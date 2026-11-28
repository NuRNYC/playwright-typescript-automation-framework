/**
 * Synthetic checkout data for the Sauce Demo checkout flow (M9-1).
 *
 * Everything here is pure: no Playwright import, no I/O, no environment
 * access, so the unit tests can load it under Node's type-stripping loader.
 * That also rules out TypeScript-only runtime syntax such as constructor
 * parameter properties, which the strip-only loader cannot execute.
 *
 * Values typed with `fill()` appear in report step titles on every run (S1)
 * and in traces and screenshots on failure (S2-S5). The defaults are
 * therefore fixed and unmistakably fictional, and the validation below is a
 * guard rail against pasting real personal data: it allows only short ASCII
 * letters, digits, spaces and hyphens (no `@`, so no email addresses).
 * Customer values must never appear in test titles or annotations.
 * See docs/security-testing-policy.md.
 */

/** The three fields on the checkout information page, in form order. */
export const CHECKOUT_FIELDS = ['firstName', 'lastName', 'postalCode'] as const;

export type CheckoutField = (typeof CHECKOUT_FIELDS)[number];

/** One synthetic customer. Derived from the field list, so they cannot drift. */
export type CheckoutCustomer = { readonly [Field in CheckoutField]: string };

/** Fixed fictional defaults, verified accepted by the site in M9-1-1. */
export const DEFAULT_CHECKOUT_CUSTOMER = Object.freeze({
  firstName: 'Synthetic',
  lastName: 'Customer',
  postalCode: '00000',
} as const satisfies CheckoutCustomer);

/** Longest value any field may hold. */
export const MAX_FIELD_LENGTH = 40;

/** Letters, digits, space and hyphen only. Empty is allowed (a missing field). */
const ALLOWED_VALUE = /^[A-Za-z0-9 -]*$/;

export type CheckoutValidationReason =
  'unknown-field' | 'not-a-string' | 'too-long' | 'disallowed-characters';

/**
 * A rejected value. The message names the field and the reason only -- never
 * the value, so a rejected real value cannot reach a log or a report.
 */
export class CheckoutCustomerError extends Error {
  readonly field: string;
  readonly reason: CheckoutValidationReason;

  constructor(field: string, reason: CheckoutValidationReason) {
    super(`Checkout customer field "${field}" is invalid: ${reason}.`);
    this.name = 'CheckoutCustomerError';
    this.field = field;
    this.reason = reason;
  }
}

function isCheckoutField(value: string): value is CheckoutField {
  return (CHECKOUT_FIELDS as readonly string[]).includes(value);
}

function validate(field: CheckoutField, value: unknown): string {
  if (typeof value !== 'string') {
    throw new CheckoutCustomerError(field, 'not-a-string');
  }
  if (value.length > MAX_FIELD_LENGTH) {
    throw new CheckoutCustomerError(field, 'too-long');
  }
  if (!ALLOWED_VALUE.test(value)) {
    throw new CheckoutCustomerError(field, 'disallowed-characters');
  }
  return value;
}

/**
 * Immutable builder: every `with` / `without` returns a NEW builder and leaves
 * the receiver unchanged, so a shared base can be derived from safely.
 *
 *   checkoutCustomer().build()                      // the defaults
 *   checkoutCustomer().without('postalCode').build() // a negative case
 */
export class CheckoutCustomerBuilder {
  readonly #values: CheckoutCustomer;

  private constructor(values: CheckoutCustomer) {
    this.#values = values;
  }

  /** A builder seeded with {@link DEFAULT_CHECKOUT_CUSTOMER}. */
  static create(): CheckoutCustomerBuilder {
    return new CheckoutCustomerBuilder({ ...DEFAULT_CHECKOUT_CUSTOMER });
  }

  /** Replace one field. Unknown field names fail to compile and throw at run time. */
  with(field: CheckoutField, value: string): CheckoutCustomerBuilder {
    if (!isCheckoutField(field)) {
      throw new CheckoutCustomerError(String(field), 'unknown-field');
    }
    return new CheckoutCustomerBuilder({ ...this.#values, [field]: value });
  }

  /** Leave one field empty, which the site reports as required. */
  without(field: CheckoutField): CheckoutCustomerBuilder {
    return this.with(field, '');
  }

  /** Validate every field and return a fresh frozen customer. */
  build(): CheckoutCustomer {
    return Object.freeze({
      firstName: validate('firstName', this.#values.firstName),
      lastName: validate('lastName', this.#values.lastName),
      postalCode: validate('postalCode', this.#values.postalCode),
    });
  }
}

/** Shorthand for {@link CheckoutCustomerBuilder.create}. */
export function checkoutCustomer(): CheckoutCustomerBuilder {
  return CheckoutCustomerBuilder.create();
}

/**
 * Parses the first `$<dollars>.<cents>` amount in a displayed string, such as
 * `$29.99` or `Tax: $2.40`, into integer cents. Integer arithmetic only, so
 * `subtotal + tax === total` is exact. Throws if no amount is present.
 */
export function parsePriceCents(text: string | null): number {
  const match = /\$(\d+)\.(\d{2})(?!\d)/.exec(text ?? '');
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error('No price in the form $<dollars>.<cents> was found.');
  }
  return Number(match[1]) * 100 + Number(match[2]);
}
