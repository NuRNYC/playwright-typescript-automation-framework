/**
 * README Test Automation Health section: exact marker handling and a
 * deterministic renderer (ADR-0013, Phase C5A). Pure.
 *
 * - `locateSection` / `replaceSection` find exactly one marker pair and
 *   replace only the bytes between them. Every byte outside the pair is kept.
 *   Missing, duplicated, nested, misplaced or malformed markers are refused.
 * - `renderReadmeSection` renders the README snapshot from one C1 health
 *   model (ADR-0012) plus separately verified provenance. It accepts only
 *   complete CI evidence with a `VERIFIED_PASS` verdict; anything else is
 *   refused with a fixed reason. Tables are padded the way Prettier formats
 *   Markdown, so the output is stable under `npm run format:check`.
 * - `parseSnapshotPin` reads the pinned source run back from a rendered
 *   section, so later decisions compare against what the README actually
 *   says.
 * - `metricIdentity` / `metricsEqual` / `metricsDigest` compare evidence
 *   structurally. Provenance (commit, run, attempt, timestamps) is rendered
 *   but is NOT part of the identity, so a new run with identical metrics is
 *   not a reason to open a pull request. Rendered Markdown is never used as
 *   the metric identity.
 *
 * This is NOT the CI diagnostic renderer (`renderHealthMarkdown` in
 * `test-health.ts`), which stays unchanged and labels its output a
 * diagnostic. Nothing here reads files, the environment, the network or the
 * clock: every date is injected.
 *
 * Free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import { createHash } from 'node:crypto';
import { OUTCOME_COLUMNS } from './test-health.ts';
import type { HealthModel, OutcomeColumn, Row, UnitSection } from './test-health.ts';
import type { SummaryState, VerdictState } from './verdict.ts';

/* ------------------------------------------------------------------ *
 * Markers
 * ------------------------------------------------------------------ */

export const SECTION_START = '<!-- test-health:start -->';
export const SECTION_END = '<!-- test-health:end -->';
/** Any text starting with this is treated as a marker and must be exact. */
const MARKER_PREFIX = '<!-- test-health:';

export const MARKER_PROBLEMS = [
  'start-missing',
  'end-missing',
  'start-duplicated',
  'end-duplicated',
  'marker-malformed',
  'marker-not-on-own-line',
  'end-before-start',
  'section-contains-marker',
  'section-not-line-terminated',
  'section-has-carriage-return',
] as const;
export type MarkerProblem = (typeof MARKER_PROBLEMS)[number];

export type LocateResult =
  | {
      readonly ok: true;
      /** Bytes up to and including the start marker's line terminator. */
      readonly before: string;
      /** Bytes strictly between the two marker lines. */
      readonly section: string;
      /** Bytes from the end marker to the end of the text. */
      readonly after: string;
    }
  | { readonly ok: false; readonly problem: MarkerProblem };

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

/** The marker starts a line and is followed by `\n` or `\r\n`. */
function ownLineEnd(text: string, at: number, marker: string): number | undefined {
  if (at > 0 && text[at - 1] !== '\n') return undefined;
  const end = at + marker.length;
  if (text.startsWith('\n', end)) return end + 1;
  if (text.startsWith('\r\n', end)) return end + 2;
  return undefined;
}

/** Finds exactly one well-formed marker pair, or a fixed problem. */
export function locateSection(text: string): LocateResult {
  const starts = occurrences(text, SECTION_START);
  const ends = occurrences(text, SECTION_END);
  if (starts.length > 1) return { ok: false, problem: 'start-duplicated' };
  if (ends.length > 1) return { ok: false, problem: 'end-duplicated' };
  // A near-miss such as `<!-- test-health:begin -->` is refused, not ignored.
  if (occurrences(text, MARKER_PREFIX).length !== starts.length + ends.length) {
    return { ok: false, problem: 'marker-malformed' };
  }
  const [start] = starts;
  const [end] = ends;
  if (start === undefined) return { ok: false, problem: 'start-missing' };
  if (end === undefined) return { ok: false, problem: 'end-missing' };
  if (end < start) return { ok: false, problem: 'end-before-start' };
  const afterStart = ownLineEnd(text, start, SECTION_START);
  if (afterStart === undefined || ownLineEnd(text, end, SECTION_END) === undefined) {
    return { ok: false, problem: 'marker-not-on-own-line' };
  }
  return {
    ok: true,
    before: text.slice(0, afterStart),
    section: text.slice(afterStart, end),
    after: text.slice(end),
  };
}

