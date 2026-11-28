/**
 * Test-health CLI (ADR-0012 amendment, Phase C2). Called by
 * `scripts/test-health.ts`, which supplies the working directory, the clock
 * and the filesystem adapter; this module reads no environment variables.
 *
 *   stamp  --unit <file> --run-id <n> --run-attempt <n> --source-sha <sha> --out <file>
 *   render --mode local --unit <file> --out <new-dir>
 *   render --mode ci --run-id <n> --run-attempt <n> --source-sha <sha>
 *          [--unit <file>] [--summary <file>] --out <new-dir>
 *
 * `stamp` records a caller-supplied CI identity on an unstamped unit result;
 * it is not independently verified, and a stamped result is never relabelled.
 * The source SHA must be the commit of the checkout that was actually tested.
 *
 * `render` writes `test-health.json` and `test-health.md` into a new
 * directory. In CI mode both inputs must carry exactly the given identity;
 * any mismatch refuses the render and writes nothing. A missing or unusable
 * input only makes its own section unavailable. Local mode accepts only
 * unstamped unit results. Neither command writes `README.md` or a CI job
 * summary.
 *
 * Paths must lie strictly inside the working directory and outside any
 * `.auth` directory. Inputs are read through a no-follow handle with a size
 * limit (the `FsAdapter` of `quality-summary-cli.ts` is reused); outputs are
 * created exclusively and never overwrite anything.
 *
 * Exit status: 0 written, 1 refused, 2 usage. Exit 0 means the health output
 * was produced; it never means the tests passed.
 */
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

import { MAX_INPUT_BYTES, parseSummary, type ParsedSummary } from './dashboard-model.ts';
import { isStrictlyWithin, type FsAdapter } from './quality-summary-cli.ts';
import {
  healthModel,
  renderHealthMarkdown,
  type HealthContext,
  type HealthModel,
  type UnitEvidence,
} from './test-health.ts';
import { MAX_UNIT_RESULTS_BYTES, parseUnitResults, stampUnitResults } from './unit-results.ts';

export type HealthExitCode = 0 | 1 | 2;

export type HealthCliCode =
  | 'stamped'
  | 'written'
  | 'usage'
  | 'unsafe-path'
  | 'input-missing'
  | 'input-unusable'
  | 'already-stamped'
  | 'provenance-mismatch'
  | 'output-exists'
  | 'write-failed'
  | 'internal-error';

export interface HealthCliResult {
  readonly exitCode: HealthExitCode;
  readonly code: HealthCliCode;
  /** Fixed section states for `written`; never paths or input text. */
  readonly states?: { readonly unit: string; readonly playwright: string };
}

/** The reused no-follow adapter plus a non-recursive directory removal. */
export interface HealthFs extends FsAdapter {
  /** Removes an empty directory; fails (throws) if it is not empty. */
  readonly removeEmptyDir: (path: string) => void;
}

export interface HealthCliDeps {
  readonly cwd: string;
  /** ISO 8601 UTC instant used as the health document's generation time. */
  readonly now: () => string;
  /** Random token for the staging directory name (16–64 of A–Z, a–z, 0–9, `-`). */
  readonly randomId: () => string;
  readonly fs: HealthFs;
}

export const HEALTH_JSON = 'test-health.json';
export const HEALTH_MARKDOWN = 'test-health.md';

const MESSAGES: Readonly<Record<HealthCliCode, string>> = {
  stamped: 'unit results stamped with the supplied CI identity (not independently verified)',
  written: 'test health written',
  usage:
    'usage: node scripts/test-health.ts stamp --unit <file> --run-id <n> --run-attempt <n> --source-sha <sha> --out <file>\n' +
    '       node scripts/test-health.ts render --mode local --unit <file> --out <new-dir>\n' +
    '       node scripts/test-health.ts render --mode ci --run-id <n> --run-attempt <n> --source-sha <sha> [--unit <file>] [--summary <file>] --out <new-dir>',
  'unsafe-path':
    'refused: a path is outside the working directory, under .auth, or not a regular file',
  'input-missing': 'refused: the unit results file does not exist',
  'input-unusable': 'refused: the unit results are incomplete, invalid or inconsistent',
  'already-stamped': 'refused: the unit results are already stamped and are never relabelled',
  'provenance-mismatch': 'refused: input run identity does not match; nothing was written',
  'output-exists': 'refused: the output already exists',
  'write-failed': 'failed: the output could not be written',
  'internal-error': 'failed: internal error',
};

