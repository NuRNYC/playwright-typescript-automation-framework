/**
 * Unit tests for the dashboard data model (ADR-0009, M8C-1).
 *
 * Same conventions as the other unit tests (ADR-0002): Node's built-in
 * runner, explicit `.ts` imports. Valid summaries are produced by the M8A
 * normalizer from synthetic fixtures; handcrafted objects are used only for
 * negative validation. Nothing is read from disk, CI or a real run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSERS,
  MAX_DEPTH,
  MAX_INPUT_BYTES,
  PROJECT_LABELS,
  buildViewModel,
  normalizeFilters,
  parseSummary,
  type DashboardFilters,
  type DashboardViewModel,
  type ParsedSummary,
  type Section,
  type ValidatedDashboardSummary,
} from './dashboard-model.ts';
import { GATE_INPUT_NAMES, LIMITS, OUTCOMES, normalize, serialize } from './quality-summary.ts';
import {
  CANARY,
  DEFAULT_PROJECTS,
  attempt,
  canaryReport,
  context,
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

function summaryText(
  reportValue: Record<string, unknown> = twelveEighteenNineteen(),
  overrides: Record<string, unknown> = {},
): string {
  return serialize(normalize(reportValue, context(overrides)));
}

function validated(parsed: ParsedSummary): ValidatedDashboardSummary {
  assert.equal(parsed.state, 'valid');
  if (parsed.state !== 'valid') {
    throw new Error('unreachable');
  }
  return parsed.validated;
}

function view(text: string, filters: DashboardFilters = {}): DashboardViewModel {
  return buildViewModel(parseSummary(text), filters);
}

function data<T>(section: Section<T>): T {
  assert.equal(section.status, 'available');
  if (section.status !== 'available') {
    throw new Error('unreachable');
  }
  return section.data;
}

type Path = readonly (string | number)[];

function nodeAt(root: unknown, path: Path): Record<string, unknown> {
  let current: unknown = root;
  for (const key of path) {
    assert.ok(typeof current === 'object' && current !== null, `no node at ${path.join('.')}`);
    current = (current as Record<string | number, unknown>)[key];
  }
  assert.ok(typeof current === 'object' && current !== null, `no node at ${path.join('.')}`);
  return current as Record<string, unknown>;
}

/** Applies `edit` to a parsed copy of `text` and re-serializes it. */
function edited(text: string, edit: (root: Record<string, unknown>) => void): string {
  const root = JSON.parse(text) as Record<string, unknown>;
  edit(root);
  return JSON.stringify(root);
}

function setAt(path: Path, key: string, value: unknown): (root: Record<string, unknown>) => void {
  return (root) => {
    nodeAt(root, path)[key] = value;
  };
}

function deleteAt(path: Path, key: string): (root: Record<string, unknown>) => void {
  return (root) => {
    delete nodeAt(root, path)[key];
  };
}

function flakyReport(): Record<string, unknown> {
  return report([
    spec('ui/login.spec.ts', 15, 'synthetic flaky', [
      testEntry('chromium', 'flaky', [
        attempt('failed', 0),
        attempt('failed', 1),
        attempt('passed', 2),
      ]),
      testEntry('firefox', 'flaky', [attempt('failed', 0), attempt('passed', 1)]),
      passing('webkit'),
    ]),
    spec('ui/login.spec.ts', 33, 'synthetic failing', [
      testEntry('chromium', 'unexpected', [attempt('failed', 0)]),
    ]),
    spec('api/products.spec.ts', 13, 'synthetic api', [passing('api')], { tags: ['api'] }),
  ]);
}

/* ------------------------------------------------------------------ *
 * Valid M8A-generated summaries
 * ------------------------------------------------------------------ */

test('a valid M8A summary parses and is consistent', () => {
  const result = validated(parseSummary(summaryText()));
  assert.equal(result.kind, 'validated-dashboard-summary');
  assert.equal(result.schemaVersion, '1.0.0');
  assert.deepEqual(result.consistency, { state: 'consistent', violations: [] });
});

test('a valid summary rebuilt by validation round-trips to the same serialization', () => {
  const text = summaryText(flakyReport());
  assert.equal(serialize(validated(parseSummary(text)).summary), text);
});

test('valid view model exposes all six sections and the run header', () => {
  const vm = view(summaryText());
  assert.equal(vm.state, 'valid');
  assert.deepEqual(vm.run, {
    schemaVersion: '1.0.0',
    generatorVersion: '0.1.0',
    runId: 1_000_001,
    runAttempt: 1,
    event: 'push',
    headSha: '0123456789abcdef0123456789abcdef01234567',
    branchClass: 'main',
    classification: 'ordinary',
    generatedAt: '2026-11-25T00:00:00.000Z',
  });
  for (const section of [vm.overview, vm.explorer, vm.projects, vm.failures, vm.gate]) {
    assert.equal(section.status, 'available');
  }
  assert.equal(vm.completeness.testData, 'available');
  assert.equal(vm.completeness.history, 'not-available-single-run');
  assert.equal(vm.completeness.requirementCoverage, 'not-available');
});

