/**
 * Proxy registry for dsh-system-proxy: one resolved proxy definition becomes
 * the transport agents needed on each path.
 *
 * Credentials are NEVER embedded in the URL handed to any agent:
 *   - http/https proxies: clean URL + `Proxy-Authorization` (undici `token`,
 *     node agents via the `headers` option) — so neither our logs nor the
 *     agents' own debug output can leak `user:pass@host`.
 *   - socks proxies: userId/password carried in the SOCKS handshake.
 *
 * SOCKS support covers socks4 / socks4a / socks5 / socks5h on BOTH paths:
 *   - fetch: an undici Agent whose `connect` performs the handshake (undici
 *     has no native socks4 client, so one tunnel serves every socks scheme);
 *   - node http(s): http.Agent / https.Agent subclasses over the same tunnel.
 *
 * All agents connect to the proxy directly (net/tls), so patching
 * http(s).request does not recurse into the agents.
 */

import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { NetworkRouteError } from "./errors.js";
import {
  buildSocksProxyConnector,
  makeSocksTunnel,
  socksSchemeInfo,
  SocksHttpAgent,
  SocksHttpsAgent,
} from "./socks.js";

function basicAuthHeader(username, password) {
  if (username === undefined && password === undefined) return undefined;
  return `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`;
}

/** Gracefully stop a node http.Agent: destroy idle sockets, destroy the rest as they free. */
function closeNodeAgent(agent) {
  try {
    const free = agent.freeSockets;
    if (free) {
      for (const key of Object.keys(free)) {
        for (const socket of free[key]) socket.destroy();
        delete free[key];
      }
    }
    const active = agent.sockets;
    if (active) {
      for (const list of Object.values(active)) {
        for (const socket of list) {
          socket.once?.("free", () => socket.destroy());
        }
      }
    }
  } catch {
    /* best effort */
  }
}

export class ProxyRegistry {
  constructor() {
    /** name -> { resolved, fetchDispatcher, httpAgent, httpsAgent } */
    this.entries = new Map();
  }

  /**
   * Register one resolved proxy.
   * @param resolved - a ResolvedProxy from `makeResolvedProxy` (clean URL).
   */
  add(resolved) {
    if (this.entries.has(resolved.name)) {
      throw new NetworkRouteError(
        `proxy "${resolved.name}" is registered twice`,
        "INVALID_PROXY",
      );
    }
    const { url, scheme, username, password } = resolved;
    const auth = basicAuthHeader(username, password);
    let fetchDispatcher = null;
    let httpAgent = null;
    let httpsAgent = null;

    if (scheme === "http" || scheme === "https") {
      const tokenOpts = auth ? { token: auth } : undefined;
      fetchDispatcher = new ProxyAgent(url, tokenOpts);
      const headers = auth ? { headers: { "Proxy-Authorization": auth } } : undefined;
      httpAgent = new HttpProxyAgent(url, headers);
      httpsAgent = new HttpsProxyAgent(url, headers);
    } else if (socksSchemeInfo(scheme)) {
      const parsed = new URL(url);
      const proxy = {
        host: parsed.hostname.replace(/^\[|\]$/g, ""),
        port: parsed.port ? Number(parsed.port) : 1080,
        ...socksSchemeInfo(scheme),
        ...(username !== undefined ? { userId: username } : {}),
        ...(password !== undefined ? { password } : {}),
      };
      // Stateless per-connection connector over a plain undici Agent: pools
      // stay isolated per origin (no cross-origin tunnel reuse), and one path
      // serves socks4/4a/5/5h on fetch.
      fetchDispatcher = new Agent({
        connect: buildSocksProxyConnector(proxy),
        connectTimeout: 10_000,
      });
      const tunnel = makeSocksTunnel(proxy);
      httpAgent = new SocksHttpAgent(tunnel);
      httpsAgent = new SocksHttpsAgent(tunnel);
    } else {
      throw new NetworkRouteError(`unsupported proxy scheme "${scheme}"`, "INVALID_PROXY");
    }

    this.entries.set(resolved.name, {
      resolved,
      fetchDispatcher,
      httpAgent,
      httpsAgent,
    });
  }

  /** Look up a registered proxy entry; undefined when absent. */
  get(name) {
    return this.entries.get(name);
  }

  /** Dispatch a fetch request through the named proxy. */
  fetch(name, input, init) {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new NetworkRouteError(`proxy "${name}" is not configured`, "UNKNOWN_PROXY");
    }
    return undiciFetch(input, { ...(init ?? {}), dispatcher: entry.fetchDispatcher });
  }

  /**
   * Close every agent WITHOUT interrupting in-flight requests: undici agents
   * `close()` gracefully (in-flight completes first); node agents destroy
   * idle sockets now and each remaining socket as it becomes free.
   */
  close() {
    for (const entry of this.entries.values()) {
      try {
        entry.fetchDispatcher?.close?.();
      } catch {
        /* ignore */
      }
      closeNodeAgent(entry.httpAgent);
      closeNodeAgent(entry.httpsAgent);
    }
    this.entries.clear();
  }

  /** Redacted proxy list for the startup log. */
  summary() {
    return [...this.entries.values()].map((entry) => {
      const r = entry.resolved;
      return `${r.name}(${r.scheme} ${r.display})`;
    });
  }
}
