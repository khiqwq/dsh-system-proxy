/**
 * dsh-system-proxy — smart outbound HTTP(S) routing for DeepSeek Harness.
 *
 *  - Named proxies: http / https / socks4 / socks4a / socks5 / socks5h, plus
 *    `system` / `env` sources. The legacy `mode`/`url` surface maps onto an
 *    implicit `default` proxy and keeps its exact behavior.
 *  - Rules: `host` / `provider` / `plugin` fields with actions
 *    `direct` / `proxy` / `fallback` / `block`. First match wins.
 *  - `fallback`: direct-first, switch to the proxy on connect-phase failure
 *    or latency threshold / health memory — only for safe-to-replay requests
 *    (GET/HEAD/OPTIONS/TRACE with a buffered body; POST and streams are never
 *    auto-replayed).
 *  - Provider/plugin attribution is explicit, never inferred: other plugins
 *    wrap calls with `ctx.networkRoute.run({ provider, plugin }, fn)` (or the
 *    module-level `runWithRoute`); optionally `trustRouteHeaders` enables
 *    `x-dsh-route-provider` / `x-dsh-route-plugin` request headers.
 *  - Per-host health memory: EWMA latency + failure cooldown with backoff.
 *  - Credentials in proxy URLs are redacted in every log line.
 *
 * Backward compatibility: `enabled / mode / url / noProxy / only /
 * patchNodeHttp` behave exactly as before when the new surface is unused.
 */

import z from "@deepseek-ai/schemastery";
import { bindTypertRemote } from "@deepseek-ai/dsh-typert-protocol";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { normalizeConfig, resolveProxyPlan } from "./config.js";
import { NetworkRouteError } from "./errors.js";
import { HealthRegistry } from "./health.js";
import { ProxyRegistry } from "./proxy.js";
import { createRouteService, runWithRoute, currentRoute, wrapAsyncIterable } from "./scope.js";
import { buildStatus } from "./status.js";
import { installTransports, makeResolver } from "./transport.js";

/**
 * Strict, hand-written Typert manifest (no decorators / generated code):
 * namespace `systemProxyStatus`, method `status`, backed by the
 * `systemProxyStatus` Service. Registered through the registry only when the
 * deployment mounts typert; the disposer is tied to the plugin fiber so hot
 * reloads withdraw before re-registering.
 */
const STATUS_MANIFEST = Object.freeze({
  package: "dsh-system-proxy",
  face: "host",
  schemas: [],
  invocations: [
    Object.freeze({
      id: "dsh-system-proxy.status",
      service: "systemProxyStatus",
      namespace: "systemProxyStatus",
      method: "status",
      implementation: "status",
      parameters: [],
      result: { mode: "src-json" },
      invocation: { kind: "direct" },
    }),
  ],
});

export const name = "dsh-system-proxy";
export const SYSTEM_PROXY_SETTINGS_NAMESPACE = settingsNamespace("system-proxy");
export const description =
  "Smart outbound routing: named proxies (http/https/socks4/4a/5/5h), " +
  "per-host/provider/plugin rules, direct-first fallback with health memory.";

const RuleSchema = z.object({
  host: z.union([z.string(), z.array(z.string())]),
  provider: z.union([z.string(), z.array(z.string())]),
  plugin: z.union([z.string(), z.array(z.string())]),
  action: z
    .union([z.const("direct"), z.const("proxy"), z.const("fallback"), z.const("block")])
    .required(),
  proxy: z.string(),
  directTimeoutMs: z.number(),
  proxyTimeoutMs: z.number(),
});

const ProxySpecSchema = z.union([
  z.string(),
  z.object({
    url: z.string().default(""),
    source: z.union([z.const("system"), z.const("env")]),
    username: z.string(),
    password: z.string().role("secret"),
  }),
]);

const DefaultSchema = z.object({
  strategy: z.union([z.const("direct"), z.const("proxy"), z.const("fallback")]),
  proxy: z.string(),
  directTimeoutMs: z.number(),
  latencyThresholdMs: z.number(),
  cooldownMs: z.number(),
  methods: z.array(z.string()),
});

