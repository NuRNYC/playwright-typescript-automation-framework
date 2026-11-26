/**
 * Trusted publication publisher (ADR-0011 P2, contract amended 2026-11-26).
 *
 *   runPublication(args, deps) -> Promise<PublicationResult>
 *
 * One execution, in this order; nothing reaches the network until every
 * offline check has passed, and nothing is written until the complete
 * generation exists in memory:
 *
 *    1 runtime        refuse dangerous Node/TLS/proxy/git configuration
 *    2 credential     the dedicated read-only token, format only
 *    3 builtAt        explicit, ISO 8601 UTC, within ±15 minutes of the clock
 *    4 source commit  HEAD equals it; tracked and untracked tree clean
 *    5 allow-list     private file outside the repository, strict schema 1.0.0
 *    6 directories    safe output parent; safe evidence directory if needed
 *    7 retained       pinned bundles read through the handle, strict P1 parser
 *    8 network        source commit on `main`; per entry the committed
 *                     `collectEvidence` over the committed transport
 *    9 policy         the ADR-0011 P2 failure matrix on the raw evidence
 *   10 manifest       the committed P1 builder; any omission is internal-error
 *   11 output         scan, then one staging directory committed by rename
 *
 * TRUST BOUNDARY. No interface of this module accepts `Collected` evidence, a
 * verdict, a summary state or an authenticity value: evidence exists only as
 * the return value of `collectEvidence(createTransport(...))` inside
 * `runPublication`. `deps` carries adapters (HTTP, filesystem, git, clock)
 * so the same code runs in tests against synthetic GitHub responses; only
 * `scripts/build-publication.ts` wires the real ones, and the CLI exposes no
 * option for any of them. These are code structure, not authentication:
 * TypeScript types and object identity prove nothing about where evidence
 * came from, and code inside this process could still forge it (ADR-0011,
 * "Runtime trust assumptions"). The trust policy is the committed
 * `TRUST_POLICY`; it is not injectable.
 *
 * Output: fixed codes only. No token, API body, URL, signed URL, path,
 * environment value or exception text is returned, written or printed.
 *
 * Free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  chmodSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { isStrictlyWithin } from './quality-summary-cli.ts';
import { isRunAttempt, isPositiveId, isSha, parseRetainedBundle } from './verdict-bundle.ts';
import type { UnauthenticatedBundle } from './verdict-bundle.ts';
import {
  buildPublicationManifest,
  isIsoUtc,
  outputScan,
  type ManifestEntryInput,
} from './publication-manifest.ts';
import {
  TRUST_POLICY,
  bundleFileName,
  collectEvidence,
  createTransport,
  nodePrivateFiles,
  reconcileCollected,
  type Collected,
  type HttpAdapter,
} from './verdict-cli.ts';
import type { RetrievalFailure, VerdictResult } from './verdict.ts';

/* ------------------------------------------------------------------ *
 * Contract constants (ADR-0011 P2)
 * ------------------------------------------------------------------ */

export const ALLOWLIST_SCHEMA_VERSION = '1.0.0';
export const ALLOWLIST_KIND = 'quality-verdict-publication-allowlist';
export const MAX_ALLOWLIST_BYTES = 64 * 1024;
export const MAX_ALLOWLIST_ENTRIES = 500;
export const MAX_RETAINED_BYTES = 64 * 1024;
export const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;
export const BUILT_AT_TOLERANCE_MS = 15 * 60 * 1000;

export const MANIFEST_FILE = 'quality-verdict-publication.json';
export const BUILD_RECORD_FILE = 'publication-build-record.json';
export const BUILD_RECORD_SCHEMA_VERSION = '1.0.0';
export const BUILD_RECORD_KIND = 'quality-verdict-publication-build-record';
/** `qvp-<builtAt as YYYYMMDDTHHMMSSZ>-<first 16 hex of the manifest SHA-256>`. */
export const GENERATION_NAME = /^qvp-\d{8}T\d{6}Z-[0-9a-f]{16}$/;
export const STAGING_PREFIX = '.qvp-staging-';
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const MAX_STAGING_ATTEMPTS = 5;

/**
 * Environment variables whose mere presence refuses the run (ADR-0011,
 * "Dangerous runtime configuration"). Values are never read.
 */
export const UNSAFE_ENVIRONMENT = Object.freeze([
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
] as const);

/** Same format the M8E-4 operator accepts (`verdict-cli.ts`). */
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const NODE_VERSION = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const STAGING_ID = /^[A-Za-z0-9-]{16,64}$/;
const MAX_ARG_LENGTH = 4096;
const FORBIDDEN_SEGMENTS = ['.git', '.auth'];

/* ------------------------------------------------------------------ *
 * Codes and messages
 * ------------------------------------------------------------------ */

export type ExitCode = 0 | 1 | 2;

export const PUBLISHER_CODES = [
  'committed',
  'usage',
  'unsafe-runtime',
  'missing-token',
  'invalid-built-at',
  'source-commit-mismatch',
  'dirty-tree',
  'invalid-allowlist',
  'unsafe-output-path',
  'unsafe-evidence-dir',
  'retained-rejected',
  'source-commit-not-on-main',
  'token-rejected',
  'rate-limited',
  'evidence-unavailable',
  'storage-redirect-refused',
  'digest-mismatch',
  'summary-conflict',
  'identity-mismatch',
  'untrusted-origin',
  'run-not-completed',
  'verdict-undetermined',
  'retained-disagrees',
  'output-exists',
  'staging-failed',
  'commit-failed',
  'internal-error',
] as const;
export type PublisherCode = (typeof PUBLISHER_CODES)[number];

