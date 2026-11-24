/**
 * Completeness and integrity policy for sharded blob reports (ADR-0007). Pure.
 *
 * Measured in Playwright 1.64.1: `merge-reports` exits 0 when a shard's blob
 * is missing (the merged report silently covers fewer tests) and when a blob
 * is present twice (every test is counted twice). It also exits 0 when the
 * merged tests FAILED. So neither "the merge succeeded" nor "the merged
 * report looks complete" proves anything; this policy checks the downloaded
 * artifacts before they are merged.
 *
 * Expected layout, one directory per shard artifact (no `merge-multiple`):
 *
 *   <root>/blob-report-1/report-1.zip
 *   <root>/blob-report-2/report-2.zip
 *
 * Each ZIP must hold exactly one `report.jsonl` and otherwise only the blob
 * reporter's attachment files, `resources/<sha1>.<extension>`.
 *
 * What this is: a completeness and structure check on files this workflow
 * produced. What this is not: proof that tests passed (the gate decides that
 * from job results), or a content scanner.
 *
 * The caller (`scripts/verify-blob-reports.ts`) supplies a snapshot of the
 * directory tree and the result of listing and testing each archive. Problems
 * name only a shard index and a fixed code -- never a file name, an archive
 * entry or any report content -- so nothing from an artifact reaches the log.
 *
 * Kept free of `@/` imports so Node's type-stripping runner can load it
 * directly (ADR-0002).
 */

/** Why an archive could not be read. Produced by the wrapper, never by content. */
export const ARCHIVE_FAILURES = [
  'unreadable',
  'tool-unavailable',
  'timeout',
  'output-limit',
] as const;
export type ArchiveFailure = (typeof ARCHIVE_FAILURES)[number];

/** The result of listing (`unzip -Z1`) and testing (`unzip -tqq`) one archive. */
export type ArchiveInspection =
  | { readonly kind: 'listed'; readonly entries: readonly string[]; readonly intact: boolean }
  | { readonly kind: 'failed'; readonly failure: ArchiveFailure };

export type EntryKind = 'file' | 'directory' | 'other';

/** A file inside a shard artifact directory. `archive` is set for regular files. */
export interface ArtifactFile {
  readonly name: string;
  readonly kind: EntryKind;
  readonly archive?: ArchiveInspection;
}

/** A top-level entry of the download root. `files` is set for directories. */
export interface ArtifactEntry {
  readonly name: string;
  readonly kind: EntryKind;
  readonly files?: readonly ArtifactFile[];
}

