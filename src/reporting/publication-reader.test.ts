/**
 * Unit tests for the Node-side strict publication reader (ADR-0011 P3-2).
 *
 * Same conventions as the other unit tests (ADR-0002). Every generation is
 * synthetic and written into a fresh `mkdtemp` sandbox outside the
 * repository; nothing reads a real publication generation, an evidence
 * bundle, a token or GitHub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANARY, SYNTHETIC_SHA } from './fixtures.ts';
import { TRUST_POLICY } from './verdict-cli.ts';
import { publicPolicy, type PublicPolicy } from './verdict-bundle.ts';
import {
  BUILD_RECORD_FILE,
  BUILD_RECORD_KIND,
  BUILD_RECORD_SCHEMA_VERSION,
  MANIFEST_FILE,
  generationName,
  nodePublisherFs,
  serializeBuildRecord,
  type BuildRecord,
} from './publication-publisher.ts';
import { canonicalPublicationText, parsePublication } from './publication-view.ts';
import {
  MAX_BUILD_RECORD_BYTES,
  READER_CODES,
  readPublicationGeneration,
  type PublicationReadRequest,
  type PublicationReaderDeps,
  type PublicationReadResult,
} from './publication-reader.ts';

/* ------------------------------------------------------------------ *
 * Synthetic generation fixtures
 * ------------------------------------------------------------------ */

const SOURCE_COMMIT = 'c0ffee0000000000000000000000000000c0ffee';
const OTHER_COMMIT = 'deadbeef00000000000000000000000000000000';
const BUILT_AT = '2026-11-26T12:00:00.000Z';
const COMMITTED_POLICY = publicPolicy(TRUST_POLICY) as PublicPolicy;
const REPO_ROOT = process.cwd();

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

type Json = Record<string, unknown>;

function entry(runId = 1_000_001): Json {
  return {
    runId,
    runAttempt: 1,
    headSha: SYNTHETIC_SHA,
    event: 'push',
    gate: {
      state: 'VERIFIED_PASS',
      reasons: ['gate-success'],
      authenticity: 'BUILD_VERIFIED',
      freshness: 'CURRENT',
      verifiedAt: BUILT_AT,
    },
    summary: {
      state: 'SUMMARY_VERIFIED_ORIGIN',
      reasons: ['verified-origin'],
      label: 'verified-origin',
    },
    artifact: {
      id: 15_000_001,
      digest: `sha256:${'ab'.repeat(32)}`,
      integrity: 'verified-in-build',
    },
    metrics: {
      authenticity: 'BUILD_VERIFIED',
      freshness: 'CURRENT',
      summarySchemaVersion: '1.0.0',
      totals: {
        attempts: 20,
        byExecutionOutcome: { flaky: 1, passed: 18 },
        byInstanceOutcome: { flaky: 1, passed: 17 },
        definitions: 12,
        executions: 19,
        instances: 18,
        retries: 1,
        zeroAttemptExecutions: 0,
      },
      completeness: {
        ambiguousIdentities: 0,
        droppedTags: 0,
        inconsistentExecutions: 0,
        invalidDurations: 0,
        invalidRetries: 0,
        omissionDetection: 'not-supported',
        provisionalOutcomes: 0,
        shardAttribution: 'not-available',
        statsCrossCheck: 'match',
        unclassifiedAttempts: 0,
        unrecognizedProjectExecutions: 0,
        unresolvedIdentities: 0,
      },
    },
  };
}

function manifestText(
  overrides: { sourceCommit?: string; builtAt?: string; policy?: Json } = {},
): string {
  return `${JSON.stringify(
    {
      manifestSchemaVersion: '1.0.0',
      kind: 'quality-verdict-publication',
      build: {
        sourceCommit: overrides.sourceCommit ?? SOURCE_COMMIT,
        builtAt: overrides.builtAt ?? BUILT_AT,
        policy: overrides.policy ?? COMMITTED_POLICY,
      },
      results: [entry()],
      untrustedOrigin: [],
      synthetic: null,
    },
    null,
    2,
  )}\n`;
}

function record(manifest: string | Uint8Array, overrides: Partial<BuildRecord> = {}): string {
  return serializeBuildRecord({
    buildRecordSchemaVersion: BUILD_RECORD_SCHEMA_VERSION,
    kind: BUILD_RECORD_KIND,
    sourceCommit: SOURCE_COMMIT,
    builtAt: BUILT_AT,
    nodeVersion: 'v24.22.3',
    allowListSha256: 'e'.repeat(64),
    packageLockSha256: 'f'.repeat(64),
    manifestSha256: sha256(manifest),
    ...overrides,
  });
}

