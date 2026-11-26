import { test, expect } from '@/fixtures/test';

/**
 * TEMPORARY NEGATIVE PROBE (M8D P1). Never merged.
 *
 * Fails on purpose in the browser-free `api` project so CI exercises its
 * retries and the advisory quality summary. The canary is synthetic and
 * built at runtime; it must never appear in quality-summary.json.
 */
const CANARY = ['m8d', 'probe', 'canary', 'SYNTHETIC'.repeat(2), '4c1e'].join('-');

test(`probe m8d synthetic title marker ${CANARY}`, () => {
  console.log(`synthetic stdout ${CANARY}`);
  test.info().annotations.push({ type: 'probe', description: CANARY });
  expect(CANARY, `synthetic error ${CANARY}`).toBe('deliberately-different');
});
