/**
 * Unit tests for the API response contract (ADR-0006).
 *
 * Same conventions as the other `node:test` suites (ADR-0002): explicit
 * `.ts` import, plain literals, no network. Data is synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseJson, parseProduct, parseProductList } from './contract.ts';

const PRODUCT = { id: 1, name: 'Synthetic Widget', priceCents: 1299 };

test('a valid product is accepted and returned with only contract fields', () => {
  assert.deepEqual(parseProduct(PRODUCT), { ok: true, value: PRODUCT });
});

test('extra fields are tolerated but dropped from the parsed value', () => {
  const parsed = parseProduct({ ...PRODUCT, internalFlag: true, nested: { a: 1 } });
  assert.deepEqual(parsed, { ok: true, value: PRODUCT });
});

test('a missing required field is rejected with its field path', () => {
  for (const field of ['id', 'name', 'priceCents'] as const) {
    const { [field]: _omitted, ...rest } = PRODUCT;
    const parsed = parseProduct(rest);
    assert.equal(parsed.ok, false, field);
    assert.match(parsed.ok ? '' : parsed.problem, new RegExp(`^product\\.${field} `), field);
  }
});

test('incorrect field types and out-of-range values are rejected', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...PRODUCT, id: '1' }, /\.id must be a positive integer/],
    [{ ...PRODUCT, id: 0 }, /\.id must be a positive integer/],
    [{ ...PRODUCT, id: 1.5 }, /\.id must be a positive integer/],
    [{ ...PRODUCT, name: 7 }, /\.name must be a non-empty string/],
    [{ ...PRODUCT, name: '  ' }, /\.name must be a non-empty string/],
    [{ ...PRODUCT, priceCents: -1 }, /\.priceCents must be a non-negative integer/],
    [{ ...PRODUCT, priceCents: '1299' }, /\.priceCents must be a non-negative integer/],
  ];
  for (const [input, problem] of cases) {
    const parsed = parseProduct(input);
    assert.match(parsed.ok ? '' : parsed.problem, problem, JSON.stringify(input));
  }
});

test('null and non-object products are rejected', () => {
  for (const input of [null, undefined, 42, 'product', [PRODUCT]]) {
    assert.deepEqual(parseProduct(input), { ok: false, problem: 'product must be an object' });
  }
});

test('a valid product list is accepted, including an empty list', () => {
  const second = { id: 2, name: 'Synthetic Gadget', priceCents: 2499 };
  assert.deepEqual(parseProductList([PRODUCT, second]), { ok: true, value: [PRODUCT, second] });
  assert.deepEqual(parseProductList([]), { ok: true, value: [] });
});

test('invalid list shapes are rejected', () => {
  for (const input of [null, {}, PRODUCT, 'list', 3]) {
    assert.deepEqual(parseProductList(input), {
      ok: false,
      problem: 'product list must be an array',
    });
  }
});

test('one invalid element rejects the whole list and names its index', () => {
  const parsed = parseProductList([PRODUCT, { ...PRODUCT, priceCents: null }]);
  assert.deepEqual(parsed, { ok: false, problem: '[1].priceCents must be a non-negative integer' });
  assert.deepEqual(parseProductList([PRODUCT, null]), {
    ok: false,
    problem: '[1] must be an object',
  });
});

test('malformed JSON is a typed failure, distinct from an invalid structure', () => {
  assert.deepEqual(parseJson('{"id": 901, "name": '), {
    ok: false,
    problem: 'response body is not valid JSON',
  });
  assert.deepEqual(parseJson('{"id": "x"}'), { ok: true, value: { id: 'x' } });
});

test('problems name the field, never the offending value', () => {
  const parsed = parseProduct({ ...PRODUCT, name: { secret: 'synthetic-sensitive-value' } });
  assert.equal(parsed.ok, false);
  assert.doesNotMatch(parsed.ok ? '' : parsed.problem, /synthetic-sensitive-value/);
});