export type ReplaceResult =
  | { readonly ok: true; readonly text: string; readonly changed: boolean }
  | { readonly ok: false; readonly problem: MarkerProblem };

/**
 * Replaces the bytes between the markers with `section`. The new section must
 * be LF-terminated Markdown with no marker text of its own.
 */
export function replaceSection(text: string, section: string): ReplaceResult {
  if (section.includes(MARKER_PREFIX)) return { ok: false, problem: 'section-contains-marker' };
  if (section.includes('\r')) return { ok: false, problem: 'section-has-carriage-return' };
  if (section.length > 0 && !section.endsWith('\n')) {
    return { ok: false, problem: 'section-not-line-terminated' };
  }
  const located = locateSection(text);
  if (!located.ok) return located;
  const next = located.before + section + located.after;
  return { ok: true, text: next, changed: next !== text };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** Who supplied the verified Gate verdict (ADR-0010). */
export type VerdictSource = 'local-operator' | 'ci-operator';

/** How the snapshot is maintained; changes only the disclosure wording. */
export type Maintenance = 'manual' | 'reviewed-automation-pr';

export interface ReadmeSnapshotInput {
  /** `owner/name`. */
  readonly repository: string;
  /** Completion time of the run's last job, to the second (`…Z`). */
  readonly completedAt: string;
  readonly verdict: 'VERIFIED_PASS';
  /** ADR-0010 summary state; only a verified-origin summary is rendered. */
  readonly summary: 'SUMMARY_VERIFIED_ORIGIN';
  readonly verdictSource: VerdictSource;
  /** Date the README change was prepared, `YYYY-MM-DD`. */
  readonly preparedOn: string;
  readonly maintenance: Maintenance;
  readonly model: HealthModel;
}

export const RENDER_PROBLEMS = [
  'invalid-repository',
  'invalid-completed-at',
  'invalid-prepared-on',
  'verdict-not-verified-pass',
  'summary-not-verified-origin',
  'model-not-ci',
  'model-run-missing',
  'model-not-push-on-main',
  'unit-not-complete',
  'playwright-not-complete',
  'row-missing',
  'definitions-unknown',
  'unit-not-all-passed',
] as const;
export type RenderProblem = (typeof RENDER_PROBLEMS)[number];

export type RenderResult =
  | { readonly ok: true; readonly section: string }
  | { readonly ok: false; readonly problem: RenderProblem };

const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string, pattern: RegExp, suffix: string): boolean {
  if (!pattern.test(value)) return false;
  const time = Date.parse(value + suffix);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value.slice(0, 19));
}

/**
 * A real UTC calendar instant to the second (`YYYY-MM-DDTHH:MM:SSZ`): the
 * pattern alone is not enough, so `2026-02-30T00:00:00Z` or `…T24:00:00Z` is
 * refused because it does not survive a round trip.
 */
export function isCalendarInstant(value: string): boolean {
  return validDate(value, SECOND, '');
}

