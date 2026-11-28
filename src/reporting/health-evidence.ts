/**
 * Read-only README health evidence adapter (ADR-0013, Phase C5B).
 *
 *   collectHealthEvidence(transport, request, policies) -> HealthEvidenceResult
 *   assessHistory(transport, snapshotSha, candidateSha)  -> HistoryFacts
 *
 * Gathers, through an INJECTED transport, everything the C5A refresh decision
 * needs for one workflow run attempt, and validates it strictly:
 *
 * 1. Candidate eligibility from run metadata BEFORE any artifact request:
 *    repository and workflow identity (name and id), push to `main`, head
 *    repository, completed status, and attempt equal to the run's newest
 *    attempt. An ineligible run never reaches the artifact list.
 * 2. The Gate verdict and summary origin from the existing ADR-0010
 *    components (`collectEvidence` + `reconcileCollected`), which also
 *    download and digest-verify `quality-summary-<attempt>`. No verdict label
 *    from any artifact is trusted.
 * 3. `unit-results-<attempt>` and `test-health-<attempt>` from the same run
 *    only, selected with the same rules as the operator (one exact name,
 *    bound to this run id and head commit, unexpired, declared size within
 *    `MAX_ARCHIVE_BYTES`, a valid `sha256:` digest), downloaded through the
 *    same bounded transport (no token on the storage redirect, one redirect
 *    only, storage host allow-list) and accepted only when SHA-256 of the
 *    exact bytes equals the API digest. Archives are read in memory by the
 *    bounded exact-entry reader.
 * 4. The C1 health model is recomputed from the strictly parsed unit result
 *    and the verified summary, using the bundle's own recorded `generatedAt`
 *    and the run identity, and must equal the CI bundle byte for byte (JSON
 *    and Markdown).
 *
 * Output is aggregate only: run identity, fixed state and diagnostic codes,
 * and the recomputed model (counts, no titles or paths). No token, URL,
 * signed query, path, log or per-test record is ever returned, and nothing
 * is written anywhere.
 *
 * Transport gap (see ADR-0013): the existing operator transport has six
 * operations; this adapter also needs the run's newest attempt, the
 * attempt's last-job completion time and the changed files of a comparison.
 * They are declared in `HealthEvidenceTransport` and injected; no live
 * implementation is provided in C5B.
 *
 * Free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import {
  TRUST_POLICY,
  collectEvidence,
  reconcileCollected,
  sha256Digest,
  type BaseTrustPolicy,
  type GitHubTransport,
} from './verdict-cli.ts';
import type {
  ArtifactEvidence,
  Retrieved,
  RunAttemptEvidence,
  SummaryState,
  VerdictState,
} from './verdict.ts';
import type { ParsedSummary } from './dashboard-model.ts';
import { MAX_ARCHIVE_BYTES } from './zip-entry.ts';
import {
  HEALTH_BUNDLE_SPEC,
  UNIT_RESULTS_SPEC,
  readExactEntries,
  type ExactEntriesSpec,
} from './zip-entries.ts';
import { parseUnitResults } from './unit-results.ts';
import {
  healthModel,
  isIsoInstant,
  renderHealthMarkdown,
  type HealthModel,
  type UnitEvidence,
} from './test-health.ts';
import {
  REFRESH_POLICY,
  candidateProblems,
  type Ancestry,
  type CandidateEvidence,
  type CandidateRun,
  type RefreshPolicy,
  type RefreshReason,
  type SectionState,
} from './refresh-decision.ts';

/* ------------------------------------------------------------------ *
 * Transport (the operator's six operations plus three read-only ones)
 * ------------------------------------------------------------------ */

export interface ChangedFile {
  readonly filename: string;
  /** Set for `renamed` and `copied` entries. */
  readonly previousFilename: string | null;
  readonly status: string;
}

export interface ChangedFiles {
  readonly files: readonly ChangedFile[];
  /**
   * False whenever the listing may be incomplete: GitHub truncated the file
   * list, pagination did not reach the reported total, or a page cap was hit.
   */
  readonly complete: boolean;
}

export interface HealthEvidenceTransport extends GitHubTransport {
  /** The run's newest attempt (`run_attempt` of `GET /actions/runs/{id}`). */
  readonly getLatestAttempt: (runId: number) => Promise<Retrieved<number>>;
  /** Latest `completed_at` over every job of the attempt (complete pagination only). */
  readonly getAttemptCompletion: (runId: number, attempt: number) => Promise<Retrieved<string>>;
  /** Files changed between two commits (`compare/{base}...{head}`). */
  readonly listChangedFiles: (baseSha: string, headSha: string) => Promise<Retrieved<ChangedFiles>>;
}

