/**
 * Configuration normalization and proxy resolution for dsh-system-proxy.
 *
 * Backward-compatible with the original config surface:
 *   enabled / mode / url / noProxy / only / patchNodeHttp
 * plus the routing surface:
 *   proxies: { name: "<url>" | { url?, source?: system|env,
 *                                 username?, passwordRef?, password? } }
 *   rules:   [{ host?|provider?|plugin?, action, proxy?, ... }]
 *   default: { strategy, proxy, directTimeoutMs, latencyThresholdMs,
 *              cooldownMs, methods }
 *   trustRouteHeaders / routeHeaderPrefix / protectLocal / protectPrivate
 *
 * Environment overrides (highest priority):
 *   DSH_PROXY_URL (wins over config.url) / DSH_PROXY_MODE /
 *   DSH_PROXY_DISABLE; NO_PROXY / no_proxy are merged into the direct
 *   baseline.
 *
 * Safety defaults: loopback, link-local, cloud metadata endpoints
 * (`protectLocal`, on by default) and private RFC1918/ULA ranges
 * (`protectPrivate`, on by default) are ALWAYS direct, so a "proxy
 * everything" config can never leak internal/metadata traffic to an external
 * proxy. Set both to false to opt out deliberately.
 */

import { execFile } from "node:child_process";
import { NetworkRouteError } from "./errors.js";
import { isLegacyOnly, normalizeRule } from "./rules.js";

const MODES = new Set(["auto", "env", "system", "manual"]);
const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];
const REGISTRY_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const REGISTRY_QUERY_TIMEOUT_MS = 3000;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Always-direct hosts (safety): loopback + cloud metadata endpoints. */
export const CORE_SAFE_NO_PROXY = [
  "localhost",
  "127.0.0.1",
  "::1",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254", // AWS/GCP/Azure metadata
  "169.254.170.2", // AWS ECS
  "169.254.170.23", // AWS ECS
  "100.100.100.200", // Alibaba cloud metadata
];

/** Private / link-local ranges, merged when `protectPrivate` is true. */
export const PRIVATE_NO_PROXY = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "0.0.0.0/8",
  "fc00::/7",
  "fe80::/10",
];

/** Default strategy used when the user configures the NEW surface (rules/proxies). */
const NEW_SURFACE_DEFAULTS = Object.freeze({
  strategy: "fallback",
  proxy: "default",
  directTimeoutMs: 3_000,
  latencyThresholdMs: 1_500,
  cooldownMs: 60_000,
  methods: ["GET", "HEAD", "OPTIONS", "TRACE"],
});

/**
 * Normalize raw plugin config into a resolution plan. Pure (no I/O): system
 * proxy probing happens later in `resolveProxyPlan`.
 */
