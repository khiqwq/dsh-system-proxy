/**
 * Test suite for dsh-system-proxy (upgraded routing plugin).
 *
 * Covers:
 *   0. unit: rules (incl. `*` / host:port / CIDR), config normalization
 *      (env priority, safety noProxy, credential stripping), health EWMA
 *   1. legacy compatibility (mode/url/noProxy/only behave as before)
 *   2. named proxies + host rules (two proxies, distinct loopback hosts)
 *   3. provider/plugin attribution via runWithRoute scope
 *   4. block action (fetch + node https)
 *   5. fallback: safe GET replays on connect failure; unsafe POST does not
 *   6. socks5 / socks5h and socks4 / socks4a end-to-end on BOTH fetch and
 *      node http paths
 *   7. redirects are re-routed per hop (proxy → direct, direct → block)
 *   8. noProxy semantics: `*`, host:port, private/metadata safety defaults
 *   9. dispose: transports restored, agents closed, in-flight not aborted
 *  10. disabled configs
 *
 * Run: node test/run-test.mjs  (from the package root)
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { once } from "node:events";
import { apply, runWithRoute, wrapAsyncIterable, currentRoute } from "../lib/index.js";
import { HealthRegistry } from "../lib/health.js";
import { hostMatches, hostPortMatches, matchRule, normalizeRule } from "../lib/rules.js";
import { normalizeConfig, parseProxyUrl, makeResolvedProxy, resolveProxyPlan } from "../lib/config.js";
import { buildStatus } from "../lib/status.js";
import selfsigned from "selfsigned";

/** Local TLS server with a self-signed cert (deterministic https target). */
async function startTlsServer() {
  // selfsigned v5 is async (WebCrypto).
  const pems = await selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    { days: 1, keySize: 2048 },
  );
  const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`tls:${req.url}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

let failures = 0;
function check(label, condition, extra = "") {
  if (condition) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

// The test proxies forward upstream via node http — they MUST use the ORIGINAL
// implementation, not the plugin-patched one, or an in-process proxy would
// re-enter the routing wrapper and loop (real proxies are out-of-process).
const ORIGINAL_HTTP_REQUEST = http.request;

/** Minimal HTTP proxy: CONNECT tunneling + absolute-form http forwarding. */
function startProxy() {
  const seen = { connects: [], requests: [] };
  const server = http.createServer((req, res) => {
    seen.requests.push(req.url);
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const fwd = ORIGINAL_HTTP_REQUEST(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: req.headers,
      },
      (fres) => {
        res.writeHead(fres.statusCode, fres.headers);
        fres.pipe(res);
      },
    );
    fwd.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(fwd);
  });
  server.on("connect", (req, socket, head) => {
    seen.connects.push(req.url);
    const idx = req.url.lastIndexOf(":");
    const host = req.url.slice(0, idx);
    const port = Number(req.url.slice(idx + 1)) || 443;
    const upstream = net.connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    // Reply with an error status like a real proxy; silently ending the
    // socket makes undici re-dispatch in a tight loop.
    upstream.on("error", () => {
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.end();
    });
    socket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        seen,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      }),
    );
  });
}

/** Minimal SOCKS5 server (no auth): CONNECT over IPv4 / domain. */
function startSocks5Proxy() {
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = "greet";
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greet") {
        if (buffer.length < 2) return;
        const nmethods = buffer[1];
        if (buffer.length < 2 + nmethods) return;
        buffer = buffer.subarray(2 + nmethods);
        stage = "request";
        socket.write(Buffer.from([0x05, 0x00]));
      }
      if (stage !== "request") return;
      if (buffer.length < 4) return;
      const ver = buffer[0];
      const cmd = buffer[1];
      const atyp = buffer[3];
      if (ver !== 5 || cmd !== 1) {
        socket.end();
        return;
      }
      let host;
      let port;
      let headerLen;
      if (atyp === 1) {
        if (buffer.length < 10) return;
        host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
        port = buffer.readUInt16BE(8);
        headerLen = 10;
      } else if (atyp === 3) {
        const len = buffer[4];
        if (buffer.length < 5 + len + 2) return;
        host = buffer.subarray(5, 5 + len).toString("utf8");
        port = buffer.readUInt16BE(5 + len);
        headerLen = 5 + len + 2;
      } else if (atyp === 4) {
        if (buffer.length < 22) return;
        const b = buffer.subarray(4, 20);
        host = Array.from({ length: 8 }, (_, i) =>
          ((b[i * 2] << 8) | b[i * 2 + 1]).toString(16),
        ).join(":");
        port = buffer.readUInt16BE(20);
        headerLen = 22;
      } else {
        socket.end();
        return;
      }
      seen.push(`${host}:${port}`);
      const rest = buffer.subarray(headerLen);
      const upstream = net.connect(port, host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.off("data", onData);
        if (rest.length) upstream.write(rest);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      // Proper SOCKS failure reply (REP=5) instead of a silent close, which
      // would make clients re-connect in a loop.
      upstream.on("error", () => {
        socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.end();
      });
      socket.on("error", () => upstream.destroy());
    };
    socket.on("data", onData);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

/** Minimal SOCKS4/4a server: [VER=4, CMD=1, PORT, IP, USERID\0, (DOMAIN\0)] → [0,90,PORT,IP]. */
function startSocks4Proxy() {
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = "header";
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage !== "header") return;
      if (buffer.length < 9) return;
      const ver = buffer[0];
      const cmd = buffer[1];
      const port = buffer.readUInt16BE(2);
      const ip = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
      if (ver !== 4 || cmd !== 1) {
        socket.end();
        return;
      }
      let offset = 8;
      const userEnd = buffer.indexOf(0, offset);
      if (userEnd === -1) return;
      offset = userEnd + 1;
      let host = ip;
      if (ip.startsWith("0.0.0.")) {
        // socks4a: domain follows
        const domEnd = buffer.indexOf(0, offset);
        if (domEnd === -1) return;
        host = buffer.subarray(offset, domEnd).toString("utf8");
        offset = domEnd + 1;
      }
      stage = "tunnel";
      seen.push(`${host}:${port}`);
      const rest = buffer.subarray(offset);
      const upstream = net.connect(port, host, () => {
        socket.write(Buffer.from([0x00, 0x5a, 0x00, 0x00, 0, 0, 0, 0]));
        socket.off("data", onData);
        if (rest.length) upstream.write(rest);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => {
        socket.write(Buffer.from([0x00, 0x5b, 0x00, 0x00, 0, 0, 0, 0]));
        socket.end();
      });
      socket.on("error", () => upstream.destroy());
    };
    socket.on("data", onData);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

/** Minimal SOCKS5 server requiring username/password auth. */
function startSocks5AuthProxy(expectedUser, expectedPass) {
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = "greet";
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greet") {
        if (buffer.length < 2) return;
        const nmethods = buffer[1];
        if (buffer.length < 2 + nmethods) return;
        const methods = [...buffer.subarray(2, 2 + nmethods)];
        buffer = buffer.subarray(2 + nmethods);
        if (!methods.includes(0x02)) {
          socket.end();
          return;
        }
        socket.write(Buffer.from([0x05, 0x02]));
        stage = "auth";
      }
      if (stage === "auth") {
        if (buffer.length < 2) return;
        const ulen = buffer[1];
        if (buffer.length < 2 + ulen + 1) return;
        const user = buffer.subarray(2, 2 + ulen).toString("utf8");
        const plen = buffer[2 + ulen];
        if (buffer.length < 2 + ulen + 1 + plen) return;
        const pass = buffer.subarray(2 + ulen + 1, 2 + ulen + 1 + plen).toString("utf8");
        buffer = buffer.subarray(2 + ulen + 1 + plen);
        if (user !== expectedUser || pass !== expectedPass) {
          socket.write(Buffer.from([0x01, 0x01]));
          socket.end();
          return;
        }
        socket.write(Buffer.from([0x01, 0x00]));
        stage = "request";
      }
      if (stage !== "request") return;
      if (buffer.length < 4) return;
      const ver = buffer[0];
      const cmd = buffer[1];
      const atyp = buffer[3];
      if (ver !== 5 || cmd !== 1) {
        socket.end();
        return;
      }
      let host;
      let port;
      let headerLen;
      if (atyp === 1) {
        if (buffer.length < 10) return;
        host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
        port = buffer.readUInt16BE(8);
        headerLen = 10;
      } else if (atyp === 3) {
        const len = buffer[4];
        if (buffer.length < 5 + len + 2) return;
        host = buffer.subarray(5, 5 + len).toString("utf8");
        port = buffer.readUInt16BE(5 + len);
        headerLen = 5 + len + 2;
      } else {
        socket.end();
        return;
      }
      seen.push(`${host}:${port}`);
      const rest = buffer.subarray(headerLen);
      const upstream = net.connect(port, host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.off("data", onData);
        if (rest.length) upstream.write(rest);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => {
        socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.end();
      });
      socket.on("error", () => upstream.destroy());
    };
    socket.on("data", onData);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

/** Local plain-HTTP responder on 0.0.0.0 (reachable via any 127.x address). */
async function startDirectServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`direct:${req.url}`);
  });
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** A port with no listener (bind then close). */
async function closedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function fakeCtx() {
  const logs = [];
  const logger = {
    info: (...a) => logs.push(["info", ...a]),
    warn: (...a) => logs.push(["warn", ...a]),
    error: (...a) => logs.push(["error", ...a]),
    debug: (...a) => logs.push(["debug", ...a]),
  };
  const cleanups = [];
  return {
    logger,
    logs,
    fiber: { state: 2 },
    effect(fn) {
      const result = fn();
      if (typeof result === "function") cleanups.push(result);
      return () => {};
    },
    dispose() {
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchText = async (url, init) => {
  const res = await fetch(url, init);
  return res.text();
};
const fetchSafe = async (url, init) => {
  try {
    return await fetch(url, init);
  } catch {
    return null;
  }
};

const proxyA = await startProxy();
const proxyB = await startProxy();
const socks5 = await startSocks5Proxy();
const socks4 = await startSocks4Proxy();
const direct = await startDirectServer();
const closed = await closedPort();
const originalFetch = globalThis.fetch;
const originalHttpsRequest = https.request;
const originalHttpRequest = http.request;
const originalHttpGet = http.get;
const originalHttpsGet = https.get;

// The runner environment may set proxy vars (the harness sets HTTPS_PROXY and
// NO_PROXY). The plugin merges NO_PROXY into the direct baseline and picks up
// proxy URLs from the standard env keys, so clear ALL of them to keep routing
// tests hermetic; the originals are restored at the end.
const PROXY_ENV_KEYS_TEST = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
];
const savedProxyEnv = {};
for (const key of PROXY_ENV_KEYS_TEST) {
  savedProxyEnv[key] = process.env[key];
  delete process.env[key];
}

console.log(
  `proxyA :${proxyA.port}, proxyB :${proxyB.port}, socks5 :${socks5.port}, ` +
    `socks4 :${socks4.port}, direct :${direct.port}, closed :${closed}`,
);

// Routing test configs opt out of the loopback safety net deliberately.
const PROTECT_OFF = { protectLocal: false, protectPrivate: false };

// Watchdog: any block that hangs (e.g. an unresponsive upstream) must fail the
// suite loudly instead of stalling `npm test` forever (CI has no timeout).
const watchdog = setTimeout(() => {
  console.error(`\nTIMEOUT: suite exceeded ${10 * 60}s — aborting`);
  process.exit(2);
}, 10 * 60 * 1000);

// ── 0. unit: rules / config / health ────────────────────────────────────────
{
  check("hostMatches suffix", hostMatches("example.com", "a.example.com") && !hostMatches("example.com", "badexample.com"));
  check("hostMatches star", hostMatches("*.example.com", "x.example.com") && hostMatches("*.example.com", "example.com"));
  check("hostPortMatches '*'", hostPortMatches("*", "example.com", 443));
  check("hostPortMatches host:port", hostPortMatches("example.com:443", "example.com", 443) && !hostPortMatches("example.com:443", "example.com", 80));
  check("hostPortMatches ip:port", hostPortMatches("127.0.0.1:8080", "127.0.0.1", 8080) && !hostPortMatches("127.0.0.1:8080", "127.0.0.1", 9090));
  check("hostPortMatches CIDR", hostPortMatches("10.0.0.0/8", "10.1.2.3", 80) && !hostPortMatches("10.0.0.0/8", "8.8.8.8", 80));
  check("hostPortMatches CIDR v6", hostPortMatches("fc00::/7", "fc00::1", 80));

  const rules = [
    normalizeRule({ host: "api.deepseek.com", action: "direct" }),
    normalizeRule({ provider: "openai", action: "proxy", proxy: "clash" }),
    normalizeRule({ plugin: "web", action: "fallback" }),
  ];
  check(
    "matchRule host first",
    matchRule(rules, { host: "api.deepseek.com", provider: "openai", plugin: null })?.action === "direct",
  );
  check(
    "matchRule provider",
    matchRule(rules, { host: "other.com", provider: "openai", plugin: null })?.action === "proxy",
  );
  check(
    "matchRule plugin",
    matchRule(rules, { host: "other.com", provider: null, plugin: "web" })?.action === "fallback",
  );
  const andRule = [normalizeRule({ host: "api.deepseek.com", provider: "openai", action: "proxy" })];
  check(
    "matchRule AND: all specified fields must match",
    matchRule(andRule, { host: "api.deepseek.com", provider: "openai", plugin: null })?.action === "proxy" &&
      matchRule(andRule, { host: "api.deepseek.com", provider: "other", plugin: null }) === undefined &&
      matchRule(andRule, { host: "other.com", provider: "openai", plugin: null }) === undefined,
  );
  const orListRule = [normalizeRule({ host: ["a.example.com", "b.example.com"], provider: "p1", action: "proxy" })];
  check(
    "matchRule AND: value list is OR within a field",
    matchRule(orListRule, { host: "b.example.com", provider: "p1", plugin: null })?.action === "proxy" &&
      matchRule(orListRule, { host: "b.example.com", provider: "p2", plugin: null }) === undefined,
  );
  check("normalizeRule proxy default", normalizeRule({ host: "h", action: "proxy" }).proxy === "default");
  let threw = false;
  try {
    normalizeRule({ host: "h", action: "bogus" });
  } catch {
    threw = true;
  }
  check("normalizeRule rejects bad action", threw);

  const legacy = normalizeConfig({});
  check("legacy config: strategy proxy", legacy.defaults.strategy === "proxy");
  check("legacy config: legacyMode", legacy.legacyMode === true);
  check("legacy config: localhost protected by default", legacy.noProxy.includes("localhost"));
  check("legacy config: metadata protected", legacy.noProxy.includes("169.254.169.254"));
  check("legacy config: private range protected", legacy.noProxy.includes("10.0.0.0/8"));

  const newCfg = normalizeConfig({
    ...PROTECT_OFF,
    noProxy: ["custom.test"],
    proxies: { a: "http://127.0.0.1:1" },
    rules: [{ host: "x", action: "direct" }],
  });
  check("new surface: strategy fallback", newCfg.defaults.strategy === "fallback");
  check("new surface: opt-out drops safety lists", !newCfg.noProxy.includes("localhost") && !newCfg.noProxy.includes("10.0.0.0/8"));
  check("new surface: custom noProxy entry kept", newCfg.noProxy.includes("custom.test"));

  // env URL priority over YAML url
  const savedEnvUrl = process.env.DSH_PROXY_URL;
  process.env.DSH_PROXY_URL = "http://env.test:1";
  try {
    check(
      "env DSH_PROXY_URL wins over url",
      normalizeConfig({ url: "http://yaml.test:2" }).url === "http://env.test:1",
    );
  } finally {
    if (savedEnvUrl === undefined) delete process.env.DSH_PROXY_URL;
    else process.env.DSH_PROXY_URL = savedEnvUrl;
  }

  // credential parsing: never in the clean URL, always redacted
  const cred = parseProxyUrl("http://user:pass@127.0.0.1:1");
  check("credentials stripped from clean URL", cred.url === "http://127.0.0.1:1/");
  check("credentials kept separately", cred.username === "user" && cred.password === "pass");
  check("display redacted", cred.display === "http://***@127.0.0.1:1");
  const rp = makeResolvedProxy("x", "http://u:p@127.0.0.1:1");
  check(
    "resolved proxy: clean url + creds + redacted display",
    rp.url === "http://127.0.0.1:1/" && rp.username === "u" && rp.password === "p" && rp.display.includes("***"),
  );

  // health
  const health = new HealthRegistry({ cooldownMs: 60000, latencyThresholdMs: 1000 });
  health.recordSuccess("fast", 500);
  health.recordSuccess("fast", 300);
  check("health EWMA within bounds", health.ewmaOf("fast") > 300 && health.ewmaOf("fast") < 500);
  check("health fast not proxy-preferred", !health.preferProxy("fast"));
  health.recordSuccess("slow", 2000);
  check("health slow proxy-preferred by latency", health.preferProxy("slow"));
  health.recordFailure("down");
  check("health cooldown after failure", health.isCoolingDown("down") && health.preferProxy("down"));
  check("health snapshot shape", "fast" in health.snapshot());

  // health map is bounded (LRU eviction)
  const capped = new HealthRegistry({ maxEntries: 3, cooldownMs: 60000, latencyThresholdMs: 9999 });
  for (let i = 0; i < 8; i += 1) capped.recordSuccess(`host-${i}.example`, 10);
  check("health map bounded by maxEntries", capped.entries.size <= 3, `size=${capped.entries.size}`);
  check("health map keeps most recent", capped.ewmaOf("host-7.example") !== null && capped.ewmaOf("host-0.example") === null);

  // env proxy schemes and authentication survive resolution. Credentials are
  // separated only when the final ResolvedProxy is built, never discarded.
  const savedHttpsProxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "socks5://alice:s3cret@127.0.0.1:1080";
  try {
    const envPlan = await resolveProxyPlan(normalizeConfig({ mode: "env" }));
    const envProxy = envPlan.resolved.get("default");
    check("env socks5:// scheme preserved", envProxy?.scheme === "socks5", envProxy?.scheme ?? "none");
    check(
      "env proxy credentials preserved separately",
      envProxy?.url === "socks5://127.0.0.1:1080" &&
        envProxy?.username === "alice" &&
        envProxy?.password === "s3cret" &&
        envProxy?.display === "socks5://***@127.0.0.1:1080",
      JSON.stringify({ url: envProxy?.url, username: envProxy?.username, display: envProxy?.display }),
    );
  } finally {
    if (savedHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = savedHttpsProxy;
  }

  // status projection is pure sanitized JSON (redacted URLs, bounded health)
  const status = buildStatus({
    enabled: true,
    patchNodeHttp: true,
    registry: {
      entries: new Map([
        ["p", { resolved: { name: "p", scheme: "http", display: "http://***@127.0.0.1:1" } }],
      ]),
    },
    health: {
      snapshot: () =>
        Object.fromEntries(
          Array.from({ length: 250 }, (_, i) => [
            `h${i}.example`,
            { ewmaMs: i, proxyEwmaMs: null, failures: 0, coolingDown: false },
          ]),
        ),
    },
    defaults: {
      strategy: "fallback",
      directTimeoutMs: 3000,
      latencyThresholdMs: 1500,
      cooldownMs: 60000,
      methods: ["GET", "HEAD"],
    },
  });
  check("status: pure JSON shape", status.plugin === "dsh-system-proxy" && Array.isArray(status.proxies) && "health" in status && "fallback" in status);
  check("status: proxy URL is redacted (no credentials)", status.proxies[0].url === "http://***@127.0.0.1:1" && !JSON.stringify(status).includes("user:pass"));
  check("status: health bounded + truncation flag", Object.keys(status.health).length <= 201 && status.health.__truncated === 50);
  const inert = buildStatus({ enabled: false });
  check("status: inert state is well-formed", inert.enabled === false && inert.proxies.length === 0 && inert.health !== undefined);
}

// ── 1. legacy compatibility ─────────────────────────────────────────────────
{
  const ctx = fakeCtx();
  apply(ctx, { mode: "manual", url: `http://127.0.0.1:${proxyA.port}` });
  await tick();
  const before = proxyA.seen.connects.length;
  // The tunnel is recorded when the proxy receives the CONNECT, before any
  // upstream reachability — deterministic even if example.com is unreachable.
  // Bound the upstream wait (5s) so a hung outbound path cannot stall the suite.
  await fetchSafe("https://example.com", { signal: AbortSignal.timeout(5000) });
  check(
    "legacy: example.com tunneled via CONNECT",
    proxyA.seen.connects.length === before + 1 && proxyA.seen.connects.at(-1).startsWith("example.com:"),
    JSON.stringify(proxyA.seen.connects.slice(before)),
  );

  const localRes = await fetchText(`http://127.0.0.1:${direct.port}/hello`);
  check("legacy: localhost bypassed (direct)", localRes === "direct:/hello");

  const connBefore = proxyA.seen.connects.length;
  const req = await new Promise((resolve) => {
    const r = https.request("https://example.com", { method: "HEAD" }, (rres) => resolve(rres));
    r.on("error", () => resolve(null));
    // Bound the upstream wait: the CONNECT is recorded by the local proxy the
    // moment the request arrives, so the assertion below is deterministic even
    // when example.com itself is unreachable or hangs.
    r.setTimeout(5000, () => {
      r.destroy();
      resolve(null);
    });
    r.end();
  });
  await tick();
  check(
    "legacy: https.request tunneled",
    proxyA.seen.connects.length >= connBefore + 1 && proxyA.seen.connects.at(-1).startsWith("example.com:"),
  );
  void req;

  ctx.dispose();
  check("restore: fetch", globalThis.fetch === originalFetch);
  check("restore: https.request", https.request === originalHttpsRequest);
  check("restore: http.request", http.request === originalHttpRequest);
  check("restore: https.get", https.get === originalHttpsGet);
  check("restore: http.get", http.get === originalHttpGet);
  const after = await fetchText(`http://127.0.0.1:${direct.port}/after`);
  check("restore: direct fetch still works", after === "direct:/after");
}

