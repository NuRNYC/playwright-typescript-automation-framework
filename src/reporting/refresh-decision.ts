/**
 * README health refresh decision (ADR-0013, Phase C5A). Pure.
 *
 * Decides, for ONE candidate CI run attempt, whether a reviewed README refresh
 * pull request may be proposed. Every fact is injected: run metadata, the
 * strictly validated evidence states, the README's pinned snapshot, commit
 * ancestry and changed-path lists are gathered elsewhere (later phases) and
 * handed in. Nothing here reads files, the environment, the network, Git or
 * the clock.
 *
 * Policies (ADR-0013):
 *
 * 1. Only complete `VERIFIED_PASS` evidence of an eligible push-to-main run is
 *    publishable. Failed, partial, missing or conflicting evidence yields an
 *    explicit decision reason; an older successful run is never substituted.
 * 2. Unknown-impact changes block publication pending human review.
 * 3. Order by source-commit ancestry and run attempt, never by run id alone.
 *    Superseded attempts and divergent sources are rejected.
 * 4. Two separate comparisons:
 *    - changes since the README snapshot's source (`snapshot..candidate`):
 *      what the candidate run measured that the snapshot did not;
 *    - changes since the candidate run's tested source (`candidate..main`):
 *      what is on `main` that the candidate run did NOT test.
 * 5. Documentation-only changes never cause a refresh on their own (this
 *    breaks the docs-merge -> CI -> refresh-PR loop), but a substantive
 *    difference in metrics, outcomes, evidence state or verification is
 *    never hidden, and the ADR-0012 age limit still applies. "Substantive"
 *    is a structured comparison of metric identities (`compareMetrics` in
 *    `readme-health.ts`), never of rendered Markdown: a new commit, run,
 *    attempt or timestamp alone is provenance, not a change.
 *
 * Free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import type { SummaryState, VerdictState } from './verdict.ts';
import { isCalendarInstant } from './readme-health.ts';
import type { MetricComparison, SnapshotPin } from './readme-health.ts';

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

export const REFRESH_POLICY = {
  repository: 'NuRNYC/playwright-typescript-automation-framework',
  workflowPath: '.github/workflows/tests.yml',
  branch: 'main',
  event: 'push',
  /** ADR-0012 section 6: stale more than 30 days after the source run completed. */
  maxSnapshotAgeDays: 30,
} as const;

export type RefreshPolicy = typeof REFRESH_POLICY;

/* ------------------------------------------------------------------ *
 * Path impact (ADR-0012 section 6)
 * ------------------------------------------------------------------ */

export type PathImpact = 'test-affecting' | 'documentation' | 'unknown-impact';

/** The ADR-0012 minimum test-affecting set. */
const TEST_AFFECTING_PREFIXES = ['tests/', 'src/', 'dashboard/', 'scripts/', '.github/workflows/'];
const TEST_AFFECTING_FILES = new Set(['playwright.config.ts', 'package.json', 'package-lock.json']);
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\x21-\x7e]+(?:\/[\x21-\x7e]+)*$/;

/**
 * Documentation is a closed list: Markdown at the repository root or under
 * `docs/`. Everything that is neither test-affecting nor documentation (tool,
 * Node.js or browser versions, configuration, environment, unrecognised
 * files) is unknown impact and blocks publication until a reviewer decides.
 */
export function classifyPath(path: string): PathImpact {
  if (!SAFE_PATH.test(path) || path.includes('//')) return 'unknown-impact';
  if (TEST_AFFECTING_FILES.has(path)) return 'test-affecting';
  if (TEST_AFFECTING_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'test-affecting';
  if (/^[^/]+\.md$/.test(path) || /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(path)) {
    return 'documentation';
  }
  return 'unknown-impact';
}

export type ChangeClass =
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'none' | 'documentation-only' | 'test-affecting' | 'unknown-impact';
      readonly testAffecting: number;
      readonly documentation: number;
      readonly unknownImpact: number;
    };

/**
 * Classifies a changed-path list (`null` = the list could not be obtained).
 * Unknown impact outranks test-affecting: it needs review whatever else
 * changed. Renames must be supplied as both paths.
 */
export function classifyChanges(paths: readonly string[] | null): ChangeClass {
  if (paths === null) return { kind: 'unavailable' };
  let testAffecting = 0;
  let documentation = 0;
  let unknownImpact = 0;
  for (const path of paths) {
    const impact = classifyPath(path);
    if (impact === 'test-affecting') testAffecting += 1;
    else if (impact === 'documentation') documentation += 1;
    else unknownImpact += 1;
  }
  const kind =
    unknownImpact > 0
      ? 'unknown-impact'
      : testAffecting > 0
        ? 'test-affecting'
        : documentation > 0
          ? 'documentation-only'
          : 'none';
  return { kind, testAffecting, documentation, unknownImpact };
}

