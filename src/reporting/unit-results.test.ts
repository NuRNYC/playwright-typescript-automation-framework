/**
 * Tests for structured unit results (ADR-0012 amendment, Phase C2): the
 * strict parser, stamping, and executable probes of the custom reporter
 * against synthetic `node:test` files in a temporary directory.
 *
 * The probes establish reporter semantics for the pinned Node.js version
 * only; the version tripwire below fails when Node.js changes, so the
 * probes must be reviewed before the semantics are relied on again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANARY } from './fixtures.ts';
import { CANCELLATION_VERIFIED_NODE_VERSIONS } from './test-health.ts';
import {
  MAX_UNIT_RESULTS_BYTES,
  UnitTally,
  parseUnitResults,
  parseUnitResultsDocument,
  serializeUnitResults,
  stampUnitResults,
  type UnitResultsDocument,
} from './unit-results.ts';

const REPORTER = join(process.cwd(), 'scripts', 'unit-test-reporter.ts');
const SHA = 'a'.repeat(40);
const IDENTITY = { runId: 1_000_001, runAttempt: 1, sourceSha: SHA };

function doc(overrides: Partial<UnitResultsDocument> = {}): UnitResultsDocument {
  const counts = { tests: 5, passed: 3, failed: 1, cancelled: 0, skipped: 1, todo: 0, suites: 1 };
  return {
    kind: 'unit-test-results',
    schemaVersion: '1.0.0',
    nodeVersion: 'v24.22.3',
    success: false,
    counts,
    events: counts,
    execution: { startedAt: '2026-11-28T00:00:00.000Z', finishedAt: '2026-11-28T00:00:01.000Z' },
    provenance: null,
    ...overrides,
  };
}

function text(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'unit-results-')));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `node --test` with the spec reporter and the structured reporter. */
function runReporter(dir: string, files: readonly string[]) {
  const out = join(dir, 'unit-results.json');
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      `--test-reporter=${REPORTER}`,
      `--test-reporter-destination=${out}`,
      ...files,
    ],
    // A minimal environment: no inherited NODE_TEST_CONTEXT from this runner.
    { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 },
  );
  return { status: result.status, stdout: result.stdout, output: readFileSync(out, 'utf8') };
}

/* ------------------------------------------------------------------ *
 * Strict parser
 * ------------------------------------------------------------------ */

test('a valid document round-trips through the strict parser', () => {
  const parsed = parseUnitResultsDocument(serializeUnitResults(doc()));
  assert.deepEqual(parsed, { ok: true, document: doc() });
  assert.equal(serializeUnitResults(doc()), serializeUnitResults(doc()));
  assert.deepEqual(Object.keys(JSON.parse(serializeUnitResults(doc())) as object), [
    'kind',
    'schemaVersion',
    'nodeVersion',
    'success',
    'counts',
    'events',
    'execution',
    'provenance',
  ]);
});

test('empty output is incomplete evidence, never a successful zero-test run', () => {
  for (const empty of ['', '\n', '   ']) {
    assert.deepEqual(parseUnitResults(empty), {
      kind: 'unavailable',
      reason: 'unit-results-incomplete',
    });
  }
});

test('malformed, oversized and schema-violating documents are invalid', () => {
  const base = JSON.parse(serializeUnitResults(doc())) as Record<string, unknown>;
  const counts = base.counts as Record<string, unknown>;
  const cases: unknown[] = [
    '{not json',
    `${' '.repeat(MAX_UNIT_RESULTS_BYTES)}{}`,
    [],
    null,
    { ...base, extra: CANARY },
    { ...base, counts: { ...counts, extra: 1 } },
    { ...base, kind: 'other' },
    { ...base, schemaVersion: '2.0.0' },
    { ...base, nodeVersion: 'node-24' },
    { ...base, success: 'false' },
    { ...base, counts: { ...counts, failed: -1 } },
    { ...base, counts: { ...counts, failed: 1.5 } },
    { ...base, counts: { ...counts, failed: '1' } },
    { ...base, counts: { ...counts, tests: Number.MAX_SAFE_INTEGER + 2 } },
    {
      ...base,
      execution: { startedAt: '2026-11-28T00:00:01.000Z', finishedAt: '2026-11-28T00:00:00.000Z' },
    },
    { ...base, execution: { startedAt: 'yesterday', finishedAt: '2026-11-28T00:00:00.000Z' } },
    { ...base, provenance: { mode: 'ci', ...IDENTITY, sourceSha: 'A'.repeat(40) } },
    { ...base, provenance: { mode: 'local' } },
    Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'events')),
  ];
  for (const value of cases) {
    const input = typeof value === 'string' ? value : text(value);
    assert.deepEqual(
      parseUnitResults(input),
      { kind: 'unavailable', reason: 'unit-results-invalid' },
      input.slice(0, 80),
    );
  }
  const equal = doc({
    execution: { startedAt: '2026-11-28T00:00:00.000Z', finishedAt: '2026-11-28T00:00:00.000Z' },
  });
  assert.equal(parseUnitResultsDocument(serializeUnitResults(equal)).ok, true);
});

