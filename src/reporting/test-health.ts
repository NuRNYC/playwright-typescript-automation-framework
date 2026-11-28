/**
 * Test-health model and Markdown rendering (ADR-0012, Phase C1). Pure.
 *
 * Builds one health model from two independent inputs:
 *
 * - Playwright evidence: the result of the committed strict parser
 *   (`parseSummary` in `dashboard-model.ts`) over one quality summary. This
 *   module never parses summary text itself and reads the summary only
 *   through its validated `QualitySummary` value.
 * - Unit evidence: a minimal typed unit-result contract (`UnitEvidence`). Its
 *   producer (reporter) and strict JSON parser are later increments (C2); see
 *   the preconditions on `UnitResults`.
 *
 * Rules applied (ADR-0012): file-path groups with an explicit Unclassified
 * row; the authentication setup excluded from every test total and disclosed
 * on its own row; the browser subtotal kept apart from the browser-free
 * synthetic-stub API group; execution-outcome columns that reconcile exactly
 * to executions; unit and Playwright units never mixed.
 *
 * Evidence states are kept distinct: `unavailable` (no usable evidence, with a
 * fixed reason), `partial` (values shown with fixed reasons) and `complete`.
 * Failed tests are outcomes, not evidence problems: complete evidence may
 * contain failures.
 *
 * Provenance: in CI mode every input must carry the caller's run id, attempt
 * and source commit; a mismatched input is not combined and its section is
 * unavailable. Matching metadata is consistency, not independent
 * verification. Local mode accepts only local unit results. The model never
 * carries a Gate verdict, a workflow conclusion, a workflow completion time or
 * a freshness claim, and is never labelled an ADR-0012 README snapshot.
 *
 * Deterministic: no filesystem, environment, network or clock access; the
 * generation time is injected. Output holds fixed codes, enums, validated
 * identifiers and aggregate counts only: no test titles, file paths or
 * diagnostics.
 *
 * Free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import { OUTCOMES } from './quality-summary.ts';
import type {
  BranchClass,
  GateInputName,
  InstanceRecord,
  Outcome,
  QualitySummary,
  RunEvent,
} from './quality-summary.ts';
import type { ParsedSummary } from './dashboard-model.ts';

export const MODEL_VERSION = '1.0.0';

/* ------------------------------------------------------------------ *
 * Groups (ADR-0012 section 2)
 * ------------------------------------------------------------------ */

export const GROUP_IDS = [
  'dashboard-functional',
  'dashboard-accessibility',
  'application-ui',
  'synthetic-stub-api',
  'authentication-setup',
] as const;
export type GroupId = (typeof GROUP_IDS)[number];
export type RowId = GroupId | 'unclassified';

/** Groups whose results are expected in every full run; absence is reported. */
const TEST_GROUPS: readonly GroupId[] = [
  'dashboard-functional',
  'dashboard-accessibility',
  'application-ui',
  'synthetic-stub-api',
];
const BROWSER_GROUPS: readonly GroupId[] = [
  'dashboard-functional',
  'dashboard-accessibility',
  'application-ui',
];

const DASHBOARD_FUNCTIONAL = new Set([
  'tests/ui/dashboard.spec.ts',
  'tests/ui/dashboard-publication.spec.ts',
  'tests/ui/dashboard-demo.spec.ts',
]);
const APPLICATION_UI = new Set(['tests/ui/login.spec.ts', 'tests/ui/login.a11y.spec.ts']);
const AUTHENTICATED_SPEC = /^tests\/ui\/authenticated\/[^/]+\.spec\.ts$/;
const API_SPEC = /^tests\/api\/[^/]+\.spec\.ts$/;

