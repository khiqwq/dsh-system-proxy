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
  env: { ...process.env, DEBUG: "*" },
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