interface Sandbox {
  readonly parent: string;
  readonly cleanup: () => void;
}

function sandbox(): Sandbox {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'qvp-reader-')));
  chmodSync(parent, 0o700);
  return {
    parent,
    cleanup: () => {
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

interface Generation {
  readonly dir: string;
  readonly sha: string;
  readonly request: PublicationReadRequest;
}

/** Writes a complete generation as the P2 publisher would: 0700 directory, two 0600 files. */
function generation(
  parent: string,
  options: { manifest?: string | Uint8Array; record?: string; name?: string } = {},
): Generation {
  const manifest = options.manifest ?? manifestText();
  const sha = sha256(manifest);
  const name = options.name ?? generationName(BUILT_AT, sha);
  const dir = join(parent, name);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, MANIFEST_FILE), manifest, { mode: 0o600 });
  writeFileSync(join(dir, BUILD_RECORD_FILE), options.record ?? record(manifest), { mode: 0o600 });
  chmodSync(join(dir, MANIFEST_FILE), 0o600);
  chmodSync(join(dir, BUILD_RECORD_FILE), 0o600);
  return {
    dir,
    sha,
    request: {
      generationDir: dir,
      expectedManifestSha256: sha,
      expectedSourceCommit: SOURCE_COMMIT,
    },
  };
}

const DEPS: PublicationReaderDeps = { fs: nodePublisherFs, repoRoot: REPO_ROOT };

function codeOf(result: PublicationReadResult): string {
  assert.equal(result.status, 'rejected', 'expected a rejection');
  if (result.status !== 'rejected') throw new Error('unreachable');
  return result.code;
}

function withSandbox(fn: (s: Sandbox) => void): void {
  const s = sandbox();
  try {
    fn(s);
  } finally {
    s.cleanup();
  }
}

/* ------------------------------------------------------------------ *
 * Accepted generation
 * ------------------------------------------------------------------ */

test('a complete, pinned, canonical generation from the expected commit is accepted', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    const result = readPublicationGeneration(g.request, DEPS);
    assert.equal(result.status, 'ok', JSON.stringify(result));
    if (result.status !== 'ok') return;
    assert.equal(result.manifestSha256, g.sha);
    assert.equal(result.manifestText, manifestText());
    assert.equal(result.generation, generationName(BUILT_AT, g.sha));
    assert.equal(result.manifest.build.sourceCommit, SOURCE_COMMIT);
    assert.equal(canonicalPublicationText(result.manifest), result.manifestText);
    assert.equal(parsePublication(result.manifestText).state, 'valid');
    assert.equal(Object.isFrozen(result), true);
    // The result carries no path.
    assert.equal(JSON.stringify(result).includes(parent), false);
  });
});

test('reading never changes the generation', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    const before = nodePublisherFs.list(g.dir);
    readPublicationGeneration(g.request, DEPS);
    assert.deepEqual(nodePublisherFs.list(g.dir), before);
    assert.equal(nodePublisherFs.lstat(g.dir)?.mode, 0o700);
  });
});

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */

test('the request must be exactly three valid, explicit fields', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    const bad: unknown[] = [
      null,
      {},
      { ...g.request, generationDir: 'relative/qvp-x' },
      { ...g.request, generationDir: `${g.dir}/` },
      { ...g.request, generationDir: `${parent}/../${g.dir.slice(parent.length + 1)}` },
      { ...g.request, generationDir: `${g.dir}\0` },
      { ...g.request, expectedManifestSha256: g.sha.toUpperCase() },
      { ...g.request, expectedManifestSha256: g.sha.slice(1) },
      { ...g.request, expectedSourceCommit: 'abc' },
      { ...g.request, authenticity: 'BUILD_VERIFIED' },
      { ...g.request, trusted: true },
      { generationDir: g.dir, expectedManifestSha256: g.sha },
    ];
    for (const request of bad) {
      assert.equal(
        codeOf(readPublicationGeneration(request as PublicationReadRequest, DEPS)),
        'invalid-request',
        JSON.stringify(request),
      );
    }
  });
});

test('the expected source commit must equal manifest.build.sourceCommit', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    const result = readPublicationGeneration(
      { ...g.request, expectedSourceCommit: OTHER_COMMIT },
      DEPS,
    );
    assert.equal(codeOf(result), 'source-commit-mismatch');
  });
});

