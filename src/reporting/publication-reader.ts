/**
 * Node-side strict publication reader (ADR-0011 P3-2).
 *
 *   readPublicationGeneration(request, deps) -> PublicationReadResult
 *
 * Reads ONE explicitly named P2 publication generation for a future trusted
 * dashboard build and returns its manifest only if every check passes. It is
 * the "Readers (P3)" contract of the ADR-0011 exclusive-claim amendment plus
 * the P3-1 commit binding:
 *
 *    1 request      exactly three fields: an absolute generation directory,
 *                   the expected manifest SHA-256 (pin) and the expected
 *                   source commit. No discovery, no defaults, no override
 *    2 name         the directory name matches the generation pattern, so a
 *                   staging directory or any other entry is refused
 *    3 directory    not a symlink; real path outside the repository with no
 *                   `.git`/`.auth` segment; owned by the caller; mode exactly
 *                   0700; every ancestor owned by root or the caller and not
 *                   group/world-writable (root-owned sticky allowed)
 *    4 contents     exactly the two generation files: an empty claim or a
 *                   partial generation is incomplete; anything else is extra
 *    5 files        each read through one `O_NOFOLLOW` handle: regular, owned
 *                   by the caller, mode exactly 0600, one link, within its
 *                   size limit, unchanged while read
 *    6 identity     the directory still has its identity after reading
 *    7 pin          SHA-256 of the manifest bytes equals the pin
 *    8 record       strict JSON, exact build-record schema and canonical text;
 *                   its manifest SHA-256 equals the computed one
 *    9 manifest     strict JSON (duplicate keys refused), the browser-safe
 *                   strict reader, byte-identical to the P1 serializer, the
 *                   P1 output scan
 *   10 binding      record and manifest agree on source commit and builtAt;
 *                   the name equals `generationName(builtAt, sha256)`; the
 *                   policy equals the committed TRUST_POLICY; the source
 *                   commit equals the expected one
 *
 * TRUST. Nothing here makes evidence trustworthy: `BUILD_VERIFIED` remains
 * the P2 publisher's statement. This reader only establishes that the files
 * are the pinned, complete, unmodified output of one publisher generation,
 * built from the expected commit under the committed policy. A process of
 * the same OS user can still change files after this check (ADR-0011
 * accepted same-user trust model).
 *
 * Output: fixed codes only. No path, file content, hash of anything other
 * than the pinned manifest, or exception text is returned.
 *
 * Free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002). Not loaded by the browser.
 */
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

import { isStrictlyWithin } from './quality-summary-cli.ts';
import { TRUST_POLICY } from './verdict-cli.ts';
import { publicPolicy, samePolicy } from './verdict-bundle.ts';
import { MAX_MANIFEST_BYTES, outputScan, serializeManifest } from './publication-manifest.ts';
import type { PublicationManifest } from './publication-manifest.ts';
import {
  BUILD_RECORD_FILE,
  BUILD_RECORD_KIND,
  BUILD_RECORD_SCHEMA_VERSION,
  GENERATION_NAME,
  MANIFEST_FILE,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  generationName,
  isStrictJson,
  serializeBuildRecord,
  type BuildRecord,
  type PublisherFs,
} from './publication-publisher.ts';
import { isCanonicalUtc, parsePublication, type PublicationRejection } from './publication-view.ts';

/** The build record is a few hundred bytes; anything near this is not one. */
export const MAX_BUILD_RECORD_BYTES = 4 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const NODE_VERSION = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const FORBIDDEN_SEGMENTS = ['.git', '.auth'];
const MAX_PATH_LENGTH = 4096;