test('all five counting units stay separate (12/18/19 regression shape)', () => {
  const overview = data(view(summaryText()).overview);
  assert.equal(overview.qualityUnit, 'instances');
  assert.deepEqual(overview.wholeRun, {
    definitions: { known: true, value: 12 },
    instances: { known: true, value: 18 },
    executions: { known: true, value: 19 },
    attempts: { known: true, value: 19 },
    retries: { known: true, value: 0 },
    zeroAttemptExecutions: { known: true, value: 0 },
  });
  assert.deepEqual(overview.filtered, overview.wholeRun);
});

test('retries are aggregated per row, per project and in failure intelligence', () => {
  const vm = view(summaryText(flakyReport()));
  const overview = data(vm.overview);
  assert.deepEqual(overview.wholeRun.attempts, { known: true, value: 8 });
  assert.deepEqual(overview.wholeRun.retries, { known: true, value: 3 });
  const rows = data(vm.explorer);
  const chromiumFlaky = rows.find((r) => r.project === 'chromium' && r.outcome === 'flaky');
  assert.equal(chromiumFlaky?.retryCount, 2);
  assert.equal(chromiumFlaky?.attemptCount, 3);
  const failures = data(vm.failures);
  assert.equal(failures.note, 'structured-status-not-root-cause');
  assert.deepEqual(
    failures.retried.map((r) => r.retries),
    [2, 1],
  );
  assert.equal(failures.flaky.length, 2);
  assert.equal(failures.failed.length, 1);
  const chromium = data(vm.projects).find((p) => p.project === 'chromium');
  assert.equal(chromium?.retries, 2);
  assert.equal(chromium?.instances, 2);
});

test('outcome lists follow the M8A severity order and are never reclassified', () => {
  const vm = view(summaryText(flakyReport()));
  const overview = data(vm.overview);
  assert.deepEqual(
    overview.byInstanceOutcome.map((o) => o.outcome),
    [...OUTCOMES],
  );
  const counts = Object.fromEntries(overview.byInstanceOutcome.map((o) => [o.outcome, o.count]));
  assert.equal(counts.flaky, 2);
  assert.equal(counts.failed, 1);
  assert.equal(counts.passed, 2);
  const summary = validated(parseSummary(summaryText(flakyReport()))).summary;
  for (const row of data(vm.explorer)) {
    const source = summary.instances.find((i) => i.instanceId === row.instanceId);
    assert.equal(row.outcome, source?.outcome);
  }
});

test('gate observations list all eight inputs in contract order', () => {
  const vm = view(
    summaryText(twelveEighteenNineteen(), {
      gateInputs: {
        ...Object.fromEntries(GATE_INPUT_NAMES.map((n) => [n, 'success'])),
        MERGE: 'failure',
      },
    }),
  );
  const gate = data(vm.gate);
  assert.deepEqual(
    gate.map((g) => g.name),
    [...GATE_INPUT_NAMES],
  );
  assert.equal(gate.find((g) => g.name === 'MERGE')?.state, 'failure');
});

/* ------------------------------------------------------------------ *
 * CI verdict
 * ------------------------------------------------------------------ */

test('CI verdict is always unverified, even when every gate input succeeded', () => {
  const states: ParsedSummary[] = [
    parseSummary(summaryText()),
    parseSummary(summaryText(twelveEighteenNineteen(), { reportState: 'report-missing' })),
    parseSummary(''),
    parseSummary('{'),
    parseSummary(JSON.stringify({ schemaVersion: '2.0.0' })),
  ];
  for (const parsed of states) {
    const vm = buildViewModel(parsed, {});
    assert.deepEqual(vm.ciVerdict, { status: 'unverified', reason: 'not-recorded-in-summary' });
    assert.ok(vm.notices.includes('ci-verdict-unverified'));
    assert.doesNotMatch(
      JSON.stringify(vm),
      /"(?:verdict|gateResult|passed)":\s*(?:true|"success")/,
    );
  }
});

test('a summary claiming a CI verdict is rejected', () => {
  const parsed = parseSummary(edited(summaryText(), setAt([], 'ciVerdict', 'success')));
  assert.deepEqual(parsed, { state: 'invalid', problem: 'invalid-structure', path: 'ciVerdict' });
});

/* ------------------------------------------------------------------ *
 * Special states
 * ------------------------------------------------------------------ */

