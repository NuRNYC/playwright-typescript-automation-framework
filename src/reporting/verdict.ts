/**
 * Quality verdict reconciliation (ADR-0010, M8E-3). Pure.
 *
 *   reconcile(summary, evidence, policy) -> VerdictResult
 *
 * Decides, for ONE workflow run attempt, two independent things:
 *
 * 1. the Gate verdict, from run-attempt, jobs and main-ancestry evidence only;
 * 2. whether a quality summary may be shown, and with which label.
 *
 * Inputs are plain values that a future transport (M8E-4) will build from
 * read-only GitHub API responses, plus the summary already parsed by
 * `parseSummary`. Every evidence field is validated again here; anything
 * malformed counts as not retrieved. The result is built field by field from
 * validated values and fixed reason codes: it never contains API error text,
 * branch names, URLs, titles or any unvalidated input.
 *
 * Precedence follows amended ADR-0010 (2026-11-26). Gate verdict, first match
 * wins:
 *
 *    1 CONFLICT              established identity contradiction (retrieved evidence)
 *    2 UNTRUSTED_PROVENANCE  confirmed untrusted origin (retrieved evidence)
 *    3 UNKNOWN               required evidence not retrieved
 *    4 PENDING               run attempt not completed
 *    5 CANCELLED             run attempt or test job cancelled
 *    6 CONFLICT              completed evidence contradicts itself
 *    7 VERIFIED_PASS         one test job and one Gate step, both success
 *    8 VERIFIED_FAIL         the Gate step completed with failure
 *    9 EXECUTION_FAILED      the job or run failed and no Gate step completed
 *   10 UNKNOWN               anything else
 *
 * Summary state, first match wins: SUMMARY_CONFLICT, SUMMARY_UNKNOWN,
 * SUMMARY_UNAVAILABLE, SUMMARY_INVALID, SUMMARY_INFORMATIVE,
 * SUMMARY_VERIFIED_ORIGIN. The summary never changes the verdict.
 *
 * No filesystem, environment, network, clock or randomness. Only type imports
 * and constants from pure modules, so Node's type-stripping test runner can
 * load it directly (ADR-0002).
 */
import type { ParsedSummary } from './dashboard-model.ts';
import { GATE_INPUT_NAMES } from './quality-summary.ts';

/* ------------------------------------------------------------------ *
 * States and reason codes
 * ------------------------------------------------------------------ */

export const VERDICT_STATES = [
  'VERIFIED_PASS',
  'VERIFIED_FAIL',
  'EXECUTION_FAILED',
  'CANCELLED',
  'PENDING',
  'UNTRUSTED_PROVENANCE',
  'CONFLICT',
  'UNKNOWN',
] as const;
export type VerdictState = (typeof VERDICT_STATES)[number];

export const SUMMARY_STATES = [
  'SUMMARY_UNKNOWN',
  'SUMMARY_UNAVAILABLE',
  'SUMMARY_CONFLICT',
  'SUMMARY_INVALID',
  'SUMMARY_INFORMATIVE',
  'SUMMARY_VERIFIED_ORIGIN',
] as const;
export type SummaryState = (typeof SUMMARY_STATES)[number];

/** Why a response is unusable. Supplied by the transport; never free text. */
export const RETRIEVAL_FAILURES = [
  'http-error',
  'not-found',
  'permission',
  'rate-limited',
  'timeout',
  'malformed',
  'incomplete-pagination',
] as const;
export type RetrievalFailure = (typeof RETRIEVAL_FAILURES)[number];

/** Evidence sources whose retrieval can fail. */
type Source = 'run' | 'jobs' | 'ancestry' | 'artifacts' | 'archive';

