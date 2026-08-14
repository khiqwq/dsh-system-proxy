/**
 * Observability test: the `systemProxyStatus` Cordis Service + strict Typert
 * Remote manifest (no decorators) survive real loader mounts and hot reloads.
 *
 * The typert registry rejects duplicate endpoints; the plugin ties the
 * manifest disposer to its own fiber, so reloading the entry withdraws the
 * old registration before the new one lands.
 *
 * Run: node test/typert-test.mjs  (from the package root)
 */

import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";

const PACKAGE_ROOT = new URL("../", import.meta.url).href;
let failures = 0;
const check = (label, ok, extra = "") => {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  }
};
const tick = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

const ENDPOINT = "systemProxyStatus/status";

const root = new Context();
new TypertRegistry(root);
await root.plugin(Loader, { baseUrl: PACKAGE_ROOT });
await root.loader.await();

const id = await root.loader.create({
  name: "./lib/index.js",
  config: { enabled: true, mode: "manual", url: "" }, // inert: no proxy resolves
});
await root.loader.await();
await tick();

check(
  "typert: strict manifest endpoint registered",
  root.typert.local.get(ENDPOINT) !== undefined,
);
const descriptor = root.typert.local.get(ENDPOINT);
check(
  "typert: endpoint maps to systemProxyStatus.status",
  descriptor?.namespace === "systemProxyStatus" && descriptor?.method === "status",
  JSON.stringify(descriptor),
);

// The provided Service is reachable and returns sanitized JSON.
const statusService = root.get("systemProxyStatus");
check("typert: systemProxyStatus service provided", statusService !== undefined && typeof statusService.status === "function");
const status = statusService.status();
check(
  "typert: status is pure sanitized JSON",
  status && typeof status === "object" && Array.isArray(status.proxies) && "health" in status,
  JSON.stringify(status).slice(0, 120),
);
check(
  "typert: status carries no credentials (proxies use redacted display)",
  JSON.stringify(status).includes("user:pass") === false && JSON.stringify(status).includes("://***") === false,
);

// Hot reload: re-applying the same entry must withdraw-then-register without
// a duplicate-endpoint rejection.
await root.loader.update(id, { config: { enabled: true, mode: "manual", url: "" } });
await root.loader.await();
await tick();
check("typert: after reload endpoint still registered (no duplicate crash)", root.typert.local.get(ENDPOINT) !== undefined);

// Removal withdraws the manifest.
await root.loader.remove(id);
await root.loader.await();
await tick();
check("typert: after removal endpoint withdrawn", root.typert.local.get(ENDPOINT) === undefined);

// A re-created entry can register again.
const id2 = await root.loader.create({
  name: "./lib/index.js",
  config: { enabled: true, mode: "manual", url: "" },
});
await root.loader.await();
await tick();
check("typert: re-create registers again", root.typert.local.get(ENDPOINT) !== undefined);
await root.loader.remove(id2);
await root.loader.await();

await root.fiber.dispose();
process.exitCode = failures > 0 ? 1 : 0;
if (failures > 0) console.error(`\n${failures} check(s) FAILED`);
else console.log("\nall typert observability checks passed");
