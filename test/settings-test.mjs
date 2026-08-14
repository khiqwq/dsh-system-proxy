import assert from "node:assert/strict";
import { Config, SYSTEM_PROXY_SETTINGS_NAMESPACE } from "../lib/index.js";

assert.equal(SYSTEM_PROXY_SETTINGS_NAMESPACE, "system-proxy");
assert.equal(Config.type, "object");
assert.equal(Config.dict.enabled.type, "boolean");
assert.equal(Config.dict.proxies.type, "dict");
assert.equal(Config.dict.rules.type, "array");
assert.equal(Config.dict.default.type, "object");
console.log("settings registration smoke test passed");