export function normalizeConfig(config) {
  const raw = config && typeof config === "object" ? config : {};
  const envMode = process.env.DSH_PROXY_MODE?.trim().toLowerCase() ?? "";
  const mode = MODES.has(envMode) ? envMode : MODES.has(raw.mode) ? raw.mode : "auto";

  // Environment override wins over the YAML value.
  const envUrl = process.env.DSH_PROXY_URL?.trim() ?? "";
  const rawUrl = typeof raw.url === "string" ? raw.url.trim() : "";
  const url = envUrl !== "" ? envUrl : rawUrl;
  // The compact Settings card addresses the implicit default proxy. Its
  // password is a credential reference, never a settings literal. Empty keeps
  // legacy/manual configurations credential-free.
  const passwordRef =
    typeof raw.passwordRef === "string" && raw.passwordRef !== ""
      ? validateCredentialRef(raw.passwordRef, "default")
      : undefined;

  const protectLocal = raw.protectLocal !== false;
  const protectPrivate = raw.protectPrivate !== false;
  const userNoProxy = Array.isArray(raw.noProxy) ? raw.noProxy : null;
  const noProxy = dedupe([
    ...(protectLocal ? CORE_SAFE_NO_PROXY : []),
    ...(protectPrivate ? PRIVATE_NO_PROXY : []),
    ...envNoProxy(),
    ...(userNoProxy ?? []),
  ]);
  const only = dedupe(Array.isArray(raw.only) ? raw.only : []);
  const patchNodeHttp = raw.patchNodeHttp !== false;

  const proxies = new Map();
  const rawProxies =
    raw.proxies && typeof raw.proxies === "object" && !Array.isArray(raw.proxies)
      ? raw.proxies
      : {};
  for (const [name, spec] of Object.entries(rawProxies)) {
    proxies.set(name, normalizeProxySpec(spec, name));
  }

  const rawRules = Array.isArray(raw.rules) ? raw.rules : [];
  const rules = rawRules.map((entry, index) => normalizeRule(entry, index));

  let defaults;
  const rawDefault = raw.default && typeof raw.default === "object" ? raw.default : null;
  const hasExplicitStrategy = typeof rawDefault?.strategy === "string";
  const newSurface = !isLegacyOnly(rawRules) || proxies.size > 0;
  if (rawDefault !== null && (hasExplicitStrategy || newSurface)) {
    const strategy =
      hasExplicitStrategy && ["direct", "proxy", "fallback"].includes(rawDefault.strategy)
        ? rawDefault.strategy
        : NEW_SURFACE_DEFAULTS.strategy;
    defaults = {
      strategy,
      proxy:
        typeof rawDefault.proxy === "string" && rawDefault.proxy.trim() !== ""
          ? rawDefault.proxy.trim()
          : "default",
      directTimeoutMs: positive(rawDefault.directTimeoutMs, NEW_SURFACE_DEFAULTS.directTimeoutMs),
      latencyThresholdMs: positive(
        rawDefault.latencyThresholdMs,
        NEW_SURFACE_DEFAULTS.latencyThresholdMs,
      ),
      cooldownMs: positive(rawDefault.cooldownMs, NEW_SURFACE_DEFAULTS.cooldownMs),
      methods:
        Array.isArray(rawDefault.methods) && rawDefault.methods.length > 0
          ? dedupe(rawDefault.methods).map((m) => m.toUpperCase())
          : [...NEW_SURFACE_DEFAULTS.methods],
    };
  } else if (newSurface) {
    defaults = { ...NEW_SURFACE_DEFAULTS };
  } else {
    // Pure legacy: proxy everything outside noProxy; `only` narrows the set.
    defaults = {
      strategy: only.length > 0 ? "direct" : "proxy",
      proxy: "default",
      directTimeoutMs: NEW_SURFACE_DEFAULTS.directTimeoutMs,
      latencyThresholdMs: NEW_SURFACE_DEFAULTS.latencyThresholdMs,
      cooldownMs: NEW_SURFACE_DEFAULTS.cooldownMs,
      methods: [...NEW_SURFACE_DEFAULTS.methods],
    };
  }

  return {
    enabled: (process.env.DSH_PROXY_DISABLE ?? "") === "" && raw.enabled !== false,
    mode,
    url,
    passwordRef,
    noProxy,
    only,
    patchNodeHttp,
    trustRouteHeaders: raw.trustRouteHeaders === true,
    routeHeaderPrefix:
      typeof raw.routeHeaderPrefix === "string" && raw.routeHeaderPrefix.trim() !== ""
        ? raw.routeHeaderPrefix.trim()
        : "x-dsh-route",
    healthMaxEntries: positive(raw.healthMaxEntries, 10_000),
    proxies,
    rawRules,
    rules,
    defaults,
    legacyMode: isLegacyOnly(rawRules) && proxies.size === 0,
  };
}