test('empty or whitespace text is the no-summary state', () => {
  for (const text of ['', '   \n\t']) {
    assert.deepEqual(parseSummary(text), { state: 'no-summary' });
    const vm = view(text);
    assert.equal(vm.state, 'no-summary');
    assert.equal(vm.run, null);
    assert.deepEqual(vm.overview, { status: 'unavailable', reason: 'no-summary' });
    assert.ok(vm.notices.includes('no-summary'));
  }
});

test('an unavailable summary keeps the run header and gate but no test data', () => {
  const text = summaryText(twelveEighteenNineteen(), { reportState: 'report-missing' });
  const vm = view(text);
  assert.equal(vm.state, 'unavailable');
  assert.equal(vm.run?.runId, 1_000_001);
  assert.equal(vm.gate.status, 'available');
  assert.deepEqual(vm.overview, { status: 'unavailable', reason: 'report-missing' });
  assert.deepEqual(vm.explorer, vm.overview);
  assert.equal(vm.completeness.testData, 'unavailable');
  assert.equal(vm.completeness.unavailableReason, 'report-missing');
  assert.ok(vm.notices.includes('test-data-unavailable'));
});

test('schema major versions other than 1 are a schema mismatch', () => {
  for (const version of ['2.0.0', '0.9.0', '10.1.2']) {
    const parsed = parseSummary(edited(summaryText(), setAt([], 'schemaVersion', version)));
    assert.equal(parsed.state, 'schema-mismatch');
    const vm = buildViewModel(parsed, {});
    assert.equal(vm.state, 'schema-mismatch');
    assert.deepEqual(vm.schemaMismatch, {
      foundMajor: Number(version.split('.')[0]),
      supportedMajor: 1,
    });
    assert.equal(vm.run, null);
  }
});

test('a compatible 1.x minor version is accepted and reported as such', () => {
  const result = validated(
    parseSummary(edited(summaryText(), setAt([], 'schemaVersion', '1.2.0'))),
  );
  assert.equal(result.schemaVersion, '1.2.0');
});

test('invalid summaries give a fixed problem code and a schema path', () => {
  const vm = view('{not json');
  assert.equal(vm.state, 'invalid');
  assert.equal(vm.invalidProblem, 'invalid-json');
  assert.equal(vm.invalidPath, null);
  assert.deepEqual(vm.overview, { status: 'unavailable', reason: 'invalid-summary' });
});

test('state flags: provisional, ambiguous, inferred duplicate, unrecognized project, conflict', () => {
  const projects = DEFAULT_PROJECTS.map((p) =>
    p.name === 'firefox' ? { name: p.name, repeatEach: 2 } : p,
  );
  const text = summaryText(
    report(
      [
        spec('ui/login.spec.ts', 15, 'synthetic provisional', [
          testEntry('chromium', 'unexpected', [attempt('failed', 0), attempt('interrupted', 1)]),
        ]),
        // Repeated with repeatEach 2: ambiguous, kept separate.
        spec('ui/login.spec.ts', 33, 'synthetic repeat', [passing('firefox')]),
        spec('ui/login.spec.ts', 33, 'synthetic repeat', [passing('firefox')]),
        // Repeated with repeatEach 1: inferred shard duplicate with a conflict.
        spec('auth.setup.ts', 24, 'synthetic setup', [passing('setup')], { column: 1 }),
        spec(
          'auth.setup.ts',
          24,
          'synthetic setup',
          [testEntry('setup', 'unexpected', [attempt('failed', 0)])],
          { column: 1 },
        ),
        spec('ui/other.spec.ts', 5, 'synthetic unknown project', [passing('mystery-project')]),
      ],
      { projects },
    ),
  );
  const vm = view(text);
  assert.equal(vm.state, 'valid');
  const rows = data(vm.explorer);
  const badge = (b: string): number => rows.filter((r) => r.badges.includes(b as never)).length;
  assert.equal(badge('provisional'), 1);
  assert.equal(badge('ambiguous-identity'), 2);
  assert.equal(badge('inferred-duplicate'), 1);
  assert.equal(badge('unrecognized-project'), 1);
  assert.equal(badge('conflict'), 1);
  for (const notice of [
    'provisional-outcomes-present',
    'ambiguous-identities-present',
    'inferred-duplicates-present',
    'unrecognized-projects-present',
  ] as const) {
    assert.ok(vm.notices.includes(notice), notice);
  }
  const duplicate = rows.find((r) => r.multiplicity === 'inferred-duplicate');
  assert.equal(duplicate?.executionCount, 2);
  assert.equal(duplicate?.outcome, 'failed');
  assert.equal(duplicate?.conflict, true);
  const unknownProject = rows.find((r) => r.project === 'unrecognized');
  assert.equal(unknownProject?.browser, 'unknown');
  const projectRow = data(vm.projects).find((p) => p.project === 'unrecognized');
  assert.equal(projectRow?.kind, 'unknown');
  assert.deepEqual(projectRow?.repeatEach, { known: false });
  const failures = data(vm.failures);
  assert.equal(failures.provisional.length, 1);
  assert.equal(failures.conflicts.length, 1);
  assert.deepEqual(vm.completeness.counts.ambiguousIdentities, { known: true, value: 2 });
  assert.deepEqual(vm.completeness.counts.provisionalOutcomes, { known: true, value: 1 });
});

