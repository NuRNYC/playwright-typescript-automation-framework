/**
 * Local quality-verdict operator (ADR-0010, M8E-4).
 *
 *   runVerdict(args, deps) -> Promise<VerdictCliResult>
 *
 * Fetches the read-only GitHub evidence for ONE workflow run attempt,
 * verifies the selected summary artifact's SHA-256 digest over the exact
 * downloaded archive bytes, reads its single `quality-summary.json` in memory,
 * hands everything to the pure M8E-3 reconciler (`./verdict.ts`) and writes
 * one allow-listed JSON bundle to an operator-selected directory OUTSIDE the
 * repository. No verdict logic lives here: every state and reason code comes
 * from `reconcile`.
 *
 * Six read-only GitHub REST operations (API version `API_VERSION`):
 *
 *   1 GET /repos/{repo}/actions/runs/{run_id}/attempts/{n}          run attempt
 *   2 GET /repos/{repo}/actions/runs/{run_id}/attempts/{n}/jobs     jobs (paginated)
 *   3 GET /repos/{repo}/actions/runs/{run_id}/artifacts             artifacts (paginated)
 *   4 GET /repos/{repo}/actions/artifacts/{artifact_id}/zip         one archive (302)
 *   5 GET /repos/{repo}/git/ref/heads/{branch}                      main tip
 *   6 GET /repos/{repo}/compare/{head_sha}...{main_tip}             ancestry
 *
 * Nothing is written to GitHub; no request is retried.
 *
 * Credential and redirect rules:
 *
 * - The token is supplied by the entry script (the only reader of
 *   `QUALITY_VERDICT_GITHUB_TOKEN`) and is captured inside the transport.
 *   It is attached only to requests whose URL is built from `API_ORIGIN`.
 * - Every request is made with redirects disabled (`redirect: 'manual'`).
 *   Only operation 4 may answer with a redirect, and it is followed once,
 *   by a separate request that carries no Authorization header and no
 *   cookies, and only when the target passes `storageTarget`: `https:`, no
 *   userinfo, default port, host matching `STORAGE_HOST`. A second redirect
 *   from storage is a failure. Any other redirect target stops the operator
 *   (`storage-redirect-refused`) instead of widening the policy.
 * - The signed storage URL is never returned, stored, logged or written.
 *
 * Digest: the archive is hashed with SHA-256 exactly as received, before any
 * parsing, and compared with that same artifact's `digest`. The reconciler
 * receives `digestContractConfirmed: true` only for an archive whose digest
 * matched in this run; the base trust policy cannot carry the flag at all.
 *
 * Output: diagnostics are fixed codes; the bundle is built field by field
 * from the reconciler's validated result and, only when metrics are
 * available, from the validated summary's totals and completeness counters.
 *
 * Output permissions (H1): the bundle is created through `PrivateFileOps`,
 * not the shared M8B writer (which creates `0o644` files): exclusive,
 * no-follow, `0o600`, then `fchmod(0o600)` on the open handle, so the final
 * mode is owner-only whatever the caller's umask. The output directory must
 * already be owned by the caller with mode exactly `0o700`; it is refused,
 * never chmod-ed.
 *
 * Adapter boundaries: HTTP (`HttpAdapter`), filesystem (`FsAdapter`, shared
 * with the M8B CLI), private-file creation (`PrivateFileOps`) and
 * temporary-name source are injected, so tests run without network or real
 * files. Kept free of `@/` imports so Node's type-stripping test runner can
 * load it directly (ADR-0002).
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';

import { parseSummary, type ParsedSummary } from './dashboard-model.ts';
import { isStrictlyWithin, type FsAdapter, type WriteOutcome } from './quality-summary-cli.ts';
import {
  reconcile,
  type AncestryEvidence,
  type ArchiveEvidence,
  type ArtifactEvidence,
  type JobEvidence,
  type ReasonCode,
  type Retrieved,
  type RetrievalFailure,
  type RunAttemptEvidence,
  type SummaryState,
  type TrustPolicy,
  type VerdictEvidence,
  type VerdictResult,
  type VerdictState,
} from './verdict.ts';
import { MAX_ARCHIVE_BYTES, readSingleEntry } from './zip-entry.ts';

/* ------------------------------------------------------------------ *
 * Contract
 * ------------------------------------------------------------------ */

export const API_ORIGIN = 'https://api.github.com';
export const API_VERSION = '2022-11-28';
export const USER_AGENT = 'quality-verdict-operator';

/** Per-request timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Largest JSON response read from the API. */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** Page size and page bound for list operations (at most 1000 items). */
export const PER_PAGE = 100;
export const MAX_PAGES = 10;

/**
 * Reviewed storage-host policy for artifact archive redirects: GitHub's
 * Actions results storage accounts on Azure Blob Storage
 * (`productionresultssa<N>.blob.core.windows.net`; `productionresultssa11`
 * was observed in M8E-4 Phase 2A). Anchored, so lookalike prefixes and
 * suffixes fail. Any other host is refused, never added automatically.
 */
export const STORAGE_HOST = /^productionresultssa\d{1,3}\.blob\.core\.windows\.net$/;

