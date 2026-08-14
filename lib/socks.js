/**
 * SOCKS4 / SOCKS4a / SOCKS5 / SOCKS5h support for dsh-system-proxy.
 *
 * This module owns the scheme metadata (`socksSchemeInfo`) and the node
 * http(s) path agents (`SocksHttpAgent` / `SocksHttpsAgent`) that tunnel
 * through the same `makeSocksTunnel` used by the fetch connector.
 *
 * The undici (fetch) connector itself lives in `./socks-connector.js`:
 * ONE stateless `connect` function serves every socks scheme, so socks4/4a/5/5h
 * are fully covered on fetch — no half support. `buildSocksProxyConnector` and
 * `makeSocksTunnel` are re-exported here for callers that import from this
 * module.
 */

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import {
  buildSocksProxyConnector,
  makeSocksTunnel,
} from "./socks-connector.js";

export { buildSocksProxyConnector, makeSocksTunnel };

/** Map a scheme string to { type, remoteDns }. */
export function socksSchemeInfo(scheme) {
  switch (scheme) {
    case "socks4":
      return { type: 4, remoteDns: false };
    case "socks4a":
      return { type: 4, remoteDns: true };
    case "socks5":
      return { type: 5, remoteDns: false };
    case "socks5h":
      return { type: 5, remoteDns: true };
    default:
      throw new Error(`not a socks scheme: ${scheme}`);
  }
}

/** node http.Agent whose createConnection tunnels through the socks proxy. */
export class SocksHttpAgent extends http.Agent {
  constructor(tunnel) {
    super({ keepAlive: true });
    this._socksTunnel = tunnel;
  }
  createConnection(options, callback) {
    boundedSocksConnect(this._socksTunnel, { host: options.host, port: options.port, secure: false }, callback);
  }
}

/** node https.Agent whose createConnection tunnels then wraps TLS. */
export class SocksHttpsAgent extends https.Agent {
  constructor(tunnel) {
    super({ keepAlive: true });
    this._socksTunnel = tunnel;
  }
  createConnection(options, callback) {
    // The tunnel hands back a RAW socket; https.Agent will not wrap it in TLS
    // once createConnection is overridden (its default does tls.connect), so
    // the TLS layer is built here over the tunneled socket — mirroring the
    // fetch path (undici buildConnector over httpSocket).
    boundedSocksConnect(
      this._socksTunnel,
      {
        host: options.host,
        port: options.port,
        secure: true,
        servername: options.servername,
      },
      (error, socket) => {
        if (error) return callback(error);
        let done = false;
        const finish = (err, sock) => {
          if (done) return;
          done = true;
          callback(err ?? null, sock);
        };
        const tlsSocket = tls.connect({
          socket,
          servername: options.servername,
          rejectUnauthorized: options.rejectUnauthorized,
        });
        const onError = (tlsError) => {
          socket.destroy();
          finish(tlsError, null);
        };
        tlsSocket.once("secureConnect", () => {
          tlsSocket.removeListener("error", onError);
          finish(null, tlsSocket);
        });
        tlsSocket.on("error", onError);
      },
    );
  }
}

/**
 * Call the tunnel with a hard bound so a node http(s) request can NEVER hang
 * forever on a silent socks proxy: if the tunnel does not settle within the
 * window the callback fires once with a timeout error (and the socket is
 * destroyed). The callback is guaranteed to fire exactly once.
 */
function boundedSocksConnect(tunnel, target, callback) {
  let settled = false;
  const finish = (error, socket) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(error ?? null, socket ?? undefined);
  };
  const timer = setTimeout(() => {
    finish(new Error("socks tunnel connect timeout"), null);
  }, 10_000);
  timer.unref?.();
  try {
    tunnel(target, (error, socket) => {
      if (settled) {
        // Late arrival after the timeout guard fired: never hand a socket to
        // node — destroy it so the proxy-side tunnel is closed, not leaked.
        socket?.destroy?.();
        return;
      }
      if (error) {
        socket?.destroy?.();
        finish(error, null);
        return;
      }
      finish(null, socket);
    });
  } catch (error) {
    finish(error, null);
  }
}