/* ------------------------------------------------------------------ *
 * Facts
 * ------------------------------------------------------------------ */

/** Run-attempt metadata as returned by the GitHub API, not the event payload. */
export interface CandidateRun {
  readonly repository: string;
  readonly workflowPath: string;
  readonly event: string;
  readonly headBranch: string | null;
  /** `head_repository.full_name`; differs from `repository` for a fork. */
  readonly headRepository: string | null;
  readonly status: string;
  readonly runId: number;
  readonly runAttempt: number;
  /** The run's newest attempt number (`run_attempt` of the run record). */
  readonly latestAttempt: number;
  readonly headSha: string;
  /** Completion time of the attempt's last job, to the second; null if unknown. */
  readonly completedAt: string | null;
}

export type SectionState = 'complete' | 'partial' | 'unavailable';

/** Results of strict validation (C2 parsers, C1 model, ADR-0010 reconciler). */
export interface CandidateEvidence {
  readonly verdict: VerdictState;
  readonly summary: SummaryState;
  readonly unit: SectionState;
  readonly playwright: SectionState;
  /** Run id, attempt and commit agree across run, unit result, summary and bundle. */
  readonly identity: 'match' | 'mismatch';
  /** C1 model recomputed with the bundle's `generatedAt` vs the CI health JSON. */
  readonly healthBundle: 'match' | 'mismatch' | 'unavailable';
}

/**
 * Where the candidate's source commit stands relative to another commit:
 * `same`; `descendant` (the candidate is strictly newer); `ancestor` (the
 * candidate is strictly older); `diverged` (neither); `unknown` (could not
 * be determined).
 */
export type Ancestry = 'same' | 'descendant' | 'ancestor' | 'diverged' | 'unknown';

export interface RefreshFacts {
  readonly candidate: CandidateRun;
  readonly evidence: CandidateEvidence;
  /** Parsed from the README's marked section; undefined when unreadable. */
  readonly snapshot: SnapshotPin | undefined;
  /** Candidate source relative to the snapshot's source commit. */
  readonly candidateVsSnapshot: Ancestry;
  /** Candidate source relative to the current `main` tip. */
  readonly candidateVsMain: Ancestry;
  /** Paths changed in `snapshot.sourceSha..candidate.headSha`. */
  readonly changesSinceSnapshotSource: readonly string[] | null;
  /** Paths changed in `candidate.headSha..main`. */
  readonly changesSinceCandidateSource: readonly string[] | null;
  /**
   * Structured comparison of the candidate's metric identity with the
   * snapshot's (`compareMetrics`): `unavailable` when the snapshot's identity
   * is unknown (for example a manual snapshot whose evidence has expired).
   */
  readonly metrics: MetricComparison;
}

/* ------------------------------------------------------------------ *
 * Decision
 * ------------------------------------------------------------------ */

export const REFRESH_REASONS = [
  // Candidate eligibility.
  'run-metadata-unavailable',
  'wrong-repository',
  'wrong-workflow',
  'not-push-event',
  'not-main-branch',
  'foreign-head-repository',
  'run-not-completed',
  'invalid-run-identity',
  'completion-time-missing',
  'attempt-superseded',
  // Evidence.
  'verdict-verified-fail',
  'verdict-execution-failed',
  'verdict-cancelled',
  'verdict-pending',
  'verdict-untrusted-provenance',
  'verdict-conflict',
  'verdict-unknown',
  'summary-not-verified-origin',
  'unit-evidence-partial',
  'unit-evidence-unavailable',
  'playwright-evidence-partial',
  'playwright-evidence-unavailable',
  'evidence-identity-mismatch',
  'health-bundle-mismatch',
  'health-bundle-unavailable',
  // Snapshot and ordering.
  'snapshot-pin-unreadable',
  'same-evidence-as-snapshot',
  'attempt-older-than-snapshot',
  'same-source-different-run',
  'candidate-older-than-snapshot',
  'divergent-source',
  'ancestry-unknown',
  'candidate-ahead-of-main',
  // Changes since the candidate's tested source (candidate..main).
  'changes-since-candidate-unavailable',
  'unknown-impact-since-candidate',
  'superseded-by-test-affecting-change',
  // Changes since the snapshot's source (snapshot..candidate).
  'changes-since-snapshot-unavailable',
  'unknown-impact-since-snapshot',
  'test-affecting-change-since-snapshot',
  'newer-attempt-of-snapshot-source',
  'substantive-change',
  'snapshot-metrics-unavailable',
  'snapshot-age-exceeded',
  'documentation-only-no-substantive-change',
  'no-substantive-change',
] as const;
export type RefreshReason = (typeof REFRESH_REASONS)[number];

