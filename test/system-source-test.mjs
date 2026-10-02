import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeConfig, resolveProxyPlan, systemProxyUrl } from "../lib/config.js";
import { hostPortMatches } from "../lib/rules.js";
import { apply } from "../lib/index.js";

const commands = mkdtempSync(join(tmpdir(), "dsh-system-proxy-"));
const command = `#!/usr/bin/env node
const name = process.argv[1].split("/").pop();
if (name === "gsettings") {
  const key = process.argv.slice(2).join(" ");
  const settings = JSON.parse(process.env.TEST_GSETTINGS || "{}");
  if (!(key in settings)) process.exit(1);
  console.log(settings[key]);
} else if (name === "kreadconfig6") {
  const key = process.argv[process.argv.indexOf("--key") + 1];
  const settings = JSON.parse(process.env.TEST_KDE || "{}");
  if (!(key in settings)) process.exit(1);
  console.log(settings[key]);
} else if (name === "reg" || name === "scutil") {
  console.log(process.env[name === "reg" ? "TEST_REG" : "TEST_SCUTIL"] || "");
} else {
  process.exit(1);
}
`;
for (const name of ["gsettings", "kreadconfig6", "reg", "scutil"]) {
  writeFileSync(join(commands, name), command, { mode: 0o755 });
}
const originalPath = process.env.PATH;
process.env.PATH = `${commands}:${originalPath}`;

function settings(gnome, kde, desktop = "niri") {
  process.env.TEST_GSETTINGS = JSON.stringify(gnome);
  process.env.TEST_KDE = JSON.stringify(kde);
  process.env.XDG_CURRENT_DESKTOP = desktop;
  process.env.KDE_SESSION_VERSION = "6";
}

test("niri reads the active GNOME manual proxy, not the unrelated KDE state", async () => {
  settings({
    "get org.gnome.system.proxy mode": "'manual'",
    "get org.gnome.system.proxy.https host": "'localhost'",
    "get org.gnome.system.proxy.https port": "7897",
  }, { ProxyType: "0" });
  assert.equal(await systemProxyUrl(), "http://localhost:7897");
});

test("KDE uses its own active KIO proxy, not a stale GNOME setting", async () => {
  settings({
    "get org.gnome.system.proxy mode": "'manual'",
    "get org.gnome.system.proxy.https host": "'stale'",
    "get org.gnome.system.proxy.https port": "9090",
  }, {
    ProxyType: "1",
    httpsProxy: "http://127.0.0.1:7897",
  }, "KDE");
  assert.equal(await systemProxyUrl(), "http://127.0.0.1:7897");
  process.env.TEST_KDE = JSON.stringify({ ProxyType: "0", httpsProxy: "http://127.0.0.1:7897" });
  assert.equal(await systemProxyUrl(), "");
});

test("KDE bypass entries follow the active KIO proxy", async () => {
  settings({}, {
    ProxyType: "1",
    httpsProxy: "http://127.0.0.1:7897",
    NoProxyFor: "localhost,*.corp.example",
  }, "KDE");
  const plan = await resolveProxyPlan(normalizeConfig({ mode: "system" }));
  assert.ok(plan.noProxy.includes("*.corp.example"));
});

test("KDE 6 resolves KIO settings when KDE_SESSION_VERSION is absent", async () => {
  settings({}, { ProxyType: "1", httpsProxy: "http://localhost:7897" }, "KDE");
  delete process.env.KDE_SESSION_VERSION;
  assert.equal(await systemProxyUrl(), "http://localhost:7897");
});

test("disabled GNOME setting does not use a stored proxy endpoint", async () => {
  settings({
    "get org.gnome.system.proxy mode": "'none'",
    "get org.gnome.system.proxy.https host": "'localhost'",
    "get org.gnome.system.proxy.https port": "7897",
  }, {});
  assert.equal(await systemProxyUrl(), "");
});


test("GNOME bypass hosts are enforced by the resolved routing plan", async () => {
  settings({
    "get org.gnome.system.proxy mode": "'manual'",
    "get org.gnome.system.proxy.https host": "'localhost'",
    "get org.gnome.system.proxy.https port": "7897",
    "get org.gnome.system.proxy ignore-hosts": "['localhost', '*.corp.example', '10.0.0.0/8']",
  }, {});
  const plan = await resolveProxyPlan(normalizeConfig({ mode: "system" }));
  assert.equal(plan.resolved.get("default")?.url, "http://localhost:7897/");
  assert.ok(plan.noProxy.includes("*.corp.example"));
});

