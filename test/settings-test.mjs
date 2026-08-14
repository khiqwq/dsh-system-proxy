import assert from "node:assert/strict";
import { Config, SYSTEM_PROXY_SETTINGS_NAMESPACE } from "../lib/index.js";

assert.equal(SYSTEM_PROXY_SETTINGS_NAMESPACE, "system-proxy");
assert.equal(Config.type, "object");
assert.equal(Config.dict.enabled.type, "boolean");
assert.equal(Config.dict.proxies.type, "dict");
assert.equal(Config.dict.rules.type, "array");
assert.equal(Config.dict.default.type, "object");
console.log("settings registration smoke test passed");

import { normalizeConfig } from "../lib/config.js";
const representatives = [
  {},
  { enabled: false, mode: "manual", url: "http://127.0.0.1:9", passwordRef: "DSH_PROXY_PASSWORD" },
  { proxies: { p: { url: "socks5h://127.0.0.1:1080", username: "u", passwordRef: "PROXY_PASS" } }, rules: [{ host: ["api.example"], provider: ["openai"], action: "proxy", proxy: "p" }], default: { strategy: "fallback", proxy: "p", directTimeoutMs: 1, latencyThresholdMs: 2, cooldownMs: 3, methods: ["GET"] } },
];
for (const value of representatives) {
  const validated = Config["~standard"].validate(value);
  assert.equal(validated.issues, undefined, JSON.stringify(validated.issues));
  assert.doesNotThrow(() => normalizeConfig(validated.value));
}
for (const value of [{ mode: "bogus" }, { proxies: [] }, { rules: {} }, { enabled: "yes" }]) {
  const validated = Config["~standard"].validate(value);
  assert.ok(validated.issues?.length > 0, "schema should reject " + JSON.stringify(value));
}
console.log("schema/runtime differential contract passed");