// ── 2. named proxies + host rules ───────────────────────────────────────────
{
  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: { pA: `http://127.0.0.1:${proxyA.port}`, pB: `http://127.0.0.1:${proxyB.port}` },
    rules: [
      { host: "127.0.0.1", action: "proxy", proxy: "pA" },
      { host: "127.0.0.2", action: "proxy", proxy: "pB" },
    ],
    default: { strategy: "direct" },
  });
  await tick();
  proxyA.seen.connects.length = 0;
  proxyB.seen.connects.length = 0;

  const resA = await fetchText(`http://127.0.0.1:${direct.port}/a`);
  check("rules: 127.0.0.1 routed to pA and served", resA === "direct:/a");
  await tick();
  check(
    "rules: proxyA saw exactly one 127.0.0.1 CONNECT",
    proxyA.seen.connects.length === 1 && proxyA.seen.connects[0].startsWith(`127.0.0.1:${direct.port}`),
    JSON.stringify(proxyA.seen.connects),
  );
  check("rules: proxyB saw nothing", proxyB.seen.connects.length === 0);

  const resB = await fetchText(`http://127.0.0.2:${direct.port}/b`);
  check("rules: 127.0.0.2 routed to pB and served", resB === "direct:/b");
  await tick();
  check(
    "rules: proxyB saw exactly one 127.0.0.2 CONNECT",
    proxyB.seen.connects.length === 1 && proxyB.seen.connects[0].startsWith(`127.0.0.2:${direct.port}`),
    JSON.stringify(proxyB.seen.connects),
  );
  ctx.dispose();
}

