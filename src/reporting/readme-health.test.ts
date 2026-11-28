/**
 * Unit tests for the README health section renderer and marker handling
 * (ADR-0013, Phase C5A). Pure: no filesystem, network or clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  README_CONTRACT_VERSION,
  SECTION_END,
  SECTION_START,
  compareMetrics,
  isCalendarInstant,
  locateSection,
  markdownTable,
  metricIdentity,
  metricsDigest,
  metricsEqual,
  parseMetricsDigest,
  parseSnapshotPin,
  renderReadmeSection,
  replaceSection,
  wrap,
  type ReadmeSnapshotInput,
} from './readme-health.ts';
import { REFRESH_POLICY, decideRefresh } from './refresh-decision.ts';
import type { HealthModel, OutcomeColumn, Row } from './test-health.ts';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const SHA = '305665bd54df997d7040078e7e57becf83f86b0c';
const REPO = 'NuRNYC/playwright-typescript-automation-framework';
const VERIFIED = { verdict: 'VERIFIED_PASS', summary: 'SUMMARY_VERIFIED_ORIGIN' } as const;

/** The committed README section at C4 (run 46162493309, attempt 1), byte for byte. */
const C4_SECTION = [
  '',
  '**Historical CI snapshot — manually maintained; does not describe current HEAD.**',
  '',
  '| Source       | Value                                                                                                                                                 |',
  '| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |',
  '| Commit       | `305665bd54df997d7040078e7e57becf83f86b0c`                                                                                                            |',
  '| CI run       | [46162493309, attempt 1](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/runs/46162493309/attempts/1) (`push` to `main`) |',
  '| Completed    | 2026-11-28T16:00:29Z                                                                                                                                  |',
  '| Gate verdict | `VERIFIED_PASS`, from the ADR-0010 local operator                                                                                                     |',
  '| Prepared     | 2026-11-28                                                                                                                                            |',
  '',
  'Unit tests (`node:test`, `checks` job of that run):',
  '',
  '| Total | Passed | Failed | Cancelled | Skipped | Todo |',
  '| ----- | ------ | ------ | --------- | ------- | ---- |',
  '| 924   | 924    | 0      | 0         | 0       | 0    |',
  '',
  'Playwright tests (quality summary of that run):',
  '',
  '| Group                                  | Definitions | Instances | Executions | Passed  |',
  '| -------------------------------------- | ----------- | --------- | ---------- | ------- |',
  '| Dashboard functional                   | 28          | 84        | 84         | 84      |',
  '| Dashboard accessibility                | 17          | 17        | 17         | 17      |',
  '| Application UI (Sauce Demo)            | 15          | 41        | 41         | 41      |',
  '| _Browser subtotal_                     | _60_        | _142_     | _142_      | _142_   |',
  '| Synthetic-stub API                     | 6           | 6         | 6          | 6       |',
  '| **Playwright total (excluding setup)** | **66**      | **148**   | **148**    | **148** |',
  '',
  'All 148 executions passed. Every other execution outcome was zero in every',
  'row: flaky, failed, timed out, skipped, did not run, and other (interrupted,',
  'unexpected pass, expected failure, unclassified). Retries were zero, and no',
  'evidence was partial or missing.',
  '',
  '- The browser subtotal sums the three browser groups. The Playwright total',
  '  adds synthetic-stub API tests to that subtotal. Subtotal and total rows are',
  '  not additional tests.',
  '- A definition is one test as the runner reports it (each generated or',
  '  parameterized test counts separately); an instance is that test in one',
  '  configured Playwright project (browser or `api`); an execution is an actual',
  '  reported run of an instance.',
  '- The authentication setup is excluded: it had one definition and one',
  '  execution in this run, so the raw summary totals are 67 definitions and 149',
  '  instances and executions. No result was unclassified.',
  "- Synthetic-stub API results cover the framework's API client against a local",
  '  synthetic stub, not a production API.',
  '- These groups are not labelled regression coverage, and execution counts are',
  '  not requirement coverage.',
  '',
  'The quality summary itself records no Gate verdict; the verdict above comes',
  'from the separate ADR-0010 operator. Freshness is not checked automatically:',
  'a reviewer assesses it when the snapshot is updated by pull request. Counting',
  'rules, evidence, retention and freshness policy:',
  '[ADR-0012](docs/adr/0012-readme-test-automation-health.md).',
  '',
  '',
].join('\n');

