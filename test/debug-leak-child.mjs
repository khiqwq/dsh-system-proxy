/**
 * DEBUG-leak child scenario: runs the plugin with CREDENTIALED proxies under
 * `DEBUG=*` and exercises fetch + node http + node https (Bearer) + socks.
 * The parent (debug-leak-test.mjs) asserts stderr contains no credentials.
 *
 * Run by the parent test; not meant to be run standalone.
 */

import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { apply } from "../lib/index.js";

// Forward upstream with the ORIGINAL http.request (the plugin patches it; an
// in-process proxy must not re-enter the routing wrapper).
const ORIGINAL_HTTP_REQUEST = http.request;

// local CONNECT proxy
const proxy = http.createServer();
proxy.on("request", (req, res) => {
  const target = new URL(req.url);
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
proxy.on("connect", (req, socket) => {
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

// minimal socks4 server (credential field ignored on purpose)
const socks = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 9) return;
    const port = buffer.readUInt16BE(2);
    const ip = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
    let offset = 8;
    const userEnd = buffer.indexOf(0, offset);
    if (userEnd === -1) return;
    offset = userEnd + 1;
    let host = ip;
    if (ip.startsWith("0.0.0.")) {
      const domEnd = buffer.indexOf(0, offset);
      if (domEnd === -1) return;
      host = buffer.subarray(offset, domEnd).toString("utf8");
    }
    const upstream = net.connect(port, host, () => {
      socket.write(Buffer.from([0x00, 0x5a, 0x00, 0x00, 0, 0, 0, 0]));
      socket.off("data", onData);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.end());
    socket.on("error", () => upstream.destroy());
  };
  socket.on("data", onData);
});
socks.listen(0, "127.0.0.1");
await once(socks, "listening");
const socksPort = socks.address().port;

// local http target
const target = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok");
});
target.listen(0, "127.0.0.1");
await once(target, "listening");
const targetPort = target.address().port;

const logs = [];
const ctx = {
  logger: {
    info: (...a) => logs.push(a.join(" ")),
    warn: (...a) => logs.push(a.join(" ")),
    error: (...a) => logs.push(a.join(" ")),
    debug: () => {},
  },
  fiber: { state: 2 },
  effect() {
    return () => {};
  },
  provide() {},
};

// Credentialed HTTP proxy: user:pass in the URL; credentials must be stripped
// from the agent URL and never appear on stderr.
apply(ctx, {
  protectLocal: false,
  protectPrivate: false,
  noProxy: [],
  mode: "manual",
  url: `http://user:pass@127.0.0.1:${proxyPort}`,
  only: ["127.0.0.1", "example.com"],
});
// Credentialed socks4 proxy (socks path credentials are handshake-only).
apply(ctx, {
  protectLocal: false,
  protectPrivate: false,
  noProxy: [],
  proxies: { s4: `socks4://sockuser:sockpass@127.0.0.1:${socksPort}` },
  rules: [{ host: "127.0.0.2", action: "proxy", proxy: "s4" }],
  default: { strategy: "direct" },
});
await new Promise((r) => setTimeout(r, 200));

// 1) fetch (plain http) through the credentialed http proxy
await fetch(`http://127.0.0.1:${targetPort}/f1`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
// 2) node http.request(url, cb) through the http proxy
await new Promise((resolve) => {
  const req = http.request(`http://127.0.0.1:${targetPort}/n1`, (res) => resolve(res));
  req.on("error", () => resolve(null));
  req.end();
});
// 3) https LLM-like request with a Bearer token (inner headers stay inside TLS)
await fetch("https://example.com/", {
  headers: { Authorization: "Bearer sk-test-secret-xyz" },
  signal: AbortSignal.timeout(4000),
}).catch(() => null);
// 4) node http through the credentialed socks4 proxy
await new Promise((resolve) => {
  const req = http.request(`http://127.0.0.2:${targetPort}/n2`, (res) => resolve(res));
  req.on("error", () => resolve(null));
  req.end();
});

await new Promise((r) => setTimeout(r, 300));
console.log("[child-done]");
process.exit(0);