// ── 3. provider/plugin attribution via scope ────────────────────────────────
{
  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: { default: `http://127.0.0.1:${proxyA.port}` },
    rules: [{ provider: "test-provider", action: "proxy" }],
    default: { strategy: "direct" },
  });
  await tick();
  proxyA.seen.connects.length = 0;

  const noScope = await fetchText(`http://127.0.0.1:${direct.port}/plain`);
  check("scope: no attribution → direct", noScope === "direct:/plain");
  await tick();
  check("scope: proxy untouched without attribution", proxyA.seen.connects.length === 0);

  const scoped = await runWithRoute({ provider: "test-provider" }, () =>
    fetchText(`http://127.0.0.1:${direct.port}/scoped`),
  );
  check("scope: attributed request still served", scoped === "direct:/scoped");
  await tick();
  check(
    "scope: attributed request went through the proxy",
    proxyA.seen.connects.some((c) => c.startsWith(`127.0.0.1:${direct.port}`)),
    JSON.stringify(proxyA.seen.connects),
  );
  ctx.dispose();
}

// ── 3b. trustRouteHeaders: honored for routing, stripped before dispatch ────
{
  const echo = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ path: req.url, provider: req.headers["x-dsh-route-provider"] ?? null }));
  });
  echo.listen(0, "0.0.0.0");
  await once(echo, "listening");
  const echoPort = echo.address().port;

  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: { default: `http://127.0.0.1:${proxyA.port}` },
    rules: [{ provider: "header-provider", action: "proxy" }],
    default: { strategy: "direct" },
    trustRouteHeaders: true,
  });
  await tick();
  proxyA.seen.connects.length = 0;

  // routed via proxy AND the route header must not reach the upstream
  const routed = await fetchText(`http://127.0.0.1:${echoPort}/routed`, {
    headers: { "x-dsh-route-provider": "header-provider" },
  });
  check("route header: request routed via provider rule", proxyA.seen.connects.length === 1 && proxyA.seen.connects[0].startsWith(`127.0.0.1:${echoPort}`), JSON.stringify(proxyA.seen.connects));
  check("route header: stripped before upstream", JSON.parse(routed).provider === null, routed);
  ctx.dispose();

  // trustRouteHeaders off → header is NOT used for routing (and not stripped)
  const ctx2 = fakeCtx();
  apply(ctx2, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: { default: `http://127.0.0.1:${proxyA.port}` },
    rules: [{ provider: "header-provider", action: "proxy" }],
    default: { strategy: "direct" },
  });
  await tick();
  proxyA.seen.connects.length = 0;
  const ignored = await fetchText(`http://127.0.0.1:${echoPort}/ignored`, {
    headers: { "x-dsh-route-provider": "header-provider" },
  });
  check("route header: ignored when trustRouteHeaders off (direct)", proxyA.seen.connects.length === 0, JSON.stringify(proxyA.seen.connects));
  check("route header: passed through when off", JSON.parse(ignored).provider === "header-provider", ignored);
  ctx2.dispose();
  echo.closeAllConnections();
  echo.close();
}

