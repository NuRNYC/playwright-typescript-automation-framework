/**
 * API response contract: types and runtime guards. Pure.
 *
 * `response.json()` returns `any`. This module is the trust boundary that
 * turns that untrusted value into typed data -- the same `unknown` → typed
 * pattern as `checkSavedSession` and the accessibility policy. No schema
 * library: M5's contract is two shapes, and hand-written guards keep the
 * framework dependency-free (ADR-0006).
 *
 * Extra fields are TOLERATED BUT DROPPED: a parsed value contains exactly the
 * contract's fields, so an unexpected server field can never leak into a
 * spec's assertions or reports by accident.
 *
 * Kept free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */

/** A product as the API layer exposes it. */
export interface Product {
  readonly id: number;
  readonly name: string;
  readonly priceCents: number;
}

/**
 * The result of parsing untrusted input. A failure names WHERE the contract
 * was broken (a field path such as `[1].priceCents`), never the offending
 * value, so problems are safe to put in reports.
 */
export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validates one product. `path` prefixes the field name in problems. */
export function parseProduct(value: unknown, path = 'product'): ParseResult<Product> {
  if (!isRecord(value)) {
    return { ok: false, problem: `${path} must be an object` };
  }
  if (!isPositiveInteger(value.id)) {
    return { ok: false, problem: `${path}.id must be a positive integer` };
  }
  if (typeof value.name !== 'string' || value.name.trim() === '') {
    return { ok: false, problem: `${path}.name must be a non-empty string` };
  }
  if (!isNonNegativeInteger(value.priceCents)) {
    return { ok: false, problem: `${path}.priceCents must be a non-negative integer` };
  }
  // Only the contract's fields are carried forward; extras are dropped.
  return { ok: true, value: { id: value.id, name: value.name, priceCents: value.priceCents } };
}

/** Validates a product collection: an array whose every element is a product. */
export function parseProductList(value: unknown): ParseResult<readonly Product[]> {
  if (!Array.isArray(value)) {
    return { ok: false, problem: 'product list must be an array' };
  }
  const products: Product[] = [];
  for (const [index, element] of value.entries()) {
    const parsed = parseProduct(element, `[${index}]`);
    if (!parsed.ok) {
      return parsed;
    }
    products.push(parsed.value);
  }
  return { ok: true, value: products };
}

/**
 * Parses a response body as JSON without throwing. A syntax error is a
 * distinct, typed outcome from a structurally invalid document.
 */
export function parseJson(text: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, problem: 'response body is not valid JSON' };
  }
}
