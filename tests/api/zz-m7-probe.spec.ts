import { test, expect } from '@/fixtures/test';

// M7 probe T8 only (probe branch, never merged): 12 failing and 12 flaky tests,
// one per line, to exercise the 10-per-level annotation caps.
test('m7 probe t8 failing 01', () => expect(1, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 failing 02', () => expect(2, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 failing 03', () => expect(3, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 failing 04', () => expect(4, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 failing 05', () => expect(5, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 failing 06', () => expect(6, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 failing 07', () => expect(7, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 failing 08', () => expect(8, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 failing 09', () => expect(9, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 failing 10', () => expect(10, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 failing 11', () => expect(11, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 failing 12', () => expect(12, 'synthetic t8 failure').toBe(0));

test('m7 probe t8 flaky 01', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));

test('m7 probe t8 flaky 02', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));

test('m7 probe t8 flaky 03', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));

test('m7 probe t8 flaky 04', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));

test('m7 probe t8 flaky 05', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));

test('m7 probe t8 flaky 06', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));

test('m7 probe t8 flaky 07', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));

test('m7 probe t8 flaky 08', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));

test('m7 probe t8 flaky 09', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));

test('m7 probe t8 flaky 10', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));

test('m7 probe t8 flaky 11', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));

test('m7 probe t8 flaky 12', () =>
  expect(test.info().retry, 'synthetic t8 first attempt').toBeGreaterThan(0));