/** One fixed line: no paths, values or input text. */
export function healthMessage(result: HealthCliResult): string {
  const base = MESSAGES[result.code];
  return result.states === undefined
    ? base
    : `${base} (unit: ${result.states.unit}; playwright: ${result.states.playwright})`;
}

function refuse(code: HealthCliCode, exitCode: HealthExitCode = 1): HealthCliResult {
  return { exitCode, code };
}

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

const FLAGS = [
  '--unit',
  '--summary',
  '--out',
  '--mode',
  '--run-id',
  '--run-attempt',
  '--source-sha',
] as const;
type Flag = (typeof FLAGS)[number];

export type HealthArgs =
  | {
      readonly command: 'stamp';
      readonly unit: string;
      readonly out: string;
      readonly runId: number;
      readonly runAttempt: number;
      readonly sourceSha: string;
    }
  | {
      readonly command: 'render';
      readonly mode: 'local';
      readonly unit: string;
      readonly out: string;
    }
  | {
      readonly command: 'render';
      readonly mode: 'ci';
      readonly unit: string | undefined;
      readonly summary: string | undefined;
      readonly out: string;
      readonly runId: number;
      readonly runAttempt: number;
      readonly sourceSha: string;
    };

const POSITIVE = /^[1-9]\d{0,15}$/;
const SHA = /^[0-9a-f]{40}$/;

function validValue(value: string | undefined): value is string {
  return value !== undefined && value !== '' && value.length <= 4096 && !value.includes('\0');
}