/** Pads a Markdown table the way Prettier does for left-aligned columns. */
export function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((cell, column) =>
    Math.max(3, cell.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${widths.map((width, column) => (cells[column] ?? '').padEnd(width)).join(' | ')} |`;
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join(
    '\n',
  );
}

/**
 * Greedy word wrap: no line longer than `width`, counting any `indent` that
 * continuation lines receive (no hyphenation, no long-word splitting).
 */
export function wrap(text: string, width = 78, indent = ''): string {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const limit = lines.length === 0 ? width : width - indent.length;
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= limit) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines.join(`\n${indent}`);
}

function bullet(text: string): string {
  return wrap(`- ${text}`, 78, '  ');
}

const COLUMN_LABEL: Readonly<Record<OutcomeColumn, string>> = {
  passed: 'Passed',
  flaky: 'Flaky',
  failed: 'Failed',
  'timed-out': 'Timed out',
  skipped: 'Skipped',
  'did-not-run': 'Did not run',
  other: 'Other',
};

const DISPLAY_ROWS = [
  { id: 'dashboard-functional', label: 'Dashboard functional', style: 'plain' },
  { id: 'dashboard-accessibility', label: 'Dashboard accessibility', style: 'plain' },
  { id: 'application-ui', label: 'Application UI (Sauce Demo)', style: 'plain' },
  { id: 'browser-subtotal', label: 'Browser subtotal', style: 'italic' },
  { id: 'synthetic-stub-api', label: 'Synthetic-stub API', style: 'plain' },
  { id: 'playwright-total', label: 'Playwright total (excluding setup)', style: 'bold' },
] as const;

function styled(value: string, style: 'plain' | 'italic' | 'bold'): string {
  if (style === 'italic') return `_${value}_`;
  if (style === 'bold') return `**${value}**`;
  return value;
}

function counted(value: number, singular: string, plural: string): string {
  return value === 1 ? `one ${singular}` : `${String(value)} ${plural}`;
}

/** Renders the README section body (between the markers), or a fixed problem. */
export function renderReadmeSection(input: ReadmeSnapshotInput): RenderResult {
  const { model } = input;
  if (!REPOSITORY.test(input.repository)) return { ok: false, problem: 'invalid-repository' };
  if (!validDate(input.completedAt, SECOND, '')) {
    return { ok: false, problem: 'invalid-completed-at' };
  }
  if (!validDate(input.preparedOn, DAY, 'T00:00:00Z')) {
    return { ok: false, problem: 'invalid-prepared-on' };
  }
  if (input.verdict !== 'VERIFIED_PASS') return { ok: false, problem: 'verdict-not-verified-pass' };
  if (input.summary !== 'SUMMARY_VERIFIED_ORIGIN') {
    return { ok: false, problem: 'summary-not-verified-origin' };
  }
  if (model.mode !== 'ci') return { ok: false, problem: 'model-not-ci' };
  if (model.run === null) return { ok: false, problem: 'model-run-missing' };
  if (model.run.event !== 'push' || model.run.branchClass !== 'main') {
    return { ok: false, problem: 'model-not-push-on-main' };
  }
  if (model.unit.state !== 'complete') return { ok: false, problem: 'unit-not-complete' };
  if (model.playwright.state !== 'complete') {
    return { ok: false, problem: 'playwright-not-complete' };
  }
  const unit = model.unit.counts;
  // VERIFIED_PASS implies a passing unit job; a contradiction is refused.
  if (unit.passed !== unit.tests || unit.tests === 0) {
    return { ok: false, problem: 'unit-not-all-passed' };
  }

  const byId = new Map<string, Row>(model.playwright.rows.map((row) => [row.id, row]));
  const shown: { label: string; style: 'plain' | 'italic' | 'bold'; row: Row }[] = [];
  for (const spec of DISPLAY_ROWS) {
    const row = byId.get(spec.id);
    if (row === undefined || !row.reported) return { ok: false, problem: 'row-missing' };
    if (!row.definitions.known) return { ok: false, problem: 'definitions-unknown' };
    shown.push({ label: spec.label, style: spec.style, row });
  }
  const setup = byId.get('authentication-setup');
  const raw = byId.get('raw-total');
  const unclassified = byId.get('unclassified');
  const total = byId.get('playwright-total');
  if (setup === undefined || raw === undefined || total === undefined) {
    return { ok: false, problem: 'row-missing' };
  }
  if (!setup.definitions.known || !raw.definitions.known) {
    return { ok: false, problem: 'definitions-unknown' };
  }

  // Outcome columns: Passed always; any other column only when non-zero.
  const extra = OUTCOME_COLUMNS.filter(
    (column) => column !== 'passed' && shown.some(({ row }) => row.outcomes[column] > 0),
  );
  const showRetries = shown.some(({ row }) => row.retries > 0);
  const header = [
    'Group',
    'Definitions',
    'Instances',
    'Executions',
    ...(showRetries ? ['Retries'] : []),
    'Passed',
    ...extra.map((column) => COLUMN_LABEL[column]),
  ];
  const playwrightRows = shown.map(({ label, style, row }) => {
    const value = (n: number): string => styled(String(n), style);
    return [
      styled(label, style),
      value(row.definitions.known ? row.definitions.value : 0),
      value(row.instances),
      value(row.executions),
      ...(showRetries ? [value(row.retries)] : []),
      value(row.outcomes.passed),
      ...extra.map((column) => value(row.outcomes[column])),
    ];
  });

  const { runId, runAttempt, sourceSha } = model.run;
  const runUrl = `https://github.com/${input.repository}/actions/runs/${String(runId)}/attempts/${String(runAttempt)}`;
  const verdictText =
    input.verdictSource === 'local-operator'
      ? '`VERIFIED_PASS`, from the ADR-0010 local operator'
      : '`VERIFIED_PASS`, from the ADR-0010 operator in CI';
  const banner =
    input.maintenance === 'manual'
      ? '**Historical CI snapshot — manually maintained; does not describe current HEAD.**'
      : '**Historical CI snapshot — refreshed by reviewed pull request; does not describe current HEAD.**';

  const executions = total.executions;
  const outcomeSentence =
    extra.length === 0
      ? `All ${String(executions)} executions passed. Every other execution outcome was zero in every row: flaky, failed, timed out, skipped, did not run, and other (interrupted, unexpected pass, expected failure, unclassified).`
      : `Of ${String(executions)} executions, ${String(total.outcomes.passed)} passed. The columns after Passed show every other non-zero outcome; every outcome column not shown was zero in every row.`;
  const retrySentence = showRetries
    ? `Retries (attempts after the first, not additional tests) are shown in their own column, and no evidence was partial or missing.`
    : 'Retries were zero, and no evidence was partial or missing.';

  const rawPhrase =
    raw.instances === raw.executions
      ? `${String(raw.definitions.value)} definitions and ${String(raw.instances)} instances and executions`
      : `${String(raw.definitions.value)} definitions, ${String(raw.instances)} instances and ${String(raw.executions)} executions`;
  const unclassifiedText =
    unclassified === undefined || unclassified.executions === 0
      ? 'No result was unclassified.'
      : `${String(unclassified.executions)} executions were unclassified.`;

  // The manual wording is the committed ADR-0012 text, wrapped as committed.
  const closing =
    input.maintenance === 'manual'
      ? [
          'The quality summary itself records no Gate verdict; the verdict above comes',
          'from the separate ADR-0010 operator. Freshness is not checked automatically:',
          'a reviewer assesses it when the snapshot is updated by pull request. Counting',
          'rules, evidence, retention and freshness policy:',
        ].join('\n')
      : wrap(
          'The quality summary itself records no Gate verdict; the verdict above comes from the separate ADR-0010 operator. Eligibility and freshness were checked by the refresh automation and are reassessed by the reviewer of the pull request. Counting rules, evidence, retention and freshness policy:',
        );

  const parts = [
    '',
    banner,
    '',
    markdownTable(
      ['Source', 'Value'],
      [
        ['Commit', `\`${sourceSha}\``],
        [
          'CI run',
          `[${String(runId)}, attempt ${String(runAttempt)}](${runUrl}) (\`push\` to \`main\`)`,
        ],
        ['Completed', input.completedAt],
        ['Gate verdict', verdictText],
        ['Prepared', input.preparedOn],
      ],
    ),
    '',
    'Unit tests (`node:test`, `checks` job of that run):',
    '',
    markdownTable(
      ['Total', 'Passed', 'Failed', 'Cancelled', 'Skipped', 'Todo'],
      [
        [unit.tests, unit.passed, unit.failed, unit.cancelled, unit.skipped, unit.todo].map((n) =>
          String(n),
        ),
      ],
    ),
    '',
    'Playwright tests (quality summary of that run):',
    '',
    markdownTable(header, playwrightRows),
    '',
    wrap(`${outcomeSentence} ${retrySentence}`),
    '',
    bullet(
      'The browser subtotal sums the three browser groups. The Playwright total adds synthetic-stub API tests to that subtotal. Subtotal and total rows are not additional tests.',
    ),
    bullet(
      'A definition is one test as the runner reports it (each generated or parameterized test counts separately); an instance is that test in one configured Playwright project (browser or `api`); an execution is an actual reported run of an instance.',
    ),
    bullet(
      `The authentication setup is excluded: it had ${counted(setup.definitions.value, 'definition', 'definitions')} and ${counted(setup.executions, 'execution', 'executions')} in this run, so the raw summary totals are ${rawPhrase}. ${unclassifiedText}`,
    ),
    bullet(
      "Synthetic-stub API results cover the framework's API client against a local synthetic stub, not a production API.",
    ),
    bullet(
      'These groups are not labelled regression coverage, and execution counts are not requirement coverage.',
    ),
    '',
    closing,
    '[ADR-0012](docs/adr/0012-readme-test-automation-health.md).',
    '',
  ];
  // Automation-maintained snapshots carry their metric identity, so a later
  // run can be compared structurally after the source artifacts expire. The
  // manual (C4) rendering is unchanged.
  if (input.maintenance === 'reviewed-automation-pr') {
    const identity = metricIdentity(model, { verdict: input.verdict, summary: input.summary });
    parts.push(`${METRICS_PREFIX}${metricsDigest(identity)} -->`, '');
  }
  return { ok: true, section: `${parts.join('\n')}\n` };
}

/* ------------------------------------------------------------------ *
 * Reading the pinned snapshot back
 * ------------------------------------------------------------------ */

export interface SnapshotPin {
  readonly sourceSha: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly completedAt: string;
}

const COMMIT_ROW = /^\| Commit +\|/;
const RUN_ROW = /^\| CI run +\|/;
const COMPLETED_ROW = /^\| Completed +\|/;
const PIN_COMMIT = /^\| Commit +\| `([0-9a-f]{40})` +\|$/;
const PIN_RUN =
  /^\| CI run +\| \[([1-9]\d{0,15}), attempt ([1-9]\d{0,3})\]\(https:\/\/github\.com\/([^/)\s]+\/[^/)\s]+)\/actions\/runs\/([1-9]\d{0,15})\/attempts\/([1-9]\d{0,3})\) \(`push` to `main`\) +\|$/;