export interface EvidencePolicies {
  readonly trust: BaseTrustPolicy;
  readonly refresh: RefreshPolicy;
}

export const EVIDENCE_POLICIES: EvidencePolicies = Object.freeze({
  trust: TRUST_POLICY,
  refresh: REFRESH_POLICY,
});

/* ------------------------------------------------------------------ *
 * Diagnostics (fixed codes only)
 * ------------------------------------------------------------------ */

type ArtifactKind = 'unit' | 'health';
type ArtifactProblem =
  | 'missing'
  | 'duplicate'
  | 'unbound'
  | 'expired'
  | 'declared-too-large'
  | 'digest-missing'
  | 'download-failed'
  | 'download-expired'
  | 'download-too-large'
  | 'digest-mismatch'
  | 'unexpected-entries'
  | 'archive-too-large'
  | 'archive-malformed';

export type EvidenceDiagnostic =
  | `${ArtifactKind}-artifact-${ArtifactProblem}`
  | 'run-metadata-unavailable'
  | 'run-identity-mismatch'
  | 'latest-attempt-unavailable'
  | 'attempt-completion-unavailable'
  | 'artifact-list-unavailable'
  | 'storage-redirect-refused'
  | 'summary-digest-mismatch'
  | 'health-bundle-json-invalid'
  | 'health-bundle-recompute-mismatch'
  | 'unit-provenance-mismatch'
  | 'playwright-provenance-mismatch';

export type HealthEvidenceResult =
  | {
      readonly status: 'ineligible';
      /** Null only when the run attempt itself could not be read. */
      readonly candidate: CandidateRun | null;
      readonly reasons: readonly RefreshReason[];
      readonly diagnostics: readonly EvidenceDiagnostic[];
    }
  | {
      readonly status: 'evaluated';
      readonly candidate: CandidateRun;
      readonly evidence: CandidateEvidence;
      readonly verification: { readonly verdict: VerdictState; readonly summary: SummaryState };
      /** Recomputed from verified inputs; never taken from the artifact. */
      readonly model: HealthModel;
      readonly diagnostics: readonly EvidenceDiagnostic[];
    };

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function posInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The candidate as the C5A decision sees it, copied without trusting types. */
function candidateOf(
  run: RunAttemptEvidence,
  latest: Retrieved<number>,
  completion: Retrieved<string>,
): CandidateRun {
  return {
    repository: str(run.repository?.fullName) ?? '',
    workflowPath: str(run.path) ?? '',
    event: str(run.event) ?? '',
    headBranch: str(run.headBranch),
    headRepository: str(run.headRepository?.fullName),
    status: str(run.status) ?? '',
    runId: posInt(run.id) ? run.id : 0,
    runAttempt: posInt(run.runAttempt) ? run.runAttempt : 0,
    latestAttempt: latest.status === 'ok' && posInt(latest.value) ? latest.value : 0,
    headSha: str(run.headSha) ?? '',
    completedAt: completion.status === 'ok' ? str(completion.value) : null,
  };
}

type Selected =
  | { readonly ok: true; readonly artifact: ArtifactEvidence }
  | { readonly ok: false; readonly problem: ArtifactProblem };

/** The operator's selection rules, applied to another artifact name. */
function select(
  artifacts: readonly ArtifactEvidence[],
  name: string,
  runId: number,
  headSha: string,
): Selected {
  const matches = artifacts.filter((a) => a.name === name);
  if (matches.length === 0) return { ok: false, problem: 'missing' };
  if (matches.length > 1) return { ok: false, problem: 'duplicate' };
  const a = matches[0] as ArtifactEvidence;
  if (!posInt(a.id) || a.workflowRun?.id !== runId || a.workflowRun.headSha !== headSha) {
    return { ok: false, problem: 'unbound' };
  }
  if (a.expired !== false) return { ok: false, problem: 'expired' };
  if (
    typeof a.sizeInBytes !== 'number' ||
    !Number.isSafeInteger(a.sizeInBytes) ||
    a.sizeInBytes < 0
  ) {
    return { ok: false, problem: 'unbound' };
  }
  if (a.sizeInBytes > MAX_ARCHIVE_BYTES) return { ok: false, problem: 'declared-too-large' };
  if (typeof a.digest !== 'string' || !DIGEST.test(a.digest)) {
    return { ok: false, problem: 'digest-missing' };
  }
  return { ok: true, artifact: a };
}

type Fetched =
  | { readonly ok: true; readonly entries: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly problem: ArtifactProblem; readonly redirectRefused: boolean };