// ── 4. block action ─────────────────────────────────────────────────────────
{
  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    rules: [{ host: "127.0.0.1", action: "block" }],
    default: { strategy: "direct" },
  });
  await tick();
  let blocked = null;
  try {
    await fetch(`http://127.0.0.1:${direct.port}/nope`);
  } catch (error) {
    blocked = error;
  }
  check("block: fetch rejects with NETWORK_BLOCKED", blocked !== null && blocked.code === "NETWORK_BLOCKED");
  let nodeBlocked = false;
  try {
    const req = https.request(`https://127.0.0.1:${direct.port}/`, () => {});
    req.on("error", () => {});
    req.end();
  } catch (error) {
    nodeBlocked = error.code === "NETWORK_BLOCKED";
  }
  check("block: node https.request throws NETWORK_BLOCKED", nodeBlocked);
  ctx.dispose();
}

// ── 5. fallback: safe replay vs unsafe ──────────────────────────────────────
{
  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: { default: `http://127.0.0.1:${proxyA.port}` },
    rules: [{ host: "127.0.0.1", action: "fallback", proxy: "default" }],
    default: { strategy: "direct" },
  });
  await tick();
  proxyA.seen.connects.length = 0;

  let failed = null;
  try {
    await fetch(`http://127.0.0.1:${closed}/boom`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    failed = error;
  }
  await tick();
  check("fallback: GET ultimately fails", failed !== null);
  check(
    "fallback: GET was replayed through the proxy (CONNECT seen)",
    proxyA.seen.connects.some((c) => c.startsWith(`127.0.0.1:${closed}`)),
    JSON.stringify(proxyA.seen.connects),
  );
  ctx.dispose();

  // unsafe POST in a FRESH context (clean health): direct only, no replay
  const ctx2 = fakeCtx();
  apply(ctx2, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: { default: `http://127.0.0.1:${proxyA.port}` },
    rules: [{ host: "127.0.0.1", action: "fallback", proxy: "default" }],
    default: { strategy: "direct" },
  });
  await tick();
  proxyA.seen.connects.length = 0;
  let postFailed = false;
  try {
    await fetch(`http://127.0.0.1:${closed}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 1 }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    postFailed = true;
  }
  await tick();
  check("fallback: unsafe POST fails without replay", postFailed);
  check(
    "fallback: POST never touched the proxy",
    proxyA.seen.connects.length === 0,
    JSON.stringify(proxyA.seen.connects),
  );
  ctx2.dispose();
}

// ── 6. socks4 / 4a / 5 / 5h on BOTH fetch and node http ─────────────────────
{
  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: {
      s4: `socks4://127.0.0.1:${socks4.port}`,
      s4a: `socks4a://127.0.0.1:${socks4.port}`,
      s5: `socks5://127.0.0.1:${socks5.port}`,
      s5h: `socks5h://127.0.0.1:${socks5.port}`,
    },
    rules: [
      { host: "127.0.0.1", action: "proxy", proxy: "s5" },
      { host: "127.0.0.2", action: "proxy", proxy: "s5h" },
      { host: "127.0.0.3", action: "proxy", proxy: "s4" },
      { host: ["127.0.0.4", "localhost"], action: "proxy", proxy: "s4a" },
      // DNS semantics: socks5 resolves locally, socks5h sends the domain.
      { host: "dns-local.invalid", action: "proxy", proxy: "s5" },
      { host: "dns-remote.invalid", action: "proxy", proxy: "s5h" },
    ],
    default: { strategy: "direct" },
  });
  await tick();

  // socks5 + fetch
  socks5.seen.length = 0;
  const viaS5 = await fetchText(`http://127.0.0.1:${direct.port}/s5`);
  check("socks5: fetch served through proxy", viaS5 === "direct:/s5");
  await tick();
  check(
    "socks5: proxy saw exactly one 127.0.0.1 CONNECT",
    socks5.seen.length === 1 && socks5.seen[0].startsWith(`127.0.0.1:${direct.port}`),
    JSON.stringify(socks5.seen),
  );

  // socks5h + fetch (remote-DNS scheme; numeric host stays IPv4 on the wire)
  socks5.seen.length = 0;
  const viaS5h = await fetchText(`http://127.0.0.2:${direct.port}/s5h`);
  check("socks5h: fetch served through proxy", viaS5h === "direct:/s5h");
  await tick();
  check(
    "socks5h: proxy saw exactly one 127.0.0.2 CONNECT",
    socks5.seen.length === 1 && socks5.seen[0].startsWith(`127.0.0.2:${direct.port}`),
    JSON.stringify(socks5.seen),
  );

  // DNS semantics: socks5 (local DNS) never contacts the proxy for an
  // unresolvable hostname; socks5h (remote DNS) hands the domain to it.
  socks5.seen.length = 0;
  let localDnsFailed = false;
  try {
    await fetch("http://dns-local.invalid:80/", { signal: AbortSignal.timeout(5000) });
  } catch {
    localDnsFailed = true;
  }
  await tick();
  check("socks5 (local DNS): unresolvable host fails without proxy contact", localDnsFailed && socks5.seen.length === 0, JSON.stringify(socks5.seen));

  socks5.seen.length = 0;
  let remoteDnsFailed = false;
  try {
    await fetch("http://dns-remote.invalid:80/", { signal: AbortSignal.timeout(5000) });
  } catch {
    remoteDnsFailed = true;
  }
  await tick();
  check("socks5h (remote DNS): unresolvable host reaches the proxy as a domain", remoteDnsFailed && socks5.seen.some((t) => t.startsWith("dns-remote.invalid:")), JSON.stringify(socks5.seen));

  // socks4 + fetch
  socks4.seen.length = 0;
  const viaS4 = await fetchText(`http://127.0.0.3:${direct.port}/s4`);
  check("socks4: fetch served through proxy", viaS4 === "direct:/s4");
  await tick();
  check(
    "socks4: proxy saw exactly one 127.0.0.3 CONNECT",
    socks4.seen.length === 1 && socks4.seen[0].startsWith(`127.0.0.3:${direct.port}`),
    JSON.stringify(socks4.seen),
  );

  // socks4a + fetch (domain form via localhost)
  socks4.seen.length = 0;
  const viaS4a = await fetchText(`http://localhost:${direct.port}/s4a`);
  check("socks4a: fetch served through proxy", viaS4a === "direct:/s4a");
  await tick();
  check(
    "socks4a: proxy saw exactly one localhost CONNECT (domain)",
    socks4.seen.length === 1 && socks4.seen[0].startsWith(`localhost:${direct.port}`),
    JSON.stringify(socks4.seen),
  );

  // socks4a + node http.request (domain form via localhost)
  socks4.seen.length = 0;
  const node4a = await new Promise((resolve) => {
    const req = http.request(`http://localhost:${direct.port}/node4a`, (res) => resolve(res));
    req.on("error", () => resolve(null));
    req.end();
  });
  const node4aText = node4a
    ? await new Promise((r) => {
        let data = "";
        node4a.on("data", (d) => (data += d));
        node4a.on("end", () => r(data));
      })
    : null;
  check("socks4a: node http.request served through proxy", node4aText === "direct:/node4a");
  await tick();
  check(
    "socks4a: proxy saw exactly one localhost CONNECT (domain)",
    socks4.seen.length === 1 && socks4.seen[0].startsWith(`localhost:${direct.port}`),
    JSON.stringify(socks4.seen),
  );

  // socks4 + node http.request
  socks4.seen.length = 0;
  const node4 = await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.3:${direct.port}/node4`, (res) => resolve(res));
    req.on("error", () => resolve(null));
    req.end();
  });
  const node4Text = node4
    ? await new Promise((r) => {
        let data = "";
        node4.on("data", (d) => (data += d));
        node4.on("end", () => r(data));
      })
    : null;
  check("socks4: node http.request served through proxy", node4Text === "direct:/node4");
  await tick();
  check(
    "socks4: proxy saw exactly one 127.0.0.3 CONNECT",
    socks4.seen.length === 1 && socks4.seen[0].startsWith(`127.0.0.3:${direct.port}`),
  );

  // socks5 + node http.request
  socks5.seen.length = 0;
  const node5 = await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${direct.port}/node5`, (res) => resolve(res));
    req.on("error", () => resolve(null));
    req.end();
  });
  const node5Text = node5
    ? await new Promise((r) => {
        let data = "";
        node5.on("data", (d) => (data += d));
        node5.on("end", () => r(data));
      })
    : null;
  check("socks5: node http.request served through proxy", node5Text === "direct:/node5");
  await tick();
  check(
    "socks5: proxy saw exactly one 127.0.0.1 CONNECT",
    socks5.seen.length === 1 && socks5.seen[0].startsWith(`127.0.0.1:${direct.port}`),
    JSON.stringify(socks5.seen),
  );

  // socks5h + node http.request (remote-DNS scheme)
  socks5.seen.length = 0;
  const node5h = await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.2:${direct.port}/node5h`, (res) => resolve(res));
    req.on("error", () => resolve(null));
    req.end();
  });
  const node5hText = node5h
    ? await new Promise((r) => {
        let data = "";
        node5h.on("data", (d) => (data += d));
        node5h.on("end", () => r(data));
      })
    : null;
  check("socks5h: node http.request served through proxy", node5hText === "direct:/node5h");
  await tick();
  check(
    "socks5h: proxy saw exactly one 127.0.0.2 CONNECT",
    socks5.seen.length === 1 && socks5.seen[0].startsWith(`127.0.0.2:${direct.port}`),
    JSON.stringify(socks5.seen),
  );
  ctx.dispose();
}

// ── 7. redirects are re-routed per hop ──────────────────────────────────────
{
  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: { pA: `http://127.0.0.1:${proxyA.port}` },
    rules: [
      { host: "127.0.0.1", action: "proxy", proxy: "pA" },
      { host: "127.0.0.2", action: "direct" },
    ],
    default: { strategy: "direct" },
  });
  await tick();

  const target = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.2:${direct.port}/final` });
    res.end();
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const aPort = target.address().port;

  proxyA.seen.connects.length = 0;
  const res = await fetch(`http://127.0.0.1:${aPort}/start`, { signal: AbortSignal.timeout(5000) });
  const body = await res.text();
  await tick();
  check("redirect: final hop served directly", body === "direct:/final");
  check(
    "redirect: first hop went through proxyA only",
    proxyA.seen.connects.length === 1 && proxyA.seen.connects[0].startsWith(`127.0.0.1:${aPort}`),
    JSON.stringify(proxyA.seen.connects),
  );
  check("redirect: response reports redirected + final url", res.redirected === true && res.url.endsWith("/final"));
  ctx.dispose();
  target.closeAllConnections();
  target.close();

  // redirect target blocked → NETWORK_BLOCKED
  const ctx2 = fakeCtx();
  apply(ctx2, {
    ...PROTECT_OFF,
    noProxy: [],
    rules: [
      { host: "127.0.0.1", action: "direct" },
      { host: "127.0.0.2", action: "block" },
    ],
    default: { strategy: "direct" },
  });
  await tick();
  const target2 = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.2:${direct.port}/final` });
    res.end();
  });
  target2.listen(0, "127.0.0.1");
  await once(target2, "listening");
  const a2 = target2.address().port;
  let blocked = null;
  try {
    await fetch(`http://127.0.0.1:${a2}/start`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    blocked = error;
  }
  check("redirect: blocked target rejects with NETWORK_BLOCKED", blocked !== null && blocked.code === "NETWORK_BLOCKED");
  ctx2.dispose();
  target2.closeAllConnections();
  target2.close();
}

