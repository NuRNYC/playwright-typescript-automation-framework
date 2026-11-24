/**
 * Verifies downloaded shard blob reports before they are merged (ADR-0007).
 *
 *   node scripts/verify-blob-reports.ts <artifact-root> <shard-total>
 *
 * The impure shell around `src/ci/blob-reports.ts`: it snapshots the
 * directory tree and asks the system `unzip` (Info-ZIP, provided by the
 * GitHub-hosted Ubuntu image) to list (`-Z1`) and test (`-tqq`) each expected
 * archive. It never extracts anything and never prints tool output, file
 * names, archive entries or report content -- only a shard index and a fixed
 * problem code. Inputs come from the command line; no environment variable is
 * read.
 *
 * Fails closed: if `unzip` is missing, errors, times out or produces more
 * output than expected, the archive counts as unreadable and the step fails.
 *
 * Passing this check means the artifact set is complete and structurally
 * valid. It does NOT mean the tests passed; the workflow gate decides that.
 */
import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  blobReportProblems,
  expectedBlobName,
  formatProblem,
  isValidShardTotal,
  type ArchiveFailure,
  type ArchiveInspection,
  type ArtifactEntry,
  type ArtifactFile,
  type EntryKind,
} from '../src/ci/blob-reports.ts';

/** Per invocation of `unzip`; a blob listing or test takes milliseconds. */
const TOOL_TIMEOUT_MS = 30_000;
/** A listing of one blob is a few lines; anything near this is not a blob. */
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const ARTIFACT_NAME = /^blob-report-([1-9]\d*)$/;

type ToolResult = { readonly ok: true; readonly stdout: string } | ToolFailure;
type ToolFailure =
  | { readonly ok: false; readonly failure: ArchiveFailure }
  | { readonly ok: false; readonly failure: 'exit' };

interface ExecError {
  readonly code?: unknown;
  readonly killed?: boolean;
  readonly signal?: unknown;
}

function classifyToolError(error: ExecError): ToolFailure {
  if (error.code === 'ENOENT') {
    return { ok: false, failure: 'tool-unavailable' };
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { ok: false, failure: 'output-limit' };
  }
  if (error.killed === true || error.signal !== null) {
    return { ok: false, failure: 'timeout' };
  }
  return { ok: false, failure: 'exit' };
}

/** Runs `unzip` with fixed arguments, no shell, bounded time and output. */
function runUnzip(args: readonly string[]): Promise<ToolResult> {
  return new Promise((done) => {
    execFile(
      'unzip',
      [...args],
      {
        encoding: 'utf8',
        shell: false,
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: MAX_TOOL_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        // stderr is deliberately discarded: it echoes file paths.
        done(error === null ? { ok: true, stdout } : classifyToolError(error));
      },
    );
  });
}

async function inspectArchive(path: string): Promise<ArchiveInspection> {
  const listing = await runUnzip(['-Z1', path]);
  if (!listing.ok) {
    return { kind: 'failed', failure: listing.failure === 'exit' ? 'unreadable' : listing.failure };
  }
  const integrity = await runUnzip(['-tqq', path]);
  if (!integrity.ok && integrity.failure !== 'exit') {
    return { kind: 'failed', failure: integrity.failure };
  }
  const entries = listing.stdout.split('\n').filter((line) => line !== '');
  return { kind: 'listed', entries, intact: integrity.ok };
}

async function kindOf(path: string): Promise<EntryKind> {
  const stats = await lstat(path);
  return stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
}

async function readShardFiles(dir: string, expected: string | undefined): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const kind = await kindOf(path);
    // Only the expected blob is opened; anything else is already a problem.
    files.push(
      kind === 'file' && name === expected
        ? { name, kind, archive: await inspectArchive(path) }
        : { name, kind },
    );
  }
  return files;
}

async function snapshot(root: string, shardTotal: number): Promise<ArtifactEntry[]> {
  const entries: ArtifactEntry[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const kind = await kindOf(path);
    if (kind !== 'directory') {
      entries.push({ name, kind });
      continue;
    }
    const match = ARTIFACT_NAME.exec(name);
    const index = match ? Number(match[1]) : Number.NaN;
    const expected =
      Number.isInteger(index) && index <= shardTotal
        ? expectedBlobName(index, shardTotal)
        : undefined;
    entries.push({ name, kind, files: await readShardFiles(path, expected) });
  }
  return entries;
}

async function main(argv: readonly string[]): Promise<number> {
  const [rootArg, totalArg, ...rest] = argv;
  const shardTotal = Number(totalArg);
  if (
    rootArg === undefined ||
    rest.length > 0 ||
    !/^\d+$/.test(totalArg ?? '') ||
    !isValidShardTotal(shardTotal)
  ) {
    console.error('usage: node scripts/verify-blob-reports.ts <artifact-root> <shard-total>');
    return 2;
  }

  let entries: ArtifactEntry[];
  try {
    entries = await snapshot(resolve(rootArg), shardTotal);
  } catch {
    // Missing or unreadable root: report a fixed code, not the OS error (it names paths).
    console.error('blob reports: no-artifacts');
    return 1;
  }

  const problems = blobReportProblems(entries, shardTotal);
  for (const problem of problems) {
    console.error(formatProblem(problem));
  }
  if (problems.length > 0) {
    return 1;
  }
  console.log(
    `blob reports: ${shardTotal} of ${shardTotal} shards complete and structurally valid`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error('blob reports: verifier-error');
    process.exitCode = 1;
  },
);
