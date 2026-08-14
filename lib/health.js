/**
 * Per-host health memory for dsh-system-proxy.
 *
 * Tracks exponentially-weighted moving average (EWMA) latency per host and a
 * failure cooldown with exponential backoff. The `fallback` strategy consults
 * this to decide whether a host should skip straight to the proxy (previous
 * connect-phase failure, or EWMA latency above the configured threshold).
 */

const EWMA_ALPHA = 0.3; // weight of the newest sample
const COOLDOWN_CAP_MS = 5 * 60_000;
const COOLDOWN_BACKOFF = 2; // failures double the cooldown window
const DEFAULT_MAX_ENTRIES = 10_000;

export class HealthRegistry {
  /**
   * @param options - `{ cooldownMs?, latencyThresholdMs?, maxEntries? }`.
   *   `maxEntries` bounds the per-host map; the least-recently-seen entry is
   *   evicted when the cap is exceeded, so long-running hosts cannot grow the
   *   map without bound.
   */
  constructor(options = {}) {
    this.cooldownMs = positive(options.cooldownMs, 60_000);
    this.latencyThresholdMs = positive(options.latencyThresholdMs, 1_500);
    this.maxEntries = positive(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.entries = new Map(); // host -> { ewma, failures, cooldownUntil, lastSeen }
  }

  /** Internal per-host record, lazily created (LRU eviction at the cap). */
  record(host) {
    let entry = this.entries.get(host);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) this.evictOne();
      entry = { ewma: null, failures: 0, cooldownUntil: 0, lastSeen: 0 };
      this.entries.set(host, entry);
    }
    entry.lastSeen = Date.now();
    return entry;
  }

  /** Evict the least-recently-seen entry when the map is at its cap. */
  evictOne() {
    let oldestHost = null;
    let oldestSeen = Infinity;
    for (const [host, entry] of this.entries) {
      if (entry.lastSeen < oldestSeen) {
        oldestSeen = entry.lastSeen;
        oldestHost = host;
      }
    }
    if (oldestHost !== null) this.entries.delete(oldestHost);
  }

  /**
   * Record a successful request (time to response headers).
   * @param host - lowercase hostname.
   * @param latencyMs - observed latency in milliseconds.
   */
  recordSuccess(host, latencyMs) {
    if (!host || !Number.isFinite(latencyMs) || latencyMs < 0) return;
    const entry = this.record(host);
    entry.failures = 0;
    entry.ewma =
      entry.ewma === null
        ? latencyMs
        : EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * entry.ewma;
  }

  /**
   * Record a connect-phase failure. Starts/extends a cooldown window with
   * exponential backoff, capped.
   * @param host - lowercase hostname.
   */
  recordFailure(host) {
    if (!host) return;
    const entry = this.record(host);
    entry.failures += 1;
    const window = Math.min(
      this.cooldownMs * COOLDOWN_BACKOFF ** (entry.failures - 1),
      COOLDOWN_CAP_MS,
    );
    entry.cooldownUntil = Date.now() + window;
  }

  /** Whether the host is currently in a failure cooldown window. */
  isCoolingDown(host) {
    const entry = this.entries.get(host);
    if (!entry) return false;
    return Date.now() < entry.cooldownUntil;
  }

  /** EWMA latency of the host, or null when no samples exist yet. */
  ewmaOf(host) {
    const entry = this.entries.get(host);
    return entry ? entry.ewma : null;
  }

  /**
   * Record a request that completed through a proxy. Tracked separately from
   * the direct EWMA (which drives `preferProxy`), for status/observability.
   * @param host - lowercase hostname.
   * @param latencyMs - observed latency in milliseconds.
   */
  recordProxy(host, latencyMs) {
    if (!host || !Number.isFinite(latencyMs) || latencyMs < 0) return;
    const entry = this.record(host);
    entry.proxyEwma =
      entry.proxyEwma === undefined
        ? latencyMs
        : EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * entry.proxyEwma;
    entry.lastProxyLatencyMs = latencyMs;
  }

  /**
   * Whether the fallback strategy should prefer the proxy for this host:
   * cooling down after a failure, or observed EWMA latency above threshold.
   */
  preferProxy(host) {
    if (this.isCoolingDown(host)) return true;
    const ewma = this.ewmaOf(host);
    return ewma !== null && ewma > this.latencyThresholdMs;
  }

  /** Detached snapshot for status/logging (no live references). */
  snapshot() {
    const out = {};
    for (const [host, entry] of this.entries) {
      out[host] = {
        ewmaMs: entry.ewma === null ? null : Math.round(entry.ewma * 10) / 10,
        proxyEwmaMs: entry.proxyEwma === undefined ? null : Math.round(entry.proxyEwma * 10) / 10,
        failures: entry.failures,
        coolingDown: Date.now() < entry.cooldownUntil,
      };
    }
    return out;
  }
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
