/**
 * Proxy registry for dsh-system-proxy: one resolved proxy definition becomes
 * the transport agents needed on each path.
 *
 * ONE unified creation path (`createTransport`) serves all five protocols:
 *   - http / https: undici ProxyAgent (fetch) + http-proxy-agent /
 *     https-proxy-agent (node http(s));
 *   - socks4 / socks4a / socks5 / socks5h: the stateless undici connector from
 *     ./socks-connector.js (fetch) + SocksHttpAgent / SocksHttpsAgent over the
 *     SAME tunnel (node http(s)) — full socks coverage on both paths.
 *
 * Credentials are NEVER embedded in the URL handed to any agent:
 *   - http/https proxies: clean URL + `Proxy-Authorization` (undici `token`,
 *     node agents via the `headers` option) — so neither our logs nor the
 *     agents' own debug output can leak `user:pass@host`.
 *   - socks proxies: userId/password carried in the SOCKS handshake.
 *
 * All agents connect to the proxy directly (net/tls), so patching
 * http(s).request does not recurse into the agents.
 */

import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { buildSocksProxyConnector } from "./socks-connector.js";
import {
  makeSocksTunnel,
  socksSchemeInfo,
  SocksHttpAgent,
  SocksHttpsAgent,
} from "./socks.js";
import { NetworkRouteError } from "./errors.js";

function basicAuthHeader(username, password) {
  if (username === undefined && password === undefined) return undefined;
  return `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`;
}

/**
 * ONE creation path for every supported scheme (http / https / socks4 / 4a /
 * 5 / 5h): builds the fetch dispatcher plus the node http(s) agents from a
 * resolved proxy (clean URL + separate credentials). Throws INVALID_PROXY for
 * anything else.
 * @param resolved - a ResolvedProxy (clean URL, scheme, separate creds).
 * @param auth - precomputed Basic auth header, or undefined.
 * @returns `{ fetchDispatcher, httpAgent, httpsAgent }`.
 */
function createTransport(resolved, auth) {
  const { url, scheme, username, password } = resolved;
  switch (scheme) {
    case "http":
    case "https": {
      const tokenOpts = auth ? { token: auth } : undefined;
      const headers = auth ? { headers: { "Proxy-Authorization": auth } } : undefined;
      return {
        fetchDispatcher: new ProxyAgent(url, tokenOpts),
        httpAgent: new HttpProxyAgent(url, headers),
        httpsAgent: new HttpsProxyAgent(url, headers),
      };
    }
    case "socks4":
    case "socks4a":
    case "socks5":
    case "socks5h": {
      const parsed = new URL(url);
      const proxy = {
        host: parsed.hostname.replace(/^\[|\]$/g, ""),
        port: parsed.port ? Number(parsed.port) : 1080,
        ...socksSchemeInfo(scheme),
        ...(username !== undefined ? { userId: username } : {}),
        ...(password !== undefined ? { password } : {}),
      };
      // One stateless undici connector serves every socks scheme on fetch
      // (pools isolated per origin — no cross-origin tunnel reuse); node
      // http(s) reuses the same tunnel via the agent subclasses.
      const tunnel = makeSocksTunnel(proxy);
      return {
        fetchDispatcher: new Agent({
          connect: buildSocksProxyConnector(proxy),
          connectTimeout: 10_000,
        }),
        httpAgent: new SocksHttpAgent(tunnel),
        httpsAgent: new SocksHttpsAgent(tunnel),
      };
    }
    default:
      throw new NetworkRouteError(`unsupported proxy scheme "${scheme}"`, "INVALID_PROXY");
  }
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
    const { fetchDispatcher, httpAgent, httpsAgent } = createTransport(
      resolved,
      basicAuthHeader(resolved.username, resolved.password),
    );
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
