/**
 * Stateless SOCKS connector for undici (fetch path) — dsh-system-proxy.
 *
 * ONE undici `connect` function serves socks4 / socks4a / socks5 / socks5h on
 * fetch (adapted from @undicijs/proxy's buildSocksProxyConnector, MIT —
 * https://jsr.io/@undicijs/proxy): establish the raw socket through the socks
 * proxy, then:
 *
 *   - http targets: return the raw socket directly;
 *   - https targets: hand the raw socket to undici's own `buildConnector` via
 *     the `httpSocket` option, so TLS wrapping, ALPN and session handling are
 *     undici's (no hand-rolled tls.connect on this path).
 *
 * SOCKS4 / SOCKS4a speak the raw protocol here (`rawSocks4Connect` — the
 * handshake is 9+ bytes, no reason to depend on a library for it); SOCKS5 /
 * SOCKS5h use the `socks` package's SocksClient (RFC 1929 auth negotiation).
 *
 * Using a plain undici `Agent` with this per-connection connector (instead of
 * undici's ProxyAgent/Socks5ProxyAgent) keeps pools isolated per origin and
 * closes the cross-origin tunnel-reuse class of issues (GHSA-hm92-r4w5-c3mj).
 *
 * DNS semantics:
 *   socks4  / socks5  → resolve the target hostname locally (local DNS)
 *   socks4a / socks5h → hand the hostname to the proxy (remote DNS)
 *
 * SOCKS4/4a cannot address IPv6 targets (protocol limit): such combinations
 * throw an explicit error and NEVER fall back to a direct connection.
 *
 * Every tunnel is bounded (10s connect+handshake window); on timeout or
 * rejection the callback fires exactly once with an error, so neither the
 * undici connector nor a node http(s) Agent can hang forever on a silent
 * proxy socket.
 *
 * Credentials ride the SOCKS handshake (`userId`/`password`); they never
 * appear in a URL handed to any agent.
 */

import net from "node:net";
import { lookup } from "node:dns/promises";
import { buildConnector } from "undici";
import { SocksClient } from "socks";
import { NetworkRouteError } from "./errors.js";

const TUNNEL_TIMEOUT_MS = 10_000;

/**
 * Raw SOCKS4 / SOCKS4a handshake over a direct TCP socket (no library):
 *
 *   request:  [VER=0x04][CMD=0x01][DSTPORT BE][DSTIP(4)][USERID\0]
 *             (socks4a: DSTIP = 0.0.0.x (x != 0) and DOMAIN\0 follows USERID\0)
 *   reply:    [0x00][STATUS][DSTPORT BE][DSTIP(4)]   (0x5A = granted)
 *
 * The callback fires exactly once: `(error, socket)` with the tunneled socket
 * on 0x5A, or an error on rejection / timeout / connect failure.
 * @param proxy - `{ host, port, userId? }` (type is implied 4).
 * @param destinationHost - the TARGET host (IP literal or domain for 4a).
 * @param destinationPort - the TARGET port.
 * @param callback - `(error, socket) => void`.
 */
export function rawSocks4Connect(proxy, destinationHost, destinationPort, callback) {
  let settled = false;
  const finish = (error, socket) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket?.removeAllListeners?.("data");
    socket?.removeAllListeners?.("error");
    callback(error, socket ?? null);
  };

  const timer = setTimeout(() => {
    socket.destroy();
    finish(
      new NetworkRouteError(
        `socks4/4a connect to ${proxy.host}:${proxy.port} timed out after ${TUNNEL_TIMEOUT_MS}ms`,
        "SOCKS_CONNECT_TIMEOUT",
      ),
      null,
    );
  }, TUNNEL_TIMEOUT_MS);
  timer.unref?.();

  const socket = net.connect(Number(proxy.port), proxy.host, () => {
    const ip4 = net.isIP(destinationHost);
    if (ip4 === 6) {
      socket.destroy();
      finish(
        new NetworkRouteError(
          `socks4/4a cannot address IPv6 target "${destinationHost}" (protocol limit) — use socks5/socks5h or direct`,
          "SOCKS4_IPV6_UNSUPPORTED",
        ),
        null,
      );
      return;
    }
    const userId = Buffer.from(proxy.userId ?? "", "utf8");
    const header = Buffer.alloc(8);
    header[0] = 0x04; // VER
    header[1] = 0x01; // CMD = connect
    header.writeUInt16BE(Number(destinationPort), 2);
    if (ip4 === 0) {
      // socks4a: 0.0.0.x with x != 0 signals a domain follows
      header[7] = 1;
      socket.write(
        Buffer.concat([
          header,
          userId,
          Buffer.from([0]),
          Buffer.from(destinationHost, "utf8"),
          Buffer.from([0]),
        ]),
      );
    } else {
      const parts = destinationHost.split(".").map(Number);
      header[4] = parts[0];
      header[5] = parts[1];
      header[6] = parts[2];
      header[7] = parts[3];
      socket.write(Buffer.concat([header, userId, Buffer.from([0])]));
    }
  });

  socket.on("error", (error) => {
    socket.destroy();
    finish(error, null);
  });

  let received = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    received = Buffer.concat([received, chunk]);
    if (received.length < 8) return;
    const status = received[1];
    if (status !== 0x5a) {
      socket.destroy();
      finish(
        new NetworkRouteError(
          `socks4/4a proxy ${proxy.host}:${proxy.port} rejected the connection (status 0x${status.toString(16)})`,
          "SOCKS_PROXY_REJECTED",
        ),
        null,
      );
      return;
    }
    finish(null, socket);
  });
}

