/**
 * Sanitized status projection for dsh-system-proxy observability.
 *
 * The `systemProxyStatus` Service and the Typert Remote expose ONLY this pure
 * JSON shape: redacted proxy URLs (credentials never leave `display`), bounded
 * per-host health, and resolved policy values. No request data, no tokens, no
 * internal handles.
 */

import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json");
const HEALTH_CAP = 200; // per-host health entries included per status snapshot

/**
 * Build the sanitized status object from the live routing state.
 * @param state - `{ enabled, patchNodeHttp, registry?, health?, defaults? }`,
 *   or null before the transports are installed.
 * @returns a plain JSON-serializable object.
 */
export function buildStatus(state) {
  const s = state ?? {};
  const proxies = [];
  if (s.registry && s.registry.entries) {
    for (const entry of s.registry.entries.values()) {
      proxies.push({
        name: entry.resolved.name,
        scheme: entry.resolved.scheme,
        url: entry.resolved.display, // redacted: credentials are never included
      });
    }
  }
  let health = {};
  if (s.health && typeof s.health.snapshot === "function") {
    const snapshot = s.health.snapshot();
    const hosts = Object.keys(snapshot);
    for (const host of hosts.slice(0, HEALTH_CAP)) health[host] = snapshot[host];
    if (hosts.length > HEALTH_CAP) health.__truncated = hosts.length - HEALTH_CAP;
  }
  return {
    plugin: "dsh-system-proxy",
    version,
    enabled: Boolean(s.enabled),
    patchNodeHttp: Boolean(s.patchNodeHttp),
    proxies,
    strategy: s.defaults?.strategy ?? null,
    fallback:
      s.defaults !== undefined && s.defaults !== null
        ? {
            directTimeoutMs: s.defaults.directTimeoutMs,
            latencyThresholdMs: s.defaults.latencyThresholdMs,
            cooldownMs: s.defaults.cooldownMs,
            methods: s.defaults.methods,
          }
        : null,
    health,
  };
}