/** The bundle's own schema version (independent of the summary schema). */
export const BUNDLE_SCHEMA_VERSION = '1.0.0';
export const BUNDLE_KIND = 'quality-verdict-bundle';

/** Attempts at an unused temporary name before giving up. */
export const MAX_TEMP_ATTEMPTS = 5;

/**
 * The project's approved trust policy (ADR-0010). `digestContractConfirmed`
 * is deliberately absent: it is decided per archive, never configured.
 */
export type BaseTrustPolicy = Omit<TrustPolicy, 'digestContractConfirmed'>;

export const TRUST_POLICY: BaseTrustPolicy = Object.freeze({
  repositoryId: 1_442_287_399,
  repositoryFullName: 'NuRNYC/playwright-typescript-automation-framework',
  workflowId: 403_933_494,
  workflowPath: '.github/workflows/tests.yml',
  workflowName: 'Playwright UI Tests',
  trustedEvent: 'push',
  trustedBranch: 'main',
  testJobName: 'test',
  gateStepName: 'Gate',
  artifactNamePrefix: 'quality-summary-',
});

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPO_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const TEMP_ID = /^[A-Za-z0-9-]{16,64}$/;
const MAX_ARG_LENGTH = 4096;

/* ------------------------------------------------------------------ *
 * HTTP adapter
 * ------------------------------------------------------------------ */

/** Only these response headers are ever exposed by the adapter. */
export interface ResponseHeaders {
  readonly location: string | null;
  readonly rateLimitRemaining: string | null;
  readonly retryAfter: string | null;
}

export interface HttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Bodies larger than this are not read (`too-large`). 3xx bodies are never read. */
  readonly maxBytes: number;
}

export type HttpResult =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly headers: ResponseHeaders;
      readonly body: Uint8Array;
    }
  | { readonly kind: 'error'; readonly error: 'timeout' | 'network' | 'too-large' };

/**
 * One GET. Implementations must never follow redirects, never send cookies
 * or credentials other than the given headers, and never throw.
 */
