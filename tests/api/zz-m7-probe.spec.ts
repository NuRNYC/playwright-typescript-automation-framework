import { test } from '@/fixtures/test';

// M7 probe T3 only (probe branch, never merged): a bounded synthetic timeout.
test('m7 probe t3 bounded timeout', async () => {
  test.setTimeout(1_000);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
});
