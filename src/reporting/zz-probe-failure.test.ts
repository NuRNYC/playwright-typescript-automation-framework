import { test } from 'node:test';
import assert from 'node:assert/strict';

test('probe: intentional unit failure', () => {
  assert.fail('probe');
});
