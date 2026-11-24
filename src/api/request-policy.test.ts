/**
 * Unit tests for API request confinement (ADR-0006).
 *
 * Same conventions as the other `node:test` suites (ADR-0002). Inputs are
 * synthetic; no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOOPBACK_ADDRESS,
  MAX_REDIRECTS,
  PRODUCTS_PATH,
  RequestPolicyError,
  assertAllowedEndpoint,
  isRedirectStatus,
  loopbackOrigin,
  productPath,
} from './request-policy.ts';

function rejected(path: string): RegExp | undefined {
  try {
    assertAllowedEndpoint(path);
    return undefined;
  } catch (error) {
    assert.ok(error instanceof RequestPolicyError);
    return new RegExp(error.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
}

test('client-built endpoint paths are accepted', () => {
  assert.doesNotThrow(() => assertAllowedEndpoint(PRODUCTS_PATH));
  assert.doesNotThrow(() => assertAllowedEndpoint(productPath(1)));
  assert.doesNotThrow(() => assertAllowedEndpoint(productPath(902)));
});

test('absolute, protocol-relative and other-scheme URLs are refused', () => {
  for (const path of [
    'http://127.0.0.1:3000/api/products',
    'https://example.invalid/api/products',
    'HTTPS://example.invalid/api/products',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/plain,x',
    '//example.invalid/api/products',
  ]) {
    assert.throws(() => assertAllowedEndpoint(path), RequestPolicyError, path);
  }
});

test('malformed paths are refused', () => {
  for (const path of [
    '',
    'api/products',
    '/api/products/../admin',
    '/api/./products',
    '/api\\products',
    '/api/products?id=1',
    '/api/products#top',
    '/api/products/ 1',
  ]) {
    assert.throws(() => assertAllowedEndpoint(path), RequestPolicyError, JSON.stringify(path));
  }
});

test('endpoints not on the allow-list are refused', () => {
  for (const path of [
    '/',
    '/api',
    '/api/products/0',
    '/api/products/01',
    '/api/products/1/edit',
    '/admin',
  ]) {
    assert.throws(
      () => assertAllowedEndpoint(path),
      /not on the allow-list|must not contain/,
      path,
    );
  }
});

test('rejection messages never echo the rejected value', () => {
  const message = rejected('https://synthetic-host.invalid/secret-path');
  assert.ok(message !== undefined);
  assert.doesNotMatch(String(message), /synthetic-host|secret-path/);
});

test('product ids must be positive safe integers', () => {
  assert.equal(productPath(42), '/api/products/42');
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => productPath(id), RequestPolicyError, String(id));
  }
});

test('only an IPv4 loopback address with a real port yields an origin', () => {
  assert.equal(
    loopbackOrigin({ address: '127.0.0.1', family: 'IPv4', port: 53817 }),
    'http://127.0.0.1:53817',
  );
  for (const bound of [
    null,
    '/tmp/stub.sock',
    { address: '0.0.0.0', family: 'IPv4', port: 53817 },
    { address: '::1', family: 'IPv6', port: 53817 },
    { address: '192.168.1.10', family: 'IPv4', port: 53817 },
    { address: '127.0.0.1', family: 'IPv4', port: 0 },
    { address: '127.0.0.1', family: 'IPv4', port: 70000 },
  ]) {
    assert.throws(() => loopbackOrigin(bound), RequestPolicyError, JSON.stringify(bound));
  }
});

test('redirects are never followed and every 3xx is a redirect', () => {
  assert.equal(MAX_REDIRECTS, 0);
  assert.equal(LOOPBACK_ADDRESS, '127.0.0.1');
  for (const status of [300, 301, 302, 303, 307, 308, 399]) {
    assert.equal(isRedirectStatus(status), true, String(status));
  }
  for (const status of [200, 204, 299, 400, 404, 500]) {
    assert.equal(isRedirectStatus(status), false, String(status));
  }
});