export const PROBLEM_CODES = [
  'invalid-shard-total',
  'no-artifacts',
  'unexpected-artifact',
  'duplicate-shard',
  'missing-shard',
  'missing-zip',
  'unexpected-file',
  'zip-unreadable',
  'zip-tool-unavailable',
  'zip-timeout',
  'zip-output-limit',
  'zip-integrity-failed',
  'missing-report-jsonl',
  'duplicate-report-jsonl',
  'unsafe-entry-path',
  'unexpected-entry',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** `shard` is the shard index the problem belongs to, or `null` for the whole set. */
export interface BlobReportProblem {
  readonly shard: number | null;
  readonly code: ProblemCode;
}

/** Playwright's own limit is far higher; two digits is plenty for this repository. */
const MAX_SHARDS = 99;

const ARTIFACT_NAME = /^blob-report-([1-9]\d*)$/;
const REPORT_ENTRY = 'report.jsonl';
/** The blob reporter stores attachments as `resources/<sha1>.<mime extension>`. */
const RESOURCE_ENTRY = /^resources\/[0-9a-f]{40}\.[a-z0-9]{1,16}$/;

const ARCHIVE_FAILURE_CODE: Readonly<Record<ArchiveFailure, ProblemCode>> = {
  unreadable: 'zip-unreadable',
  'tool-unavailable': 'zip-tool-unavailable',
  timeout: 'zip-timeout',
  'output-limit': 'zip-output-limit',
};

export function isValidShardTotal(total: number): boolean {
  return Number.isInteger(total) && total >= 1 && total <= MAX_SHARDS;
}

/**
 * The blob file name Playwright 1.64.1 writes for a shard: the index is
 * zero-padded to the width of the total (`report-1.zip` of 2, `report-01.zip`
 * of 10). Re-validate on Playwright upgrades.
 */
export function expectedBlobName(index: number, total: number): string {
  return `report-${String(index).padStart(String(total).length, '0')}.zip`;
}

/** The artifact name the shard job uploads for a shard index. */
export function artifactName(index: number): string {
  return `blob-report-${index}`;
}

/** Absolute, drive-qualified, backslash or `..`-segment entry paths. */
export function isUnsafeEntryPath(entry: string): boolean {
  return (
    entry === '' ||
    entry.startsWith('/') ||
    /^[A-Za-z]:/.test(entry) ||
    entry.includes('\\') ||
    entry.includes('\0') ||
    entry.split('/').some((segment) => segment === '..' || segment === '.')
  );
}

function archiveProblems(archive: ArchiveInspection | undefined): ProblemCode[] {
  if (archive === undefined) {
    return ['zip-unreadable'];
  }
  if (archive.kind === 'failed') {
    return [ARCHIVE_FAILURE_CODE[archive.failure]];
  }

  const codes = new Set<ProblemCode>();
  if (!archive.intact) {
    codes.add('zip-integrity-failed');
  }
  const reports = archive.entries.filter((entry) => entry === REPORT_ENTRY).length;
  if (reports === 0) {
    codes.add('missing-report-jsonl');
  } else if (reports > 1) {
    codes.add('duplicate-report-jsonl');
  }
  const seen = new Set<string>();
  for (const entry of archive.entries) {
    if (isUnsafeEntryPath(entry)) {
      codes.add('unsafe-entry-path');
    } else if (entry !== REPORT_ENTRY && (!RESOURCE_ENTRY.test(entry) || seen.has(entry))) {
      codes.add('unexpected-entry');
    }
    seen.add(entry);
  }
  return [...codes];
}

/**
 * Every problem with a downloaded set of shard artifacts, in a stable order.
 * Empty means the set is complete and every archive is structurally valid.
 */
export function blobReportProblems(
  root: readonly ArtifactEntry[],
  shardTotal: number,
): BlobReportProblem[] {
  if (!isValidShardTotal(shardTotal)) {
    return [{ shard: null, code: 'invalid-shard-total' }];
  }
  if (root.length === 0) {
    return [{ shard: null, code: 'no-artifacts' }];
  }

  const problems: BlobReportProblem[] = [];
  const byShard = new Map<number, ArtifactEntry>();

  for (const entry of root) {
    const match = entry.kind === 'directory' ? ARTIFACT_NAME.exec(entry.name) : null;
    const index = match ? Number(match[1]) : Number.NaN;
    if (!Number.isInteger(index) || index > shardTotal) {
      problems.push({ shard: null, code: 'unexpected-artifact' });
    } else if (byShard.has(index)) {
      problems.push({ shard: index, code: 'duplicate-shard' });
    } else {
      byShard.set(index, entry);
    }
  }

  for (let index = 1; index <= shardTotal; index++) {
    const entry = byShard.get(index);
    if (entry === undefined) {
      problems.push({ shard: index, code: 'missing-shard' });
      continue;
    }
    const expected = expectedBlobName(index, shardTotal);
    const files = entry.files ?? [];
    const blob = files.find((file) => file.name === expected && file.kind === 'file');
    if (files.some((file) => file !== blob)) {
      problems.push({ shard: index, code: 'unexpected-file' });
    }
    if (blob === undefined) {
      problems.push({ shard: index, code: 'missing-zip' });
      continue;
    }
    for (const code of archiveProblems(blob.archive)) {
      problems.push({ shard: index, code });
    }
  }
  return problems;
}

/** One log line per problem: a shard index and a fixed code, nothing else. */
export function formatProblem(problem: BlobReportProblem): string {
  return problem.shard === null
    ? `blob reports: ${problem.code}`
    : `blob reports: shard ${problem.shard}: ${problem.code}`;
}
