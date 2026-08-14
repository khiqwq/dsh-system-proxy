/**
 * Transport patching and route dispatch for dsh-system-proxy.
 *
 * Two patched surfaces:
 *  1. `globalThis.fetch` — full routing including:
 *       - the safe fallback path (direct attempt → proxy on connect-phase
 *         failure, only for replayable requests), and
 *       - per-hop redirect handling: 3xx responses are followed manually so
 *         EVERY hop is re-routed through the rule engine (a redirect target
 *         may be direct, proxied via another proxy, or blocked).
 *  2. `node:http` / `node:https` request/get — routing by health-aware agent
 *     selection (no post-hoc retry: the caller owns the request object).
 *
 * Fallback safety rules (enforced in `fetchWithFallback`):
 *  - only requests whose method is in `default.methods` (GET/HEAD/OPTIONS/
 *    TRACE by default) are replayed on another route (POST defaults to no
 *    retry);
 *  - the body must be buffered and under a size cap (streams / FormData are
 *    never replayed);
 *  - the STRICT connect-phase classification is event-based: a direct attempt
 *    is replayed only when undici reported onError (or our own connect
 *    timeout) AND onConnect was called ZERO times (>= 1 is ambiguous — bytes
 *    may have reached the server) AND no onHeaders / onResponseStart was ever
 *    observed (a response that started is never replayed);
 *  - a caller-aborted request is never retried.
 */

import http from "node:http";
import https from "node:https";
import { Agent, fetch as undiciFetch } from "undici";
import { NetworkRouteError } from "./errors.js";
import { matchRule } from "./rules.js";
import { currentRoute } from "./scope.js";

/**
 * A dedicated plain Agent for the instrumented DIRECT attempt in fallback.
 * Do NOT use undici's global dispatcher here: host environments (e.g. DSH)
 * may replace it with an EnvHttpProxyAgent, which would silently route the
 * "direct" attempt through an environment proxy and break both the retry
 * classification and the direct-first contract.
 */
const DIRECT_AGENT = new Agent();

/** Upper bound for a request body that may be replayed on another route. */
const MAX_REPLAYABLE_BODY_BYTES = 4 * 1024 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

/** Build the route resolver: rules first, then the default strategy. */
export function makeResolver({ rules, defaults, registry, logger }) {
  const resolve = (hostname, facts) => {
    const rule = matchRule(rules, {
      host: hostname ?? null,
      port: facts?.port,
      provider: facts?.provider ?? null,
      plugin: facts?.plugin ?? null,
    });
    const fromRule = rule
      ? routeForAction(rule.action, rule.proxy, rule.directTimeoutMs, rule.proxyTimeoutMs)
      : null;
    if (fromRule) return fromRule;

    switch (defaults.strategy) {
      case "direct":
        return { kind: "direct" };
      case "proxy":
        return withProxy({ kind: "proxy" }, defaults.proxy);
      case "fallback":
      default:
        return withProxy(
          { kind: "fallback", directTimeoutMs: defaults.directTimeoutMs },
          defaults.proxy,
        );
    }
  };

  function routeForAction(action, proxyName, directTimeoutMs, proxyTimeoutMs) {
    switch (action) {
      case "block":
        return { kind: "block" };
      case "direct":
        return { kind: "direct" };
      case "proxy":
        return withProxy({ kind: "proxy", timeoutMs: proxyTimeoutMs }, proxyName);
      case "fallback":
        return withProxy(
          {
            kind: "fallback",
            directTimeoutMs: directTimeoutMs ?? defaults.directTimeoutMs,
            timeoutMs: proxyTimeoutMs,
          },
          proxyName,
        );
      default:
        return null;
    }
  }

  function withProxy(route, proxyName) {
    const entry = registry.get(proxyName);
    if (!entry) {
      throw new NetworkRouteError(
        `proxy "${proxyName}" is required by the selected route but is not available`,
        "UNKNOWN_PROXY",
      );
    }
    return { ...route, proxy: entry };
  }

  return resolve;
}

