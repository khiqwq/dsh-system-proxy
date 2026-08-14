/**
 * Route context propagation for dsh-system-proxy.
 *
 * The global fetch / node http(s) wrappers only ever see a target URL; they
 * cannot reliably know which DSH plugin or provider issued a request. Instead
 * of guessing, this module exposes an explicit, honest opt-in channel:
 *
 *  - An AsyncLocalStorage scope. Any plugin can wrap its outbound calls with
 *    `ctx.networkRoute.run({ provider, plugin }, () => fetch(...))` (or the
 *    module-level `runWithRoute`) so the request is attributed while it is
 *    in flight — including every nested async operation.
 *  - An optional request-header channel (`trustRouteHeaders: true`). When
 *    enabled, `x-dsh-route-provider` / `x-dsh-route-plugin` headers on a
 *    request are honored. Off by default because headers are forgeable; the
 *    header name prefix is configurable via `routeHeaderPrefix`.
 *
 * Nothing here infers provider/plugin identity from URLs or heuristics.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with a route context attached (provider/plugin attribution).
 * Returns whatever `fn` returns (promises are awaited naturally by ALS).
 * @param route - `{ provider?, plugin? }` attribution, or null to clear.
 * @param fn - the work to attribute, including any nested async calls.
 */
export function runWithRoute(route, fn) {
  return storage.run(route ?? null, fn);
}

/** The route context attached to the current async execution, or null. */
export function currentRoute() {
  return storage.getStore() ?? null;
}

/**
 * Wrap an async iterable so EVERY iteration step (`next` / `return` / `throw`)
 * runs inside the ALS route context.
 *
 * This matters because `als.run(meta, () => iterable)` does NOT keep the
 * context alive for later iteration: the iterator's `next()` calls execute in
 * whatever async context the consumer happens to be in, losing the route.
 * Wrapping the `[Symbol.asyncIterator]` protocol guarantees a stream (e.g. an
 * SSE body consumed lazily) is fully attributed to `route`.
 * @param route - `{ provider?, plugin? }` attribution (null clears).
 * @param iterable - any async iterable.
 * @returns a new async iterable with context-preserving iteration.
 */
export function wrapAsyncIterable(route, iterable) {
  const source = iterable[Symbol.asyncIterator]();
  const wrapped = {
    next: (arg) => storage.run(route ?? null, () => source.next(arg)),
    return: (arg) =>
      storage.run(route ?? null, () =>
        source.return ? source.return(arg) : Promise.resolve({ done: true, value: undefined }),
      ),
    throw: (arg) =>
      storage.run(route ?? null, () =>
        source.throw ? source.throw(arg) : Promise.reject(arg),
      ),
  };
  return {
    [Symbol.asyncIterator]() {
      return wrapped;
    },
  };
}

/**
 * Build the `networkRoute` service value exposed on the Cordis context.
 * Other plugins use it as:
 *
 *   ctx.networkRoute.run({ provider: "openai" }, () => fetch(...))
 *   ctx.networkRoute.iterable({ provider: "openai" }, response.body)  // SSE
 *   ctx.networkRoute.get()   // -> { provider?, plugin? } | null
 */
export function createRouteService() {
  return {
    run: runWithRoute,
    get: currentRoute,
    /** Wrap an async iterable so every next/return/throw keeps the route. */
    iterable: wrapAsyncIterable,
    /** Attach only a provider, preserving any outer plugin attribution. */
    withProvider(provider, fn) {
      const outer = currentRoute();
      return runWithRoute(
        { ...(outer ?? {}), provider: provider ?? undefined },
        fn,
      );
    },
    /** Attach only a plugin, preserving any outer provider attribution. */
    withPlugin(plugin, fn) {
      const outer = currentRoute();
      return runWithRoute(
        { ...(outer ?? {}), plugin: plugin ?? undefined },
        fn,
      );
    },
  };
}
