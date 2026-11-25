/**
 * Failure triage for the merged Playwright JSON report (ADR-0008). Pure.
 *
 * Turns the verified, merged report into a small, safe summary: one category
 * per logical test, derived ONLY from structured status fields, plus at most
 * a fixed number of GitHub annotations. It never reads or emits free text
 * from the report -- no error messages, stacks, expected/received values,
 * test titles, stdout/stderr, attachments, request data, git metadata or
 * absolute error locations. Anything that cannot be validated is omitted
 * (a location) or reported with a fixed label (a project), never passed
 * through.
 *
 * Triage is advisory. It does not decide whether CI passes; the M6 gate does
 * (ADR-0007). An input that cannot be read yields a fixed "unavailable"
 * result, never an empty "nothing failed" summary.
 *
 * Kept free of `@/` imports so Node's type-stripping runner can load it
 * directly (ADR-0002).
 */

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

/** Every category, most severe first. The order drives output ordering. */
export const CATEGORIES = [
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
export type Category = (typeof CATEGORIES)[number];

/** Categories published as `::error` annotations. */
export const ERROR_CATEGORIES: readonly Category[] = [
  'failed',
  'timed-out',
  'interrupted',
  'unexpected-pass',
  'unclassified',
];
/** Categories published as `::warning` annotations. */
export const WARNING_CATEGORIES: readonly Category[] = ['flaky'];

/** The approved maximum per annotation level (ADR-0008, D5). */
export const MAX_ANNOTATIONS_PER_LEVEL = 10;
/** Items listed individually in the job summary; counts are always complete. */
export const MAX_SUMMARY_ITEMS = 50;

/**
 * Projects in `playwright.config.ts`. A second list by necessity: the config
 * imports runtime modules this pure file cannot load. An unknown name is
 * reported as `unrecognized-project`, never echoed.
 */
export const KNOWN_PROJECTS = [
  'setup',
  'chromium',
  'firefox',
  'webkit',
  'chromium-authenticated',
  'firefox-authenticated',
  'webkit-authenticated',
  'api',
] as const;
export type ProjectLabel = (typeof KNOWN_PROJECTS)[number] | 'unrecognized-project';

/** Playwright's `testDir`; JSON spec paths are relative to it. */
export const TEST_DIR = 'tests';

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export interface SourceLocation {
  /** Repository-relative, validated: `tests/<path>.spec.ts` or `.setup.ts`. */
  readonly file: string;
  readonly line: number;
}

/** One logical test after de-duplicating executions (for example `setup` per shard). */
export interface TriageItem {
  readonly category: Category;
  readonly project: ProjectLabel;
  /** Omitted when the reported path or line did not validate. */
  readonly location?: SourceLocation;
  /** How many executions (shards × projects) contributed to this item. */
  readonly executions: number;
}

export type UnavailableReason =
  | 'merge-not-successful'
  | 'report-missing'
  | 'report-unreadable'
  | 'report-invalid-json'
  | 'report-invalid-shape'
  | 'report-empty'
  | 'report-too-large'
  | 'internal-error';

export type TriageResult =
  | {
      readonly kind: 'triaged';
      readonly items: readonly TriageItem[];
      readonly logicalCounts: Readonly<Record<Category, number>>;
      readonly executionCounts: Readonly<Record<Category, number>>;
      readonly logicalTests: number;
      readonly executions: number;
    }
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason };

/* ------------------------------------------------------------------ *
 * Runtime validation helpers
 * ------------------------------------------------------------------ */

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TEST_STATUSES = ['expected', 'unexpected', 'flaky', 'skipped'] as const;
type TestStatus = (typeof TEST_STATUSES)[number];
const RESULT_STATUSES = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'] as const;
type ResultStatus = (typeof RESULT_STATUSES)[number];

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Bounds that keep a hostile or broken report from exhausting the runner. */
const MAX_SUITE_DEPTH = 32;
const MAX_TESTS = 10_000;
const MAX_LINE = 1_000_000;

const SPEC_FILE =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*\.(?:spec|setup)\.ts$/;