function outcomes(values: Partial<Record<OutcomeColumn, number>>): Record<OutcomeColumn, number> {
  return {
    passed: 0,
    flaky: 0,
    failed: 0,
    'timed-out': 0,
    skipped: 0,
    'did-not-run': 0,
    other: 0,
    ...values,
  };
}

function row(
  id: Row['id'],
  definitions: number,
  executions: number,
  extra: {
    instances?: number;
    retries?: number;
    outcomes?: Partial<Record<OutcomeColumn, number>>;
  } = {},
): Row {
  return {
    id,
    reported: true,
    definitions: { known: true, value: definitions },
    instances: extra.instances ?? executions,
    executions,
    attempts: executions + (extra.retries ?? 0),
    retries: extra.retries ?? 0,
    outcomes: outcomes(extra.outcomes ?? { passed: executions }),
  };
}

function c4Rows(): Row[] {
  return [
    row('dashboard-functional', 28, 84),
    row('dashboard-accessibility', 17, 17),
    row('application-ui', 15, 41),
    row('synthetic-stub-api', 6, 6),
    row('authentication-setup', 1, 1),
    { ...row('unclassified', 0, 0), reported: false },
    row('browser-subtotal', 60, 142),
    row('playwright-total', 66, 148),
    row('raw-total', 67, 149),
  ];
}

function model(overrides: Partial<HealthModel> = {}, rows: Row[] = c4Rows()): HealthModel {
  return {
    kind: 'test-health',
    modelVersion: '1.0.0',
    mode: 'ci',
    run: { runId: 46162493309, runAttempt: 1, sourceSha: SHA, event: 'push', branchClass: 'main' },
    generatedAt: '2026-11-28T16:00:25.379Z',
    unit: {
      state: 'complete',
      reasons: [],
      nodeVersion: 'v24.22.3',
      counts: { tests: 924, passed: 924, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 },
      execution: { startedAt: '2026-11-28T15:57:02.143Z', finishedAt: '2026-11-28T15:57:38.222Z' },
    },
    playwright: {
      state: 'complete',
      reasons: [],
      missingGroups: [],
      rows,
      summaryGeneratedAt: '2026-11-28T16:00:12.243Z',
    },
    ...overrides,
  };
}

function input(overrides: Partial<ReadmeSnapshotInput> = {}): ReadmeSnapshotInput {
  return {
    repository: 'NuRNYC/playwright-typescript-automation-framework',
    completedAt: '2026-11-28T16:00:29Z',
    verdict: 'VERIFIED_PASS',
    summary: 'SUMMARY_VERIFIED_ORIGIN',
    verdictSource: 'local-operator',
    preparedOn: '2026-11-28',
    maintenance: 'manual',
    model: model(),
    ...overrides,
  };
}

/** Collapses line wrapping so phrases can be matched across lines. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function rendered(overrides: Partial<ReadmeSnapshotInput> = {}): string {
  const result = renderReadmeSection(input(overrides));
  assert.ok(result.ok, JSON.stringify(result));
  return result.section;
}

const README = `# Title\n\n## Test Automation Health\n\n${SECTION_START}\n${C4_SECTION}${SECTION_END}\n\n## Next\n`;

/* ------------------------------------------------------------------ *
 * Markers
 * ------------------------------------------------------------------ */

test('locates exactly one marker pair and splits the text without loss', () => {
  const located = locateSection(README);
  assert.ok(located.ok);
  assert.equal(located.section, C4_SECTION);
  assert.equal(located.before + located.section + located.after, README);
  assert.ok(located.before.endsWith(`${SECTION_START}\n`));
  assert.ok(located.after.startsWith(SECTION_END));
});

test('replacement preserves every byte outside the marker pair', () => {
  const replaced = replaceSection(README, 'new\n');
  assert.ok(replaced.ok);
  assert.equal(replaced.changed, true);
  assert.equal(
    replaced.text,
    `# Title\n\n## Test Automation Health\n\n${SECTION_START}\nnew\n${SECTION_END}\n\n## Next\n`,
  );
});

test('replacing with identical content reports no change', () => {
  const replaced = replaceSection(README, C4_SECTION);
  assert.deepEqual(replaced, { ok: true, text: README, changed: false });
});

