/**
 * Quality summary CLI application logic (ADR-0009, M8B).
 *
 * The impure shell around the pure M8A normalizer (`./quality-summary.ts`):
 * it validates the run context and the target, validates every path, reads
 * the merged JSON report only when VERIFY and MERGE were observed as
 * `success`, and writes the serialized summary atomically. All normalization
 * and aggregation stays in M8A; this module adds no schema of its own.
 *
 * Adapter boundaries: the environment arrives as a plain object, the clock as
 * a function and the filesystem as an `FsAdapter`, so tests can drive every
 * path with synthetic values. `scripts/quality-summary.ts` supplies the real
 * ones.
 *
 * Environment contract (all values are validated, none is trusted):
 *
 *   GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_EVENT_NAME  run identity
 *   QS_HEAD_SHA                                           commit under test
 *   QS_BRANCH                                             raw branch; classified only
 *   CHECKS SHARDS INVENTORY DOWNLOAD_1 DOWNLOAD_2
 *   VERIFY MERGE UPLOAD                                   the eight Gate inputs
 *   APP_TARGET, BASE_URL                                  restricted-target refusal
 *   RUNNER_TEMP                                           optional second input root
 *
 * Diagnostics are fixed codes only: no path, error text, report content or
 * environment value is ever returned or printed.
 *
 * Kept free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { resolveConfig } from '../config/env.ts';
import { isRestricted } from '../config/security.ts';
import {
  GATE_INPUT_NAMES,
  normalize,
  serialize,
  validateRunContext,
  type QualitySummary,
  type ReportState,
  type UnavailableReason,
} from './quality-summary.ts';

/* ------------------------------------------------------------------ *
 * Contract
 * ------------------------------------------------------------------ */

/** Larger reports are not read; the summary records `report-too-large`. */
export const MAX_REPORT_BYTES = 50 * 1024 * 1024;

/** The only file name ever written, inside the validated output directory. */
export const OUTPUT_FILE = 'quality-summary.json';

const MAX_ARG_LENGTH = 4096;

/**
 * Exit codes:
 *   0  a summary was written (available or unavailable)
 *   1  refused or failed; no summary was written or replaced
 *   2  usage error
 */
export type ExitCode = 0 | 1 | 2;

export type CliCode =
  | 'written-available'
  | 'written-unavailable'
  | 'usage'
  | 'invalid-configuration'
  | 'restricted-target'
  | 'invalid-run-context'
  | 'unsafe-input-path'
  | 'unsafe-output-path'
  | 'write-failed'
  | 'internal-error';

export interface CliResult {
  readonly exitCode: ExitCode;
  readonly code: CliCode;
  /** The summary's unavailable reason when `written-unavailable`, else null. */
  readonly reason: UnavailableReason | null;
}

export interface CliArgs {
  readonly reportPath: string;
  readonly outputDir: string;
}

export interface FileInfo {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
}

/** The filesystem operations the CLI performs. Every path is pre-validated. */
export interface FsAdapter {
  /** `undefined` when nothing exists at the path. Never follows a final symlink. */
  readonly lstat: (path: string) => FileInfo | undefined;
  readonly realpath: (path: string) => string;
  readonly readFile: (path: string) => string;
  readonly mkdir: (path: string) => void;
  /** Creates `path` exclusively (fails if it exists), writes and syncs it. */
  readonly writeNew: (path: string, data: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
}

export interface CliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** ISO 8601 UTC timestamp for the summary's `generatedAt`. */
  readonly now: () => string;
  /** Distinguishes temporary files of concurrent runs. */
  readonly pid: number;
  readonly fs: FsAdapter;
}

const MESSAGES: Readonly<Record<CliCode, string>> = {
  'written-available': 'summary written (test data available)',
  'written-unavailable': 'summary written (test data unavailable)',
  usage: 'usage: node scripts/quality-summary.ts <report.json> <output-dir>',
  'invalid-configuration': 'refused: target configuration is invalid',
  'restricted-target': 'refused: restricted targets never produce a summary',
  'invalid-run-context': 'refused: run context is invalid',
  'unsafe-input-path': 'refused: report path is not allowed',
  'unsafe-output-path': 'refused: output path is not allowed',
  'write-failed': 'failed: the summary could not be written',
  'internal-error': 'failed: internal error',
};

/** A fixed, value-free line for the console. */
export function resultMessage(result: CliResult): string {
  const reason = result.reason === null ? '' : ` [${result.reason}]`;
  return `quality-summary: ${result.code}${reason} — ${MESSAGES[result.code]}`;
}

function refuse(code: CliCode, exitCode: ExitCode = 1): CliResult {
  return { exitCode, code, reason: null };
}

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

