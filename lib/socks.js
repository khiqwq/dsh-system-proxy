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
    this._socksTunnel(
      { host: options.host, port: options.port, secure: false },
      (error, socket) => {
        if (error) return callback(error);
        callback(null, socket);
      },
    );
  }
}

/** node https.Agent whose createConnection tunnels then wraps TLS. */
export class SocksHttpsAgent extends https.Agent {
  constructor(tunnel) {
    super({ keepAlive: true });
    this._socksTunnel = tunnel;
  }
  createConnection(options, callback) {
    this._socksTunnel(
      {
        host: options.host,
        port: options.port,
        secure: true,
        servername: options.servername,
        rejectUnauthorized: options.rejectUnauthorized,
      },
      (error, socket) => {
        if (error) return callback(error);
        callback(null, socket);
      },
    );
  }
}