// ── 8. noProxy semantics: `*` and host:port ─────────────────────────────────
{
  // `*` in noProxy → everything direct even under a proxy-everything default
  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: ["*"],
    url: `http://127.0.0.1:${proxyA.port}`,
    mode: "manual",
  });
  await tick();
  proxyA.seen.connects.length = 0;
  const res = await fetchText(`http://127.0.0.1:${direct.port}/star`);
  await tick();
  check("noProxy '*': localhost stays direct", proxyA.seen.connects.length === 0, JSON.stringify(proxyA.seen.connects));
  check("noProxy '*': response still fine", res === "direct:/star");
  ctx.dispose();

  // host:port in noProxy beats a proxy rule for that exact port
  const ctx2 = fakeCtx();
  apply(ctx2, {
    ...PROTECT_OFF,
    noProxy: [`127.0.0.1:${direct.port}`],
    proxies: { pA: `http://127.0.0.1:${proxyA.port}` },
    rules: [{ host: "127.0.0.1", action: "proxy", proxy: "pA" }],
    default: { strategy: "direct" },
  });
  await tick();
  proxyA.seen.connects.length = 0;
  const directHit = await fetchText(`http://127.0.0.1:${direct.port}/x`);
  check("noProxy host:port: served directly", directHit === "direct:/x");
  await tick();
  check(
    "noProxy host:port: proxy untouched",
    proxyA.seen.connects.length === 0,
    JSON.stringify(proxyA.seen.connects),
  );
  ctx2.dispose();
}