export const READER_CODES = [
  'invalid-request',
  'invalid-generation-name',
  'generation-missing',
  'symlink-refused',
  'not-a-directory',
  'inside-repository',
  'unsafe-owner',
  'unsafe-permissions',
  'unsafe-ancestry',
  'incomplete-generation',
  'unexpected-entries',
  'file-unsafe',
  'file-too-large',
  'file-unstable',
  'generation-changed',
  'manifest-sha256-mismatch',
  'invalid-encoding',
  'build-record-invalid',
  'build-record-mismatch',
  'manifest-invalid',
  'manifest-not-canonical',
  'output-scan-failed',
  'generation-name-mismatch',
  'policy-mismatch',
  'source-commit-mismatch',
] as const;
export type ReaderCode = (typeof READER_CODES)[number];

/** The explicit, complete input. There is no field for trust, authenticity or a verdict. */
export interface PublicationReadRequest {
  /** Absolute path of one generation directory (`qvp-<builtAt>-<sha16>`). */
  readonly generationDir: string;
  /** Expected SHA-256 of the manifest file, 64 lowercase hex, from trusted build configuration. */
  readonly expectedManifestSha256: string;
  /** The dashboard build's own source commit; must equal `manifest.build.sourceCommit`. */
  readonly expectedSourceCommit: string;
}

/** Read-only adapters; the production ones are `nodePublisherFs` (P2). */
export interface PublicationReaderDeps {
  readonly fs: Pick<PublisherFs, 'callerUid' | 'lstat' | 'realpath' | 'readHandle' | 'list'>;
  /** The repository root; the generation must lie outside it. */
  readonly repoRoot: string;
}

export type PublicationReadResult =
  | {
      readonly status: 'ok';
      readonly generation: string;
      /** The exact manifest text, for embedding by the dashboard build. */
      readonly manifestText: string;
      readonly manifestSha256: string;
      readonly manifest: PublicationManifest;
    }
  | {
      readonly status: 'rejected';
      readonly code: ReaderCode;
      /** For `manifest-invalid` only: the browser-safe reader's fixed code. */
      readonly detail: PublicationRejection | null;
    };

type Rec = Readonly<Record<string, unknown>>;

function isRec(value: unknown): value is Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function refuse(
  code: ReaderCode,
  detail: PublicationRejection | null = null,
): PublicationReadResult {
  return Object.freeze({ status: 'rejected', code, detail });
}

function hasForbiddenSegment(path: string): boolean {
  return path.split(sep).some((s) => FORBIDDEN_SEGMENTS.includes(s.toLowerCase()));
}

