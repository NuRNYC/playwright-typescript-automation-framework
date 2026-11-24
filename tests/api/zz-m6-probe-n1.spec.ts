import { test, expect } from '@/fixtures/test';

// M6 probe N1 only (never merged): one deterministic failure in the
// browser-free `api` project, so exactly one shard fails.
test('m6 probe n1 deliberate failure', () => {
  expect(1 + 1, 'synthetic probe failure').toBe(3);
});