test('event tallies or a success flag that disagree with the counts are inconsistent', () => {
  const counts = doc().counts;
  for (const bad of [
    doc({ events: { ...counts, passed: counts.passed - 1, failed: counts.failed + 1 } }),
    doc({ events: { ...counts, suites: 0 } }),
    doc({ success: true }),
    doc({
      success: false,
      counts: { ...counts, passed: 4, failed: 0 },
      events: { ...counts, passed: 4, failed: 0 },
    }),
  ]) {
    assert.deepEqual(parseUnitResults(serializeUnitResults(bad)), {
      kind: 'unavailable',
      reason: 'unit-results-inconsistent',
    });
  }
});

test('counts that do not reconcile are inconsistent even when the tallies match them', () => {
  const unreconciled = {
    tests: 6,
    passed: 3,
    failed: 1,
    cancelled: 0,
    skipped: 1,
    todo: 0,
    suites: 1,
  };
  assert.deepEqual(
    parseUnitResults(serializeUnitResults(doc({ counts: unreconciled, events: unreconciled }))),
    { kind: 'unavailable', reason: 'unit-results-inconsistent' },
  );
  const big = Number.MAX_SAFE_INTEGER;
  const overflow = {
    tests: big,
    passed: big,
    failed: 1,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    suites: 0,
  };
  assert.deepEqual(
    parseUnitResults(
      serializeUnitResults(doc({ success: false, counts: overflow, events: overflow })),
    ),
    { kind: 'unavailable', reason: 'unit-results-inconsistent' },
  );
});

test('a completed failing run is valid evidence of its failures', () => {
  const parsed = parseUnitResults(serializeUnitResults(doc()));
  assert.equal(parsed.kind, 'unit-results');
  if (parsed.kind !== 'unit-results') return;
  assert.equal(parsed.counts.failed, 1);
  assert.deepEqual(parsed.provenance, { mode: 'local' });
  assert.deepEqual(Object.keys(parsed).sort(), [
    'counts',
    'execution',
    'kind',
    'nodeVersion',
    'provenance',
  ]);
});

/* ------------------------------------------------------------------ *
 * Stamping
 * ------------------------------------------------------------------ */

test('stamping records the supplied identity once and never relabels', () => {
  const stamped = stampUnitResults(serializeUnitResults(doc()), IDENTITY);
  assert.equal(stamped.ok, true);
  if (!stamped.ok) return;
  const parsed = parseUnitResults(stamped.text);
  assert.ok(parsed.kind === 'unit-results');
  assert.deepEqual(parsed.provenance, { mode: 'ci', ...IDENTITY });
  assert.deepEqual(stampUnitResults(stamped.text, IDENTITY), {
    ok: false,
    reason: 'already-stamped',
  });
  assert.deepEqual(stampUnitResults(stamped.text, { ...IDENTITY, runAttempt: 2 }), {
    ok: false,
    reason: 'already-stamped',
  });
  assert.deepEqual(stampUnitResults('', IDENTITY), {
    ok: false,
    reason: 'unit-results-incomplete',
  });
  for (const bad of [
    { ...IDENTITY, runId: 0 },
    { ...IDENTITY, runAttempt: 1.5 },
    { ...IDENTITY, sourceSha: 'abc' },
  ]) {
    assert.deepEqual(stampUnitResults(serializeUnitResults(doc()), bad), {
      ok: false,
      reason: 'invalid-identity',
    });
  }
});

/* ------------------------------------------------------------------ *
 * Tally
 * ------------------------------------------------------------------ */

test('the tally reads only allow-listed fields and needs exactly one run summary', () => {
  const meta = {
    nodeVersion: 'v24.22.3',
    startedAt: '2026-11-28T00:00:00.000Z',
    finishedAt: '2026-11-28T00:00:01.000Z',
  };
  const summary = {
    type: 'test:summary',
    data: {
      counts: {
        tests: 1,
        passed: 1,
        failed: 0,
        cancelled: 0,
        skipped: 0,
        todo: 0,
        suites: 0,
        topLevel: 1,
      },
      success: true,
      [CANARY]: CANARY,
    },
  };
  const pass = {
    type: 'test:pass',
    data: { name: CANARY, file: `/home/${CANARY}.ts`, details: { type: 'test', duration_ms: 1 } },
  };
  const tally = new UnitTally();
  for (const ev of [
    pass,
    { type: 'test:summary', data: { ...summary.data, file: 'x' } },
    summary,
  ]) {
    tally.add(ev);
  }
  const finished = tally.finish(meta);
  assert.ok(finished !== undefined);
  const out = serializeUnitResults(finished);
  assert.equal(out.includes(CANARY), false);
  assert.equal(out.includes('/home/'), false);
  assert.equal(parseUnitResultsDocument(out).ok, true);

  assert.equal(new UnitTally().finish(meta), undefined);
  const twice = new UnitTally();
  twice.add(summary);
  twice.add(summary);
  assert.equal(twice.finish(meta), undefined);
});