test('an inconsistent execution is flagged without reclassification', () => {
  const text = summaryText(
    report([
      spec('ui/login.spec.ts', 15, 'synthetic mismatch', [
        testEntry('chromium', 'expected', [attempt('failed', 0)]),
      ]),
    ]),
  );
  const result = validated(parseSummary(text));
  const execution = result.summary.instances[0]?.executions[0];
  assert.equal(execution?.consistent, false);
  const row = data(buildViewModel(parseSummary(text), {}).explorer)[0];
  assert.ok(row?.badges.includes('inconsistent-execution'));
  assert.equal(row?.outcome, result.summary.instances[0]?.outcome);
});

test('tampered counts are flagged as inconsistent data, not corrected', () => {
  const text = edited(summaryText(), (root) => {
    nodeAt(root, ['totals'])['retries'] = 5;
    nodeAt(root, ['totals', 'byInstanceOutcome'])['passed'] = 17;
    nodeAt(root, ['totals', 'byInstanceOutcome'])['failed'] = 1;
  });
  const result = validated(parseSummary(text));
  assert.equal(result.consistency.state, 'inconsistent');
  assert.deepEqual(result.consistency.violations, ['instance-outcome-totals', 'retries-count']);
  const vm = buildViewModel(parseSummary(text), {});
  assert.ok(vm.notices.includes('inconsistent-data'));
  assert.equal(vm.completeness.consistency, 'inconsistent');
  // Whole-run totals are shown as reported; filtered counts come from records.
  const overview = data(vm.overview);
  assert.deepEqual(overview.wholeRun.retries, { known: true, value: 5 });
  assert.deepEqual(overview.filtered.retries, { known: true, value: 0 });
});

test('a tampered instance outcome is flagged as not most severe', () => {
  const text = edited(summaryText(flakyReport()), (root) => {
    const instances = root['instances'] as Record<string, unknown>[];
    const flaky = instances.find((i) => i['outcome'] === 'flaky');
    assert.ok(flaky);
    flaky['outcome'] = 'passed';
  });
  const result = validated(parseSummary(text));
  assert.ok(result.consistency.violations.includes('instance-outcome-not-most-severe'));
});

/* ------------------------------------------------------------------ *
 * UNKNOWN versus zero
 * ------------------------------------------------------------------ */

test('unavailable data is UNKNOWN, never zero', () => {
  const vm = view(summaryText(twelveEighteenNineteen(), { reportState: 'report-unreadable' }));
  for (const count of Object.values(vm.completeness.counts)) {
    assert.deepEqual(count, { known: false });
  }
  assert.equal(vm.completeness.statsCrossCheck, 'unknown');
  assert.doesNotMatch(JSON.stringify(vm), /"value":0/);
});

test('a genuine zero is a known zero', () => {
  const vm = view(summaryText());
  assert.deepEqual(data(vm.overview).wholeRun.retries, { known: true, value: 0 });
  assert.deepEqual(vm.completeness.counts.droppedTags, { known: true, value: 0 });
});

test('missing totals in an available summary are invalid, not zero', () => {
  for (const edit of [deleteAt([], 'totals'), setAt([], 'totals', null)]) {
    assert.deepEqual(parseSummary(edited(summaryText(), edit)), {
      state: 'invalid',
      problem: 'invalid-structure',
      path: 'totals',
    });
  }
  assert.deepEqual(parseSummary(edited(summaryText(), deleteAt(['totals'], 'retries'))), {
    state: 'invalid',
    problem: 'invalid-structure',
    path: 'totals.retries',
  });
});

test('missing repeatEach is UNKNOWN on the project row', () => {
  const text = summaryText(
    report([spec('ui/login.spec.ts', 15, 'synthetic', [passing('chromium')])], {
      projects: DEFAULT_PROJECTS.map((p) =>
        p.name === 'chromium' ? { name: p.name, repeatEach: 'x' } : p,
      ),
    }),
  );
  const row = data(view(text).projects).find((p) => p.project === 'chromium');
  assert.deepEqual(row?.repeatEach, { known: false });
  const firefox = data(view(text).projects).find((p) => p.project === 'firefox');
  assert.deepEqual(firefox?.repeatEach, { known: true, value: 1 });
});

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

