/**
 * Quality summary normalizer (ADR-0009, M8A). Pure.
 *
 * Turns the verified, merged Playwright JSON report into a small, versioned,
 * metadata-only summary. Every output object is built field by field from
 * validated values: input objects are never spread, cloned or passed through,
 * so a field that is not explicitly copied cannot reach the output. Titles are
 * used internally to tell tests apart and are never emitted; neither are error
 * text, logs, steps, attachments, annotations, report metadata, paths outside
 * `tests/` or raw branch names.
 *
 * Determinism: `normalize` reads no clock, environment, filesystem, network or
 * mutable global state. Everything external arrives through a
 * `ValidatedRunContext`. Objects are built in a fixed key order and arrays are
 * sorted with locale-independent comparators, so the same report and context
 * serialize to the same bytes.
 *
 * The summary never contains a CI verdict (`ciVerdict` is always
 * "not-recorded-in-summary"): it is produced before the Gate. The verdict is
 * joined later from the completed Gate step through the GitHub API.
 *
 * Kept free of `@/` imports and of imports in general, so Node's
 * type-stripping test runner can load it directly (ADR-0002).
 */

/* ------------------------------------------------------------------ *
 * Versions, limits and enums
 * ------------------------------------------------------------------ */

export const SCHEMA_VERSION = '1.0.0';
export const GENERATOR_NAME = 'quality-summary';
export const GENERATOR_VERSION = '0.1.0';
export const CI_VERDICT = 'not-recorded-in-summary';

/** Exceeding any limit makes the whole summary unavailable, never truncated. */
export const LIMITS = Object.freeze({
  maxSuiteDepth: 32,
  maxExecutions: 10_000,
  maxAttemptsPerExecution: 10,
  maxStringLength: 200,
  maxTagsPerInstance: 8,
  maxLine: 1_000_000,
  maxDurationMs: 86_400_000,
  maxOutputBytes: 5 * 1024 * 1024,
});

/** The existing Gate's eight inputs (ADR-0007), in the Gate's own order. */
export const GATE_INPUT_NAMES = [
  'CHECKS',
  'SHARDS',
  'INVENTORY',
  'DOWNLOAD_1',
  'DOWNLOAD_2',
  'VERIFY',
  'MERGE',
  'UPLOAD',
] as const;
export type GateInputName = (typeof GATE_INPUT_NAMES)[number];

const GITHUB_RESULTS = ['success', 'failure', 'cancelled', 'skipped'] as const;
export const GATE_INPUT_STATES = [...GITHUB_RESULTS, 'unavailable', 'unknown'] as const;
export type GateInputState = (typeof GATE_INPUT_STATES)[number];

/** Every outcome, most severe first. The order drives aggregation and output. */
export const OUTCOMES = [
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
] as const;
export type Outcome = (typeof OUTCOMES)[number];

const PLAYWRIGHT_ATTEMPT_STATUSES = [
  'passed',
  'failed',
  'timedOut',
  'skipped',
  'interrupted',
] as const;
type PlaywrightAttemptStatus = (typeof PLAYWRIGHT_ATTEMPT_STATUSES)[number];
export type AttemptStatus = PlaywrightAttemptStatus | 'unclassified';

const REPORTED_STATUSES = ['expected', 'unexpected', 'flaky', 'skipped'] as const;
type PlaywrightTestStatus = (typeof REPORTED_STATUSES)[number];
export type ReportedStatus = PlaywrightTestStatus | 'invalid';

/**
 * Projects in `playwright.config.ts`. A second list by necessity, as in the
 * triage policy: this pure module cannot load the configuration. Unknown
 * names are reported as `unrecognized`, never echoed.
 */
export const KNOWN_PROJECTS = {
  api: { kind: 'api', browser: 'none' },
  chromium: { kind: 'ui', browser: 'chromium' },
  'chromium-authenticated': { kind: 'ui-authenticated', browser: 'chromium' },
  firefox: { kind: 'ui', browser: 'firefox' },
  'firefox-authenticated': { kind: 'ui-authenticated', browser: 'firefox' },
  setup: { kind: 'setup', browser: 'chromium' },
  webkit: { kind: 'ui', browser: 'webkit' },
  'webkit-authenticated': { kind: 'ui-authenticated', browser: 'webkit' },
} as const satisfies Record<string, { readonly kind: string; readonly browser: string }>;
export type KnownProject = keyof typeof KNOWN_PROJECTS;
export type ProjectLabel = KnownProject | 'unrecognized';
export type ProjectKind = (typeof KNOWN_PROJECTS)[KnownProject]['kind'];
export type Browser = (typeof KNOWN_PROJECTS)[KnownProject]['browser'];