function validArg(value: string | undefined): value is string {
  return (
    value !== undefined && value !== '' && value.length <= MAX_ARG_LENGTH && !value.includes('\0')
  );
}

/** Exactly two positional arguments: `<report.json> <output-dir>`. */
export function parseArgs(
  argv: readonly string[],
): { readonly ok: true; readonly args: CliArgs } | { readonly ok: false } {
  const [reportPath, outputDir, ...rest] = argv;
  if (!validArg(reportPath) || !validArg(outputDir) || rest.length > 0) {
    return { ok: false };
  }
  return { ok: true, args: { reportPath, outputDir } };
}

/* ------------------------------------------------------------------ *
 * Path safety
 * ------------------------------------------------------------------ */

/** True when `child` is strictly inside `root` (not equal, no `..` escape). */
export function isStrictlyWithin(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function isWithinOrEqual(child: string, root: string): boolean {
  return child === root || isStrictlyWithin(child, root);
}

/** Segments that mark saved authentication state; never read. */
const FORBIDDEN_SEGMENTS = ['.auth'];

function hasForbiddenSegment(path: string): boolean {
  return path.split(sep).some((segment) => FORBIDDEN_SEGMENTS.includes(segment.toLowerCase()));
}

type InputCheck =
  | { readonly kind: 'read'; readonly path: string }
  | { readonly kind: 'state'; readonly state: Exclude<ReportState, 'provided'> }
  | { readonly kind: 'unsafe' };

/**
 * The report must be a `.json` file whose resolved location, and whose
 * parent directory after resolving symlinks, lie inside an allowed root (the
 * working directory or `RUNNER_TEMP`). The report itself must not be a
 * symlink, and no path segment may name saved authentication state.
 */
function checkInput(reportArg: string, deps: CliDeps): InputCheck {
  const { fs } = deps;
  const reportPath = resolve(deps.cwd, reportArg);
  if (!reportPath.toLowerCase().endsWith('.json') || hasForbiddenSegment(reportPath)) {
    return { kind: 'unsafe' };
  }
  const roots = [deps.cwd];
  const runnerTemp = deps.env.RUNNER_TEMP;
  if (runnerTemp !== undefined && isAbsolute(runnerTemp)) {
    roots.push(runnerTemp);
  }
  const lexicalRoot = roots.find((root) => isStrictlyWithin(reportPath, root));
  if (lexicalRoot === undefined) {
    return { kind: 'unsafe' };
  }
  const parent = dirname(reportPath);
  if (fs.lstat(parent) === undefined) {
    return { kind: 'state', state: 'report-missing' };
  }
  const realParent = fs.realpath(parent);
  const realRoot = fs.realpath(lexicalRoot);
  if (!isWithinOrEqual(realParent, realRoot) || hasForbiddenSegment(realParent)) {
    return { kind: 'unsafe' };
  }
  const info = fs.lstat(reportPath);
  if (info === undefined) {
    return { kind: 'state', state: 'report-missing' };
  }
  if (info.kind === 'symlink') {
    return { kind: 'unsafe' };
  }
  if (info.kind !== 'file') {
    return { kind: 'state', state: 'report-unreadable' };
  }
  if (info.size > MAX_REPORT_BYTES) {
    return { kind: 'state', state: 'report-too-large' };
  }
  return { kind: 'read', path: join(realParent, basename(reportPath)) };
}

/**
 * The output directory must be strictly inside the working directory after
 * resolving symlinks, must not itself be a symlink, and may be created (one
 * level) when its parent is safe. An existing output file must be a regular
 * file, never a symlink or directory.
 */
function checkOutput(outputArg: string, deps: CliDeps): string | undefined {
  const { fs } = deps;
  const outputDir = resolve(deps.cwd, outputArg);
  const realCwd = fs.realpath(deps.cwd);
  if (!isStrictlyWithin(outputDir, deps.cwd) || hasForbiddenSegment(outputDir)) {
    return undefined;
  }
  const parent = dirname(outputDir);
  if (fs.lstat(parent) === undefined || !isWithinOrEqual(fs.realpath(parent), realCwd)) {
    return undefined;
  }
  const existing = fs.lstat(outputDir);
  if (existing === undefined) {
    fs.mkdir(outputDir);
  } else if (existing.kind !== 'directory') {
    return undefined;
  }
  const realDir = fs.realpath(outputDir);
  if (!isStrictlyWithin(realDir, realCwd) || fs.lstat(realDir)?.kind !== 'directory') {
    return undefined;
  }
  const target = join(realDir, OUTPUT_FILE);
  const current = fs.lstat(target);
  if (current !== undefined && current.kind !== 'file') {
    return undefined;
  }
  return target;
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

function contextFor(
  deps: CliDeps,
  reportState: ReportState,
): ReturnType<typeof validateRunContext> {
  const { env } = deps;
  const runId = Number(env.GITHUB_RUN_ID);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  return validateRunContext({
    runId: /^\d{1,16}$/.test(env.GITHUB_RUN_ID ?? '') ? runId : undefined,
    runAttempt: /^\d{1,6}$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ? runAttempt : undefined,
    event: env.GITHUB_EVENT_NAME,
    headSha: env.QS_HEAD_SHA,
    branch: env.QS_BRANCH,
    generatedAt: deps.now(),
    reportState,
    gateInputs: Object.fromEntries(GATE_INPUT_NAMES.map((name) => [name, env[name]])),
  });
}

function targetProblem(deps: CliDeps): CliCode | undefined {
  try {
    const config = resolveConfig({
      APP_TARGET: deps.env.APP_TARGET,
      BASE_URL: deps.env.BASE_URL,
    });
    return isRestricted(config.tier) ? 'restricted-target' : undefined;
  } catch {
    return 'invalid-configuration';
  }
}

/** Writes via an exclusive temporary file in the same directory, then renames. */
function writeAtomically(target: string, data: string, deps: CliDeps): boolean {
  const temporary = join(dirname(target), `.${OUTPUT_FILE}.${deps.pid}.tmp`);
  try {
    deps.fs.writeNew(temporary, data);
    deps.fs.rename(temporary, target);
    return true;
  } catch {
    try {
      if (deps.fs.lstat(temporary) !== undefined) {
        deps.fs.remove(temporary);
      }
    } catch {
      // Cleanup is best effort; the result is already a failure.
    }
    return false;
  }
}

function readReport(path: string, deps: CliDeps): { state: ReportState; value: unknown } {
  let text: string;
  try {
    text = deps.fs.readFile(path);
  } catch {
    return { state: 'report-unreadable', value: undefined };
  }
  try {
    return { state: 'provided', value: JSON.parse(text) as unknown };
  } catch {
    return { state: 'report-invalid-json', value: undefined };
  }
}

/**
 * Order: target, run context, output path, report (only after VERIFY and
 * MERGE were observed as `success`), normalize, atomic write. Any unexpected
 * exception becomes the fixed `internal-error` result.
 */
export function runQualitySummary(args: CliArgs, deps: CliDeps): CliResult {
  try {
    const target = targetProblem(deps);
    if (target !== undefined) {
      return refuse(target);
    }
    const initial = contextFor(deps, 'provided');
    if (!initial.ok) {
      return refuse('invalid-run-context');
    }
    const outputPath = checkOutput(args.outputDir, deps);
    if (outputPath === undefined) {
      return refuse('unsafe-output-path');
    }

    let report: unknown;
    let reportState: ReportState = 'provided';
    const gates = initial.context.observedGateInputs;
    if (gates.VERIFY === 'success' && gates.MERGE === 'success') {
      const input = checkInput(args.reportPath, deps);
      if (input.kind === 'unsafe') {
        return refuse('unsafe-input-path');
      }
      if (input.kind === 'state') {
        reportState = input.state;
      } else {
        const read = readReport(input.path, deps);
        reportState = read.state;
        report = read.value;
      }
    }
    // When VERIFY or MERGE did not succeed the report is never touched; the
    // normalizer records the corresponding unavailable reason.
    const context = contextFor(deps, reportState);
    if (!context.ok) {
      return refuse('invalid-run-context');
    }
    const summary: QualitySummary = normalize(report, context.context);
    if (!writeAtomically(outputPath, serialize(summary), deps)) {
      return refuse('write-failed');
    }
    return summary.testData.state === 'available'
      ? { exitCode: 0, code: 'written-available', reason: null }
      : { exitCode: 0, code: 'written-unavailable', reason: summary.testData.reason };
  } catch {
    return refuse('internal-error');
  }
}

/* ------------------------------------------------------------------ *
 * Node filesystem adapter
 * ------------------------------------------------------------------ */

export const nodeFs: FsAdapter = {
  lstat: (path) => {
    try {
      const info = lstatSync(path);
      const kind = info.isSymbolicLink()
        ? 'symlink'
        : info.isFile()
          ? 'file'
          : info.isDirectory()
            ? 'directory'
            : 'other';
      return { kind, size: info.size };
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  },
  realpath: (path) => realpathSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  mkdir: (path) => {
    mkdirSync(path, { mode: 0o755 });
  },
  writeNew: (path, data) => {
    const fd = openSync(path, 'wx', 0o644);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  remove: (path) => {
    unlinkSync(path);
  },
};
