/**
 * Unit tests for the saved-session policy.
 *
 * Same conventions as `src/config/env.test.ts` (ADR-0002): Node's built-in
 * runner, an explicit `./session.ts` import, and no ambient state. The clock
 * is injected, so expiry rules are tested at exact boundaries rather than
 * against the real time.
 *
 * Cookie values below are synthetic placeholders, never real session data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPIRY_MARGIN_SECONDS,
  SAUCEDEMO_SESSION,
  SessionStateError,
  assertSupportedTarget,
  checkSavedSession,
  selectSessionCookies,
  type SessionCookie,
} from './session.ts';

const NOW = 1_800_000_000;
const PLACEHOLDER_VALUE = 'placeholder-session-value';

function cookie(overrides: Partial<SessionCookie> = {}): SessionCookie {
  return {
    name: SAUCEDEMO_SESSION.cookieName,
    value: PLACEHOLDER_VALUE,
    domain: SAUCEDEMO_SESSION.hostname,
    path: SAUCEDEMO_SESSION.cookiePath,
    expires: NOW + 600,
    ...overrides,
  };
}

function state(cookies: unknown[], origins: unknown[] = []): unknown {
  return { cookies, origins };
}

/** Asserts a SessionStateError whose message matches and never leaks the value. */
function assertRejected(fn: () => unknown, message: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof SessionStateError);
    assert.match(error.message, message);
    assert.ok(!error.message.includes(PLACEHOLDER_VALUE), 'message must not contain the value');
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * checkSavedSession
 * ------------------------------------------------------------------ */

test('a fresh single-cookie session is accepted and returned unchanged', () => {
  const result = checkSavedSession(state([cookie()]), NOW);

  assert.deepEqual(result, { cookies: [cookie()], origins: [] });
});

test('a malformed state structure is rejected', () => {
  for (const input of [
    null,
    [],
    'state',
    {},
    { cookies: [] },
    { origins: [] },
    { cookies: {}, origins: [] },
  ]) {
    assertRejected(() => checkSavedSession(input, NOW), /not a valid storage state/);
  }
  assertRejected(
    () => checkSavedSession(state([{ ...cookie(), expires: '600' }]), NOW),
    /malformed cookie/,
  );
});

test('any origin storage is rejected, so cart data cannot be restored', () => {
  const withCart = state(
    [cookie()],
    [
      {
        origin: 'https://www.saucedemo.com',
        localStorage: [{ name: 'cart-contents', value: '[4]' }],
      },
    ],
  );

  assertRejected(() => checkSavedSession(withCart, NOW), /must not contain origin storage/);
});

test('a missing or wrongly named session cookie is rejected', () => {
  assertRejected(() => checkSavedSession(state([]), NOW), /exactly one cookie; found 0/);
  assertRejected(
    () => checkSavedSession(state([cookie({ name: 'other' })]), NOW),
    /only the "session-username" cookie/,
  );
});

test('an unexpected additional cookie is rejected', () => {
  assertRejected(
    () => checkSavedSession(state([cookie(), cookie({ name: 'tracker' })]), NOW),
    /exactly one cookie; found 2/,
  );
});

test('a cookie scoped to another domain or path is rejected', () => {
  for (const scoped of [
    cookie({ domain: '.saucedemo.com' }),
    cookie({ domain: 'evil.example' }),
    cookie({ path: '/inventory.html' }),
  ]) {
    assertRejected(() => checkSavedSession(state([scoped]), NOW), /must be scoped to/);
  }
});

test('expiry uses a 60-second safety margin at its exact boundary', () => {
  assert.equal(EXPIRY_MARGIN_SECONDS, 60);

  const justValid = state([cookie({ expires: NOW + EXPIRY_MARGIN_SECONDS + 1 })]);
  assert.doesNotThrow(() => checkSavedSession(justValid, NOW));

  for (const expires of [NOW + EXPIRY_MARGIN_SECONDS, NOW + 1, NOW, NOW - 600]) {
    assertRejected(
      () => checkSavedSession(state([cookie({ expires })]), NOW),
      /expired or expires within 60s/,
    );
  }
});

test('a cookie without an expiry time is rejected', () => {
  assertRejected(() => checkSavedSession(state([cookie({ expires: -1 })]), NOW), /no expiry time/);
});

/* ------------------------------------------------------------------ *
 * selectSessionCookies
 * ------------------------------------------------------------------ */

test('only the Sauce Demo session cookie survives selection', () => {
  const selected = selectSessionCookies([
    cookie({ name: 'backtrace-guid' }),
    cookie(),
    cookie({ domain: 'events.backtrace.io' }),
  ]);

  assert.deepEqual(selected, [cookie()]);
});

/* ------------------------------------------------------------------ *
 * assertSupportedTarget
 * ------------------------------------------------------------------ */

test('authentication fails closed outside the verified Sauce Demo hostname', () => {
  assert.doesNotThrow(() => assertSupportedTarget('saucedemo', 'https://www.saucedemo.com/'));

  assertRejected(
    () => assertSupportedTarget('staging', 'https://www.saucedemo.com/'),
    /verified only for APP_TARGET=saucedemo/,
  );
  assertRejected(
    () => assertSupportedTarget('saucedemo', 'https://staging.example.com/'),
    /verified only for www\.saucedemo\.com/,
  );
  assertRejected(() => assertSupportedTarget('saucedemo', 'not a url'), /valid base URL/);
});
