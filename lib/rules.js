/**
 * Rule model for dsh-system-proxy: host/provider/plugin based routing rules.
 *
 * A rule matches a request when ALL of its specified fields match the request
 * facts (host, provider, plugin): fields are ANDed together, while each field's
 * own value list is ORed ("host a OR host b, AND provider p"). A field that is
 * empty or unknown in the request is "not specified" and does not constrain the
 * match. The first matching rule in list order wins; if no rule matches, the
 * `default` strategy applies.
 *
 * Actions:
 *   - `direct`   — never proxy, no fallback.
 *   - `proxy`    — always route through the named proxy.
 *   - `fallback` — try direct first (bounded by `directTimeoutMs`), switch to
 *     the named proxy on connect-phase failure / latency threshold / health
 *     memory. Only safe-to-replay requests (see transport.js) actually retry;
 *     the node http(s) path selects by health instead of post-hoc retry.
 *   - `block`    — reject the request with `NetworkRouteError` (code
 *     `NETWORK_BLOCKED`).
 */

import net from "node:net";
import { NetworkRouteError } from "./errors.js";

export const ACTIONS = new Set(["direct", "proxy", "fallback", "block"]);

/**
 * Host/port pattern match used by rules AND noProxy entries. Supports:
 *   - "*" (match everything)
 *   - exact hostname, dotted-suffix (".example.com" / "*.example.com")
 *   - plain IPv4/IPv6 and CIDR ranges ("10.0.0.0/8", "fc00::/7")
 *   - an optional ":port" suffix ("example.com:443", "127.0.0.1:8080",
 *     "[::1]:8080") that must match the request port when known
 * @param pattern - the configured pattern.
 * @param hostname - lowercase target hostname (may be an IP literal).
 * @param port - effective target port, or undefined when unknown.
 */
export function hostPortMatches(pattern, hostname, port) {
  let p = String(pattern ?? "").trim().toLowerCase();
  if (!p) return false;
  if (p === "*") return true;
  p = p.replace(/^https?:\/\//, "").replace(/^socks5?h?:\/\//, "");

  let requiredPort = null;
  if (p.startsWith("[")) {
    const close = p.indexOf("]");
    if (close !== -1) {
      const rest = p.slice(close + 1);
      if (rest.startsWith(":")) requiredPort = rest.slice(1);
      p = p.slice(0, close + 1);
    }
  } else if (!p.includes("::")) {
    const idx = p.lastIndexOf(":");
    if (idx !== -1) {
      requiredPort = p.slice(idx + 1);
      p = p.slice(0, idx);
    }
  }

  if (requiredPort !== null && requiredPort !== "") {
    const wanted = Number(requiredPort);
    if (
      Number.isFinite(wanted) &&
      port !== undefined &&
      port !== null &&
      port !== "" &&
      Number(port) !== wanted
    ) {
      return false;
    }
  }

  if (p.includes("/")) return cidrMatches(p, hostname);
  if (net.isIP(hostname)) {
    if (net.isIP(p)) return ipMatches(p, hostname);
    return false; // numeric host vs non-numeric pattern
  }
  p = p.replace(/^\*\./, "").replace(/^\./, "");
  if (!p) return false;
  return hostname === p || hostname.endsWith(`.${p}`);
}

function ipMatches(a, b) {
  if (net.isIP(a) !== net.isIP(b)) return false;
  if (net.isIP(a) === 4) return a === b;
  return normalizeV6(a) === normalizeV6(b);
}

function normalizeV6(addr) {
  return net.isIPv6(addr) ? addr.toLowerCase() : addr;
}

function ipv4ToInt(addr) {
  const parts = addr.split(".").map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

/** Parse an IPv6 address (with `::` compression and embedded IPv4) into a 128-bit BigInt. */
function ipv6ToBigInt(addr) {
  let value = addr;
  if (value.includes(".")) {
    const m = /([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(value);
    if (!m) return null;
    const hi = ((Number(m[1]) << 8) | Number(m[2])).toString(16);
    const lo = ((Number(m[3]) << 8) | Number(m[4])).toString(16);
    value = value.slice(0, m.index) + (m.index > 0 ? ":" : "") + `${hi}:${lo}`;
  }
  const doubleColon = value.indexOf("::");
  let head;
  let tail;
  if (doubleColon !== -1) {
    head = doubleColon === 0 ? [] : value.slice(0, doubleColon).split(":").filter(Boolean);
    tail =
      doubleColon === value.length - 2
        ? []
        : value.slice(doubleColon + 2).split(":").filter(Boolean);
  } else {
    head = value.split(":").filter(Boolean);
    tail = [];
  }
  if (head.length + tail.length > 8) return null;
  const groups = [...head, ...new Array(8 - head.length - tail.length).fill("0"), ...tail];
  let result = 0n;
  for (const group of groups) {
    const n = Number.parseInt(group || "0", 16);
    if (!Number.isFinite(n)) return null;
    result = (result << 16n) | BigInt(n & 0xffff);
  }
  return result;
}

/** CIDR match for IPv4 and IPv6 (manual math: net.BlockList v6 is broken in some builds). */
function cidrMatches(pattern, hostname) {
  const slash = pattern.indexOf("/");
  if (slash === -1) return false;
  const addr = pattern.slice(0, slash);
  const bits = Number(pattern.slice(slash + 1));
  const family = net.isIP(hostname);
  if (family === 0) return false;
  if (family === 4 && net.isIP(addr) === 4) {
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const ip = ipv4ToInt(hostname);
    const network = ipv4ToInt(addr);
    const mask = bits === 0 ? 0 : (~0 >>> 0) << (32 - bits) >>> 0;
    return (ip & mask) === (network & mask);
  }
  if (family === 6 && net.isIP(addr) === 6) {
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
    const ip = ipv6ToBigInt(hostname);
    const network = ipv6ToBigInt(addr);
    if (ip === null || network === null) return false;
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
    return (ip & mask) === (network & mask);
  }
  return false;
}

/** Backward-compatible hostname-only matcher (host:port / CIDR not applied). */
export function hostMatches(pattern, hostname) {
  return hostPortMatches(pattern, hostname, undefined);
}

function toList(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());
}

/**
 * Normalize one raw rule entry. Throws NetworkRouteError on invalid input so
 * misconfiguration fails loudly at load time instead of silently misrouting.
 * @param raw - the raw rule object from config.
 * @param index - rule index for diagnostics.
 */
export function normalizeRule(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new NetworkRouteError(`rules[${index}] must be an object`, "INVALID_RULE");
  }
  const action = String(raw.action ?? "").toLowerCase();
  if (!ACTIONS.has(action)) {
    throw new NetworkRouteError(
      `rules[${index}].action must be one of ${[...ACTIONS].join(", ")} (got ${JSON.stringify(raw.action)})`,
      "INVALID_RULE",
    );
  }
  const rule = {
    host: toList(raw.host),
    provider: toList(raw.provider),
    plugin: toList(raw.plugin),
    action,
    proxy: typeof raw.proxy === "string" && raw.proxy.trim() !== "" ? raw.proxy.trim() : undefined,
    directTimeoutMs: positiveNumber(raw.directTimeoutMs, `rules[${index}].directTimeoutMs`),
    proxyTimeoutMs: positiveNumber(raw.proxyTimeoutMs, `rules[${index}].proxyTimeoutMs`),
  };
  if ((action === "proxy" || action === "fallback") && rule.proxy === undefined) {
    // `default` proxy is implied when named proxies exist; validated at resolve time.
    rule.proxy = "default";
  }
  if (action !== "block" && rule.host.length === 0 && rule.provider.length === 0 && rule.plugin.length === 0) {
    throw new NetworkRouteError(
      `rules[${index}] must specify at least one of host / provider / plugin`,
      "INVALID_RULE",
    );
  }
  return rule;
}

function positiveNumber(value, path) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new NetworkRouteError(`${path} must be a non-negative number`, "INVALID_RULE");
  }
  return n;
}