const PIN_COMPLETED = /^\| Completed +\| (\S+) +\|$/;

/** The one line matching `row`, or undefined when there are none or several. */
function onlyLine(lines: readonly string[], row: RegExp): string | undefined {
  const found = lines.filter((line) => row.test(line));
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The pinned source of a rendered section, or `undefined` unless it can be
 * read exactly: one Commit row, one CI run row and one Completed row; the run
 * link must point at `repository` and repeat the cell's run id and attempt;
 * the completion time must be a real calendar instant. Nothing is guessed.
 */
export function parseSnapshotPin(section: string, repository: string): SnapshotPin | undefined {
  const lines = section.split('\n');
  const commit = PIN_COMMIT.exec(onlyLine(lines, COMMIT_ROW) ?? '');
  const run = PIN_RUN.exec(onlyLine(lines, RUN_ROW) ?? '');
  const completed = PIN_COMPLETED.exec(onlyLine(lines, COMPLETED_ROW) ?? '');
  const sha = commit?.[1];
  const [, cellRun, cellAttempt, linkRepository, linkRun, linkAttempt] = run ?? [];
  const completedAt = completed?.[1];
  if (sha === undefined || completedAt === undefined || !isCalendarInstant(completedAt)) {
    return undefined;
  }
  if (cellRun === undefined || cellAttempt === undefined) return undefined;
  if (linkRepository !== repository || linkRun !== cellRun || linkAttempt !== cellAttempt) {
    return undefined;
  }
  const runId = Number(cellRun);
  const runAttempt = Number(cellAttempt);
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(runAttempt)) return undefined;
  return { sourceSha: sha, runId, runAttempt, completedAt };
}