test('the manifest SHA-256 must equal the pin', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    const result = readPublicationGeneration(
      { ...g.request, expectedManifestSha256: 'a'.repeat(64) },
      DEPS,
    );
    assert.equal(codeOf(result), 'manifest-sha256-mismatch');
  });
});

/* ------------------------------------------------------------------ *
 * Name, claim and staging
 * ------------------------------------------------------------------ */

test('staging directories and other names are refused by name', () => {
  withSandbox(({ parent }) => {
    for (const name of [
      '.qvp-staging-0123456789abcdef',
      'qvp-latest',
      'qvp-20261126T120000Z-ABCDEF0123456789',
      'generation',
    ]) {
      const g = generation(parent, { name });
      assert.equal(
        codeOf(readPublicationGeneration(g.request, DEPS)),
        'invalid-generation-name',
        name,
      );
    }
  });
});

test('a name that does not match builtAt and the manifest hash is refused', () => {
  withSandbox(({ parent }) => {
    const wrongTime = generation(parent, {
      name: `qvp-20261126T120001Z-${sha256(manifestText()).slice(0, 16)}`,
    });
    assert.equal(
      codeOf(readPublicationGeneration(wrongTime.request, DEPS)),
      'generation-name-mismatch',
    );
    rmSync(wrongTime.dir, { recursive: true });
    const wrongHash = generation(parent, { name: 'qvp-20261126T120000Z-0000000000000000' });
    assert.equal(
      codeOf(readPublicationGeneration(wrongHash.request, DEPS)),
      'generation-name-mismatch',
    );
  });
});

test('an empty claim or a partial generation is incomplete', () => {
  withSandbox(({ parent }) => {
    const sha = sha256(manifestText());
    const claim = join(parent, generationName(BUILT_AT, sha));
    mkdirSync(claim, { mode: 0o700 });
    chmodSync(claim, 0o700);
    const request = {
      generationDir: claim,
      expectedManifestSha256: sha,
      expectedSourceCommit: SOURCE_COMMIT,
    };
    assert.equal(codeOf(readPublicationGeneration(request, DEPS)), 'incomplete-generation');
    writeFileSync(join(claim, MANIFEST_FILE), manifestText(), { mode: 0o600 });
    chmodSync(join(claim, MANIFEST_FILE), 0o600);
    assert.equal(codeOf(readPublicationGeneration(request, DEPS)), 'incomplete-generation');
  });
});

test('extra entries are refused', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    writeFileSync(join(g.dir, 'notes.txt'), 'x', { mode: 0o600 });
    assert.equal(codeOf(readPublicationGeneration(g.request, DEPS)), 'unexpected-entries');
    unlinkSync(join(g.dir, 'notes.txt'));
    mkdirSync(join(g.dir, '.qvp-staging-0123456789abcdef'), { mode: 0o700 });
    assert.equal(codeOf(readPublicationGeneration(g.request, DEPS)), 'unexpected-entries');
  });
});

test('a missing generation is refused', () => {
  withSandbox(({ parent }) => {
    const sha = sha256(manifestText());
    const request = {
      generationDir: join(parent, generationName(BUILT_AT, sha)),
      expectedManifestSha256: sha,
      expectedSourceCommit: SOURCE_COMMIT,
    };
    assert.equal(codeOf(readPublicationGeneration(request, DEPS)), 'generation-missing');
  });
});

/* ------------------------------------------------------------------ *
 * Links, ownership and permissions
 * ------------------------------------------------------------------ */

test('a symlinked generation directory is refused', () => {
  withSandbox(({ parent }) => {
    const real = generation(parent, { name: 'elsewhere' });
    const name = generationName(BUILT_AT, real.sha);
    symlinkSync(real.dir, join(parent, name));
    const request = { ...real.request, generationDir: join(parent, name) };
    assert.equal(codeOf(readPublicationGeneration(request, DEPS)), 'symlink-refused');
  });
});

test('a symlinked or hard-linked file is refused', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    const outside = join(parent, 'outside.json');
    writeFileSync(outside, manifestText(), { mode: 0o600 });
    chmodSync(outside, 0o600);
    unlinkSync(join(g.dir, MANIFEST_FILE));
    symlinkSync(outside, join(g.dir, MANIFEST_FILE));
    assert.equal(codeOf(readPublicationGeneration(g.request, DEPS)), 'file-unsafe');
    unlinkSync(join(g.dir, MANIFEST_FILE));
    linkSync(outside, join(g.dir, MANIFEST_FILE));
    assert.equal(codeOf(readPublicationGeneration(g.request, DEPS)), 'file-unsafe');
  });
});