/** Tags as the JSON reporter writes them (without `@`). Others are dropped. */
export const ALLOWED_TAGS = ['a11y', 'api', 'smoke'] as const;
export type Tag = (typeof ALLOWED_TAGS)[number];

/** Playwright's `testDir`; JSON spec paths are relative to it. */
export const TEST_DIR = 'tests';

export type RunEvent = 'push' | 'pull_request' | 'other';
export type BranchClass = 'main' | 'pull-request' | 'probe' | 'other' | 'unknown';
export type RunClassification = 'ordinary' | 'intentional-probe' | 'unknown';

/** States the CLI may report about the report file before `normalize` runs. */
export const REPORT_STATES = [
  'provided',
  'report-missing',
  'report-unreadable',
  'report-invalid-json',
  'report-too-large',
] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export type UnavailableReason =
  | Exclude<ReportState, 'provided'>
  | 'verification-not-successful'
  | 'merge-not-successful'
  | 'report-invalid-shape'
  | 'report-empty'
  | 'output-too-large'
  | 'internal-inconsistency';

export type Identity = 'resolved' | 'unresolved' | 'ambiguous-repeat-or-shard';
export type Multiplicity = 'single' | 'inferred-duplicate' | 'ambiguous';
/**
 * `provisional` marks an outcome whose precedence ADR-0009 leaves undecided:
 * an unexpected attempt followed by an interrupted one. The attempts are
 * preserved; consumers must not treat the outcome as established.
 */
export type OutcomeCertainty = 'established' | 'provisional';

/* ------------------------------------------------------------------ *
 * Output types
 * ------------------------------------------------------------------ */

export type OutcomeCounts = Readonly<Partial<Record<Outcome, number>>>;

export interface AttemptRecord {
  readonly retry: number | null;
  readonly status: AttemptStatus;
  readonly durationMs: number | null;
}

export interface ExecutionRecord {
  readonly outcome: Outcome;
  readonly outcomeCertainty: OutcomeCertainty;
  readonly reportedStatus: ReportedStatus;
  readonly consistent: boolean;
  readonly attempts: readonly AttemptRecord[];
}

export interface InstanceRecord {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly project: ProjectLabel;
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly locationGroupSize: number | null;
  readonly tags: readonly Tag[];
  readonly identity: Identity;
  readonly multiplicity: Multiplicity;
  readonly outcome: Outcome;
  readonly outcomeCertainty: OutcomeCertainty;
  readonly conflict: boolean;
  readonly executionOutcomes: OutcomeCounts;
  readonly executions: readonly ExecutionRecord[];
}

export interface ProjectRecord {
  readonly name: KnownProject;
  readonly kind: ProjectKind;
  readonly browser: Browser;
  readonly repeatEach: number | null;
}

export interface Completeness {
  readonly unrecognizedProjectExecutions: number;
  readonly unresolvedIdentities: number;
  readonly ambiguousIdentities: number;
  readonly inconsistentExecutions: number;
  readonly provisionalOutcomes: number;
  readonly unclassifiedAttempts: number;
  readonly invalidDurations: number;
  readonly invalidRetries: number;
  readonly droppedTags: number;
  readonly statsCrossCheck: 'match' | 'mismatch' | 'unavailable';
  readonly omissionDetection: 'not-supported';
  readonly shardAttribution: 'not-available';
}

export interface Totals {
  readonly definitions: number;
  readonly instances: number;
  readonly executions: number;
  readonly attempts: number;
  readonly retries: number;
  readonly zeroAttemptExecutions: number;
  readonly byInstanceOutcome: OutcomeCounts;
  readonly byExecutionOutcome: OutcomeCounts;
}

export interface RunRecord {
  readonly runId: number;
  readonly runAttempt: number;
  readonly event: RunEvent;
  readonly headSha: string;
  readonly branchClass: BranchClass;
  readonly classification: RunClassification;
  readonly generatedAt: string;
}

export type TestData =
  | { readonly state: 'available'; readonly reason: null }
  | { readonly state: 'unavailable'; readonly reason: UnavailableReason };