/** Plugin configuration schema — documentation and settings seams. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  mode: z
    .union([z.const("auto"), z.const("env"), z.const("system"), z.const("manual")])
    .default("auto"),
  url: z.string().default(""),
  noProxy: z.array(z.string()),
  only: z.array(z.string()),
  patchNodeHttp: z.boolean().default(true),
  trustRouteHeaders: z.boolean().default(false),
  routeHeaderPrefix: z.string().default("x-dsh-route"),
  protectLocal: z.boolean().default(true),
  protectPrivate: z.boolean().default(true),
  healthMaxEntries: z.number().default(10000),
  proxies: z.dict(ProxySpecSchema).default({}),
  rules: z.array(RuleSchema).default([]),
  default: DefaultSchema,
});

export { NetworkRouteError, runWithRoute, currentRoute, wrapAsyncIterable };

/**
 * Cordis plugin entry: normalize config, resolve proxies, install the
 * transport patches, expose the `networkRoute` service, and restore
 * everything on disposal.
 * @param ctx - the Cordis context of the plugin fiber.
 * @param config - the loader entry config (may be partial or absent).
 */
export function apply(ctx, config) {
  let currentConfig = () => config;
  let reloadQueue = Promise.resolve();

  const routeService = createRouteService();
  try {
    ctx.provide?.("networkRoute", routeService);
  } catch (error) {
    ctx.logger.debug(`dsh-system-proxy: could not provide networkRoute service: ${error.message}`);
  }

  // ── observability: systemProxyStatus Service + Typert Remote ─────────────
  // Status is a Cordis Service (host-side) and, when the deployment mounts the
  // typert registry, a strict Remote manifest (namespace `systemProxyStatus` /
  // method `status`) served by the typert gateway — no bare /status endpoint.
  const statusRef = { state: null };
  const statusService = {
    status() {
      return buildStatus(statusRef.state ?? { enabled: normalizeConfig(currentConfig()).enabled });
    },
  };
  statusService.typertRemote = bindTypertRemote(statusService, "systemProxyStatus");
  try {
    ctx.provide?.("systemProxyStatus", statusService);
  } catch (error) {
    ctx.logger.debug(`dsh-system-proxy: could not provide systemProxyStatus service: ${error.message}`);
  }
  const typert = typeof ctx.get === "function" ? ctx.get("typert") : undefined;
  if (typert && typeof typert.register === "function") {
    try {
      const disposeRemote = typert.register(STATUS_MANIFEST);
      // The manifest disposer must ride THIS plugin's fiber: on hot reload the
      // previous registration is withdrawn before the new apply() registers
      // again, so the registry never sees a duplicate endpoint.
      ctx.effect(
        () => () => {
          try {
            disposeRemote();
          } catch (error) {
            ctx.logger.warn(`dsh-system-proxy: failed to withdraw typert manifest: ${error.message}`);
          }
        },
        "dsh-system-proxy: typert manifest",
      );
    } catch (error) {
      ctx.logger.warn(`dsh-system-proxy: typert manifest registration failed: ${error.message}`);
    }
  }

  let runtime = null;
  let disposed = false;
  ctx.effect(
    () => () => {
      disposed = true;
      statusRef.state = null;
      if (runtime !== null) {
        runtime.restore();
        runtime.close?.();
        runtime = null;
      }
    },
    "dsh-system-proxy: restore transports",
  );

  const reload = async () => {
    const plan = normalizeConfig(currentConfig());
    statusRef.state = null;
    if (runtime !== null) {
      runtime.restore();
      runtime.close?.();
      runtime = null;
    }
    if (!plan.enabled) {
      ctx.logger.info(
        "dsh-system-proxy: disabled (DSH_PROXY_DISABLE or config.enabled) — transports untouched",
      );
      return;
    }

    let resolved;
    try {
      resolved = await resolveProxyPlan(plan);
    } catch (error) {
      ctx.logger.error(`dsh-system-proxy: failed to resolve proxy configuration: ${error.message}`);
      return;
    }
    if (disposed) return;

    // Pure legacy config with no resolvable proxy: keep the old inert behavior.
    if (resolved.legacyMode && resolved.resolved.size === 0) {
      ctx.logger.warn(
        "dsh-system-proxy: no proxy found — direct connections stay as-is " +
          "(set mode: manual + url, export HTTPS_PROXY, or start your proxy tool; " +
          "the OS system proxy is currently off)",
      );
      return;
    }

    const registry = new ProxyRegistry();
    for (const proxy of resolved.resolved.values()) registry.add(proxy);
    const health = new HealthRegistry({
      cooldownMs: resolved.defaults.cooldownMs,
      latencyThresholdMs: resolved.defaults.latencyThresholdMs,
      maxEntries: resolved.healthMaxEntries,
    });

    // Final rule list: user block rules first, then the immutable noProxy
    // safety baseline, then other user rules, then legacy `only`.
    const directBaseline = resolved.noProxy.length > 0
      ? [{ host: [...resolved.noProxy], provider: [], plugin: [], action: "direct", proxy: undefined, directTimeoutMs: undefined, proxyTimeoutMs: undefined }]
      : [];
    const onlyRules = resolved.only.length > 0
      ? [{ host: [...resolved.only], provider: [], plugin: [], action: "proxy", proxy: "default", directTimeoutMs: undefined, proxyTimeoutMs: undefined }]
      : [];
    // User block rules must be able to deny even protected/private targets;
    // immutable safety-direct rules then prevent user proxy/fallback rules from
    // tunneling localhost, metadata or private ranges. Other user rules follow.
    const blockRules = resolved.rules.filter((rule) => rule.action === "block");
    const routeRules = resolved.rules.filter((rule) => rule.action !== "block");
    const rules = [...blockRules, ...directBaseline, ...routeRules, ...onlyRules];

    const options = {
      trustRouteHeaders: resolved.trustRouteHeaders,
      routeHeaderPrefix: resolved.routeHeaderPrefix,
    };
    const resolve = makeResolver({
      rules,
      defaults: resolved.defaults,
      registry,
      logger: ctx.logger,
    });

    try {
      runtime = installTransports({
        originalFetch: globalThis.fetch,
        resolve,
        registry,
        health,
        defaults: resolved.defaults,
        options,
        logger: ctx.logger,
        patchNodeHttp: resolved.patchNodeHttp,
      });
      statusRef.state = {
        enabled: resolved.enabled,
        patchNodeHttp: resolved.patchNodeHttp,
        registry,
        health,
        defaults: resolved.defaults,
      };
    } catch (error) {
      runtime = null;
      ctx.logger.error(`dsh-system-proxy: failed to install transport patches: ${error.message}`);
      return;
    }

    const proxyList = registry.summary().join(", ");
    const strategy = resolved.defaults.strategy;
    const scopeDesc =
      resolved.rules.length > 0
        ? `${resolved.rules.length} rule(s); default ${strategy}`
        : `legacy: default ${strategy} (${resolved.noProxy.join(", ")} direct)`;
    ctx.logger.info(
      `dsh-system-proxy: proxies [${proxyList}] — ${scopeDesc}` +
        (resolved.patchNodeHttp ? " (fetch + node http/https)" : " (fetch only)"),
    );
    ctx.logger.info(
      `dsh-system-proxy: fallback methods ${resolved.defaults.methods.join("/")}, ` +
        `directTimeoutMs ${resolved.defaults.directTimeoutMs}, latencyThresholdMs ${resolved.defaults.latencyThresholdMs}`,
    );
  };

  const scheduleReload = () => {
    reloadQueue = reloadQueue.then(reload, reload);
  };
  installSettingsSection(ctx, SYSTEM_PROXY_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      currentConfig = source;
    },
    onChange: scheduleReload,
  });
  scheduleReload();
}
