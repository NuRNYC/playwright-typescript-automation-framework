/**
 * Request confinement for the API layer (ADR-0006). Pure.
 *
 * Measured in Playwright 1.64.1: an `APIRequestContext` with a `baseURL`
 * still sends an ABSOLUTE URL to whatever host it names, and it FOLLOWS
 * redirects to other origins by default. Confinement therefore cannot rely on
 * `baseURL`. It is enforced here instead:
 *
 * - The client builds every path itself from a fixed allow-list; specs never
 *   pass URLs.
 * - Every path is re-checked to be a plain relative path on the allow-list.
 * - The only origin a client can use is a verified loopback address.
 * - Redirects are never followed (`maxRedirects: 0`); a 3xx is a refusal.
 *
 * Kept free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */

/** Thrown when a request would leave the approved request flow. */
export class RequestPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestPolicyError';
  }
}

/** Every endpoint the API layer may call. Anything else is refused. */
const ALLOWED_ENDPOINTS: readonly RegExp[] = [/^\/api\/products$/, /^\/api\/products\/[1-9]\d*$/];

/** Never follow redirects: a redirect could leave the approved origin. */
export const MAX_REDIRECTS = 0;

/** The only interface the stub may bind to. */
export const LOOPBACK_ADDRESS = '127.0.0.1';

/** Builds the path for one product; the id must be a positive safe integer. */
export function productPath(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new RequestPolicyError('product id must be a positive integer');
  }
  return `/api/products/${id}`;
}

/** The path for the product collection. */
export const PRODUCTS_PATH = '/api/products';

/**
 * Asserts that `path` is a relative, allow-listed endpoint path. Rejects
 * absolute and protocol-relative URLs, any scheme, backslashes, dot segments,
 * queries, fragments and every endpoint not on the allow-list. The message
 * never echoes the rejected value.
 */
export function assertAllowedEndpoint(path: string): void {
  const problem = /^[a-z][a-z0-9+.-]*:/i.test(path)
    ? 'a URL scheme is not allowed'
    : path.startsWith('//')
      ? 'a protocol-relative URL is not allowed'
      : !path.startsWith('/')
        ? 'the path must start with "/"'
        : /[\\?#]|\/\.\.?(\/|$)|\s/.test(path)
          ? 'the path must not contain backslashes, dot segments, queries, fragments or whitespace'
          : !ALLOWED_ENDPOINTS.some((pattern) => pattern.test(path))
            ? 'the endpoint is not on the allow-list'
            : undefined;
  if (problem !== undefined) {
    throw new RequestPolicyError(`Refused API request path: ${problem}.`);
  }
}

/** The shape of `server.address()` for a TCP server. */
export interface BoundAddress {
  readonly address: string;
  readonly family: string;
  readonly port: number;
}

/**
 * Verifies the address a server actually bound to, and returns the only
 * origin the API layer will use. Anything other than IPv4 loopback on a real
 * port is refused.
 */
export function loopbackOrigin(bound: BoundAddress | string | null): string {
  if (bound === null || typeof bound === 'string') {
    throw new RequestPolicyError('API stub is not bound to a TCP address');
  }
  if (bound.address !== LOOPBACK_ADDRESS || bound.family !== 'IPv4') {
    throw new RequestPolicyError(`API stub must bind to ${LOOPBACK_ADDRESS} only`);
  }
  if (!Number.isInteger(bound.port) || bound.port < 1 || bound.port > 65535) {
    throw new RequestPolicyError('API stub has no valid port');
  }
  return `http://${LOOPBACK_ADDRESS}:${bound.port}`;
}

/** 3xx statuses are refused redirects, never followed. */
export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status <= 399;
}