/** Exact-path group membership; `null` files and unmatched paths are Unclassified. */
export function groupOf(file: string | null): RowId {
  if (file === null) return 'unclassified';
  if (DASHBOARD_FUNCTIONAL.has(file)) return 'dashboard-functional';
  if (file === 'tests/ui/dashboard.a11y.spec.ts') return 'dashboard-accessibility';
  if (APPLICATION_UI.has(file) || AUTHENTICATED_SPEC.test(file)) return 'application-ui';
  if (API_SPEC.test(file)) return 'synthetic-stub-api';
  if (file === 'tests/auth.setup.ts') return 'authentication-setup';
  return 'unclassified';
}

/* ------------------------------------------------------------------ *
 * Outcome columns (ADR-0012 section 5)
 * ------------------------------------------------------------------ */

export const OUTCOME_COLUMNS = [
  'passed',
  'flaky',
  'failed',
  'timed-out',
  'skipped',
  'did-not-run',
  'other',
] as const;
export type OutcomeColumn = (typeof OUTCOME_COLUMNS)[number];

/** Every normalizer outcome maps to exactly one column. */
export const COLUMN_OF: Readonly<Record<Outcome, OutcomeColumn>> = {
  passed: 'passed',
  flaky: 'flaky',
  failed: 'failed',
  'timed-out': 'timed-out',
  skipped: 'skipped',
  'did-not-run': 'did-not-run',
  interrupted: 'other',
  'unexpected-pass': 'other',
  'expected-failure': 'other',
  unclassified: 'other',
};

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** Run identity in CI mode. */
export interface CiIdentity {
  readonly runId: number;
  readonly runAttempt: number;
  readonly sourceSha: string;
}

export type HealthContext =
  | ({ readonly mode: 'ci'; readonly generatedAt: string } & CiIdentity)
  | { readonly mode: 'local'; readonly generatedAt: string };

export type UnitProvenance = ({ readonly mode: 'ci' } & CiIdentity) | { readonly mode: 'local' };

/**
 * Unit-result input. Produced by the C2 strict parser (`parseUnitResults` in
 * `unit-results.ts`) from one complete `node:test` run summary; an
 * interrupted, empty, invalid or inconsistent document arrives as
 * `unavailable` instead. Counts are the reporter's own figures; provenance is
 * what the workflow supplied, not independently verified. This module still
 * re-checks types and the count identity and never trusts them blindly.
 */
export interface UnitResults {
  readonly kind: 'unit-results';
  readonly provenance: UnitProvenance;
  /** Node.js version that ran the tests, e.g. `v24.22.3`. */
  readonly nodeVersion: string;
  readonly counts: {
    readonly tests: number;
    readonly passed: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly skipped: number;
    readonly todo: number;
    readonly suites: number;
  };
  /** Reporter-clock execution window, or null when not recorded. */
  readonly execution: { readonly startedAt: string; readonly finishedAt: string } | null;
}

export const UNIT_UNAVAILABLE_REASONS = [
  'unit-results-missing',
  'unit-results-invalid',
  'unit-results-incomplete',
  'unit-results-inconsistent',
] as const;
export type UnitUnavailableInput = (typeof UNIT_UNAVAILABLE_REASONS)[number];

/**
 * Node.js versions whose `cancelled` counting was established by executable
 * probes (timeouts and cancellation by a parent count as `cancelled`, never
 * as `passed`). Results from other versions keep cancelled counts partial.
 */
export const CANCELLATION_VERIFIED_NODE_VERSIONS: readonly string[] = ['v24.22.3'];

const NODE_VERSION = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export type UnitEvidence =
  UnitResults | { readonly kind: 'unavailable'; readonly reason: UnitUnavailableInput };

/* ------------------------------------------------------------------ *
 * Output model
 * ------------------------------------------------------------------ */

/** A count that is either known or explicitly unknown (never a guessed zero). */
export type Count = { readonly known: true; readonly value: number } | { readonly known: false };

export type UnitUnavailableReason =
  UnitUnavailableInput | 'provenance-mismatch' | 'not-local-evidence';

export type UnitPartialReason =
  'unit-counts-do-not-reconcile' | 'unit-cancelled-semantics-unverified';