export interface QualitySummary {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly generator: { readonly name: typeof GENERATOR_NAME; readonly version: string };
  readonly run: RunRecord;
  readonly ciVerdict: typeof CI_VERDICT;
  readonly observedGateInputs: Readonly<Record<GateInputName, GateInputState>>;
  readonly testData: TestData;
  readonly completeness: Completeness | null;
  readonly projects: readonly ProjectRecord[];
  readonly instances: readonly InstanceRecord[];
  readonly totals: Totals | null;
}

/* ------------------------------------------------------------------ *
 * Run context
 * ------------------------------------------------------------------ */

export interface ValidatedRunContext {
  readonly kind: 'validated-run-context';
  readonly run: RunRecord;
  readonly observedGateInputs: Readonly<Record<GateInputName, GateInputState>>;
  readonly reportState: ReportState;
}

export type ContextProblem =
  | 'context-shape'
  | 'run-id'
  | 'run-attempt'
  | 'head-sha'
  | 'generated-at'
  | 'report-state'
  | 'gate-inputs';

export type ContextResult =
  | { readonly ok: true; readonly context: ValidatedRunContext }
  | { readonly ok: false; readonly problem: ContextProblem };

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

const SHA = /^[0-9a-f]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** `''` or a missing value is `unavailable` (the step did not run); other strings are `unknown`. */
export function gateInputState(value: unknown): GateInputState {
  if (value === undefined || value === null || value === '') {
    return 'unavailable';
  }
  return oneOf(GITHUB_RESULTS, value) ? value : 'unknown';
}

/** Classifies the raw branch name; the name itself is never kept. */
export function branchClass(event: RunEvent, branch: unknown): BranchClass {
  if (typeof branch !== 'string' || branch === '' || branch.length > 255) {
    return 'unknown';
  }
  if (branch.startsWith('probe/')) {
    return 'probe';
  }
  if (event === 'pull_request') {
    return 'pull-request';
  }
  return branch === 'main' ? 'main' : 'other';
}

function classificationOf(branch: BranchClass): RunClassification {
  if (branch === 'probe') {
    return 'intentional-probe';
  }
  return branch === 'unknown' ? 'unknown' : 'ordinary';
}

/**
 * Validates the impure shell's view of the run. Inputs: `runId`,
 * `runAttempt`, `event`, `headSha`, `branch` (raw; only classified),
 * `generatedAt` (ISO 8601 UTC), `reportState` and `gateInputs` (the eight
 * Gate values as GitHub expressions produced them).
 */
export function validateRunContext(input: unknown): ContextResult {
  if (!isRecord(input)) {
    return { ok: false, problem: 'context-shape' };
  }
  if (!isPositiveSafeInteger(input.runId)) {
    return { ok: false, problem: 'run-id' };
  }
  if (!isPositiveSafeInteger(input.runAttempt)) {
    return { ok: false, problem: 'run-attempt' };
  }
  if (typeof input.headSha !== 'string' || !SHA.test(input.headSha)) {
    return { ok: false, problem: 'head-sha' };
  }
  if (typeof input.generatedAt !== 'string' || !ISO_UTC.test(input.generatedAt)) {
    return { ok: false, problem: 'generated-at' };
  }
  if (!oneOf(REPORT_STATES, input.reportState)) {
    return { ok: false, problem: 'report-state' };
  }
  const gateInputs = input.gateInputs;
  if (!isRecord(gateInputs)) {
    return { ok: false, problem: 'gate-inputs' };
  }
  const event: RunEvent =
    input.event === 'push' || input.event === 'pull_request' ? input.event : 'other';
  const branch = branchClass(event, input.branch);
  const observed = Object.fromEntries(
    GATE_INPUT_NAMES.map((name) => [name, gateInputState(gateInputs[name])]),
  ) as Record<GateInputName, GateInputState>;
  return {
    ok: true,
    context: {
      kind: 'validated-run-context',
      run: {
        runId: input.runId,
        runAttempt: input.runAttempt,
        event,
        headSha: input.headSha,
        branchClass: branch,
        classification: classificationOf(branch),
        generatedAt: input.generatedAt,
      },
      observedGateInputs: observed,
      reportState: input.reportState,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Report collection
 * ------------------------------------------------------------------ */

const SPEC_FILE =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*\.(?:spec|setup)\.ts$/;

class ShapeError extends Error {}
class SizeError extends Error {}

interface Counters {
  invalidDurations: number;
  invalidRetries: number;
  unclassifiedAttempts: number;
}

interface RawExecution {
  readonly order: number;
  /** Internal only: the reported project name, never emitted. */
  readonly rawProject: string | undefined;
  readonly project: ProjectLabel;
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  /** Internal only: the test title, never emitted. */
  readonly title: string | undefined;
  readonly rawTags: readonly unknown[];
  readonly reportedStatus: ReportedStatus;
  readonly expectedStatus: PlaywrightAttemptStatus | undefined;
  readonly attempts: readonly AttemptRecord[];
}

function projectLabel(value: unknown): ProjectLabel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_PROJECTS, value)
    ? (value as KnownProject)
    : 'unrecognized';
}

function validFile(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length + TEST_DIR.length + 1 > LIMITS.maxStringLength ||
    value.includes('..') ||
    !SPEC_FILE.test(value)
  ) {
    return null;
  }
  return `${TEST_DIR}/${value}`;
}

