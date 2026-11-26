/**
 * Dashboard data model (ADR-0009, M8C-1). Pure.
 *
 * Turns an untrusted quality-summary JSON text (the M8A schema, version 1.x)
 * into a display-ready view model for the future static dashboard. Two steps:
 *
 *   parseSummary(text)              -> ParsedSummary (validated or a fixed state)
 *   buildViewModel(parsed, filters) -> DashboardViewModel
 *
 * Every summary is untrusted, even one M8A produced: a file can be edited or
 * swapped. Validation follows the exported M8A types exactly, rebuilds the
 * summary field by field from validated values, and drops unknown fields, so
 * nothing unexpected can reach a view model. The view model contains only
 * enums, numbers, ordinal ids, validated spec paths, the commit SHA and the
 * generation timestamp -- no titles, error text, logs, attachments, URLs,
 * markup or raw branch names.
 *
 * Semantics:
 * - Missing totals are UNKNOWN (`{ known: false }`), never zero. Inside the
 *   M8A outcome maps an absent key means zero, as the contract defines.
 * - Definitions, instances, executions, attempts and retries stay separate;
 *   instances are the default quality unit.
 * - Outcomes are displayed as M8A classified them, never reclassified;
 *   consistency checks only flag disagreements.
 * - The CI verdict is always UNVERIFIED: a summary never contains it.
 * - Deliberate probe runs and runs of unknown classification are excluded
 *   from quality indicators unless explicitly included.
 * - A single summary has no history and no requirement coverage.
 *
 * No filesystem, environment, network, clock or DOM access. Only type
 * imports and constants from the pure M8A module, so Node's type-stripping
 * test runner can load it directly (ADR-0002).
 */
import {
  ALLOWED_TAGS,
  CI_VERDICT,
  GATE_INPUT_NAMES,
  GATE_INPUT_STATES,
  GENERATOR_NAME,
  KNOWN_PROJECTS,
  LIMITS,
  OUTCOMES,
  invariantViolations,
  type AttemptRecord,
  type AttemptStatus,
  type Browser,
  type BranchClass,
  type Completeness,
  type ExecutionRecord,
  type GateInputName,
  type GateInputState,
  type Identity,
  type InstanceRecord,
  type KnownProject,
  type Multiplicity,
  type Outcome,
  type OutcomeCertainty,
  type OutcomeCounts,
  type ProjectKind,
  type ProjectLabel,
  type ProjectRecord,
  type QualitySummary,
  type ReportedStatus,
  type RunClassification,
  type RunEvent,
  type RunRecord,
  type Tag,
  type Totals,
  type UnavailableReason,
} from './quality-summary.ts';

/* ------------------------------------------------------------------ *
 * Limits and enums mirrored from the M8A contract
 * ------------------------------------------------------------------ */

/** Same bound as the largest summary M8A will write. */
export const MAX_INPUT_BYTES = LIMITS.maxOutputBytes;
/** The deepest M8A structure is six levels (instances/executions/attempts). */
export const MAX_DEPTH = 8;
export const MAX_NODES = 2_000_000;
export const SUPPORTED_MAJOR = 1;

/** Typed as `Record` so a missing or extra member is a compile error. */
const ATTEMPT_STATUS_SET: Readonly<Record<AttemptStatus, true>> = {
  passed: true,
  failed: true,
  timedOut: true,
  skipped: true,
  interrupted: true,
  unclassified: true,
};
const REPORTED_STATUS_SET: Readonly<Record<ReportedStatus, true>> = {
  expected: true,
  unexpected: true,
  flaky: true,
  skipped: true,
  invalid: true,
};
const UNAVAILABLE_REASON_SET: Readonly<Record<UnavailableReason, true>> = {
  'report-missing': true,
  'report-unreadable': true,
  'report-invalid-json': true,
  'report-too-large': true,
  'verification-not-successful': true,
  'merge-not-successful': true,
  'report-invalid-shape': true,
  'report-empty': true,
  'output-too-large': true,
  'internal-inconsistency': true,
};
const RUN_EVENT_SET: Readonly<Record<RunEvent, true>> = {
  push: true,
  pull_request: true,
  other: true,
};
const BRANCH_CLASS_SET: Readonly<Record<BranchClass, true>> = {
  main: true,
  'pull-request': true,
  probe: true,
  other: true,
  unknown: true,
};
const CLASSIFICATION_SET: Readonly<Record<RunClassification, true>> = {
  ordinary: true,
  'intentional-probe': true,
  unknown: true,
};
const IDENTITY_SET: Readonly<Record<Identity, true>> = {
  resolved: true,
  unresolved: true,
  'ambiguous-repeat-or-shard': true,
};
const MULTIPLICITY_SET: Readonly<Record<Multiplicity, true>> = {
  single: true,
  'inferred-duplicate': true,
  ambiguous: true,
};
const CERTAINTY_SET: Readonly<Record<OutcomeCertainty, true>> = {
  established: true,
  provisional: true,
};
const STATS_CROSS_CHECK_SET: Readonly<Record<Completeness['statsCrossCheck'], true>> = {
  match: true,
  mismatch: true,
  unavailable: true,
};

const KNOWN_PROJECT_NAMES = Object.keys(KNOWN_PROJECTS) as KnownProject[];

export const RUN_CLASSIFICATIONS = Object.keys(CLASSIFICATION_SET) as RunClassification[];
export const PROJECT_LABELS = [
  ...Object.keys(KNOWN_PROJECTS),
  'unrecognized',
].sort() as ProjectLabel[];
export type DashboardBrowser = Browser | 'unknown';
export const BROWSERS = [
  ...new Set([...Object.values(KNOWN_PROJECTS).map((p) => p.browser), 'unknown']),
].sort() as DashboardBrowser[];

const SHA = /^[0-9a-f]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SEMVER = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/;
const INSTANCE_ID = /^i\d{5,7}$/;
const DEFINITION_ID = /^d\d{5,7}$/;
const SPEC_FILE =
  /^tests\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*\.(?:spec|setup)\.ts$/;

