/**
 * Unit tests for the synthetic checkout builder and price parser (M9-1).
 *
 * Run with Node's built-in runner: `npm run test:unit`. No browser, no
 * network. Imports './checkout.ts' with its extension, as the type-stripping
 * loader requires (see ADR-0002).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKOUT_FIELDS,
  CheckoutCustomerError,
  DEFAULT_CHECKOUT_CUSTOMER,
  MAX_FIELD_LENGTH,
  checkoutCustomer,
  parsePriceCents,
  type CheckoutField,
} from './checkout.ts';

function rejection(build: () => unknown): CheckoutCustomerError {
  try {
    build();
  } catch (error) {
    assert.ok(error instanceof CheckoutCustomerError);
    return error;
  }
  assert.fail('expected a CheckoutCustomerError');
}

test('defaults are the fixed synthetic customer', () => {
  assert.deepEqual(checkoutCustomer().build(), {
    firstName: 'Synthetic',
    lastName: 'Customer',
    postalCode: '00000',
  });
  assert.deepEqual(checkoutCustomer().build(), DEFAULT_CHECKOUT_CUSTOMER);
});

test('output is deterministic across builders and calls', () => {
  const builder = checkoutCustomer().with('lastName', 'Example');
  assert.deepEqual(builder.build(), builder.build());
  assert.deepEqual(builder.build(), checkoutCustomer().with('lastName', 'Example').build());
});

test('build returns a fresh frozen object each time', () => {
  const builder = checkoutCustomer();
  const first = builder.build();
  const second = builder.build();
  assert.notEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(second));
  assert.notEqual(first, DEFAULT_CHECKOUT_CUSTOMER);
});

test('the defaults constant is frozen', () => {
  assert.ok(Object.isFrozen(DEFAULT_CHECKOUT_CUSTOMER));
});

test('with replaces only the named field', () => {
  assert.deepEqual(checkoutCustomer().with('postalCode', '12345').build(), {
    firstName: 'Synthetic',
    lastName: 'Customer',
    postalCode: '12345',
  });
});

test('the builder is immutable: deriving leaves the base unchanged', () => {
  const base = checkoutCustomer();
  const derived = base.with('firstName', 'Other').without('lastName');
  assert.notEqual(base, derived);
  assert.deepEqual(base.build(), DEFAULT_CHECKOUT_CUSTOMER);
  assert.deepEqual(derived.build(), {
    firstName: 'Other',
    lastName: '',
    postalCode: '00000',
  });
});

test('without leaves each field empty for negative cases', () => {
  for (const field of CHECKOUT_FIELDS) {
    const customer = checkoutCustomer().without(field).build();
    assert.equal(customer[field], '');
    for (const other of CHECKOUT_FIELDS.filter((name) => name !== field)) {
      assert.equal(customer[other], DEFAULT_CHECKOUT_CUSTOMER[other]);
    }
  }
});

test('accepts letters, digits, spaces and hyphens up to the length limit', () => {
  const longest = 'A'.repeat(MAX_FIELD_LENGTH);
  assert.equal(checkoutCustomer().with('firstName', longest).build().firstName, longest);
  assert.equal(
    checkoutCustomer().with('lastName', 'Fictional Name-2').build().lastName,
    'Fictional Name-2',
  );
});

test('rejects an over-length value', () => {
  const error = rejection(() =>
    checkoutCustomer()
      .with('lastName', 'B'.repeat(MAX_FIELD_LENGTH + 1))
      .build(),
  );
  assert.equal(error.field, 'lastName');
  assert.equal(error.reason, 'too-long');
});

test('rejects disallowed characters, including email-shaped values', () => {
  for (const value of ['someone@example.com', 'Line\nBreak', 'Semi;colon', 'Ünicode']) {
    const error = rejection(() => checkoutCustomer().with('firstName', value).build());
    assert.equal(error.field, 'firstName');
    assert.equal(error.reason, 'disallowed-characters');
  }
});

test('error messages name the field and reason but never echo the value', () => {
  const secretLooking = 'Do-Not-Echo-This-Value-9';
  const error = rejection(() => checkoutCustomer().with('postalCode', `${secretLooking}@`).build());
  assert.equal(
    error.message,
    'Checkout customer field "postalCode" is invalid: disallowed-characters.',
  );
  assert.ok(!error.message.includes(secretLooking));
});

test('rejects a non-string value from an untyped caller', () => {
  const untyped = checkoutCustomer() as unknown as {
    with(field: string, value: unknown): { build(): unknown };
  };
  const error = rejection(() => untyped.with('postalCode', 12345).build());
  assert.equal(error.reason, 'not-a-string');
});

test('unknown field names are a compile error and a run-time error', () => {
  const error = rejection(() =>
    // @ts-expect-error -- 'email' is not a CheckoutField.
    checkoutCustomer().with('email', 'x'),
  );
  assert.equal(error.reason, 'unknown-field');

  // Type-level check: the field union is exactly the three form fields.
  const fields: readonly CheckoutField[] = CHECKOUT_FIELDS;
  assert.deepEqual(fields, ['firstName', 'lastName', 'postalCode']);
});

test('parsePriceCents reads displayed amounts as integer cents', () => {
  assert.equal(parsePriceCents('$29.99'), 2999);
  assert.equal(parsePriceCents('Item total: $29.99'), 2999);
  assert.equal(parsePriceCents('Tax: $2.40'), 240);
  assert.equal(parsePriceCents('Total: $32.39'), 3239);
  assert.equal(parsePriceCents('$0.07'), 7);
  // Exact integer arithmetic where floating point would not be.
  assert.equal(parsePriceCents('$0.10') + parsePriceCents('$0.20'), parsePriceCents('$0.30'));
});

test('parsePriceCents rejects text without a well-formed amount', () => {
  for (const text of [null, '', 'Total:', '$29', '$29.9', '29.99', '$29.999']) {
    assert.throws(() => parsePriceCents(text), /No price/);
  }
});