test('project filter narrows rows and projects but keeps whole-run totals', () => {
  const vm = view(summaryText(), { projects: ['firefox'] });
  const rows = data(vm.explorer);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.project === 'firefox'));
  assert.deepEqual(
    data(vm.projects).map((p) => p.project),
    ['firefox'],
  );
  const overview = data(vm.overview);
  assert.deepEqual(overview.wholeRun.instances, { known: true, value: 18 });
  assert.deepEqual(overview.filtered.instances, { known: true, value: rows.length });
  assert.ok(vm.notices.includes('filters-active'));
});

test('browser filter covers every project of that browser', () => {
  const rows = data(view(summaryText(), { browsers: ['webkit'] }).explorer);
  assert.deepEqual([...new Set(rows.map((r) => r.project))].sort(), [
    'webkit',
    'webkit-authenticated',
  ]);
  const none = data(view(summaryText(), { browsers: ['none'] }).explorer);
  assert.deepEqual([...new Set(none.map((r) => r.project))], ['api']);
});

test('outcome filter selects by instance outcome', () => {
  const vm = view(summaryText(flakyReport()), { outcomes: ['flaky'] });
  const rows = data(vm.explorer);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.outcome === 'flaky'));
  const filtered = Object.fromEntries(
    data(vm.overview).filteredByInstanceOutcome.map((o) => [o.outcome, o.count]),
  );
  assert.equal(filtered.flaky, 2);
  assert.equal(filtered.passed, 0);
});

test('ambiguous-only and provisional-only filters', () => {
  const projects = DEFAULT_PROJECTS.map((p) =>
    p.name === 'firefox' ? { name: p.name, repeatEach: 3 } : p,
  );
  const text = summaryText(
    report(
      [
        spec('ui/login.spec.ts', 15, 'synthetic provisional', [
          testEntry('chromium', 'unexpected', [attempt('failed', 0), attempt('interrupted', 1)]),
        ]),
        spec('ui/login.spec.ts', 33, 'synthetic repeat', [passing('firefox')]),
        spec('ui/login.spec.ts', 33, 'synthetic repeat', [passing('firefox')]),
        spec('ui/login.spec.ts', 40, 'synthetic plain', [passing('webkit')]),
      ],
      { projects },
    ),
  );
  const ambiguous = data(view(text, { ambiguousOnly: true }).explorer);
  assert.equal(ambiguous.length, 2);
  assert.ok(ambiguous.every((r) => r.identity === 'ambiguous-repeat-or-shard'));
  const provisional = data(view(text, { provisionalOnly: true }).explorer);
  assert.equal(provisional.length, 1);
  assert.equal(provisional[0]?.outcomeCertainty, 'provisional');
  assert.equal(data(view(text, { ambiguousOnly: true, provisionalOnly: true }).explorer).length, 0);
});

test('unknown filter values are ignored and counted, never echoed', () => {
  const filters = normalizeFilters({
    projects: ['chromium', `<img src=x onerror=${CANARY}>`, 'chromium'],
    browsers: ['netscape'],
    outcomes: ['exploded', 'failed'],
    classifications: ['ordinary', CANARY],
  });
  assert.deepEqual(filters.projects, ['chromium']);
  assert.deepEqual(filters.browsers, []);
  assert.deepEqual(filters.outcomes, ['failed']);
  assert.deepEqual(filters.classifications, ['ordinary']);
  assert.equal(filters.ignoredValues, 4);
  const vm = view(summaryText(), { projects: [CANARY] });
  assert.ok(vm.notices.includes('filter-values-ignored'));
  assert.equal(JSON.stringify(vm).includes(CANARY), false);
});

test('default filters are inactive and include nothing extra', () => {
  assert.deepEqual(normalizeFilters(), {
    projects: [],
    browsers: [],
    outcomes: [],
    classifications: [],
    ambiguousOnly: false,
    provisionalOnly: false,
    includeProbeRuns: false,
    ignoredValues: 0,
    active: false,
  });
  assert.deepEqual(PROJECT_LABELS, [...PROJECT_LABELS].sort());
  assert.deepEqual(BROWSERS, ['chromium', 'firefox', 'none', 'unknown', 'webkit']);
});

test('probe runs are excluded from quality indicators by default and included on request', () => {
  const text = summaryText(twelveEighteenNineteen(), { branch: 'probe/synthetic' });
  const excluded = view(text);
  assert.equal(excluded.state, 'valid');
  assert.equal(excluded.run?.classification, 'intentional-probe');
  assert.deepEqual(excluded.overview, { status: 'excluded', reason: 'probe-run' });
  assert.deepEqual(excluded.explorer, excluded.overview);
  assert.equal(excluded.gate.status, 'available');
  assert.ok(excluded.notices.includes('probe-run-excluded'));
  const included = view(text, { includeProbeRuns: true });
  assert.equal(data(included.overview).scope, 'probe-included');
  assert.ok(included.notices.includes('probe-run-included'));
  assert.equal(JSON.stringify(included).includes('probe/synthetic'), false);
});

