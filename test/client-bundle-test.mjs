import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const [source, bundle, packageText] = await Promise.all([
  readFile(resolve(root, "client.js"), "utf8"),
  readFile(resolve(root, "lib/client.js"), "utf8"),
  readFile(resolve(root, "package.json"), "utf8"),
]);
const pkg = JSON.parse(packageText);
assert.equal(bundle, source, "build must reproduce the hand-written client bundle");
for (const token of [
  'window.__ModuleLoader__.load({', 'id: "dsh-system-proxy"',
  'settings.plugin.item', 'const NAMESPACE = "system-proxy"',
  '"enabled"', '"mode"', '"patchNodeHttp"', '"protectPrivate"',
  'type: "password"', 'autoComplete: "new-password"',
  'api.credentials.set', 'api.credentials.describe', 'passwordRef',
  '已配置', '页面不会回显原文', 'hasUserinfo(draft.proxyUrl)',
  'snapshot.status === "unavailable"',
]) assert.ok(bundle.includes(token), `client bundle missing ${token}`);
assert.equal(bundle.includes('type: "password", autoComplete: "new-password", value: draft.proxyUrl'), false);
assert.equal(pkg.exports["./client"], "./lib/client.js");
assert.equal(pkg.dsh.client.platform, "web");
const graphDependencies = [
  "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-api-remotes",
];
for (const dependency of graphDependencies) {
  assert.ok(pkg.dsh.client.inject.includes(dependency), `missing client graph dependency ${dependency}`);
  assert.equal(pkg.peerDependencies[dependency], "^0.1.0-rc.6");
}
assert.equal(pkg.peerDependencies.react, "^18.2.0");
assert.match(pkg.scripts.prepack, /build.*test/);
console.log("client bundle static test passed");