const MESSAGES: Readonly<Record<PublisherCode, string>> = {
  committed: 'publication generation committed',
  usage:
    'usage: node scripts/build-publication.ts --allowlist <abs> --out-parent <abs> --source-commit <40hex> --built-at <ISO> [--evidence-dir <abs>]',
  'unsafe-runtime': 'refused: unsafe Node, TLS, proxy or git runtime configuration',
  'missing-token': 'refused: QUALITY_VERDICT_GITHUB_TOKEN is missing or malformed',
  'invalid-built-at': 'refused: builtAt is invalid or not within 15 minutes of the clock',
  'source-commit-mismatch': 'refused: HEAD is not the requested source commit',
  'dirty-tree': 'refused: the working tree is not clean',
  'invalid-allowlist': 'refused: the allow-list is invalid or not private',
  'unsafe-output-path': 'refused: the output parent directory is not allowed',
  'unsafe-evidence-dir': 'refused: the evidence directory is not allowed',
  'retained-rejected': 'refused: a pinned retained bundle failed its checks',
  'source-commit-not-on-main': 'refused: the source commit is not on main',
  'token-rejected': 'failed: the token was rejected or lacks permission',
  'rate-limited': 'failed: GitHub rate limit reached; nothing was retried',
  'evidence-unavailable': 'failed: required GitHub evidence is unavailable',
  'storage-redirect-refused': 'failed: an artifact redirect left the storage policy',
  'digest-mismatch': 'failed: an artifact digest did not match',
  'summary-conflict': 'failed: summary evidence is in conflict',
  'identity-mismatch': 'failed: run or attempt identity evidence is contradictory',
  'untrusted-origin': 'failed: an allow-listed run has untrusted origin',
  'run-not-completed': 'failed: an allow-listed run is not completed',
  'verdict-undetermined': 'failed: an allow-listed run has no determinable verdict',
  'retained-disagrees': 'failed: a retained bundle disagrees with fresh evidence',
  'output-exists': 'refused: the publication generation already exists',
  'staging-failed': 'failed: the staging directory could not be prepared',
  'commit-failed': 'failed: the publication generation could not be committed',
  'internal-error': 'failed: internal error',
};

export interface PublicationResult {
  readonly exitCode: ExitCode;
  readonly code: PublisherCode;
  /** The committed generation's directory name (never a path), or null. */
  readonly generation: string | null;
  readonly manifestSha256: string | null;
}

/** One fixed, value-free console line. */
export function resultMessage(result: PublicationResult): string {
  const detail =
    result.generation !== null && result.manifestSha256 !== null
      ? ` generation=${result.generation} manifest-sha256=${result.manifestSha256}`
      : '';
  return `quality-publication: ${result.code}${detail} — ${MESSAGES[result.code]}`;
}

function refuse(code: PublisherCode): PublicationResult {
  return { exitCode: code === 'usage' ? 2 : 1, code, generation: null, manifestSha256: null };
}

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

export interface PublicationArgs {
  readonly allowlist: string;
  readonly outParent: string;
  readonly sourceCommit: string;
  readonly builtAt: string;
  readonly evidenceDir: string | null;
}

const OPTIONS = {
  '--allowlist': 'allowlist',
  '--out-parent': 'outParent',
  '--source-commit': 'sourceCommit',
  '--built-at': 'builtAt',
  '--evidence-dir': 'evidenceDir',
} as const;

function absolutePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ARG_LENGTH &&
    !value.includes('\0') &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

/** Each option exactly once, as `--name value`; no positional arguments. */
export function parsePublicationArgs(
  argv: readonly string[],
): { readonly ok: true; readonly args: PublicationArgs } | { readonly ok: false } {
  const seen: Partial<Record<(typeof OPTIONS)[keyof typeof OPTIONS], string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (name === undefined || value === undefined || !Object.hasOwn(OPTIONS, name)) {
      return { ok: false };
    }
    const key = OPTIONS[name as keyof typeof OPTIONS];
    if (seen[key] !== undefined || value.startsWith('--')) return { ok: false };
    seen[key] = value;
  }
  const { allowlist, outParent, sourceCommit, builtAt, evidenceDir } = seen;
  if (
    allowlist === undefined ||
    outParent === undefined ||
    sourceCommit === undefined ||
    builtAt === undefined ||
    !absolutePath(allowlist) ||
    !absolutePath(outParent) ||
    (evidenceDir !== undefined && !absolutePath(evidenceDir)) ||
    !isSha(sourceCommit) ||
    builtAt.length > 64
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    args: { allowlist, outParent, sourceCommit, builtAt, evidenceDir: evidenceDir ?? null },
  };
}

/* ------------------------------------------------------------------ *
 * Strict JSON pre-parse (duplicate keys, escapes, Unicode)
 * ------------------------------------------------------------------ */

/** Deepest nesting accepted before parsing; the allow-list needs four levels. */
export const MAX_JSON_DEPTH = 8;

const HEX4 = /^[0-9A-Fa-f]{4}$/;

/**
 * Validates JSON text strictly before `JSON.parse` sees it, because
 * `JSON.parse` silently keeps the last of duplicate keys (a reviver only sees
 * keys after they collapsed). Bounded recursive descent over the RFC 8259
 * grammar: depth at most `MAX_JSON_DEPTH`; object keys compared after full
 * escape decoding, so `"runId"` and `"runId"` are the same key and a
 * repeat at any level is rejected; only the eight standard escapes;
 * `\uXXXX` with exactly four hex digits and surrogates only as a valid
 * high-low pair; no unescaped control characters; nothing after the value.
 * Returns a boolean only: no position, key or value is ever reported.
 */