/**
 * - `refresh`: a refresh PR may be proposed (subject to revalidation right
 *   before publication).
 * - `no-op`: nothing to propose; the README already says what this run says.
 * - `skip`: this run is not publishable; no human action is implied.
 * - `blocked`: publication needs a human decision (conflict or unknown impact).
 */
export type RefreshAction = 'refresh' | 'no-op' | 'skip' | 'blocked';

export interface RefreshDecision {
  readonly action: RefreshAction;
  readonly reasons: readonly RefreshReason[];
}

const BLOCKING: ReadonlySet<RefreshReason> = new Set<RefreshReason>([
  'verdict-conflict',
  'evidence-identity-mismatch',
  'health-bundle-mismatch',
  'snapshot-pin-unreadable',
  'same-source-different-run',
  'ancestry-unknown',
  'candidate-ahead-of-main',
  'changes-since-candidate-unavailable',
  'unknown-impact-since-candidate',
  'changes-since-snapshot-unavailable',
  'unknown-impact-since-snapshot',
  'snapshot-metrics-unavailable',
]);

const VERDICT_REASON: Readonly<Record<Exclude<VerdictState, 'VERIFIED_PASS'>, RefreshReason>> = {
  VERIFIED_FAIL: 'verdict-verified-fail',
  EXECUTION_FAILED: 'verdict-execution-failed',
  CANCELLED: 'verdict-cancelled',
  PENDING: 'verdict-pending',
  UNTRUSTED_PROVENANCE: 'verdict-untrusted-provenance',
  CONFLICT: 'verdict-conflict',
  UNKNOWN: 'verdict-unknown',
};

const SHA = /^[0-9a-f]{40}$/;
const DAY_MS = 86_400_000;

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function refusal(reasons: readonly RefreshReason[]): RefreshDecision {
  return {
    action: reasons.some((reason) => BLOCKING.has(reason)) ? 'blocked' : 'skip',
    reasons,
  };
}

/** Eligibility of the run attempt itself (metadata from the API). */
export function candidateProblems(
  candidate: CandidateRun,
  policy: RefreshPolicy = REFRESH_POLICY,
): RefreshReason[] {
  const reasons: RefreshReason[] = [];
  if (candidate.repository !== policy.repository) reasons.push('wrong-repository');
  if (candidate.workflowPath !== policy.workflowPath) reasons.push('wrong-workflow');
  if (candidate.event !== policy.event) reasons.push('not-push-event');
  if (candidate.headBranch !== policy.branch) reasons.push('not-main-branch');
  if (candidate.headRepository !== policy.repository) reasons.push('foreign-head-repository');
  if (candidate.status !== 'completed') reasons.push('run-not-completed');
  if (
    !positive(candidate.runId) ||
    !positive(candidate.runAttempt) ||
    !positive(candidate.latestAttempt) ||
    !SHA.test(candidate.headSha)
  ) {
    reasons.push('invalid-run-identity');
  } else if (candidate.runAttempt > candidate.latestAttempt) {
    // An attempt newer than the run's newest attempt cannot exist.
    reasons.push('invalid-run-identity');
  } else if (candidate.runAttempt < candidate.latestAttempt) {
    reasons.push('attempt-superseded');
  }
  if (candidate.completedAt === null || !isCalendarInstant(candidate.completedAt)) {
    reasons.push('completion-time-missing');
  }
  return reasons;
}

/** Only complete, consistent `VERIFIED_PASS` evidence passes. */
export function evidenceProblems(evidence: CandidateEvidence): RefreshReason[] {
  const reasons: RefreshReason[] = [];
  if (evidence.verdict !== 'VERIFIED_PASS') reasons.push(VERDICT_REASON[evidence.verdict]);
  if (evidence.summary !== 'SUMMARY_VERIFIED_ORIGIN') reasons.push('summary-not-verified-origin');
  if (evidence.unit === 'partial') reasons.push('unit-evidence-partial');
  if (evidence.unit === 'unavailable') reasons.push('unit-evidence-unavailable');
  if (evidence.playwright === 'partial') reasons.push('playwright-evidence-partial');
  if (evidence.playwright === 'unavailable') reasons.push('playwright-evidence-unavailable');
  if (evidence.identity !== 'match') reasons.push('evidence-identity-mismatch');
  if (evidence.healthBundle === 'mismatch') reasons.push('health-bundle-mismatch');
  if (evidence.healthBundle === 'unavailable') reasons.push('health-bundle-unavailable');
  return reasons;
}