function validPosition(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= LIMITS.maxLine
    ? value
    : null;
}

function attemptOf(value: unknown, counters: Counters): AttemptRecord {
  if (!isRecord(value)) {
    throw new ShapeError();
  }
  const status: AttemptStatus = oneOf(PLAYWRIGHT_ATTEMPT_STATUSES, value.status)
    ? value.status
    : 'unclassified';
  if (status === 'unclassified') {
    counters.unclassifiedAttempts += 1;
  }
  let retry: number | null = null;
  if (
    typeof value.retry === 'number' &&
    Number.isInteger(value.retry) &&
    value.retry >= 0 &&
    value.retry < LIMITS.maxAttemptsPerExecution
  ) {
    retry = value.retry;
  } else {
    counters.invalidRetries += 1;
  }
  let durationMs: number | null = null;
  if (
    typeof value.duration === 'number' &&
    Number.isFinite(value.duration) &&
    value.duration >= 0 &&
    value.duration <= LIMITS.maxDurationMs
  ) {
    durationMs = Math.round(value.duration);
  } else {
    counters.invalidDurations += 1;
  }
  return { retry, status, durationMs };
}

function collect(suites: unknown, depth: number, out: RawExecution[], counters: Counters): void {
  if (!Array.isArray(suites) || depth > LIMITS.maxSuiteDepth) {
    throw new ShapeError();
  }
  for (const suite of suites) {
    if (!isRecord(suite)) {
      throw new ShapeError();
    }
    const specs = suite.specs ?? [];
    if (!Array.isArray(specs)) {
      throw new ShapeError();
    }
    for (const spec of specs) {
      if (!isRecord(spec) || !Array.isArray(spec.tests)) {
        throw new ShapeError();
      }
      const file = validFile(spec.file);
      const line = validPosition(spec.line);
      const column = validPosition(spec.column);
      const title = typeof spec.title === 'string' && spec.title !== '' ? spec.title : undefined;
      const rawTags: readonly unknown[] = Array.isArray(spec.tags) ? spec.tags : [];
      for (const test of spec.tests) {
        if (!isRecord(test) || !Array.isArray(test.results)) {
          throw new ShapeError();
        }
        if (out.length >= LIMITS.maxExecutions) {
          throw new SizeError();
        }
        if (test.results.length > LIMITS.maxAttemptsPerExecution) {
          throw new SizeError();
        }
        out.push({
          order: out.length,
          rawProject: typeof test.projectName === 'string' ? test.projectName : undefined,
          project: projectLabel(test.projectName),
          file,
          line,
          column,
          title,
          rawTags,
          reportedStatus: oneOf(REPORTED_STATUSES, test.status) ? test.status : 'invalid',
          expectedStatus: oneOf(PLAYWRIGHT_ATTEMPT_STATUSES, test.expectedStatus)
            ? test.expectedStatus
            : undefined,
          attempts: test.results.map((result) => attemptOf(result, counters)),
        });
      }
    }
    if (suite.suites !== undefined) {
      collect(suite.suites, depth + 1, out, counters);
    }
  }
}

/** `repeatEach` per reported project name; `null` when absent, invalid or contradictory. */
function repeatEachByProject(report: UnknownRecord): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const config = report.config;
  const projects = isRecord(config) && Array.isArray(config.projects) ? config.projects : [];
  for (const project of projects) {
    if (!isRecord(project) || typeof project.name !== 'string') {
      continue;
    }
    const value =
      typeof project.repeatEach === 'number' &&
      Number.isInteger(project.repeatEach) &&
      project.repeatEach >= 1
        ? project.repeatEach
        : null;
    const previous = result.get(project.name);
    result.set(project.name, previous === undefined || previous === value ? value : null);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Outcome evaluation (per execution, from attempts)
 * ------------------------------------------------------------------ */

interface Evaluation {
  readonly outcome: Outcome;
  readonly certainty: OutcomeCertainty;
  readonly consistent: boolean;
}

function unexpectedOutcome(status: AttemptStatus): Outcome {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'timedOut':
      return 'timed-out';
    case 'passed':
      return 'unexpected-pass';
    default:
      return 'unclassified';
  }
}