export function projectLabel(value: unknown): ProjectLabel {
  return oneOf(KNOWN_PROJECTS, value) ? value : 'unrecognized-project';
}

/** A validated repository-relative location, or `undefined`. */
export function sourceLocation(file: unknown, line: unknown): SourceLocation | undefined {
  if (typeof file !== 'string' || !SPEC_FILE.test(file) || file.includes('..')) {
    return undefined;
  }
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > MAX_LINE) {
    return undefined;
  }
  return { file: `${TEST_DIR}/${file}`, line };
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

function assertNever(value: never): never {
  throw new Error(`unhandled value: ${String(value)}`);
}

/**
 * One execution's category, from structured fields only. `results` are the
 * attempt statuses in order; an invalid status anywhere is `unclassified`.
 */
export function classify(
  status: unknown,
  expectedStatus: unknown,
  results: readonly unknown[],
): Category {
  if (!oneOf(TEST_STATUSES, status)) {
    return 'unclassified';
  }
  const attempts: ResultStatus[] = [];
  for (const result of results) {
    if (!oneOf(RESULT_STATUSES, result)) {
      return 'unclassified';
    }
    attempts.push(result);
  }
  const last = attempts.at(-1);
  const test: TestStatus = status;
  switch (test) {
    case 'flaky':
      return 'flaky';
    case 'skipped':
      return attempts.length === 0 ? 'did-not-run' : 'skipped';
    case 'expected':
      return expectedStatus === 'failed' ? 'expected-failure' : 'passed';
    case 'unexpected':
      if (last === undefined) {
        return 'unclassified';
      }
      switch (last) {
        case 'failed':
          return 'failed';
        case 'timedOut':
          return 'timed-out';
        case 'interrupted':
          return 'interrupted';
        case 'passed':
          return 'unexpected-pass';
        case 'skipped':
          return 'unclassified';
        default:
          return assertNever(last);
      }
    default:
      return assertNever(test);
  }
}

function severity(category: Category): number {
  return CATEGORIES.indexOf(category);
}

function zeroCounts(): Record<Category, number> {
  return Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
}

/* ------------------------------------------------------------------ *
 * Report walk
 * ------------------------------------------------------------------ */

interface Execution {
  readonly key: string;
  readonly category: Category;
  readonly project: ProjectLabel;
  readonly location: SourceLocation | undefined;
}

class ShapeError extends Error {}
class SizeError extends Error {}

function collect(suites: unknown, depth: number, out: Execution[]): void {
  if (!Array.isArray(suites) || depth > MAX_SUITE_DEPTH) {
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
      const location = sourceLocation(spec.file, spec.line);
      // Identity only, never output. Spec ids are NOT stable across shards:
      // merging suffixes a repeated id (observed, Playwright 1.64.1).
      const column = Number.isInteger(spec.column) ? String(spec.column) : '';
      const title = typeof spec.title === 'string' ? spec.title : undefined;
      for (const test of spec.tests) {
        if (!isRecord(test) || !Array.isArray(test.results)) {
          throw new ShapeError();
        }
        if (out.length >= MAX_TESTS) {
          throw new SizeError();
        }
        const statuses = test.results.map((r) => (isRecord(r) ? r.status : undefined));
        const project = projectLabel(test.projectName);
        // Executions of the same test in the same project are one logical
        // test (for example `setup`, which runs once per shard). The key uses
        // project, validated location, column and title; the title is a map
        // key only and is never published. Without a valid location and
        // title there is no safe identity, so the execution counts alone.
        const key =
          location !== undefined && title !== undefined
            ? [project, location.file, location.line, column, title].join('\u0000')
            : `unidentified\u0000${out.length}`;
        out.push({
          key,
          category: classify(test.status, test.expectedStatus, statuses),
          project,
          location,
        });
      }
    }
    if (suite.suites !== undefined) {
      collect(suite.suites, depth + 1, out);
    }
  }
}

function compareItems(a: TriageItem, b: TriageItem): number {
  return (
    severity(a.category) - severity(b.category) ||
    a.project.localeCompare(b.project) ||
    (a.location?.file ?? '￿').localeCompare(b.location?.file ?? '￿') ||
    (a.location?.line ?? 0) - (b.location?.line ?? 0)
  );
}

