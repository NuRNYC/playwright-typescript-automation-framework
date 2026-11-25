/**
 * Unit tests for the quality-summary normalizer (ADR-0009, M8A).
 *
 * Same conventions as the other unit tests (ADR-0002): Node's built-in
 * runner, explicit `.ts` imports, plain-object inputs. Every report is
 * synthetic (see `fixtures.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CI_VERDICT,
  GATE_INPUT_NAMES,
  LIMITS,
  SCHEMA_VERSION,
  branchClass,
  evaluateExecution,
  gateInputState,
  invariantViolations,
  normalize,
  serialize,
  validateRunContext,
  type InstanceRecord,
  type QualitySummary,
} from './quality-summary.ts';
import {
  CANARY,
  DEFAULT_PROJECTS,
  attempt,
  canaryReport,
  context,
  contextInput,
  deepFreeze,
  passing,
  reorderKeys,
  report,
  spec,
  testEntry,
  twelveEighteenNineteen,
} from './fixtures.ts';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function run(reportValue: unknown, overrides: Record<string, unknown> = {}): QualitySummary {
  return normalize(reportValue, context(overrides));
}

function only(summary: QualitySummary): InstanceRecord {
  assert.equal(summary.instances.length, 1, 'expected exactly one instance');
  const [instance] = summary.instances;
  assert.ok(instance);
  return instance;
}

function single(
  project: string,
  status: string,
  results: ReturnType<typeof attempt>[],
  expected = 'passed',
): QualitySummary {
  return run(
    report([
      spec('ui/login.spec.ts', 15, 'synthetic', [testEntry(project, status, results, expected)]),
    ]),
  );
}

function assertAvailable(summary: QualitySummary): void {
  assert.equal(summary.testData.state, 'available');
  assert.deepEqual(invariantViolations(summary), []);
}

function assertUnavailable(summary: QualitySummary, reason: string): void {
  assert.deepEqual(summary.testData, { state: 'unavailable', reason });
  assert.equal(summary.completeness, null);
  assert.equal(summary.totals, null);
  assert.deepEqual(summary.instances, []);
  assert.deepEqual(summary.projects, []);
  assert.equal(summary.ciVerdict, CI_VERDICT);
}

/** Every key the output may contain, at any depth. Anything else is a leak. */
const ALLOWED_OUTPUT_KEYS = new Set([
  'schemaVersion',
  'generator',
  'name',
  'version',
  'run',
  'runId',
  'runAttempt',
  'event',
  'headSha',
  'branchClass',
  'classification',
  'generatedAt',
  'ciVerdict',
  'observedGateInputs',
  ...GATE_INPUT_NAMES,
  'testData',
  'state',
  'reason',
  'completeness',
  'unrecognizedProjectExecutions',
  'unresolvedIdentities',
  'ambiguousIdentities',
  'inconsistentExecutions',
  'provisionalOutcomes',
  'unclassifiedAttempts',
  'invalidDurations',
  'invalidRetries',
  'droppedTags',
  'statsCrossCheck',
  'omissionDetection',
  'shardAttribution',
  'projects',
  'kind',
  'browser',
  'repeatEach',
  'instances',
  'instanceId',
  'definitionId',
  'project',
  'file',
  'line',
  'column',
  'locationGroupSize',
  'tags',
  'identity',
  'multiplicity',
  'outcome',
  'outcomeCertainty',
  'conflict',
  'executionOutcomes',
  'executions',
  'reportedStatus',
  'consistent',
  'attempts',
  'retry',
  'status',
  'durationMs',
  'totals',
  'definitions',
  'zeroAttemptExecutions',
  'retries',
  'byInstanceOutcome',
  'byExecutionOutcome',
  // Outcome-count map keys.
  'failed',
  'timed-out',
  'interrupted',
  'unexpected-pass',
  'unclassified',
  'flaky',
  'did-not-run',
  'expected-failure',
  'skipped',
  'passed',
]);

function unexpectedKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => unexpectedKeys(v, `${path}[${i}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(ALLOWED_OUTPUT_KEYS.has(k) ? [] : [`${path}.${k}`]),
      ...unexpectedKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * Run context and gate inputs
 * ------------------------------------------------------------------ */

test('a valid context is accepted and the raw branch name is not kept', () => {
  const result = validateRunContext(contextInput({ branch: `feature/${CANARY}` }));
  assert.ok(result.ok);
  assert.equal(result.context.run.branchClass, 'other');
  assert.ok(!JSON.stringify(result.context).includes(CANARY));
});

const SYNTHETIC_UPPER = 'A'.repeat(40);

test('invalid context fields are refused with a fixed problem code', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ runId: 0 }, 'run-id'],
    [{ runId: 1.5 }, 'run-id'],
    [{ runAttempt: 0 }, 'run-attempt'],
    [{ headSha: 'ABC' }, 'head-sha'],
    [{ headSha: SYNTHETIC_UPPER }, 'head-sha'],
    [{ generatedAt: '25/11/2026' }, 'generated-at'],
    [{ reportState: 'whatever' }, 'report-state'],
    [{ gateInputs: 'success' }, 'gate-inputs'],
  ];
  for (const [override, problem] of cases) {
    assert.deepEqual(validateRunContext(contextInput(override)), { ok: false, problem });
  }
  assert.deepEqual(validateRunContext(null), { ok: false, problem: 'context-shape' });
});

test('gate inputs distinguish unavailable from unknown values', () => {
  assert.equal(gateInputState('success'), 'success');
  assert.equal(gateInputState('cancelled'), 'cancelled');
  assert.equal(gateInputState(''), 'unavailable');
  assert.equal(gateInputState(undefined), 'unavailable');
  assert.equal(gateInputState('neutral'), 'unknown');
  assert.equal(gateInputState(1), 'unknown');
  const result = validateRunContext(
    contextInput({ gateInputs: { CHECKS: 'success', MERGE: '', VERIFY: 'weird', NINTH: 'x' } }),
  );
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.context.observedGateInputs), [...GATE_INPUT_NAMES]);
  assert.equal(result.context.observedGateInputs.MERGE, 'unavailable');
  assert.equal(result.context.observedGateInputs.VERIFY, 'unknown');
  assert.equal(result.context.observedGateInputs.UPLOAD, 'unavailable');
});

test('branches are classified, probes are labelled, and nothing raw is emitted', () => {
  assert.equal(branchClass('push', 'main'), 'main');
  assert.equal(branchClass('pull_request', 'feat/x'), 'pull-request');
  assert.equal(branchClass('pull_request', 'probe/m6-ci-failure-paths'), 'probe');
  assert.equal(branchClass('push', 'release'), 'other');
  assert.equal(branchClass('push', ''), 'unknown');
  assert.equal(branchClass('push', undefined), 'unknown');
  const probe = run(twelveEighteenNineteen(), {
    branch: 'probe/m7-triage-paths',
    event: 'pull_request',
  });
  assert.equal(probe.run.classification, 'intentional-probe');
  const unknown = run(twelveEighteenNineteen(), { branch: undefined });
  assert.equal(unknown.run.classification, 'unknown');
  assert.equal(run(twelveEighteenNineteen()).run.classification, 'ordinary');
});

test('the summary never records a CI verdict, even when every input succeeded', () => {
  const summary = run(twelveEighteenNineteen());
  assert.equal(summary.ciVerdict, 'not-recorded-in-summary');
  assert.equal(summary.schemaVersion, SCHEMA_VERSION);
  assert.ok(!('verdict' in summary));
});

/* ------------------------------------------------------------------ *
 * Unavailable paths
 * ------------------------------------------------------------------ */

test('a report reported missing or unreadable by the CLI is unavailable without reading it', () => {
  for (const state of [
    'report-missing',
    'report-unreadable',
    'report-invalid-json',
    'report-too-large',
  ]) {
    assertUnavailable(run(twelveEighteenNineteen(), { reportState: state }), state);
  }
});

test('unsuccessful verification or merge yields an unavailable summary with observed inputs', () => {
  const gates = Object.fromEntries(GATE_INPUT_NAMES.map((n) => [n, 'success']));
  const merge = run(twelveEighteenNineteen(), { gateInputs: { ...gates, MERGE: 'failure' } });
  assertUnavailable(merge, 'merge-not-successful');
  assert.equal(merge.observedGateInputs.MERGE, 'failure');
  const verify = run(twelveEighteenNineteen(), { gateInputs: { ...gates, VERIFY: 'skipped' } });
  assertUnavailable(verify, 'verification-not-successful');
  const missing = run(twelveEighteenNineteen(), { gateInputs: { ...gates, MERGE: '' } });
  assertUnavailable(missing, 'merge-not-successful');
});

test('an invalid report shape is unavailable', () => {
  for (const value of [
    null,
    [],
    'report',
    42,
    { suites: 'x' },
    { suites: [{ specs: 'x' }] },
    { suites: [{ specs: [{ tests: 'x' }] }] },
    { suites: [{ specs: [{ tests: [{ results: 'x' }] }] }] },
    { suites: [{ specs: [{ tests: [{ results: [7] }] }] }] },
  ]) {
    assertUnavailable(run(value), 'report-invalid-shape');
  }
});

test('an empty report is not evidence that nothing failed', () => {
  assertUnavailable(run({ suites: [] }), 'report-empty');
  assertUnavailable(run(report([])), 'report-empty');
});

test('excessive nesting is refused', () => {
  let suites: unknown[] = [{ specs: [spec('ui/a.spec.ts', 1, 't', [passing('chromium')])] }];
  for (let i = 0; i <= LIMITS.maxSuiteDepth; i++) {
    suites = [{ specs: [], suites }];
  }
  assertUnavailable(run({ suites }), 'report-invalid-shape');
});

test('too many executions or attempts are refused, never truncated', () => {
  const many = Array.from({ length: LIMITS.maxExecutions + 1 }, () => passing('api'));
  assertUnavailable(run(report([spec('api/products.spec.ts', 13, 't', many)])), 'report-too-large');
  const attempts = Array.from({ length: LIMITS.maxAttemptsPerExecution + 1 }, (_, i) =>
    attempt('failed', i),
  );
  assertUnavailable(single('chromium', 'unexpected', attempts), 'report-too-large');
});

test('an output larger than the limit is unavailable', () => {
  const tenAttempts = Array.from({ length: LIMITS.maxAttemptsPerExecution }, (_, i) =>
    attempt(i === LIMITS.maxAttemptsPerExecution - 1 ? 'passed' : 'failed', i),
  );
  const specs = Array.from({ length: LIMITS.maxExecutions }, (_, i) =>
    spec('api/products.spec.ts', i + 1, `t${i}`, [testEntry('api', 'flaky', tenAttempts)]),
  );
  assertUnavailable(run(report(specs)), 'output-too-large');
});

/* ------------------------------------------------------------------ *
 * Outcomes and retries
 * ------------------------------------------------------------------ */

test('a passing test', () => {
  const s = single('chromium', 'expected', [attempt('passed')]);
  assertAvailable(s);
  const i = only(s);
  assert.equal(i.outcome, 'passed');
  assert.equal(i.outcomeCertainty, 'established');
  assert.deepEqual(i.executions[0]?.attempts, [{ retry: 0, status: 'passed', durationMs: 25 }]);
  assert.equal(s.totals?.retries, 0);
});

test('a failed test, and a test failing on every retry', () => {
  assert.equal(only(single('chromium', 'unexpected', [attempt('failed')])).outcome, 'failed');
  const s = single('chromium', 'unexpected', [
    attempt('failed', 0),
    attempt('failed', 1),
    attempt('failed', 2),
  ]);
  assertAvailable(s);
  assert.equal(only(s).outcome, 'failed');
  assert.equal(s.totals?.attempts, 3);
  assert.equal(s.totals?.retries, 2);
  assert.equal(s.totals?.executions, 1);
});

test('failed then passed is flaky, with both attempts preserved', () => {
  const s = single('chromium', 'flaky', [attempt('failed', 0), attempt('passed', 1)]);
  assertAvailable(s);
  const i = only(s);
  assert.equal(i.outcome, 'flaky');
  assert.deepEqual(
    i.executions[0]?.attempts.map((a) => a.status),
    ['failed', 'passed'],
  );
  assert.equal(s.totals?.retries, 1);
});

test('a timed-out attempt is distinct from an interrupted one', () => {
  const timedOut = only(single('chromium', 'unexpected', [attempt('timedOut')]));
  assert.equal(timedOut.outcome, 'timed-out');
  // Playwright reports an interrupted-only test as `skipped` at test level.
  const interrupted = only(single('chromium', 'skipped', [attempt('interrupted')]));
  assert.equal(interrupted.outcome, 'interrupted');
  assert.equal(interrupted.outcomeCertainty, 'established');
  assert.equal(interrupted.executions[0]?.reportedStatus, 'skipped');
  assert.equal(interrupted.executions[0]?.consistent, true);
});

test('failed then interrupted keeps the earlier failure and marks the outcome provisional', () => {
  const s = single('chromium', 'unexpected', [attempt('failed', 0), attempt('interrupted', 1)]);
  assertAvailable(s);
  const i = only(s);
  assert.equal(i.outcome, 'interrupted');
  assert.equal(i.outcomeCertainty, 'provisional');
  assert.deepEqual(
    i.executions[0]?.attempts.map((a) => a.status),
    ['failed', 'interrupted'],
  );
  assert.equal(s.completeness?.provisionalOutcomes, 1);
  // The same through the exported evaluator.
  const evaluation = evaluateExecution(
    [
      { retry: 0, status: 'timedOut', durationMs: 1 },
      { retry: 1, status: 'interrupted', durationMs: 1 },
    ],
    'passed',
    'unexpected',
  );
  assert.deepEqual(evaluation, {
    outcome: 'interrupted',
    certainty: 'provisional',
    consistent: true,
  });
});

test('expected failure and unexpected pass', () => {
  assert.equal(
    only(single('chromium', 'expected', [attempt('failed')], 'failed')).outcome,
    'expected-failure',
  );
  assert.equal(
    only(single('chromium', 'unexpected', [attempt('passed')], 'failed')).outcome,
    'unexpected-pass',
  );
});

test('skipped is distinct from did-not-run', () => {
  assert.equal(
    only(single('chromium', 'skipped', [attempt('skipped')], 'skipped')).outcome,
    'skipped',
  );
  const noAttempts = single('firefox-authenticated', 'skipped', []);
  assertAvailable(noAttempts);
  assert.equal(only(noAttempts).outcome, 'did-not-run');
  assert.equal(noAttempts.totals?.zeroAttemptExecutions, 1);
  assert.equal(
    only(single('chromium', 'skipped', [attempt('skipped')], 'passed')).outcome,
    'did-not-run',
  );
});

test('unknown attempt and test statuses are unclassified and counted, not guessed', () => {
  const badAttempt = single('chromium', 'unexpected', [attempt('exploded')]);
  assertAvailable(badAttempt);
  assert.equal(only(badAttempt).outcome, 'unclassified');
  assert.equal(only(badAttempt).executions[0]?.attempts[0]?.status, 'unclassified');
  assert.equal(badAttempt.completeness?.unclassifiedAttempts, 1);
  const badStatus = single('chromium', 'weird', [attempt('passed')]);
  assert.equal(only(badStatus).outcome, 'unclassified');
  assert.equal(only(badStatus).executions[0]?.reportedStatus, 'invalid');
  assert.equal(badStatus.completeness?.inconsistentExecutions, 1);
  const contradiction = single('chromium', 'expected', [attempt('failed')]);
  assert.equal(only(contradiction).outcome, 'unclassified');
  assert.equal(contradiction.completeness?.inconsistentExecutions, 1);
});

test('invalid durations and retries become null and are counted', () => {
  const s = single('chromium', 'flaky', [
    attempt('failed', 'x', -5),
    attempt('passed', 1, Number.NaN),
  ]);
  assertAvailable(s);
  const attempts = only(s).executions[0]?.attempts ?? [];
  assert.deepEqual(
    attempts.map((a) => a.durationMs),
    [null, null],
  );
  assert.deepEqual(
    attempts.map((a) => a.retry),
    [null, 1],
  );
  assert.equal(s.completeness?.invalidDurations, 2);
  assert.equal(s.completeness?.invalidRetries, 1);
  const big = single('chromium', 'expected', [attempt('passed', 0, LIMITS.maxDurationMs + 1)]);
  assert.equal(big.completeness?.invalidDurations, 1);
  const fractional = single('chromium', 'expected', [attempt('passed', 0, 12.6)]);
  assert.equal(only(fractional).executions[0]?.attempts[0]?.durationMs, 13);
});

/* ------------------------------------------------------------------ *
 * Identity and grouping
 * ------------------------------------------------------------------ */

test('duplicate setup executions are grouped as an inferred duplicate', () => {
  const s = run(
    report([
      spec('auth.setup.ts', 24, 'setup', [passing('setup')], { column: 1 }),
      spec('auth.setup.ts', 24, 'setup', [passing('setup')], { column: 1 }),
    ]),
  );
  assertAvailable(s);
  const i = only(s);
  assert.equal(i.multiplicity, 'inferred-duplicate');
  assert.equal(i.identity, 'resolved');
  assert.equal(i.executions.length, 2);
  assert.deepEqual(i.executionOutcomes, { passed: 2 });
  assert.equal(s.completeness?.shardAttribution, 'not-available');
});

test('contradictory duplicate outcomes keep both observations and flag a conflict', () => {
  const s = run(
    report([
      spec('auth.setup.ts', 24, 'setup', [passing('setup')], { column: 1 }),
      spec('auth.setup.ts', 24, 'setup', [testEntry('setup', 'unexpected', [attempt('failed')])], {
        column: 1,
      }),
    ]),
  );
  assertAvailable(s);
  const i = only(s);
  assert.equal(i.outcome, 'failed');
  assert.equal(i.conflict, true);
  assert.deepEqual(i.executionOutcomes, { failed: 1, passed: 1 });
});

test('repeated entries are not merged when repeatEach is above 1 or unknown', () => {
  const twice = [
    spec('ui/login.spec.ts', 15, 'same', [passing('chromium')]),
    spec('ui/login.spec.ts', 15, 'same', [passing('chromium')]),
  ];
  const repeated = run(report(twice, { projects: [{ name: 'chromium', repeatEach: 2 }] }));
  assertAvailable(repeated);
  assert.equal(repeated.instances.length, 2);
  assert.ok(repeated.instances.every((i) => i.identity === 'ambiguous-repeat-or-shard'));
  assert.equal(repeated.completeness?.ambiguousIdentities, 2);
  assert.equal(repeated.totals?.definitions, 1);
  const unknownConfig = run(report(twice, { projects: [] }));
  assert.equal(unknownConfig.instances.length, 2);
  assert.equal(unknownConfig.completeness?.ambiguousIdentities, 2);
});

test('two titles sharing one location are separate instances without exposing titles', () => {
  const s = run(
    report([
      spec('ui/login.spec.ts', 15, 'first title', [passing('chromium')]),
      spec('ui/login.spec.ts', 15, 'second title', [passing('chromium')]),
    ]),
  );
  assertAvailable(s);
  assert.equal(s.instances.length, 2);
  assert.deepEqual(
    s.instances.map((i) => i.locationGroupSize),
    [2, 2],
  );
  assert.notEqual(s.instances[0]?.definitionId, s.instances[1]?.definitionId);
  assert.ok(!serialize(s).includes('title'));
});

test('missing or invalid locations are unresolved and never merged', () => {
  const s = run(
    report([
      spec('/abs/path/x.spec.ts', 15, 't', [passing('chromium')]),
      spec('ui/../escape.spec.ts', 15, 't', [passing('chromium')]),
      spec('ui/login.spec.ts', 0, 't', [passing('chromium')]),
      spec('ui/login.spec.ts', 1.5, 't', [passing('chromium')]),
      spec('ui/login.spec.ts', 15, undefined, [passing('chromium')]),
      spec('ui/login.spec.ts', 15, undefined, [passing('chromium')]),
      spec('ui/notes.md', 15, 't', [passing('chromium')]),
    ]),
  );
  assertAvailable(s);
  assert.equal(s.instances.length, 7);
  assert.ok(s.instances.every((i) => i.identity === 'unresolved' && i.locationGroupSize === null));
  assert.equal(s.completeness?.unresolvedIdentities, 7);
  assert.equal(s.totals?.definitions, 7);
  assert.ok(!serialize(s).includes('/abs/'));
  assert.ok(!serialize(s).includes('..'));
});

test('unknown projects are labelled, counted and not merged with each other', () => {
  const s = run(
    report([spec('ui/login.spec.ts', 15, 't', [passing('mystery-one'), passing('mystery-two')])]),
  );
  assertAvailable(s);
  assert.equal(s.instances.length, 2);
  assert.ok(s.instances.every((i) => i.project === 'unrecognized'));
  assert.equal(s.completeness?.unrecognizedProjectExecutions, 2);
  assert.ok(!serialize(s).includes('mystery'));
});

test('only allow-listed tags are emitted; others are dropped and counted', () => {
  const s = run(
    report([
      spec('ui/login.spec.ts', 15, 't', [passing('chromium')], {
        tags: ['smoke', 'internal', 7, 'a11y'],
      }),
    ]),
  );
  assert.deepEqual(only(s).tags, ['a11y', 'smoke']);
  assert.equal(s.completeness?.droppedTags, 2);
});

/* ------------------------------------------------------------------ *
 * Counting
 * ------------------------------------------------------------------ */

test('the synthetic 12/18/19 shape counts definitions, instances and executions', () => {
  const s = run(twelveEighteenNineteen());
  assertAvailable(s);
  assert.equal(s.totals?.definitions, 12);
  assert.equal(s.totals?.instances, 18);
  assert.equal(s.totals?.executions, 19);
  assert.equal(s.totals?.attempts, 19);
  assert.equal(s.totals?.retries, 0);
  assert.deepEqual(s.totals?.byInstanceOutcome, { passed: 18 });
  assert.deepEqual(s.totals?.byExecutionOutcome, { passed: 19 });
  assert.equal(s.completeness?.statsCrossCheck, 'match');
  assert.deepEqual(
    s.projects.map((p) => p.name),
    DEFAULT_PROJECTS.map((p) => p.name).sort(),
  );
  const setup = s.instances.find((i) => i.project === 'setup');
  assert.equal(setup?.executions.length, 2);
  assert.equal(setup?.multiplicity, 'inferred-duplicate');
});

test('every counting invariant holds across mixed outcomes', () => {
  const s = run(
    report([
      spec('ui/login.spec.ts', 15, 'a', [
        testEntry('chromium', 'flaky', [attempt('failed', 0), attempt('passed', 1)]),
        testEntry('firefox', 'unexpected', [attempt('failed', 0), attempt('interrupted', 1)]),
        testEntry('webkit', 'skipped', []),
      ]),
      spec('ui/login.spec.ts', 33, 'b', [
        testEntry('chromium', 'expected', [attempt('failed')], 'failed'),
      ]),
      spec('auth.setup.ts', 24, 'setup', [passing('setup')], { column: 1 }),
      spec(
        'auth.setup.ts',
        24,
        'setup',
        [testEntry('setup', 'unexpected', [attempt('timedOut')])],
        { column: 1 },
      ),
    ]),
  );
  assertAvailable(s);
  const t = s.totals;
  assert.ok(t);
  assert.equal(t.definitions, 3);
  assert.equal(t.instances, 5);
  assert.equal(t.executions, 6);
  assert.equal(t.attempts, 7);
  assert.equal(t.retries, 2);
  assert.equal(t.zeroAttemptExecutions, 1);
  assert.deepEqual(t.byInstanceOutcome, {
    'timed-out': 1,
    interrupted: 1,
    flaky: 1,
    'did-not-run': 1,
    'expected-failure': 1,
  });
  assert.deepEqual(t.byExecutionOutcome, {
    'timed-out': 1,
    interrupted: 1,
    flaky: 1,
    'did-not-run': 1,
    'expected-failure': 1,
    passed: 1,
  });
});

test('invariant checks detect inconsistent summaries', () => {
  const good = run(twelveEighteenNineteen());
  assert.ok(good.totals);
  const broken: QualitySummary = {
    ...good,
    totals: { ...good.totals, instances: 17, retries: 99, definitions: 30 },
  };
  assert.deepEqual(invariantViolations(broken).sort(), [
    'instance-outcomes-sum',
    'instances-at-least-definitions',
    'retries-at-most-attempts',
    'totals-match-records',
  ]);
});

test('Playwright stats discrepancies are flagged, not corrected', () => {
  const specs = [spec('ui/login.spec.ts', 15, 't', [passing('chromium')])];
  const mismatch = run(
    report(specs, { stats: { expected: 5, unexpected: 0, flaky: 0, skipped: 0 } }),
  );
  assertAvailable(mismatch);
  assert.equal(mismatch.completeness?.statsCrossCheck, 'mismatch');
  assert.equal(mismatch.totals?.executions, 1);
  assert.equal(run(report(specs, { stats: 'none' })).completeness?.statsCrossCheck, 'unavailable');
  assert.equal(
    run(report(specs, { stats: { expected: -1, unexpected: 0, flaky: 0, skipped: 0 } }))
      .completeness?.statsCrossCheck,
    'unavailable',
  );
});

/* ------------------------------------------------------------------ *
 * Security
 * ------------------------------------------------------------------ */

test('no secret canary from any prohibited input field reaches the output', () => {
  const s = normalize(canaryReport(), context({ branch: `feature/${CANARY}` }));
  assertAvailable(s);
  const out = serialize(s);
  assert.ok(!out.includes(CANARY), 'a canary leaked into the summary');
  assert.ok(!out.includes('/home/runner'));
  assert.ok(!out.includes('@example.com'));
  assert.equal(s.instances.length, 3);
});

test('the output contains only allow-listed keys, even with unknown input fields', () => {
  for (const summary of [run(canaryReport()), run(twelveEighteenNineteen()), run({ suites: [] })]) {
    assert.deepEqual(unexpectedKeys(summary), []);
  }
});

test('the normalizer source does not read the clock, environment, filesystem or network', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'reporting', 'quality-summary.ts'),
    'utf8',
  );
  for (const forbidden of [
    'Date.now',
    'new Date',
    'process.',
    'require(',
    'fetch(',
    "from 'node:",
    'Math.random',
  ]) {
    assert.ok(!source.includes(forbidden), `quality-summary.ts must not use ${forbidden}`);
  }
  assert.ok(!/^import /m.test(source), 'quality-summary.ts must have no imports');
});

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

test('identical input and context serialize to identical bytes', () => {
  const a = serialize(run(twelveEighteenNineteen()));
  const b = serialize(run(twelveEighteenNineteen()));
  assert.equal(a, b);
  assert.ok(a.endsWith('}\n'));
});

test('input key order does not change the output', () => {
  const base = canaryReport();
  const reordered = reorderKeys(base);
  assert.equal(serialize(run(base)), serialize(run(reordered)));
  const ctxA = validateRunContext(contextInput());
  const ctxB = validateRunContext(reorderKeys(contextInput()));
  assert.ok(ctxA.ok && ctxB.ok);
  assert.equal(serialize(normalize(base, ctxA.context)), serialize(normalize(base, ctxB.context)));
});

test('ordering is deterministic and ids are ordinal', () => {
  const s = run(twelveEighteenNineteen());
  assert.deepEqual(
    s.instances.map((i) => i.instanceId),
    s.instances.map((_, n) => `i${String(n + 1).padStart(5, '0')}`),
  );
  const projects = s.instances.map((i) => i.project);
  assert.deepEqual(projects, [...projects].sort());
  assert.ok(s.instances.every((i) => /^d\d{5}$/.test(i.definitionId)));
});

test('normalize does not mutate its input', () => {
  const frozen = deepFreeze(twelveEighteenNineteen());
  assert.doesNotThrow(() => run(frozen));
});