/** Every reason code the reconciler can emit. Fixed; never derived from input values. */
export type ReasonCode =
  | 'invalid-request'
  | 'invalid-policy'
  | `retrieval-${Source}-${RetrievalFailure}`
  | 'identity-run-id-mismatch'
  | 'identity-attempt-mismatch'
  | 'identity-job-attempt-mismatch'
  | 'identity-job-sha-mismatch'
  | 'identity-ancestry-sha-mismatch'
  | 'identity-duplicate-test-job'
  | 'identity-duplicate-gate-step'
  | 'provenance-event'
  | 'provenance-branch'
  | 'provenance-repository'
  | 'provenance-head-repository'
  | 'provenance-workflow-id'
  | 'provenance-workflow-path'
  | 'provenance-workflow-name'
  | 'provenance-head-ahead-of-main'
  | 'provenance-diverged-from-main'
  | 'run-not-completed'
  | 'run-cancelled'
  | 'job-cancelled'
  | 'outcome-job-not-completed'
  | 'outcome-gate-success-job-not-success'
  | 'outcome-gate-failure-job-success'
  | 'outcome-run-success-job-not-success'
  | 'gate-success'
  | 'gate-failure'
  | 'job-failed-before-gate'
  | 'run-failed-without-test-job'
  | 'no-test-job'
  | 'gate-not-decisive'
  | 'unmapped-conclusion'
  | 'artifact-duplicate'
  | 'artifact-run-mismatch'
  | 'artifact-repository-mismatch'
  | 'artifact-head-repository-mismatch'
  | 'artifact-sha-mismatch'
  | 'artifact-created-outside-attempt'
  | 'artifact-id-mismatch'
  | 'digest-mismatch'
  | 'summary-run-mismatch'
  | 'summary-attempt-mismatch'
  | 'summary-event-mismatch'
  | 'summary-sha-mismatch'
  | 'observed-inputs-contradict-gate'
  | 'binding-run-attempt-unavailable'
  | 'artifact-absent'
  | 'artifact-expired'
  | 'archive-not-downloaded'
  | 'archive-unexpected-entries'
  | 'archive-too-large'
  | 'summary-missing'
  | 'summary-invalid'
  | 'summary-schema-mismatch'
  | 'verdict-not-trusted'
  | 'digest-contract-unconfirmed'
  | 'verified-origin';

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** A response that was obtained, or a fixed reason why it was not. */
export type Retrieved<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'failed'; readonly reason: RetrievalFailure };

/** Get workflow run attempt (transport-normalized). */
export interface RunAttemptEvidence {
  readonly id: number;
  readonly runAttempt: number;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly headSha: string;
  readonly headBranch: string | null;
  readonly workflowId: number;
  readonly path: string;
  readonly name: string;
  readonly repository: { readonly id: number; readonly fullName: string };
  readonly headRepository: { readonly fullName: string } | null;
  readonly runStartedAt: string;
  readonly updatedAt: string;
}

