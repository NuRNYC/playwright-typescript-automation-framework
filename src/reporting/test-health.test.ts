/**
 * Unit tests for the test-health model and Markdown rendering (ADR-0012, C1).
 *
 * Same conventions as the other unit tests (ADR-0002). Every summary is
 * synthetic: built from the shared report fixtures through the committed
 * normalizer and strict parser, so the tests exercise the real counting
 * semantics. No artifact, network, environment or clock is used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANARY,
  SYNTHETIC_SHA,
  SYNTHETIC_TIME,
  attempt,
  canaryReport,
  context,
  passing,
  report,
  spec,
  testEntry,
  type SyntheticSpec,
} from './fixtures.ts';
import { normalize } from './quality-summary.ts';
import { parseSummary, type ParsedSummary } from './dashboard-model.ts';
import {
  COLUMN_OF,
  OUTCOME_COLUMNS,
  escapeMarkdown,
  groupOf,
  healthModel,
  renderHealthMarkdown,
  type HealthContext,
  type HealthModel,
  type PlaywrightSection,
  type Row,
  type UnitEvidence,
  type UnitResults,
} from './test-health.ts';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const RUN = { runId: 1_000_001, runAttempt: 1, sourceSha: SYNTHETIC_SHA };
const GENERATED = '2026-11-28T12:00:00.000Z';
const CI: HealthContext = { mode: 'ci', generatedAt: GENERATED, ...RUN };
const LOCAL: HealthContext = { mode: 'local', generatedAt: GENERATED };
const BROWSERS = ['chromium', 'firefox', 'webkit'];
const AUTHENTICATED = BROWSERS.map((b) => `${b}-authenticated`);

/** Normalizes, serializes and strictly parses a synthetic report. */
function parsed(
  specs: readonly SyntheticSpec[],
  overrides: Record<string, unknown> = {},
): ParsedSummary {
  const summary = normalize(report(specs), context(overrides));
  return parseSummary(JSON.stringify(summary));
}

function unit(
  overrides: Partial<UnitResults['counts']> = {},
  provenance: UnitResults['provenance'] = { mode: 'ci', ...RUN },
): UnitResults {
  return {
    kind: 'unit-results',
    provenance,
    counts: {
      tests: 10,
      passed: 10,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
      suites: 0,
      ...overrides,
    },
    execution: { startedAt: SYNTHETIC_TIME, finishedAt: '2026-11-25T00:00:30.000Z' },
  };
}