// ── 9. dispose: agents closed, in-flight not aborted ────────────────────────
{
  const slow = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200);
      res.end("slow-ok");
    }, 400);
  });
  slow.listen(0, "127.0.0.1");
  await once(slow, "listening");
  const slowPort = slow.address().port;

  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: { default: `http://127.0.0.1:${proxyA.port}` },
    rules: [{ host: "127.0.0.1", action: "proxy", proxy: "default" }],
    default: { strategy: "direct" },
  });
  await tick();

  const inFlight = (async () => {
    const res = await fetch(`http://127.0.0.1:${slowPort}/`, { signal: AbortSignal.timeout(5000) });
    return res.text();
  })();
  await tick(120); // let the request start, then dispose mid-flight
  ctx.dispose();
  check("dispose: fetch wrapper restored", globalThis.fetch === originalFetch);

  const body = await inFlight;
  check("dispose: in-flight request completed", body === "slow-ok");
  check("dispose: http.request restored", http.request === originalHttpRequest);
  slow.closeAllConnections();
  slow.close();
}

// ── 10. disabled configs ────────────────────────────────────────────────────
{
  const ctx = fakeCtx();
  apply(ctx, { enabled: false });
  await tick();
  check("disabled config: fetch untouched", globalThis.fetch === originalFetch);
  ctx.dispose();

  const ctx2 = fakeCtx();
  process.env.DSH_PROXY_DISABLE = "1";
  apply(ctx2, { mode: "manual", url: `http://127.0.0.1:${proxyA.port}` });
  await tick();
  check("DSH_PROXY_DISABLE: fetch untouched", globalThis.fetch === originalFetch);
  delete process.env.DSH_PROXY_DISABLE;
  ctx2.dispose();

  const ctx3 = fakeCtx();
  apply(ctx3, { mode: "manual", url: "" });
  await tick();
  check("no proxy: fetch untouched", globalThis.fetch === originalFetch);
  check("no proxy: warned", ctx3.logs.some(([level]) => level === "warn"));
  ctx3.dispose();
}

// ── 11. ALS async-iterator context (next/return/throw each inside run) ──────
{
  // normal iteration: every next() sees the route
  let routeInNext = [];
  async function* gen1() {
    yield 1;
    routeInNext.push(currentRoute()?.provider ?? null);
    yield 2;
  }
  const wrapped1 = wrapAsyncIterable({ provider: "iter-provider" }, gen1());
  const values = [];
  for await (const v of wrapped1) values.push(v);
  check("ALS iterable: values streamed", JSON.stringify(values) === "[1,2]", JSON.stringify(values));
  check("ALS iterable: route visible inside next()", routeInNext[0] === "iter-provider", JSON.stringify(routeInNext));
  check("ALS iterable: route cleared outside", currentRoute() === null);

  // abort (return): the underlying iterator's finally runs inside the route
  let routeInReturn = null;
  let returnRan = false;
  async function* gen2() {
    try {
      yield 1;
      yield 2;
    } finally {
      returnRan = true;
      routeInReturn = currentRoute()?.plugin ?? null;
    }
  }
  const it2 = wrapAsyncIterable({ plugin: "iter-plugin" }, gen2())[Symbol.asyncIterator]();
  await it2.next();
  const ret = await it2.return(99);
  check("ALS iterable: return() propagates + finally ran in context", ret.done === true && returnRan && routeInReturn === "iter-plugin", JSON.stringify({ ret, returnRan, routeInReturn }));

  // throw: the generator's catch runs inside the route and rethrows
  let routeInThrow = null;
  let throwRan = false;
  async function* gen3() {
    try {
      yield 1;
    } catch (error) {
      throwRan = true;
      routeInThrow = currentRoute()?.provider ?? null;
      throw error;
    }
  }
  const it3 = wrapAsyncIterable({ provider: "throw-provider" }, gen3())[Symbol.asyncIterator]();
  await it3.next();
  let thrown = null;
  try {
    await it3.throw(new Error("boom"));
  } catch (error) {
    thrown = error;
  }
  check("ALS iterable: throw() runs catch in context and rethrows", thrown?.message === "boom" && throwRan && routeInThrow === "throw-provider", JSON.stringify({ thrown: thrown?.message, throwRan, routeInThrow }));
}