async function fetchEntries(
  transport: GitHubTransport,
  artifact: ArtifactEvidence,
  spec: ExactEntriesSpec,
): Promise<Fetched> {
  const download = await transport.downloadArtifact(artifact.id);
  if (download.status === 'redirect-refused') {
    return { ok: false, problem: 'download-failed', redirectRefused: true };
  }
  if (download.status === 'too-large') {
    return { ok: false, problem: 'download-too-large', redirectRefused: false };
  }
  if (download.status === 'failed') {
    return {
      ok: false,
      problem: download.reason === 'expired' ? 'download-expired' : 'download-failed',
      redirectRefused: false,
    };
  }
  // Never parse bytes that are not the published artifact.
  if (sha256Digest(download.bytes) !== artifact.digest) {
    return { ok: false, problem: 'digest-mismatch', redirectRefused: false };
  }
  const read = readExactEntries(download.bytes, spec);
  if (read.status === 'ok') return { ok: true, entries: read.entries };
  const problem: ArtifactProblem =
    read.status === 'unexpected-entries'
      ? 'unexpected-entries'
      : read.status === 'too-large'
        ? 'archive-too-large'
        : 'archive-malformed';
  return { ok: false, problem, redirectRefused: false };
}

function sectionState(state: 'complete' | 'partial' | 'unavailable'): SectionState {
  return state;
}

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

/**
 * Collects and validates the evidence for one run attempt. Sequential and
 * bounded; nothing is retried, written or logged; never throws for remote
 * data (an adapter that throws is a programming error of the caller).
 */