test('unknown-classification runs are excluded by default and included on request', () => {
  const text = summaryText(twelveEighteenNineteen(), { branch: '' });
  const excluded = view(text);
  assert.equal(excluded.run?.classification, 'unknown');
  assert.deepEqual(excluded.overview, { status: 'excluded', reason: 'unknown-classification' });
  assert.ok(excluded.notices.includes('unknown-classification-excluded'));
  const included = view(text, { includeProbeRuns: true });
  assert.equal(data(included.overview).scope, 'unknown-classification-included');
  assert.ok(included.notices.includes('unknown-classification-included'));
});

test('a classification filter that does not match the run excludes it', () => {
  const vm = view(summaryText(), { classifications: ['intentional-probe'] });
  assert.deepEqual(vm.overview, { status: 'excluded', reason: 'classification-filter' });
  assert.ok(vm.notices.includes('run-excluded-by-classification-filter'));
  assert.equal(view(summaryText(), { classifications: ['ordinary'] }).overview.status, 'available');
});

/* ------------------------------------------------------------------ *
 * Input bounds
 * ------------------------------------------------------------------ */

test('input over the 5 MB limit is rejected before parsing', () => {
  assert.equal(MAX_INPUT_BYTES, LIMITS.maxOutputBytes);
  const text = `{"pad":"${'x'.repeat(MAX_INPUT_BYTES)}"}`;
  assert.deepEqual(parseSummary(text), {
    state: 'invalid',
    problem: 'input-too-large',
    path: null,
  });
  // Multi-byte characters count as bytes, not code units.
  const wide = `{"pad":"${'é'.repeat(MAX_INPUT_BYTES / 2)}"}`;
  assert.equal(parseSummary(wide).state, 'invalid');
});

test('excessive nesting is rejected', () => {
  const deep = `${'['.repeat(MAX_DEPTH + 2)}${']'.repeat(MAX_DEPTH + 2)}`;
  assert.deepEqual(parseSummary(deep), { state: 'invalid', problem: 'too-deep', path: null });
  const hidden = edited(
    summaryText(),
    setAt([], 'extra', JSON.parse(`${'{"a":'.repeat(20)}1${'}'.repeat(20)}`)),
  );
  assert.equal(parseSummary(hidden).state, 'invalid');
});

/* ------------------------------------------------------------------ *
 * Malformed fields (handcrafted negative cases)
 * ------------------------------------------------------------------ */

