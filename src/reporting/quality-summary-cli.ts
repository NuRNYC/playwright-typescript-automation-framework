/**
 * Quality summary CLI application logic (ADR-0009, M8B).
 *
 * The impure shell around the pure M8A normalizer (`./quality-summary.ts`):
 * it validates the target and the run context, validates every path, reads
 * the merged JSON report only when VERIFY and MERGE were observed as
 * `success`, and writes the serialized summary atomically. All normalization
 * and aggregation stays in M8A; this module adds no schema of its own.
 *
 * Adapter boundaries: the environment arrives as a plain object, the clock
 * and temporary-name source as functions, and the filesystem as an
 * `FsAdapter`, so tests can drive every path with synthetic values.
 * `scripts/quality-summary.ts` supplies the real ones.
 *
 * Environment contract (`ENV_KEYS`; every value is validated, none trusted):
 *
 *   GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_EVENT_NAME  run identity
 *   QS_HEAD_SHA                                           commit under test
 *   QS_BRANCH                                             raw branch; classified only
 *   CHECKS SHARDS INVENTORY DOWNLOAD_1 DOWNLOAD_2
 *   VERIFY MERGE UPLOAD                                   the eight Gate inputs
 *   APP_TARGET, BASE_URL                                  restricted-target refusal
 *   RUNNER_TEMP                                           optional second input root
 *
 * Order of operations: every check that needs no filesystem mutation runs
 * first (target, run context, output plan, report path and read); only then
 * is the output directory created (one level) and the summary written. A
 * refusal therefore never creates a directory or a file.
 *
 * Filesystem race (TOCTOU) protections -- partial, not complete:
 *
 * - The report is opened with O_NOFOLLOW (a symlink in the final component
 *   is refused) and read through the opened handle, whose own fstat decides
 *   type and size. After opening, the path is resolved again and the
 *   handle's device and inode must match the file at that resolved location
 *   inside an allowed root; a parent directory swapped for a symlink between
 *   validation and opening is therefore detected and refused.
 * - The temporary output file is created exclusively (O_CREAT | O_EXCL |
 *   O_NOFOLLOW) with a random name, then the output directory is resolved
 *   again and the file's identity re-checked before the rename. A directory
 *   swapped for a symlink before the write is detected; the stray temporary
 *   file is removed and nothing is renamed.
 * - Residual: Node offers no `openat`/`renameat`, so path-based steps still
 *   resolve intermediate directories by name. A local process that can swap
 *   directories precisely between the final re-check and the rename, or that
 *   can hard-link files into an allowed root, is outside what this module can
 *   prevent. The CLI is meant for a single-tenant CI runner.
 * - Where the platform lacks O_NOFOLLOW the report is not read (it is
 *   treated as unreadable): fail closed.
 *
 * Diagnostics are fixed codes only: no path, error text, report content or
 * environment value is ever returned or printed.
 *
 * Kept free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
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

/** Attempts at an unused temporary name before giving up. */
export const MAX_TEMP_ATTEMPTS = 5;

/** The only environment variables the CLI reads. */
export const ENV_KEYS = [
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_EVENT_NAME',
  'QS_HEAD_SHA',
  'QS_BRANCH',
  ...GATE_INPUT_NAMES,
  'APP_TARGET',
  'BASE_URL',
  'RUNNER_TEMP',
] as const;

const MAX_ARG_LENGTH = 4096;
const TEMP_ID = /^[A-Za-z0-9-]{16,64}$/;

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

/** Result of reading a file through a no-follow handle. */
export type ReadOutcome =
  | { readonly status: 'ok'; readonly text: string; readonly identity: string }
  | {
      readonly status: 'missing' | 'symlink' | 'not-file' | 'too-large' | 'unreadable';
    };

/** Result of an exclusive, no-follow create. */
export type WriteOutcome =
  | { readonly status: 'ok'; readonly identity: string }
  | { readonly status: 'exists' }
  | { readonly status: 'failed' };