/**
 * Triage a parsed JSON report (`unknown`). Deterministic: the same input
 * always gives the same output, in the same order.
 */
export function triage(report: unknown): TriageResult {
  if (!isRecord(report)) {
    return { kind: 'unavailable', reason: 'report-invalid-shape' };
  }
  const executions: Execution[] = [];
  try {
    collect(report.suites, 0, executions);
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof SizeError ? 'report-too-large' : 'report-invalid-shape',
    };
  }

  if (executions.length === 0) {
    // A report with no tests is not evidence that nothing failed.
    return { kind: 'unavailable', reason: 'report-empty' };
  }

  const executionCounts = zeroCounts();
  const byKey = new Map<string, { item: TriageItem }>();
  for (const execution of executions) {
    executionCounts[execution.category] += 1;
    const existing = byKey.get(execution.key);
    if (existing === undefined) {
      byKey.set(execution.key, {
        item: {
          category: execution.category,
          project: execution.project,
          ...(execution.location ? { location: execution.location } : {}),
          executions: 1,
        },
      });
      continue;
    }
    // The most severe outcome of any execution wins.
    const current = existing.item;
    existing.item = {
      ...current,
      category:
        severity(execution.category) < severity(current.category)
          ? execution.category
          : current.category,
      executions: current.executions + 1,
    };
  }

  const items = [...byKey.values()].map((entry) => entry.item).sort(compareItems);
  const logicalCounts = zeroCounts();
  for (const item of items) {
    logicalCounts[item.category] += 1;
  }
  return {
    kind: 'triaged',
    items,
    logicalCounts,
    executionCounts,
    logicalTests: items.length,
    executions: executions.length,
  };
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

/** GitHub workflow-command escaping for a message (`data`). */
export function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** GitHub workflow-command escaping for a property value. */
export function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export interface AnnotationLimits {
  readonly errors: number;
  readonly warnings: number;
}

function clampLimit(value: number): number {
  return Number.isInteger(value) ? Math.min(Math.max(value, 0), MAX_ANNOTATIONS_PER_LEVEL) : 0;
}

function describe(item: TriageItem): string {
  const where = item.location ? `${item.location.file}:${item.location.line}` : 'location withheld';
  return `${item.category} · [${item.project}] · ${where}`;
}

function annotation(level: 'error' | 'warning', item: TriageItem): string {
  const properties = [
    ...(item.location
      ? [
          `file=${escapeProperty(item.location.file)}`,
          `line=${escapeProperty(String(item.location.line))}`,
        ]
      : []),
    `title=${escapeProperty(`Test triage: ${item.category}`)}`,
  ].join(',');
  return `::${level} ${properties}::${escapeData(describe(item))}`;
}

/** Workflow commands to print, capped per level (never above the approved maximum). */
export function annotations(result: TriageResult, limits: AnnotationLimits): string[] {
  if (result.kind === 'unavailable') {
    return [
      `::warning title=${escapeProperty('Test triage unavailable')}::${escapeData(
        `Test triage unavailable (${result.reason}). This is not a test result; see the gate.`,
      )}`,
    ];
  }
  const errors = result.items.filter((i) => ERROR_CATEGORIES.includes(i.category));
  const warnings = result.items.filter((i) => WARNING_CATEGORIES.includes(i.category));
  return [
    ...errors.slice(0, clampLimit(limits.errors)).map((i) => annotation('error', i)),
    ...warnings.slice(0, clampLimit(limits.warnings)).map((i) => annotation('warning', i)),
  ];
}

