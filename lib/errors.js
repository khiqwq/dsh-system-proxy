/**
 * Shared error types for dsh-system-proxy.
 */

/** Base error for routing decisions made by this plugin. */
export class NetworkRouteError extends Error {
  /**
   * @param message - human-readable description.
   * @param code - stable machine-routable code (e.g. `NETWORK_BLOCKED`,
   *   `INVALID_PROXY`, `PROXY_FETCH_UNSUPPORTED`).
   * @param options - standard ErrorOptions (cause chaining).
   */
  constructor(message, code = "NETWORK_ROUTE", options) {
    super(message, options);
    this.name = "NetworkRouteError";
    this.code = code;
  }
}