/** Each flag at most once with a value; no positional arguments after the command. */
export function parseHealthArgs(argv: readonly string[]): HealthArgs | undefined {
  const [command, ...rest] = argv;
  if (command !== 'stamp' && command !== 'render') return undefined;
  const values = new Map<Flag, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if (!(FLAGS as readonly (string | undefined)[]).includes(name)) return undefined;
    const flag = name as Flag;
    if (values.has(flag) || !validValue(value)) return undefined;
    values.set(flag, value);
  }
  const has = (flag: Flag): boolean => values.has(flag);
  const identityGiven = has('--run-id') || has('--run-attempt') || has('--source-sha');
  const identity = (): { runId: number; runAttempt: number; sourceSha: string } | undefined => {
    const runId = values.get('--run-id');
    const runAttempt = values.get('--run-attempt');
    const sourceSha = values.get('--source-sha');
    if (
      runId === undefined ||
      runAttempt === undefined ||
      sourceSha === undefined ||
      !POSITIVE.test(runId) ||
      !POSITIVE.test(runAttempt) ||
      !SHA.test(sourceSha) ||
      !Number.isSafeInteger(Number(runId)) ||
      !Number.isSafeInteger(Number(runAttempt))
    ) {
      return undefined;
    }
    return { runId: Number(runId), runAttempt: Number(runAttempt), sourceSha };
  };
  const unit = values.get('--unit');
  const out = values.get('--out');
  if (out === undefined) return undefined;
  if (command === 'stamp') {
    const id = identity();
    if (unit === undefined || id === undefined || has('--summary') || has('--mode')) {
      return undefined;
    }
    return { command, unit, out, ...id };
  }
  const mode = values.get('--mode');
  if (mode === 'local') {
    if (unit === undefined || identityGiven || has('--summary')) return undefined;
    return { command, mode, unit, out };
  }
  if (mode === 'ci') {
    const id = identity();
    const summary = values.get('--summary');
    if (id === undefined || (unit === undefined && summary === undefined)) return undefined;
    return { command, mode, unit, summary, out, ...id };
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Paths and files
 * ------------------------------------------------------------------ */

function hasAuthSegment(path: string): boolean {
  return path.split(sep).includes('.auth');
}

/** The absolute path when it is strictly inside the real working directory. */
function safePath(arg: string, deps: HealthCliDeps): string | undefined {
  try {
    const root = deps.fs.realpath(deps.cwd);
    const absolute = isAbsolute(arg) ? resolve(arg) : resolve(root, arg);
    const name = basename(absolute);
    if (name === '' || name === '.' || name === '..') return undefined;
    const parentInfo = deps.fs.lstat(dirname(absolute));
    if (parentInfo?.kind !== 'directory') return undefined;
    const realParent = deps.fs.realpath(dirname(absolute));
    const target = resolve(realParent, name);
    if (!isStrictlyWithin(target, root) || hasAuthSegment(target)) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

type InputRead =
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'missing' | 'too-large' | 'unreadable' }
  | { readonly status: 'unsafe' };

function readInput(arg: string, maxBytes: number, deps: HealthCliDeps): InputRead {
  const path = safePath(arg, deps);
  if (path === undefined) return { status: 'unsafe' };
  const info = deps.fs.lstat(path);
  if (info === undefined) return { status: 'missing' };
  if (info.kind !== 'file') return { status: 'unsafe' };
  const read = deps.fs.readNoFollow(path, maxBytes);
  if (read.status === 'ok') return { status: 'ok', text: read.text };
  if (read.status === 'missing') return { status: 'missing' };
  if (read.status === 'too-large') return { status: 'too-large' };
  if (read.status === 'symlink' || read.status === 'not-file') return { status: 'unsafe' };
  return { status: 'unreadable' };
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

function runStamp(
  args: Extract<HealthArgs, { command: 'stamp' }>,
  deps: HealthCliDeps,
): HealthCliResult {
  const input = readInput(args.unit, MAX_UNIT_RESULTS_BYTES, deps);
  if (input.status === 'unsafe') return refuse('unsafe-path');
  if (input.status === 'missing') return refuse('input-missing');
  if (input.status !== 'ok') return refuse('input-unusable');
  const stamped = stampUnitResults(input.text, {
    runId: args.runId,
    runAttempt: args.runAttempt,
    sourceSha: args.sourceSha,
  });
  if (!stamped.ok) {
    return refuse(stamped.reason === 'already-stamped' ? 'already-stamped' : 'input-unusable');
  }
  const out = safePath(args.out, deps);
  if (out === undefined) return refuse('unsafe-path');
  if (deps.fs.lstat(out) !== undefined) return refuse('output-exists');
  const written = deps.fs.writeNew(out, stamped.text);
  if (written.status === 'exists') return refuse('output-exists');
  if (written.status !== 'ok') return refuse('write-failed');
  return { exitCode: 0, code: 'stamped' };
}

function unitEvidence(arg: string | undefined, deps: HealthCliDeps): UnitEvidence | 'unsafe' {
  if (arg === undefined) return { kind: 'unavailable', reason: 'unit-results-missing' };
  const input = readInput(arg, MAX_UNIT_RESULTS_BYTES, deps);
  if (input.status === 'unsafe') return 'unsafe';
  if (input.status === 'missing') return { kind: 'unavailable', reason: 'unit-results-missing' };
  if (input.status !== 'ok') return { kind: 'unavailable', reason: 'unit-results-invalid' };
  return parseUnitResults(input.text);
}

function summaryEvidence(arg: string | undefined, deps: HealthCliDeps): ParsedSummary | 'unsafe' {
  if (arg === undefined) return { state: 'no-summary' };
  const input = readInput(arg, MAX_INPUT_BYTES, deps);
  if (input.status === 'unsafe') return 'unsafe';
  if (input.status === 'missing') return { state: 'no-summary' };
  if (input.status === 'too-large')
    return { state: 'invalid', problem: 'input-too-large', path: null };
  if (input.status !== 'ok') return { state: 'invalid', problem: 'invalid-structure', path: null };
  return parseSummary(input.text);
}

function mismatched(model: HealthModel): boolean {
  const reasons = [
    model.unit.state === 'unavailable' ? model.unit.reason : undefined,
    model.playwright.state === 'unavailable' ? model.playwright.reason : undefined,
  ];
  return reasons.some((r) => r === 'provenance-mismatch' || r === 'not-local-evidence');
}

const STAGING_ID = /^[A-Za-z0-9-]{16,64}$/;

/**
 * Writes every file into a private staging directory next to `out`, created
 * by this invocation, and publishes it with one rename only after every file
 * was written. On failure it removes only the files and the staging
 * directory this invocation created (never recursively), so no partial
 * bundle is ever published under `out`, and nothing that existed before is
 * touched.
 */
function publishBundle(
  out: string,
  files: readonly (readonly [string, string])[],
  deps: HealthCliDeps,
): 'ok' | 'output-exists' | 'write-failed' {
  const id = deps.randomId();
  if (!STAGING_ID.test(id)) return 'write-failed';
  const staging = resolve(dirname(out), `.${basename(out)}.${id}.staging`);
  if (deps.fs.lstat(staging) !== undefined) return 'write-failed';
  try {
    deps.fs.mkdir(staging);
  } catch {
    return 'write-failed';
  }
  const created: string[] = [];
  const cleanUp = (): void => {
    for (const path of created) {
      try {
        deps.fs.remove(path);
      } catch {
        // Left in the unpublished staging directory; never under `out`.
      }
    }
    try {
      deps.fs.removeEmptyDir(staging);
    } catch {
      // Not empty or not removable: it stays as staging, never published.
    }
  };
  for (const [name, data] of files) {
    const path = resolve(staging, name);
    const written = deps.fs.writeNew(path, data);
    if (written.status !== 'ok') {
      cleanUp();
      return 'write-failed';
    }
    created.push(path);
  }
  // `out` is re-checked immediately before the rename; the rename never
  // replaces a non-empty directory or a file.
  if (deps.fs.lstat(out) !== undefined) {
    cleanUp();
    return 'output-exists';
  }
  try {
    deps.fs.rename(staging, out);
  } catch {
    cleanUp();
    return 'write-failed';
  }
  return 'ok';
}

function runRender(
  args: Extract<HealthArgs, { command: 'render' }>,
  deps: HealthCliDeps,
): HealthCliResult {
  const unit = unitEvidence(args.unit, deps);
  const summary = summaryEvidence(args.mode === 'ci' ? args.summary : undefined, deps);
  if (unit === 'unsafe' || summary === 'unsafe') return refuse('unsafe-path');
  const generatedAt = deps.now();
  const context: HealthContext =
    args.mode === 'ci'
      ? {
          mode: 'ci',
          generatedAt,
          runId: args.runId,
          runAttempt: args.runAttempt,
          sourceSha: args.sourceSha,
        }
      : { mode: 'local', generatedAt };
  const built = healthModel(summary, unit, context);
  if (!built.ok) return refuse('internal-error');
  // Never combine, or even write, evidence whose run identity disagrees.
  if (mismatched(built.model)) return refuse('provenance-mismatch');

  const out = safePath(args.out, deps);
  if (out === undefined) return refuse('unsafe-path');
  if (deps.fs.lstat(out) !== undefined) return refuse('output-exists');
  const json = `${JSON.stringify(built.model, null, 2)}\n`;
  const markdown = renderHealthMarkdown(built.model);
  const published = publishBundle(
    out,
    [
      [HEALTH_JSON, json],
      [HEALTH_MARKDOWN, markdown],
    ],
    deps,
  );
  if (published !== 'ok') return refuse(published);
  return {
    exitCode: 0,
    code: 'written',
    states: { unit: built.model.unit.state, playwright: built.model.playwright.state },
  };
}

/** Runs one command; never throws. */
export function runTestHealth(argv: readonly string[], deps: HealthCliDeps): HealthCliResult {
  try {
    const args = parseHealthArgs(argv);
    if (args === undefined) return refuse('usage', 2);
    return args.command === 'stamp' ? runStamp(args, deps) : runRender(args, deps);
  } catch {
    return refuse('internal-error');
  }
}