/* ------------------------------------------------------------------ *
 * Parse result
 * ------------------------------------------------------------------ */

export type InvalidProblem = 'input-too-large' | 'invalid-json' | 'too-deep' | 'invalid-structure';

export interface Consistency {
  readonly state: 'consistent' | 'inconsistent';
  /** Fixed check names, sorted; never input text. */
  readonly violations: readonly string[];
}

export interface ValidatedDashboardSummary {
  readonly kind: 'validated-dashboard-summary';
  readonly schemaVersion: string;
  /** Rebuilt from validated values only. */
  readonly summary: QualitySummary;
  readonly consistency: Consistency;
}

export type ParsedSummary =
  | { readonly state: 'no-summary' }
  | {
      readonly state: 'invalid';
      readonly problem: InvalidProblem;
      /** Schema path of the first failing field (from the schema, never input keys). */
      readonly path: string | null;
    }
  | { readonly state: 'schema-mismatch'; readonly foundMajor: number; readonly supportedMajor: 1 }
  | { readonly state: 'valid'; readonly validated: ValidatedDashboardSummary };

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

class InvalidField extends Error {
  readonly path: string;
  constructor(path: string) {
    super('invalid field');
    this.path = path;
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new InvalidField(path);
  }
  return value;
}

function array(value: unknown, path: string, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new InvalidField(path);
  }
  return value;
}

function int(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new InvalidField(path);
  }
  return value;
}

function nullableInt(value: unknown, path: string, min: number, max: number): number | null {
  return value === null ? null : int(value, path, min, max);
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new InvalidField(path);
  }
  return value;
}

function member<T extends string>(set: Readonly<Record<T, true>>, value: unknown, path: string): T {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(set, value)) {
    throw new InvalidField(path);
  }
  return value as T;
}

function listMember<T extends string>(values: readonly T[], value: unknown, path: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new InvalidField(path);
  }
  return value as T;
}

function matching(value: unknown, pattern: RegExp, path: string): string {
  if (typeof value !== 'string' || value.length > LIMITS.maxStringLength || !pattern.test(value)) {
    throw new InvalidField(path);
  }
  return value;
}

function exactly<T extends string | null>(value: unknown, expected: T, path: string): T {
  if (value !== expected) {
    throw new InvalidField(path);
  }
  return expected;
}

const MAX_COUNT = 100_000_000;

function outcomeCounts(value: unknown, path: string): OutcomeCounts {
  const raw = record(value, path);
  const counts: Partial<Record<Outcome, number>> = {};
  for (const key of Object.keys(raw)) {
    listMember(OUTCOMES, key, `${path}.<key>`);
  }
  for (const outcome of OUTCOMES) {
    if (Object.prototype.hasOwnProperty.call(raw, outcome)) {
      counts[outcome] = int(raw[outcome], `${path}.${outcome}`, 1, MAX_COUNT);
    }
  }
  return counts;
}