/** Extract hostname/protocol/effective-port from a fetch input; null when not http(s). */
export function extractFetchTarget(input) {
  try {
    let url;
    if (typeof input === "string" || input instanceof URL) {
      url = new URL(input instanceof URL ? input.href : input);
    } else if (input && typeof input === "object" && typeof input.url === "string") {
      url = new URL(input.url);
    } else {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Node >= ? returns IPv6 hostnames WITH brackets ("[::1]"); rules match
    // the bare address, so strip them.
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return {
      hostname,
      protocol: url.protocol,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    };
  } catch {
    return null;
  }
}

/** Extract provider/plugin attribution from the ALS scope plus (optional) headers. */
export function readRouteFacts(input, init, options) {
  const scope = currentRoute();
  let provider = scope?.provider ?? null;
  let plugin = scope?.plugin ?? null;
  if (options.trustRouteHeaders) {
    const headers = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
    const p = findHeader(headers, `${options.routeHeaderPrefix}-provider`);
    const pl = findHeader(headers, `${options.routeHeaderPrefix}-plugin`);
    if (p) provider = p.toLowerCase();
    if (pl) plugin = pl.toLowerCase();
  }
  return { provider, plugin };
}

function findHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === null || value === undefined ? null : String(value);
  }
  if (Array.isArray(headers)) {
    const found = headers.find((pair) => pair && String(pair[0]).toLowerCase() === name);
    return found ? String(found[1]) : null;
  }
  if (typeof headers === "object") {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) return String(headers[key]);
    }
  }
  return null;
}

/**
 * Return a copy of `headers` without the internal route headers
 * (`<prefix>-provider` / `<prefix>-plugin`), or null when there is nothing to
 * strip (so callers can avoid touching the original).
 */
function cleanRouteHeaders(headers, options) {
  if (!headers) return null;
  const drop = new Set([`${options.routeHeaderPrefix}-provider`, `${options.routeHeaderPrefix}-plugin`]);
  if (typeof headers.forEach === "function") {
    const next = new Headers();
    headers.forEach((value, key) => {
      if (!drop.has(key.toLowerCase())) next.append(key, value);
    });
    return next;
  }
  if (Array.isArray(headers)) {
    const filtered = headers.filter((pair) => pair && !drop.has(String(pair[0]).toLowerCase()));
    return filtered.length === headers.length ? null : filtered;
  }
  if (typeof headers === "object") {
    const next = {};
    let changed = false;
    for (const [key, value] of Object.entries(headers)) {
      if (drop.has(key.toLowerCase())) {
        changed = true;
        continue;
      }
      next[key] = value;
    }
    return changed ? next : null;
  }
  return null;
}

/** Remove internal route headers before dispatch, including Request input headers. */
function sanitizeInit(input, init, options) {
  const sourceHeaders =
    init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  const headers = cleanRouteHeaders(sourceHeaders, options);
  return headers === null ? init : { ...(init ?? {}), headers };
}

const REDIRECT_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
]);

/** Strip origin-bound credentials when a redirect crosses an origin boundary. */
function stripRedirectCredentials(headers) {
  if (!headers) return headers;
  const next = new Headers(headers);
  for (const name of REDIRECT_CREDENTIAL_HEADERS) next.delete(name);
  return next;
}

/** Whether a fetch body can be safely replayed on a second route. */
export function bodyIsReplayable(body) {
  if (body === undefined || body === null) return true;
  if (typeof body === "string") return body.length <= MAX_REPLAYABLE_BODY_BYTES;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size <= MAX_REPLAYABLE_BODY_BYTES;
  if (typeof FormData !== "undefined" && body instanceof FormData) return false;
  if (body instanceof ArrayBuffer) return body.byteLength <= MAX_REPLAYABLE_BODY_BYTES;
  if (ArrayBuffer.isView(body)) return body.byteLength <= MAX_REPLAYABLE_BODY_BYTES;
  return false; // ReadableStream, async iterable, anything else
}