function model(
  playwright: ParsedSummary,
  unitEvidence: UnitEvidence = unit(),
  ctx: HealthContext = CI,
): HealthModel {
  const result = healthModel(playwright, unitEvidence, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.model;
}

function available(section: PlaywrightSection) {
  assert.notEqual(section.state, 'unavailable', JSON.stringify(section));
  if (section.state === 'unavailable') throw new Error('unreachable');
  return section;
}

function rowOf(section: PlaywrightSection, id: Row['id']): Row {
  const r = available(section).rows.find((x) => x.id === id);
  assert.ok(r, id);
  return r;
}

/** A small run with every test group, shaped like the repository. */
function baselineSpecs(): SyntheticSpec[] {
  return [
    spec('ui/dashboard.spec.ts', 10, 'synthetic dashboard a', BROWSERS.map(passing)),
    spec('ui/dashboard-publication.spec.ts', 11, 'synthetic dashboard b', BROWSERS.map(passing)),
    spec('ui/dashboard-demo.spec.ts', 12, 'synthetic dashboard c', BROWSERS.map(passing)),
    spec('ui/dashboard.a11y.spec.ts', 13, 'synthetic dashboard a11y', [passing('chromium')]),
    spec('ui/login.spec.ts', 14, 'synthetic login', BROWSERS.map(passing)),
    spec('ui/login.a11y.spec.ts', 15, 'synthetic login a11y', [passing('chromium')]),
    spec('ui/authenticated/cart.spec.ts', 16, 'synthetic cart', AUTHENTICATED.map(passing)),
    spec('ui/authenticated/inventory.a11y.spec.ts', 17, 'synthetic inventory a11y', [
      passing('chromium-authenticated'),
    ]),
    spec('api/products.spec.ts', 18, 'synthetic api a', [passing('api')]),
    spec('api/products.spec.ts', 19, 'synthetic api b', [passing('api')]),
    spec('auth.setup.ts', 20, 'synthetic setup', [passing('setup')]),
  ];
}

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */

test('groups are exact file paths and every other path is Unclassified', () => {
  const members: [string, string][] = [
    ['tests/ui/dashboard.spec.ts', 'dashboard-functional'],
    ['tests/ui/dashboard-publication.spec.ts', 'dashboard-functional'],
    ['tests/ui/dashboard-demo.spec.ts', 'dashboard-functional'],
    ['tests/ui/dashboard.a11y.spec.ts', 'dashboard-accessibility'],
    ['tests/ui/login.spec.ts', 'application-ui'],
    ['tests/ui/login.a11y.spec.ts', 'application-ui'],
    ['tests/ui/authenticated/cart.spec.ts', 'application-ui'],
    ['tests/ui/authenticated/inventory.a11y.spec.ts', 'application-ui'],
    ['tests/api/products.spec.ts', 'synthetic-stub-api'],
    ['tests/auth.setup.ts', 'authentication-setup'],
  ];
  for (const [file, group] of members) assert.equal(groupOf(file), group, file);
  for (const near of [
    'ui/dashboard.spec.ts',
    'tests/ui/dashboard-extra.spec.ts',
    'tests/ui/dashboard.a11y.spec.tsx',
    'tests/ui/dashboard.spec.ts.bak',
    'tests/ui/logout.spec.ts',
    'tests/ui/authenticated/nested/cart.spec.ts',
    'tests/ui/authenticated/cart.test.ts',
    'tests/api/nested/products.spec.ts',
    'tests/api/products.test.ts',
    'tests/auth.setup.js',
    'TESTS/UI/DASHBOARD.SPEC.TS',
  ]) {
    assert.equal(groupOf(near), 'unclassified', near);
  }
  assert.equal(groupOf(null), 'unclassified');
});

test('every normalizer outcome maps to exactly one column', () => {
  for (const column of Object.values(COLUMN_OF)) assert.ok(OUTCOME_COLUMNS.includes(column));
  assert.deepEqual(
    Object.entries(COLUMN_OF)
      .filter(([, c]) => c === 'other')
      .map(([o]) => o)
      .sort(),
    ['expected-failure', 'interrupted', 'unclassified', 'unexpected-pass'],
  );
});

/* ------------------------------------------------------------------ *
 * Totals, subtotals and setup
 * ------------------------------------------------------------------ */

test('the browser subtotal, API, Playwright total, setup and raw totals stay separate', () => {
  const m = model(parsed(baselineSpecs()));
  const section = available(m.playwright);
  assert.equal(section.state, 'complete');
  const pick = (id: Row['id']) => {
    const r = rowOf(m.playwright, id);
    return [r.definitions.known ? r.definitions.value : -1, r.instances, r.executions];
  };
  assert.deepEqual(pick('dashboard-functional'), [3, 9, 9]);
  assert.deepEqual(pick('dashboard-accessibility'), [1, 1, 1]);
  assert.deepEqual(pick('application-ui'), [4, 8, 8]);
  assert.deepEqual(pick('browser-subtotal'), [8, 18, 18]);
  assert.deepEqual(pick('synthetic-stub-api'), [2, 2, 2]);
  assert.deepEqual(pick('playwright-total'), [10, 20, 20]);
  assert.deepEqual(pick('authentication-setup'), [1, 1, 1]);
  assert.deepEqual(pick('unclassified'), [0, 0, 0]);
  assert.deepEqual(pick('raw-total'), [11, 21, 21]);
  // The API group is never part of the browser subtotal, and no row is counted twice.
  assert.equal(rowOf(m.playwright, 'browser-subtotal').outcomes.passed, 18);
  assert.equal(rowOf(m.playwright, 'playwright-total').outcomes.passed, 20);
  assert.equal(rowOf(m.playwright, 'raw-total').outcomes.passed, 21);
  // Unit counts never enter Playwright rows.
  assert.equal(m.unit.state, 'complete');
});

test('a duplicated setup execution stays one instance and never enters test totals', () => {
  const specs = baselineSpecs();
  specs.push(spec('auth.setup.ts', 20, 'synthetic setup', [passing('setup')]));
  const m = model(parsed(specs));
  const setup = rowOf(m.playwright, 'authentication-setup');
  assert.equal(setup.instances, 1);
  assert.equal(setup.executions, 2);
  assert.deepEqual(rowOf(m.playwright, 'playwright-total').executions, 20);
  assert.deepEqual(rowOf(m.playwright, 'raw-total').executions, 22);
  assert.equal(available(m.playwright).state, 'complete');
});

/* ------------------------------------------------------------------ *
 * Outcomes, retries and failures
 * ------------------------------------------------------------------ */

test('retries, flaky results, failures and every outcome are counted once per execution', () => {
  const specs = [
    ...baselineSpecs(),
    spec('ui/dashboard.spec.ts', 30, 'synthetic flaky', [
      testEntry('chromium', 'flaky', [attempt('failed'), attempt('passed', 1)]),
    ]),
    spec('ui/dashboard.spec.ts', 31, 'synthetic failed', [
      testEntry('chromium', 'unexpected', [
        attempt('failed'),
        attempt('failed', 1),
        attempt('failed', 2),
      ]),
    ]),
    spec('ui/dashboard.spec.ts', 32, 'synthetic timeout', [
      testEntry('chromium', 'unexpected', [attempt('timedOut')]),
    ]),
    spec('ui/dashboard.spec.ts', 33, 'synthetic skipped', [
      testEntry('chromium', 'skipped', [attempt('skipped')], 'skipped'),
    ]),
    spec('ui/dashboard.spec.ts', 34, 'synthetic not run', [testEntry('chromium', 'skipped', [])]),
    spec('ui/dashboard.spec.ts', 35, 'synthetic interrupted', [
      testEntry('chromium', 'skipped', [attempt('interrupted')]),
    ]),
    spec('ui/dashboard.spec.ts', 36, 'synthetic expected failure', [
      testEntry('chromium', 'expected', [attempt('failed')], 'failed'),
    ]),
    spec('ui/dashboard.spec.ts', 37, 'synthetic unexpected pass', [
      testEntry('chromium', 'unexpected', [attempt('passed')], 'failed'),
    ]),
  ];
  const m = model(parsed(specs));
  // Failed tests are outcomes: the evidence itself is still complete.
  assert.equal(available(m.playwright).state, 'complete');
  const row = rowOf(m.playwright, 'dashboard-functional');
  assert.equal(row.instances, 9 + 8);
  assert.equal(row.executions, 9 + 8);
  assert.equal(row.attempts, 9 + 2 + 3 + 1 + 1 + 0 + 1 + 1 + 1);
  assert.equal(row.retries, 1 + 2);
  assert.deepEqual(row.outcomes, {
    passed: 9,
    flaky: 1,
    failed: 1,
    'timed-out': 1,
    skipped: 1,
    'did-not-run': 1,
    other: 3,
  });
  const sum = OUTCOME_COLUMNS.reduce((n, c) => n + row.outcomes[c], 0);
  assert.equal(sum, row.executions);
});

test('totals that do not reconcile make the Playwright values unavailable', () => {
  const good = parsed(baselineSpecs());
  assert.equal(good.state, 'valid');
  if (good.state !== 'valid') return;
  const s = good.validated.summary;
  const totals = s.totals;
  assert.ok(totals !== null);
  const tampered = (patch: Partial<NonNullable<typeof totals>>): ParsedSummary => ({
    ...good,
    validated: { ...good.validated, summary: { ...s, totals: { ...totals, ...patch } } },
  });
  for (const patch of [
    { executions: totals.executions + 1 },
    { instances: totals.instances - 1 },
    { attempts: totals.attempts + 1 },
    { retries: totals.retries + 1 },
    { definitions: totals.definitions + 1 },
    { byExecutionOutcome: { ...totals.byExecutionOutcome, passed: 0, failed: totals.executions } },
  ]) {
    const m = model(tampered(patch));
    assert.deepEqual(m.playwright, { state: 'unavailable', reason: 'totals-do-not-reconcile' });
    assert.equal(m.unit.state, 'complete');
  }
});

/* ------------------------------------------------------------------ *
 * Missing, partial and independent evidence
 * ------------------------------------------------------------------ */

test('each section is evaluated independently when the other is missing', () => {
  const noPlaywright = model({ state: 'no-summary' });
  assert.deepEqual(noPlaywright.playwright, { state: 'unavailable', reason: 'summary-missing' });
  assert.equal(noPlaywright.unit.state, 'complete');
  const noUnit = model(parsed(baselineSpecs()), {
    kind: 'unavailable',
    reason: 'unit-results-missing',
  });
  assert.deepEqual(noUnit.unit, { state: 'unavailable', reason: 'unit-results-missing' });
  assert.equal(available(noUnit.playwright).state, 'complete');
  assert.deepEqual(model({ state: 'invalid', problem: 'invalid-json', path: null }).playwright, {
    state: 'unavailable',
    reason: 'summary-invalid',
  });
  assert.deepEqual(
    model({ state: 'schema-mismatch', foundMajor: 2, supportedMajor: 1 }).playwright,
    { state: 'unavailable', reason: 'summary-schema-mismatch' },
  );
  const markdown = renderHealthMarkdown(noPlaywright);
  assert.match(
    markdown,
    /### Playwright tests \(quality summary\)\n\n\*\*Unavailable\*\* — `summary-missing`\./,
  );
  assert.match(markdown, /\| 10 \| 10 \| 0 \| 0 \| 0 \| 0 \| 0 \|/);
});

test('an unavailable summary is never shown as zero tests', () => {
  const m = model(parsed(baselineSpecs(), { reportState: 'report-missing' }));
  assert.deepEqual(m.playwright, { state: 'unavailable', reason: 'summary-test-data-unavailable' });
  assert.doesNotMatch(renderHealthMarkdown(m), /Playwright total/);
});

test('partial evidence keeps its values and names fixed reasons', () => {
  const gate = model(
    parsed(baselineSpecs(), {
      gateInputs: {
        CHECKS: 'success',
        SHARDS: 'failure',
        INVENTORY: 'success',
        DOWNLOAD_1: 'success',
        DOWNLOAD_2: 'success',
        VERIFY: 'success',
        MERGE: 'success',
        UPLOAD: 'success',
      },
    }),
  );
  const section = available(gate.playwright);
  assert.equal(section.state, 'partial');
  assert.deepEqual(section.reasons, ['gate-input-not-success']);
  assert.equal(rowOf(gate.playwright, 'playwright-total').executions, 20);

  // A group with no reported results is shown as "none reported", not a clean zero.
  const noApi = model(parsed(baselineSpecs().filter((s) => s.file !== 'api/products.spec.ts')));
  const noApiSection = available(noApi.playwright);
  assert.equal(noApiSection.state, 'partial');
  assert.deepEqual(noApiSection.missingGroups, ['synthetic-stub-api']);
  assert.ok(noApiSection.reasons.includes('groups-not-reported'));
  assert.equal(rowOf(noApi.playwright, 'synthetic-stub-api').reported, false);
  assert.match(renderHealthMarkdown(noApi), /\| Synthetic-stub API \| none reported \|/);
});

test('Unclassified files and unresolved identities make the evidence partial', () => {
  const unclassified = model(
    parsed([
      ...baselineSpecs(),
      spec('ui/unknown-area.spec.ts', 40, 'synthetic unknown', [passing('chromium')]),
    ]),
  );
  const u = available(unclassified.playwright);
  assert.equal(u.state, 'partial');
  assert.ok(u.reasons.includes('unclassified-files'));
  assert.equal(rowOf(unclassified.playwright, 'unclassified').executions, 1);
  assert.equal(rowOf(unclassified.playwright, 'playwright-total').executions, 20);
  assert.equal(rowOf(unclassified.playwright, 'raw-total').executions, 22);

  const unresolved = model(
    parsed([
      ...baselineSpecs(),
      spec('ui/dashboard.spec.ts', -1, 'synthetic no location', [passing('chromium')]),
    ]),
  );
  const r = available(unresolved.playwright);
  assert.equal(r.state, 'partial');
  assert.ok(r.reasons.includes('unresolved-identities'), JSON.stringify(r.reasons));
  // No definition count is invented for the unresolved result or any total containing it.
  for (const id of [
    'dashboard-functional',
    'browser-subtotal',
    'playwright-total',
    'raw-total',
  ] as const) {
    assert.equal(rowOf(unresolved.playwright, id).definitions.known, false, id);
  }
  // Groups without the unresolved result keep their known definition counts.
  assert.deepEqual(rowOf(unresolved.playwright, 'synthetic-stub-api').definitions, {
    known: true,
    value: 2,
  });
  assert.match(renderHealthMarkdown(unresolved), /\| Raw summary totals \| unknown \|/);
});

test('unit evidence: failures are complete, inconsistency and cancellation are partial', () => {
  assert.equal(
    model({ state: 'no-summary' }, unit({ passed: 8, failed: 2 })).unit.state,
    'complete',
  );
  const mismatch = model({ state: 'no-summary' }, unit({ passed: 9 })).unit;
  assert.equal(mismatch.state, 'partial');
  assert.ok(
    mismatch.state === 'partial' && mismatch.reasons.includes('unit-counts-do-not-reconcile'),
  );
  const cancelled = model({ state: 'no-summary' }, unit({ passed: 9, cancelled: 1 })).unit;
  assert.ok(
    cancelled.state === 'partial' &&
      cancelled.reasons.includes('unit-cancelled-semantics-unverified'),
  );
  assert.deepEqual(model({ state: 'no-summary' }, unit({ failed: -1 })).unit, {
    state: 'unavailable',
    reason: 'unit-results-invalid',
  });
  assert.deepEqual(model({ state: 'no-summary' }, unit({ tests: 1.5 })).unit, {
    state: 'unavailable',
    reason: 'unit-results-invalid',
  });
});

test('unit output keeps only allow-listed fields; extra runtime properties never survive', () => {
  const base = unit();
  const leaky = {
    ...base,
    [CANARY]: CANARY,
    titles: [CANARY],
    counts: { ...base.counts, [CANARY]: CANARY, extraCount: CANARY },
    execution: { startedAt: SYNTHETIC_TIME, finishedAt: SYNTHETIC_TIME, path: `/home/${CANARY}` },
  } as unknown as UnitResults;
  const m = model(parsed(baselineSpecs()), leaky);
  assert.equal(m.unit.state, 'complete');
  assert.deepEqual(Object.keys(m.unit.counts).sort(), [
    'cancelled',
    'failed',
    'passed',
    'skipped',
    'suites',
    'tests',
    'todo',
  ]);
  assert.deepEqual(m.unit.execution, { startedAt: SYNTHETIC_TIME, finishedAt: SYNTHETIC_TIME });
  const json = JSON.stringify(m);
  const markdown = renderHealthMarkdown(m);
  for (const text of [json, markdown]) {
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes('extraCount'), false);
    assert.equal(text.includes('/home/'), false);
  }
});