const NEGATIVE_CASES: readonly [string, (root: Record<string, unknown>) => void, string][] = [
  ['missing schema version', deleteAt([], 'schemaVersion'), 'schemaVersion'],
  ['non-semver schema version', setAt([], 'schemaVersion', 'one'), 'schemaVersion'],
  ['wrong generator', setAt(['generator'], 'name', 'other-tool'), 'generator.name'],
  ['missing run', deleteAt([], 'run'), 'run'],
  ['bad head SHA', setAt(['run'], 'headSha', 'abc'), 'run.headSha'],
  ['bad run id', setAt(['run'], 'runId', -1), 'run.runId'],
  ['fractional attempt', setAt(['run'], 'runAttempt', 1.5), 'run.runAttempt'],
  ['raw branch in class', setAt(['run'], 'branchClass', 'feature/x'), 'run.branchClass'],
  [
    'classification contradicts branch',
    setAt(['run'], 'classification', 'unknown'),
    'run.classification',
  ],
  ['bad timestamp', setAt(['run'], 'generatedAt', 'yesterday'), 'run.generatedAt'],
  ['bad event', setAt(['run'], 'event', 'schedule'), 'run.event'],
  ['missing gate input', deleteAt(['observedGateInputs'], 'MERGE'), 'observedGateInputs.MERGE'],
  [
    'unknown gate state',
    setAt(['observedGateInputs'], 'CHECKS', 'passed'),
    'observedGateInputs.CHECKS',
  ],
  ['unknown test-data state', setAt(['testData'], 'state', 'maybe'), 'testData.state'],
  ['available with reason', setAt(['testData'], 'reason', 'report-missing'), 'testData.reason'],
  ['missing completeness', setAt([], 'completeness', null), 'completeness'],
  [
    'negative completeness count',
    setAt(['completeness'], 'droppedTags', -1),
    'completeness.droppedTags',
  ],
  [
    'bad cross-check',
    setAt(['completeness'], 'statsCrossCheck', 'ok'),
    'completeness.statsCrossCheck',
  ],
  [
    'claimed shard attribution',
    setAt(['completeness'], 'shardAttribution', 'available'),
    'completeness.shardAttribution',
  ],
  ['unknown project metadata', setAt(['projects', 0], 'name', 'mystery'), 'projects[0].name'],
  ['wrong project browser', setAt(['projects', 0], 'browser', 'webkit'), 'projects[0].browser'],
  ['bad instance id', setAt(['instances', 0], 'instanceId', 'x1'), 'instances[0].instanceId'],
  [
    'unknown instance outcome',
    setAt(['instances', 0], 'outcome', 'exploded'),
    'instances[0].outcome',
  ],
  [
    'unknown instance project',
    setAt(['instances', 0], 'project', 'mystery'),
    'instances[0].project',
  ],
  [
    'absolute file path',
    setAt(['instances', 0], 'file', '/etc/passwd.spec.ts'),
    'instances[0].file',
  ],
  [
    'traversal file path',
    setAt(['instances', 0], 'file', 'tests/a/../b.spec.ts'),
    'instances[0].file',
  ],
  [
    'markup in file',
    setAt(['instances', 0], 'file', 'tests/<script>.spec.ts'),
    'instances[0].file',
  ],
  ['unknown tag', setAt(['instances', 0], 'tags', ['<b>x</b>']), 'instances[0].tags[0]'],
  ['duplicate tags', setAt(['instances', 0], 'tags', ['smoke', 'smoke']), 'instances[0].tags'],
  ['bad identity', setAt(['instances', 0], 'identity', 'guessed'), 'instances[0].identity'],
  [
    'bad certainty',
    setAt(['instances', 0], 'outcomeCertainty', 'likely'),
    'instances[0].outcomeCertainty',
  ],
  ['string conflict', setAt(['instances', 0], 'conflict', 'no'), 'instances[0].conflict'],
  ['no executions', setAt(['instances', 0], 'executions', []), 'instances[0].executions'],
  [
    'unknown execution outcome',
    setAt(['instances', 0, 'executions', 0], 'outcome', 'exploded'),
    'instances[0].executions[0].outcome',
  ],
  [
    'unknown reported status',
    setAt(['instances', 0, 'executions', 0], 'reportedStatus', 'ok'),
    'instances[0].executions[0].reportedStatus',
  ],
  [
    'unknown attempt status',
    setAt(['instances', 0, 'executions', 0, 'attempts', 0], 'status', 'crashed'),
    'instances[0].executions[0].attempts[0].status',
  ],
  [
    'negative duration',
    setAt(['instances', 0, 'executions', 0, 'attempts', 0], 'durationMs', -1),
    'instances[0].executions[0].attempts[0].durationMs',
  ],
  [
    'fractional retry',
    setAt(['instances', 0, 'executions', 0, 'attempts', 0], 'retry', 0.5),
    'instances[0].executions[0].attempts[0].retry',
  ],
  [
    'retry over limit',
    setAt(
      ['instances', 0, 'executions', 0, 'attempts', 0],
      'retry',
      LIMITS.maxAttemptsPerExecution,
    ),
    'instances[0].executions[0].attempts[0].retry',
  ],
  [
    'unknown outcome key',
    setAt(['totals', 'byInstanceOutcome'], 'exploded', 1),
    'totals.byInstanceOutcome.<key>',
  ],
  [
    'zero outcome entry',
    setAt(['totals', 'byInstanceOutcome'], 'failed', 0),
    'totals.byInstanceOutcome.failed',
  ],
  ['string total', setAt(['totals'], 'instances', '18'), 'totals.instances'],
  [
    'duplicate instance id',
    (root) => {
      const instances = root['instances'] as Record<string, unknown>[];
      const first = instances[0];
      assert.ok(first);
      instances.push({ ...first });
    },
    'instances.instanceId',
  ],
];

for (const [name, edit, path] of NEGATIVE_CASES) {
  test(`malformed field is rejected: ${name}`, () => {
    assert.deepEqual(parseSummary(edited(summaryText(), edit)), {
      state: 'invalid',
      problem: 'invalid-structure',
      path,
    });
  });
}

test('non-object roots are invalid', () => {
  for (const text of ['null', '[]', '42', '"summary"']) {
    assert.deepEqual(parseSummary(text), {
      state: 'invalid',
      problem: 'invalid-structure',
      path: '$',
    });
  }
});

test('an unavailable summary carrying data is rejected', () => {
  const unavailable = summaryText(twelveEighteenNineteen(), { reportState: 'report-missing' });
  const available = JSON.parse(summaryText()) as Record<string, unknown>;
  assert.deepEqual(
    parseSummary(edited(unavailable, setAt([], 'instances', available['instances']))),
    {
      state: 'invalid',
      problem: 'invalid-structure',
      path: 'instances',
    },
  );
  assert.deepEqual(parseSummary(edited(unavailable, setAt([], 'totals', available['totals']))), {
    state: 'invalid',
    problem: 'invalid-structure',
    path: 'totals',
  });
  assert.deepEqual(parseSummary(edited(unavailable, setAt(['testData'], 'reason', 'because'))), {
    state: 'invalid',
    problem: 'invalid-structure',
    path: 'testData.reason',
  });
});