export interface HttpAdapter {
  readonly get: (request: HttpRequest) => Promise<HttpResult>;
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

export type DownloadOutcome =
  | { readonly status: 'ok'; readonly bytes: Uint8Array }
  | { readonly status: 'failed'; readonly reason: RetrievalFailure | 'expired' }
  /** The storage body exceeded `MAX_ARCHIVE_BYTES` and was abandoned unread. */
  | { readonly status: 'too-large' }
  | { readonly status: 'redirect-refused' };

export interface GitHubTransport {
  readonly getRunAttempt: (
    runId: number,
    attempt: number,
  ) => Promise<Retrieved<RunAttemptEvidence>>;
  readonly listJobs: (runId: number, attempt: number) => Promise<Retrieved<JobEvidence[]>>;
  readonly listArtifacts: (runId: number) => Promise<Retrieved<ArtifactEvidence[]>>;
  readonly downloadArtifact: (artifactId: number) => Promise<DownloadOutcome>;
  readonly resolveBranchTip: () => Promise<Retrieved<string>>;
  readonly compare: (evaluatedSha: string, tipSha: string) => Promise<Retrieved<AncestryEvidence>>;
}

export interface TransportConfig {
  readonly token: string;
  readonly repository: string;
  readonly branch: string;
  readonly http: HttpAdapter;
}

type Rec = Readonly<Record<string, unknown>>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function posInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function nonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function ok<T>(value: T): Retrieved<T> {
  return { status: 'ok', value };
}
function failed<T>(reason: RetrievalFailure): Retrieved<T> {
  return { status: 'failed', reason };
}

/** Maps a non-success HTTP status to a fixed retrieval failure. */
export function classifyStatus(status: number, headers: ResponseHeaders): RetrievalFailure {
  const exhausted = headers.rateLimitRemaining === '0' || headers.retryAfter !== null;
  if (status === 429 || (status === 403 && exhausted)) return 'rate-limited';
  if (status === 401 || status === 403) return 'permission';
  if (status === 404) return 'not-found';
  return 'http-error';
}

/**
 * The validated storage URL for an archive redirect, or `undefined`. The
 * caller must treat the returned URL as a secret.
 */
export function storageTarget(location: string | null): URL | undefined {
  if (
    location === null ||
    location.length > 16_384 ||
    !location.startsWith('https://') ||
    /[\s\\]/.test(location)
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !STORAGE_HOST.test(url.hostname)
  ) {
    return undefined;
  }
  return url;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/* Field mapping. Values are copied without trusting their types: the
 * reconciler validates every field again and treats any malformed response
 * as not retrieved. Only fields this module itself relies on are checked. */

function mapRun(v: unknown): RunAttemptEvidence | undefined {
  if (!isRec(v) || !isRec(v.repository)) return undefined;
  const head = v.head_repository;
  return {
    id: v.id,
    runAttempt: v.run_attempt,
    event: v.event,
    status: v.status,
    conclusion: v.conclusion ?? null,
    headSha: v.head_sha,
    headBranch: v.head_branch ?? null,
    workflowId: v.workflow_id,
    path: v.path,
    name: v.name,
    repository: { id: v.repository.id, fullName: v.repository.full_name },
    headRepository:
      head === null || head === undefined
        ? null
        : { fullName: isRec(head) ? head.full_name : undefined },
    runStartedAt: v.run_started_at,
    updatedAt: v.updated_at,
  } as RunAttemptEvidence;
}

function mapStep(v: unknown): unknown {
  if (!isRec(v)) return v;
  return { number: v.number, name: v.name, status: v.status, conclusion: v.conclusion ?? null };
}

function mapJob(v: unknown): JobEvidence | undefined {
  if (!isRec(v)) return undefined;
  return {
    id: v.id,
    name: v.name,
    runAttempt: v.run_attempt,
    headSha: v.head_sha,
    status: v.status,
    conclusion: v.conclusion ?? null,
    steps: Array.isArray(v.steps) ? (v.steps as unknown[]).map(mapStep) : v.steps,
  } as JobEvidence;
}

function mapArtifact(v: unknown): ArtifactEvidence | undefined {
  if (!isRec(v) || !isRec(v.workflow_run)) return undefined;
  const run = v.workflow_run;
  return {
    id: v.id,
    name: v.name,
    sizeInBytes: v.size_in_bytes,
    digest: v.digest ?? null,
    createdAt: v.created_at,
    expiresAt: v.expires_at,
    expired: v.expired,
    workflowRun: {
      id: run.id,
      repositoryId: run.repository_id,
      headRepositoryId: run.head_repository_id,
      headSha: run.head_sha,
    },
  } as ArtifactEvidence;
}

/** Interprets `compare/{evaluated}...{tip}`: base is the evaluated commit, head the tip. */
function mapCompare(
  v: unknown,
  evaluatedSha: string,
  tipSha: string,
): AncestryEvidence | undefined {
  if (!isRec(v) || !isRec(v.merge_base_commit) || !isRec(v.base_commit)) return undefined;
  const mergeBase = v.merge_base_commit.sha;
  if (v.base_commit.sha !== evaluatedSha || typeof mergeBase !== 'string' || !SHA.test(mergeBase)) {
    return undefined;
  }
  const base = { evaluatedSha, mainTipSha: tipSha };
  switch (v.status) {
    case 'identical':
      return evaluatedSha === tipSha ? { ...base, relation: 'identical' } : undefined;
    case 'ahead': // the tip is ahead of the evaluated commit
      return mergeBase === evaluatedSha && evaluatedSha !== tipSha
        ? { ...base, relation: 'head-is-ancestor' }
        : undefined;
    case 'behind': // the evaluated commit is ahead of the tip
      return mergeBase === tipSha && evaluatedSha !== tipSha
        ? { ...base, relation: 'head-ahead' }
        : undefined;
    case 'diverged':
      return mergeBase !== evaluatedSha && mergeBase !== tipSha
        ? { ...base, relation: 'diverged' }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Builds the read-only transport. The token stays inside this closure and is
 * attached only to URLs built from `API_ORIGIN`.
 */
export function createTransport(config: TransportConfig): GitHubTransport {
  const { http } = config;
  if (!REPO_SLUG.test(config.repository) || !BRANCH.test(config.branch)) {
    throw new Error('invalid transport configuration');
  }
  const repoPath = `/repos/${config.repository}`;
  const apiHeaders: Readonly<Record<string, string>> = Object.freeze({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  });
  const storageHeaders: Readonly<Record<string, string>> = Object.freeze({
    'User-Agent': USER_AGENT,
  });

  async function apiGet(path: string, maxBytes: number): Promise<HttpResult> {
    return http.get({
      url: `${API_ORIGIN}${repoPath}${path}`,
      headers: apiHeaders,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes,
    });
  }

  async function getJson(path: string): Promise<Retrieved<unknown>> {
    const r = await apiGet(path, MAX_JSON_BYTES);
    if (r.kind === 'error') {
      return failed(
        r.error === 'timeout' ? 'timeout' : r.error === 'too-large' ? 'malformed' : 'http-error',
      );
    }
    if (r.status !== 200) return failed(classifyStatus(r.status, r.headers));
    try {
      return ok(JSON.parse(utf8(r.body)) as unknown);
    } catch {
      return failed('malformed');
    }
  }

  async function paged<T>(
    path: string,
    key: string,
    map: (v: unknown) => T | undefined,
  ): Promise<Retrieved<T[]>> {
    const items: T[] = [];
    let total: number | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await getJson(`${path}?per_page=${String(PER_PAGE)}&page=${String(page)}`);
      if (r.status === 'failed') return failed(r.reason);
      const v = r.value;
      if (!isRec(v) || !nonNegInt(v.total_count) || !Array.isArray(v[key])) {
        return failed('malformed');
      }
      const list = v[key] as unknown[];
      if (list.length > PER_PAGE) return failed('malformed');
      if (total === undefined) total = v.total_count;
      else if (v.total_count !== total) return failed('incomplete-pagination');
      for (const raw of list) {
        const mapped = map(raw);
        if (mapped === undefined) return failed('malformed');
        items.push(mapped);
      }
      if (items.length > total) return failed('malformed');
      if (items.length === total) return ok(items);
      if (list.length === 0) return failed('incomplete-pagination');
    }
    return failed('incomplete-pagination');
  }

  async function single<T>(
    path: string,
    map: (v: unknown) => T | undefined,
  ): Promise<Retrieved<T>> {
    const r = await getJson(path);
    if (r.status === 'failed') return failed(r.reason);
    const mapped = map(r.value);
    return mapped === undefined ? failed('malformed') : ok(mapped);
  }

  return Object.freeze({
    getRunAttempt: (runId: number, attempt: number) =>
      single(`/actions/runs/${String(runId)}/attempts/${String(attempt)}`, mapRun),

    listJobs: (runId: number, attempt: number) =>
      paged(`/actions/runs/${String(runId)}/attempts/${String(attempt)}/jobs`, 'jobs', mapJob),

    listArtifacts: (runId: number) =>
      paged(`/actions/runs/${String(runId)}/artifacts`, 'artifacts', mapArtifact),

    resolveBranchTip: () =>
      single(`/git/ref/heads/${config.branch}`, (v) => {
        if (!isRec(v) || !isRec(v.object)) return undefined;
        const tip = v.object.sha;
        return v.ref === `refs/heads/${config.branch}` &&
          v.object.type === 'commit' &&
          typeof tip === 'string' &&
          SHA.test(tip)
          ? tip
          : undefined;
      }),

    compare: async (evaluatedSha: string, tipSha: string): Promise<Retrieved<AncestryEvidence>> => {
      if (!SHA.test(evaluatedSha) || !SHA.test(tipSha)) return failed('malformed');
      return single(`/compare/${evaluatedSha}...${tipSha}?per_page=1`, (v) =>
        mapCompare(v, evaluatedSha, tipSha),
      );
    },

    downloadArtifact: async (artifactId: number): Promise<DownloadOutcome> => {
      if (!posInt(artifactId)) return { status: 'failed', reason: 'malformed' };
      const r = await apiGet(`/actions/artifacts/${String(artifactId)}/zip`, 0);
      if (r.kind === 'error') {
        return { status: 'failed', reason: r.error === 'timeout' ? 'timeout' : 'http-error' };
      }
      if (r.status === 410) return { status: 'failed', reason: 'expired' };
      if (r.status !== 302) {
        return { status: 'failed', reason: classifyStatus(r.status, r.headers) };
      }
      const target = storageTarget(r.headers.location);
      if (target === undefined) return { status: 'redirect-refused' };
      // Separate request: no Authorization, no cookies, no further redirect.
      const s = await http.get({
        url: target.href,
        headers: storageHeaders,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: MAX_ARCHIVE_BYTES,
      });
      if (s.kind === 'error') {
        // `too-large` is an established breach: the adapter stopped at the cap.
        if (s.error === 'too-large') return { status: 'too-large' };
        return { status: 'failed', reason: s.error === 'timeout' ? 'timeout' : 'http-error' };
      }
      if (s.status !== 200) return { status: 'failed', reason: 'http-error' };
      return { status: 'ok', bytes: s.body };
    },
  });
}

/* ------------------------------------------------------------------ *
 * Evidence collection
 * ------------------------------------------------------------------ */

export type DigestStatus = 'verified' | 'mismatch' | 'not-checked';

export interface Collected {
  readonly evidence: VerdictEvidence;
  readonly summary: ParsedSummary | null;
  readonly digest: DigestStatus;
  readonly redirectRefused: boolean;
}

/** SHA-256 of the exact bytes, in the API's `sha256:<hex>` form. */
export function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

type Selection =
  | { readonly action: 'download'; readonly artifact: ArtifactEvidence }
  | { readonly action: 'reject-declared-size'; readonly artifact: ArtifactEvidence }
  | undefined;

/**
 * What to do with the expected artifact, decided from metadata only. The
 * artifact must be the single one with the expected name, bound to this run
 * and head commit, and unexpired. A declared size over `MAX_ARCHIVE_BYTES` is
 * rejected without any download request; otherwise a valid `sha256:` digest
 * is required to download. The reconciler re-checks everything.
 */
function selectArtifact(
  artifacts: Retrieved<ArtifactEvidence[]>,
  run: Retrieved<RunAttemptEvidence>,
  request: { runId: number; runAttempt: number },
  policy: BaseTrustPolicy,
): Selection {
  if (artifacts.status !== 'ok' || run.status !== 'ok') return undefined;
  const name = `${policy.artifactNamePrefix}${String(request.runAttempt)}`;
  const matches = artifacts.value.filter((a) => a.name === name);
  if (matches.length !== 1) return undefined;
  const a = matches[0] as ArtifactEvidence;
  const bound =
    posInt(a.id) &&
    isRec(a.workflowRun) &&
    a.workflowRun.id === request.runId &&
    a.workflowRun.headSha === run.value.headSha &&
    a.expired === false &&
    nonNegInt(a.sizeInBytes);
  if (!bound) return undefined;
  if (a.sizeInBytes > MAX_ARCHIVE_BYTES) return { action: 'reject-declared-size', artifact: a };
  return typeof a.digest === 'string' && DIGEST.test(a.digest)
    ? { action: 'download', artifact: a }
    : undefined;
}

/**
 * Runs the six operations for one attempt and builds the reconciler's input.
 * Sequential and bounded; nothing is retried.
 */
export async function collectEvidence(
  transport: GitHubTransport,
  request: { readonly runId: number; readonly runAttempt: number },
  policy: BaseTrustPolicy,
): Promise<Collected> {
  const run = await transport.getRunAttempt(request.runId, request.runAttempt);
  const jobs = await transport.listJobs(request.runId, request.runAttempt);

  let ancestry: Retrieved<AncestryEvidence>;
  const headSha = run.status === 'ok' ? run.value.headSha : undefined;
  if (typeof headSha === 'string' && SHA.test(headSha)) {
    const tip = await transport.resolveBranchTip();
    ancestry =
      tip.status === 'ok' ? await transport.compare(headSha, tip.value) : failed(tip.reason);
  } else {
    ancestry = failed(run.status === 'failed' ? run.reason : 'malformed');
  }

  const artifacts = await transport.listArtifacts(request.runId);

  let archive: ArchiveEvidence = { status: 'not-attempted' };
  let summary: ParsedSummary | null = null;
  let digest: DigestStatus = 'not-checked';
  let redirectRefused = false;

  const selection = selectArtifact(artifacts, run, request, policy);
  if (selection?.action === 'reject-declared-size') {
    // Never downloaded: the declared size alone establishes the breach.
    archive = {
      status: 'rejected',
      artifactId: selection.artifact.id,
      reason: 'declared-too-large',
    };
  } else if (selection?.action === 'download') {
    const candidate = selection.artifact;
    const download = await transport.downloadArtifact(candidate.id);
    if (download.status === 'redirect-refused') {
      redirectRefused = true;
      archive = { status: 'failed', reason: 'http-error' };
    } else if (download.status === 'too-large') {
      archive = { status: 'rejected', artifactId: candidate.id, reason: 'stream-too-large' };
    } else if (download.status === 'failed') {
      archive = { status: 'failed', reason: download.reason };
    } else if (sha256Digest(download.bytes) !== candidate.digest) {
      // Never parse an archive whose bytes are not the published artifact.
      digest = 'mismatch';
      archive = {
        status: 'downloaded',
        artifactId: candidate.id,
        digestCheck: 'mismatch',
        contents: 'unexpected-entries',
      };
    } else {
      digest = 'verified';
      const entry = readSingleEntry(download.bytes);
      if (entry.status === 'ok') summary = parseSummary(entry.text);
      archive = {
        status: 'downloaded',
        artifactId: candidate.id,
        digestCheck: 'match',
        contents:
          entry.status === 'ok'
            ? 'single-summary'
            : entry.status === 'too-large'
              ? 'too-large'
              : 'unexpected-entries',
      };
    }
  }

  return {
    evidence: { request, run, jobs, ancestry, artifacts, archive },
    summary,
    digest,
    redirectRefused,
  };
}

/** Reconciles with the digest flag set only by THIS archive's verified digest. */
export function reconcileCollected(collected: Collected, policy: BaseTrustPolicy): VerdictResult {
  const archive = collected.evidence.archive;
  const digestContractConfirmed =
    collected.digest === 'verified' &&
    archive.status === 'downloaded' &&
    archive.digestCheck === 'match';
  return reconcile(collected.summary, collected.evidence, { ...policy, digestContractConfirmed });
}

/* ------------------------------------------------------------------ *
 * Bundle
 * ------------------------------------------------------------------ */

export interface VerdictBundle {
  readonly bundleSchemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  readonly kind: typeof BUNDLE_KIND;
  /** The trust policy the attempt was evaluated against (not response values). */
  readonly policy: {
    readonly repositoryId: number;
    readonly repositoryFullName: string;
    readonly workflowId: number;
    readonly workflowPath: string;
    readonly workflowName: string;
    readonly trustedEvent: 'push';
    readonly trustedBranch: string;
  };
  readonly request: { readonly runId: number; readonly runAttempt: number };
  /** Validated identity from the reconciler; null where not established. */
  readonly identity: VerdictResult['identity'];
  readonly verdict: { readonly state: VerdictState; readonly reasons: readonly ReasonCode[] };
  readonly summary: {
    readonly state: SummaryState;
    readonly reasons: readonly ReasonCode[];
    readonly metricsAvailable: boolean;
    readonly label: 'verified-origin' | 'unverified-origin' | null;
  };
  readonly artifact: { readonly id: number | null; readonly digest: DigestStatus };
  /** Only when the reconciler made metrics available; never zero-filled. */
  readonly metrics: {
    readonly summarySchemaVersion: string;
    readonly totals: unknown;
    readonly completeness: unknown;
  } | null;
}

/** Deep copy restricted to JSON numbers, strings, booleans, null, arrays and plain objects. */
function plain(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((v) => plain(v, depth + 1));
  if (isRec(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, plain(value[k], depth + 1)]),
    );
  }
  return null;
}

export function buildBundle(
  result: VerdictResult,
  collected: Collected,
  policy: BaseTrustPolicy,
): VerdictBundle {
  const s = collected.summary;
  const metrics =
    result.summary.metricsAvailable && s !== null && s.state === 'valid'
      ? {
          summarySchemaVersion: s.validated.schemaVersion,
          totals: plain(s.validated.summary.totals),
          completeness: plain(s.validated.summary.completeness),
        }
      : null;
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    kind: BUNDLE_KIND,
    policy: {
      repositoryId: policy.repositoryId,
      repositoryFullName: policy.repositoryFullName,
      workflowId: policy.workflowId,
      workflowPath: policy.workflowPath,
      workflowName: policy.workflowName,
      trustedEvent: policy.trustedEvent,
      trustedBranch: policy.trustedBranch,
    },
    request: {
      runId: collected.evidence.request.runId,
      runAttempt: collected.evidence.request.runAttempt,
    },
    identity: {
      runId: result.identity.runId,
      runAttempt: result.identity.runAttempt,
      headSha: result.identity.headSha,
      event: result.identity.event,
      testJobId: result.identity.testJobId,
      artifactId: result.identity.artifactId,
    },
    verdict: { state: result.verdict.state, reasons: [...result.verdict.reasons] },
    summary: {
      state: result.summary.state,
      reasons: [...result.summary.reasons],
      metricsAvailable: result.summary.metricsAvailable,
      label: result.summary.label,
    },
    artifact: { id: result.identity.artifactId, digest: collected.digest },
    metrics,
  };
}