// ── 12. SOCKS fetch path preserves SSE streaming, abort, and cancel ─────────
{
  const sse = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    setTimeout(() => res.write("data: 2\n\n"), 120);
    setTimeout(() => {
      res.write("data: 3\n\n");
      res.end();
    }, 240);
  });
  sse.listen(0, "127.0.0.1");
  await once(sse, "listening");
  const ssePort = sse.address().port;

  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: { s4: `socks4://127.0.0.1:${socks4.port}` },
    rules: [{ host: "127.0.0.1", action: "proxy", proxy: "s4" }],
    default: { strategy: "direct" },
  });
  await tick();

  // SSE: chunks arrive incrementally through the socks4 tunnel
  const res = await fetch(`http://127.0.0.1:${ssePort}/events`, { signal: AbortSignal.timeout(5000) });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const times = [];
  for (let i = 0; i < 3; i += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    times.push(Date.now());
    text += decoder.decode(value, { stream: true });
  }
  check("socks4 SSE: streamed content complete", text.includes("data: 1") && text.includes("data: 2") && text.includes("data: 3"), text);
  check("socks4 SSE: delivered incrementally (backpressure intact)", times.length >= 2 && times.at(-1) - times[0] >= 80, JSON.stringify(times));

  // abort mid-stream: the reader rejects with AbortError
  const ac = new AbortController();
  const abortFetch = fetch(`http://127.0.0.1:${ssePort}/events`, { signal: ac.signal });
  const res2 = await abortFetch;
  const r2 = res2.body.getReader();
  await r2.read();
  ac.abort();
  let aborted = null;
  try {
    await r2.read();
  } catch (error) {
    aborted = error;
  }
  check("socks4 SSE: abort mid-stream propagates", aborted !== null && aborted.name === "AbortError", aborted?.name ?? "");

  // cancel: reader.cancel() drains cleanly and the stream ends
  const cancelFetch = await fetch(`http://127.0.0.1:${ssePort}/events`, { signal: AbortSignal.timeout(5000) });
  const r3 = cancelFetch.body.getReader();
  await r3.read();
  await r3.cancel();
  const afterCancel = await r3.read();
  check("socks4 SSE: cancel() ends the stream cleanly", afterCancel.done === true, JSON.stringify(afterCancel));

  ctx.dispose();
  sse.closeAllConnections();
  sse.close();
}

// ── 13. node http(s) call-form acceptance (url,cb) / (options,cb) / get ─────
{
  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: { default: `http://127.0.0.1:${proxyA.port}` },
    rules: [{ host: "127.0.0.1", action: "proxy", proxy: "default" }],
    default: { strategy: "direct" },
  });
  await tick();

  // http.request(url, cb)
  const r1 = await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${direct.port}/cb1`, (res) => resolve(res));
    req.on("error", () => resolve(null));
    req.end();
  });
  check("http.request(url, cb): callback fired", r1 !== null && r1.statusCode === 200);

  // http.get(url, cb)
  const g1 = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${direct.port}/get1`, (res) => resolve(res)).on("error", () => resolve(null));
  });
  check("http.get(url, cb): callback fired", g1 !== null && g1.statusCode === 200);

  // options-form: http.request({ host, port, path }, cb)
  const r2 = await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: direct.port, path: "/opt1" },
      (res) => resolve(res),
    );
    req.on("error", () => resolve(null));
    req.end();
  });
  check("http.request(options, cb): callback fired", r2 !== null && r2.statusCode === 200);

  // https.request(url, cb) — local TLS target through the proxy (deterministic)
  const tlsServer = await startTlsServer();
  const r3 = await new Promise((resolve) => {
    const req = https.request(
      `https://127.0.0.1:${tlsServer.port}/`,
      { rejectUnauthorized: false },
      (res) => resolve(res),
    );
    req.on("error", () => resolve(null));
    req.end();
  });
  check("https.request(url, cb): callback fired", r3 !== null && r3.statusCode === 200);
  await tlsServer.close();
  ctx.dispose();
}

// ── 14. default internal/metadata protection + legacy-only-direct ───────────
{
  // default protect (no opt-out): 10.x and metadata never reach the proxy
  const ctx = fakeCtx();
  apply(ctx, { mode: "manual", url: `http://127.0.0.1:${proxyA.port}` });
  await tick();
  proxyA.seen.connects.length = 0;
  await fetchSafe("http://10.0.0.5/", { signal: AbortSignal.timeout(1500) });
  await fetchSafe("http://169.254.169.254/", { signal: AbortSignal.timeout(1500) });
  await tick();
  check(
    "default protection: 10.x and metadata never hit the proxy",
    proxyA.seen.connects.length === 0,
    JSON.stringify(proxyA.seen.connects),
  );
  ctx.dispose();

  // legacy `only` semantics: listed host proxied, UNMATCHED host direct
  const ctx2 = fakeCtx();
  apply(ctx2, {
    ...PROTECT_OFF,
    noProxy: [],
    mode: "manual",
    url: `http://127.0.0.1:${proxyA.port}`,
    only: ["127.0.0.1"],
  });
  await tick();
  proxyA.seen.connects.length = 0;
  const listed = await fetchText(`http://127.0.0.1:${direct.port}/listed`);
  check("legacy only: listed host proxied", listed === "direct:/listed");
  await tick();
  check("legacy only: listed host went through proxy", proxyA.seen.connects.some((c) => c.startsWith(`127.0.0.1:${direct.port}`)), JSON.stringify(proxyA.seen.connects));
  proxyA.seen.connects.length = 0;
  const unlisted = await fetchText(`http://127.0.0.2:${direct.port}/unlisted`);
  check("legacy only: unlisted host served directly", unlisted === "direct:/unlisted");
  await tick();
  check("legacy only: unlisted host NOT proxied", proxyA.seen.connects.length === 0, JSON.stringify(proxyA.seen.connects));
  ctx2.dispose();
}

// ── 15. IPv6 options-form host parsing + agent-close no-leak on reload ──────
{
  // options-form '[::1]:port' host resolves to '::1' for rule matching
  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    rules: [{ host: "::1", action: "block" }],
    default: { strategy: "direct" },
  });
  await tick();
  let ipv6Blocked = false;
  try {
    const req = http.request({ host: "[::1]:1", port: 1, path: "/" }, () => {});
    req.on("error", () => {});
    req.end();
  } catch (error) {
    ipv6Blocked = error.code === "NETWORK_BLOCKED";
  }
  check("IPv6 options-form host '[::1]:port' matched", ipv6Blocked);
  ctx.dispose();

  // hot reload does not leak sockets: create a proxied connection each cycle
  const countSockets = () =>
    process._getActiveHandles().filter(
      (h) => h && h.constructor && (h.constructor.name === "Socket" || h.constructor.name === "TLSSocket"),
    ).length;
  const reloadConfig = {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: { default: `http://127.0.0.1:${proxyA.port}` },
    rules: [{ host: "127.0.0.1", action: "proxy", proxy: "default" }],
    default: { strategy: "direct" },
  };
  const cycle = async () => {
    const c = fakeCtx();
    apply(c, reloadConfig);
    await tick(60);
    await fetchText(`http://127.0.0.1:${direct.port}/x`).catch(() => null);
    c.dispose();
    await tick(200); // let undici close() settle
  };
  await cycle();
  await cycle();
  await cycle();
  const before = countSockets();
  for (let i = 0; i < 5; i += 1) await cycle();
  const after = countSockets();
  check("reload: active socket count does not grow", after <= before + 2, `before=${before} after=${after}`);
}