/* ------------------------------------------------------------------ *
 * Reporter probes (pinned Node.js version)
 * ------------------------------------------------------------------ */

test('probes run on a Node.js version whose cancellation semantics were verified', () => {
  assert.ok(
    CANCELLATION_VERIFIED_NODE_VERSIONS.includes(process.version),
    `re-probe reporter semantics for ${process.version}`,
  );
});

test('reporter probe: every outcome is counted as observed, and failure status is kept', () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, 'mixed.test.mjs'),
      `import { test, describe } from 'node:test';
test('${CANARY} pass', () => {});
test('fail', () => { throw new Error('${CANARY} /home/someone/secret'); });
test('skip', { skip: true }, () => {});
test('todo', { todo: true }, () => {});
test('todo failing', { todo: true }, () => { throw new Error('x'); });
test('parent', async (t) => { await t.test('sub a', () => {}); await t.test('sub b', () => {}); });
describe('suite', () => { test('in suite', () => {}); });
for (const n of [1, 2]) test('generated ' + n, () => {});
test('timeout', { timeout: 50 }, async () => { await new Promise((r) => setTimeout(r, 400)); });
test('parent timeout', { timeout: 50 }, async (t) => {
  t.test('child cancelled', async () => { await new Promise((r) => setTimeout(r, 400)); });
  await new Promise((r) => setTimeout(r, 200));
});
`,
    );
    const run = runReporter(dir, ['mixed.test.mjs']);
    // The test command's own failure status is preserved.
    assert.equal(run.status, 1);
    assert.match(run.stdout, /✖ fail/);
    const parsed = parseUnitResultsDocument(run.output);
    assert.equal(parsed.ok, true, run.output);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.document.counts, {
      tests: 14,
      passed: 7,
      failed: 1,
      cancelled: 3,
      skipped: 1,
      todo: 2,
      suites: 1,
    });
    assert.equal(parsed.document.success, false);
    assert.equal(parsed.document.nodeVersion, process.version);
    assert.equal(parsed.document.provenance, null);
    // Aggregate-only: no titles, error messages or paths.
    for (const forbidden of [
      CANARY,
      '/home/',
      dir,
      'generated',
      'in suite',
      'sub a',
      'child cancelled',
    ]) {
      assert.equal(run.output.includes(forbidden), false, forbidden);
    }
  });
});

test('reporter probe: a passing run exits zero with consistent counts', () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, 'ok.test.mjs'),
      `import { test } from 'node:test';\ntest('a', () => {});\ntest('b', () => {});\n`,
    );
    const run = runReporter(dir, ['ok.test.mjs']);
    assert.equal(run.status, 0);
    const parsed = parseUnitResults(run.output);
    assert.ok(parsed.kind === 'unit-results');
    assert.equal(parsed.counts.tests, 2);
    assert.equal(parsed.counts.passed, 2);
  });
});

test('reporter probe: an interrupted run leaves no stale or partial result', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'unit-results-')));
  try {
    writeFileSync(
      join(dir, 'slow.test.mjs'),
      `import { test } from 'node:test';\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 20000)); });\n`,
    );
    const out = join(dir, 'unit-results.json');
    // A previous run's valid-looking result must not survive.
    writeFileSync(
      out,
      serializeUnitResults(
        doc({
          success: true,
          counts: { ...doc().counts, failed: 0, passed: 4 },
          events: { ...doc().counts, failed: 0, passed: 4 },
        }),
      ),
    );
    const status = await new Promise<number | null>((done) => {
      const child = spawn(
        process.execPath,
        [
          '--test',
          `--test-reporter=${REPORTER}`,
          `--test-reporter-destination=${out}`,
          'slow.test.mjs',
        ],
        { cwd: dir, env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' },
      );
      setTimeout(() => child.kill('SIGINT'), 1500);
      child.on('close', (code) => done(code));
    });
    assert.notEqual(status, 0);
    const output = readFileSync(out, 'utf8');
    assert.equal(output, '');
    assert.deepEqual(parseUnitResults(output), {
      kind: 'unavailable',
      reason: 'unit-results-incomplete',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