export function serializeBundle(bundle: VerdictBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export type ExitCode = 0 | 1 | 2;

export type VerdictCliCode =
  | 'written'
  | 'usage'
  | 'missing-token'
  | 'invalid-policy'
  | 'unsafe-output-path'
  | 'unsafe-output-permissions'
  | 'output-exists'
  | 'storage-redirect-refused'
  | 'write-failed'
  | 'internal-error';

export interface VerdictCliResult {
  readonly exitCode: ExitCode;
  readonly code: VerdictCliCode;
  readonly verdict: VerdictState | null;
  readonly summary: SummaryState | null;
}

export interface VerdictArgs {
  readonly runId: number;
  readonly runAttempt: number;
  readonly outputDir: string;
}

export interface VerdictDeps {
  /** The token, read by the entry script from QUALITY_VERDICT_GITHUB_TOKEN only. */
  readonly token: string | undefined;
  readonly http: HttpAdapter;
  readonly fs: FsAdapter;
  /** The repository root; the bundle is never written inside it. */
  readonly repoRoot: string;
  readonly randomId: () => string;
  readonly policy: BaseTrustPolicy;
  /** Owner-only file creation and ownership checks; defaults to `nodePrivateFiles`. */
  readonly privateFiles?: PrivateFileOps;
}

/** Mode of every bundle file, independent of the caller's umask. */
export const BUNDLE_FILE_MODE = 0o600;
/** Required mode of the existing output directory (checked, never applied). */
export const OUTPUT_DIR_MODE = 0o700;

export interface Ownership {
  /** Permission bits (`mode & 0o7777`) of the path itself (lstat, no follow). */
  readonly mode: number;
  /** True only when the path is owned by this process's user. */
  readonly ownedByCaller: boolean;
}

/** Bundle-only filesystem operations that the shared M8B adapter does not offer. */
export interface PrivateFileOps {
  /**
   * Creates `path` exclusively (O_CREAT | O_EXCL | O_NOFOLLOW), sets mode
   * `0o600` on the open handle, writes and syncs `data`, and confirms the
   * handle's mode. Identity uses the same `dev:ino` form as `FsAdapter.identity`.
   */
  readonly writeNewPrivate: (path: string, data: string) => WriteOutcome;
  /** `undefined` when nothing exists at the path. Never follows a final symlink. */
  readonly ownership: (path: string) => Ownership | undefined;
}

const MESSAGES: Readonly<Record<VerdictCliCode, string>> = {
  written: 'bundle written',
  usage: 'usage: node scripts/verify-quality-verdict.ts <run-id> <attempt> <absolute-output-dir>',
  'missing-token': 'refused: QUALITY_VERDICT_GITHUB_TOKEN is missing or malformed',
  'invalid-policy': 'refused: trust policy is invalid',
  'unsafe-output-path': 'refused: output directory is not allowed',
  'unsafe-output-permissions':
    'refused: output directory must be owned by the current user with mode 0700',
  'output-exists': 'refused: a bundle for this attempt already exists in the output directory',
  'storage-redirect-refused':
    'stopped: the artifact download redirected to a location outside the storage policy',
  'write-failed': 'failed: the bundle could not be written',
  'internal-error': 'failed: internal error',
};

/** A fixed, value-free line for the console. States are fixed vocabulary. */
export function resultMessage(result: VerdictCliResult): string {
  const states =
    result.verdict !== null && result.summary !== null
      ? ` [verdict ${result.verdict}, summary ${result.summary}]`
      : '';
  return `quality-verdict: ${result.code}${states} — ${MESSAGES[result.code]}`;
}

function refuse(code: VerdictCliCode, exitCode: ExitCode = 1): VerdictCliResult {
  return { exitCode, code, verdict: null, summary: null };
}

/** Exactly three positional arguments: `<run-id> <attempt> <absolute-output-dir>`. */
export function parseVerdictArgs(
  argv: readonly string[],
): { readonly ok: true; readonly args: VerdictArgs } | { readonly ok: false } {
  const [runId, attempt, outputDir, ...rest] = argv;
  if (
    rest.length > 0 ||
    runId === undefined ||
    attempt === undefined ||
    outputDir === undefined ||
    !/^[1-9]\d{0,15}$/.test(runId) ||
    !/^[1-9]\d{0,5}$/.test(attempt) ||
    outputDir === '' ||
    outputDir.length > MAX_ARG_LENGTH ||
    outputDir.includes('\0') ||
    !isAbsolute(outputDir)
  ) {
    return { ok: false };
  }
  const id = Number(runId);
  if (!Number.isSafeInteger(id)) return { ok: false };
  return { ok: true, args: { runId: id, runAttempt: Number(attempt), outputDir } };
}

export function bundleFileName(runId: number, runAttempt: number): string {
  return `quality-verdict-${String(runId)}-${String(runAttempt)}.json`;
}

const FORBIDDEN_SEGMENTS = ['.auth', '.git'];

function hasForbiddenSegment(path: string): boolean {
  return path.split(sep).some((segment) => FORBIDDEN_SEGMENTS.includes(segment.toLowerCase()));
}

function withinOrEqual(child: string, root: string): boolean {
  return child === root || isStrictlyWithin(child, root);
}

interface BundlePlan {
  readonly realDir: string;
  readonly fileName: string;
}

function privateFilesOf(deps: VerdictDeps): PrivateFileOps {
  return deps.privateFiles ?? nodePrivateFiles;
}

/** The directory is owned by the caller and has mode exactly 0700. */
function isPrivateDir(path: string, deps: VerdictDeps): boolean {
  const own = privateFilesOf(deps).ownership(path);
  return own !== undefined && own.ownedByCaller && own.mode === OUTPUT_DIR_MODE;
}

/**
 * The output directory must be an existing, absolute, non-symlink directory
 * whose real path lies outside the repository, owned by the caller with mode
 * 0700; the bundle file must not exist yet. Nothing is created or chmod-ed.
 */
function planBundle(
  args: VerdictArgs,
  deps: VerdictDeps,
): BundlePlan | 'unsafe-output-path' | 'unsafe-output-permissions' | 'output-exists' {
  const { fs } = deps;
  const dir = resolve(args.outputDir);
  if (hasForbiddenSegment(dir)) return 'unsafe-output-path';
  const realRepo = fs.realpath(deps.repoRoot);
  if (withinOrEqual(dir, resolve(deps.repoRoot)) || withinOrEqual(dir, realRepo)) {
    return 'unsafe-output-path';
  }
  if (fs.lstat(dir)?.kind !== 'directory') return 'unsafe-output-path';
  const realDir = fs.realpath(dir);
  if (withinOrEqual(realDir, realRepo) || hasForbiddenSegment(realDir)) {
    return 'unsafe-output-path';
  }
  if (!isPrivateDir(realDir, deps)) return 'unsafe-output-permissions';
  const fileName = bundleFileName(args.runId, args.runAttempt);
  if (fs.lstat(join(realDir, fileName)) !== undefined) return 'output-exists';
  return { realDir, fileName };
}

function removeIfFile(path: string, fs: FsAdapter): void {
  try {
    if (fs.lstat(path)?.kind === 'file') fs.remove(path);
  } catch {
    // Best effort; the result is already a failure.
  }
}

/**
 * Exclusive owner-only temporary file in the output directory, re-validation
 * of the directory (path and 0700 ownership), the file's identity and 0600
 * mode, and the target's continued absence, then rename. An existing bundle
 * is never replaced.
 */
function writeBundle(
  plan: BundlePlan,
  data: string,
  deps: VerdictDeps,
): 'ok' | 'output-exists' | 'write-failed' {
  const { fs } = deps;
  const privateFiles = privateFilesOf(deps);
  const target = join(plan.realDir, plan.fileName);
  for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS; attempt++) {
    const id = deps.randomId();
    if (!TEMP_ID.test(id)) return 'write-failed';
    const temporary = join(plan.realDir, `.${plan.fileName}.${id}.tmp`);
    if (basename(temporary) !== `.${plan.fileName}.${id}.tmp`) return 'write-failed';
    const created = privateFiles.writeNewPrivate(temporary, data);
    if (created.status === 'exists') continue;
    if (created.status === 'failed') {
      removeIfFile(temporary, fs);
      return 'write-failed';
    }
    try {
      if (fs.lstat(target) !== undefined) {
        removeIfFile(temporary, fs);
        return 'output-exists';
      }
      const temporaryOwnership = privateFiles.ownership(temporary);
      const unchanged =
        fs.realpath(plan.realDir) === plan.realDir &&
        isPrivateDir(plan.realDir, deps) &&
        fs.lstat(temporary)?.kind === 'file' &&
        fs.identity(temporary) === created.identity &&
        temporaryOwnership?.ownedByCaller === true &&
        temporaryOwnership.mode === BUNDLE_FILE_MODE;
      if (!unchanged) {
        removeIfFile(temporary, fs);
        return 'write-failed';
      }
      fs.rename(temporary, target);
      return 'ok';
    } catch {
      removeIfFile(temporary, fs);
      return 'write-failed';
    }
  }
  return 'write-failed';
}