export interface StepEvidence {
  readonly number: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** One entry of "list jobs for a workflow run attempt". */
export interface JobEvidence {
  readonly id: number;
  readonly name: string;
  readonly runAttempt: number;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly steps: readonly StepEvidence[];
}

/**
 * Main-branch ancestry, already interpreted by the transport from a commit
 * comparison of the evaluated head commit with a resolved `main` tip.
 * `identical` and `head-is-ancestor` are the only accepted proofs.
 */
export interface AncestryEvidence {
  readonly evaluatedSha: string;
  readonly mainTipSha: string;
  readonly relation: 'identical' | 'head-is-ancestor' | 'head-ahead' | 'diverged';
}

/** One entry of "list workflow run artifacts". */
export interface ArtifactEvidence {
  readonly id: number;
  readonly name: string;
  readonly sizeInBytes: number;
  readonly digest: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly workflowRun: {
    readonly id: number;
    readonly repositoryId: number;
    readonly headRepositoryId: number;
    readonly headSha: string;
  };
}

/**
 * The archive download of the selected artifact. The transport computes the
 * SHA-256 over the exact downloaded bytes and reports only whether it matches
 * the artifact's `digest`; it also reports whether the archive held exactly
 * one `quality-summary.json` within the size limit.
 */
export type ArchiveEvidence =
  | { readonly status: 'not-attempted' }
  | { readonly status: 'failed'; readonly reason: RetrievalFailure | 'expired' }
  | {
      readonly status: 'downloaded';
      readonly artifactId: number;
      readonly digestCheck: 'match' | 'mismatch';
      readonly contents: 'single-summary' | 'unexpected-entries' | 'too-large';
    };

export interface VerdictEvidence {
  /** The run attempt being evaluated. Evidence must not come from any other attempt. */
  readonly request: { readonly runId: number; readonly runAttempt: number };
  readonly run: Retrieved<RunAttemptEvidence>;
  readonly jobs: Retrieved<readonly JobEvidence[]>;
  readonly ancestry: Retrieved<AncestryEvidence>;
  readonly artifacts: Retrieved<readonly ArtifactEvidence[]>;
  readonly archive: ArchiveEvidence;
}

/** The expected identity of the trusted pipeline. Explicit; no defaults are assumed. */
export interface TrustPolicy {
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly workflowName: string;
  readonly trustedEvent: 'push';
  readonly trustedBranch: string;
  readonly testJobName: string;
  readonly gateStepName: string;
  readonly artifactNamePrefix: string;
  /** False until M8E-4 confirms the digest byte contract; caps metrics at "unverified origin". */
  readonly digestContractConfirmed: boolean;
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

export interface VerdictResult {
  readonly verdict: { readonly state: VerdictState; readonly reasons: readonly ReasonCode[] };
  readonly summary: {
    readonly state: SummaryState;
    readonly reasons: readonly ReasonCode[];
    readonly metricsAvailable: boolean;
    readonly label: 'verified-origin' | 'unverified-origin' | null;
  };
  /** Validated identity only: integers, the 40-hex head SHA and the event class. */
  readonly identity: {
    readonly runId: number | null;
    readonly runAttempt: number | null;
    readonly headSha: string | null;
    readonly event: 'push' | 'pull_request' | 'other' | null;
    readonly testJobId: number | null;
    readonly artifactId: number | null;
  };
}

/* ------------------------------------------------------------------ *
 * Validation (evidence is untrusted even when typed)
 * ------------------------------------------------------------------ */

const SHA = /^[0-9a-f]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const WORD = /^[a-z][a-z_]{0,31}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_TEXT = 255;

type Rec = Readonly<Record<string, unknown>>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function posInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;
}
function word(value: unknown): value is string {
  return typeof value === 'string' && WORD.test(value);
}
function wordOrNull(value: unknown): value is string | null {
  return value === null || word(value);
}
function sha(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}
function time(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
}
function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Validated copy, or undefined when anything is malformed. Unknown fields are dropped. */
function validRun(v: unknown): RunAttemptEvidence | undefined {
  if (!isRec(v) || !isRec(v.repository)) return undefined;
  const repo = v.repository;
  const head = v.headRepository;
  if (
    !posInt(v.id) ||
    !posInt(v.runAttempt) ||
    !text(v.event) ||
    !word(v.status) ||
    !wordOrNull(v.conclusion) ||
    !sha(v.headSha) ||
    !(v.headBranch === null || text(v.headBranch)) ||
    !posInt(v.workflowId) ||
    !text(v.path) ||
    !text(v.name) ||
    !posInt(repo.id) ||
    !text(repo.fullName) ||
    !(head === null || (isRec(head) && text(head.fullName))) ||
    !time(v.runStartedAt) ||
    !time(v.updatedAt)
  ) {
    return undefined;
  }
  return {
    id: v.id,
    runAttempt: v.runAttempt,
    event: v.event,
    status: v.status,
    conclusion: v.conclusion,
    headSha: v.headSha,
    headBranch: v.headBranch,
    workflowId: v.workflowId,
    path: v.path,
    name: v.name,
    repository: { id: repo.id, fullName: repo.fullName },
    headRepository: head === null ? null : { fullName: (head as { fullName: string }).fullName },
    runStartedAt: v.runStartedAt,
    updatedAt: v.updatedAt,
  };
}

function validStep(v: unknown): StepEvidence | undefined {
  if (
    !isRec(v) ||
    !posInt(v.number) ||
    !text(v.name) ||
    !word(v.status) ||
    !wordOrNull(v.conclusion)
  ) {
    return undefined;
  }
  return { number: v.number, name: v.name, status: v.status, conclusion: v.conclusion };
}

function validJobs(v: unknown): JobEvidence[] | undefined {
  if (!Array.isArray(v) || v.length > 1000) return undefined;
  const jobs: JobEvidence[] = [];
  for (const j of v as unknown[]) {
    if (
      !isRec(j) ||
      !posInt(j.id) ||
      !text(j.name) ||
      !posInt(j.runAttempt) ||
      !sha(j.headSha) ||
      !word(j.status) ||
      !wordOrNull(j.conclusion) ||
      !Array.isArray(j.steps) ||
      j.steps.length > 1000
    ) {
      return undefined;
    }
    const steps: StepEvidence[] = [];
    for (const s of j.steps as unknown[]) {
      const step = validStep(s);
      if (step === undefined) return undefined;
      steps.push(step);
    }
    jobs.push({
      id: j.id,
      name: j.name,
      runAttempt: j.runAttempt,
      headSha: j.headSha,
      status: j.status,
      conclusion: j.conclusion,
      steps,
    });
  }
  return jobs;
}

const RELATIONS = ['identical', 'head-is-ancestor', 'head-ahead', 'diverged'] as const;

function validAncestry(v: unknown): AncestryEvidence | undefined {
  if (!isRec(v) || !sha(v.evaluatedSha) || !sha(v.mainTipSha) || !oneOf(RELATIONS, v.relation)) {
    return undefined;
  }
  // "identical" must actually mean the same commit.
  if ((v.relation === 'identical') !== (v.evaluatedSha === v.mainTipSha)) {
    return undefined;
  }
  return { evaluatedSha: v.evaluatedSha, mainTipSha: v.mainTipSha, relation: v.relation };
}

function validArtifacts(v: unknown): ArtifactEvidence[] | undefined {
  if (!Array.isArray(v) || v.length > 1000) return undefined;
  const list: ArtifactEvidence[] = [];
  for (const a of v as unknown[]) {
    if (!isRec(a) || !isRec(a.workflowRun)) return undefined;
    const run = a.workflowRun;
    if (
      !posInt(a.id) ||
      !text(a.name) ||
      typeof a.sizeInBytes !== 'number' ||
      !Number.isSafeInteger(a.sizeInBytes) ||
      a.sizeInBytes < 0 ||
      !(a.digest === null || (typeof a.digest === 'string' && DIGEST.test(a.digest))) ||
      !time(a.createdAt) ||
      !time(a.expiresAt) ||
      typeof a.expired !== 'boolean' ||
      !posInt(run.id) ||
      !posInt(run.repositoryId) ||
      !posInt(run.headRepositoryId) ||
      !sha(run.headSha)
    ) {
      return undefined;
    }
    list.push({
      id: a.id,
      name: a.name,
      sizeInBytes: a.sizeInBytes,
      digest: a.digest,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      expired: a.expired,
      workflowRun: {
        id: run.id,
        repositoryId: run.repositoryId,
        headRepositoryId: run.headRepositoryId,
        headSha: run.headSha,
      },
    });
  }
  return list;
}

type Got<T> = { ok: true; value: T } | { ok: false; reason: RetrievalFailure };

/** A retrieved response is usable only if it validates; otherwise it counts as malformed. */
function take<T>(r: unknown, validate: (value: unknown) => T | undefined): Got<T> {
  if (isRec(r) && r.status === 'ok') {
    const value = validate(r.value);
    return value === undefined ? { ok: false, reason: 'malformed' } : { ok: true, value };
  }
  if (isRec(r) && r.status === 'failed' && oneOf(RETRIEVAL_FAILURES, r.reason)) {
    return { ok: false, reason: r.reason };
  }
  return { ok: false, reason: 'malformed' };
}

function validPolicy(p: unknown): TrustPolicy | undefined {
  if (
    !isRec(p) ||
    !posInt(p.repositoryId) ||
    !text(p.repositoryFullName) ||
    !posInt(p.workflowId) ||
    !text(p.workflowPath) ||
    !text(p.workflowName) ||
    p.trustedEvent !== 'push' ||
    !text(p.trustedBranch) ||
    !text(p.testJobName) ||
    !text(p.gateStepName) ||
    !text(p.artifactNamePrefix) ||
    typeof p.digestContractConfirmed !== 'boolean'
  ) {
    return undefined;
  }
  return {
    repositoryId: p.repositoryId,
    repositoryFullName: p.repositoryFullName,
    workflowId: p.workflowId,
    workflowPath: p.workflowPath,
    workflowName: p.workflowName,
    trustedEvent: 'push',
    trustedBranch: p.trustedBranch,
    testJobName: p.testJobName,
    gateStepName: p.gateStepName,
    artifactNamePrefix: p.artifactNamePrefix,
    digestContractConfirmed: p.digestContractConfirmed,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function sorted(codes: Iterable<ReasonCode>): ReasonCode[] {
  return [...new Set(codes)].sort();
}

function eventClass(event: string): 'push' | 'pull_request' | 'other' {
  return event === 'push' || event === 'pull_request' ? event : 'other';
}

function isGateSuccess(step: StepEvidence | undefined): boolean {
  return step?.status === 'completed' && step.conclusion === 'success';
}
function isGateFailure(step: StepEvidence | undefined): boolean {
  return step?.status === 'completed' && step.conclusion === 'failure';
}

const TRUSTED_COMPLETED: readonly VerdictState[] = [
  'VERIFIED_PASS',
  'VERIFIED_FAIL',
  'EXECUTION_FAILED',
  'CANCELLED',
];

interface Context {
  readonly policy: TrustPolicy;
  readonly request: { readonly runId: number; readonly runAttempt: number };
  readonly run: Got<RunAttemptEvidence>;
  readonly jobs: Got<JobEvidence[]>;
  readonly ancestry: Got<AncestryEvidence>;
  readonly testJob: JobEvidence | undefined;
  readonly gate: StepEvidence | undefined;
}

/* ------------------------------------------------------------------ *
 * Gate verdict
 * ------------------------------------------------------------------ */

function decideVerdict(c: Context): { state: VerdictState; reasons: ReasonCode[] } {
  const { policy, request, run, jobs, ancestry } = c;

  // 1. Established identity contradictions, from retrieved evidence only.
  const conflicts = new Set<ReasonCode>();
  if (run.ok) {
    if (run.value.id !== request.runId) conflicts.add('identity-run-id-mismatch');
    if (run.value.runAttempt !== request.runAttempt) conflicts.add('identity-attempt-mismatch');
  }
  if (jobs.ok) {
    const shas = new Set(jobs.value.map((j) => j.headSha));
    for (const job of jobs.value) {
      if (job.runAttempt !== request.runAttempt) conflicts.add('identity-job-attempt-mismatch');
      if (run.ok && job.headSha !== run.value.headSha) conflicts.add('identity-job-sha-mismatch');
    }
    if (shas.size > 1) conflicts.add('identity-job-sha-mismatch');
    const testJobs = jobs.value.filter((j) => j.name === policy.testJobName);
    if (testJobs.length > 1) conflicts.add('identity-duplicate-test-job');
    for (const job of testJobs) {
      if (job.steps.filter((s) => s.name === policy.gateStepName).length > 1) {
        conflicts.add('identity-duplicate-gate-step');
      }
    }
  }
  if (run.ok && ancestry.ok && ancestry.value.evaluatedSha !== run.value.headSha) {
    conflicts.add('identity-ancestry-sha-mismatch');
  }
  if (conflicts.size > 0) return { state: 'CONFLICT', reasons: sorted(conflicts) };

  // 2. Confirmed untrusted origin, from retrieved evidence only.
  const untrusted = new Set<ReasonCode>();
  if (run.ok) {
    const r = run.value;
    if (r.event !== policy.trustedEvent) untrusted.add('provenance-event');
    if (r.headBranch !== policy.trustedBranch) untrusted.add('provenance-branch');
    if (
      r.repository.id !== policy.repositoryId ||
      r.repository.fullName !== policy.repositoryFullName
    ) {
      untrusted.add('provenance-repository');
    }
    if (r.headRepository?.fullName !== policy.repositoryFullName) {
      untrusted.add('provenance-head-repository');
    }
    if (r.workflowId !== policy.workflowId) untrusted.add('provenance-workflow-id');
    if (r.path !== policy.workflowPath) untrusted.add('provenance-workflow-path');
    if (r.name !== policy.workflowName) untrusted.add('provenance-workflow-name');
  }
  if (ancestry.ok) {
    if (ancestry.value.relation === 'head-ahead') untrusted.add('provenance-head-ahead-of-main');
    if (ancestry.value.relation === 'diverged') untrusted.add('provenance-diverged-from-main');
  }
  if (untrusted.size > 0) return { state: 'UNTRUSTED_PROVENANCE', reasons: sorted(untrusted) };

  // 3. Missing evidence. Never negative evidence, never a verified result.
  const missing = new Set<ReasonCode>();
  if (!run.ok) missing.add(`retrieval-run-${run.reason}`);
  if (!jobs.ok) missing.add(`retrieval-jobs-${jobs.reason}`);
  if (!ancestry.ok) missing.add(`retrieval-ancestry-${ancestry.reason}`);
  if (!run.ok || !jobs.ok || !ancestry.ok) return { state: 'UNKNOWN', reasons: sorted(missing) };

  const r = run.value;
  const job = c.testJob;
  const gate = c.gate;

  // 4. Pending.
  if (r.status !== 'completed') return { state: 'PENDING', reasons: ['run-not-completed'] };

  // 5. Cancelled, even if a Gate executed during cancellation.
  if (r.conclusion === 'cancelled' || job?.conclusion === 'cancelled') {
    const reasons: ReasonCode[] = [];
    if (r.conclusion === 'cancelled') reasons.push('run-cancelled');
    if (job?.conclusion === 'cancelled') reasons.push('job-cancelled');
    return { state: 'CANCELLED', reasons: sorted(reasons) };
  }

  // 6. Completed evidence contradicting itself.
  const outcome = new Set<ReasonCode>();
  if (job !== undefined && job.status !== 'completed') outcome.add('outcome-job-not-completed');
  if (job !== undefined && isGateSuccess(gate) && job.conclusion !== 'success') {
    outcome.add('outcome-gate-success-job-not-success');
  }
  if (job !== undefined && isGateFailure(gate) && job.conclusion === 'success') {
    outcome.add('outcome-gate-failure-job-success');
  }
  if (job !== undefined && r.conclusion === 'success' && job.conclusion !== 'success') {
    outcome.add('outcome-run-success-job-not-success');
  }
  if (outcome.size > 0) return { state: 'CONFLICT', reasons: sorted(outcome) };

  // 7. Verified pass.
  if (job?.conclusion === 'success' && isGateSuccess(gate) && r.conclusion === 'success') {
    return { state: 'VERIFIED_PASS', reasons: ['gate-success'] };
  }

  // 8. Verified fail: only through a completed, failed Gate.
  if (job !== undefined && isGateFailure(gate)) {
    return { state: 'VERIFIED_FAIL', reasons: ['gate-failure'] };
  }

  // 9. The pipeline failed before reaching a verdict.
  const gateCompleted = isGateSuccess(gate) || isGateFailure(gate);
  if (
    job !== undefined &&
    (job.conclusion === 'failure' || job.conclusion === 'timed_out') &&
    !gateCompleted
  ) {
    return { state: 'EXECUTION_FAILED', reasons: ['job-failed-before-gate'] };
  }
  if (
    job === undefined &&
    (r.conclusion === 'failure' ||
      r.conclusion === 'timed_out' ||
      r.conclusion === 'startup_failure')
  ) {
    return { state: 'EXECUTION_FAILED', reasons: ['run-failed-without-test-job'] };
  }

  // 10. Anything else.
  if (job === undefined) return { state: 'UNKNOWN', reasons: ['no-test-job'] };
  if (gate === undefined || !gateCompleted)
    return { state: 'UNKNOWN', reasons: ['gate-not-decisive'] };
  return { state: 'UNKNOWN', reasons: ['unmapped-conclusion'] };
}

/* ------------------------------------------------------------------ *
 * Summary availability and integrity
 * ------------------------------------------------------------------ */

function decideSummary(
  c: Context,
  verdict: VerdictState,
  artifacts: Got<ArtifactEvidence[]>,
  archive: ArchiveEvidence,
  summary: ParsedSummary | null,
): { state: SummaryState; reasons: ReasonCode[]; artifactId: number | null } {
  const { policy, request, run } = c;
  const expectedName = `${policy.artifactNamePrefix}${String(request.runAttempt)}`;
  const candidates = artifacts.ok ? artifacts.value.filter((a) => a.name === expectedName) : [];
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  const valid =
    summary !== null && summary.state === 'valid' ? summary.validated.summary : undefined;
  const downloaded = archive.status === 'downloaded' ? archive : undefined;

  // 1. Established integrity contradictions.
  const conflicts = new Set<ReasonCode>();
  if (candidates.length > 1) conflicts.add('artifact-duplicate');
  if (candidate !== undefined) {
    const wr = candidate.workflowRun;
    if (wr.id !== request.runId) conflicts.add('artifact-run-mismatch');
    if (wr.repositoryId !== policy.repositoryId) conflicts.add('artifact-repository-mismatch');
    if (wr.headRepositoryId !== policy.repositoryId)
      conflicts.add('artifact-head-repository-mismatch');
    if (run.ok) {
      if (wr.headSha !== run.value.headSha) conflicts.add('artifact-sha-mismatch');
      const created = Date.parse(candidate.createdAt);
      if (
        created < Date.parse(run.value.runStartedAt) ||
        created > Date.parse(run.value.updatedAt)
      ) {
        conflicts.add('artifact-created-outside-attempt');
      }
    }
    if (downloaded !== undefined && downloaded.artifactId !== candidate.id) {
      conflicts.add('artifact-id-mismatch');
    }
  }
  if (downloaded !== undefined && downloaded.digestCheck === 'mismatch')
    conflicts.add('digest-mismatch');
  if (valid !== undefined) {
    if (valid.run.runId !== request.runId) conflicts.add('summary-run-mismatch');
    if (valid.run.runAttempt !== request.runAttempt) conflicts.add('summary-attempt-mismatch');
    if (run.ok) {
      if (valid.run.event !== eventClass(run.value.event)) conflicts.add('summary-event-mismatch');
      if (valid.run.headSha !== run.value.headSha) conflicts.add('summary-sha-mismatch');
    }
    const allSuccess = GATE_INPUT_NAMES.every((n) => valid.observedGateInputs[n] === 'success');
    if (
      (verdict === 'VERIFIED_PASS' && !allSuccess) ||
      (verdict === 'VERIFIED_FAIL' && allSuccess)
    ) {
      conflicts.add('observed-inputs-contradict-gate');
    }
  }
  const artifactId = candidate?.id ?? null;
  if (conflicts.size > 0)
    return { state: 'SUMMARY_CONFLICT', reasons: sorted(conflicts), artifactId };

  // 2. Retrieval failures.
  if (!artifacts.ok) {
    return {
      state: 'SUMMARY_UNKNOWN',
      reasons: [`retrieval-artifacts-${artifacts.reason}`],
      artifactId,
    };
  }
  if (archive.status === 'failed' && archive.reason !== 'expired') {
    return {
      state: 'SUMMARY_UNKNOWN',
      reasons: [`retrieval-archive-${archive.reason}`],
      artifactId,
    };
  }

  // 3. Unavailable: never zero metrics.
  if (candidate === undefined)
    return { state: 'SUMMARY_UNAVAILABLE', reasons: ['artifact-absent'], artifactId };
  if (candidate.expired || (archive.status === 'failed' && archive.reason === 'expired')) {
    return { state: 'SUMMARY_UNAVAILABLE', reasons: ['artifact-expired'], artifactId };
  }
  if (downloaded === undefined) {
    return { state: 'SUMMARY_UNAVAILABLE', reasons: ['archive-not-downloaded'], artifactId };
  }

  // Binding needs the run attempt (SHA and creation window); without it the
  // summary cannot be shown as bound.
  if (!run.ok) {
    return { state: 'SUMMARY_UNKNOWN', reasons: ['binding-run-attempt-unavailable'], artifactId };
  }

  // 4. Invalid archive or summary.
  if (downloaded.contents === 'unexpected-entries') {
    return { state: 'SUMMARY_INVALID', reasons: ['archive-unexpected-entries'], artifactId };
  }
  if (downloaded.contents === 'too-large') {
    return { state: 'SUMMARY_INVALID', reasons: ['archive-too-large'], artifactId };
  }
  if (summary === null || summary.state === 'no-summary') {
    return { state: 'SUMMARY_INVALID', reasons: ['summary-missing'], artifactId };
  }
  if (summary.state === 'schema-mismatch') {
    return { state: 'SUMMARY_INVALID', reasons: ['summary-schema-mismatch'], artifactId };
  }
  if (valid === undefined)
    return { state: 'SUMMARY_INVALID', reasons: ['summary-invalid'], artifactId };

  // 5. Valid and bound, but the origin is not established as trusted.
  const informative: ReasonCode[] = [];
  if (!TRUSTED_COMPLETED.includes(verdict)) informative.push('verdict-not-trusted');
  if (!policy.digestContractConfirmed) informative.push('digest-contract-unconfirmed');
  if (informative.length > 0) {
    return { state: 'SUMMARY_INFORMATIVE', reasons: sorted(informative), artifactId };
  }

  // 6. Verified origin.
  return { state: 'SUMMARY_VERIFIED_ORIGIN', reasons: ['verified-origin'], artifactId };
}

/* ------------------------------------------------------------------ *
 * reconcile
 * ------------------------------------------------------------------ */

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function invalidInput(reason: 'invalid-request' | 'invalid-policy'): VerdictResult {
  return deepFreeze({
    verdict: { state: 'UNKNOWN', reasons: [reason] },
    summary: { state: 'SUMMARY_UNKNOWN', reasons: [reason], metricsAvailable: false, label: null },
    identity: {
      runId: null,
      runAttempt: null,
      headSha: null,
      event: null,
      testJobId: null,
      artifactId: null,
    },
  });
}

/**
 * Reconciles one run attempt. Pure and deterministic: equal inputs give
 * deep-equal, frozen results; inputs are never mutated.
 */
export function reconcile(
  summary: ParsedSummary | null,
  evidence: VerdictEvidence,
  policy: TrustPolicy,
): VerdictResult {
  const validatedPolicy = validPolicy(policy);
  if (validatedPolicy === undefined) return invalidInput('invalid-policy');
  const request = isRec(evidence) && isRec(evidence.request) ? evidence.request : undefined;
  if (request === undefined || !posInt(request.runId) || !posInt(request.runAttempt)) {
    return invalidInput('invalid-request');
  }

  const run = take(evidence.run, validRun);
  const jobs = take(evidence.jobs, validJobs);
  const ancestry = take(evidence.ancestry, validAncestry);
  const artifacts = take(evidence.artifacts, validArtifacts);
  const archive = validArchive(evidence.archive);

  const testJobs = jobs.ok ? jobs.value.filter((j) => j.name === validatedPolicy.testJobName) : [];
  const testJob = testJobs.length === 1 ? testJobs[0] : undefined;
  const gates = testJob?.steps.filter((s) => s.name === validatedPolicy.gateStepName) ?? [];
  const context: Context = {
    policy: validatedPolicy,
    request: { runId: request.runId, runAttempt: request.runAttempt },
    run,
    jobs,
    ancestry,
    testJob,
    gate: gates.length === 1 ? gates[0] : undefined,
  };

  const verdict = decideVerdict(context);
  const summaryResult = decideSummary(context, verdict.state, artifacts, archive, summary);
  const metricsAvailable =
    (summaryResult.state === 'SUMMARY_VERIFIED_ORIGIN' ||
      summaryResult.state === 'SUMMARY_INFORMATIVE') &&
    summary !== null &&
    summary.state === 'valid' &&
    summary.validated.summary.testData.state === 'available';

  return deepFreeze({
    verdict: { state: verdict.state, reasons: verdict.reasons },
    summary: {
      state: summaryResult.state,
      reasons: summaryResult.reasons,
      metricsAvailable,
      label:
        summaryResult.state === 'SUMMARY_VERIFIED_ORIGIN'
          ? 'verified-origin'
          : summaryResult.state === 'SUMMARY_INFORMATIVE'
            ? 'unverified-origin'
            : null,
    },
    identity: {
      runId: run.ok ? run.value.id : null,
      runAttempt: run.ok ? run.value.runAttempt : null,
      headSha: run.ok ? run.value.headSha : null,
      event: run.ok ? eventClass(run.value.event) : null,
      testJobId: testJob?.id ?? null,
      artifactId: summaryResult.artifactId,
    },
  });
}

function validArchive(v: unknown): ArchiveEvidence {
  if (!isRec(v)) return { status: 'failed', reason: 'malformed' };
  if (v.status === 'not-attempted') return { status: 'not-attempted' };
  if (v.status === 'failed') {
    return v.reason === 'expired'
      ? { status: 'failed', reason: 'expired' }
      : { status: 'failed', reason: oneOf(RETRIEVAL_FAILURES, v.reason) ? v.reason : 'malformed' };
  }
  if (
    v.status === 'downloaded' &&
    posInt(v.artifactId) &&
    (v.digestCheck === 'match' || v.digestCheck === 'mismatch') &&
    (v.contents === 'single-summary' ||
      v.contents === 'unexpected-entries' ||
      v.contents === 'too-large')
  ) {
    return {
      status: 'downloaded',
      artifactId: v.artifactId,
      digestCheck: v.digestCheck,
      contents: v.contents,
    };
  }
  return { status: 'failed', reason: 'malformed' };
}