test('an inverted unit execution interval is invalid; equal instants are valid', () => {
  const at = (startedAt: string, finishedAt: string): UnitResults => ({
    ...unit(),
    execution: { startedAt, finishedAt },
  });
  const inverted = model(
    parsed(baselineSpecs()),
    at('2026-11-25T00:00:30.000Z', '2026-11-25T00:00:29.999Z'),
  );
  assert.deepEqual(inverted.unit, { state: 'unavailable', reason: 'unit-results-invalid' });
  // Usable Playwright evidence is not hidden by invalid unit evidence.
  assert.equal(available(inverted.playwright).state, 'complete');
  const equal = model({ state: 'no-summary' }, at(SYNTHETIC_TIME, SYNTHETIC_TIME));
  assert.equal(equal.unit.state, 'complete');
  // The interval is the reporter's own; it is not compared with the generation time.
  const afterGeneration = model(
    { state: 'no-summary' },
    at('2026-12-01T00:00:00.000Z', '2026-12-01T00:00:01.000Z'),
  );
  assert.equal(afterGeneration.unit.state, 'complete');
});

/* ------------------------------------------------------------------ *
 * Provenance
 * ------------------------------------------------------------------ */

test('inputs whose provenance conflicts are not combined', () => {
  const summary = parsed(baselineSpecs());
  for (const other of [
    { ...CI, runId: 1_000_002 },
    { ...CI, runAttempt: 2 },
    { ...CI, sourceSha: 'f'.repeat(40) },
  ]) {
    const m = model(summary, unit(), other);
    assert.deepEqual(m.playwright, { state: 'unavailable', reason: 'provenance-mismatch' });
    assert.deepEqual(m.unit, { state: 'unavailable', reason: 'provenance-mismatch' });
  }
  const mixed = model(summary, unit({}, { mode: 'ci', ...RUN, runAttempt: 2 }));
  assert.equal(available(mixed.playwright).state, 'complete');
  assert.deepEqual(mixed.unit, { state: 'unavailable', reason: 'provenance-mismatch' });
  assert.deepEqual(model(summary, unit({}, { mode: 'local' })).unit, {
    state: 'unavailable',
    reason: 'provenance-mismatch',
  });
});