/**
 * Order: token and policy, output plan (no mutation), evidence, reconcile,
 * then the single atomic write. A refused storage redirect stops before
 * anything is written. Never throws; unexpected errors are `internal-error`.
 */
export async function runVerdict(args: VerdictArgs, deps: VerdictDeps): Promise<VerdictCliResult> {
  try {
    const token = deps.token;
    if (typeof token !== 'string' || !TOKEN.test(token)) return refuse('missing-token');
    const policy = deps.policy;
    if (
      !isRec(policy) ||
      typeof policy.repositoryFullName !== 'string' ||
      !REPO_SLUG.test(policy.repositoryFullName) ||
      typeof policy.trustedBranch !== 'string' ||
      !BRANCH.test(policy.trustedBranch) ||
      'digestContractConfirmed' in policy
    ) {
      return refuse('invalid-policy');
    }

    const plan = planBundle(args, deps);
    if (typeof plan === 'string') return refuse(plan);

    const transport = createTransport({
      token,
      repository: policy.repositoryFullName,
      branch: policy.trustedBranch,
      http: deps.http,
    });
    const request = { runId: args.runId, runAttempt: args.runAttempt };
    const collected = await collectEvidence(transport, request, policy);
    if (collected.redirectRefused) return refuse('storage-redirect-refused');

    const result = reconcileCollected(collected, policy);
    const data = serializeBundle(buildBundle(result, collected, policy));

    const written = writeBundle(plan, data, deps);
    if (written !== 'ok') return refuse(written);
    return {
      exitCode: 0,
      code: 'written',
      verdict: result.verdict.state,
      summary: result.summary.state,
    };
  } catch {
    return refuse('internal-error');
  }
}