/**
 * Match a normalized rule list against request facts. Returns the first
 * matching rule, or undefined. Semantics: ALL specified fields must match
 * (AND across fields); each field's value list is ORed within itself. A
 * specified field with unknown request facts does not match. Defensive against
 * legacy/inline rules that may omit the array fields.
 * @param rules - normalized rules in priority order.
 * @param facts - `{ host, port?, provider, plugin }` (lowercased strings or null).
 */
export function matchRule(rules, facts) {
  for (const rule of rules) {
    const hosts = rule.host ?? [];
    const providers = rule.provider ?? [];
    const plugins = rule.plugin ?? [];
    const hasHost = hosts.length > 0;
    const hasProvider = providers.length > 0;
    const hasPlugin = plugins.length > 0;
    if (!hasHost && !hasProvider && !hasPlugin) continue; // nothing specified
    if (hasHost && (facts.host === null || !hosts.some((pattern) => hostPortMatches(pattern, facts.host, facts.port)))) continue;
    if (hasProvider && (facts.provider === null || !providers.some((entry) => entry === facts.provider))) continue;
    if (hasPlugin && (facts.plugin === null || !plugins.some((entry) => entry === facts.plugin))) continue;
    return rule; // every specified field matched (AND across fields)
  }
  return undefined;
}

/**
 * Convert the legacy `noProxy`/`only` lists into explicit direct/proxy rules.
 * Kept separate so the old config keeps its exact semantics:
 *  - `noProxy` hosts always connect directly (baseline, prepended first);
 *  - when `only` is non-empty, ONLY those hosts are proxied (via the
 *    `default` proxy) and everything else is direct;
 *  - when `only` is empty, everything outside `noProxy` is proxied.
 */
export function legacyRules(noProxy, only) {
  const rules = [];
  if (noProxy.length > 0) rules.push({ host: noProxy, action: "direct", proxy: undefined, directTimeoutMs: undefined, proxyTimeoutMs: undefined, legacy: true });
  if (only.length > 0) {
    rules.push({ host: only, action: "proxy", proxy: "default", directTimeoutMs: undefined, proxyTimeoutMs: undefined, legacy: true });
  }
  return rules;
}

/** Whether a rule list originates purely from legacy config (no user rules). */
export function isLegacyOnly(rawRules) {
  return rawRules.length === 0;
}