test('CRLF marker lines are accepted and kept as they were', () => {
  const crlf = `a\r\n${SECTION_START}\r\nold\r\n${SECTION_END}\r\nb\r\n`;
  const replaced = replaceSection(crlf, 'new\n');
  assert.ok(replaced.ok);
  assert.equal(replaced.text, `a\r\n${SECTION_START}\r\nnew\n${SECTION_END}\r\nb\r\n`);
});

test('an empty section is allowed', () => {
  const replaced = replaceSection(README, '');
  assert.ok(replaced.ok);
  assert.ok(replaced.text.includes(`${SECTION_START}\n${SECTION_END}`));
});

test('malformed marker layouts are refused with a fixed problem', () => {
  const cases: [string, string][] = [
    ['no markers\n', 'start-missing'],
    [`${SECTION_START}\nx\n`, 'end-missing'],
    [`x\n${SECTION_END}\n`, 'start-missing'],
    [`${SECTION_START}\n${SECTION_START}\nx\n${SECTION_END}\n`, 'start-duplicated'],
    [`${SECTION_START}\nx\n${SECTION_END}\n${SECTION_END}\n`, 'end-duplicated'],
    [
      `${SECTION_START}\na\n${SECTION_START}\nb\n${SECTION_END}\nc\n${SECTION_END}\n`,
      'start-duplicated',
    ],
    [`${SECTION_END}\nx\n${SECTION_START}\n`, 'end-before-start'],
    [`${SECTION_START}\nx\n<!-- test-health:stop -->\n`, 'marker-malformed'],
    [`<!-- test-health:begin -->\n${SECTION_START}\nx\n${SECTION_END}\n`, 'marker-malformed'],
    [`text ${SECTION_START}\nx\n${SECTION_END}\n`, 'marker-not-on-own-line'],
    [`${SECTION_START} trailing\nx\n${SECTION_END}\n`, 'marker-not-on-own-line'],
    [`${SECTION_START}\nx\n${SECTION_END}`, 'marker-not-on-own-line'],
  ];
  for (const [text, problem] of cases) {
    assert.deepEqual(locateSection(text), { ok: false, problem }, JSON.stringify(text));
    assert.deepEqual(replaceSection(text, 'y\n'), { ok: false, problem }, JSON.stringify(text));
  }
});

test('a replacement section is refused if it carries markers, CR or no final newline', () => {
  assert.deepEqual(replaceSection(README, `x\n${SECTION_END}\n`), {
    ok: false,
    problem: 'section-contains-marker',
  });
  assert.deepEqual(replaceSection(README, 'x\r\n'), {
    ok: false,
    problem: 'section-has-carriage-return',
  });
  assert.deepEqual(replaceSection(README, 'x'), {
    ok: false,
    problem: 'section-not-line-terminated',
  });
});

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

test('renders the committed C4 README section byte for byte', () => {
  assert.equal(rendered(), C4_SECTION);
});

test('rendering is deterministic and idempotent through marker replacement', () => {
  assert.equal(rendered(), rendered());
  const replaced = replaceSection(README, rendered());
  assert.deepEqual(replaced, { ok: true, text: README, changed: false });
});

test('tables are padded like Prettier, with a minimum separator width of three', () => {
  assert.equal(
    markdownTable(['A', 'Longer'], [['x', 'y']]),
    '| A   | Longer |\n| --- | ------ |\n| x   | y      |',
  );
});

test('wrap keeps every line within the width, counting the continuation indent', () => {
  const text = wrap(`- ${'word '.repeat(40).trim()}`, 20, '  ');
  for (const line of text.split('\n')) assert.ok(line.length <= 20, line);
  assert.ok(
    text
      .split('\n')
      .slice(1)
      .every((line) => line.startsWith('  ')),
  );
});