/* ------------------------------------------------------------------ *
 * Node private-file adapter
 * ------------------------------------------------------------------ */

/** `O_NOFOLLOW` where the platform provides it; `undefined` otherwise (fail closed). */
const O_NOFOLLOW: number | undefined = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;

function errorCodeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

/**
 * Owner-only bundle creation. The create mode is `0o600` (a umask can only
 * remove bits from it) and `fchmod` then sets exactly `0o600` on the handle,
 * so a permissive umask such as 000 cannot widen it and the result does not
 * depend on the umask at all. Platforms without `O_NOFOLLOW` or `getuid`
 * fail closed.
 */
export const nodePrivateFiles: PrivateFileOps = {
  writeNewPrivate: (path, data) => {
    if (O_NOFOLLOW === undefined) return { status: 'failed' };
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
        BUNDLE_FILE_MODE,
      );
    } catch (error) {
      return { status: errorCodeOf(error) === 'EEXIST' ? 'exists' : 'failed' };
    }
    try {
      fchmodSync(fd, BUNDLE_FILE_MODE);
      const bytes = Buffer.from(data, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
      }
      fsyncSync(fd);
      const info = fstatSync(fd);
      if (!info.isFile() || (info.mode & 0o7777) !== BUNDLE_FILE_MODE) return { status: 'failed' };
      return { status: 'ok', identity: `${String(info.dev)}:${String(info.ino)}` };
    } catch {
      return { status: 'failed' };
    } finally {
      closeSync(fd);
    }
  },
  ownership: (path) => {
    try {
      const info = lstatSync(path);
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      return { mode: info.mode & 0o7777, ownedByCaller: uid !== undefined && info.uid === uid };
    } catch {
      return undefined;
    }
  },
};

