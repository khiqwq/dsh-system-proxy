# Security Policy

## Reporting a Vulnerability

Please **do not open a public issue** for security vulnerabilities. Report
them privately to the maintainers instead.

How to report:

- If the repository has a private vulnerability reporting channel enabled on
  GitHub, use **Security → Report a vulnerability** on the repository page.
- Otherwise, contact the maintainers via a private channel (for example a
  direct message on GitHub, or email if listed in the repository description).

Please include:

- the affected version(s) and Node.js version;
- a minimal reproduction (config snippet + steps);
- impact assessment if you have one (e.g. credential exposure, SSRF,
  outbound bypass).

You should receive an acknowledgement within a few business days. We ask that
you refrain from public disclosure until a fix has been released and the
maintainers have had reasonable time to coordinate.

## Scope

This policy covers the `dsh-system-proxy` package itself: the routing engine
in `lib/`, the loader patch in `cordis.patch.yml`, and the published npm
artifact.

Out of scope:

- upstream dependencies (report those to their own maintainers);
- the DeepSeek Harness / Cordis core (report those upstream);
- user configuration mistakes (documented behavior, e.g. intentionally
  trusting `HTTP(S)_PROXY` environment variables).

## Security-relevant behavior

- Proxy credentials in URLs are redacted from all plugin log output.
- Credentials are stripped from the proxy URL before ANY transport agent is
  constructed; authentication is injected separately (undici `token`, node
  agent `headers` `Proxy-Authorization`, SOCKS handshake `userId`/`password`).
- SOCKS4/4a with an IPv6 target is refused explicitly
  (`SOCKS4_IPV6_UNSUPPORTED`), never silently direct.
- By default, `trustRouteHeaders` is off: `x-dsh-route-*` headers are
  forgeable and are not honored unless explicitly enabled. They are always
  stripped from the outbound request before dispatch, even while untrusted.
- Route context for provider/plugin rules is never inferred from URLs; it is
  only attached explicitly via `ctx.networkRoute.run(...)`.
- `fallback` replays only safe requests (bounded, buffered bodies; the
  configured method allow-list) and only on connect-phase failures.
- Loopback, link-local, cloud metadata endpoints, RFC1918 and IPv6 ULA ranges
  are direct by default (`protectLocal` / `protectPrivate`).

If you believe any of these guarantees are violated, please report it.