function extractMethod(input, init) {
  const value =
    typeof init?.method === "string" && init.method.trim() !== ""
      ? init.method
      : input && typeof input === "object" && typeof input.method === "string"
        ? input.method
        : "GET";
  return value.toUpperCase();
}

function extractBody(input, init) {
  if (init && Object.prototype.hasOwnProperty.call(init, "body")) return init.body;
  if (typeof Request !== "undefined" && input instanceof Request) {
    if (input.bodyUsed) return Symbol.for("dsh.consumed-body");
    return input.body;
  }
  return undefined;
}

function inputUrlString(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && typeof input.url === "string") return input.url;
  return null;
}

/** Fetch redirect semantics: which method the next hop uses. */
function redirectMethod(status, method) {
  if (status === 303 && method !== "HEAD") return "GET";
  if ((status === 301 || status === 302) && method !== "GET" && method !== "HEAD") return "GET";
  return method;
}

async function drainResponse(response) {
  try {
    await response.body?.cancel();
  } catch {
    /* ignore */
  }
}

/** Tag a manually-followed response with the final URL / redirected flag. */
function markRedirected(response, url) {
  if (!url) return response;
  try {
    // Own accessors shadow the prototype getters without breaking undici's
    // private-field access (a Proxy would break `response.text()`).
    Object.defineProperty(response, "url", { get: () => url, configurable: true });
    Object.defineProperty(response, "redirected", { get: () => true, configurable: true });
  } catch {
    /* best effort */
  }
  return response;
}

/**
 * One routed hop, then manual redirect following so every hop is re-routed.
 * `init.redirect` is forced to "manual" for routed requests.
 */
async function followRedirects(input, init, target, hopsLeft, env) {
  const facts = { ...readRouteFacts(input, init, env.options), port: target.port };
  const route = env.resolve(target.hostname, facts);
  const dispatchInit = sanitizeInit(input, init, env.options);
  let response;
  switch (route.kind) {
    case "block":
      throw new NetworkRouteError(
        `blocked by dsh-system-proxy rule (host=${target.hostname})`,
        "NETWORK_BLOCKED",
      );
    case "direct":
      response = await env.originalFetch(input, { ...dispatchInit, redirect: "manual" });
      break;
    case "proxy":
      response = await fetchViaProxy(input, { ...dispatchInit, redirect: "manual" }, route, target.hostname, env);
      break;
    case "fallback":
      response = await fetchWithFallback(input, { ...dispatchInit, redirect: "manual" }, route, target.hostname, env);
      break;
    default:
      response = await env.originalFetch(input, init);
      return response;
  }

  if (!REDIRECT_STATUS.has(response.status)) return response;

  // Honor the caller's redirect mode: manual → return the 3xx as-is; error →
  // throw like native fetch; follow (default) → re-route each hop.
  const requestedMode = init?.redirect ?? "follow";
  if (requestedMode === "manual") return response;
  if (requestedMode === "error") {
    throw new TypeError(`unexpected redirect: ${response.status}`);
  }
  const location = response.headers.get("location");
  const base = inputUrlString(input);
  if (!location || !base) return response;
  await drainResponse(response);

  if (hopsLeft <= 0) {
    throw new NetworkRouteError("too many redirects while routing", "TOO_MANY_REDIRECTS");
  }
  const nextUrl = new URL(location, base);
  const method = extractMethod(input, init);
  const nextMethod = redirectMethod(response.status, method);
  const nextInit = { ...init, method: nextMethod, redirect: "manual" };
  const currentUrl = new URL(base);
  if (currentUrl.origin !== nextUrl.origin) {
    const sourceHeaders =
      init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
    nextInit.headers = stripRedirectCredentials(sourceHeaders);
  }
  if (nextMethod !== method) {
    nextInit.body = undefined; // converted to GET
  } else if (!bodyIsReplayable(extractBody(input, init))) {
    // A stream/FormData body cannot be re-sent on a 307/308 hop; surface the
    // redirect response as-is rather than silently dropping the body.
    return response;
  }
  const nextInput = nextUrl.href;
  const nextTarget = extractFetchTarget(nextInput);
  if (!nextTarget) return env.originalFetch(nextInput, nextInit);
  const finalResponse = await followRedirects(nextInput, nextInit, nextTarget, hopsLeft - 1, env);
  return markRedirected(finalResponse, nextUrl.href);
}

