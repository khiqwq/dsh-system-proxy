# Contributing to dsh-system-proxy

Thanks for your interest! This document covers how to set up the project,
run the test suite, and what to keep in mind when changing code.

## Prerequisites

- Node.js >= 22 (CI tests Node 22 and 24).
- npm >= 9 (the project is a pure ESM package with a `package-lock.json`).

## Development setup

```sh
npm ci
```

> If you are behind a restrictive network and npm's default cache is
> unavailable, point npm at a writable local cache:
> `npm ci --cache <path-to-writable-cache>`.

## Running tests

```sh
npm test
```

This runs, in order:

1. `node test/run-test.mjs` — standalone transport tests: local CONNECT /
   SOCKS proxy servers, fetch + node http(s) routing, rules, fallback,
   health, restoration, SOCKS auth / cross-origin isolation, redirects.
2. `node test/load-in-cordis.mjs` — real Cordis loader mount and hot-reload
   smoke test. It uses the package root automatically; set
   `DSH_TEST_PROFILE_DIR` to a custom profile directory if needed.
3. `node test/typert-test.mjs` — `systemProxyStatus` Service + strict Typert
   Remote manifest registration and hot-reload withdrawal.

## What to check before opening a PR

- `npm test` passes locally.
- `npm audit --audit-level=high` is clean (CI enforces this).
- No secrets, proxy credentials, or request headers are logged. Run the
  suite with `DEBUG=*` and confirm stderr contains no `user:pass`,
  `Authorization`, or `Bearer` values.
- New transport behavior has a test: SOCKS schemes, `(url, cb)` overloads,
  connect-phase fallback classification, redirect handling, and rule
  precedence are the usual blind spots.

## Design constraints

- **Backward compatibility**: legacy `enabled / mode / url / noProxy / only /
  patchNodeHttp` config must keep its exact semantics when the new
  `proxies / rules / default` surface is unused.
- **Loader patches replace the whole `config`** for an entry. If you change a
  rule or proxy in `cordis.patch.yml` examples, restate the complete `config`
  block — a partial restate silently drops the other keys.
- **No inference of provider/plugin identity**: attribution is explicit only
  via `ctx.networkRoute.run(...)` (or opt-in `trustRouteHeaders`). Do not add
  URL/heuristic guessing.
- **Fallback safety**: never replay a request after a response has started;
  POST and stream bodies are never auto-replayed.
- **Do not add unauthenticated HTTP routes** or modify DSH core trust
  boundaries (`WEB_SETTINGS_NAMESPACES`, `API_REMOTE_FORWARDED_EVENTS`,
  `PRIVILEGED_METHODS`, plugin inventory projection).

## Commit conventions

- Small, focused commits with a `type(scope): summary` style subject
  (e.g. `fix(transport): handle (url, cb) overload`).
- Reference the motivating issue/PR number when one exists.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](./LICENSE).