/** The filesystem operations the CLI performs. Every path is pre-validated. */
export interface FsAdapter {
  /** `undefined` when nothing exists at the path. Never follows a final symlink. */
  readonly lstat: (path: string) => FileInfo | undefined;
  readonly realpath: (path: string) => string;
  /** `dev:ino` of the file the path resolves to, or `undefined`. */
  readonly identity: (path: string) => string | undefined;
  /** Opens with O_NOFOLLOW, checks type and size on the handle, reads at most `maxBytes`. */
  readonly readNoFollow: (path: string, maxBytes: number) => ReadOutcome;
  readonly mkdir: (path: string) => void;
  /** Creates `path` with O_CREAT | O_EXCL | O_NOFOLLOW, writes and syncs it. */
  readonly writeNew: (path: string, data: string) => WriteOutcome;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
}

export interface CliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** ISO 8601 UTC timestamp for the summary's `generatedAt`. */
  readonly now: () => string;
  /** Collision-resistant random token for temporary file names (16–64 of A–Z, a–z, 0–9, `-`). */
  readonly randomId: () => string;
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

/** Copies only `ENV_KEYS` from an environment object. */
export function pickEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]]));
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
 * Path safety (no mutation)
 * ------------------------------------------------------------------ */

/** True when `child` is strictly inside `root` (not equal, no `..` escape). */
export function isStrictlyWithin(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function isWithinOrEqual(child: string, root: string): boolean {
  return child === root || isStrictlyWithin(child, root);
}

/** Segments that mark saved authentication state; never read or written. */
const FORBIDDEN_SEGMENTS = ['.auth'];

function hasForbiddenSegment(path: string): boolean {
  return path.split(sep).some((segment) => FORBIDDEN_SEGMENTS.includes(segment.toLowerCase()));
}

type InputResult =
  | { readonly kind: 'parsed'; readonly value: unknown }
  | { readonly kind: 'state'; readonly state: Exclude<ReportState, 'provided'> }
  | { readonly kind: 'unsafe' };

/**
 * The report must be a `.json` file whose resolved location, and whose
 * parent directory after resolving symlinks, lie inside an allowed root (the
 * working directory or `RUNNER_TEMP`). It is opened with O_NOFOLLOW and its
 * identity re-checked after opening. No path segment may name saved
 * authentication state. Read-only: nothing is created.
 */
function readInput(reportArg: string, deps: CliDeps): InputResult {
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
  const realRoot = fs.realpath(lexicalRoot);
  const realParent = fs.realpath(parent);
  if (!isWithinOrEqual(realParent, realRoot) || hasForbiddenSegment(realParent)) {
    return { kind: 'unsafe' };
  }
  const target = join(realParent, basename(reportPath));
  const read = fs.readNoFollow(target, MAX_REPORT_BYTES);
  switch (read.status) {
    case 'missing':
      return { kind: 'state', state: 'report-missing' };
    case 'symlink':
      return { kind: 'unsafe' };
    case 'not-file':
    case 'unreadable':
      return { kind: 'state', state: 'report-unreadable' };
    case 'too-large':
      return { kind: 'state', state: 'report-too-large' };
    case 'ok':
      break;
  }
  // Post-open check: the opened file must be the one now found at the path,
  // inside the allowed root. Detects a parent swapped for a symlink.
  let resolved: string;
  try {
    resolved = fs.realpath(target);
  } catch {
    return { kind: 'unsafe' };
  }
  if (
    !isStrictlyWithin(resolved, realRoot) ||
    hasForbiddenSegment(resolved) ||
    fs.identity(resolved) !== read.identity
  ) {
    return { kind: 'unsafe' };
  }
  try {
    return { kind: 'parsed', value: JSON.parse(read.text) as unknown };
  } catch {
    return { kind: 'state', state: 'report-invalid-json' };
  }
}

interface OutputPlan {
  /** Real path of the existing parent of the output directory. */
  readonly realParent: string;
  readonly name: string;
  /** Real path of the output directory when it already exists. */
  readonly realDir: string | undefined;
  readonly realCwd: string;
}

/**
 * Validates the output location without creating anything. The directory
 * must be strictly inside the working directory after resolving symlinks;
 * neither it nor an existing output file may be a symlink. A missing
 * directory is allowed (one level) when its parent is safe.
 */
function planOutput(outputArg: string, deps: CliDeps): OutputPlan | undefined {
  const { fs } = deps;
  const outputDir = resolve(deps.cwd, outputArg);
  if (!isStrictlyWithin(outputDir, deps.cwd) || hasForbiddenSegment(outputDir)) {
    return undefined;
  }
  const realCwd = fs.realpath(deps.cwd);
  const parent = dirname(outputDir);
  const parentInfo = fs.lstat(parent);
  if (parentInfo === undefined) {
    return undefined;
  }
  const realParent = fs.realpath(parent);
  if (!isWithinOrEqual(realParent, realCwd) || hasForbiddenSegment(realParent)) {
    return undefined;
  }
  const name = basename(outputDir);
  const existing = fs.lstat(join(realParent, name));
  if (existing === undefined) {
    return { realParent, name, realDir: undefined, realCwd };
  }
  if (existing.kind !== 'directory') {
    return undefined;
  }
  const realDir = fs.realpath(join(realParent, name));
  if (!isStrictlyWithin(realDir, realCwd)) {
    return undefined;
  }
  const current = fs.lstat(join(realDir, OUTPUT_FILE));
  if (current !== undefined && current.kind !== 'file') {
    return undefined;
  }
  return { realParent, name, realDir, realCwd };
}

/** Creates the planned directory if needed and re-validates it. The only mkdir. */
function ensureOutput(plan: OutputPlan, deps: CliDeps): string | undefined {
  const { fs } = deps;
  const dir = join(plan.realParent, plan.name);
  if (plan.realDir === undefined) {
    if (fs.lstat(dir) !== undefined) {
      return undefined; // Appeared since planning: do not trust it.
    }
    fs.mkdir(dir);
  }
  const info = fs.lstat(dir);
  if (info?.kind !== 'directory') {
    return undefined;
  }
  const realDir = fs.realpath(dir);
  if (
    !isStrictlyWithin(realDir, plan.realCwd) ||
    (plan.realDir !== undefined && realDir !== plan.realDir)
  ) {
    return undefined;
  }
  const current = fs.lstat(join(realDir, OUTPUT_FILE));
  if (current !== undefined && current.kind !== 'file') {
    return undefined;
  }
  return realDir;
}

/* ------------------------------------------------------------------ *
 * Atomic write
 * ------------------------------------------------------------------ */

function removeIfFile(path: string, deps: CliDeps): void {
  try {
    if (deps.fs.lstat(path)?.kind === 'file') {
      deps.fs.remove(path);
    }
  } catch {
    // Cleanup is best effort; the result is already a failure.
  }
}

/**
 * Exclusive temporary file with a random name in the output directory, then
 * re-validation of the directory and the file's identity, then rename. A
 * name collision retries with a new name; existing files are never touched.
 */
function writeAtomically(realDir: string, data: string, deps: CliDeps): boolean {
  const target = join(realDir, OUTPUT_FILE);
  for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS; attempt++) {
    const id = deps.randomId();
    if (!TEMP_ID.test(id)) {
      return false;
    }
    const temporary = join(realDir, `.${OUTPUT_FILE}.${id}.tmp`);
    const created = deps.fs.writeNew(temporary, data);
    if (created.status === 'exists') {
      continue;
    }
    if (created.status === 'failed') {
      removeIfFile(temporary, deps);
      return false;
    }
    try {
      const unchanged =
        deps.fs.realpath(realDir) === realDir &&
        deps.fs.lstat(temporary)?.kind === 'file' &&
        deps.fs.identity(temporary) === created.identity &&
        deps.fs.lstat(target)?.kind !== 'symlink' &&
        deps.fs.lstat(target)?.kind !== 'directory';
      if (!unchanged) {
        removeIfFile(temporary, deps);
        return false;
      }
      deps.fs.rename(temporary, target);
      return true;
    } catch {
      removeIfFile(temporary, deps);
      return false;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

function contextFor(
  deps: CliDeps,
  reportState: ReportState,
): ReturnType<typeof validateRunContext> {
  const { env } = deps;
  return validateRunContext({
    runId: /^\d{1,16}$/.test(env.GITHUB_RUN_ID ?? '') ? Number(env.GITHUB_RUN_ID) : undefined,
    runAttempt: /^\d{1,6}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
      ? Number(env.GITHUB_RUN_ATTEMPT)
      : undefined,
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
    const config = resolveConfig({ APP_TARGET: deps.env.APP_TARGET, BASE_URL: deps.env.BASE_URL });
    return isRestricted(config.tier) ? 'restricted-target' : undefined;
  } catch {
    return 'invalid-configuration';
  }
}

/**
 * Order: target, run context, output plan, report (only if VERIFY and MERGE
 * were observed as `success`) -- all without mutation -- then normalize,
 * create the output directory if needed and write atomically. Any
 * unexpected exception becomes the fixed `internal-error` result.
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
    const plan = planOutput(args.outputDir, deps);
    if (plan === undefined) {
      return refuse('unsafe-output-path');
    }

    let report: unknown;
    let reportState: ReportState = 'provided';
    const gates = initial.context.observedGateInputs;
    if (gates.VERIFY === 'success' && gates.MERGE === 'success') {
      const input = readInput(args.reportPath, deps);
      if (input.kind === 'unsafe') {
        return refuse('unsafe-input-path');
      }
      if (input.kind === 'state') {
        reportState = input.state;
      } else {
        report = input.value;
      }
    }
    // When VERIFY or MERGE did not succeed the report is never touched; the
    // normalizer records the corresponding unavailable reason.
    const context = contextFor(deps, reportState);
    if (!context.ok) {
      return refuse('invalid-run-context');
    }
    const summary: QualitySummary = normalize(report, context.context);
    const data = serialize(summary);

    // First mutation: the output directory, only after every check passed.
    const realDir = ensureOutput(plan, deps);
    if (realDir === undefined) {
      return refuse('unsafe-output-path');
    }
    if (!writeAtomically(realDir, data, deps)) {
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

function identityOf(info: { readonly dev: number; readonly ino: number }): string {
  return `${info.dev}:${info.ino}`;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

/** `O_NOFOLLOW` where the platform provides it; `undefined` otherwise (fail closed). */
const O_NOFOLLOW: number | undefined = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;

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
      if (errorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  },
  realpath: (path) => realpathSync(path),
  identity: (path) => {
    try {
      return identityOf(statSync(path));
    } catch {
      return undefined;
    }
  },
  readNoFollow: (path, maxBytes) => {
    if (O_NOFOLLOW === undefined) {
      return { status: 'unreadable' };
    }
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') {
        return { status: 'missing' };
      }
      // ELOOP (Linux) / EMLINK, EFTYPE (BSD, macOS): the final component is a symlink.
      if (code === 'ELOOP' || code === 'EMLINK' || code === 'EFTYPE') {
        return { status: 'symlink' };
      }
      return { status: 'unreadable' };
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) {
        return { status: 'not-file' };
      }
      if (info.size > maxBytes) {
        return { status: 'too-large' };
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const n = readSync(fd, buffer, 0, buffer.length, null);
        if (n === 0) {
          break;
        }
        total += n;
        if (total > maxBytes) {
          return { status: 'too-large' }; // Grew while being read.
        }
        chunks.push(Buffer.from(buffer.subarray(0, n)));
      }
      return {
        status: 'ok',
        text: Buffer.concat(chunks).toString('utf8'),
        identity: identityOf(info),
      };
    } catch {
      return { status: 'unreadable' };
    } finally {
      closeSync(fd);
    }
  },
  mkdir: (path) => {
    mkdirSync(path, { mode: 0o755 });
  },
  writeNew: (path, data) => {
    if (O_NOFOLLOW === undefined) {
      return { status: 'failed' };
    }
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
        0o644,
      );
    } catch (error) {
      return { status: errorCode(error) === 'EEXIST' ? 'exists' : 'failed' };
    }
    try {
      const bytes = Buffer.from(data, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
      }
      fsyncSync(fd);
      return { status: 'ok', identity: identityOf(fstatSync(fd)) };
    } catch {
      return { status: 'failed' };
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