/** Install the global fetch wrapper. Returns a restore function. */
export function installFetchWrapper({ originalFetch, resolve, registry, health, defaults, options, logger }) {
  const wrapper = async function fetch(input, init) {
    const target = extractFetchTarget(input);
    if (!target) return originalFetch(input, init);
    const env = {
      originalFetch,
      resolve,
      registry,
      health,
      defaults,
      options,
      logger,
    };
    return followRedirects(input, init, target, MAX_REDIRECTS, env);
  };

  globalThis.fetch = wrapper;
  return () => {
    if (globalThis.fetch === wrapper) globalThis.fetch = originalFetch;
  };
}

/** Dispatch one fetch through the named proxy and record proxy-path latency. */
async function fetchViaProxy(input, init, route, hostname, env) {
  const t0 = performance.now();
  const res = await env.registry.fetch(route.proxy.resolved.name, input, init);
  env.health?.recordProxy(hostname, performance.now() - t0);
  return res;
}

/**
 * The `fallback` strategy for fetch: direct first (bounded), proxy on
 * connect-phase failure — only for safe-to-replay requests.
 */
async function fetchWithFallback(input, init, route, hostname, env) {
  const { registry, health, defaults, originalFetch, logger } = env;
  const proxyEnv = { registry, health };
  const method = extractMethod(input, init);
  const safe = defaults.methods.includes(method) && bodyIsReplayable(extractBody(input, init));

  if (!safe) {
    // Not replayable: route selection only (health may still prefer proxy).
    if (health.preferProxy(hostname)) return fetchViaProxy(input, init, route, hostname, proxyEnv);
    const t0 = performance.now();
    try {
      const res = await originalFetch(input, init);
      health.recordSuccess(hostname, performance.now() - t0);
      return res;
    } catch (error) {
      health.recordFailure(hostname);
      throw error;
    }
  }

  if (health.preferProxy(hostname)) {
    return fetchViaProxy(input, init, route, hostname, proxyEnv);
  }

  const callerSignal = init?.signal ?? null;
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const onCallerAbort = () => {
    callerAborted = true;
    controller.abort(callerSignal?.reason ?? new Error("aborted by caller"));
  };
  if (callerSignal) {
    if (callerSignal.aborted) return originalFetch(input, init);
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timeoutMs = route.directTimeoutMs ?? defaults.directTimeoutMs ?? 0;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`direct connect timeout after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

  // STRICT connect-phase classification via undici handler events. A direct
  // attempt is safe to replay ONLY when the connection was NEVER established
  // (onConnect fired zero times — undici may call it once per connection
  // attempt, so >= 1 means bytes could have reached the server → ambiguous,
  // never retry) and no response bytes arrived (onHeaders/onResponseStart
  // observed → never retry). The failure must arrive through onError (or our
  // own connect timeout); a caller abort is never retried. POST and
  // non-replayable bodies are excluded by the `safe` gate above.
  const events = { connects: 0, headers: false, responseStart: false };
  const trackingDispatcher = {
    dispatch(opts, handler) {
      return DIRECT_AGENT.dispatch(opts, trackingHandler(handler, events));
    },
  };

  const t0 = performance.now();
  try {
    const res = await undiciFetch(input, {
      ...init,
      signal: controller.signal,
      dispatcher: trackingDispatcher,
    });
    health.recordSuccess(hostname, performance.now() - t0);
    return res;
  } catch (error) {
    health.recordFailure(hostname);
    if (callerAborted || callerSignal?.aborted) throw error;
    const safeToRetry =
      events.connects === 0 && !events.headers && !events.responseStart && (timedOut || events.error !== undefined);
    if (!safeToRetry) throw error;
    logger?.info?.(
      `dsh-system-proxy: fallback ${hostname} → ${route.proxy?.resolved?.name ?? "proxy"} ` +
        `(${timedOut ? "direct timeout" : "connect failure"}, ${method})`,
    );
    return fetchViaProxy(input, init, route, hostname, proxyEnv);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Wrap an undici dispatch handler so the fallback path can classify failures
 * by transport events. undici v7's `onConnect(abort)` takes a single argument
 * (no context), and may fire once per connection attempt — counting it is the
 * only reliable "was the connection ever established" signal.
 */
function trackingHandler(handler, events) {
  return new Proxy(handler, {
    get(target, prop, receiver) {
      switch (prop) {
        case "onConnect":
          return (abort) => {
            events.connects += 1;
            return target.onConnect?.(abort);
          };
        case "onHeaders":
          return (...args) => {
            events.headers = true;
            return target.onHeaders?.(...args);
          };
        case "onResponseStart":
          return (...args) => {
            events.responseStart = true;
            return target.onResponseStart?.(...args);
          };
        case "onError":
          return (error) => {
            events.error = error;
            return target.onError?.(error);
          };
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
}

/** Overload-normalized node http(s).request arguments. */
function parseRequestArgs(args) {
  const first = args[0];
  let url = null;
  let options = {};
  let callback = null;
  if (typeof first === "string" || first instanceof URL) {
    // URL forms: (url[, options][, callback]) and (url, callback) shorthand.
    // The FIRST function after the url is the callback (matches node's own
    // options-as-function overload); the first plain object is options. This
    // scan can never drop the callback for (url, cb).
    url = first;
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i];
      if (typeof arg === "function") {
        callback = arg;
        break;
      }
      if (arg && typeof arg === "object") options = arg;
    }
  } else if (first && typeof first === "object") {
    options = first;
    if (typeof args[1] === "function") callback = args[1];
  } else if (typeof first === "function") {
    callback = first;
  }
  return { url, options, callback };
}

/** Target hostname for a node http(s) request, from url form or options form. */
function requestTargetHost(url, options) {
  try {
    if (typeof url === "string") return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url instanceof URL) return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    /* fall through to options */
  }
  const hostname = options.hostname;
  if (typeof hostname === "string" && hostname.length > 0) {
    return hostname.toLowerCase().replace(/^\[|\]$/g, "");
  }
  const host = options.host;
  if (typeof host === "string" && host.length > 0) {
    const h = host.trim();
    // bracketed IPv6: "[::1]:8080" / "[::1]"
    if (h.startsWith("[")) {
      const close = h.indexOf("]");
      if (close !== -1) return h.slice(1, close).toLowerCase();
    }
    // bare IPv6 ("::1") is not "host:port" — treat it whole
    if (h.split(":").length - 1 > 1) return h.toLowerCase();
    const idx = h.lastIndexOf(":");
    return (idx === -1 ? h : h.slice(0, idx)).toLowerCase();
  }
  return null;
}

/** Effective target port for a node http(s) request. */
function requestTargetPort(url, options, secure) {
  try {
    if (typeof url === "string" || url instanceof URL) {
      const parsed = new URL(url instanceof URL ? url.href : url);
      if (parsed.port) return Number(parsed.port);
    }
  } catch {
    /* fall through to options */
  }
  const port = Number(options.port);
  if (Number.isFinite(port) && port > 0) return port;
  return secure ? 443 : 80;
}

function dispatchNodeProxy(original, url, opts, callback, secure, route) {
  const agent = secure ? route.proxy.httpsAgent : route.proxy.httpAgent;
  if (!agent) {
    return original(
      ...(url !== null
        ? [url, opts, callback].filter((v) => v !== undefined)
        : [opts, callback].filter((v) => v !== undefined)),
    );
  }
  const next = { ...opts, agent };
  if (url !== null) return original(url, next, callback ?? undefined);
  return original(next, callback ?? undefined);
}

/** Rebuild node request args after cleaning route headers / injecting agent. */
function dispatchOriginal(original, url, opts, callback) {
  if (url !== null) return original(url, opts, callback ?? undefined);
  return original(opts, callback ?? undefined);
}

/** Wrap one node http(s).request implementation with route dispatch. */
function makeRequestWrapper(original, secure, resolve, registry, health, defaults, options) {
  return function request(...args) {
    const { url, options: opts, callback } = parseRequestArgs(args);
    const host = requestTargetHost(url, opts);
    if (host === null) return original(...args);
    const facts = {
      ...readRouteFacts(null, { headers: opts?.headers }, options),
      port: requestTargetPort(url, opts, secure),
    };
    const route = resolve(host, facts);
    const cleanHeaders = cleanRouteHeaders(opts?.headers, options);
    const cleanOpts = cleanHeaders === null ? opts : { ...opts, headers: cleanHeaders };
    switch (route.kind) {
      case "block":
        throw new NetworkRouteError(
          `blocked by dsh-system-proxy rule (host=${host})`,
          "NETWORK_BLOCKED",
        );
      case "direct":
        return dispatchOriginal(original, url, cleanOpts, callback);
      case "proxy":
        return dispatchNodeProxy(original, url, cleanOpts, callback, secure, route);
      case "fallback":
        // node path: health-aware selection, no post-hoc retry.
        if (!health.preferProxy(host)) return dispatchOriginal(original, url, cleanOpts, callback);
        return dispatchNodeProxy(original, url, cleanOpts, callback, secure, route);
      default:
        return original(...args);
    }
  };
}

/** http.get / https.get delegate through the (patched) request implementation. */
function makeGetWrapper(requestImpl) {
  return function get(...args) {
    const req = requestImpl(...args);
    req.end();
    return req;
  };
}

/**
 * Install every transport patch. Returns a disposer that restores each
 * patched global only if it still points at our wrapper (so a later plugin
 * that wrapped us is not clobbered), plus `close()` for the agent pools.
 */
export function installTransports({
  originalFetch,
  resolve,
  registry,
  health,
  defaults,
  options,
  logger,
  patchNodeHttp,
}) {
  const restorers = [];

  if (typeof originalFetch === "function") {
    restorers.push(
      installFetchWrapper({ originalFetch, resolve, registry, health, defaults, options, logger }),
    );
  } else {
    logger.warn("dsh-system-proxy: globalThis.fetch is missing — fetch traffic cannot be routed");
  }

  if (patchNodeHttp) {
    const originalHttpRequest = http.request;
    const originalHttpsRequest = https.request;
    const originalHttpGet = http.get;
    const originalHttpsGet = https.get;

    const httpRequest = makeRequestWrapper(originalHttpRequest, false, resolve, registry, health, defaults, options);
    const httpsRequest = makeRequestWrapper(originalHttpsRequest, true, resolve, registry, health, defaults, options);
    const httpGet = makeGetWrapper(httpRequest);
    const httpsGet = makeGetWrapper(httpsRequest);

    http.request = httpRequest;
    https.request = httpsRequest;
    http.get = httpGet;
    https.get = httpsGet;

    restorers.push(
      () => {
        if (http.request === httpRequest) http.request = originalHttpRequest;
        if (http.get === httpGet) http.get = originalHttpGet;
      },
      () => {
        if (https.request === httpsRequest) https.request = originalHttpsRequest;
        if (https.get === httpsGet) https.get = originalHttpsGet;
      },
    );
  }

  return {
    restore() {
      for (const restore of restorers) {
        try {
          restore();
        } catch (error) {
          logger.warn(`dsh-system-proxy: failed to restore a transport patch: ${error.message}`);
        }
      }
    },
    /** Free every proxy agent (connection pools) without aborting in-flight. */
    close() {
      registry.close();
    },
  };
}