test('local mode accepts only local evidence and is labelled local', () => {
  const m = model(parsed(baselineSpecs()), unit({}, { mode: 'local' }), LOCAL);
  assert.equal(m.mode, 'local');
  assert.equal(m.run, null);
  assert.equal(m.unit.state, 'complete');
  assert.deepEqual(m.playwright, { state: 'unavailable', reason: 'not-local-evidence' });
  assert.deepEqual(model({ state: 'no-summary' }, unit(), LOCAL).unit, {
    state: 'unavailable',
    reason: 'not-local-evidence',
  });
  const markdown = renderHealthMarkdown(m);
  assert.match(markdown, /^## Test health — LOCAL output, not CI evidence/);
  assert.doesNotMatch(markdown, /Run ID|Source commit/);
});

test('an invalid context is refused', () => {
  const summary = parsed(baselineSpecs());
  for (const ctx of [
    { ...CI, sourceSha: 'ABC' },
    { ...CI, runId: 0 },
    { ...CI, runAttempt: 1.5 },
    { ...CI, generatedAt: '2026-11-28' },
    { ...CI, generatedAt: '2026-02-30T00:00:00.000Z' },
    { ...LOCAL, generatedAt: 'now' },
  ]) {
    assert.deepEqual(healthModel(summary, unit(), ctx), { ok: false, problem: 'invalid-context' });
  }
});

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

test('CI rendering is deterministic, labelled a diagnostic and makes no verdict or freshness claim', () => {
  const m = model(parsed(baselineSpecs()));
  const markdown = renderHealthMarkdown(m);
  assert.equal(markdown, renderHealthMarkdown(model(parsed(baselineSpecs()))));
  assert.match(markdown, /^## Test health — CI diagnostic\n\nNot an ADR-0012 README snapshot\./);
  assert.match(markdown, new RegExp(`\\| Source commit \\| \`${SYNTHETIC_SHA}\` \\|`));
  assert.match(
    markdown,
    /No Gate verdict is derived from this data, and freshness is not assessed\./,
  );
  assert.match(markdown, /Workflow conclusion and completion time are not available/);
  assert.match(
    markdown,
    /\| Playwright total \(excluding setup\) \| 10 \| 20 \| 20 \| 20 \| 0 \| 20 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \|/,
  );
  assert.match(markdown, /\(report generation, not execution\)/);
  for (const forbidden of [
    'tests/',
    'synthetic dashboard',
    'VERIFIED',
    'snapshot of',
    'current HEAD',
  ]) {
    assert.equal(markdown.includes(forbidden), false, forbidden);
  }
});

test('rendered output never contains per-test content or canary values', () => {
  const summary = normalize(canaryReport(), context());
  const m = model(parseSummary(JSON.stringify(summary)));
  const markdown = renderHealthMarkdown(m);
  assert.equal(markdown.includes(CANARY), false);
  assert.equal(JSON.stringify(m).includes(CANARY), false);
  assert.equal(/\/home\/|\/Users\//.test(markdown), false);
});

test('Markdown escaping neutralizes table, HTML and code characters', () => {
  assert.equal(escapeMarkdown('a|b<c>&`d`\n*e*'), 'a\\|b\\<c\\>\\&\\`d\\` \\*e\\*');
});