/** Markdown for `$GITHUB_STEP_SUMMARY`. Only fixed text and validated fields. */
export function summary(result: TriageResult): string {
  if (result.kind === 'unavailable') {
    return [
      '## Test triage',
      '',
      `**Unavailable** (\`${result.reason}\`). No classification was produced; this is`,
      'not a test result. The required `test` gate decides pass or fail.',
      '',
    ].join('\n');
  }
  const rows = CATEGORIES.map(
    (c) => `| ${c} | ${result.logicalCounts[c]} | ${result.executionCounts[c]} |`,
  );
  const listed = result.items.filter(
    (i) => ERROR_CATEGORIES.includes(i.category) || WARNING_CATEGORIES.includes(i.category),
  );
  const lines = listed.slice(0, MAX_SUMMARY_ITEMS).map((i) => `- ${describe(i)}`);
  if (listed.length > MAX_SUMMARY_ITEMS) {
    lines.push(`- … and ${listed.length - MAX_SUMMARY_ITEMS} more (see the HTML report)`);
  }
  return [
    '## Test triage',
    '',
    'Advisory: classified from structured test statuses only. The required',
    '`test` gate decides pass or fail.',
    '',
    `Logical tests: ${result.logicalTests} · Executions: ${result.executions}`,
    '',
    '| Category | Logical tests | Executions |',
    '| --- | --- | --- |',
    ...rows,
    '',
    ...(lines.length > 0 ? ['### Needs attention', '', ...lines] : ['No failed or flaky tests.']),
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Orchestration with injected I/O (used by scripts/triage-report.ts)
 * ------------------------------------------------------------------ */

/** What the adapter could load: a parsed report, or a fixed reason it could not. */
export type LoadedReport =
  | { readonly kind: 'parsed'; readonly value: unknown }
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason };

export interface TriageIo {
  /** Reads and parses the report. May throw; a throw becomes `internal-error`. */
  readonly loadReport: () => Promise<LoadedReport>;
  /** Writes one line to the log (workflow commands are lines). */
  readonly print: (line: string) => void;
  /** Appends Markdown to the job summary. May throw. */
  readonly appendSummary: (markdown: string) => Promise<void>;
  /** Classification; injectable so tests can force a failure. */
  readonly classify?: (report: unknown) => TriageResult;
}

const INTERNAL_ERROR: TriageResult = { kind: 'unavailable', reason: 'internal-error' };

/**
 * Fixed fallback output. Built only from constants, so it cannot depend on
 * whatever failed and cannot carry an exception message.
 */
const FALLBACK_WARNING =
  '::warning title=Test triage unavailable::Test triage unavailable (internal-error). This is not a test result; see the gate.';
const FALLBACK_SUMMARY = [
  '## Test triage',
  '',
  '**Unavailable** (`internal-error`). No classification was produced; this is',
  'not a test result. The required `test` gate decides pass or fail.',
  '',
].join('\n');
const SUMMARY_WRITE_FAILED =
  '::warning title=Test triage::Test triage summary could not be written.';

/**
 * Runs triage end to end and returns the process exit code: 0 when triage
 * was produced and its summary written, 1 otherwise. Never rethrows: any
 * exception in loading, classification or rendering becomes the fixed
 * `internal-error` result, and no exception value is ever printed.
 */
export async function runTriage(io: TriageIo): Promise<number> {
  const classifyReport = io.classify ?? triage;

  let result: TriageResult;
  try {
    const loaded = await io.loadReport();
    result = loaded.kind === 'parsed' ? classifyReport(loaded.value) : loaded;
  } catch {
    result = INTERNAL_ERROR;
  }

  let lines: string[];
  let markdown: string;
  try {
    lines = annotations(result, {
      errors: MAX_ANNOTATIONS_PER_LEVEL,
      warnings: MAX_ANNOTATIONS_PER_LEVEL,
    });
    markdown = summary(result);
  } catch {
    result = INTERNAL_ERROR;
    lines = [FALLBACK_WARNING];
    markdown = FALLBACK_SUMMARY;
  }

  for (const line of lines) {
    io.print(line);
  }

  let summaryWritten = true;
  try {
    await io.appendSummary(`${markdown}\n`);
  } catch {
    summaryWritten = false;
    io.print(SUMMARY_WRITE_FAILED);
  }

  if (result.kind === 'unavailable') {
    io.print(`test triage: unavailable (${result.reason})`);
    return 1;
  }
  io.print(
    `test triage: ${result.logicalTests} logical tests, ${result.executions} executions classified`,
  );
  return summaryWritten ? 0 : 1;
}