function withinOrEqual(child: string, root: string): boolean {
  return child === root || isStrictlyWithin(child, root);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every ancestor up to `/`: a directory owned by root or the caller, not group/world-writable (root sticky allowed). */
function safeAncestry(real: string, uid: number, fs: PublicationReaderDeps['fs']): boolean {
  let current = dirname(real);
  for (;;) {
    const info = fs.lstat(current);
    if (info?.kind !== 'directory') return false;
    const ownerOk = info.uid === 0 || info.uid === uid;
    const writableByOthers = (info.mode & 0o022) !== 0;
    const rootSticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!ownerOk || (writableByOthers && !rootSticky)) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function validRequest(value: unknown): value is PublicationReadRequest {
  if (!isRec(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join() !== 'expectedManifestSha256,expectedSourceCommit,generationDir') return false;
  const dir = value.generationDir;
  return (
    typeof dir === 'string' &&
    dir.length > 0 &&
    dir.length <= MAX_PATH_LENGTH &&
    !dir.includes('\0') &&
    isAbsolute(dir) &&
    resolve(dir) === dir &&
    typeof value.expectedManifestSha256 === 'string' &&
    SHA256_HEX.test(value.expectedManifestSha256) &&
    typeof value.expectedSourceCommit === 'string' &&
    SHA.test(value.expectedSourceCommit)
  );
}

type FileRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: ReaderCode };

function readGenerationFile(
  path: string,
  maxBytes: number,
  uid: number,
  fs: PublicationReaderDeps['fs'],
): FileRead {
  const read = fs.readHandle(path, maxBytes);
  if (read.status === 'too-large') return { ok: false, code: 'file-too-large' };
  if (read.status === 'missing') return { ok: false, code: 'incomplete-generation' };
  if (read.status !== 'ok') return { ok: false, code: 'file-unsafe' };
  if (!read.isFile || read.uid !== uid || read.mode !== PRIVATE_FILE_MODE || read.nlink !== 1) {
    return { ok: false, code: 'file-unsafe' };
  }
  if (read.bytes.byteLength > maxBytes) return { ok: false, code: 'file-too-large' };
  if (!read.stable) return { ok: false, code: 'file-unstable' };
  return { ok: true, bytes: read.bytes };
}

function decode(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

const RECORD_KEYS = [
  'buildRecordSchemaVersion',
  'kind',
  'sourceCommit',
  'builtAt',
  'nodeVersion',
  'allowListSha256',
  'packageLockSha256',
  'manifestSha256',
] as const;

/** Strict build-record parse: exact keys, formats and canonical P2 serialization. */
function parseBuildRecord(text: string): BuildRecord | undefined {
  if (!isStrictJson(text)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRec(raw) || Object.keys(raw).join() !== RECORD_KEYS.join()) return undefined;
  const r = raw;
  if (
    r.buildRecordSchemaVersion !== BUILD_RECORD_SCHEMA_VERSION ||
    r.kind !== BUILD_RECORD_KIND ||
    typeof r.sourceCommit !== 'string' ||
    !SHA.test(r.sourceCommit) ||
    !isCanonicalUtc(r.builtAt) ||
    typeof r.nodeVersion !== 'string' ||
    !NODE_VERSION.test(r.nodeVersion) ||
    typeof r.allowListSha256 !== 'string' ||
    !SHA256_HEX.test(r.allowListSha256) ||
    typeof r.packageLockSha256 !== 'string' ||
    !SHA256_HEX.test(r.packageLockSha256) ||
    typeof r.manifestSha256 !== 'string' ||
    !SHA256_HEX.test(r.manifestSha256)
  ) {
    return undefined;
  }
  const record: BuildRecord = {
    buildRecordSchemaVersion: BUILD_RECORD_SCHEMA_VERSION,
    kind: BUILD_RECORD_KIND,
    sourceCommit: r.sourceCommit,
    builtAt: r.builtAt,
    nodeVersion: r.nodeVersion,
    allowListSha256: r.allowListSha256,
    packageLockSha256: r.packageLockSha256,
    manifestSha256: r.manifestSha256,
  };
  return serializeBuildRecord(record) === text ? record : undefined;
}

/**
 * Reads and verifies one publication generation. Never throws; never
 * discovers, creates, modifies or removes anything.
 */
export function readPublicationGeneration(
  request: PublicationReadRequest,
  deps: PublicationReaderDeps,
): PublicationReadResult {
  try {
    return read(request, deps);
  } catch {
    return refuse('invalid-request');
  }
}

function read(request: PublicationReadRequest, deps: PublicationReaderDeps): PublicationReadResult {
  // 1 request
  if (!validRequest(request)) return refuse('invalid-request');
  const { fs } = deps;
  const uid = fs.callerUid();
  if (uid === undefined || typeof deps.repoRoot !== 'string' || !isAbsolute(deps.repoRoot)) {
    return refuse('invalid-request');
  }
  const dir = request.generationDir;

  // 2 name (refuses `.qvp-staging-*` and every other name)
  const name = basename(dir);
  if (!GENERATION_NAME.test(name)) return refuse('invalid-generation-name');

  // 3 directory
  const first = fs.lstat(dir);
  if (first === undefined) return refuse('generation-missing');
  if (first.kind === 'symlink') return refuse('symlink-refused');
  if (first.kind !== 'directory') return refuse('not-a-directory');
  const real = fs.realpath(dir);
  if (
    real === undefined ||
    basename(real) !== name ||
    hasForbiddenSegment(dir) ||
    hasForbiddenSegment(real)
  ) {
    return refuse('unsafe-ancestry');
  }
  const realRepo = fs.realpath(deps.repoRoot);
  if (
    realRepo === undefined ||
    withinOrEqual(real, resolve(deps.repoRoot)) ||
    withinOrEqual(real, realRepo) ||
    withinOrEqual(resolve(deps.repoRoot), real)
  ) {
    return refuse('inside-repository');
  }
  const info = fs.lstat(real);
  if (info?.kind !== 'directory') return refuse('not-a-directory');
  if (info.uid !== uid) return refuse('unsafe-owner');
  if (info.mode !== PRIVATE_DIR_MODE) return refuse('unsafe-permissions');
  if (!safeAncestry(real, uid, fs)) return refuse('unsafe-ancestry');

  // 4 contents (a verification of this one directory, never discovery)
  const names = fs.list(real);
  if (names === undefined) return refuse('not-a-directory');
  const expected = [BUILD_RECORD_FILE, MANIFEST_FILE];
  const extra = names.filter((n) => !expected.includes(n));
  if (extra.length > 0) return refuse('unexpected-entries');
  if (names.length !== expected.length) return refuse('incomplete-generation');

  // 5 files, through the handle
  const manifestRead = readGenerationFile(
    `${real}${sep}${MANIFEST_FILE}`,
    MAX_MANIFEST_BYTES,
    uid,
    fs,
  );
  if (!manifestRead.ok) return refuse(manifestRead.code);
  const recordRead = readGenerationFile(
    `${real}${sep}${BUILD_RECORD_FILE}`,
    MAX_BUILD_RECORD_BYTES,
    uid,
    fs,
  );
  if (!recordRead.ok) return refuse(recordRead.code);

  // 6 the directory is still the one that was checked, with the same contents
  const after = fs.lstat(real);
  const namesAfter = fs.list(real);
  if (
    after?.kind !== 'directory' ||
    after.identity !== info.identity ||
    after.uid !== uid ||
    after.mode !== PRIVATE_DIR_MODE ||
    namesAfter === undefined ||
    [...namesAfter].sort().join('/') !== [...expected].sort().join('/')
  ) {
    return refuse('generation-changed');
  }

  // 7 pin
  const manifestSha256 = sha256Hex(manifestRead.bytes);
  if (manifestSha256 !== request.expectedManifestSha256) return refuse('manifest-sha256-mismatch');

  const manifestText = decode(manifestRead.bytes);
  const recordText = decode(recordRead.bytes);
  if (manifestText === undefined || recordText === undefined) return refuse('invalid-encoding');

  // 8 build record
  const record = parseBuildRecord(recordText);
  if (record === undefined) return refuse('build-record-invalid');
  if (record.manifestSha256 !== manifestSha256) return refuse('build-record-mismatch');

  // 9 manifest
  if (!isStrictJson(manifestText)) return refuse('manifest-invalid', 'invalid-json');
  const parsed = parsePublication(manifestText);
  if (parsed.state !== 'valid') return refuse('manifest-invalid', parsed.code);
  const manifest = parsed.manifest;
  if (serializeManifest(manifest) !== manifestText) return refuse('manifest-not-canonical');
  if (!outputScan(manifestText)) return refuse('output-scan-failed');

  // 10 binding
  if (
    record.sourceCommit !== manifest.build.sourceCommit ||
    record.builtAt !== manifest.build.builtAt
  ) {
    return refuse('build-record-mismatch');
  }
  if (generationName(manifest.build.builtAt, manifestSha256) !== name) {
    return refuse('generation-name-mismatch');
  }
  const committed = publicPolicy(TRUST_POLICY);
  if (committed === undefined || !samePolicy(manifest.build.policy, committed)) {
    return refuse('policy-mismatch');
  }
  if (manifest.build.sourceCommit !== request.expectedSourceCommit) {
    return refuse('source-commit-mismatch');
  }

  return Object.freeze({ status: 'ok', generation: name, manifestText, manifestSha256, manifest });
}