// ── 16. socks5 auth, cross-origin isolation, socks4/4a IPv6 refusal ────────
{
  const authProxy = await startSocks5AuthProxy("alice", "s3cret");
  const ctx = fakeCtx();
  apply(ctx, {
    ...PROTECT_OFF,
    noProxy: [],
    proxies: {
      s5a: `socks5://alice:s3cret@127.0.0.1:${authProxy.port}`, // URL credentials
      s5b: { url: `socks5://127.0.0.1:${authProxy.port}`, username: "alice", password: "s3cret" }, // field credentials
      s5bad: `socks5://alice:wrong@127.0.0.1:${authProxy.port}`,
      s4: `socks4://127.0.0.1:${socks4.port}`,
    },
    rules: [
      { host: "127.0.0.1", action: "proxy", proxy: "s5a" },
      { host: "127.0.0.2", action: "proxy", proxy: "s5b" },
      { host: "127.0.0.3", action: "proxy", proxy: "s5bad" },
      { host: "127.0.0.4", action: "proxy", proxy: "s5a" }, // same agent as 127.0.0.1
      { host: "::1", action: "proxy", proxy: "s4" },
    ],
    default: { strategy: "direct" },
  });
  await tick();

  // auth success: URL credentials + field credentials (fetch)
  const r1 = await fetchText(`http://127.0.0.1:${direct.port}/a1`);
  check("socks5 auth: fetch via URL credentials succeeds", r1 === "direct:/a1");
  const r2 = await fetchText(`http://127.0.0.2:${direct.port}/a2`);
  check("socks5 auth: fetch via username/password fields succeeds", r2 === "direct:/a2");

  // auth success: node http path
  const n1 = await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${direct.port}/n-auth`, (res) => resolve(res));
    req.on("error", () => resolve(null));
    req.end();
  });
  check("socks5 auth: node http.request via auth proxy succeeds", n1 !== null && n1.statusCode === 200);

  // wrong password rejects
  let bad = null;
  try {
    await fetch(`http://127.0.0.3:${direct.port}/a3`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    bad = error;
  }
  check("socks5 auth: wrong password rejects", bad !== null);

  // cross-origin isolation: two origins through the SAME agent/pool
  authProxy.seen.length = 0;
  const results = await Promise.all([
    fetchText(`http://127.0.0.1:${direct.port}/x1`),
    fetchText(`http://127.0.0.4:${direct.port}/x2`),
    fetchText(`http://127.0.0.1:${direct.port}/x3`),
    fetchText(`http://127.0.0.4:${direct.port}/x4`),
  ]);
  check(
    "socks cross-origin: all responses correct (no cross-talk)",
    JSON.stringify(results) === JSON.stringify(["direct:/x1", "direct:/x2", "direct:/x3", "direct:/x4"]),
    JSON.stringify(results),
  );
  await tick();
  const hits1 = authProxy.seen.filter((t) => t.startsWith(`127.0.0.1:${direct.port}`)).length;
  const hits4 = authProxy.seen.filter((t) => t.startsWith(`127.0.0.4:${direct.port}`)).length;
  check(
    "socks cross-origin: each origin reached its own target, no foreign host",
    hits1 >= 1 &&
      hits4 >= 1 &&
      authProxy.seen.every((t) => t.startsWith(`127.0.0.1:${direct.port}`) || t.startsWith(`127.0.0.4:${direct.port}`)),
    JSON.stringify(authProxy.seen),
  );

  // socks4 + IPv6 target: explicit error, proxy untouched, no silent direct
  socks4.seen.length = 0;
  let ipv6Err = null;
  try {
    await fetch(`http://[::1]:${direct.port}/v6`, { signal: AbortSignal.timeout(3000) });
  } catch (error) {
    ipv6Err = error;
  }
  let causeCode = null;
  let cur = ipv6Err;
  for (let i = 0; i < 5 && cur; i += 1) {
    if (cur?.code) {
      causeCode = cur.code;
      break;
    }
    cur = cur?.cause;
  }
  check("socks4+IPv6: fetch rejects with explicit SOCKS4_IPV6_UNSUPPORTED", ipv6Err !== null && causeCode === "SOCKS4_IPV6_UNSUPPORTED", causeCode ?? "none");
  check("socks4+IPv6: proxy untouched (no silent direct)", socks4.seen.length === 0, JSON.stringify(socks4.seen));

  ctx.dispose();
  authProxy.close();
}

// ── 17. strict connect-phase retry classification (undici handler events) ───
{
  const applyFallback = (ctx) =>
    apply(ctx, {
      ...PROTECT_OFF,
      noProxy: [],
      proxies: { default: `http://127.0.0.1:${proxyA.port}` },
      rules: [{ host: "127.0.0.1", action: "fallback", proxy: "default", directTimeoutMs: 1200 }],
      default: { strategy: "direct" },
    });

  // (a) ambiguous: connection established (onConnect >= 1) then dropped before
  // any response → NEVER replayed through the proxy
  const resetServer = net.createServer((socket) => socket.destroy());
  resetServer.listen(0, "127.0.0.1");
  await once(resetServer, "listening");
  const resetPort = resetServer.address().port;

  const ctx = fakeCtx();
  applyFallback(ctx);
  await tick();
  proxyA.seen.connects.length = 0;
  let ambiguousErr = null;
  try {
    await fetch(`http://127.0.0.1:${resetPort}/`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    ambiguousErr = error;
  }
  await tick();
  check("strict: connect-then-drop (onConnect>=1) is ambiguous and rejects", ambiguousErr !== null);
  check("strict: ambiguous failure is NEVER replayed through the proxy", proxyA.seen.connects.length === 0, JSON.stringify(proxyA.seen.connects));
  ctx.dispose();
  resetServer.closeAllConnections?.();
  resetServer.close();

  // (b) response started (headers received) → response returned as-is, never
  // replayed; the truncated body surfaces as a read error, not a retry
  const halfServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
    res.write("partial");
    res.destroy();
  });
  halfServer.listen(0, "127.0.0.1");
  await once(halfServer, "listening");
  const halfPort = halfServer.address().port;

  const ctx2 = fakeCtx();
  applyFallback(ctx2);
  await tick();
  proxyA.seen.connects.length = 0;
  let halfRes = null;
  let halfFetchErr = null;
  try {
    halfRes = await fetch(`http://127.0.0.1:${halfPort}/`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    halfFetchErr = error;
  }
  check("strict: response-started (headers) → direct result, never replayed", halfRes !== null || halfFetchErr !== null);
  if (halfRes !== null) {
    let readErr = null;
    try {
      await halfRes.text();
    } catch (error) {
      readErr = error;
    }
    check("strict: truncated body surfaces as a read error", readErr !== null);
  }
  await tick();
  check("strict: response-started failure NEVER replayed through the proxy", proxyA.seen.connects.length === 0, JSON.stringify(proxyA.seen.connects));
  ctx2.dispose();
  halfServer.closeAllConnections?.();
  halfServer.close();

  // (c) strict still retries when the connection was NEVER established
  // (connect-phase: ECONNREFUSED, onConnect == 0) — covered by block 5, re-checked here.
  const ctx3 = fakeCtx();
  applyFallback(ctx3);
  await tick();
  proxyA.seen.connects.length = 0;
  let refusedErr = null;
  try {
    await fetch(`http://127.0.0.1:${closed}/`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    refusedErr = error;
  }
  await tick();
  check("strict: ECONNREFUSED (onConnect==0) IS replayed through the proxy", refusedErr !== null && proxyA.seen.connects.some((c) => c.startsWith(`127.0.0.1:${closed}`)), JSON.stringify(proxyA.seen.connects));
  ctx3.dispose();
}

await Promise.race([proxyA.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
await Promise.race([proxyB.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
await Promise.race([socks5.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
await Promise.race([socks4.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
await Promise.race([direct.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);

for (const key of PROXY_ENV_KEYS_TEST) {
  if (savedProxyEnv[key] === undefined) delete process.env[key];
  else process.env[key] = savedProxyEnv[key];
}

clearTimeout(watchdog);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