test("GNOME falls back to SOCKS when HTTP endpoints are absent", async () => {
  settings({
    "get org.gnome.system.proxy mode": "'manual'",
    "get org.gnome.system.proxy.https host": "''",
    "get org.gnome.system.proxy.https port": "0",
    "get org.gnome.system.proxy.http host": "''",
    "get org.gnome.system.proxy.http port": "0",
    "get org.gnome.system.proxy.socks host": "'127.0.0.1'",
    "get org.gnome.system.proxy.socks port": "1080",
  }, {});
  assert.equal(await systemProxyUrl(), "socks5h://127.0.0.1:1080");
});

test("GNOME accepts a standard HTTP proxy port and rejects malformed hosts", async () => {
  settings({
    "get org.gnome.system.proxy mode": "'manual'",
    "get org.gnome.system.proxy.https host": "'proxy.example'",
    "get org.gnome.system.proxy.https port": "80",
  }, {});
  assert.equal(await systemProxyUrl(), "http://proxy.example:80");
  process.env.TEST_GSETTINGS = JSON.stringify({
    "get org.gnome.system.proxy mode": "'manual'",
    "get org.gnome.system.proxy.https host": "'proxy.example/other'",
    "get org.gnome.system.proxy.https port": "7897",
  });
  assert.equal(await systemProxyUrl(), "");
});

test("Windows manual proxy honors WinINET enabled state and bypass entries", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    process.env.TEST_REG = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=localhost:7897;https=localhost:7897
    ProxyOverride    REG_SZ    localhost;*.corp.example;<local>
`;
    const plan = await resolveProxyPlan(normalizeConfig({ mode: "system" }));
    assert.equal(plan.resolved.get("default")?.url, "http://localhost:7897/");
    assert.ok(plan.noProxy.includes("*.corp.example"));
    process.env.TEST_REG = process.env.TEST_REG.replace("0x1", "0x0");
    assert.equal(await systemProxyUrl(), "");
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("macOS manual proxy honors scutil exceptions and disabled state", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    process.env.TEST_SCUTIL = `<dictionary> {
  HTTPSEnable : 1
  HTTPSProxy : localhost
  HTTPSPort : 7897
  ExceptionsList : <array> {
    0 : localhost
    1 : *.corp.example
  }
}`;
    const plan = await resolveProxyPlan(normalizeConfig({ mode: "system" }));
    assert.equal(plan.resolved.get("default")?.url, "http://localhost:7897/");
    assert.ok(plan.noProxy.includes("*.corp.example"));
    process.env.TEST_SCUTIL = "<dictionary> { HTTPSEnable : 0 HTTPSProxy : localhost HTTPSPort : 7897 }";
    assert.equal(await systemProxyUrl(), "");
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("macOS does not use an HTTPS endpoint when only HTTP is enabled", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    process.env.TEST_SCUTIL = `<dictionary> {
  HTTPSEnable : 0
  HTTPSProxy : wrong.example
  HTTPSPort : 9999
  HTTPEnable : 1
  HTTPProxy : correct.example
  HTTPPort : 8080
}`;
    assert.equal(await systemProxyUrl(), "http://correct.example:8080");
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("WinINET <local> bypass protects unqualified intranet hostnames", () => {
  assert.equal(hostPortMatches("<local>", "intranet"), true);
  assert.equal(hostPortMatches("<local>", "api.example.com"), false);
  assert.equal(hostPortMatches("<local>", "10.0.0.3"), false);
});

test("active system proxy follows changes and removes its transport when disabled", async () => {
  settings({
    "get org.gnome.system.proxy mode": "'manual'",
    "get org.gnome.system.proxy.https host": "'localhost'",
    "get org.gnome.system.proxy.https port": "7897",
  }, {});
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let poll;
  const cleanups = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    },
  };
  const waitFor = async (condition) => {
    for (let i = 0; i < 30 && !condition(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(condition(), "proxy state did not converge");
  };
  try {
    globalThis.setInterval = (fn) => {
      poll = fn;
      return { unref() {} };
    };
    globalThis.clearInterval = () => {};
    apply(ctx, { mode: "system" });
    await waitFor(() => globalThis.fetch !== originalFetch);
    assert.equal(typeof poll, "function");
    process.env.TEST_GSETTINGS = JSON.stringify({ "get org.gnome.system.proxy mode": "'none'" });
    await poll();
    await waitFor(() => globalThis.fetch === originalFetch);
    settings({
      "get org.gnome.system.proxy mode": "'manual'",
      "get org.gnome.system.proxy.https host": "'localhost'",
      "get org.gnome.system.proxy.https port": "7897",
    }, {});
    await poll();
    await waitFor(() => globalThis.fetch !== originalFetch);
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
    assert.equal(globalThis.fetch, originalFetch);
  }
});
process.on("exit", () => {
  process.env.PATH = originalPath;
  rmSync(commands, { recursive: true, force: true });
});