/**
 * Build one SOCKS tunnel function.
 * @param proxy - `{ host, port, type, remoteDns, userId?, password? }`.
 * @returns `(target, callback)` where target is
 *   `{ host, port, secure?, servername?, rejectUnauthorized? }`.
 */
export function makeSocksTunnel(proxy) {
  return function socksTunnel(target, callback) {
    // undici / node may hand the host bracketed ("[::1]") — normalize first so
    // the IPv6 refusal below sees the real address.
    const rawHost = String(target.host ?? "").replace(/^\[|\]$/g, "");
    if (proxy.type === 4 && net.isIP(rawHost) === 6) {
      callback(
        new NetworkRouteError(
          `socks4/4a cannot address IPv6 target "${rawHost}" (protocol limit) — use socks5/socks5h or direct`,
          "SOCKS4_IPV6_UNSUPPORTED",
        ),
        null,
      );
      return;
    }
    if (proxy.type === 4) {
      // Raw SOCKS4 / SOCKS4a handshake — no library dependency.
      (async () => {
        let destinationHost = rawHost;
        if (!proxy.remoteDns && net.isIP(destinationHost) === 0) {
          const { address } = await lookup(destinationHost, { family: 0 });
          destinationHost = address;
        }
        return destinationHost;
      })().then(
        (destinationHost) =>
          rawSocks4Connect(
            proxy,
            destinationHost,
            Number(target.port ?? (target.secure ? 443 : 80)),
            callback,
          ),
        (error) => callback(error, null),
      );
      return;
    }
    (async () => {
      let destinationHost = rawHost;
      if (!proxy.remoteDns && net.isIP(destinationHost) === 0) {
        const { address } = await lookup(destinationHost, { family: 0 });
        destinationHost = address;
      }
      const { socket } = await SocksClient.createConnection({
        proxy: {
          host: proxy.host,
          port: Number(proxy.port),
          type: proxy.type,
          ...(proxy.userId !== undefined ? { userId: proxy.userId } : {}),
          ...(proxy.password !== undefined ? { password: proxy.password } : {}),
        },
        command: "connect",
        destination: {
          host: destinationHost,
          port: Number(target.port ?? (target.secure ? 443 : 80)),
        },
        timeout: TUNNEL_TIMEOUT_MS,
      });
      return socket;
    })().then(
      (socket) => callback(null, socket),
      (error) => callback(error, null),
    );
  };
}

/**
 * Stateless undici `connect` option for socks proxies. Every connection is a
 * fresh socks handshake; https targets are TLS-wrapped by undici's own
 * buildConnector over the tunneled socket (`httpSocket`), http targets return
 * the raw socket.
 * @param proxy - `{ host, port, type, remoteDns, userId?, password? }`.
 * @param opts - extra buildConnector options (e.g. `{ timeout }`).
 * @returns the undici connector `(options, callback) => void`.
 */
export function buildSocksProxyConnector(proxy, opts = {}) {
  const tlsConnector = buildConnector(opts);
  const tunnel = makeSocksTunnel(proxy);
  return function connect(options, callback) {
    const secure = options.protocol === "https:";
    tunnel(
      {
        host: options.hostname ?? options.host,
        port: options.port,
        secure,
        servername: options.servername,
      },
      (error, socket) => {
        if (error) return callback(error, null);
        if (!secure) return callback(null, socket);
        // https: undici's buildConnector wraps TLS over the tunneled socket.
        tlsConnector({ ...options, httpSocket: socket }, callback);
      },
    );
  };
}
