import { test, expect } from '@/fixtures/test';

// M7 probe T1 only (probe branch, never merged): one deterministic failure.
test('m7 probe t1 deterministic failure', () => {
  expect('synthetic-actual-t1', 'synthetic t1 assertion context').toBe('synthetic-expected-t1');
});