/**
 * Buckets attempts exactly as Playwright 1.64.1's `computeTestCaseOutcome`
 * does, so the derived test-level status can be cross-checked against the
 * reported one. An interrupted attempt counts as neither expected nor
 * unexpected, which is why an interrupted-only test is reported as `skipped`.
 */
export function evaluateExecution(
  attempts: readonly AttemptRecord[],
  expectedStatus: PlaywrightAttemptStatus | undefined,
  reportedStatus: ReportedStatus,
): Evaluation {
  let interrupted = 0;
  let skippedExpected = 0;
  let expected = 0;
  let unexpected = 0;
  let lastUnexpected: AttemptStatus | undefined;
  let unclassified = false;
  for (const attempt of attempts) {
    if (attempt.status === 'unclassified') {
      unclassified = true;
    } else if (attempt.status === 'interrupted') {
      interrupted += 1;
    } else if (attempt.status === 'skipped') {
      if (expectedStatus === 'skipped') {
        skippedExpected += 1;
      }
    } else if (attempt.status === expectedStatus) {
      expected += 1;
    } else {
      unexpected += 1;
      lastUnexpected = attempt.status;
    }
  }
  let derived: PlaywrightTestStatus;
  if (expected === 0 && unexpected === 0) {
    derived = 'skipped';
  } else if (unexpected === 0) {
    derived = 'expected';
  } else if (expected === 0 && skippedExpected === 0) {
    derived = 'unexpected';
  } else {
    derived = 'flaky';
  }
  const consistent = !unclassified && expectedStatus !== undefined && reportedStatus === derived;
  if (!consistent) {
    return { outcome: 'unclassified', certainty: 'established', consistent: false };
  }
  if (attempts.length === 0) {
    return { outcome: 'did-not-run', certainty: 'established', consistent };
  }
  switch (derived) {
    case 'skipped':
      if (interrupted > 0) {
        return { outcome: 'interrupted', certainty: 'established', consistent };
      }
      return {
        outcome: skippedExpected > 0 ? 'skipped' : 'did-not-run',
        certainty: 'established',
        consistent,
      };
    case 'expected':
      return {
        outcome: expectedStatus === 'failed' ? 'expected-failure' : 'passed',
        certainty: 'established',
        consistent,
      };
    case 'unexpected': {
      const last = attempts[attempts.length - 1];
      if (last?.status === 'interrupted') {
        // ADR-0009 leaves the precedence of "unexpected, then interrupted"
        // undecided: the interruption is reported, the earlier attempts stay
        // in `attempts`, and the outcome is marked provisional.
        return { outcome: 'interrupted', certainty: 'provisional', consistent };
      }
      return {
        outcome: unexpectedOutcome(lastUnexpected ?? 'unclassified'),
        certainty: 'established',
        consistent,
      };
    }
    case 'flaky':
      return { outcome: 'flaky', certainty: 'established', consistent };
  }
}

/* ------------------------------------------------------------------ *
 * Grouping, identity and aggregation
 * ------------------------------------------------------------------ */

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function severity(outcome: Outcome): number {
  return OUTCOMES.indexOf(outcome);
}

function countOutcomes(outcomes: readonly Outcome[]): OutcomeCounts {
  const counts: Partial<Record<Outcome, number>> = {};
  for (const outcome of OUTCOMES) {
    const n = outcomes.filter((o) => o === outcome).length;
    if (n > 0) {
      counts[outcome] = n;
    }
  }
  return counts;
}