/* ------------------------------------------------------------------ *
 * Metric identity (structured, provenance-free)
 * ------------------------------------------------------------------ */

/**
 * Version of the README counting and presentation contract (ADR-0012 groups,
 * units and outcome columns; ADR-0013 rendering). Bump it when either
 * changes, so that a contract change is a substantive change.
 */
export const README_CONTRACT_VERSION = 'adr-0012/1+adr-0013/1';

const METRICS_PREFIX = '<!-- test-health-metrics: ';
const METRICS_LINE = /^<!-- test-health-metrics: (sha256:[0-9a-f]{64}) -->$/;

export interface MetricRow {
  readonly id: Row['id'];
  readonly reported: boolean;
  readonly definitions: number | null;
  readonly instances: number;
  readonly executions: number;
  readonly attempts: number;
  readonly retries: number;
  readonly outcomes: Readonly<Record<OutcomeColumn, number>>;
}

/**
 * Everything that makes two snapshots say different things: the contract
 * version, the verification state, both evidence states with their reasons,
 * the unit counts and every Playwright row (groups, setup, Unclassified,
 * subtotals and totals) with every outcome. Excludes the source commit, run
 * id, attempt, every timestamp, the preparation date and the Node.js version.
 */
export interface MetricIdentity {
  readonly contract: string;
  readonly modelVersion: string;
  readonly verification: { readonly verdict: VerdictState; readonly summary: SummaryState };
  readonly unit:
    | { readonly state: 'unavailable'; readonly reason: string }
    | {
        readonly state: 'complete' | 'partial';
        readonly reasons: readonly string[];
        readonly counts: Extract<UnitSection, { state: 'complete' | 'partial' }>['counts'];
      };
  readonly playwright:
    | { readonly state: 'unavailable'; readonly reason: string }
    | {
        readonly state: 'complete' | 'partial';
        readonly reasons: readonly string[];
        readonly missingGroups: readonly string[];
        readonly rows: readonly MetricRow[];
      };
}