function normalizeProxySpec(spec, name) {
  if (typeof spec === "string") {
    const value = spec.trim();
    if (value === "system" || value === "env") return { url: "", source: value };
    return { url: value, source: undefined, username: undefined, passwordRef: undefined, password: undefined };
  }
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    const source = spec.source === "system" || spec.source === "env" ? spec.source : undefined;
    const url = typeof spec.url === "string" ? spec.url.trim() : "";
    const username =
      typeof spec.username === "string" && spec.username !== "" ? spec.username : undefined;
    const passwordRef =
      typeof spec.passwordRef === "string" && spec.passwordRef !== ""
        ? validateCredentialRef(spec.passwordRef, name)
        : undefined;
    const password =
      typeof spec.password === "string" && spec.password !== "" ? spec.password : undefined;
    if (passwordRef !== undefined && password !== undefined) {
      throw new NetworkRouteError(
        `proxies["${name}"] cannot define both passwordRef and plaintext password`,
        "AMBIGUOUS_PROXY_CREDENTIAL",
      );
    }
    if (!source && url === "" && username === undefined && passwordRef === undefined && password === undefined) {
      throw new NetworkRouteError(
        `proxies["${name}"] must have a url or a source (system|env)`,
        "INVALID_PROXY",
      );
    }
    return { url, source, username, passwordRef, password };
  }
  throw new NetworkRouteError(
    `proxies["${name}"] must be a URL string or { url?, source?, username?, passwordRef?, password? }`,
    "INVALID_PROXY",
  );
}

/**
 * Resolve a normalized plan into concrete runtime values: every named proxy
 * becomes a ResolvedProxy with a detected scheme, a CLEAN URL (credentials
 * stripped — agents get auth separately) and redacted display; legacy
 * mode/url resolve into the implicit `default` proxy. Async because
 * system-proxy probing spawns a subprocess.
 */
export async function resolveProxyPlan(plan, options = {}) {
  const resolveCredential = options.resolveCredential;
  const resolved = new Map();
  const skippedSources = new Set();

  // Implicit "default" proxy from legacy mode/url when not explicitly defined.
  if (!plan.proxies.has("default") && (plan.mode !== "manual" || plan.url !== "" || plan.legacyMode)) {
    const url = await resolveLegacyUrl(plan);
    if (url) {
      let password;
      if (plan.passwordRef !== undefined) {
        if (typeof resolveCredential !== "function") {
          throw new NetworkRouteError(
            'credential service is unavailable for proxy "default"',
            "CREDENTIAL_SERVICE_UNAVAILABLE",
          );
        }
        password = await resolveCredential(plan.passwordRef);
        if (typeof password !== "string" || password.length === 0) {
          throw new NetworkRouteError(
            `credential "${plan.passwordRef}" required by proxy "default" is not configured`,
            "CREDENTIAL_NOT_CONFIGURED",
          );
        }
      }
      resolved.set("default", makeResolvedProxy("default", url, { password, passwordRef: plan.passwordRef }));
    }
  }

  for (const [name, spec] of plan.proxies) {
    const url = spec.source ? await sourceUrl(spec.source) : spec.url;
    if (!url) {
      // A named proxy whose source (system/env) is currently off is skipped,
      // not fatal. Tracked so references degrade to direct with a warning.
      skippedSources.add(name);
      continue;
    }
    let password = spec.password;
    if (spec.passwordRef !== undefined) {
      if (typeof resolveCredential !== "function") {
        throw new NetworkRouteError(
          `credential service is unavailable for proxy "${name}"`,
          "CREDENTIAL_SERVICE_UNAVAILABLE",
        );
      }
      password = await resolveCredential(spec.passwordRef);
      if (typeof password !== "string" || password.length === 0) {
        throw new NetworkRouteError(
          `credential "${spec.passwordRef}" required by proxy "${name}" is not configured`,
          "CREDENTIAL_NOT_CONFIGURED",
        );
      }
    }
    resolved.set(
      name,
      makeResolvedProxy(name, url, {
        username: spec.username,
        password,
        passwordRef: spec.passwordRef,
      }),
    );
  }

  // Pure legacy config with no resolvable proxy is a legitimate "no proxy"
  // state (the apply() path warns and stays inert) — not a config error.
  if (plan.legacyMode && resolved.size === 0) {
    return { ...plan, resolved, skippedSources };
  }

  // Re-point any rules / defaults that actually need a proxy. `direct` and
  // `block` actions never touch a proxy, and a `direct` default strategy has
  // no proxy dependency — so only the names real routing needs are enforced.
  const referenced = new Set();
  for (const rule of plan.rules) {
    if ((rule.action === "proxy" || rule.action === "fallback") && rule.proxy) {
      referenced.add(rule.proxy);
    }
  }
  if (plan.defaults.strategy !== "direct") {
    referenced.add(plan.defaults.proxy);
  }
  for (const name of referenced) {
    if (resolved.has(name) || skippedSources.has(name)) continue;
    throw new NetworkRouteError(
      `proxy "${name}" is referenced but not configured (check proxies / url / mode)`,
      "UNKNOWN_PROXY",
    );
  }

  return { ...plan, resolved, skippedSources };
}