test('invalid view models never echo input values', () => {
  const text = edited(summaryText(), setAt(['instances', 0], 'outcome', CANARY));
  const vm = view(text);
  assert.equal(vm.state, 'invalid');
  assert.equal(JSON.stringify(vm).includes(CANARY), false);
  assert.equal(JSON.stringify(parseSummary(text)).includes(CANARY), false);
});

/* ------------------------------------------------------------------ *
 * Security: unknown fields and canaries
 * ------------------------------------------------------------------ */

test('unexpected input fields at every level never reach the result', () => {
  const text = edited(summaryText(flakyReport()), (root) => {
    const paths: Path[] = [
      [],
      ['generator'],
      ['run'],
      ['observedGateInputs'],
      ['testData'],
      ['completeness'],
      ['projects', 0],
      ['instances', 0],
      ['instances', 0, 'executions', 0],
      ['instances', 0, 'executions', 0, 'attempts', 0],
      ['totals'],
    ];
    for (const path of paths) {
      const node = nodeAt(root, path);
      node[CANARY] = CANARY;
      node['title'] = `${CANARY} title`;
      node['branch'] = `feature/${CANARY}`;
      node['error'] = { message: CANARY, stack: CANARY };
    }
  });
  // A JSON "__proto__" key becomes an own property under JSON.parse.
  const withProto = text.replace('{', `{"__proto__":{"polluted":"${CANARY}"},`);
  const result = validated(parseSummary(withProto));
  const serialized =
    JSON.stringify(result) + JSON.stringify(buildViewModel(parseSummary(withProto), {}));
  assert.equal(serialized.includes(CANARY), false);
  assert.equal(serialized.includes('"title"'), false);
  assert.equal(serialized.includes('"error"'), false);
  assert.equal(serialized.includes('polluted'), false);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  assert.equal(serialize(result.summary), summaryText(flakyReport()));
});

test('outcome maps accept outcome keys only', () => {
  const text = edited(summaryText(), setAt(['instances', 0, 'executionOutcomes'], CANARY, 1));
  assert.deepEqual(parseSummary(text), {
    state: 'invalid',
    problem: 'invalid-structure',
    path: 'instances[0].executionOutcomes.<key>',
  });
});

test('the synthetic secret canary never leaks from an M8A canary report', () => {
  const text = summaryText(canaryReport());
  assert.equal(text.includes(CANARY), false);
  const vm = view(text, { includeProbeRuns: true });
  assert.equal(vm.state, 'valid');
  assert.equal(JSON.stringify(vm).includes(CANARY), false);
});

test('the view model holds no titles, URLs or markup', () => {
  const vm = view(summaryText());
  const serialized = JSON.stringify(vm);
  assert.equal(serialized.includes('synthetic login'), false);
  assert.doesNotMatch(serialized, /https?:|[<>]|javascript:/i);
});

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

test('view models are deterministic and independent of key order', () => {
  const text = summaryText(flakyReport());
  const filters: DashboardFilters = {
    projects: ['firefox', 'chromium'],
    outcomes: ['passed', 'flaky'],
  };
  const first = view(text, filters);
  assert.deepEqual(view(text, filters), first);
  assert.deepEqual(view(JSON.stringify(reorderKeys(JSON.parse(text))), filters), first);
  assert.deepEqual(
    view(text, { projects: ['chromium', 'firefox'], outcomes: ['flaky', 'passed'] }),
    first,
  );
});

test('rows, projects, notices and violations are sorted deterministically', () => {
  const vm = view(summaryText());
  const ids = data(vm.explorer).map((r) => r.instanceId);
  assert.deepEqual(ids, [...ids].sort());
  const projects = data(vm.projects).map((p) => p.project);
  assert.deepEqual(projects, [...projects].sort());
  assert.deepEqual(vm.notices, [...vm.notices].sort());
  const shuffled = edited(summaryText(), (root) => {
    (root['instances'] as unknown[]).reverse();
    (root['projects'] as unknown[]).reverse();
  });
  const fromShuffled = view(shuffled);
  assert.deepEqual(fromShuffled.explorer, vm.explorer);
  assert.deepEqual(fromShuffled.projects, vm.projects);
});

test('buildViewModel does not mutate its input', () => {
  const parsed = parseSummary(summaryText(flakyReport()));
  const before = JSON.stringify(parsed);
  buildViewModel(parsed, { projects: ['chromium'] });
  assert.equal(JSON.stringify(parsed), before);
});