function metricRow(row: Row): MetricRow {
  const outcomes = {} as Record<OutcomeColumn, number>;
  for (const column of OUTCOME_COLUMNS) outcomes[column] = row.outcomes[column];
  return {
    id: row.id,
    reported: row.reported,
    definitions: row.definitions.known ? row.definitions.value : null,
    instances: row.instances,
    executions: row.executions,
    attempts: row.attempts,
    retries: row.retries,
    outcomes,
  };
}

/** Builds the identity field by field, in a fixed key and row order. */
export function metricIdentity(
  model: HealthModel,
  verification: { readonly verdict: VerdictState; readonly summary: SummaryState },
): MetricIdentity {
  const unit: MetricIdentity['unit'] =
    model.unit.state === 'unavailable'
      ? { state: 'unavailable', reason: model.unit.reason }
      : {
          state: model.unit.state,
          reasons: [...model.unit.reasons].sort(),
          counts: {
            tests: model.unit.counts.tests,
            passed: model.unit.counts.passed,
            failed: model.unit.counts.failed,
            cancelled: model.unit.counts.cancelled,
            skipped: model.unit.counts.skipped,
            todo: model.unit.counts.todo,
            suites: model.unit.counts.suites,
          },
        };
  const playwright: MetricIdentity['playwright'] =
    model.playwright.state === 'unavailable'
      ? { state: 'unavailable', reason: model.playwright.reason }
      : {
          state: model.playwright.state,
          reasons: [...model.playwright.reasons].sort(),
          missingGroups: [...model.playwright.missingGroups].sort(),
          rows: [...model.playwright.rows]
            .map(metricRow)
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        };
  return {
    contract: README_CONTRACT_VERSION,
    modelVersion: model.modelVersion,
    verification: { verdict: verification.verdict, summary: verification.summary },
    unit,
    playwright,
  };
}

function canonical(identity: MetricIdentity): string {
  return JSON.stringify(identity);
}

/** Structural equality of two identities. */
export function metricsEqual(a: MetricIdentity, b: MetricIdentity): boolean {
  return canonical(a) === canonical(b);
}

/** `sha256:<hex>` of the canonical identity, recorded in automated snapshots. */
export function metricsDigest(identity: MetricIdentity): string {
  return `sha256:${createHash('sha256').update(canonical(identity), 'utf8').digest('hex')}`;
}

/**
 * The metric digest recorded in a section, or `undefined` when there is none
 * or more than one. Manually maintained snapshots carry none.
 */
export function parseMetricsDigest(section: string): string | undefined {
  const found = section.split('\n').filter((line) => line.startsWith(METRICS_PREFIX.trimEnd()));
  if (found.length !== 1) return undefined;
  return METRICS_LINE.exec(found[0] ?? '')?.[1];
}

export type MetricComparison = 'same' | 'different' | 'unavailable';

/**
 * Compares the candidate's identity with the snapshot's, given either the
 * snapshot's full identity (recomputed from its evidence while retained) or
 * the digest recorded in the README.
 */
export function compareMetrics(
  snapshot: MetricIdentity | string | undefined,
  candidate: MetricIdentity,
): MetricComparison {
  if (snapshot === undefined) return 'unavailable';
  if (typeof snapshot === 'string') {
    return snapshot === metricsDigest(candidate) ? 'same' : 'different';
  }
  return metricsEqual(snapshot, candidate) ? 'same' : 'different';
}