export async function collectHealthEvidence(
  transport: HealthEvidenceTransport,
  request: { readonly runId: number; readonly runAttempt: number },
  policies: EvidencePolicies = EVIDENCE_POLICIES,
): Promise<HealthEvidenceResult> {
  if (!posInt(request.runId) || !posInt(request.runAttempt)) {
    return {
      status: 'ineligible',
      candidate: null,
      reasons: ['invalid-run-identity'],
      diagnostics: [],
    };
  }

  // 1. Metadata only. No artifact is listed or downloaded until this passes.
  const run = await transport.getRunAttempt(request.runId, request.runAttempt);
  if (run.status !== 'ok') {
    return {
      status: 'ineligible',
      candidate: null,
      reasons: ['run-metadata-unavailable'],
      diagnostics: ['run-metadata-unavailable'],
    };
  }
  const latest = await transport.getLatestAttempt(request.runId);
  const completion = await transport.getAttemptCompletion(request.runId, request.runAttempt);
  const candidate = candidateOf(run.value, latest, completion);
  const diagnostics: EvidenceDiagnostic[] = [];
  if (latest.status !== 'ok') diagnostics.push('latest-attempt-unavailable');
  if (completion.status !== 'ok') diagnostics.push('attempt-completion-unavailable');

  const reasons = candidateProblems(candidate, policies.refresh);
  if (
    run.value.repository?.id !== policies.trust.repositoryId &&
    !reasons.includes('wrong-repository')
  ) {
    reasons.push('wrong-repository');
  }
  if (run.value.workflowId !== policies.trust.workflowId && !reasons.includes('wrong-workflow')) {
    reasons.push('wrong-workflow');
  }
  if (candidate.runId !== request.runId || candidate.runAttempt !== request.runAttempt) {
    diagnostics.push('run-identity-mismatch');
    if (!reasons.includes('invalid-run-identity')) reasons.push('invalid-run-identity');
  }
  if (latest.status !== 'ok' && !reasons.includes('run-metadata-unavailable')) {
    reasons.push('run-metadata-unavailable');
  }
  if (reasons.length > 0) return { status: 'ineligible', candidate, reasons, diagnostics };

  // 2. Verdict and verified summary through the ADR-0010 operator components.
  const collected = await collectEvidence(transport, request, policies.trust);
  const verdict = reconcileCollected(collected, policies.trust);
  if (collected.redirectRefused) diagnostics.push('storage-redirect-refused');
  if (collected.digest === 'mismatch') diagnostics.push('summary-digest-mismatch');
  const summary: ParsedSummary = collected.summary ?? { state: 'no-summary' };

  // 3. The other two artifacts of the same run attempt.
  const artifacts = collected.evidence.artifacts;
  const fetchKind = async (
    kind: ArtifactKind,
    prefix: string,
    spec: ExactEntriesSpec,
  ): Promise<ReadonlyMap<string, string> | undefined> => {
    if (artifacts.status !== 'ok') return undefined;
    const chosen = select(
      artifacts.value,
      `${prefix}${String(request.runAttempt)}`,
      request.runId,
      candidate.headSha,
    );
    if (!chosen.ok) {
      diagnostics.push(`${kind}-artifact-${chosen.problem}`);
      return undefined;
    }
    const fetched = await fetchEntries(transport, chosen.artifact, spec);
    if (!fetched.ok) {
      diagnostics.push(`${kind}-artifact-${fetched.problem}`);
      if (fetched.redirectRefused && !diagnostics.includes('storage-redirect-refused')) {
        diagnostics.push('storage-redirect-refused');
      }
      return undefined;
    }
    return fetched.entries;
  };
  if (artifacts.status !== 'ok') diagnostics.push('artifact-list-unavailable');
  const unitEntries = await fetchKind('unit', 'unit-results-', UNIT_RESULTS_SPEC);
  const healthEntries = await fetchKind('health', 'test-health-', HEALTH_BUNDLE_SPEC);

  const unitText = unitEntries?.get('unit-results.stamped.json');
  const unit: UnitEvidence =
    unitText === undefined
      ? { kind: 'unavailable', reason: 'unit-results-missing' }
      : parseUnitResults(unitText);

  // 4. Recompute with the bundle's own generation time and compare bytes.
  const identity = {
    runId: request.runId,
    runAttempt: request.runAttempt,
    sourceSha: candidate.headSha,
  };
  let healthBundle: CandidateEvidence['healthBundle'] = 'unavailable';
  let generatedAt: string | undefined;
  const bundleJson = healthEntries?.get('test-health.json');
  const bundleMarkdown = healthEntries?.get('test-health.md');
  if (bundleJson !== undefined && bundleMarkdown !== undefined) {
    try {
      const parsed: unknown = JSON.parse(bundleJson);
      const recorded =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).generatedAt
          : undefined;
      if (isIsoInstant(recorded)) generatedAt = recorded;
    } catch {
      generatedAt = undefined;
    }
    if (generatedAt === undefined) {
      diagnostics.push('health-bundle-json-invalid');
      healthBundle = 'mismatch';
    }
  }
  // Without a usable bundle the model is still built (for its states), from
  // the attempt's completion time; such evidence is never publishable.
  const built = healthModel(summary, unit, {
    mode: 'ci',
    generatedAt: generatedAt ?? candidate.completedAt ?? '1970-01-01T00:00:00Z',
    ...identity,
  });
  if (!built.ok) {
    return { status: 'ineligible', candidate, reasons: ['invalid-run-identity'], diagnostics };
  }
  const model = built.model;
  if (generatedAt !== undefined) {
    const sameJson = bundleJson === `${JSON.stringify(model, null, 2)}\n`;
    const sameMarkdown = bundleMarkdown === renderHealthMarkdown(model);
    healthBundle = sameJson && sameMarkdown ? 'match' : 'mismatch';
    if (healthBundle === 'mismatch') diagnostics.push('health-bundle-recompute-mismatch');
  }

  const unitMismatch =
    model.unit.state === 'unavailable' &&
    (model.unit.reason === 'provenance-mismatch' || model.unit.reason === 'not-local-evidence');
  const playwrightMismatch =
    model.playwright.state === 'unavailable' &&
    (model.playwright.reason === 'provenance-mismatch' ||
      model.playwright.reason === 'not-local-evidence');
  if (unitMismatch) diagnostics.push('unit-provenance-mismatch');
  if (playwrightMismatch) diagnostics.push('playwright-provenance-mismatch');
  const verdictIdentity =
    verdict.identity.runId === request.runId &&
    verdict.identity.runAttempt === request.runAttempt &&
    verdict.identity.headSha === candidate.headSha;

  return {
    status: 'evaluated',
    candidate,
    evidence: {
      verdict: verdict.verdict.state,
      summary: verdict.summary.state,
      unit: sectionState(model.unit.state),
      playwright: sectionState(model.playwright.state),
      identity: unitMismatch || playwrightMismatch || !verdictIdentity ? 'mismatch' : 'match',
      healthBundle,
    },
    verification: { verdict: verdict.verdict.state, summary: verdict.summary.state },
    model,
    diagnostics,
  };
}

/* ------------------------------------------------------------------ *
 * History: ancestry and both changed-path lists
 * ------------------------------------------------------------------ */

export type HistoryDiagnostic =
  | 'main-tip-unavailable'
  | 'snapshot-comparison-unavailable'
  | 'main-comparison-unavailable'
  | 'changes-since-snapshot-incomplete'
  | 'changes-since-candidate-incomplete';

export interface HistoryFacts {
  readonly mainTip: string | null;
  readonly candidateVsSnapshot: Ancestry;
  readonly candidateVsMain: Ancestry;
  readonly changesSinceSnapshotSource: readonly string[] | null;
  readonly changesSinceCandidateSource: readonly string[] | null;
  readonly diagnostics: readonly HistoryDiagnostic[];
}