test('automation-maintained snapshots disclose how they are refreshed', () => {
  const section = rendered({ maintenance: 'reviewed-automation-pr', verdictSource: 'ci-operator' });
  assert.ok(
    flat(section).includes('refreshed by reviewed pull request; does not describe current HEAD'),
  );
  assert.ok(section.includes('`VERIFIED_PASS`, from the ADR-0010 operator in CI'));
  assert.ok(flat(section).includes('checked by the refresh automation'));
  assert.ok(!section.includes('manually maintained'));
  for (const line of section.split('\n')) {
    // Prose wraps at 78 columns; tables, the banner, the ADR link and the digest are single lines.
    if (!/^(\||\*\*|\[|<!--)/.test(line)) assert.ok(line.length <= 78, line);
  }
});

test('non-zero outcomes and retries get their own columns, never hidden', () => {
  const rows = c4Rows().map((r) =>
    r.id === 'application-ui' || r.id === 'browser-subtotal' || r.id === 'playwright-total'
      ? {
          ...r,
          retries: 2,
          outcomes: outcomes({ passed: r.outcomes.passed - 2, flaky: 2 }),
        }
      : r,
  );
  const section = rendered({ model: model({}, rows) });
  assert.ok(section.includes('| Group'));
  assert.match(section, /\| Retries \| Passed +\| Flaky \|/);
  assert.ok(flat(section).includes('Of 148 executions, 146 passed.'));
  assert.ok(!section.includes('All 148 executions passed'));
  assert.ok(flat(section).includes('Retries (attempts after the first, not additional tests)'));
  assert.ok(!section.includes('Retries were zero'));
});

test('a setup with two executions and unequal raw totals is described exactly', () => {
  const rows = c4Rows().map((r) =>
    r.id === 'authentication-setup'
      ? row('authentication-setup', 1, 2, { instances: 1 })
      : r.id === 'raw-total'
        ? row('raw-total', 67, 150, { instances: 149 })
        : r,
  );
  const section = rendered({ model: model({}, rows) });
  assert.ok(flat(section).includes('one definition and 2 executions'));
  assert.ok(flat(section).includes('67 definitions, 149 instances and 150 executions'));
});

test('only complete VERIFIED_PASS push-to-main CI evidence is rendered', () => {
  const base = model();
  const cases: [Partial<ReadmeSnapshotInput>, string][] = [
    [{ verdict: 'VERIFIED_FAIL' as 'VERIFIED_PASS' }, 'verdict-not-verified-pass'],
    [
      { summary: 'SUMMARY_INFORMATIVE' as 'SUMMARY_VERIFIED_ORIGIN' },
      'summary-not-verified-origin',
    ],
    [{ model: { ...base, mode: 'local', run: null } }, 'model-not-ci'],
    [{ model: { ...base, run: null } }, 'model-run-missing'],
    [
      { model: { ...base, run: { ...base.run!, event: 'pull_request' } } },
      'model-not-push-on-main',
    ],
    [{ model: { ...base, run: { ...base.run!, branchClass: 'other' } } }, 'model-not-push-on-main'],
    [
      { model: { ...base, unit: { state: 'unavailable', reason: 'unit-results-missing' } } },
      'unit-not-complete',
    ],
    [
      { model: { ...base, playwright: { state: 'unavailable', reason: 'summary-missing' } } },
      'playwright-not-complete',
    ],
    [{ repository: 'not a repository' }, 'invalid-repository'],
    [{ completedAt: '2026-11-28T16:00:29.000Z' }, 'invalid-completed-at'],
    [{ completedAt: '2026-02-30T00:00:00Z' }, 'invalid-completed-at'],
    [{ preparedOn: '2026-13-01' }, 'invalid-prepared-on'],
  ];
  for (const [overrides, problem] of cases) {
    assert.deepEqual(renderReadmeSection(input(overrides)), { ok: false, problem }, problem);
  }
});

test('partial evidence, unknown definitions, missing rows and unit failures are refused', () => {
  const base = model();
  if (base.unit.state !== 'complete' || base.playwright.state !== 'complete')
    throw new Error('fixture');
  const partialUnit = { ...base.unit, state: 'partial' as const };
  assert.deepEqual(renderReadmeSection(input({ model: { ...base, unit: partialUnit } })), {
    ok: false,
    problem: 'unit-not-complete',
  });
  const failing = { ...base.unit, counts: { ...base.unit.counts, passed: 923, failed: 1 } };
  assert.deepEqual(renderReadmeSection(input({ model: { ...base, unit: failing } })), {
    ok: false,
    problem: 'unit-not-all-passed',
  });
  const unknown = c4Rows().map((r) =>
    r.id === 'application-ui' ? { ...r, definitions: { known: false as const } } : r,
  );
  assert.deepEqual(renderReadmeSection(input({ model: model({}, unknown) })), {
    ok: false,
    problem: 'definitions-unknown',
  });
  const missing = c4Rows().filter((r) => r.id !== 'synthetic-stub-api');
  assert.deepEqual(renderReadmeSection(input({ model: model({}, missing) })), {
    ok: false,
    problem: 'row-missing',
  });
  const unreported = c4Rows().map((r) =>
    r.id === 'dashboard-functional' ? { ...r, reported: false } : r,
  );
  assert.deepEqual(renderReadmeSection(input({ model: model({}, unreported) })), {
    ok: false,
    problem: 'row-missing',
  });
});

/* ------------------------------------------------------------------ *
 * Reading the pin back
 * ------------------------------------------------------------------ */

test('the pinned source is read back exactly from a rendered section', () => {
  assert.deepEqual(parseSnapshotPin(C4_SECTION, REPO), {
    sourceSha: SHA,
    runId: 46162493309,
    runAttempt: 1,
    completedAt: '2026-11-28T16:00:29Z',
  });
});

test('an inconsistent, malformed or missing pin is not guessed', () => {
  const variants = [
    C4_SECTION.replace('/runs/46162493309/attempts/1', '/runs/46162493309/attempts/2'),
    C4_SECTION.replace('/runs/46162493309/attempts/1', '/runs/46162493310/attempts/1'),
    C4_SECTION.replace(SHA, 'abc'),
    C4_SECTION.replace('2026-11-28T16:00:29Z', 'soon'),
    C4_SECTION.replace('2026-11-28T16:00:29Z', '2026-02-30T16:00:29Z'),
    C4_SECTION.replace('2026-11-28T16:00:29Z', '2026-11-28T24:00:00Z'),
    '',
  ];
  for (const variant of variants) assert.equal(parseSnapshotPin(variant, REPO), undefined);
});

test('a run link to a foreign repository is rejected', () => {
  const foreign = C4_SECTION.replace(
    'github.com/NuRNYC/playwright-typescript-automation-framework/actions',
    'github.com/attacker/playwright-typescript-automation-framework/actions',
  );
  assert.equal(parseSnapshotPin(foreign, REPO), undefined);
  assert.equal(parseSnapshotPin(C4_SECTION, 'someone/else'), undefined);
});

test('duplicate or conflicting pin rows are rejected', () => {
  const lines = C4_SECTION.split('\n');
  const duplicate = (prefix: string, replacement?: [string, string]): string => {
    const index = lines.findIndex((line) => line.startsWith(prefix));
    const line = lines[index] ?? '';
    const copy = replacement === undefined ? line : line.replace(replacement[0], replacement[1]);
    return [...lines.slice(0, index + 1), copy, ...lines.slice(index + 1)].join('\n');
  };
  assert.equal(parseSnapshotPin(duplicate('| Commit'), REPO), undefined);
  assert.equal(parseSnapshotPin(duplicate('| CI run'), REPO), undefined);
  assert.equal(parseSnapshotPin(duplicate('| Completed'), REPO), undefined);
  assert.equal(parseSnapshotPin(duplicate('| Commit', [SHA, 'f'.repeat(40)]), REPO), undefined);
  assert.equal(
    parseSnapshotPin(duplicate('| Completed', ['16:00:29', '16:00:30']), REPO),
    undefined,
  );
});

test('calendar instants are validated as real dates, not by pattern alone', () => {
  assert.equal(isCalendarInstant('2026-11-28T16:00:29Z'), true);
  assert.equal(isCalendarInstant('2028-02-29T00:00:00Z'), true);
  for (const bad of [
    '2026-02-30T00:00:00Z',
    '2027-02-29T00:00:00Z',
    '2026-11-28T24:00:00Z',
    '2026-11-28T16:60:00Z',
    '2026-11-28T16:00:29.000Z',
    '2026-11-28 16:00:29Z',
  ]) {
    assert.equal(isCalendarInstant(bad), false, bad);
  }
});

/* ------------------------------------------------------------------ *
 * Metric identity: structured, provenance-free
 * ------------------------------------------------------------------ */

const OTHER_SHA = 'bf3c489d0665c7119dce98d19c69b25fe61209bf';

/** The same evidence observed by another run of another commit, at another time. */
function reobserved(base: HealthModel, runId: number, sourceSha: string): HealthModel {
  if (base.unit.state === 'unavailable' || base.playwright.state === 'unavailable') {
    throw new Error('fixture');
  }
  return {
    ...base,
    run: { ...base.run!, runId, sourceSha },
    generatedAt: '2026-11-29T09:15:00.000Z',
    unit: {
      ...base.unit,
      nodeVersion: 'v24.22.3',
      execution: { startedAt: '2026-11-29T09:10:00.000Z', finishedAt: '2026-11-29T09:10:40.000Z' },
    },
    playwright: { ...base.playwright, summaryGeneratedAt: '2026-11-29T09:14:50.000Z' },
  };
}

test('provenance and timestamps are not part of the metric identity', () => {
  const a = metricIdentity(model(), VERIFIED);
  const b = metricIdentity(reobserved(model(), 46170000000, OTHER_SHA), VERIFIED);
  assert.equal(metricsEqual(a, b), true);
  assert.equal(metricsDigest(a), metricsDigest(b));
  assert.equal(a.contract, README_CONTRACT_VERSION);
  assert.doesNotMatch(JSON.stringify(a), /46162493309|305665bd|2026-11-28/);
});

test('metrics, outcomes, setup, Unclassified, evidence and verification are meaningful', () => {
  const base = metricIdentity(model(), VERIFIED);
  const changedRows = (id: Row['id'], change: Partial<Row>): HealthModel =>
    model(
      {},
      c4Rows().map((r) => (r.id === id ? { ...r, ...change } : r)),
    );
  const partial = model();
  if (partial.playwright.state === 'unavailable') throw new Error('fixture');
  const variants = [
    metricIdentity(changedRows('application-ui', { executions: 42, instances: 42 }), VERIFIED),
    metricIdentity(
      changedRows('playwright-total', { outcomes: outcomes({ passed: 147, flaky: 1 }) }),
      VERIFIED,
    ),
    metricIdentity(changedRows('authentication-setup', { executions: 2 }), VERIFIED),
    metricIdentity(changedRows('unclassified', { reported: true, executions: 1 }), VERIFIED),
    metricIdentity(changedRows('raw-total', { retries: 1, attempts: 150 }), VERIFIED),
    metricIdentity(
      model({
        playwright: { ...partial.playwright, state: 'partial', reasons: ['unresolved-identities'] },
      }),
      VERIFIED,
    ),
    metricIdentity(model(), { verdict: 'VERIFIED_PASS', summary: 'SUMMARY_INFORMATIVE' }),
    metricIdentity(model(), { verdict: 'VERIFIED_FAIL', summary: 'SUMMARY_VERIFIED_ORIGIN' }),
    { ...base, contract: 'adr-0012/2+adr-0013/1' },
  ];
  for (const variant of variants) {
    assert.equal(metricsEqual(base, variant), false, JSON.stringify(variant).slice(0, 80));
    assert.notEqual(metricsDigest(base), metricsDigest(variant));
  }
});

test('automated snapshots record exactly one metric digest; manual ones none', () => {
  const automated = rendered({ maintenance: 'reviewed-automation-pr' });
  assert.equal(parseMetricsDigest(automated), metricsDigest(metricIdentity(model(), VERIFIED)));
  assert.equal(parseMetricsDigest(C4_SECTION), undefined);
  const digestLine = automated
    .split('\n')
    .find((line) => line.startsWith('<!-- test-health-metrics'));
  assert.equal(parseMetricsDigest(`${automated}${digestLine ?? ''}\n`), undefined);
  assert.ok(replaceSection(README, automated).ok, 'the digest line is not a section marker');
});

test('compareMetrics accepts a full identity or a recorded digest', () => {
  const identity = metricIdentity(model(), VERIFIED);
  const other = metricIdentity(
    model(
      {},
      c4Rows().map((r) => (r.id === 'dashboard-functional' ? { ...r, executions: 85 } : r)),
    ),
    VERIFIED,
  );
  assert.equal(compareMetrics(identity, identity), 'same');
  assert.equal(compareMetrics(metricsDigest(identity), identity), 'same');
  assert.equal(compareMetrics(identity, other), 'different');
  assert.equal(compareMetrics(metricsDigest(identity), other), 'different');
  assert.equal(compareMetrics(undefined, identity), 'unavailable');
});

/* ------------------------------------------------------------------ *
 * End to end (pure): snapshot -> docs-only merge -> new run
 * ------------------------------------------------------------------ */

function decide(readme: string, candidateModel: HealthModel, completedAt: string) {
  const located = locateSection(readme);
  assert.ok(located.ok);
  const run = candidateModel.run!;
  return decideRefresh({
    candidate: {
      repository: REPO,
      workflowPath: REFRESH_POLICY.workflowPath,
      event: 'push',
      headBranch: 'main',
      headRepository: REPO,
      status: 'completed',
      runId: run.runId,
      runAttempt: run.runAttempt,
      latestAttempt: run.runAttempt,
      headSha: run.sourceSha,
      completedAt,
    },
    evidence: {
      verdict: 'VERIFIED_PASS',
      summary: 'SUMMARY_VERIFIED_ORIGIN',
      unit: 'complete',
      playwright: 'complete',
      identity: 'match',
      healthBundle: 'match',
    },
    snapshot: parseSnapshotPin(located.section, REPO),
    candidateVsSnapshot: 'descendant',
    candidateVsMain: 'same',
    // The refresh PR's merge changed only the README.
    changesSinceSnapshotSource: ['README.md'],
    changesSinceCandidateSource: [],
    metrics: compareMetrics(
      parseMetricsDigest(located.section),
      metricIdentity(candidateModel, VERIFIED),
    ),
  });
}

test('end to end: identical metrics after a docs-only refresh merge are a no-op', () => {
  // 1. The automated snapshot pinned to run 46162493309 at 305665bd.
  const snapshot = rendered({
    maintenance: 'reviewed-automation-pr',
    verdictSource: 'ci-operator',
  });
  const readme = `# T\n\n${SECTION_START}\n${snapshot}${SECTION_END}\n`;
  // 2. Its PR merged (README only); 3. the push run of that merge.
  const next = reobserved(model(), 46170000000, OTHER_SHA);
  const nextSection = rendered({
    maintenance: 'reviewed-automation-pr',
    verdictSource: 'ci-operator',
    completedAt: '2026-11-29T09:16:00Z',
    preparedOn: '2026-11-29',
    model: next,
  });
  // The rendered Markdown differs (commit, run, timestamps) ...
  assert.notEqual(nextSection, snapshot);
  // ... but the structured identity does not, so nothing is proposed.
  assert.deepEqual(decide(readme, next, '2026-11-29T09:16:00Z'), {
    action: 'no-op',
    reasons: ['documentation-only-no-substantive-change'],
  });
});

test('end to end: a changed metric after a docs-only merge is still proposed', () => {
  const snapshot = rendered({
    maintenance: 'reviewed-automation-pr',
    verdictSource: 'ci-operator',
  });
  const readme = `# T\n\n${SECTION_START}\n${snapshot}${SECTION_END}\n`;
  const flakyRows = c4Rows().map((r) =>
    ['application-ui', 'browser-subtotal', 'playwright-total', 'raw-total'].includes(r.id)
      ? {
          ...r,
          retries: 1,
          attempts: r.attempts + 1,
          outcomes: outcomes({ passed: r.executions - 1, flaky: 1 }),
        }
      : r,
  );
  const changed = reobserved(model({}, flakyRows), 46170000000, OTHER_SHA);
  assert.deepEqual(decide(readme, changed, '2026-11-29T09:16:00Z'), {
    action: 'refresh',
    reasons: ['substantive-change'],
  });
});

test('end to end: a manual snapshot without a recorded identity needs review', () => {
  const readme = `# T\n\n${SECTION_START}\n${C4_SECTION}${SECTION_END}\n`;
  const next = reobserved(model(), 46170000000, OTHER_SHA);
  assert.deepEqual(decide(readme, next, '2026-11-29T09:16:00Z'), {
    action: 'blocked',
    reasons: ['snapshot-metrics-unavailable'],
  });
  // The age limit still justifies a refresh without the identity.
  assert.deepEqual(decide(readme, next, '2026-12-29T09:16:00Z'), {
    action: 'refresh',
    reasons: ['snapshot-age-exceeded'],
  });
});
