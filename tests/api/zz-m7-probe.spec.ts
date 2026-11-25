import { test, expect } from '@/fixtures/test';

// M7 probe T5 only (probe branch, never merged): hostile synthetic strings in
// titles and failure messages. The token-shaped value is built at runtime so
// no credential-shaped literal is committed.
const TOKEN = ['ghp', 'M7SENTINEL'.repeat(3) + 'ABCDEF'].join('_');
const HOSTILE = [
  'M7SENTINEL-TITLE',
  '100% %0A%25 newline\nsecond line',
  '::error file=/etc/passwd,line=1::M7SENTINEL-INJECTED',
  '<img src=x onerror=alert(1)> [click](https://example.invalid/M7SENTINEL)',
  '| table | break |',
  '/home/runner/work/../../etc/passwd ../../secret C:\\Windows',
  TOKEN,
].join(' ');

test(`m7 probe t5 ${HOSTILE}`, () => {
  expect(`M7SENTINEL-ACTUAL ${HOSTILE}`, `M7SENTINEL-MESSAGE ${HOSTILE}`).toBe('expected');
});

test(`m7 probe t5 thrown ${HOSTILE}`, () => {
  const fail = (): never => {
    throw new Error(`M7SENTINEL-THROWN ${HOSTILE}`);
  };
  expect(fail).not.toThrow();
});
