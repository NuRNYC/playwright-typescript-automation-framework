/**
 * Contract checks for the README health dry-run workflow (ADR-0013 C5C).
 *
 * Text-level assertions over the committed workflow file: they pin the trust
 * boundary (dispatch-only trigger from `main`, read-only permissions, a
 * pinned checkout without persisted credentials, the token mapped for one
 * step only, no dependency install, no write or publish step). GitHub's own
 * validation runs when the file is pushed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Unit tests run from the repository root (`npm run test:unit`).
const WORKFLOW = readFileSync(resolve('.github/workflows/readme-health-dry-run.yml'), 'utf8');
/** The workflow without comment lines, so prose cannot satisfy a check. */
const CODE = WORKFLOW.split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

test('the only trigger is workflow_dispatch with run id and attempt inputs', () => {
  const on = /^on:\n([\s\S]*?)\n\S/m.exec(CODE)?.[1] ?? '';
  assert.match(on, /^ {2}workflow_dispatch:$/m);
  assert.deepEqual(on.match(/^ {2}[a-z_]+:/gm), ['  workflow_dispatch:']);
  assert.match(on, /^ {6}run_id:$/m);
  assert.match(on, /^ {6}run_attempt:$/m);
  for (const trigger of [
    'workflow_run',
    'pull_request',
    'push:',
    'schedule',
    'repository_dispatch',
  ]) {
    assert.ok(!CODE.includes(trigger), trigger);
  }
});

test('permissions are actions: read and contents: read only, everywhere', () => {
  const grants = CODE.match(/^\s+[a-z-]+: (read|write|none)$/gm) ?? [];
  assert.deepEqual(grants.map((g) => g.trim()).sort(), [
    'actions: read',
    'actions: read',
    'contents: read',
    'contents: read',
  ]);
  assert.ok(!/write/.test(CODE), 'no write permission or write step');
  assert.ok(!CODE.includes('secrets.'), 'no stored secret');
});

test('execution is restricted to main and the checkout is pinned without credentials', () => {
  assert.match(
    CODE,
    /if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' \}\}/,
  );
  assert.match(CODE, /ref: \$\{\{ github\.sha \}\}\n\s+persist-credentials: false/);
  assert.equal((CODE.match(/uses: actions\/checkout@/g) ?? []).length, 1);
  assert.ok(!/npm (ci|install)|yarn|pnpm/.test(CODE), 'no dependency installation');
});

test('the token is mapped once, for the evaluate step only, to the documented variable', () => {
  const mappings = CODE.match(/\$\{\{ github\.token \}\}/g) ?? [];
  assert.equal(mappings.length, 1);
  assert.match(
    CODE,
    /- id: evaluate[\s\S]*?QUALITY_VERDICT_GITHUB_TOKEN: \$\{\{ github\.token \}\}/,
  );
  const evaluate = /- id: evaluate[\s\S]*?(?=\n {6}- )/.exec(CODE)?.[0] ?? '';
  assert.ok(evaluate.includes('scripts/readme-health-dry-run.ts'));
  assert.ok(!/GITHUB_TOKEN:|GH_TOKEN/.test(CODE.replace('QUALITY_VERDICT_GITHUB_TOKEN', '')));
});

test('inputs reach the shell through the environment, never by interpolation', () => {
  const runBlocks = CODE.match(/run: \|[\s\S]*?(?=\n {6}(- |[a-z-]+:))/g) ?? [];
  assert.ok(runBlocks.length >= 3);
  for (const block of runBlocks) assert.ok(!block.includes('${{'), block.slice(0, 60));
  assert.match(CODE, /RUN_ID: \$\{\{ inputs\.run_id \}\}/);
  assert.match(CODE, /RUN_ATTEMPT: \$\{\{ inputs\.run_attempt \}\}/);
});

test('every job and step is time-bounded and only the aggregate report is uploaded', () => {
  assert.match(CODE, /^ {4}timeout-minutes: \d+$/m);
  const steps = CODE.split(/\n {6}- /).slice(1);
  for (const step of steps) assert.match(step, /timeout-minutes: \d+/, step.slice(0, 60));
  assert.equal((CODE.match(/uses: actions\/upload-artifact@/g) ?? []).length, 1);
  assert.match(CODE, /path: \$\{\{ runner\.temp \}\}\/readme-health-dry-run\/report\.json\n/);
  assert.match(CODE, /retention-days: 3/);
  assert.ok(!/gh (pr|api -X|release)|git (push|commit)/.test(CODE), 'no write command');
});
