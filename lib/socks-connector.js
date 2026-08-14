/**
 * Stateless SOCKS connector for undici (fetch path) — dsh-system-proxy.
 *
 * ONE undici `connect` function serves socks4 / socks4a / socks5 / socks5h on
 * fetch (adapted from @undicijs/proxy's buildSocksProxyConnector, MIT —
 * https://jsr.io/@undicijs/proxy): establish the raw socket through the socks
 * proxy with the `socks` package, then:
 *
 *   - http targets: return the raw socket directly;
 *   - https targets: hand the raw socket to undici's own `buildConnector` via
 *     the `httpSocket` option, so TLS wrapping, ALPN and session handling are
 *     undici's (no hand-rolled tls.connect on this path).
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
 * Credentials ride the SOCKS handshake (`userId`/`password`); they never
 * appear in a URL handed to any agent.
 */

import net from "node:net";
import { lookup } from "node:dns/promises";
import { buildConnector } from "undici";
import { SocksClient } from "socks";
import { NetworkRouteError } from "./errors.js";

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
        timeout: 10_000,
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