test('a regular file at the generation name is not a directory', () => {
  withSandbox(({ parent }) => {
    const sha = sha256(manifestText());
    const path = join(parent, generationName(BUILT_AT, sha));
    writeFileSync(path, 'x', { mode: 0o600 });
    const request = {
      generationDir: path,
      expectedManifestSha256: sha,
      expectedSourceCommit: SOURCE_COMMIT,
    };
    assert.equal(codeOf(readPublicationGeneration(request, DEPS)), 'not-a-directory');
  });
});

test('directory and file modes must be exactly 0700 and 0600', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    for (const mode of [0o755, 0o750, 0o701, 0o1700]) {
      chmodSync(g.dir, mode);
      assert.equal(
        codeOf(readPublicationGeneration(g.request, DEPS)),
        'unsafe-permissions',
        mode.toString(8),
      );
    }
    chmodSync(g.dir, 0o700);
    for (const file of [MANIFEST_FILE, BUILD_RECORD_FILE]) {
      for (const mode of [0o644, 0o640, 0o400, 0o700]) {
        chmodSync(join(g.dir, file), mode);
        assert.equal(
          codeOf(readPublicationGeneration(g.request, DEPS)),
          'file-unsafe',
          `${file} ${mode.toString(8)}`,
        );
      }
      chmodSync(join(g.dir, file), 0o600);
    }
    assert.equal(readPublicationGeneration(g.request, DEPS).status, 'ok');
  });
});

test('a directory or file owned by another user is refused', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    const uid = nodePublisherFs.callerUid() ?? 0;
    const otherDir: PublicationReaderDeps = {
      repoRoot: REPO_ROOT,
      fs: {
        ...nodePublisherFs,
        lstat: (path) => {
          const info = nodePublisherFs.lstat(path);
          return info !== undefined && path === g.dir ? { ...info, uid: uid + 1 } : info;
        },
      },
    };
    assert.equal(codeOf(readPublicationGeneration(g.request, otherDir)), 'unsafe-owner');
    const otherFile: PublicationReaderDeps = {
      repoRoot: REPO_ROOT,
      fs: {
        ...nodePublisherFs,
        readHandle: (path, max) => {
          const read = nodePublisherFs.readHandle(path, max);
          return read.status === 'ok' && path.endsWith(MANIFEST_FILE)
            ? { ...read, uid: uid + 1 }
            : read;
        },
      },
    };
    assert.equal(codeOf(readPublicationGeneration(g.request, otherFile)), 'file-unsafe');
    const unknownCaller: PublicationReaderDeps = {
      repoRoot: REPO_ROOT,
      fs: { ...nodePublisherFs, callerUid: () => undefined },
    };
    assert.equal(codeOf(readPublicationGeneration(g.request, unknownCaller)), 'invalid-request');
  });
});

test('a group- or world-writable ancestor is refused', () => {
  withSandbox(({ parent }) => {
    const middle = join(parent, 'shared');
    mkdirSync(middle, { mode: 0o700 });
    const g = generation(middle);
    for (const mode of [0o777, 0o770, 0o722]) {
      chmodSync(middle, mode);
      assert.equal(
        codeOf(readPublicationGeneration(g.request, DEPS)),
        'unsafe-ancestry',
        mode.toString(8),
      );
    }
    chmodSync(middle, 0o700);
    assert.equal(readPublicationGeneration(g.request, DEPS).status, 'ok');
  });
});

test('a generation inside the repository, or one containing it, is refused', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    assert.equal(
      codeOf(readPublicationGeneration(g.request, { ...DEPS, repoRoot: parent })),
      'inside-repository',
    );
    assert.equal(
      codeOf(readPublicationGeneration(g.request, { ...DEPS, repoRoot: join(g.dir, 'repo') })),
      'inside-repository',
    );
  });
});