/** Resolve the legacy mode → URL chain (manual / env / system / auto). */
async function resolveLegacyUrl(plan) {
  switch (plan.mode) {
    case "manual":
      return plan.url;
    case "env":
      return pickEnvProxy();
    case "system":
      return await systemProxyUrl();
    case "auto":
    default:
      return pickEnvProxy() || (await systemProxyUrl()) || plan.url;
  }
}

async function sourceUrl(source) {
  if (source === "env") return pickEnvProxy();
  if (source === "system") return await systemProxyUrl();
  return "";
}

function pickEnvProxy() {
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (!value) continue;
    // Validate here, but preserve the raw credential-bearing value until
    // makeResolvedProxy() separates authentication from the clean agent URL.
    // Returning parseProxyUrl(value).url would silently discard credentials
    // from environment-provided proxies before an agent can receive them.
    parseProxyUrl(value);
    return URL_SCHEME_RE.test(value) ? value : `http://${value}`;
  }
  return "";
}

/**
 * Parse a proxy URL into { url (credentials stripped), scheme, display,
 * username?, password? }. Bare "host:port" becomes http://host:port.
 * Credentials never survive into the URL handed to transport agents; they
 * are returned separately and injected as auth headers / socks fields.
 */
export function parseProxyUrl(value) {
  const url = URL_SCHEME_RE.test(value) ? value : `http://${value}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new NetworkRouteError(
      `invalid proxy URL "${redactUrl(url)}": ${error.message}`,
      "INVALID_PROXY",
    );
  }
  const scheme = detectScheme(parsed.protocol);
  if (!parsed.hostname) {
    throw new NetworkRouteError(`proxy URL "${redactUrl(url)}" has no host`, "INVALID_PROXY");
  }
  const username = parsed.username !== "" ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password !== "" ? decodeURIComponent(parsed.password) : undefined;
  if (parsed.username !== "" || parsed.password !== "") {
    parsed.username = "";
    parsed.password = "";
  }
  return {
    url: parsed.href,
    scheme,
    display: username || password ? `${parsed.protocol}//***@${parsed.host}` : parsed.href,
    username,
    password,
  };
}

/** Legacy alias kept for compatibility with earlier exports. */
export function normalizeProxyUrl(value) {
  return parseProxyUrl(value);
}

export function detectScheme(protocol) {
  switch (protocol) {
    case "http:":
    case "https:":
      return protocol.slice(0, -1);
    case "socks4:":
      return "socks4";
    case "socks4a:":
      return "socks4a";
    case "socks5:":
    case "socks:":
      return "socks5";
    case "socks5h:":
      return "socks5h";
    default:
      throw new NetworkRouteError(`unsupported proxy scheme "${protocol}"`, "INVALID_PROXY");
  }
}

