import { test, expect } from '@/fixtures/test';

// M7 probe T2 only (probe branch, never merged): fails on the first attempt
// only, so CI retries make it flaky.
test('m7 probe t2 flaky on first attempt', () => {
  expect(test.info().retry, 'synthetic t2 first-attempt failure').toBeGreaterThan(0);
});