test('a .git or .auth path segment is refused', () => {
  withSandbox(({ parent }) => {
    // Separate parents: macOS filesystems are usually case-insensitive.
    for (const [i, segment] of ['.git', '.auth', '.GIT'].entries()) {
      const base = join(parent, `p${String(i)}`, segment);
      mkdirSync(base, { mode: 0o700, recursive: true });
      chmodSync(join(parent, `p${String(i)}`), 0o700);
      const g = generation(base);
      assert.equal(codeOf(readPublicationGeneration(g.request, DEPS)), 'unsafe-ancestry', segment);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Modification during reading and size limits
 * ------------------------------------------------------------------ */

test('a file modified while it is read is refused', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    const unstable: PublicationReaderDeps = {
      repoRoot: REPO_ROOT,
      fs: {
        ...nodePublisherFs,
        readHandle: (path, max) => {
          const read = nodePublisherFs.readHandle(path, max);
          return read.status === 'ok' && path.endsWith(BUILD_RECORD_FILE)
            ? { ...read, stable: false }
            : read;
        },
      },
    };
    assert.equal(codeOf(readPublicationGeneration(g.request, unstable)), 'file-unstable');
  });
});

test('a directory replaced or changed during reading is refused', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    let calls = 0;
    const swapped: PublicationReaderDeps = {
      repoRoot: REPO_ROOT,
      fs: {
        ...nodePublisherFs,
        lstat: (path) => {
          const info = nodePublisherFs.lstat(path);
          if (info === undefined || path !== g.dir) return info;
          calls += 1;
          // The third lstat of the directory is the post-read identity check.
          return calls >= 3 ? { ...info, identity: '0:0' } : info;
        },
      },
    };
    assert.equal(codeOf(readPublicationGeneration(g.request, swapped)), 'generation-changed');
    let lists = 0;
    const grew: PublicationReaderDeps = {
      repoRoot: REPO_ROOT,
      fs: {
        ...nodePublisherFs,
        list: (path) => {
          lists += 1;
          const names = nodePublisherFs.list(path);
          return lists >= 2 && names !== undefined ? [...names, 'late.json'] : names;
        },
      },
    };
    assert.equal(codeOf(readPublicationGeneration(g.request, grew)), 'generation-changed');
  });
});

test('oversized files are refused before reading', () => {
  withSandbox(({ parent }) => {
    const big = generation(parent, { record: `${' '.repeat(MAX_BUILD_RECORD_BYTES)}\n` });
    assert.equal(codeOf(readPublicationGeneration(big.request, DEPS)), 'file-too-large');
  });
});

/* ------------------------------------------------------------------ *
 * Build record binding
 * ------------------------------------------------------------------ */

test('the build record must be strict, canonical and bound to the manifest', () => {
  const manifest = manifestText();
  const good = record(manifest);
  const cases: [string, string, string][] = [
    [
      'another manifest hash',
      record(manifest, { manifestSha256: 'a'.repeat(64) }),
      'build-record-mismatch',
    ],
    [
      'another source commit',
      record(manifest, { sourceCommit: OTHER_COMMIT }),
      'build-record-mismatch',
    ],
    [
      'another builtAt',
      record(manifest, { builtAt: '2026-11-26T12:00:01.000Z' }),
      'build-record-mismatch',
    ],
    ['extra field', good.replace('"kind"', '"verified": true,\n  "kind"'), 'build-record-invalid'],
    [
      'duplicate key',
      good.replace('"kind"', '"nodeVersion": "v1.0.0",\n  "kind"'),
      'build-record-invalid',
    ],
    ['escaped key', good.replace('"kind"', '"\\u006bind"'), 'build-record-invalid'],
    ['compact form', `${JSON.stringify(JSON.parse(good))}\n`, 'build-record-invalid'],
    [
      'wrong kind',
      good.replace(BUILD_RECORD_KIND, 'quality-verdict-bundle'),
      'build-record-invalid',
    ],
    ['wrong version', good.replace('"1.0.0"', '"2.0.0"'), 'build-record-invalid'],
    ['bad node version', record(manifest, { nodeVersion: 'node24' }), 'build-record-invalid'],
    ['not JSON', 'nope', 'build-record-invalid'],
  ];
  for (const [name, recordText, code] of cases) {
    withSandbox(({ parent }) => {
      const g = generation(parent, { manifest, record: recordText });
      assert.equal(codeOf(readPublicationGeneration(g.request, DEPS)), code, name);
    });
  }
});

/* ------------------------------------------------------------------ *
 * Manifest content
 * ------------------------------------------------------------------ */

test('a manifest with duplicate keys is refused even when pinned', () => {
  withSandbox(({ parent }) => {
    const text = manifestText().replace(
      '"kind": "quality-verdict-publication",',
      '"kind": "quality-verdict-publication",\n  "kind": "quality-verdict-publication",',
    );
    const g = generation(parent, { manifest: text });
    const result = readPublicationGeneration(g.request, DEPS);
    assert.deepEqual(result, {
      status: 'rejected',
      code: 'manifest-invalid',
      detail: 'invalid-json',
    });
  });
});