export function isStrictJson(text: string): boolean {
  let i = 0;
  const n = text.length;
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      i++;
    }
  };
  /** Decodes one string at `i` (which must be `"`); undefined if invalid. */
  const str = (): string | undefined => {
    if (text[i] !== '"') return undefined;
    i++;
    let out = '';
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return out;
      }
      if (c < 0x20) return undefined;
      if (c === 0x5c) {
        const e = text[i + 1];
        i += 2;
        const simple: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        if (e !== undefined && Object.hasOwn(simple, e)) {
          out += simple[e];
          continue;
        }
        if (e !== 'u') return undefined;
        const hex = text.slice(i, i + 4);
        if (!HEX4.test(hex)) return undefined;
        i += 4;
        const unit = Number.parseInt(hex, 16);
        if (unit >= 0xdc00 && unit <= 0xdfff) return undefined; // lone low surrogate
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const low = text.slice(i + 2, i + 6);
          if (text.slice(i, i + 2) !== '\\u' || !HEX4.test(low)) return undefined;
          const lowUnit = Number.parseInt(low, 16);
          if (lowUnit < 0xdc00 || lowUnit > 0xdfff) return undefined;
          i += 6;
          out += String.fromCharCode(unit, lowUnit);
          continue;
        }
        out += String.fromCharCode(unit);
        continue;
      }
      // Raw UTF-16 from strictly decoded UTF-8: a lone surrogate cannot occur,
      // but is still refused.
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = text.charCodeAt(i + 1);
        if (!(d >= 0xdc00 && d <= 0xdfff)) return undefined;
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) return undefined;
      out += text[i];
      i++;
    }
    return undefined;
  };
  const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
  const value = (depth: number): boolean => {
    if (depth > MAX_JSON_DEPTH) return false;
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const keys = new Set<string>();
      ws();
      if (text[i] === '}') {
        i++;
        return true;
      }
      for (;;) {
        ws();
        const key = str();
        if (key === undefined || keys.has(key)) return false;
        keys.add(key);
        ws();
        if (text[i] !== ':') return false;
        i++;
        if (!value(depth + 1)) return false;
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return true;
        }
        return false;
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return true;
      }
      for (;;) {
        if (!value(depth + 1)) return false;
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return true;
        }
        return false;
      }
    }
    if (c === '"') return str() !== undefined;
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return true;
      }
    }
    const m = NUMBER.exec(text.slice(i, i + 64));
    if (m === null) return false;
    i += m[0].length;
    return true;
  };
  if (!value(0)) return false;
  ws();
  return i === n;
}

/* ------------------------------------------------------------------ *
 * Allow-list (schema 1.0.0)
 * ------------------------------------------------------------------ */

export interface AllowListEntry {
  readonly runId: number;
  readonly runAttempt: number;
  /** Expected SHA-256 of a retained bundle, or null. Never a path. */
  readonly retainedSha256: string | null;
}

export interface AllowList {
  readonly includeUntrustedOrigin: boolean;
  /** Sorted by runId, then runAttempt; duplicate-free. */
  readonly entries: readonly AllowListEntry[];
}

type Rec = Readonly<Record<string, unknown>>;