export type UnitSection =
  | { readonly state: 'unavailable'; readonly reason: UnitUnavailableReason }
  | {
      readonly state: 'complete' | 'partial';
      readonly reasons: readonly UnitPartialReason[];
      readonly nodeVersion: string;
      readonly counts: UnitResults['counts'];
      readonly execution: UnitResults['execution'];
    };

export type PlaywrightUnavailableReason =
  | 'summary-missing'
  | 'summary-invalid'
  | 'summary-schema-mismatch'
  | 'summary-test-data-unavailable'
  | 'totals-do-not-reconcile'
  | 'provenance-mismatch'
  | 'not-local-evidence';

export type PlaywrightPartialReason =
  | 'summary-inconsistent'
  | 'unrecognized-project-executions'
  | 'unresolved-identities'
  | 'ambiguous-identities'
  | 'inconsistent-executions'
  | 'provisional-outcomes'
  | 'unclassified-attempts'
  | 'invalid-durations'
  | 'invalid-retries'
  | 'stats-cross-check-not-match'
  | 'gate-input-not-success'
  | 'unclassified-files'
  | 'groups-not-reported';

export interface Row {
  readonly id: RowId | 'browser-subtotal' | 'playwright-total' | 'raw-total';
  /** False when the summary reported no instance for a group: shown as "none reported". */
  readonly reported: boolean;
  readonly definitions: Count;
  readonly instances: number;
  readonly executions: number;
  readonly attempts: number;
  readonly retries: number;
  readonly outcomes: Readonly<Record<OutcomeColumn, number>>;
}

export type PlaywrightSection =
  | { readonly state: 'unavailable'; readonly reason: PlaywrightUnavailableReason }
  | {
      readonly state: 'complete' | 'partial';
      readonly reasons: readonly PlaywrightPartialReason[];
      /** Groups with no reported instance (fixed ids). */
      readonly missingGroups: readonly GroupId[];
      readonly rows: readonly Row[];
      readonly summaryGeneratedAt: string;
    };

export interface HealthModel {
  readonly kind: 'test-health';
  readonly modelVersion: typeof MODEL_VERSION;
  readonly mode: 'ci' | 'local';
  /** CI identity the inputs were checked against (consistency, not verification). */
  readonly run:
    | (CiIdentity & { readonly event: RunEvent | null; readonly branchClass: BranchClass | null })
    | null;
  readonly generatedAt: string;
  readonly unit: UnitSection;
  readonly playwright: PlaywrightSection;
}

export type HealthResult =
  | { readonly ok: true; readonly model: HealthModel }
  | { readonly ok: false; readonly problem: 'invalid-context' };

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositive(value: unknown): value is number {
  return isCount(value) && value >= 1;
}

export function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

function validIdentity(value: {
  runId: unknown;
  runAttempt: unknown;
  sourceSha: unknown;
}): boolean {
  return (
    isPositive(value.runId) &&
    isPositive(value.runAttempt) &&
    typeof value.sourceSha === 'string' &&
    SHA.test(value.sourceSha)
  );
}

function sameIdentity(a: CiIdentity, b: CiIdentity): boolean {
  return a.runId === b.runId && a.runAttempt === b.runAttempt && a.sourceSha === b.sourceSha;
}

function validContext(context: HealthContext): boolean {
  if (!isIsoInstant(context.generatedAt)) return false;
  if (context.mode === 'local') return true;
  return context.mode === 'ci' && validIdentity(context);
}

/* ------------------------------------------------------------------ *
 * Unit section
 * ------------------------------------------------------------------ */