function padId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(5, '0')}`;
}

interface Group {
  readonly identity: Identity;
  readonly multiplicity: Multiplicity;
  readonly executions: readonly RawExecution[];
}

function isResolved(e: RawExecution): boolean {
  return (
    e.rawProject !== undefined &&
    e.title !== undefined &&
    e.file !== null &&
    e.line !== null &&
    e.column !== null
  );
}

function identityKey(e: RawExecution): string {
  return [e.rawProject, e.file, e.line, e.column, e.title].join('\u0000');
}

function locationKey(e: RawExecution): string {
  return [e.file, e.line, e.column].join('\u0000');
}

function groupExecutions(
  executions: readonly RawExecution[],
  repeatEach: ReadonlyMap<string, number | null>,
): Group[] {
  const groups: Group[] = [];
  const byKey = new Map<string, RawExecution[]>();
  for (const execution of executions) {
    if (!isResolved(execution)) {
      groups.push({ identity: 'unresolved', multiplicity: 'single', executions: [execution] });
      continue;
    }
    const key = identityKey(execution);
    const list = byKey.get(key);
    if (list === undefined) {
      byKey.set(key, [execution]);
    } else {
      list.push(execution);
    }
  }
  for (const list of byKey.values()) {
    const first = list[0];
    if (first === undefined) {
      continue;
    }
    if (list.length === 1) {
      groups.push({ identity: 'resolved', multiplicity: 'single', executions: list });
      continue;
    }
    // Same project, location and title more than once. With repeatEach 1 the
    // CI design implies one execution per shard: grouped, but labelled as an
    // inference (the JSON has no shard index). Otherwise the observations
    // stay separate and are flagged ambiguous.
    const repeats = first.rawProject === undefined ? undefined : repeatEach.get(first.rawProject);
    if (repeats === 1) {
      groups.push({ identity: 'resolved', multiplicity: 'inferred-duplicate', executions: list });
    } else {
      for (const execution of list) {
        groups.push({
          identity: 'ambiguous-repeat-or-shard',
          multiplicity: 'ambiguous',
          executions: [execution],
        });
      }
    }
  }
  return groups;
}

function sortKey(e: RawExecution): readonly (string | number)[] {
  return [
    e.project,
    e.rawProject ?? '',
    e.file ?? '',
    e.line ?? 0,
    e.column ?? 0,
    e.title ?? '',
    e.order,
  ];
}

function compareExecutions(a: RawExecution, b: RawExecution): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === y) {
      continue;
    }
    if (typeof x === 'number' && typeof y === 'number') {
      return x - y;
    }
    return compareStrings(String(x), String(y));
  }
  return 0;
}

function tagsOf(executions: readonly RawExecution[], dropped: { count: number }): Tag[] {
  const tags = new Set<Tag>();
  for (const execution of executions) {
    for (const tag of execution.rawTags) {
      if (oneOf(ALLOWED_TAGS, tag)) {
        tags.add(tag);
      } else {
        dropped.count += 1;
      }
    }
  }
  return ALLOWED_TAGS.filter((tag) => tags.has(tag)).slice(0, LIMITS.maxTagsPerInstance);
}

function crossCheckStats(
  report: UnknownRecord,
  executions: readonly RawExecution[],
): Completeness['statsCrossCheck'] {
  const stats = report.stats;
  if (!isRecord(stats)) {
    return 'unavailable';
  }
  let total = 0;
  for (const status of REPORTED_STATUSES) {
    const value = stats[status];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return 'unavailable';
    }
    if (value !== executions.filter((e) => e.reportedStatus === status).length) {
      return 'mismatch';
    }
    total += value;
  }
  return total === executions.length ? 'match' : 'mismatch';
}

/* ------------------------------------------------------------------ *
 * Invariants
 * ------------------------------------------------------------------ */

function sumCounts(counts: OutcomeCounts): number {
  return OUTCOMES.reduce((sum, outcome) => sum + (counts[outcome] ?? 0), 0);
}

/**
 * Names of violated counting invariants; empty when consistent. `normalize`
 * refuses to return an available summary that violates any of them.
 */
export function invariantViolations(summary: QualitySummary): string[] {
  const totals = summary.totals;
  if (summary.testData.state === 'unavailable') {
    return totals === null && summary.instances.length === 0 ? [] : ['unavailable-has-data'];
  }
  if (totals === null) {
    return ['totals-missing'];
  }
  const violations: string[] = [];
  const executions = summary.instances.flatMap((i) => i.executions);
  const attempts = executions.flatMap((e) => e.attempts);
  if (sumCounts(totals.byInstanceOutcome) !== totals.instances) {
    violations.push('instance-outcomes-sum');
  }
  if (sumCounts(totals.byExecutionOutcome) !== totals.executions) {
    violations.push('execution-outcomes-sum');
  }
  if (totals.executions < totals.instances) {
    violations.push('executions-at-least-instances');
  }
  if (totals.instances < totals.definitions) {
    violations.push('instances-at-least-definitions');
  }
  if (totals.retries > totals.attempts) {
    violations.push('retries-at-most-attempts');
  }
  if (
    totals.zeroAttemptExecutions !== executions.filter((e) => e.attempts.length === 0).length ||
    totals.zeroAttemptExecutions >
      (totals.byExecutionOutcome['did-not-run'] ?? 0) +
        (totals.byExecutionOutcome.unclassified ?? 0)
  ) {
    violations.push('zero-attempt-executions');
  }
  if (summary.instances.some((i) => sumCounts(i.executionOutcomes) !== i.executions.length)) {
    violations.push('instance-execution-multiplicity');
  }
  if (
    summary.instances.length !== totals.instances ||
    executions.length !== totals.executions ||
    attempts.length !== totals.attempts
  ) {
    violations.push('totals-match-records');
  }
  return violations;
}

/* ------------------------------------------------------------------ *
 * normalize
 * ------------------------------------------------------------------ */

/** Deterministic serialization: fixed key order, two-space indent, final newline. */
export function serialize(summary: QualitySummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

function unavailable(context: ValidatedRunContext, reason: UnavailableReason): QualitySummary {
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    run: context.run,
    ciVerdict: CI_VERDICT,
    observedGateInputs: context.observedGateInputs,
    testData: { state: 'unavailable', reason },
    completeness: null,
    projects: [],
    instances: [],
    totals: null,
  };
}

function runRecord(run: RunRecord): RunRecord {
  return {
    runId: run.runId,
    runAttempt: run.runAttempt,
    event: run.event,
    headSha: run.headSha,
    branchClass: run.branchClass,
    classification: run.classification,
    generatedAt: run.generatedAt,
  };
}

function gateRecord(
  inputs: Readonly<Record<GateInputName, GateInputState>>,
): Record<GateInputName, GateInputState> {
  return Object.fromEntries(GATE_INPUT_NAMES.map((name) => [name, inputs[name]])) as Record<
    GateInputName,
    GateInputState
  >;
}

/**
 * Normalizes a merged Playwright JSON report. `report` is untrusted; the
 * context must come from `validateRunContext`. The summary is unavailable,
 * with a fixed reason, unless the report was provided and both VERIFY and
 * MERGE were observed as `success`.
 */
export function normalize(report: unknown, context: ValidatedRunContext): QualitySummary {
  const safeContext: ValidatedRunContext = {
    kind: 'validated-run-context',
    run: runRecord(context.run),
    observedGateInputs: gateRecord(context.observedGateInputs),
    reportState: context.reportState,
  };
  if (safeContext.reportState !== 'provided') {
    return unavailable(safeContext, safeContext.reportState);
  }
  if (safeContext.observedGateInputs.VERIFY !== 'success') {
    return unavailable(safeContext, 'verification-not-successful');
  }
  if (safeContext.observedGateInputs.MERGE !== 'success') {
    return unavailable(safeContext, 'merge-not-successful');
  }
  if (!isRecord(report)) {
    return unavailable(safeContext, 'report-invalid-shape');
  }

  const counters: Counters = { invalidDurations: 0, invalidRetries: 0, unclassifiedAttempts: 0 };
  const raw: RawExecution[] = [];
  try {
    collect(report.suites, 0, raw, counters);
  } catch (error) {
    return unavailable(
      safeContext,
      error instanceof SizeError ? 'report-too-large' : 'report-invalid-shape',
    );
  }
  if (raw.length === 0) {
    // A report with no tests is not evidence that nothing failed.
    return unavailable(safeContext, 'report-empty');
  }

  const repeatEach = repeatEachByProject(report);
  const groups = groupExecutions(raw, repeatEach).map((group) => ({
    ...group,
    executions: [...group.executions].sort(compareExecutions),
  }));
  groups.sort((a, b) => {
    const x = a.executions[0];
    const y = b.executions[0];
    return x === undefined || y === undefined ? 0 : compareExecutions(x, y);
  });

  const titlesByLocation = new Map<string, Set<string>>();
  for (const execution of raw) {
    if (isResolved(execution) && execution.title !== undefined) {
      const key = locationKey(execution);
      const titles = titlesByLocation.get(key) ?? new Set<string>();
      titles.add(execution.title);
      titlesByLocation.set(key, titles);
    }
  }

  const definitionIds = new Map<string, string>();
  const dropped = { count: 0 };
  let inconsistentExecutions = 0;
  let provisionalOutcomes = 0;

  const instances: InstanceRecord[] = groups.map((group, index) => {
    const first = group.executions[0];
    if (first === undefined) {
      throw new Error('empty group');
    }
    const definitionKey =
      group.identity === 'unresolved'
        ? `unresolved\u0000${first.order}`
        : [first.file, first.line, first.column, first.title].join('\u0000');
    let definitionId = definitionIds.get(definitionKey);
    if (definitionId === undefined) {
      definitionId = padId('d', definitionIds.size + 1);
      definitionIds.set(definitionKey, definitionId);
    }
    const executions: ExecutionRecord[] = group.executions.map((execution) => {
      const evaluation = evaluateExecution(
        execution.attempts,
        execution.expectedStatus,
        execution.reportedStatus,
      );
      if (!evaluation.consistent) {
        inconsistentExecutions += 1;
      }
      if (evaluation.certainty === 'provisional') {
        provisionalOutcomes += 1;
      }
      return {
        outcome: evaluation.outcome,
        outcomeCertainty: evaluation.certainty,
        reportedStatus: execution.reportedStatus,
        consistent: evaluation.consistent,
        attempts: execution.attempts.map((attempt) => ({
          retry: attempt.retry,
          status: attempt.status,
          durationMs: attempt.durationMs,
        })),
      };
    });
    const outcomes = executions.map((e) => e.outcome);
    const outcome = outcomes.reduce<Outcome>(
      (worst, o) => (severity(o) < severity(worst) ? o : worst),
      'passed',
    );
    const titles =
      group.identity === 'unresolved' ? undefined : titlesByLocation.get(locationKey(first));
    return {
      instanceId: padId('i', index + 1),
      definitionId,
      project: first.project,
      file: first.file,
      line: first.line,
      column: first.column,
      locationGroupSize: titles === undefined ? null : titles.size,
      tags: tagsOf(group.executions, dropped),
      identity: group.identity,
      multiplicity: group.multiplicity,
      outcome,
      outcomeCertainty: executions.some((e) => e.outcomeCertainty === 'provisional')
        ? 'provisional'
        : 'established',
      conflict: new Set(outcomes).size > 1,
      executionOutcomes: countOutcomes(outcomes),
      executions,
    };
  });

  const projects: ProjectRecord[] = (Object.keys(KNOWN_PROJECTS) as KnownProject[])
    .filter((name) => repeatEach.has(name))
    .sort(compareStrings)
    .map((name) => ({
      name,
      kind: KNOWN_PROJECTS[name].kind,
      browser: KNOWN_PROJECTS[name].browser,
      repeatEach: repeatEach.get(name) ?? null,
    }));

  const allExecutions = instances.flatMap((i) => i.executions);
  const allAttempts = allExecutions.flatMap((e) => e.attempts);
  const totals: Totals = {
    definitions: definitionIds.size,
    instances: instances.length,
    executions: allExecutions.length,
    attempts: allAttempts.length,
    retries: allAttempts.filter((a) => a.retry !== null && a.retry > 0).length,
    zeroAttemptExecutions: allExecutions.filter((e) => e.attempts.length === 0).length,
    byInstanceOutcome: countOutcomes(instances.map((i) => i.outcome)),
    byExecutionOutcome: countOutcomes(allExecutions.map((e) => e.outcome)),
  };

  const summary: QualitySummary = {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    run: safeContext.run,
    ciVerdict: CI_VERDICT,
    observedGateInputs: safeContext.observedGateInputs,
    testData: { state: 'available', reason: null },
    completeness: {
      unrecognizedProjectExecutions: raw.filter((e) => e.project === 'unrecognized').length,
      unresolvedIdentities: instances.filter((i) => i.identity === 'unresolved').length,
      ambiguousIdentities: instances.filter((i) => i.identity === 'ambiguous-repeat-or-shard')
        .length,
      inconsistentExecutions,
      provisionalOutcomes,
      unclassifiedAttempts: counters.unclassifiedAttempts,
      invalidDurations: counters.invalidDurations,
      invalidRetries: counters.invalidRetries,
      droppedTags: dropped.count,
      statsCrossCheck: crossCheckStats(report, raw),
      omissionDetection: 'not-supported',
      shardAttribution: 'not-available',
    },
    projects,
    instances,
    totals,
  };

  if (invariantViolations(summary).length > 0) {
    return unavailable(safeContext, 'internal-inconsistency');
  }
  if (serialize(summary).length > LIMITS.maxOutputBytes) {
    return unavailable(safeContext, 'output-too-large');
  }
  return summary;
}