test('a schema-invalid manifest is refused with the browser reader code', () => {
  withSandbox(({ parent }) => {
    const text = manifestText().replace('"VERIFIED_PASS"', '"PASS"');
    const g = generation(parent, { manifest: text });
    assert.deepEqual(readPublicationGeneration(g.request, DEPS), {
      status: 'rejected',
      code: 'manifest-invalid',
      detail: 'invalid-value',
    });
  });
});

test('a manifest whose policy differs from the committed TRUST_POLICY is refused', () => {
  const foreign = {
    ...COMMITTED_POLICY,
    repositoryId: 900_000_001,
    repositoryFullName: 'example-owner/example-repo',
  };
  withSandbox(({ parent }) => {
    const g = generation(parent, { manifest: manifestText({ policy: foreign }) });
    assert.equal(codeOf(readPublicationGeneration(g.request, DEPS)), 'policy-mismatch');
  });
});

test('secret and path canaries in a manifest are refused by the output scan', () => {
  for (const workflowName of ['canary build', 'token refresh']) {
    withSandbox(({ parent }) => {
      const g = generation(parent, {
        manifest: manifestText({ policy: { ...COMMITTED_POLICY, workflowName } }),
      });
      assert.equal(
        codeOf(readPublicationGeneration(g.request, DEPS)),
        'output-scan-failed',
        workflowName,
      );
    });
  }
});

test('invalid UTF-8 is refused even when pinned', () => {
  withSandbox(({ parent }) => {
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode(manifestText()).slice(0, -2),
      0xff,
      0x0a,
    ]);
    const g = generation(parent, { manifest: bytes });
    assert.equal(codeOf(readPublicationGeneration(g.request, DEPS)), 'invalid-encoding');
  });
});

test('rejections carry only fixed codes: no path, content or canary', () => {
  withSandbox(({ parent }) => {
    const marker = join(parent, CANARY);
    mkdirSync(marker, { mode: 0o700 });
    const g = generation(marker, { record: `${CANARY}\n` });
    const result = readPublicationGeneration(g.request, DEPS);
    assert.equal(codeOf(result), 'build-record-invalid');
    const text = JSON.stringify(result);
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes(parent), false);
    assert.deepEqual(Object.keys(result).sort(), ['code', 'detail', 'status']);
    assert.ok((READER_CODES as readonly string[]).includes(codeOf(result)));
  });
});

test('an adapter exception becomes a fixed rejection', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    const throwing: PublicationReaderDeps = {
      repoRoot: REPO_ROOT,
      fs: {
        ...nodePublisherFs,
        list: () => {
          throw new Error(`boom ${CANARY}`);
        },
      },
    };
    const result = readPublicationGeneration(g.request, throwing);
    assert.equal(result.status, 'rejected');
    assert.equal(JSON.stringify(result).includes(CANARY), false);
  });
});

test('a generation moved after the claim is read from its new, validated location only', () => {
  withSandbox(({ parent }) => {
    const g = generation(parent);
    const moved = join(parent, 'moved');
    mkdirSync(moved, { mode: 0o700 });
    const target = join(moved, generationName(BUILT_AT, g.sha));
    renameSync(g.dir, target);
    assert.equal(codeOf(readPublicationGeneration(g.request, DEPS)), 'generation-missing');
    assert.equal(
      readPublicationGeneration({ ...g.request, generationDir: target }, DEPS).status,
      'ok',
    );
  });
});

test('a pinned, canonical generation with a contradictory verdict reason is refused', () => {
  withSandbox(({ parent }) => {
    const text = manifestText().replace('"gate-success"', '"gate-failure"');
    const g = generation(parent, { manifest: text });
    const result = readPublicationGeneration(g.request, DEPS);
    assert.deepEqual(result, {
      status: 'rejected',
      code: 'manifest-invalid',
      detail: 'reason-state-mismatch',
    });
    assert.equal(JSON.stringify(result).includes(parent), false);
  });
});

test('a pinned, canonical generation with a contradictory summary reason is refused', () => {
  withSandbox(({ parent }) => {
    const text = manifestText().replace('"verified-origin"\n', '"artifact-absent"\n');
    assert.notEqual(text, manifestText());
    const g = generation(parent, { manifest: text });
    assert.deepEqual(readPublicationGeneration(g.request, DEPS), {
      status: 'rejected',
      code: 'manifest-invalid',
      detail: 'reason-state-mismatch',
    });
  });
});