/** Build a ResolvedProxy from a raw URL string plus optional credential overrides. */
export function makeResolvedProxy(name, rawUrl, overrides = {}) {
  const parsed = parseProxyUrl(rawUrl);
  return {
    name,
    url: parsed.url,
    scheme: parsed.scheme,
    display: parsed.display,
    username: overrides.username ?? parsed.username,
    password: overrides.password ?? parsed.password,
    passwordRef: overrides.passwordRef,
  };
}

/** Strip credentials from a proxy URL for log lines. */
export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      return `${parsed.protocol}//***@${parsed.host}`;
    }
  } catch {
    /* keep the raw value */
  }
  return url;
}

export function systemProxyUrl() {
  if (process.platform === "win32") return windowsProxyUrl();
  if (process.platform === "darwin") return macosProxyUrl();
  return "";
}

/**
 * Read the WinINET system proxy. `ProxyServer` may be "host:port" or a
 * per-protocol list "http=...;https=...;socks=...". https is preferred, then
 * http, then the plain value; a socks-only configuration resolves to a
 * `socks5h://` URL (remote DNS, no leak of the target hostname).
 */
function windowsProxyUrl() {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", REGISTRY_KEY],
      { timeout: REGISTRY_QUERY_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve("");
        const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(stdout);
        if (!enabled || Number.parseInt(enabled[1], 16) === 0) return resolve("");
        const server = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(stdout);
        if (!server) return resolve("");
        const parts = new Map();
        for (const entry of server[1].split(";")) {
          const idx = entry.indexOf("=");
          if (idx === -1) parts.set("__plain", entry);
          else parts.set(entry.slice(0, idx).trim().toLowerCase(), entry.slice(idx + 1).trim());
        }
        if (parts.size === 0) return resolve("");
        const pick = parts.get("https") || parts.get("http") || parts.get("__plain");
        if (pick) return resolve(/^https?:\/\//i.test(pick) ? pick : `http://${pick}`);
        const socks = parts.get("socks");
        if (socks) return resolve(/^socks/i.test(socks) ? socks : `socks5h://${socks}`);
        resolve("");
      },
    );
  });
}

/** Read the macOS system proxy via scutil (HTTP/HTTPS + SOCKS entries). */
function macosProxyUrl() {
  return new Promise((resolve) => {
    execFile(
      "scutil",
      ["--proxy"],
      { timeout: REGISTRY_QUERY_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve("");
        const httpEnabled =
          /HTTPSEnable\s*:\s*1/.test(stdout) || /HTTPEnable\s*:\s*1/.test(stdout);
        const socksEnabled = /SOCKSEnable\s*:\s*1/.test(stdout);
        if (!httpEnabled && !socksEnabled) return resolve("");
        if (httpEnabled) {
          const host = /(?:HTTPS|HTTP)Proxy\s*:\s*(\S+)/.exec(stdout);
          const port = /(?:HTTPS|HTTP)Port\s*:\s*(\d+)/.exec(stdout);
          if (host) return resolve(`http://${host[1]}${port ? `:${port[1]}` : ""}`);
        }
        if (socksEnabled) {
          const host = /SOCKSProxy\s*:\s*(\S+)/.exec(stdout);
          const port = /SOCKSPort\s*:\s*(\d+)/.exec(stdout);
          if (host) return resolve(`socks5h://${host[1]}${port ? `:${port[1]}` : ""}`);
        }
        resolve("");
      },
    );
  });
}

function envNoProxy() {
  const raw = process.env.NO_PROXY || process.env.no_proxy || "";
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function dedupe(list) {
  return [...new Set(list.map((entry) => String(entry).trim()).filter(Boolean))];
}

function validateCredentialRef(value, proxyName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new NetworkRouteError(
      `proxies["${proxyName}"].passwordRef must be an environment-style identifier`,
      "INVALID_CREDENTIAL_REF",
    );
  }
  return value;
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export { MODES, PROXY_ENV_KEYS, REGISTRY_KEY };