function isRec(value: unknown): value is Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Rec {
  if (!isRec(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

/**
 * Strict parser: at most 64 KiB, strict UTF-8 (a BOM is not accepted),
 * `isStrictJson` (no duplicate keys at any level, strict escapes), JSON,
 * exact keys at every level, 1–500 entries, valid IDs, no duplicate
 * `(runId, runAttempt)` pairs, retained bundles named only by SHA-256.
 * Returns undefined for anything else.
 */
export function parseAllowList(bytes: Uint8Array): AllowList | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ALLOWLIST_BYTES) return undefined;
  let raw: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    // Duplicate keys (including escaped equivalents), invalid escapes,
    // malformed Unicode and control characters are refused before parsing.
    if (!isStrictJson(text)) return undefined;
    raw = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (
    !exactKeys(raw, ['allowListSchemaVersion', 'kind', 'includeUntrustedOrigin', 'entries']) ||
    raw.allowListSchemaVersion !== ALLOWLIST_SCHEMA_VERSION ||
    raw.kind !== ALLOWLIST_KIND ||
    typeof raw.includeUntrustedOrigin !== 'boolean' ||
    !Array.isArray(raw.entries) ||
    raw.entries.length === 0 ||
    raw.entries.length > MAX_ALLOWLIST_ENTRIES
  ) {
    return undefined;
  }
  const entries: AllowListEntry[] = [];
  const seen = new Set<string>();
  for (const e of raw.entries as readonly unknown[]) {
    if (!exactKeys(e, ['runId', 'runAttempt', 'retained'])) return undefined;
    if (!isPositiveId(e.runId) || !isRunAttempt(e.runAttempt)) return undefined;
    let retainedSha256: string | null = null;
    if (e.retained !== null) {
      if (!exactKeys(e.retained, ['sha256'])) return undefined;
      const sha = e.retained.sha256;
      if (typeof sha !== 'string' || !SHA256_HEX.test(sha)) return undefined;
      retainedSha256 = sha;
    }
    const key = `${String(e.runId)}/${String(e.runAttempt)}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    entries.push({ runId: e.runId, runAttempt: e.runAttempt, retainedSha256 });
  }
  entries.sort((a, b) => a.runId - b.runId || a.runAttempt - b.runAttempt);
  return { includeUntrustedOrigin: raw.includeUntrustedOrigin, entries };
}

/* ------------------------------------------------------------------ *
 * Adapters
 * ------------------------------------------------------------------ */

export interface PathInfo {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly uid: number;
  /** `mode & 0o7777`, including the sticky bit. */
  readonly mode: number;
  /** `dev:ino`. */
  readonly identity: string;
}

/** Facts taken from the open handle (`fstat`), never from the path. */
export type HandleRead =
  | {
      readonly status: 'ok';
      readonly bytes: Uint8Array;
      readonly isFile: boolean;
      readonly uid: number;
      readonly mode: number;
      readonly nlink: number;
      /** A second `fstat` after reading showed the same device, inode and size, and EOF was reached. */
      readonly stable: boolean;
    }
  | { readonly status: 'missing' | 'symlink' | 'not-file' | 'too-large' | 'unreadable' };

export interface PublisherFs {
  readonly callerUid: () => number | undefined;
  /** Never follows a final symlink; undefined when nothing exists. */
  readonly lstat: (path: string) => PathInfo | undefined;
  readonly realpath: (path: string) => string | undefined;
  /** `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`; type and size checked on the handle before reading. */
  readonly readHandle: (path: string, maxBytes: number) => HandleRead;
  /** Exclusive `mkdir` (fails if anything exists), then mode exactly 0700. */
  readonly mkdirPrivate: (path: string) => 'ok' | 'exists' | 'failed';
  /** Exclusive, no-follow, 0600 + fchmod, write, fsync (the M8E-4 H1 primitive). */
  readonly writeNewPrivate: (
    path: string,
    data: string,
  ) =>
    { readonly status: 'ok'; readonly identity: string } | { readonly status: 'exists' | 'failed' };
  readonly fsyncDir: (path: string) => boolean;
  /** Entry names of a directory this run created. Never used to discover inputs. */
  readonly list: (path: string) => readonly string[] | undefined;
  /** `exists`: the target exists and was not replaced (EEXIST, ENOTEMPTY, ENOTDIR, EISDIR). */
  readonly rename: (from: string, to: string) => 'ok' | 'exists' | 'failed';
  readonly removeFile: (path: string) => void;
  readonly removeDir: (path: string) => void;
}

export interface GitProbe {
  /** `git rev-parse --verify HEAD^{commit}`, or undefined on any failure. */
  readonly head: () => string | undefined;
  /** `git status --porcelain=v1 --untracked-files=all`, or undefined on any failure. */
  readonly status: () => string | undefined;
}

export interface RuntimeFacts {
  /** `process.execArgv`. */
  readonly execArgv: readonly string[];
  /** Whether an environment variable is set. Values are never read. */
  readonly isSet: (name: string) => boolean;
}

/**
 * Adapters only. `scripts/build-publication.ts` is the single production
 * caller and wires the real ones; tests substitute synthetic ones. None of
 * these can supply evidence, a verdict or an authenticity value.
 */
export interface PublisherDeps {
  readonly runtime: RuntimeFacts;
  /** Read by the entry script from QUALITY_VERDICT_GITHUB_TOKEN only. */
  readonly token: string | undefined;
  /** The system UTC clock, ISO 8601. */
  readonly now: () => string;
  /** `process.version`. */
  readonly nodeVersion: string;
  /** The repository root; inputs and outputs must lie outside it. */
  readonly repoRoot: string;
  readonly http: HttpAdapter;
  readonly git: GitProbe;
  readonly fs: PublisherFs;
  /** Random token for staging names (16–64 of A–Z, a–z, 0–9, `-`). */
  readonly randomId: () => string;
}

/* ------------------------------------------------------------------ *
 * Path safety
 * ------------------------------------------------------------------ */

function hasForbiddenSegment(path: string): boolean {
  return path.split(sep).some((s) => FORBIDDEN_SEGMENTS.includes(s.toLowerCase()));
}

function withinOrEqual(child: string, root: string): boolean {
  return child === root || isStrictlyWithin(child, root);
}

function insideRepo(real: string, deps: PublisherDeps): boolean {
  const realRepo = deps.fs.realpath(deps.repoRoot);
  return (
    realRepo === undefined ||
    withinOrEqual(real, resolve(deps.repoRoot)) ||
    withinOrEqual(real, realRepo)
  );
}

/**
 * Every ancestor of `real` up to `/` is a directory owned by root or the
 * caller and not writable by group or others; a root-owned sticky directory
 * (such as `/tmp`) is accepted, since others cannot replace entries in it.
 */
function safeAncestry(real: string, uid: number, fs: PublisherFs): boolean {
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

/**
 * An existing private directory: absolute, final component not a symlink,
 * real path outside the repository without `.git`/`.auth` segments, owned by
 * the caller with mode exactly 0700, safe ancestry. Returns its real path.
 */
function privateDirectory(path: string, deps: PublisherDeps): string | undefined {
  const { fs } = deps;
  const uid = fs.callerUid();
  if (uid === undefined || !absolutePath(path) || hasForbiddenSegment(path)) return undefined;
  if (fs.lstat(path)?.kind !== 'directory') return undefined;
  const real = fs.realpath(path);
  if (real === undefined || hasForbiddenSegment(real) || insideRepo(real, deps)) return undefined;
  const info = fs.lstat(real);
  if (info?.kind !== 'directory' || info.uid !== uid || info.mode !== PRIVATE_DIR_MODE) {
    return undefined;
  }
  return safeAncestry(real, uid, fs) ? real : undefined;
}

/**
 * Reads a private file through its handle: regular, owned by the caller,
 * mode exactly 0600, one link, within the limit, stable while read; its
 * directory has safe ancestry and lies outside the repository.
 */
function readPrivateFile(
  real: string,
  maxBytes: number,
  deps: PublisherDeps,
): Uint8Array | undefined {
  const uid = deps.fs.callerUid();
  if (uid === undefined) return undefined;
  // The containing directory and all its ancestors (ownership, no group or
  // world write unless root-owned sticky).
  if (!safeAncestry(real, uid, deps.fs)) return undefined;
  const read = deps.fs.readHandle(real, maxBytes);
  if (
    read.status !== 'ok' ||
    !read.isFile ||
    read.uid !== uid ||
    read.mode !== PRIVATE_FILE_MODE ||
    read.nlink !== 1 ||
    !read.stable ||
    read.bytes.byteLength > maxBytes
  ) {
    return undefined;
  }
  return read.bytes;
}

/* ------------------------------------------------------------------ *
 * Evidence failure policy (ADR-0011 P2 failure matrix)
 * ------------------------------------------------------------------ */

function retrievalCode(reasons: readonly RetrievalFailure[]): PublisherCode | undefined {
  if (reasons.length === 0) return undefined;
  if (reasons.includes('permission')) return 'token-rejected';
  if (reasons.includes('rate-limited')) return 'rate-limited';
  // Every other failure, including any 404 (`not-found`), is unavailable
  // evidence: it never establishes that a run is absent.
  return 'evidence-unavailable';
}

/**
 * Applies the failure matrix to one attempt's raw evidence and the
 * reconciler's result. `undefined` means the attempt may be published.
 */
export function evidenceFailure(
  collected: Collected,
  result: VerdictResult,
  includeUntrustedOrigin: boolean,
): PublisherCode | undefined {
  if (collected.redirectRefused) return 'storage-redirect-refused';

  const ev = collected.evidence;
  const failures: RetrievalFailure[] = [];
  for (const r of [ev.run, ev.jobs, ev.ancestry, ev.artifacts]) {
    if (r.status === 'failed') failures.push(r.reason);
  }
  if (ev.archive.status === 'failed' && ev.archive.reason !== 'expired') {
    failures.push(ev.archive.reason);
  }
  const retrieval = retrievalCode(failures);
  if (retrieval !== undefined) return retrieval;

  const verdict = result.verdict;
  const summary = result.summary;
  if (verdict.reasons.includes('invalid-request') || verdict.reasons.includes('invalid-policy')) {
    return 'internal-error';
  }
  if (summary.state === 'SUMMARY_CONFLICT') {
    return summary.reasons.includes('digest-mismatch') ? 'digest-mismatch' : 'summary-conflict';
  }
  if (verdict.state === 'CONFLICT' && verdict.reasons.some((r) => r.startsWith('identity-'))) {
    return 'identity-mismatch';
  }
  const untrusted = verdict.state === 'UNTRUSTED_PROVENANCE' || result.identity.event !== 'push';
  if (untrusted && !includeUntrustedOrigin) return 'untrusted-origin';
  if (verdict.state === 'PENDING') return 'run-not-completed';
  if (verdict.state === 'UNKNOWN') return 'verdict-undetermined';

  switch (summary.state) {
    case 'SUMMARY_UNKNOWN':
      return 'evidence-unavailable';
    case 'SUMMARY_UNAVAILABLE':
      // Only an artifact explicitly absent from a successful listing, or
      // expired through the listing flag or the archive endpoint's 410.
      return summary.reasons.every((r) => r === 'artifact-absent' || r === 'artifact-expired')
        ? undefined
        : 'evidence-unavailable';
    case 'SUMMARY_INVALID':
      // Only after the archive's digest matched in this execution.
      return ev.archive.status === 'downloaded' && ev.archive.digestCheck === 'match'
        ? undefined
        : 'evidence-unavailable';
    default:
      return undefined;
  }
}

const MANIFEST_REJECTION_CODES: Readonly<Record<string, PublisherCode>> = {
  'retained-disagrees': 'retained-disagrees',
  'identity-mismatch': 'identity-mismatch',
  'retained-invalid': 'retained-rejected',
  'retained-identity-incomplete': 'retained-rejected',
};

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `2026-11-26T12:00:00.000Z` -> `20261126T120000Z`. */
function compactTime(iso: string): string {
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

export function generationName(builtAt: string, manifestSha256: string): string {
  return `qvp-${compactTime(builtAt)}-${manifestSha256.slice(0, 16)}`;
}

export interface BuildRecord {
  readonly buildRecordSchemaVersion: typeof BUILD_RECORD_SCHEMA_VERSION;
  readonly kind: typeof BUILD_RECORD_KIND;
  readonly sourceCommit: string;
  readonly builtAt: string;
  readonly nodeVersion: string;
  readonly allowListSha256: string;
  readonly packageLockSha256: string;
  readonly manifestSha256: string;
}

export function serializeBuildRecord(record: BuildRecord): string {
  const ordered: BuildRecord = {
    buildRecordSchemaVersion: record.buildRecordSchemaVersion,
    kind: record.kind,
    sourceCommit: record.sourceCommit,
    builtAt: record.builtAt,
    nodeVersion: record.nodeVersion,
    allowListSha256: record.allowListSha256,
    packageLockSha256: record.packageLockSha256,
    manifestSha256: record.manifestSha256,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function sameNames(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  if (actual === undefined || actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const e = [...expected].sort();
  return a.every((n, i) => n === e[i]);
}

/**
 * The ADR-0011 exclusive-claim generation commit (amended 2026-11-26):
 *
 *    1 claim       `mkdir(<parent>/<generation>, 0700)`; any existing entry of
 *                  any type is `output-exists` and is never touched
 *    2 record      the claim's identity (`dev:ino`), owner and mode
 *    3 stage       a separate private staging directory; two exclusive 0600
 *                  files, each fsynced; the staging directory fsynced
 *    4 validate    parent, staging, both files, and the claim: same identity,
 *                  owned, mode exactly 0700, empty
 *    5 commit      one `rename(staging, claim)` within the parent
 *    6 confirm     the generation has the staging identity and exactly the
 *                  two files; the parent is fsynced
 *
 * Guarantees: an entry present when the claim is attempted is never modified,
 * replaced or removed (exclusive `mkdir`); content becomes visible only
 * through one rename. NOT guaranteed: Node's `rename` is not a no-replace
 * primitive — it replaces an empty directory — so a process of the same OS
 * user that substitutes its own empty directory for the claim after step 4
 * is replaced by the rename. That residual race is accepted by ADR-0011 (the
 * publisher's OS user is trusted). Atomic visibility is not crash
 * durability: a crash can leave an empty claim or a staging directory.
 *
 * Identity is `dev:ino`. A substitute created after the original claim was
 * removed may receive the same inode number (filesystems reuse them; observed
 * on Linux) and is then indistinguishable from the claim; it is an empty,
 * same-user directory and falls under the same accepted residual race.
 *
 * Cleanup removes only resources this run created that still match their
 * recorded identity, and the claim only while it is still empty; a foreign
 * or identity-changed entry is never deleted or replaced.
 */
function commitGeneration(
  parent: string,
  name: string,
  files: readonly (readonly [string, string])[],
  deps: PublisherDeps,
): PublisherCode {
  const { fs } = deps;
  const uid = fs.callerUid();
  if (uid === undefined) return 'staging-failed';
  const target = join(parent, name);
  const fileNames = files.map(([n]) => n);

  // 1–2. Exclusive claim of the generation name.
  const claimed = fs.mkdirPrivate(target);
  if (claimed === 'exists') return 'output-exists';
  if (claimed === 'failed') return 'staging-failed';
  const claimInfo = fs.lstat(target);
  if (
    claimInfo?.kind !== 'directory' ||
    claimInfo.uid !== uid ||
    claimInfo.mode !== PRIVATE_DIR_MODE
  ) {
    // Not provably the directory this run created: never removed.
    return 'staging-failed';
  }
  const claimIdentity = claimInfo.identity;

  const created: { path: string; identity: string }[] = [];
  let staging: string | undefined;
  let stagingIdentity: string | undefined;

  const claimIntact = (): boolean => {
    const info = fs.lstat(target);
    return (
      info?.kind === 'directory' &&
      info.identity === claimIdentity &&
      info.uid === uid &&
      info.mode === PRIVATE_DIR_MODE &&
      fs.list(target)?.length === 0
    );
  };
  const cleanup = (): void => {
    for (const f of created) {
      try {
        if (fs.lstat(f.path)?.identity === f.identity) fs.removeFile(f.path);
      } catch {
        // Best effort; the result is already a failure.
      }
    }
    if (staging !== undefined && stagingIdentity !== undefined) {
      try {
        if (fs.lstat(staging)?.identity === stagingIdentity) fs.removeDir(staging);
      } catch {
        // Best effort; a non-empty or foreign staging directory stays.
      }
    }
    try {
      // The claim only while it is still this run's empty directory.
      if (claimIntact()) fs.removeDir(target);
    } catch {
      // Best effort.
    }
  };

  try {
    // 3. Separate private staging directory.
    for (let i = 0; i < MAX_STAGING_ATTEMPTS && staging === undefined; i++) {
      const id = deps.randomId();
      if (typeof id !== 'string' || !STAGING_ID.test(id)) break;
      const candidate = join(parent, `${STAGING_PREFIX}${id}`);
      const made = fs.mkdirPrivate(candidate);
      if (made === 'failed') break;
      if (made === 'ok') staging = candidate;
    }
    if (staging === undefined) {
      cleanup();
      return 'staging-failed';
    }
    const stagingInfo = fs.lstat(staging);
    if (
      stagingInfo?.kind !== 'directory' ||
      stagingInfo.uid !== uid ||
      stagingInfo.mode !== PRIVATE_DIR_MODE
    ) {
      staging = undefined; // not provably ours: never removed
      cleanup();
      return 'staging-failed';
    }
    stagingIdentity = stagingInfo.identity;
    for (const [fileName, data] of files) {
      const path = join(staging, fileName);
      const written = fs.writeNewPrivate(path, data);
      if (written.status !== 'ok') {
        cleanup();
        return 'staging-failed';
      }
      created.push({ path, identity: written.identity });
    }
    if (!fs.fsyncDir(staging)) {
      cleanup();
      return 'staging-failed';
    }

    // 4. Re-validate everything immediately before the commit.
    const again = fs.lstat(staging);
    const filesIntact = created.every((f) => {
      const info = fs.lstat(f.path);
      return (
        info?.kind === 'file' &&
        info.uid === uid &&
        info.mode === PRIVATE_FILE_MODE &&
        info.identity === f.identity
      );
    });
    if (
      privateDirectory(parent, deps) !== parent ||
      again?.identity !== stagingIdentity ||
      again.uid !== uid ||
      again.mode !== PRIVATE_DIR_MODE ||
      !sameNames(fs.list(staging), fileNames) ||
      !filesIntact
    ) {
      cleanup();
      return 'staging-failed';
    }
    if (!claimIntact()) {
      cleanup();
      return 'commit-failed';
    }

    // 5. One rename onto the empty claim.
    const renamed = fs.rename(staging, target);
    if (renamed !== 'ok') {
      cleanup();
      return renamed === 'exists' ? 'output-exists' : 'commit-failed';
    }
  } catch {
    cleanup();
    return 'staging-failed';
  }

  // 6. Committed and visible. Confirm it is this run's generation and make
  // the rename durable. A failure here is reported and the generation is
  // left for the maintainer: removing it would not be atomic.
  try {
    const committed = fs.lstat(target);
    if (
      committed?.kind !== 'directory' ||
      committed.identity !== stagingIdentity ||
      !sameNames(fs.list(target), fileNames)
    ) {
      return 'commit-failed';
    }
    if (!fs.fsyncDir(parent)) return 'commit-failed';
  } catch {
    return 'commit-failed';
  }
  return 'committed';
}

/* ------------------------------------------------------------------ *
 * runPublication
 * ------------------------------------------------------------------ */

/**
 * Builds and commits one publication generation. Never throws; any
 * unexpected error is `internal-error`.
 */
export async function runPublication(
  args: PublicationArgs,
  deps: PublisherDeps,
): Promise<PublicationResult> {
  return runPublicationWith(args, deps, buildPublicationManifest);
}

/**
 * TEST SEAM. `runPublication` with the P1 manifest builder supplied, so the
 * defence-in-depth guards on its result (no omissions; every allow-listed run
 * published) can be tested in isolation. The production entry script calls
 * `runPublication` only, and no CLI option reaches this parameter. A
 * substituted builder could return any manifest at all, which is why it is
 * reachable only from code and never from the command line; it is a test
 * mechanism, not an authentication boundary.
 */
export async function runPublicationWith(
  args: PublicationArgs,
  deps: PublisherDeps,
  buildManifest: typeof buildPublicationManifest,
): Promise<PublicationResult> {
  try {
    // 1. Runtime configuration, before anything else.
    if (
      deps.runtime.execArgv.length > 0 ||
      UNSAFE_ENVIRONMENT.some((name) => deps.runtime.isSet(name))
    ) {
      return refuse('unsafe-runtime');
    }
    // 2. Credential format.
    const token = deps.token;
    if (typeof token !== 'string' || !TOKEN.test(token)) return refuse('missing-token');
    // 3. builtAt: explicit, canonical UTC, within ±15 minutes. A sanity check only.
    const now = deps.now();
    if (
      !isIsoUtc(args.builtAt) ||
      !isIsoUtc(now) ||
      Math.abs(Date.parse(now) - Date.parse(args.builtAt)) > BUILT_AT_TOLERANCE_MS
    ) {
      return refuse('invalid-built-at');
    }
    if (typeof deps.nodeVersion !== 'string' || !NODE_VERSION.test(deps.nodeVersion)) {
      return refuse('internal-error');
    }
    // 4. Source commit and clean tree.
    if (!isSha(args.sourceCommit) || deps.git.head() !== args.sourceCommit) {
      return refuse('source-commit-mismatch');
    }
    if (deps.git.status() !== '') return refuse('dirty-tree');
    const lock = deps.fs.readHandle(join(deps.repoRoot, 'package-lock.json'), MAX_LOCKFILE_BYTES);
    if (lock.status !== 'ok' || !lock.isFile || !lock.stable) return refuse('internal-error');
    const packageLockSha256 = sha256Hex(lock.bytes);

    // 5. Allow-list: a private file outside the repository.
    if (hasForbiddenSegment(args.allowlist) || deps.fs.lstat(args.allowlist)?.kind !== 'file') {
      return refuse('invalid-allowlist');
    }
    const allowReal = deps.fs.realpath(args.allowlist);
    if (allowReal === undefined || hasForbiddenSegment(allowReal) || insideRepo(allowReal, deps)) {
      return refuse('invalid-allowlist');
    }
    const allowBytes = readPrivateFile(allowReal, MAX_ALLOWLIST_BYTES, deps);
    const allowList = allowBytes === undefined ? undefined : parseAllowList(allowBytes);
    if (allowBytes === undefined || allowList === undefined) return refuse('invalid-allowlist');
    const allowListSha256 = sha256Hex(allowBytes);

    // 6. Directories. --evidence-dir is required if and only if a bundle is pinned.
    const pins = allowList.entries.some((e) => e.retainedSha256 !== null);
    if (pins !== (args.evidenceDir !== null)) return refuse('usage');
    const outParent = privateDirectory(args.outParent, deps);
    if (outParent === undefined) return refuse('unsafe-output-path');
    let evidenceDir: string | undefined;
    if (args.evidenceDir !== null) {
      evidenceDir = privateDirectory(args.evidenceDir, deps);
      if (evidenceDir === undefined) return refuse('unsafe-evidence-dir');
    }

    // 7. Pinned retained bundles, still offline.
    const retained = new Map<string, UnauthenticatedBundle>();
    for (const entry of allowList.entries) {
      if (entry.retainedSha256 === null || evidenceDir === undefined) continue;
      const path = join(evidenceDir, bundleFileName(entry.runId, entry.runAttempt));
      const bytes = readPrivateFile(path, MAX_RETAINED_BYTES, deps);
      if (bytes === undefined) return refuse('retained-rejected');
      const parsed = parseRetainedBundle(
        bytes,
        { runId: entry.runId, runAttempt: entry.runAttempt, sha256: entry.retainedSha256 },
        TRUST_POLICY,
      );
      if (parsed.status !== 'valid') return refuse('retained-rejected');
      retained.set(`${String(entry.runId)}/${String(entry.runAttempt)}`, parsed.bundle);
    }

    // 8. Network: the committed transport, one execution, no retries.
    const transport = createTransport({
      token,
      repository: TRUST_POLICY.repositoryFullName,
      branch: TRUST_POLICY.trustedBranch,
      http: deps.http,
    });
    const tip = await transport.resolveBranchTip();
    if (tip.status === 'failed') return refuse(retrievalCode([tip.reason]) ?? 'internal-error');
    const onMain = await transport.compare(args.sourceCommit, tip.value);
    if (onMain.status === 'failed') {
      return refuse(retrievalCode([onMain.reason]) ?? 'internal-error');
    }
    if (onMain.value.relation !== 'identical' && onMain.value.relation !== 'head-is-ancestor') {
      return refuse('source-commit-not-on-main');
    }

    const inputs: ManifestEntryInput[] = [];
    for (const entry of allowList.entries) {
      const request = { runId: entry.runId, runAttempt: entry.runAttempt };
      const collected = await collectEvidence(transport, request, TRUST_POLICY);
      // 9. Failure policy on the raw evidence, before projection.
      const failure = evidenceFailure(
        collected,
        reconcileCollected(collected, TRUST_POLICY),
        allowList.includeUntrustedOrigin,
      );
      if (failure !== undefined) return refuse(failure);
      inputs.push({
        kind: 'build-verified',
        runId: entry.runId,
        runAttempt: entry.runAttempt,
        collected,
        retained: retained.get(`${String(entry.runId)}/${String(entry.runAttempt)}`) ?? null,
      });
    }

    // 10. The committed P1 manifest builder.
    const built = buildManifest({
      build: {
        sourceCommit: args.sourceCommit,
        builtAt: args.builtAt,
        workingTree: 'clean',
        policy: TRUST_POLICY,
      },
      entries: inputs,
      synthetic: null,
      includeUntrustedOrigin: allowList.includeUntrustedOrigin,
    });
    if (built.status !== 'built') {
      return refuse(MANIFEST_REJECTION_CODES[built.code] ?? 'internal-error');
    }
    // Every allow-listed run is published or the build fails.
    if (built.omitted.length > 0) return refuse('internal-error');
    const published = built.manifest.results.length + built.manifest.untrustedOrigin.length;
    if (published !== allowList.entries.length) return refuse('internal-error');

    // 11. Output scan, then the generation.
    const record = serializeBuildRecord({
      buildRecordSchemaVersion: BUILD_RECORD_SCHEMA_VERSION,
      kind: BUILD_RECORD_KIND,
      sourceCommit: args.sourceCommit,
      builtAt: args.builtAt,
      nodeVersion: deps.nodeVersion,
      allowListSha256,
      packageLockSha256,
      manifestSha256: built.sha256,
    });
    const inputsNamed = [args.allowlist, args.outParent, args.evidenceDir, allowReal, outParent];
    for (const text of [built.text, record]) {
      if (!outputScan(text) || text.includes(token)) return refuse('internal-error');
      if (inputsNamed.some((p) => p !== null && p !== undefined && text.includes(p))) {
        return refuse('internal-error');
      }
    }
    const name = generationName(args.builtAt, built.sha256);
    if (!GENERATION_NAME.test(name)) return refuse('internal-error');
    const committed = commitGeneration(
      outParent,
      name,
      [
        [MANIFEST_FILE, built.text],
        [BUILD_RECORD_FILE, record],
      ],
      deps,
    );
    if (committed !== 'committed') return refuse(committed);
    return { exitCode: 0, code: 'committed', generation: name, manifestSha256: built.sha256 };
  } catch {
    return refuse('internal-error');
  }
}

/* ------------------------------------------------------------------ *
 * Node adapters (wired only by scripts/build-publication.ts)
 * ------------------------------------------------------------------ */

const O_NOFOLLOW: number | undefined = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
const O_NONBLOCK: number = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
const O_DIRECTORY: number | undefined = (constants as { O_DIRECTORY?: number }).O_DIRECTORY;

function errorCodeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

function kindOf(stats: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): PathInfo['kind'] {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

export const nodePublisherFs: PublisherFs = {
  callerUid: () => (typeof process.getuid === 'function' ? process.getuid() : undefined),
  lstat: (path) => {
    try {
      const s = lstatSync(path);
      return {
        kind: kindOf(s),
        uid: s.uid,
        mode: s.mode & 0o7777,
        identity: `${String(s.dev)}:${String(s.ino)}`,
      };
    } catch {
      return undefined;
    }
  },
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  },
  readHandle: (path, maxBytes) => {
    if (O_NOFOLLOW === undefined) return { status: 'unreadable' };
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === 'ENOENT') return { status: 'missing' };
      if (code === 'ELOOP' || code === 'EMLINK') return { status: 'symlink' };
      return { status: 'unreadable' };
    }
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) return { status: 'not-file' };
      if (before.size > maxBytes) return { status: 'too-large' };
      const bytes = new Uint8Array(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (n === 0) break;
        offset += n;
      }
      const extra = new Uint8Array(1);
      const eof = offset === bytes.length && readSync(fd, extra, 0, 1, offset) === 0;
      const after = fstatSync(fd);
      return {
        status: 'ok',
        bytes,
        isFile: true,
        uid: before.uid,
        mode: before.mode & 0o7777,
        nlink: before.nlink,
        stable:
          eof &&
          after.dev === before.dev &&
          after.ino === before.ino &&
          after.size === before.size &&
          after.nlink === before.nlink,
      };
    } catch {
      return { status: 'unreadable' };
    } finally {
      closeSync(fd);
    }
  },
  mkdirPrivate: (path) => {
    try {
      mkdirSync(path, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
      return errorCodeOf(error) === 'EEXIST' ? 'exists' : 'failed';
    }
    try {
      // The umask can only remove bits; set exactly 0700 on the new directory.
      chmodSync(path, PRIVATE_DIR_MODE);
      return 'ok';
    } catch {
      return 'failed';
    }
  },
  writeNewPrivate: (path, data) => nodePrivateFiles.writeNewPrivate(path, data),
  fsyncDir: (path) => {
    if (O_NOFOLLOW === undefined || O_DIRECTORY === undefined) return false;
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
    } catch {
      return false;
    }
    try {
      fsyncSync(fd);
      return true;
    } catch {
      return false;
    } finally {
      closeSync(fd);
    }
  },
  list: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return undefined;
    }
  },
  rename: (from, to) => {
    try {
      renameSync(from, to);
      return 'ok';
    } catch (error) {
      const code = errorCodeOf(error);
      return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR' || code === 'EISDIR'
        ? 'exists'
        : 'failed';
    }
  },
  removeFile: (path) => {
    unlinkSync(path);
  },
  removeDir: (path) => {
    rmdirSync(path);
  },
};

/**
 * Environment for the git child process. No shell; no inherited variables
 * (so no inherited GIT_* override); global and system git configuration
 * ignored. Without PATH, the platform default search path is used.
 */
export const GIT_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
});

export function nodeGit(repoRoot: string): GitProbe {
  const git = (args: readonly string[]): string | undefined => {
    try {
      return execFileSync(
        'git',
        ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
        {
          cwd: repoRoot,
          env: GIT_ENVIRONMENT,
          encoding: 'utf8',
          shell: false,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        },
      );
    } catch {
      return undefined;
    }
  };
  return {
    head: () => {
      const out = git(['rev-parse', '--verify', 'HEAD^{commit}'])?.trim();
      return out !== undefined && isSha(out) ? out : undefined;
    },
    status: () =>
      git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']),
  };
}
