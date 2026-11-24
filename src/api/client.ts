import type { APIRequestContext } from '@playwright/test';
import {
  parseJson,
  parseProduct,
  parseProductList,
  type ParseResult,
  type Product,
} from './contract';
import {
  MAX_REDIRECTS,
  PRODUCTS_PATH,
  assertAllowedEndpoint,
  isRedirectStatus,
  productPath,
} from './request-policy';

/**
 * Every outcome of an API call, as a discriminated union. The client never
 * throws for an HTTP or contract failure and never asserts: specs decide
 * what an outcome means, exactly as with page objects.
 *
 * Failure variants carry the status and, for contract problems, the field
 * path -- never a header, cookie or body.
 */
export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly kind: 'http-error'; readonly status: number }
  | { readonly ok: false; readonly kind: 'redirect-refused'; readonly status: number }
  | { readonly ok: false; readonly kind: 'malformed-json'; readonly status: number }
  | {
      readonly ok: false;
      readonly kind: 'contract-violation';
      readonly status: number;
      readonly problem: string;
    };

/**
 * Typed client for the synthetic product API (ADR-0006).
 *
 * It owns every endpoint: specs call methods, never URLs. The request
 * context it is given must already point at the verified loopback stub; the
 * client adds its own confinement on top (allow-listed relative paths, no
 * redirects). It has no dependency on a browser.
 */
export class ApiClient {
  readonly #request: APIRequestContext;

  constructor(request: APIRequestContext) {
    this.#request = request;
  }

  listProducts(): Promise<ApiResult<readonly Product[]>> {
    return this.#get(PRODUCTS_PATH, parseProductList);
  }

  getProduct(id: number): Promise<ApiResult<Product>> {
    return this.#get(productPath(id), (value) => parseProduct(value));
  }

  async #get<T>(path: string, parse: (value: unknown) => ParseResult<T>): Promise<ApiResult<T>> {
    assertAllowedEndpoint(path);
    const response = await this.#request.get(path, {
      maxRedirects: MAX_REDIRECTS,
      failOnStatusCode: false,
    });
    const status = response.status();

    if (isRedirectStatus(status)) {
      return { ok: false, kind: 'redirect-refused', status };
    }
    if (status < 200 || status > 299) {
      return { ok: false, kind: 'http-error', status };
    }
    const json = parseJson(await response.text());
    if (!json.ok) {
      return { ok: false, kind: 'malformed-json', status };
    }
    const parsed = parse(json.value);
    return parsed.ok
      ? { ok: true, status, data: parsed.value }
      : { ok: false, kind: 'contract-violation', status, problem: parsed.problem };
  }
}