function unitSection(evidence: UnitEvidence, context: HealthContext): UnitSection {
  if (evidence.kind === 'unavailable') {
    return {
      state: 'unavailable',
      reason: (UNIT_UNAVAILABLE_REASONS as readonly string[]).includes(evidence.reason)
        ? evidence.reason
        : 'unit-results-invalid',
    };
  }
  const { counts, provenance, execution } = evidence;
  const fields = [
    counts.tests,
    counts.passed,
    counts.failed,
    counts.cancelled,
    counts.skipped,
    counts.todo,
    counts.suites,
  ];
  if (!fields.every(isCount)) return { state: 'unavailable', reason: 'unit-results-invalid' };
  if (typeof evidence.nodeVersion !== 'string' || !NODE_VERSION.test(evidence.nodeVersion)) {
    return { state: 'unavailable', reason: 'unit-results-invalid' };
  }
  // The reporter's own execution interval: both instants valid and not inverted
  // (equal is valid). Never compared with the generation time or other machines.
  if (
    execution !== null &&
    !(
      isIsoInstant(execution.startedAt) &&
      isIsoInstant(execution.finishedAt) &&
      Date.parse(execution.finishedAt) >= Date.parse(execution.startedAt)
    )
  ) {
    return { state: 'unavailable', reason: 'unit-results-invalid' };
  }
  if (context.mode === 'local') {
    if (provenance.mode !== 'local') return { state: 'unavailable', reason: 'not-local-evidence' };
  } else if (
    provenance.mode !== 'ci' ||
    !validIdentity(provenance) ||
    !sameIdentity(provenance, context)
  ) {
    return { state: 'unavailable', reason: 'provenance-mismatch' };
  }
  const reasons: UnitPartialReason[] = [];
  if (
    counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo !==
    counts.tests
  ) {
    reasons.push('unit-counts-do-not-reconcile');
  }
  // Cancellation counting is verified only for probed Node.js versions.
  if (counts.cancelled > 0 && !CANCELLATION_VERIFIED_NODE_VERSIONS.includes(evidence.nodeVersion)) {
    reasons.push('unit-cancelled-semantics-unverified');
  }
  return {
    state: reasons.length === 0 ? 'complete' : 'partial',
    reasons,
    nodeVersion: evidence.nodeVersion,
    // Explicit allow-listed fields: extra runtime properties never survive.
    counts: {
      tests: counts.tests,
      passed: counts.passed,
      failed: counts.failed,
      cancelled: counts.cancelled,
      skipped: counts.skipped,
      todo: counts.todo,
      suites: counts.suites,
    },
    execution:
      execution === null
        ? null
        : { startedAt: execution.startedAt, finishedAt: execution.finishedAt },
  };
}

/* ------------------------------------------------------------------ *
 * Playwright section
 * ------------------------------------------------------------------ */

function zeroOutcomes(): Record<OutcomeColumn, number> {
  return Object.fromEntries(OUTCOME_COLUMNS.map((c) => [c, 0])) as Record<OutcomeColumn, number>;
}

interface Accumulator {
  definitions: Set<string>;
  unresolved: boolean;
  instances: number;
  executions: number;
  attempts: number;
  retries: number;
  outcomes: Record<OutcomeColumn, number>;
}

function emptyAccumulator(): Accumulator {
  return {
    definitions: new Set(),
    unresolved: false,
    instances: 0,
    executions: 0,
    attempts: 0,
    retries: 0,
    outcomes: zeroOutcomes(),
  };
}

function add(acc: Accumulator, instance: InstanceRecord): void {
  acc.instances += 1;
  // An unresolved identity has no trustworthy definition key: never count one.
  if (instance.identity === 'unresolved') acc.unresolved = true;
  else acc.definitions.add(instance.definitionId);
  for (const execution of instance.executions) {
    acc.executions += 1;
    acc.attempts += execution.attempts.length;
    acc.retries += execution.attempts.filter((a) => a.retry !== null && a.retry > 0).length;
    acc.outcomes[COLUMN_OF[execution.outcome]] += 1;
  }
}

function merge(parts: readonly Accumulator[]): Accumulator {
  const out = emptyAccumulator();
  for (const p of parts) {
    for (const d of p.definitions) out.definitions.add(d);
    out.unresolved ||= p.unresolved;
    out.instances += p.instances;
    out.executions += p.executions;
    out.attempts += p.attempts;
    out.retries += p.retries;
    for (const c of OUTCOME_COLUMNS) out.outcomes[c] += p.outcomes[c];
  }
  return out;
}