/** Iterative depth and size bound over the parsed JSON value. */
function withinBounds(root: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) {
      break;
    }
    nodes += 1;
    if (nodes > MAX_NODES || item.depth > MAX_DEPTH) {
      return false;
    }
    if (typeof item.value === 'object' && item.value !== null) {
      for (const child of Object.values(item.value)) {
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Schema validation (M8A QualitySummary 1.x)
 * ------------------------------------------------------------------ */

function runRecord(value: unknown): RunRecord {
  const run = record(value, 'run');
  const branchClass = member(BRANCH_CLASS_SET, run.branchClass, 'run.branchClass');
  const classification = member(CLASSIFICATION_SET, run.classification, 'run.classification');
  const expected: RunClassification =
    branchClass === 'probe'
      ? 'intentional-probe'
      : branchClass === 'unknown'
        ? 'unknown'
        : 'ordinary';
  if (classification !== expected) {
    throw new InvalidField('run.classification');
  }
  return {
    runId: int(run.runId, 'run.runId', 1, Number.MAX_SAFE_INTEGER),
    runAttempt: int(run.runAttempt, 'run.runAttempt', 1, Number.MAX_SAFE_INTEGER),
    event: member(RUN_EVENT_SET, run.event, 'run.event'),
    headSha: matching(run.headSha, SHA, 'run.headSha'),
    branchClass,
    classification,
    generatedAt: matching(run.generatedAt, ISO_UTC, 'run.generatedAt'),
  };
}

function gateInputs(value: unknown): Record<GateInputName, GateInputState> {
  const raw = record(value, 'observedGateInputs');
  return Object.fromEntries(
    GATE_INPUT_NAMES.map((name) => [
      name,
      listMember(GATE_INPUT_STATES, raw[name], `observedGateInputs.${name}`),
    ]),
  ) as Record<GateInputName, GateInputState>;
}

function completenessRecord(value: unknown): Completeness {
  const raw = record(value, 'completeness');
  const count = (key: string): number => int(raw[key], `completeness.${key}`, 0, MAX_COUNT);
  return {
    unrecognizedProjectExecutions: count('unrecognizedProjectExecutions'),
    unresolvedIdentities: count('unresolvedIdentities'),
    ambiguousIdentities: count('ambiguousIdentities'),
    inconsistentExecutions: count('inconsistentExecutions'),
    provisionalOutcomes: count('provisionalOutcomes'),
    unclassifiedAttempts: count('unclassifiedAttempts'),
    invalidDurations: count('invalidDurations'),
    invalidRetries: count('invalidRetries'),
    droppedTags: count('droppedTags'),
    statsCrossCheck: member(
      STATS_CROSS_CHECK_SET,
      raw.statsCrossCheck,
      'completeness.statsCrossCheck',
    ),
    omissionDetection: exactly(
      raw.omissionDetection,
      'not-supported',
      'completeness.omissionDetection',
    ),
    shardAttribution: exactly(
      raw.shardAttribution,
      'not-available',
      'completeness.shardAttribution',
    ),
  };
}

function projectRecords(value: unknown): ProjectRecord[] {
  const raw = array(value, 'projects', Object.keys(KNOWN_PROJECTS).length);
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const p = record(item, `projects[${i}]`);
    const name = listMember(KNOWN_PROJECT_NAMES, p.name, `projects[${i}].name`);
    if (seen.has(name)) {
      throw new InvalidField(`projects[${i}].name`);
    }
    seen.add(name);
    const expected = KNOWN_PROJECTS[name];
    return {
      name,
      kind: exactly<ProjectKind>(p.kind, expected.kind, `projects[${i}].kind`),
      browser: exactly<Browser>(p.browser, expected.browser, `projects[${i}].browser`),
      repeatEach: nullableInt(
        p.repeatEach,
        `projects[${i}].repeatEach`,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    };
  });
}

function attemptRecord(value: unknown, path: string): AttemptRecord {
  const a = record(value, path);
  return {
    retry: nullableInt(a.retry, `${path}.retry`, 0, LIMITS.maxAttemptsPerExecution - 1),
    status: member(ATTEMPT_STATUS_SET, a.status, `${path}.status`),
    durationMs: nullableInt(a.durationMs, `${path}.durationMs`, 0, LIMITS.maxDurationMs),
  };
}

function executionRecord(value: unknown, path: string): ExecutionRecord {
  const e = record(value, path);
  return {
    outcome: listMember(OUTCOMES, e.outcome, `${path}.outcome`),
    outcomeCertainty: member(CERTAINTY_SET, e.outcomeCertainty, `${path}.outcomeCertainty`),
    reportedStatus: member(REPORTED_STATUS_SET, e.reportedStatus, `${path}.reportedStatus`),
    consistent: bool(e.consistent, `${path}.consistent`),
    attempts: array(e.attempts, `${path}.attempts`, LIMITS.maxAttemptsPerExecution).map((a, k) =>
      attemptRecord(a, `${path}.attempts[${k}]`),
    ),
  };
}

function tagList(value: unknown, path: string): Tag[] {
  const raw = array(value, path, LIMITS.maxTagsPerInstance);
  const tags = raw.map((t, k) => listMember(ALLOWED_TAGS, t, `${path}[${k}]`));
  if (new Set(tags).size !== tags.length) {
    throw new InvalidField(path);
  }
  return ALLOWED_TAGS.filter((t) => tags.includes(t));
}

function instanceRecord(value: unknown, path: string): InstanceRecord {
  const r = record(value, path);
  const file = r.file === null ? null : matching(r.file, SPEC_FILE, `${path}.file`);
  if (file !== null && file.includes('..')) {
    throw new InvalidField(`${path}.file`);
  }
  const executions = array(r.executions, `${path}.executions`, LIMITS.maxExecutions);
  if (executions.length === 0) {
    throw new InvalidField(`${path}.executions`);
  }
  return {
    instanceId: matching(r.instanceId, INSTANCE_ID, `${path}.instanceId`),
    definitionId: matching(r.definitionId, DEFINITION_ID, `${path}.definitionId`),
    project: listMember(PROJECT_LABELS, r.project, `${path}.project`),
    file,
    line: nullableInt(r.line, `${path}.line`, 1, LIMITS.maxLine),
    column: nullableInt(r.column, `${path}.column`, 1, LIMITS.maxLine),
    locationGroupSize: nullableInt(
      r.locationGroupSize,
      `${path}.locationGroupSize`,
      1,
      LIMITS.maxExecutions,
    ),
    tags: tagList(r.tags, `${path}.tags`),
    identity: member(IDENTITY_SET, r.identity, `${path}.identity`),
    multiplicity: member(MULTIPLICITY_SET, r.multiplicity, `${path}.multiplicity`),
    outcome: listMember(OUTCOMES, r.outcome, `${path}.outcome`),
    outcomeCertainty: member(CERTAINTY_SET, r.outcomeCertainty, `${path}.outcomeCertainty`),
    conflict: bool(r.conflict, `${path}.conflict`),
    executionOutcomes: outcomeCounts(r.executionOutcomes, `${path}.executionOutcomes`),
    executions: executions.map((e, j) => executionRecord(e, `${path}.executions[${j}]`)),
  };
}

function totalsRecord(value: unknown): Totals {
  const t = record(value, 'totals');
  const count = (key: string): number => int(t[key], `totals.${key}`, 0, MAX_COUNT);
  return {
    definitions: count('definitions'),
    instances: count('instances'),
    executions: count('executions'),
    attempts: count('attempts'),
    retries: count('retries'),
    zeroAttemptExecutions: count('zeroAttemptExecutions'),
    byInstanceOutcome: outcomeCounts(t.byInstanceOutcome, 'totals.byInstanceOutcome'),
    byExecutionOutcome: outcomeCounts(t.byExecutionOutcome, 'totals.byExecutionOutcome'),
  };
}

function validate(raw: UnknownRecord, schemaVersion: string): QualitySummary {
  const generator = record(raw.generator, 'generator');
  exactly(generator.name, GENERATOR_NAME, 'generator.name');
  const generatorVersion = matching(generator.version, SEMVER, 'generator.version');
  const run = runRecord(raw.run);
  exactly(raw.ciVerdict, CI_VERDICT, 'ciVerdict');
  const observedGateInputs = gateInputs(raw.observedGateInputs);
  const testData = record(raw.testData, 'testData');
  const base: Pick<
    QualitySummary,
    'schemaVersion' | 'generator' | 'run' | 'ciVerdict' | 'observedGateInputs'
  > = {
    schemaVersion: schemaVersion as QualitySummary['schemaVersion'],
    generator: { name: GENERATOR_NAME, version: generatorVersion },
    run,
    ciVerdict: CI_VERDICT,
    observedGateInputs,
  };
  if (testData.state === 'unavailable') {
    const reason = member(UNAVAILABLE_REASON_SET, testData.reason, 'testData.reason');
    exactly(raw.completeness, null, 'completeness');
    exactly(raw.totals, null, 'totals');
    if (array(raw.projects, 'projects', 0).length !== 0) {
      throw new InvalidField('projects');
    }
    if (array(raw.instances, 'instances', 0).length !== 0) {
      throw new InvalidField('instances');
    }
    return {
      ...base,
      testData: { state: 'unavailable', reason },
      completeness: null,
      projects: [],
      instances: [],
      totals: null,
    };
  }
  exactly(testData.state, 'available', 'testData.state');
  exactly(testData.reason, null, 'testData.reason');
  const instances = array(raw.instances, 'instances', LIMITS.maxExecutions).map((item, i) =>
    instanceRecord(item, `instances[${i}]`),
  );
  const executionTotal = instances.reduce((n, i) => n + i.executions.length, 0);
  if (executionTotal > LIMITS.maxExecutions) {
    throw new InvalidField('instances');
  }
  const ids = new Set(instances.map((i) => i.instanceId));
  if (ids.size !== instances.length) {
    throw new InvalidField('instances.instanceId');
  }
  return {
    ...base,
    testData: { state: 'available', reason: null },
    completeness: completenessRecord(raw.completeness),
    projects: projectRecords(raw.projects),
    instances,
    totals: totalsRecord(raw.totals),
  };
}

/* ------------------------------------------------------------------ *
 * Consistency checks (flag, never correct or reclassify)
 * ------------------------------------------------------------------ */

function severity(outcome: Outcome): number {
  return OUTCOMES.indexOf(outcome);
}

const IDENTITY_MULTIPLICITY: Readonly<Record<Identity, readonly Multiplicity[]>> = {
  resolved: ['single', 'inferred-duplicate'],
  unresolved: ['single'],
  'ambiguous-repeat-or-shard': ['ambiguous'],
};

function consistencyOf(summary: QualitySummary): Consistency {
  const violations = new Set<string>(invariantViolations(summary));
  const instances = summary.instances;
  const executions = instances.flatMap((i) => i.executions);
  for (const instance of instances) {
    const outcomes = instance.executions.map((e) => e.outcome);
    const worst = outcomes.reduce<Outcome>((w, o) => (severity(o) < severity(w) ? o : w), 'passed');
    if (instance.outcome !== worst) {
      violations.add('instance-outcome-not-most-severe');
    }
    if (instance.conflict !== new Set(outcomes).size > 1) {
      violations.add('conflict-flag');
    }
    const provisional = instance.executions.some((e) => e.outcomeCertainty === 'provisional');
    if ((instance.outcomeCertainty === 'provisional') !== provisional) {
      violations.add('instance-certainty');
    }
    if (!IDENTITY_MULTIPLICITY[instance.identity].includes(instance.multiplicity)) {
      violations.add('identity-multiplicity');
    }
    if (instance.multiplicity !== 'inferred-duplicate' && instance.executions.length !== 1) {
      violations.add('multiplicity-execution-count');
    }
    for (const outcome of OUTCOMES) {
      if (
        (instance.executionOutcomes[outcome] ?? 0) !== outcomes.filter((o) => o === outcome).length
      ) {
        violations.add('execution-outcomes-map');
      }
    }
  }
  const totals = summary.totals;
  const completeness = summary.completeness;
  if (totals !== null) {
    if (totals.definitions !== new Set(instances.map((i) => i.definitionId)).size) {
      violations.add('definitions-count');
    }
    const retries = executions.flatMap((e) => e.attempts).filter((a) => (a.retry ?? 0) > 0).length;
    if (totals.retries !== retries) {
      violations.add('retries-count');
    }
    for (const outcome of OUTCOMES) {
      if (
        (totals.byInstanceOutcome[outcome] ?? 0) !==
        instances.filter((i) => i.outcome === outcome).length
      ) {
        violations.add('instance-outcome-totals');
      }
      if (
        (totals.byExecutionOutcome[outcome] ?? 0) !==
        executions.filter((e) => e.outcome === outcome).length
      ) {
        violations.add('execution-outcome-totals');
      }
    }
  }
  if (completeness !== null) {
    const checks: [string, number, number][] = [
      [
        'unresolved-identities',
        completeness.unresolvedIdentities,
        instances.filter((i) => i.identity === 'unresolved').length,
      ],
      [
        'ambiguous-identities',
        completeness.ambiguousIdentities,
        instances.filter((i) => i.identity === 'ambiguous-repeat-or-shard').length,
      ],
      [
        'provisional-outcomes',
        completeness.provisionalOutcomes,
        executions.filter((e) => e.outcomeCertainty === 'provisional').length,
      ],
      [
        'inconsistent-executions',
        completeness.inconsistentExecutions,
        executions.filter((e) => !e.consistent).length,
      ],
    ];
    for (const [name, reported, actual] of checks) {
      if (reported !== actual) {
        violations.add(`completeness-${name}`);
      }
    }
  }
  const list = [...violations].sort();
  return { state: list.length === 0 ? 'consistent' : 'inconsistent', violations: list };
}

/* ------------------------------------------------------------------ *
 * parseSummary
 * ------------------------------------------------------------------ */

/**
 * Validates an untrusted summary text. Empty or whitespace-only text is "no
 * summary"; a major version other than 1 is a schema mismatch; anything
 * malformed is invalid with a fixed problem code and schema path.
 */
export function parseSummary(text: string): ParsedSummary {
  if (typeof text !== 'string' || text.trim() === '') {
    return { state: 'no-summary' };
  }
  if (new TextEncoder().encode(text).length > MAX_INPUT_BYTES) {
    return { state: 'invalid', problem: 'input-too-large', path: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { state: 'invalid', problem: 'invalid-json', path: null };
  }
  if (!withinBounds(raw)) {
    return { state: 'invalid', problem: 'too-deep', path: null };
  }
  if (!isRecord(raw)) {
    return { state: 'invalid', problem: 'invalid-structure', path: '$' };
  }
  const version = typeof raw.schemaVersion === 'string' ? SEMVER.exec(raw.schemaVersion) : null;
  if (version === null) {
    return { state: 'invalid', problem: 'invalid-structure', path: 'schemaVersion' };
  }
  const major = Number(version[1]);
  if (major !== SUPPORTED_MAJOR) {
    return { state: 'schema-mismatch', foundMajor: major, supportedMajor: 1 };
  }
  try {
    const summary = validate(raw, version[0]);
    return {
      state: 'valid',
      validated: {
        kind: 'validated-dashboard-summary',
        schemaVersion: version[0],
        summary,
        consistency: consistencyOf(summary),
      },
    };
  } catch (error) {
    return {
      state: 'invalid',
      problem: 'invalid-structure',
      path: error instanceof InvalidField ? error.path : null,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

export interface DashboardFilters {
  /** Empty means all. Unknown values are ignored and counted. */
  readonly projects?: readonly string[];
  readonly browsers?: readonly string[];
  readonly outcomes?: readonly string[];
  readonly classifications?: readonly string[];
  readonly ambiguousOnly?: boolean;
  readonly provisionalOnly?: boolean;
  /** Include deliberate probe runs and unknown-classification runs in quality indicators. */
  readonly includeProbeRuns?: boolean;
}

export interface NormalizedFilters {
  readonly projects: readonly ProjectLabel[];
  readonly browsers: readonly DashboardBrowser[];
  readonly outcomes: readonly Outcome[];
  readonly classifications: readonly RunClassification[];
  readonly ambiguousOnly: boolean;
  readonly provisionalOnly: boolean;
  readonly includeProbeRuns: boolean;
  readonly ignoredValues: number;
  readonly active: boolean;
}

function pick<T extends string>(
  values: readonly string[] | undefined,
  allowed: readonly T[],
  ignored: { count: number },
): T[] {
  const chosen = new Set<T>();
  for (const value of values ?? []) {
    if ((allowed as readonly string[]).includes(value)) {
      chosen.add(value as T);
    } else {
      ignored.count += 1;
    }
  }
  return allowed.filter((v) => chosen.has(v));
}

export function normalizeFilters(filters: DashboardFilters = {}): NormalizedFilters {
  const ignored = { count: 0 };
  const projects = pick(filters.projects, PROJECT_LABELS, ignored);
  const browsers = pick(filters.browsers, BROWSERS, ignored);
  const outcomes = pick(filters.outcomes, OUTCOMES, ignored);
  const classifications = pick(filters.classifications, RUN_CLASSIFICATIONS, ignored);
  const ambiguousOnly = filters.ambiguousOnly === true;
  const provisionalOnly = filters.provisionalOnly === true;
  return {
    projects,
    browsers,
    outcomes,
    classifications,
    ambiguousOnly,
    provisionalOnly,
    includeProbeRuns: filters.includeProbeRuns === true,
    ignoredValues: ignored.count,
    active:
      projects.length + browsers.length + outcomes.length + classifications.length > 0 ||
      ambiguousOnly ||
      provisionalOnly,
  };
}

/* ------------------------------------------------------------------ *
 * View model types
 * ------------------------------------------------------------------ */

/** A count that may be unknown; never a fabricated zero. */
export type Count = { readonly known: true; readonly value: number } | { readonly known: false };

const UNKNOWN: Count = { known: false };
function known(value: number): Count {
  return { known: true, value };
}

export type DashboardState = 'no-summary' | 'valid' | 'unavailable' | 'schema-mismatch' | 'invalid';

export type Badge =
  | 'provisional'
  | 'ambiguous-identity'
  | 'inferred-duplicate'
  | 'unresolved-identity'
  | 'unrecognized-project'
  | 'conflict'
  | 'inconsistent-execution';

export type Notice =
  | 'no-summary'
  | 'invalid-summary'
  | 'schema-mismatch'
  | 'test-data-unavailable'
  | 'inconsistent-data'
  | 'probe-run-excluded'
  | 'probe-run-included'
  | 'unknown-classification-excluded'
  | 'unknown-classification-included'
  | 'run-excluded-by-classification-filter'
  | 'provisional-outcomes-present'
  | 'ambiguous-identities-present'
  | 'inferred-duplicates-present'
  | 'unrecognized-projects-present'
  | 'filters-active'
  | 'filter-values-ignored'
  | 'ci-verdict-unverified'
  | 'no-history'
  | 'no-requirement-coverage';

export interface UnitTotals {
  readonly definitions: Count;
  readonly instances: Count;
  readonly executions: Count;
  readonly attempts: Count;
  readonly retries: Count;
  readonly zeroAttemptExecutions: Count;
}

export interface OutcomeCount {
  readonly outcome: Outcome;
  readonly count: number;
}

export interface AttemptView {
  readonly retry: number | null;
  readonly status: AttemptStatus;
  readonly durationMs: number | null;
}

export interface ExecutionView {
  readonly outcome: Outcome;
  readonly outcomeCertainty: OutcomeCertainty;
  readonly reportedStatus: ReportedStatus;
  readonly consistent: boolean;
  readonly attempts: readonly AttemptView[];
}

export interface InstanceRow {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly project: ProjectLabel;
  readonly browser: DashboardBrowser;
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly locationGroupSize: number | null;
  readonly tags: readonly Tag[];
  readonly outcome: Outcome;
  readonly outcomeCertainty: OutcomeCertainty;
  readonly identity: Identity;
  readonly multiplicity: Multiplicity;
  readonly conflict: boolean;
  readonly executionCount: number;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly badges: readonly Badge[];
  readonly executions: readonly ExecutionView[];
}

export interface ProjectRow {
  readonly project: ProjectLabel;
  readonly kind: ProjectKind | 'unknown';
  readonly browser: DashboardBrowser;
  readonly repeatEach: Count;
  readonly instances: number;
  readonly executions: number;
  readonly attempts: number;
  readonly retries: number;
  readonly byInstanceOutcome: readonly OutcomeCount[];
}

export type Section<T> =
  | { readonly status: 'available'; readonly data: T }
  | {
      readonly status: 'unavailable';
      readonly reason: UnavailableReason | 'no-summary' | 'schema-mismatch' | 'invalid-summary';
    }
  | {
      readonly status: 'excluded';
      readonly reason: 'probe-run' | 'unknown-classification' | 'classification-filter';
    };

export interface Overview {
  readonly qualityUnit: 'instances';
  readonly scope: 'ordinary' | 'probe-included' | 'unknown-classification-included';
  readonly wholeRun: UnitTotals;
  readonly filtered: UnitTotals;
  readonly byInstanceOutcome: readonly OutcomeCount[];
  readonly byExecutionOutcome: readonly OutcomeCount[];
  readonly filteredByInstanceOutcome: readonly OutcomeCount[];
}

export interface FailureIntelligence {
  readonly note: 'structured-status-not-root-cause';
  readonly failed: readonly string[];
  readonly timedOut: readonly string[];
  readonly interrupted: readonly string[];
  readonly unexpectedPass: readonly string[];
  readonly flaky: readonly string[];
  readonly unclassified: readonly string[];
  readonly provisional: readonly string[];
  readonly conflicts: readonly string[];
  readonly retried: readonly { readonly instanceId: string; readonly retries: number }[];
}

export interface GateObservation {
  readonly name: GateInputName;
  readonly state: GateInputState;
}

export interface CompletenessView {
  readonly testData: 'available' | 'unavailable' | 'unknown';
  readonly unavailableReason: UnavailableReason | null;
  readonly consistency: 'consistent' | 'inconsistent' | 'unknown';
  readonly violations: readonly string[];
  readonly counts: {
    readonly unrecognizedProjectExecutions: Count;
    readonly unresolvedIdentities: Count;
    readonly ambiguousIdentities: Count;
    readonly inconsistentExecutions: Count;
    readonly provisionalOutcomes: Count;
    readonly unclassifiedAttempts: Count;
    readonly invalidDurations: Count;
    readonly invalidRetries: Count;
    readonly droppedTags: Count;
  };
  readonly statsCrossCheck: Completeness['statsCrossCheck'] | 'unknown';
  readonly omissionDetection: 'not-supported';
  readonly shardAttribution: 'not-available';
  readonly history: 'not-available-single-run';
  readonly requirementCoverage: 'not-available';
}

export interface RunHeader {
  readonly schemaVersion: string;
  readonly generatorVersion: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly event: RunEvent;
  readonly headSha: string;
  readonly branchClass: BranchClass;
  readonly classification: RunClassification;
  readonly generatedAt: string;
}

export interface DashboardViewModel {
  readonly state: DashboardState;
  readonly invalidProblem: InvalidProblem | null;
  readonly invalidPath: string | null;
  readonly schemaMismatch: { readonly foundMajor: number; readonly supportedMajor: 1 } | null;
  readonly run: RunHeader | null;
  readonly ciVerdict: { readonly status: 'unverified'; readonly reason: 'not-recorded-in-summary' };
  readonly filters: NormalizedFilters;
  readonly notices: readonly Notice[];
  readonly overview: Section<Overview>;
  readonly explorer: Section<readonly InstanceRow[]>;
  readonly projects: Section<readonly ProjectRow[]>;
  readonly failures: Section<FailureIntelligence>;
  readonly gate: Section<readonly GateObservation[]>;
  readonly completeness: CompletenessView;
}

/* ------------------------------------------------------------------ *
 * buildViewModel
 * ------------------------------------------------------------------ */

const CI_VERDICT_VIEW = { status: 'unverified', reason: 'not-recorded-in-summary' } as const;

function browserOf(project: ProjectLabel): DashboardBrowser {
  return project === 'unrecognized' ? 'unknown' : KNOWN_PROJECTS[project].browser;
}

function outcomeList(counts: OutcomeCounts): OutcomeCount[] {
  return OUTCOMES.map((outcome) => ({ outcome, count: counts[outcome] ?? 0 }));
}

function countBy<T>(items: readonly T[], outcomeOf: (item: T) => Outcome): OutcomeCount[] {
  return OUTCOMES.map((outcome) => ({
    outcome,
    count: items.filter((item) => outcomeOf(item) === outcome).length,
  }));
}

function badgesOf(instance: InstanceRecord): Badge[] {
  const badges: Badge[] = [];
  if (instance.outcomeCertainty === 'provisional') badges.push('provisional');
  if (instance.identity === 'ambiguous-repeat-or-shard') badges.push('ambiguous-identity');
  if (instance.multiplicity === 'inferred-duplicate') badges.push('inferred-duplicate');
  if (instance.identity === 'unresolved') badges.push('unresolved-identity');
  if (instance.project === 'unrecognized') badges.push('unrecognized-project');
  if (instance.conflict) badges.push('conflict');
  if (instance.executions.some((e) => !e.consistent)) badges.push('inconsistent-execution');
  return badges;
}

function rowOf(instance: InstanceRecord): InstanceRow {
  const attempts = instance.executions.flatMap((e) => e.attempts);
  return {
    instanceId: instance.instanceId,
    definitionId: instance.definitionId,
    project: instance.project,
    browser: browserOf(instance.project),
    file: instance.file,
    line: instance.line,
    column: instance.column,
    locationGroupSize: instance.locationGroupSize,
    tags: [...instance.tags],
    outcome: instance.outcome,
    outcomeCertainty: instance.outcomeCertainty,
    identity: instance.identity,
    multiplicity: instance.multiplicity,
    conflict: instance.conflict,
    executionCount: instance.executions.length,
    attemptCount: attempts.length,
    retryCount: attempts.filter((a) => (a.retry ?? 0) > 0).length,
    badges: badgesOf(instance),
    executions: instance.executions.map((e) => ({
      outcome: e.outcome,
      outcomeCertainty: e.outcomeCertainty,
      reportedStatus: e.reportedStatus,
      consistent: e.consistent,
      attempts: e.attempts.map((a) => ({
        retry: a.retry,
        status: a.status,
        durationMs: a.durationMs,
      })),
    })),
  };
}

function unitTotals(rows: readonly InstanceRow[]): UnitTotals {
  return {
    definitions: known(new Set(rows.map((r) => r.definitionId)).size),
    instances: known(rows.length),
    executions: known(rows.reduce((n, r) => n + r.executionCount, 0)),
    attempts: known(rows.reduce((n, r) => n + r.attemptCount, 0)),
    retries: known(rows.reduce((n, r) => n + r.retryCount, 0)),
    zeroAttemptExecutions: known(
      rows.reduce((n, r) => n + r.executions.filter((e) => e.attempts.length === 0).length, 0),
    ),
  };
}

function emptyCompleteness(
  testData: CompletenessView['testData'],
  reason: UnavailableReason | null,
): CompletenessView {
  return {
    testData,
    unavailableReason: reason,
    consistency: 'unknown',
    violations: [],
    counts: {
      unrecognizedProjectExecutions: UNKNOWN,
      unresolvedIdentities: UNKNOWN,
      ambiguousIdentities: UNKNOWN,
      inconsistentExecutions: UNKNOWN,
      provisionalOutcomes: UNKNOWN,
      unclassifiedAttempts: UNKNOWN,
      invalidDurations: UNKNOWN,
      invalidRetries: UNKNOWN,
      droppedTags: UNKNOWN,
    },
    statsCrossCheck: 'unknown',
    omissionDetection: 'not-supported',
    shardAttribution: 'not-available',
    history: 'not-available-single-run',
    requirementCoverage: 'not-available',
  };
}

function nonValid(
  state: Exclude<DashboardState, 'valid' | 'unavailable'>,
  filters: NormalizedFilters,
  extra: Pick<DashboardViewModel, 'invalidProblem' | 'invalidPath' | 'schemaMismatch'>,
): DashboardViewModel {
  const reason = state === 'invalid' ? 'invalid-summary' : state;
  const notice: Notice = state === 'invalid' ? 'invalid-summary' : state;
  const section = { status: 'unavailable', reason } as const;
  return {
    state,
    ...extra,
    run: null,
    ciVerdict: CI_VERDICT_VIEW,
    filters,
    notices: [notice, 'ci-verdict-unverified', 'no-history'],
    overview: section,
    explorer: section,
    projects: section,
    failures: section,
    gate: section,
    completeness: emptyCompleteness('unknown', null),
  };
}

/**
 * Builds the dashboard view model. Pure and deterministic: the same parse
 * result and filters always give a deep-equal result.
 */
export function buildViewModel(
  parsed: ParsedSummary,
  filters: DashboardFilters = {},
): DashboardViewModel {
  const normalized = normalizeFilters(filters);
  const none = { invalidProblem: null, invalidPath: null, schemaMismatch: null };
  if (parsed.state === 'no-summary') {
    return nonValid('no-summary', normalized, none);
  }
  if (parsed.state === 'invalid') {
    return nonValid('invalid', normalized, {
      ...none,
      invalidProblem: parsed.problem,
      invalidPath: parsed.path,
    });
  }
  if (parsed.state === 'schema-mismatch') {
    return nonValid('schema-mismatch', normalized, {
      ...none,
      schemaMismatch: { foundMajor: parsed.foundMajor, supportedMajor: parsed.supportedMajor },
    });
  }

  const { summary, consistency, schemaVersion } = parsed.validated;
  const run: RunHeader = {
    schemaVersion,
    generatorVersion: summary.generator.version,
    runId: summary.run.runId,
    runAttempt: summary.run.runAttempt,
    event: summary.run.event,
    headSha: summary.run.headSha,
    branchClass: summary.run.branchClass,
    classification: summary.run.classification,
    generatedAt: summary.run.generatedAt,
  };
  const gate: Section<readonly GateObservation[]> = {
    status: 'available',
    data: GATE_INPUT_NAMES.map((name) => ({ name, state: summary.observedGateInputs[name] })),
  };
  const notices = new Set<Notice>([
    'ci-verdict-unverified',
    'no-history',
    'no-requirement-coverage',
  ]);
  if (normalized.active) notices.add('filters-active');
  if (normalized.ignoredValues > 0) notices.add('filter-values-ignored');

  if (summary.testData.state === 'unavailable') {
    notices.add('test-data-unavailable');
    const section = { status: 'unavailable', reason: summary.testData.reason } as const;
    return {
      state: 'unavailable',
      ...none,
      run,
      ciVerdict: CI_VERDICT_VIEW,
      filters: normalized,
      notices: [...notices].sort(),
      overview: section,
      explorer: section,
      projects: section,
      failures: section,
      gate,
      completeness: emptyCompleteness('unavailable', summary.testData.reason),
    };
  }

  const totals = summary.totals;
  const completeness = summary.completeness;
  if (totals === null || completeness === null) {
    // Unreachable after validation; kept explicit rather than assuming zero.
    return nonValid('invalid', normalized, {
      ...none,
      invalidProblem: 'invalid-structure',
      invalidPath: 'totals',
    });
  }

  if (consistency.state === 'inconsistent') notices.add('inconsistent-data');
  const allRows = [...summary.instances]
    .sort((a, b) => (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0))
    .map(rowOf);
  if (allRows.some((r) => r.outcomeCertainty === 'provisional'))
    notices.add('provisional-outcomes-present');
  if (allRows.some((r) => r.identity === 'ambiguous-repeat-or-shard'))
    notices.add('ambiguous-identities-present');
  if (allRows.some((r) => r.multiplicity === 'inferred-duplicate'))
    notices.add('inferred-duplicates-present');
  if (allRows.some((r) => r.project === 'unrecognized'))
    notices.add('unrecognized-projects-present');

  const classification = summary.run.classification;
  let exclusion: 'probe-run' | 'unknown-classification' | 'classification-filter' | null = null;
  if (classification === 'intentional-probe') {
    notices.add(normalized.includeProbeRuns ? 'probe-run-included' : 'probe-run-excluded');
    if (!normalized.includeProbeRuns) exclusion = 'probe-run';
  } else if (classification === 'unknown') {
    notices.add(
      normalized.includeProbeRuns
        ? 'unknown-classification-included'
        : 'unknown-classification-excluded',
    );
    if (!normalized.includeProbeRuns) exclusion = 'unknown-classification';
  }
  if (
    exclusion === null &&
    normalized.classifications.length > 0 &&
    !normalized.classifications.includes(classification)
  ) {
    exclusion = 'classification-filter';
    notices.add('run-excluded-by-classification-filter');
  }

  const rows = allRows.filter(
    (r) =>
      (normalized.projects.length === 0 || normalized.projects.includes(r.project)) &&
      (normalized.browsers.length === 0 || normalized.browsers.includes(r.browser)) &&
      (normalized.outcomes.length === 0 || normalized.outcomes.includes(r.outcome)) &&
      (!normalized.ambiguousOnly || r.identity === 'ambiguous-repeat-or-shard') &&
      (!normalized.provisionalOnly || r.outcomeCertainty === 'provisional'),
  );

  const wholeRun: UnitTotals = {
    definitions: known(totals.definitions),
    instances: known(totals.instances),
    executions: known(totals.executions),
    attempts: known(totals.attempts),
    retries: known(totals.retries),
    zeroAttemptExecutions: known(totals.zeroAttemptExecutions),
  };

  const completenessView: CompletenessView = {
    testData: 'available',
    unavailableReason: null,
    consistency: consistency.state,
    violations: consistency.violations,
    counts: {
      unrecognizedProjectExecutions: known(completeness.unrecognizedProjectExecutions),
      unresolvedIdentities: known(completeness.unresolvedIdentities),
      ambiguousIdentities: known(completeness.ambiguousIdentities),
      inconsistentExecutions: known(completeness.inconsistentExecutions),
      provisionalOutcomes: known(completeness.provisionalOutcomes),
      unclassifiedAttempts: known(completeness.unclassifiedAttempts),
      invalidDurations: known(completeness.invalidDurations),
      invalidRetries: known(completeness.invalidRetries),
      droppedTags: known(completeness.droppedTags),
    },
    statsCrossCheck: completeness.statsCrossCheck,
    omissionDetection: completeness.omissionDetection,
    shardAttribution: completeness.shardAttribution,
    history: 'not-available-single-run',
    requirementCoverage: 'not-available',
  };

  const base = {
    state: 'valid' as const,
    ...none,
    run,
    ciVerdict: CI_VERDICT_VIEW,
    filters: normalized,
    notices: [...notices].sort(),
    gate,
    completeness: completenessView,
  };

  if (exclusion !== null) {
    const section = { status: 'excluded', reason: exclusion } as const;
    return { ...base, overview: section, explorer: section, projects: section, failures: section };
  }

  const ids = (predicate: (r: InstanceRow) => boolean): string[] =>
    rows.filter(predicate).map((r) => r.instanceId);
  const projectNames = new Set<ProjectLabel>([
    ...summary.projects.map((p) => p.name),
    ...rows.map((r) => r.project),
  ]);
  const projectRows: ProjectRow[] = [...projectNames]
    .filter((p) => normalized.projects.length === 0 || normalized.projects.includes(p))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((project) => {
      const own = rows.filter((r) => r.project === project);
      const config = summary.projects.find((p) => p.name === project);
      return {
        project,
        kind: config?.kind ?? 'unknown',
        browser: browserOf(project),
        repeatEach:
          config?.repeatEach === undefined || config.repeatEach === null
            ? UNKNOWN
            : known(config.repeatEach),
        instances: own.length,
        executions: own.reduce((n, r) => n + r.executionCount, 0),
        attempts: own.reduce((n, r) => n + r.attemptCount, 0),
        retries: own.reduce((n, r) => n + r.retryCount, 0),
        byInstanceOutcome: countBy(own, (r) => r.outcome),
      };
    });

  return {
    ...base,
    overview: {
      status: 'available',
      data: {
        qualityUnit: 'instances',
        scope:
          classification === 'ordinary'
            ? 'ordinary'
            : classification === 'intentional-probe'
              ? 'probe-included'
              : 'unknown-classification-included',
        wholeRun,
        filtered: unitTotals(rows),
        byInstanceOutcome: outcomeList(totals.byInstanceOutcome),
        byExecutionOutcome: outcomeList(totals.byExecutionOutcome),
        filteredByInstanceOutcome: countBy(rows, (r) => r.outcome),
      },
    },
    explorer: { status: 'available', data: rows },
    projects: { status: 'available', data: projectRows },
    failures: {
      status: 'available',
      data: {
        note: 'structured-status-not-root-cause',
        failed: ids((r) => r.outcome === 'failed'),
        timedOut: ids((r) => r.outcome === 'timed-out'),
        interrupted: ids((r) => r.outcome === 'interrupted'),
        unexpectedPass: ids((r) => r.outcome === 'unexpected-pass'),
        flaky: ids((r) => r.outcome === 'flaky'),
        unclassified: ids((r) => r.outcome === 'unclassified'),
        provisional: ids((r) => r.outcomeCertainty === 'provisional'),
        conflicts: ids((r) => r.conflict),
        retried: rows
          .filter((r) => r.retryCount > 0)
          .map((r) => ({ instanceId: r.instanceId, retries: r.retryCount }))
          .sort(
            (a, b) =>
              b.retries - a.retries ||
              (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0),
          ),
      },
    },
  };
}
