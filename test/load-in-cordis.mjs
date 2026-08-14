/**
 * Loads the plugin through the REAL Cordis loader the same way a DSH profile
 * boot does, then verifies proxying inside the fiber and restoration after
 * disposal. Uses only local targets so the checks are deterministic.
 *
 * The loader entry is resolved from the package root (relative specifier), so
 * the test runs on any machine. For a full-fidelity bare-name mount from a
 * real DSH profile, set DSH_TEST_PROFILE_DIR to that profile directory, e.g.:
 *
 *   $env:DSH_TEST_PROFILE_DIR = "$env:DSH_HOME\profiles\web"
 *
 * Run: node test/load-in-cordis.mjs  (from the package root)
 */

import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";

const PACKAGE_ROOT = new URL("../", import.meta.url).href;
const userProfile = process.env.DSH_TEST_PROFILE_DIR;
const PROFILE_DIR = userProfile
  ? pathToFileURL(userProfile.replace(/[\\/]+$/, "") + "/").href
  : PACKAGE_ROOT;
const ENTRY_NAME = userProfile ? "dsh-system-proxy" : "./lib/index.js";
let failures = 0;
const check = (label, ok, extra = "") => {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

// The runner environment may set proxy vars (the harness sets HTTPS_PROXY and
// NO_PROXY); the plugin merges NO_PROXY into the direct baseline and reads
// proxy URLs from the standard env keys. Clear ALL of them so routing checks
// are hermetic; restore at the end.
const PROXY_ENV_KEYS_TEST = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
];
const savedProxyEnv = {};
for (const key of PROXY_ENV_KEYS_TEST) {
  savedProxyEnv[key] = process.env[key];
  delete process.env[key];
}

// local CONNECT proxy
const seen = [];
const proxy = http.createServer();
proxy.on("connect", (req, socket) => {
  seen.push(req.url);
  const idx = req.url.lastIndexOf(":");
  const host = req.url.slice(0, idx);
  const port = Number(req.url.slice(idx + 1)) || 443;
  const upstream = net.connect(port, host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => {
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.end();
  });
  socket.on("error", () => upstream.destroy());
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const proxyPort = proxy.address().port;

// local target server (0.0.0.0 → reachable via any 127.x address)
const local = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("local:" + req.url);
});
local.listen(0, "0.0.0.0");
await once(local, "listening");
const localPort = local.address().port;

// Routing-test config opts out of the loopback safety net.
const baseConfig = {
  protectLocal: false,
  protectPrivate: false,
  mode: "manual",
  url: `http://127.0.0.1:${proxyPort}`,
  only: ["127.0.0.1"],
};

const root = new Context();
await root.plugin(Loader, { baseUrl: PROFILE_DIR });
await root.loader.await();

const id = await root.loader.create({
  name: ENTRY_NAME,
  config: { ...baseConfig },
});
await root.loader.await();
await new Promise((r) => setTimeout(r, 150)); // let async proxy resolution settle

const before = seen.length;
const res = await fetch(`http://127.0.0.1:${localPort}/a`, {
  signal: AbortSignal.timeout(5000),
}).catch(() => null);
await new Promise((r) => setTimeout(r, 100));
check(
  "inside cordis: proxied fetch reached the proxy",
  seen.length === before + 1 && seen.at(-1).startsWith(`127.0.0.1:${localPort}`),
  JSON.stringify(seen.slice(before)),
);
check("inside cordis: proxied fetch got a response", res !== null && res.status === 200);

// hot-reload path: update the entry, plugin re-applies from new config
const seenBeforeUpdate = seen.length;
await root.loader.update(id, {
  config: { ...baseConfig, only: ["127.0.0.2"] },
});
await root.loader.await();
await new Promise((r) => setTimeout(r, 150));
const onlyRes = await fetch(`http://127.0.0.2:${localPort}/b`, {
  signal: AbortSignal.timeout(5000),
}).catch(() => null);
await new Promise((r) => setTimeout(r, 100));
check(
  "after reload: only-listed host now goes through the proxy",
  seen.length === seenBeforeUpdate + 1 && seen.at(-1).startsWith(`127.0.0.2:${localPort}`),
  JSON.stringify(seen.slice(seenBeforeUpdate)),
);
check("after reload: response still served", onlyRes !== null && onlyRes.status === 200);

await root.loader.remove(id);
await root.loader.await();
const fetchBack = await fetch(`http://127.0.0.1:${localPort}/`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
check("after removal: direct fetch still works", fetchBack !== null && fetchBack.status === 200);

await root.fiber.dispose();
await new Promise((r) => setTimeout(r, 200)); // let agent close() settle
proxy.closeAllConnections();
proxy.close();
local.closeAllConnections();
local.close();

for (const key of PROXY_ENV_KEYS_TEST) {
  if (savedProxyEnv[key] === undefined) delete process.env[key];
  else process.env[key] = savedProxyEnv[key];
}

// exitCode instead of exit(): let pending async teardown finish first.
process.exitCode = failures > 0 ? 1 : 0;
if (failures > 0) console.error(`\n${failures} check(s) FAILED`);
else console.log("\nall in-cordis checks passed");
