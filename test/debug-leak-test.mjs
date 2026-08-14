/**
 * DEBUG credential-leak acceptance (SECURITY_HANDOFF item 2):
 * runs the plugin with CREDENTIALED proxies under `DEBUG=*` and asserts the
 * child's stderr never contains the proxy credentials, their URL form, or the
 * upstream Bearer token.
 *
 * Run: node test/debug-leak-test.mjs  (from the package root)
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;
const check = (label, ok, extra = "") => {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const child = spawn(process.execPath, ["test/debug-leak-child.mjs"], {
  cwd: ROOT,
  // The harness may set HTTPS_PROXY/NO_PROXY; strip all proxy env so the child
  // scenario is hermetic and only the explicitly-configured credentialed
  // proxies are exercised under DEBUG=*.
  env: (() => {
    const childEnv = { ...process.env, DEBUG: "*" };
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      delete childEnv[key];
    }
    return childEnv;
  })(),
});
let stderr = "";
let stdout = "";
child.stderr.on("data", (d) => (stderr += d));
child.stdout.on("data", (d) => (stdout += d));
const code = await new Promise((resolve) => child.on("close", resolve));

check("DEBUG leak: child scenario ran to completion", stdout.includes("[child-done]") && code === 0, `code=${code}`);
for (const needle of ["user:pass@", "sockuser", "sockpass", "sk-test-secret-xyz", "Bearer sk-"]) {
  check(`DEBUG leak: stderr has no ${JSON.stringify(needle)}`, !stderr.includes(needle), `needle=${needle}`);
}

if (failures > 0) {
  console.error("\n--- child stderr (first 2000 chars) ---\n" + stderr.slice(0, 2000));
  console.error(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nno credential leaks under DEBUG=*");
}
