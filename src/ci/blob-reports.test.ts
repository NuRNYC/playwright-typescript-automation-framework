/**
 * Unit tests for the blob-report completeness policy (ADR-0007).
 *
 * Same conventions as the other unit tests (ADR-0002): Node's built-in
 * runner, an explicit `.ts` import, plain-object inputs. Archive listings are
 * shaped like the blobs Playwright 1.64.1 writes: `report.jsonl` plus, for
 * failing tests, `resources/<sha1>.<extension>` attachments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blobReportProblems,
  expectedBlobName,
  formatProblem,
  isUnsafeEntryPath,
  type ArchiveInspection,
  type ArtifactEntry,
  type BlobReportProblem,
} from './blob-reports.ts';

const SHA1 = 'a'.repeat(40);
const LISTED: ArchiveInspection = { kind: 'listed', entries: ['report.jsonl'], intact: true };

function shard(index: number, archive: ArchiveInspection = LISTED, total = 2): ArtifactEntry {
  return {
    name: `blob-report-${index}`,
    kind: 'directory',
    files: [{ name: expectedBlobName(index, total), kind: 'file', archive }],
  };
}

function codes(problems: readonly BlobReportProblem[]): string[] {
  return problems.map(formatProblem);
}

test('a complete two-shard set with plain and attachment-bearing blobs passes', () => {
  const withAttachments: ArchiveInspection = {
    kind: 'listed',
    entries: ['report.jsonl', `resources/${SHA1}.md`, `resources/${'b'.repeat(40)}.zip`],
    intact: true,
  };
  assert.deepEqual(blobReportProblems([shard(1), shard(2, withAttachments)], 2), []);
});

test('blob names follow the zero-padding Playwright 1.64.1 applies', () => {
  assert.equal(expectedBlobName(1, 2), 'report-1.zip');
  assert.equal(expectedBlobName(1, 10), 'report-01.zip');
  assert.equal(expectedBlobName(10, 10), 'report-10.zip');
  assert.deepEqual(blobReportProblems([shard(1, LISTED, 1)], 1), []);
});

test('invalid shard totals and empty input are refused', () => {
  for (const total of [0, -1, 1.5, Number.NaN, 100]) {
    assert.deepEqual(codes(blobReportProblems([shard(1)], total)), [
      'blob reports: invalid-shard-total',
    ]);
  }
  assert.deepEqual(codes(blobReportProblems([], 2)), ['blob reports: no-artifacts']);
});

test('a missing shard is reported even though merge-reports would accept the set', () => {
  assert.deepEqual(codes(blobReportProblems([shard(1)], 2)), [
    'blob reports: shard 2: missing-shard',
  ]);
  assert.deepEqual(codes(blobReportProblems([shard(2)], 2)), [
    'blob reports: shard 1: missing-shard',
  ]);
});

test('duplicate, out-of-range and unexpected artifacts are refused', () => {
  assert.deepEqual(codes(blobReportProblems([shard(1), shard(1), shard(2)], 2)), [
    'blob reports: shard 1: duplicate-shard',
  ]);
  assert.deepEqual(codes(blobReportProblems([shard(1), shard(2), shard(3)], 2)), [
    'blob reports: unexpected-artifact',
  ]);
  for (const entry of [
    { name: 'blob-report-0', kind: 'directory', files: [] },
    { name: 'blob-report-01', kind: 'directory', files: [] },
    { name: 'playwright-report', kind: 'directory', files: [] },
    { name: 'report-1.zip', kind: 'file' },
    { name: 'blob-report-2', kind: 'other' },
  ] as const satisfies readonly ArtifactEntry[]) {
    const problems = codes(blobReportProblems([shard(1), entry], 2));
    assert.equal(problems.includes('blob reports: unexpected-artifact'), true, entry.name);
  }
});

test('each shard needs exactly its own blob file and nothing else', () => {
  const wrongName: ArtifactEntry = {
    name: 'blob-report-2',
    kind: 'directory',
    files: [{ name: 'report-1.zip', kind: 'file', archive: LISTED }],
  };
  assert.deepEqual(codes(blobReportProblems([shard(1), wrongName], 2)), [
    'blob reports: shard 2: unexpected-file',
    'blob reports: shard 2: missing-zip',
  ]);

  const empty: ArtifactEntry = { name: 'blob-report-2', kind: 'directory', files: [] };
  assert.deepEqual(codes(blobReportProblems([shard(1), empty], 2)), [
    'blob reports: shard 2: missing-zip',
  ]);

  const extra: ArtifactEntry = {
    name: 'blob-report-2',
    kind: 'directory',
    files: [
      { name: 'report-2.zip', kind: 'file', archive: LISTED },
      { name: 'report-2-copy.zip', kind: 'file', archive: LISTED },
    ],
  };
  assert.deepEqual(codes(blobReportProblems([shard(1), extra], 2)), [
    'blob reports: shard 2: unexpected-file',
  ]);

  const notAFile: ArtifactEntry = {
    name: 'blob-report-2',
    kind: 'directory',
    files: [{ name: 'report-2.zip', kind: 'directory' }],
  };
  assert.deepEqual(codes(blobReportProblems([shard(1), notAFile], 2)), [
    'blob reports: shard 2: unexpected-file',
    'blob reports: shard 2: missing-zip',
  ]);
});

test('unreadable archives fail closed, including tool failures', () => {
  const cases: [ArchiveInspection | undefined, string][] = [
    [{ kind: 'failed', failure: 'unreadable' }, 'zip-unreadable'],
    [{ kind: 'failed', failure: 'tool-unavailable' }, 'zip-tool-unavailable'],
    [{ kind: 'failed', failure: 'timeout' }, 'zip-timeout'],
    [{ kind: 'failed', failure: 'output-limit' }, 'zip-output-limit'],
    [undefined, 'zip-unreadable'],
  ];
  for (const [archive, code] of cases) {
    const entry: ArtifactEntry = {
      name: 'blob-report-2',
      kind: 'directory',
      files: [
        archive === undefined
          ? { name: 'report-2.zip', kind: 'file' }
          : { name: 'report-2.zip', kind: 'file', archive },
      ],
    };
    assert.deepEqual(codes(blobReportProblems([shard(1), entry], 2)), [
      `blob reports: shard 2: ${code}`,
    ]);
  }
});

test('an archive must pass its integrity test and hold exactly one report.jsonl', () => {
  const check = (archive: ArchiveInspection): string[] =>
    codes(blobReportProblems([shard(1), shard(2, archive)], 2));

  assert.deepEqual(check({ kind: 'listed', entries: ['report.jsonl'], intact: false }), [
    'blob reports: shard 2: zip-integrity-failed',
  ]);
  assert.deepEqual(check({ kind: 'listed', entries: [], intact: true }), [
    'blob reports: shard 2: missing-report-jsonl',
  ]);
  assert.deepEqual(check({ kind: 'listed', entries: [`resources/${SHA1}.png`], intact: true }), [
    'blob reports: shard 2: missing-report-jsonl',
  ]);
  assert.deepEqual(
    check({ kind: 'listed', entries: ['report.jsonl', 'report.jsonl'], intact: true }),
    ['blob reports: shard 2: duplicate-report-jsonl'],
  );
});

test('unexpected and unsafe archive entries are refused', () => {
  const check = (entry: string): string[] =>
    codes(
      blobReportProblems(
        [shard(1), shard(2, { kind: 'listed', entries: ['report.jsonl', entry], intact: true })],
        2,
      ),
    );

  for (const entry of [
    'notes.txt',
    'resources/',
    `resources/${SHA1}`,
    `resources/${SHA1.slice(1)}.md`,
    `resources/sub/${SHA1}.md`,
    `resources/${SHA1.toUpperCase()}.md`,
    'report.json',
  ]) {
    assert.deepEqual(check(entry), ['blob reports: shard 2: unexpected-entry'], entry);
  }
  for (const entry of [
    '/etc/passwd',
    '../report.jsonl',
    'resources/../../x',
    'C:/x',
    'resources\\x',
    './report.jsonl',
    '',
  ]) {
    assert.deepEqual(check(entry), ['blob reports: shard 2: unsafe-entry-path'], entry);
  }
  // A repeated attachment entry is a duplicate, not a second valid file.
  const repeated = `resources/${SHA1}.md`;
  assert.deepEqual(
    codes(
      blobReportProblems(
        [
          shard(1),
          shard(2, { kind: 'listed', entries: ['report.jsonl', repeated, repeated], intact: true }),
        ],
        2,
      ),
    ),
    ['blob reports: shard 2: unexpected-entry'],
  );
});

test('unsafe entry paths are recognised directly', () => {
  assert.equal(isUnsafeEntryPath('report.jsonl'), false);
  assert.equal(isUnsafeEntryPath(`resources/${SHA1}.md`), false);
  for (const entry of ['/a', '..', 'a/../b', 'D:\\a', 'a\\b', 'a/./b', 'a\0b', '']) {
    assert.equal(isUnsafeEntryPath(entry), true, JSON.stringify(entry));
  }
});

test('problems never contain artifact names, entry names or report content', () => {
  const secretName = 'synthetic-secret-artifact';
  const secretEntry = 'synthetic-secret-entry.txt';
  const problems = codes(
    blobReportProblems(
      [
        { name: secretName, kind: 'directory', files: [] },
        shard(1, { kind: 'listed', entries: ['report.jsonl', secretEntry], intact: true }),
      ],
      2,
    ),
  );
  assert.deepEqual(problems, [
    'blob reports: unexpected-artifact',
    'blob reports: shard 1: unexpected-entry',
    'blob reports: shard 2: missing-shard',
  ]);
  assert.equal(problems.join('\n').includes('synthetic-secret'), false);
});