function ageExceeded(snapshot: SnapshotPin, candidate: CandidateRun, days: number): boolean {
  if (candidate.completedAt === null) return false;
  const from = Date.parse(snapshot.completedAt);
  const to = Date.parse(candidate.completedAt);
  return Number.isFinite(from) && Number.isFinite(to) && to - from > days * DAY_MS;
}

/** The whole decision for one candidate run attempt. */
export function decideRefresh(
  facts: RefreshFacts,
  policy: RefreshPolicy = REFRESH_POLICY,
): RefreshDecision {
  const { candidate, snapshot } = facts;

  // 1. Eligibility and evidence: every problem is reported together.
  const problems = [...candidateProblems(candidate, policy), ...evidenceProblems(facts.evidence)];
  if (problems.length > 0) return refusal(problems);

  // 2. The README's own pin must be readable to order against it.
  if (snapshot === undefined) return refusal(['snapshot-pin-unreadable']);

  // 3. Ordering against the snapshot: ancestry first, attempt within a run.
  let sameSourceNewerAttempt = false;
  switch (facts.candidateVsSnapshot) {
    case 'same':
      if (candidate.headSha !== snapshot.sourceSha || candidate.runId !== snapshot.runId) {
        return refusal(['same-source-different-run']);
      }
      if (candidate.runAttempt === snapshot.runAttempt) {
        return { action: 'no-op', reasons: ['same-evidence-as-snapshot'] };
      }
      if (candidate.runAttempt < snapshot.runAttempt) {
        return refusal(['attempt-older-than-snapshot']);
      }
      sameSourceNewerAttempt = true;
      break;
    case 'descendant':
      break;
    case 'ancestor':
      return refusal(['candidate-older-than-snapshot']);
    case 'diverged':
      return refusal(['divergent-source']);
    case 'unknown':
      return refusal(['ancestry-unknown']);
  }

  // 4. What `main` holds that the candidate run did not test.
  switch (facts.candidateVsMain) {
    case 'same':
      break;
    case 'ancestor': {
      const since = classifyChanges(facts.changesSinceCandidateSource);
      if (since.kind === 'unavailable') return refusal(['changes-since-candidate-unavailable']);
      if (since.kind === 'unknown-impact') return refusal(['unknown-impact-since-candidate']);
      if (since.kind === 'test-affecting') return refusal(['superseded-by-test-affecting-change']);
      break;
    }
    case 'descendant':
      return refusal(['candidate-ahead-of-main']);
    case 'diverged':
      return refusal(['divergent-source']);
    case 'unknown':
      return refusal(['ancestry-unknown']);
  }

  // 5. What the candidate measured that the snapshot did not.
  const reasons: RefreshReason[] = [];
  if (sameSourceNewerAttempt) {
    reasons.push('newer-attempt-of-snapshot-source');
  } else {
    const since = classifyChanges(facts.changesSinceSnapshotSource);
    if (since.kind === 'unavailable') return refusal(['changes-since-snapshot-unavailable']);
    if (since.kind === 'unknown-impact') return refusal(['unknown-impact-since-snapshot']);
    if (since.kind === 'test-affecting') reasons.push('test-affecting-change-since-snapshot');
  }
  if (facts.metrics === 'different') reasons.push('substantive-change');
  if (ageExceeded(snapshot, candidate, policy.maxSnapshotAgeDays)) {
    reasons.push('snapshot-age-exceeded');
  }
  // Without the snapshot's identity a "no change" verdict cannot be proved:
  // a person decides, unless a test-affecting change or the age limit
  // already justifies a refresh.
  const justified = reasons.some(
    (reason) =>
      reason === 'test-affecting-change-since-snapshot' || reason === 'snapshot-age-exceeded',
  );
  if (facts.metrics === 'unavailable' && !justified) {
    return refusal(['snapshot-metrics-unavailable']);
  }

  // A newer attempt of the same source only matters if it says something new.
  const meaningful = reasons.filter((reason) => reason !== 'newer-attempt-of-snapshot-source');
  if (meaningful.length === 0) {
    return {
      action: 'no-op',
      reasons: sameSourceNewerAttempt
        ? ['newer-attempt-of-snapshot-source', 'no-substantive-change']
        : ['documentation-only-no-substantive-change'],
    };
  }
  return { action: 'refresh', reasons };
}