const KNOWN_FILE_STATUSES = new Set([
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
  'unchanged',
]);

/**
 * Paths of a comparison, or `null` (unknown) whenever the list may be
 * incomplete or contains anything not understood. Renames and copies
 * contribute both paths. Paths are not trusted: `classifyPath` treats any
 * unusual path as unknown impact.
 */
export function changedPaths(listing: Retrieved<ChangedFiles>): string[] | null {
  if (listing.status !== 'ok' || listing.value.complete !== true) return null;
  const files: unknown = listing.value.files;
  if (!Array.isArray(files)) return null;
  const paths = new Set<string>();
  for (const raw of files as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return null;
    const file = raw as Record<string, unknown>;
    const { filename, status, previousFilename } = file;
    if (typeof filename !== 'string' || typeof status !== 'string') return null;
    if (!KNOWN_FILE_STATUSES.has(status)) return null;
    paths.add(filename);
    if (status === 'renamed' || status === 'copied') {
      if (typeof previousFilename !== 'string') return null;
      paths.add(previousFilename);
    }
  }
  return [...paths].sort();
}

/**
 * Relation of `candidate` to `other` from the operator's comparison of
 * `{evaluated}...{tip}`, oriented so the result describes the candidate.
 */
async function relation(
  transport: GitHubTransport,
  candidate: string,
  other: string,
  candidateIsEvaluated: boolean,
): Promise<Ancestry> {
  if (candidate === other) return 'same';
  const compared = candidateIsEvaluated
    ? await transport.compare(candidate, other)
    : await transport.compare(other, candidate);
  if (compared.status !== 'ok') return 'unknown';
  switch (compared.value.relation) {
    case 'identical':
      return 'same';
    case 'head-is-ancestor': // the evaluated commit is an ancestor of the tip
      return candidateIsEvaluated ? 'ancestor' : 'descendant';
    case 'head-ahead': // the evaluated commit is ahead of the tip
      return candidateIsEvaluated ? 'descendant' : 'ancestor';
    case 'diverged':
      return 'diverged';
    default:
      return 'unknown';
  }
}

/** Both ancestry relations and both changed-path lists (ADR-0013 rule 4). */
export async function assessHistory(
  transport: HealthEvidenceTransport,
  snapshotSha: string,
  candidateSha: string,
): Promise<HistoryFacts> {
  const diagnostics: HistoryDiagnostic[] = [];
  if (!SHA.test(snapshotSha) || !SHA.test(candidateSha)) {
    return {
      mainTip: null,
      candidateVsSnapshot: 'unknown',
      candidateVsMain: 'unknown',
      changesSinceSnapshotSource: null,
      changesSinceCandidateSource: null,
      diagnostics: ['snapshot-comparison-unavailable', 'main-comparison-unavailable'],
    };
  }
  const tip = await transport.resolveBranchTip();
  const mainTip = tip.status === 'ok' && SHA.test(tip.value) ? tip.value : null;
  if (mainTip === null) diagnostics.push('main-tip-unavailable');

  const candidateVsSnapshot = await relation(transport, candidateSha, snapshotSha, false);
  if (candidateVsSnapshot === 'unknown') diagnostics.push('snapshot-comparison-unavailable');
  const candidateVsMain =
    mainTip === null ? 'unknown' : await relation(transport, candidateSha, mainTip, true);
  if (mainTip !== null && candidateVsMain === 'unknown') {
    diagnostics.push('main-comparison-unavailable');
  }

  let sinceSnapshot: string[] | null = null;
  if (candidateVsSnapshot === 'same') sinceSnapshot = [];
  else if (candidateVsSnapshot === 'descendant') {
    sinceSnapshot = changedPaths(await transport.listChangedFiles(snapshotSha, candidateSha));
    if (sinceSnapshot === null) diagnostics.push('changes-since-snapshot-incomplete');
  }
  let sinceCandidate: string[] | null = null;
  if (candidateVsMain === 'same') sinceCandidate = [];
  else if (candidateVsMain === 'ancestor' && mainTip !== null) {
    sinceCandidate = changedPaths(await transport.listChangedFiles(candidateSha, mainTip));
    if (sinceCandidate === null) diagnostics.push('changes-since-candidate-incomplete');
  }
  return {
    mainTip,
    candidateVsSnapshot,
    candidateVsMain,
    changesSinceSnapshotSource: sinceSnapshot,
    changesSinceCandidateSource: sinceCandidate,
    diagnostics,
  };
}