function row(id: Row['id'], acc: Accumulator): Row {
  return {
    id,
    reported: acc.instances > 0,
    definitions: acc.unresolved ? { known: false } : { known: true, value: acc.definitions.size },
    instances: acc.instances,
    executions: acc.executions,
    attempts: acc.attempts,
    retries: acc.retries,
    outcomes: { ...acc.outcomes },
  };
}

const COMPLETENESS_REASONS: readonly (readonly [
  keyof NonNullable<QualitySummary['completeness']>,
  PlaywrightPartialReason,
])[] = [
  ['unrecognizedProjectExecutions', 'unrecognized-project-executions'],
  ['unresolvedIdentities', 'unresolved-identities'],
  ['ambiguousIdentities', 'ambiguous-identities'],
  ['inconsistentExecutions', 'inconsistent-executions'],
  ['provisionalOutcomes', 'provisional-outcomes'],
  ['unclassifiedAttempts', 'unclassified-attempts'],
  ['invalidDurations', 'invalid-durations'],
  ['invalidRetries', 'invalid-retries'],
];

function playwrightSection(parsed: ParsedSummary, context: HealthContext): PlaywrightSection {
  if (parsed.state === 'no-summary') return { state: 'unavailable', reason: 'summary-missing' };
  if (parsed.state === 'invalid') return { state: 'unavailable', reason: 'summary-invalid' };
  if (parsed.state === 'schema-mismatch') {
    return { state: 'unavailable', reason: 'summary-schema-mismatch' };
  }
  const summary = parsed.validated.summary;
  if (context.mode === 'local') return { state: 'unavailable', reason: 'not-local-evidence' };
  const identity: CiIdentity = {
    runId: summary.run.runId,
    runAttempt: summary.run.runAttempt,
    sourceSha: summary.run.headSha,
  };
  if (!sameIdentity(identity, context))
    return { state: 'unavailable', reason: 'provenance-mismatch' };
  if (summary.testData.state === 'unavailable' || summary.totals === null) {
    return { state: 'unavailable', reason: 'summary-test-data-unavailable' };
  }

  const groups = new Map<RowId, Accumulator>();
  for (const id of [...GROUP_IDS, 'unclassified' as const]) groups.set(id, emptyAccumulator());
  for (const instance of summary.instances) {
    const acc = groups.get(groupOf(instance.file));
    if (acc !== undefined) add(acc, instance);
  }
  const get = (id: RowId): Accumulator => groups.get(id) ?? emptyAccumulator();
  const browser = merge(BROWSER_GROUPS.map(get));
  const playwright = merge([browser, get('synthetic-stub-api')]);
  const raw = merge([playwright, get('authentication-setup'), get('unclassified')]);

  // Reconcile every unit and every outcome against the normalizer's own totals.
  const totals = summary.totals;
  const expectedOutcomes = zeroOutcomes();
  for (const outcome of OUTCOMES) {
    expectedOutcomes[COLUMN_OF[outcome]] += totals.byExecutionOutcome[outcome] ?? 0;
  }
  const reconciles =
    raw.instances === totals.instances &&
    raw.executions === totals.executions &&
    raw.attempts === totals.attempts &&
    raw.retries === totals.retries &&
    (raw.unresolved || raw.definitions.size === totals.definitions) &&
    OUTCOME_COLUMNS.every((c) => raw.outcomes[c] === expectedOutcomes[c]);
  if (!reconciles) return { state: 'unavailable', reason: 'totals-do-not-reconcile' };

  const reasons: PlaywrightPartialReason[] = [];
  if (parsed.validated.consistency.state !== 'consistent') reasons.push('summary-inconsistent');
  const completeness = summary.completeness;
  for (const [key, reason] of COMPLETENESS_REASONS) {
    const value = completeness?.[key];
    if (typeof value === 'number' && value > 0) reasons.push(reason);
  }
  if (completeness !== null && completeness.statsCrossCheck !== 'match') {
    reasons.push('stats-cross-check-not-match');
  }
  const gate = summary.observedGateInputs as Readonly<Record<GateInputName, string>>;
  if (Object.values(gate).some((state) => state !== 'success')) {
    reasons.push('gate-input-not-success');
  }
  if (get('unclassified').instances > 0) reasons.push('unclassified-files');
  const missingGroups = TEST_GROUPS.filter((id) => get(id).instances === 0);
  if (missingGroups.length > 0) reasons.push('groups-not-reported');

  return {
    state: reasons.length === 0 ? 'complete' : 'partial',
    reasons,
    missingGroups,
    rows: [
      row('dashboard-functional', get('dashboard-functional')),
      row('dashboard-accessibility', get('dashboard-accessibility')),
      row('application-ui', get('application-ui')),
      row('browser-subtotal', browser),
      row('synthetic-stub-api', get('synthetic-stub-api')),
      row('playwright-total', playwright),
      row('authentication-setup', get('authentication-setup')),
      row('unclassified', get('unclassified')),
      row('raw-total', raw),
    ],
    summaryGeneratedAt: summary.run.generatedAt,
  };
}

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