/* ------------------------------------------------------------------ *
 * Node HTTP adapter
 * ------------------------------------------------------------------ */

function pickHeaders(headers: Headers): ResponseHeaders {
  return {
    location: headers.get('location'),
    rateLimitRemaining: headers.get('x-ratelimit-remaining'),
    retryAfter: headers.get('retry-after'),
  };
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: unknown }).name === 'TimeoutError' ||
      (error as { name?: unknown }).name === 'AbortError')
  );
}

/**
 * `fetch` with redirects disabled, no credentials mode, a timeout signal and
 * a streaming byte cap. Error details are discarded.
 */
export const nodeHttp: HttpAdapter = {
  get: async (request) => {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: 'GET',
        headers: request.headers,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      return { kind: 'error', error: isTimeout(error) ? 'timeout' : 'network' };
    }
    const headers = pickHeaders(response.headers);
    const status = response.status;
    try {
      if ((status >= 300 && status < 400) || response.body === null) {
        await response.body?.cancel();
        return { kind: 'response', status, headers, body: new Uint8Array(0) };
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > request.maxBytes) {
        await response.body.cancel();
        return { kind: 'error', error: 'too-large' };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > request.maxBytes) {
          await reader.cancel();
          return { kind: 'error', error: 'too-large' };
        }
        chunks.push(value);
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { kind: 'response', status, headers, body };
    } catch (error) {
      return { kind: 'error', error: isTimeout(error) ? 'timeout' : 'network' };
    }
  },
};