/**
 * Builds the health model. Each section is evaluated independently, so
 * missing evidence on one side never hides available evidence on the other.
 */
export function healthModel(
  playwright: ParsedSummary,
  unit: UnitEvidence,
  context: HealthContext,
): HealthResult {
  if (!validContext(context)) return { ok: false, problem: 'invalid-context' };
  const playwrightResult = playwrightSection(playwright, context);
  const summaryRun =
    playwright.state === 'valid' && playwrightResult.state !== 'unavailable'
      ? playwright.validated.summary.run
      : null;
  return {
    ok: true,
    model: {
      kind: 'test-health',
      modelVersion: MODEL_VERSION,
      mode: context.mode,
      run:
        context.mode === 'ci'
          ? {
              runId: context.runId,
              runAttempt: context.runAttempt,
              sourceSha: context.sourceSha,
              event: summaryRun?.event ?? null,
              branchClass: summaryRun?.branchClass ?? null,
            }
          : null,
      generatedAt: context.generatedAt,
      unit: unitSection(unit, context),
      playwright: playwrightResult,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

/** Escapes Markdown and HTML control characters; collapses line breaks. */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/[\\`*_{}[\]()#+\-.!|<>&~]/g, (c) => `\\${c}`);
}

const ROW_LABEL: Readonly<Record<Row['id'], string>> = {
  'dashboard-functional': 'Dashboard functional',
  'dashboard-accessibility': 'Dashboard accessibility',
  'application-ui': 'Application UI',
  'browser-subtotal': 'Browser subtotal',
  'synthetic-stub-api': 'Synthetic-stub API',
  'playwright-total': 'Playwright total (excluding setup)',
  'authentication-setup': 'Authentication setup (excluded)',
  unclassified: 'Unclassified',
  'raw-total': 'Raw summary totals',
};

const COLUMN_LABEL: Readonly<Record<OutcomeColumn, string>> = {
  passed: 'Passed',
  flaky: 'Flaky',
  failed: 'Failed',
  'timed-out': 'Timed out',
  skipped: 'Skipped',
  'did-not-run': 'Did not run',
  other: 'Other',
};

/** Characters allowed inside a rendered code span: fixed codes, digits, ISO times, hex. */
const CODE_SAFE = /^[A-Za-z0-9:.-]+$/;

/**
 * A code span for a fixed code or validated identifier. Anything outside the
 * safe set is rendered as escaped plain text instead, never inside a span.
 */
function code(value: string): string {
  return CODE_SAFE.test(value) ? `\`${value}\`` : escapeMarkdown(value);
}

function countText(count: Count): string {
  return count.known ? String(count.value) : 'unknown';
}

function stateLine(state: 'complete' | 'partial', reasons: readonly string[]): string {
  return state === 'complete'
    ? 'Evidence: complete.'
    : `Evidence: **partial** — ${reasons.map((r) => code(r)).join(', ')}.`;
}

function renderUnit(section: UnitSection): string[] {
  const lines = ['### Unit tests (`node:test`)', ''];
  if (section.state === 'unavailable') {
    return [...lines, `**Unavailable** — ${code(section.reason)}.`];
  }
  const c = section.counts;
  lines.push(
    stateLine(section.state, section.reasons),
    '',
    '| Tests | Passed | Failed | Cancelled | Skipped | Todo | Suites |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${[c.tests, c.passed, c.failed, c.cancelled, c.skipped, c.todo, c.suites].join(' | ')} |`,
  );
  lines.push(
    '',
    `Node.js ${code(section.nodeVersion)}. Cancelled tests (timed out or cancelled by their parent) did not pass.`,
  );
  if (section.execution !== null) {
    lines.push(
      '',
      `Execution (reporter clock): ${code(section.execution.startedAt)} to ${code(section.execution.finishedAt)}.`,
    );
  }
  return lines;
}

function renderPlaywright(section: PlaywrightSection): string[] {
  const lines = ['### Playwright tests (quality summary)', ''];
  if (section.state === 'unavailable') {
    return [...lines, `**Unavailable** — ${code(section.reason)}.`];
  }
  lines.push(stateLine(section.state, section.reasons));
  if (section.missingGroups.length > 0) {
    lines.push(
      '',
      `Groups with no reported results: ${section.missingGroups.map((g) => code(g)).join(', ')}.`,
    );
  }
  lines.push(
    '',
    `| Group | Definitions | Instances | Executions | Attempts | Retries | ${OUTCOME_COLUMNS.map((c) => COLUMN_LABEL[c]).join(' | ')} |`,
    `| --- | --- | --- | --- | --- | --- | ${OUTCOME_COLUMNS.map(() => '---').join(' | ')} |`,
  );
  for (const r of section.rows) {
    const label = ROW_LABEL[r.id];
    if (!r.reported) {
      lines.push(
        `| ${label} | none reported | | | | | ${OUTCOME_COLUMNS.map(() => '').join(' | ')} |`,
      );
      continue;
    }
    lines.push(
      `| ${label} | ${countText(r.definitions)} | ${String(r.instances)} | ${String(r.executions)} | ${String(r.attempts)} | ${String(r.retries)} | ${OUTCOME_COLUMNS.map((c) => String(r.outcomes[c])).join(' | ')} |`,
    );
  }
  lines.push(
    '',
    'Subtotal and total rows are sums of the group rows, not additional tests. Other = interrupted, unexpected pass, expected failure or unclassified.',
    '',
    `Quality summary generated: ${code(section.summaryGeneratedAt)} (report generation, not execution).`,
  );
  return lines;
}

/** Deterministic Markdown for one model; aggregate values and fixed codes only. */
export function renderHealthMarkdown(model: HealthModel): string {
  const header =
    model.mode === 'local'
      ? ['## Test health — LOCAL output, not CI evidence', '']
      : [
          '## Test health — CI diagnostic',
          '',
          'Not an ADR-0012 README snapshot. Run identity is as supplied by the workflow and checked for consistency only; it is not independently verified.',
          '',
          '| Field | Value |',
          '| --- | --- |',
          `| Run ID | ${String(model.run?.runId ?? '')} |`,
          `| Run attempt | ${String(model.run?.runAttempt ?? '')} |`,
          `| Source commit | ${code(model.run?.sourceSha ?? '')} |`,
          `| Event | ${model.run?.event === null || model.run === null ? 'unknown' : code(model.run.event)} |`,
          '',
        ];
  return [
    ...header,
    `Health generated: ${code(model.generatedAt)}. Workflow conclusion and completion time are not available when this is generated. No Gate verdict is derived from this data, and freshness is not assessed.`,
    '',
    ...renderUnit(model.unit),
    '',
    ...renderPlaywright(model.playwright),
    '',
  ].join('\n');
}
