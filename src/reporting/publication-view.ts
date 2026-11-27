/**
 * Browser-safe publication reader and view model (ADR-0011 P3-2). Pure.
 *
 *   parsePublication(text)                          -> ParsedPublication
 *   buildPublicationViewModel(parsed, origin, now)  -> PublicationViewModel
 *
 * Validates a `quality-verdict-publication` 1.0.0 manifest text against the
 * exact P1 schema and cross-field rules, and maps it to presentation-ready
 * data for the static dashboard. Nothing here authenticates anything:
 *
 * - `BUILD_VERIFIED` is a statement made by the trusted Node build (the P2
 *   publisher, then the P3 Node-side reader in `./publication-reader.ts`).
 *   The browser cannot prove it; it only refuses data that is malformed,
 *   non-canonical or contradictory, and labels each claim as the publisher's
 *   build statement.
 * - Text from any other origin (for example a file picked by a viewer) is
 *   `imported`: every claim is shown as IMPORTED_UNAUTHENTICATED, nothing is
 *   aggregated and nothing gets verified styling, whatever the file says.
 * - Validation never escalates authenticity, and fixed codes never echo input.
 *
 * Browser constraints (existing dashboard architecture): compiled one file at
 * a time with `transpileModule` to ES2022 modules, no bundler. Only relative
 * imports of browser-safe modules (`./verdict.ts`, `./quality-summary.ts`);
 * type-only imports are erased. No Node APIs, filesystem, network, storage,
 * DOM, clock, dynamic import or dynamic code. The caller supplies the
 * current time.
 *
 * The P1 vocabularies that live in modules importing `node:crypto`
 * (`./verdict-bundle.ts`, `./publication-manifest.ts`) are restated here;
 * `publication-view.test.ts` proves they equal the committed sources.
 */
import { OUTCOMES, type Outcome } from './quality-summary.ts';
import {
  RETRIEVAL_FAILURES,
  SUMMARY_STATES,
  VERDICT_STATES,
  type ReasonCode,
  type RetrievalFailure,
  type SummaryState,
  type VerdictState,
} from './verdict.ts';
import type {
  Freshness,
  Integrity,
  ManifestEntry,
  ManifestMetrics,
  PublicationManifest,
  PublishedAuthenticity,
} from './publication-manifest.ts';
import type { BundleCompleteness, BundleTotals, PublicPolicy } from './verdict-bundle.ts';

/* ------------------------------------------------------------------ *
 * Contract constants (restated from P1; equality proven by tests)
 * ------------------------------------------------------------------ */

export const PUBLICATION_SCHEMA_VERSION = '1.0.0';
export const PUBLICATION_KIND = 'quality-verdict-publication';
export const MAX_PUBLICATION_BYTES = 1024 * 1024;
export const MAX_PUBLICATION_ENTRIES = 500;
export const MAX_PUBLICATION_DEPTH = 8;
export const STALE_AFTER_DAYS = 30;
export const SYNTHETIC_SECTION_LABEL = 'SYNTHETIC DEMONSTRATION DATA';
const MAX_COUNT = 100_000_000;
const MAX_RUN_ATTEMPT = 1_000;
const DAY_MS = 86_400_000;

export const PUBLISHED_AUTHENTICITY = [
  'BUILD_VERIFIED',
  'RETAINED_UNAUTHENTICATED',
  'SYNTHETIC',
] as const satisfies readonly PublishedAuthenticity[];
export const FRESHNESS_VALUES = [
  'CURRENT',
  'HISTORICAL',
  'NOT_APPLICABLE',
] as const satisfies readonly Freshness[];
export const INTEGRITY_VALUES = [
  'verified-in-build',
  'retained-not-reverified',
  'mismatch',
  'not-checked',
] as const satisfies readonly Integrity[];
export const EVENT_VALUES = ['push', 'pull_request', 'other'] as const;
export const STATS_CROSS_CHECK_VALUES = ['match', 'mismatch', 'unavailable'] as const;
/** ADR-0010 completed, trusted verdicts (`TRUSTED_VERDICTS` in verdict-bundle.ts). */
export const TRUSTED_COMPLETED_VERDICTS = [
  'VERIFIED_PASS',
  'VERIFIED_FAIL',
  'EXECUTION_FAILED',
  'CANCELLED',
] as const satisfies readonly VerdictState[];

const RETRIEVAL_SOURCES = ['run', 'jobs', 'ancestry', 'artifacts', 'archive'] as const;
type RetrievalSource = (typeof RETRIEVAL_SOURCES)[number];
type RetrievalCode = `retrieval-${RetrievalSource}-${RetrievalFailure}`;
type NamedReason = Exclude<ReasonCode, RetrievalCode>;

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SEMVER = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/;
const REPO_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml$/;
const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/* ------------------------------------------------------------------ *
 * Fixed display text (exhaustive: a new enum member is a compile error)
 * ------------------------------------------------------------------ */

export type Tone = 'pass' | 'fail' | 'warn' | 'neutral';

export const VERDICT_TEXT: Readonly<
  Record<VerdictState, { readonly symbol: string; readonly label: string; readonly tone: Tone }>
> = {
  VERIFIED_PASS: { symbol: '✓', label: 'Verified pass', tone: 'pass' },
  VERIFIED_FAIL: { symbol: '✗', label: 'Verified Gate failure', tone: 'fail' },
  EXECUTION_FAILED: {
    symbol: '⚠',
    label: 'Pipeline failed before a verdict (not a test failure)',
    tone: 'fail',
  },
  CANCELLED: { symbol: '⊘', label: 'Cancelled', tone: 'warn' },
  PENDING: { symbol: '…', label: 'In progress', tone: 'warn' },
  UNTRUSTED_PROVENANCE: { symbol: '?', label: 'Unverified origin (pull request)', tone: 'warn' },
  CONFLICT: { symbol: '⚠', label: 'Evidence conflict', tone: 'warn' },
  UNKNOWN: { symbol: '?', label: 'Could not verify', tone: 'warn' },
};

export const SUMMARY_TEXT: Readonly<Record<SummaryState, string>> = {
  SUMMARY_VERIFIED_ORIGIN: 'Metrics from a verified origin',
  SUMMARY_INFORMATIVE: 'Metrics from an unverified origin (not published)',
  SUMMARY_UNAVAILABLE: 'Metrics unavailable',
  SUMMARY_INVALID: 'Summary invalid',
  SUMMARY_CONFLICT: 'Summary conflict — possible tampering',
  SUMMARY_UNKNOWN: 'Summary could not be checked',
};

export type DisplayedAuthenticity = PublishedAuthenticity | 'IMPORTED_UNAUTHENTICATED';

export const AUTHENTICITY_TEXT: Readonly<Record<DisplayedAuthenticity, string>> = {
  BUILD_VERIFIED: "Verified by the publisher's build (publisher statement)",
  RETAINED_UNAUTHENTICATED: "Historical retained evidence — publisher's record, not re-verified",
  SYNTHETIC: 'SYNTHETIC DEMONSTRATION DATA — not a real CI result',
  IMPORTED_UNAUTHENTICATED: 'Imported file — not authenticated',
};

export const FRESHNESS_TEXT: Readonly<Record<Freshness, string>> = {
  CURRENT: "Established by the publisher's build at build time",
  HISTORICAL: 'Historical — not re-verified',
  NOT_APPLICABLE: 'Not applicable (synthetic data)',
};

export const INTEGRITY_TEXT: Readonly<Record<Integrity, string>> = {
  'verified-in-build': 'Archive SHA-256 matched the declared digest in the build',
  'retained-not-reverified': 'Retained record; archive not re-checked',
  mismatch: 'Archive SHA-256 did not match the declared digest',
  'not-checked': 'Archive not checked',
};

const NAMED_REASON_TEXT: Readonly<Record<NamedReason, string>> = {
  'invalid-request': 'Invalid request',
  'invalid-policy': 'Invalid trust policy',
  'identity-run-id-mismatch': 'Response was for another run',
  'identity-attempt-mismatch': 'Response was for another attempt',
  'identity-job-attempt-mismatch': 'Job belongs to another attempt',
  'identity-job-sha-mismatch': 'Job ran another commit',
  'identity-ancestry-sha-mismatch': 'Ancestry checked another commit',
  'identity-duplicate-test-job': 'More than one test job',
  'identity-duplicate-gate-step': 'More than one Gate step',
  'provenance-event': 'Not a trusted event',
  'provenance-branch': 'Not the trusted branch',
  'provenance-repository': 'Another repository',
  'provenance-head-repository': 'Head from another repository',
  'provenance-workflow-id': 'Another workflow',
  'provenance-workflow-path': 'Another workflow file',
  'provenance-workflow-name': 'Another workflow name',
  'provenance-head-ahead-of-main': 'Commit not on main (ahead)',
  'provenance-diverged-from-main': 'Commit not on main (diverged)',
  'run-not-completed': 'Run not completed',
  'run-cancelled': 'Run cancelled',
  'job-cancelled': 'Test job cancelled',
  'outcome-job-not-completed': 'Test job not completed',
  'outcome-gate-success-job-not-success': 'Gate succeeded but the job did not',
  'outcome-gate-failure-job-success': 'Gate failed but the job succeeded',
  'outcome-run-success-job-not-success': 'Run succeeded but the job did not',
  'outcome-run-not-success-job-and-gate-success': 'Run failed although job and Gate succeeded',
  'gate-success': 'Gate step succeeded',
  'gate-failure': 'Gate step failed',
  'job-failed-before-gate': 'Job failed before the Gate',
  'run-failed-without-test-job': 'Run failed without a test job',
  'no-test-job': 'No test job',
  'gate-not-decisive': 'Gate outcome not decisive',
  'unmapped-conclusion': 'Unrecognized conclusion',
  'artifact-duplicate': 'Duplicate summary artifact',
  'artifact-run-mismatch': 'Artifact from another run',
  'artifact-repository-mismatch': 'Artifact from another repository',
  'artifact-head-repository-mismatch': 'Artifact from another head repository',
  'artifact-sha-mismatch': 'Artifact for another commit',
  'artifact-created-outside-attempt': 'Artifact created outside the attempt',
  'artifact-id-mismatch': 'Artifact ID mismatch',
  'digest-mismatch': 'Archive digest mismatch',
  'summary-run-mismatch': 'Summary for another run',
  'summary-attempt-mismatch': 'Summary for another attempt',
  'summary-event-mismatch': 'Summary for another event',
  'summary-sha-mismatch': 'Summary for another commit',
  'observed-inputs-contradict-gate': 'Observed Gate inputs contradict the Gate',
  'binding-run-attempt-unavailable': 'Run attempt binding unavailable',
  'artifact-absent': 'Summary artifact absent',
  'artifact-expired': 'Summary artifact expired',
  'archive-not-downloaded': 'Archive not downloaded',
  'archive-unexpected-entries': 'Archive has unexpected entries',
  'archive-too-large': 'Archive too large',
  'summary-missing': 'Summary missing from the archive',
  'summary-invalid': 'Summary invalid',
  'summary-schema-mismatch': 'Unsupported summary schema',
  'verdict-not-trusted': 'Verdict not trusted',
  'digest-contract-unconfirmed': 'Digest contract not confirmed',
  'verified-origin': 'Verified origin',
};

const SOURCE_TEXT: Readonly<Record<RetrievalSource, string>> = {
  run: 'Run attempt',
  jobs: 'Jobs',
  ancestry: 'Ancestry',
  artifacts: 'Artifact listing',
  archive: 'Archive',
};

const FAILURE_TEXT: Readonly<Record<RetrievalFailure, string>> = {
  'http-error': 'HTTP error',
  'not-found': 'not found',
  permission: 'permission denied',
  'rate-limited': 'rate limited',
  timeout: 'timed out',
  malformed: 'malformed response',
  'incomplete-pagination': 'incomplete pagination',
};

/** Every reason code, in a fixed order; equal as a set to `REASON_CODES` (verdict-bundle.ts). */
export const PUBLICATION_REASON_CODES: readonly ReasonCode[] = Object.freeze([
  ...(Object.keys(NAMED_REASON_TEXT) as NamedReason[]),
  ...RETRIEVAL_SOURCES.flatMap((s) =>
    RETRIEVAL_FAILURES.map((f): RetrievalCode => `retrieval-${s}-${f}`),
  ),
]);

const REASON_TEXT: ReadonlyMap<string, string> = new Map<string, string>([
  ...Object.entries(NAMED_REASON_TEXT),
  ...RETRIEVAL_SOURCES.flatMap((s) =>
    RETRIEVAL_FAILURES.map((f): [string, string] => [
      `retrieval-${s}-${f}`,
      `${SOURCE_TEXT[s]} not retrieved: ${FAILURE_TEXT[f]}`,
    ]),
  ),
]);

/** Fixed display text of a reason code. */
export function reasonText(code: ReasonCode): string {
  return REASON_TEXT.get(code) ?? 'Unrecognized reason';
}

/* ------------------------------------------------------------------ *
 * Strict reader
 * ------------------------------------------------------------------ */

export const PUBLICATION_REJECTIONS = [
  'input-type',
  'too-large',
  'invalid-json',
  'too-deep',
  'invalid-structure',
  'unknown-field',
  'missing-field',
  'invalid-value',
  'unsupported-version',
  'wrong-kind',
  'invalid-reason',
  'reasons-not-canonical',
  'too-many-entries',
  'duplicate-entry',
  'entries-not-sorted',
  'untrusted-in-results',
  'trusted-in-untrusted-origin',
  'identity-conflict',
  'authenticity-mismatch',
  'freshness-mismatch',
  'label-mismatch',
  'integrity-mismatch',
  'metrics-not-permitted',
  'metrics-inconsistent',
  'synthetic-mismatch',
  'not-canonical',
] as const;
export type PublicationRejection = (typeof PUBLICATION_REJECTIONS)[number];

export type ParsedPublication =
  | { readonly state: 'valid'; readonly manifest: PublicationManifest }
  | { readonly state: 'rejected'; readonly code: PublicationRejection };

type Rec = Readonly<Record<string, unknown>>;

class Reject extends Error {
  readonly code: PublicationRejection;
  constructor(code: PublicationRejection) {
    super(code);
    this.code = code;
  }
}

function isRec(value: unknown): value is Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function has(value: Rec, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Exactly these keys. Unknown key names are never echoed. */
function exactKeys(value: unknown, keys: readonly string[]): Rec {
  if (!isRec(value)) throw new Reject('invalid-structure');
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Reject('unknown-field');
  }
  for (const key of keys) {
    if (!has(value, key)) throw new Reject('missing-field');
  }
  return value;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Reject('invalid-value');
  }
  return value as T;
}

function positiveId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Reject('invalid-value');
  }
  return value;
}

function runAttempt(value: unknown): number {
  const n = positiveId(value);
  if (n > MAX_RUN_ATTEMPT) throw new Reject('invalid-value');
  return n;
}

function count(value: unknown, min = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > MAX_COUNT
  ) {
    throw new Reject('invalid-value');
  }
  return value;
}

function matching(pattern: RegExp, value: unknown): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Reject('invalid-value');
  return value;
}

/** A real calendar instant in canonical UTC form (same rule as P1 `isIsoUtc`). */
export function isCanonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  const iso = new Date(ms).toISOString();
  return iso === value || iso === value.replace('Z', '.000Z');
}

function utc(value: unknown): string {
  if (!isCanonicalUtc(value)) throw new Reject('invalid-value');
  return value;
}

/** Iterative depth bound, so hostile input cannot exhaust the stack. */
function withinDepth(root: unknown, maxDepth: number): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (typeof item.value !== 'object' || item.value === null) continue;
    if (item.depth > maxDepth || ++nodes > 1_000_000) return false;
    for (const child of Object.values(item.value)) {
      stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}

const POLICY_KEYS = [
  'repositoryId',
  'repositoryFullName',
  'workflowId',
  'workflowPath',
  'workflowName',
  'trustedEvent',
  'trustedBranch',
] as const;

function policy(value: unknown): PublicPolicy {
  const p = exactKeys(value, POLICY_KEYS);
  if (p.trustedEvent !== 'push') throw new Reject('invalid-value');
  return {
    repositoryId: positiveId(p.repositoryId),
    repositoryFullName: matching(REPO_SLUG, p.repositoryFullName),
    workflowId: positiveId(p.workflowId),
    workflowPath: matching(WORKFLOW_PATH, p.workflowPath),
    workflowName: matching(WORKFLOW_NAME, p.workflowName),
    trustedEvent: 'push',
    trustedBranch: matching(BRANCH, p.trustedBranch),
  };
}

function reasons(value: unknown): ReasonCode[] {
  if (!Array.isArray(value)) throw new Reject('invalid-structure');
  const codes = (value as readonly unknown[]).map((code): ReasonCode => {
    if (typeof code !== 'string' || !REASON_TEXT.has(code)) throw new Reject('invalid-reason');
    return code as ReasonCode;
  });
  const canonical = [...new Set(codes)].sort();
  if (canonical.length !== codes.length || canonical.some((c, i) => c !== codes[i])) {
    throw new Reject('reasons-not-canonical');
  }
  return codes;
}

const SORTED_OUTCOMES: readonly Outcome[] = [...OUTCOMES].sort();

function outcomeCounts(value: unknown): Partial<Record<Outcome, number>> {
  if (!isRec(value)) throw new Reject('invalid-structure');
  for (const key of Object.keys(value)) {
    if (!(OUTCOMES as readonly string[]).includes(key)) throw new Reject('unknown-field');
  }
  // Inside an outcome map an absent key means zero; a present key is at least 1.
  const out: Partial<Record<Outcome, number>> = {};
  for (const key of SORTED_OUTCOMES) {
    if (has(value, key)) out[key] = count(value[key], 1);
  }
  return out;
}

const TOTALS_KEYS = [
  'attempts',
  'byExecutionOutcome',
  'byInstanceOutcome',
  'definitions',
  'executions',
  'instances',
  'retries',
  'zeroAttemptExecutions',
] as const;

const COMPLETENESS_KEYS = [
  'ambiguousIdentities',
  'droppedTags',
  'inconsistentExecutions',
  'invalidDurations',
  'invalidRetries',
  'omissionDetection',
  'provisionalOutcomes',
  'shardAttribution',
  'statsCrossCheck',
  'unclassifiedAttempts',
  'unrecognizedProjectExecutions',
  'unresolvedIdentities',
] as const;

function sum(counts: Partial<Record<Outcome, number>>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function totals(value: unknown): BundleTotals {
  const t = exactKeys(value, TOTALS_KEYS);
  const out: BundleTotals = {
    attempts: count(t.attempts),
    byExecutionOutcome: outcomeCounts(t.byExecutionOutcome),
    byInstanceOutcome: outcomeCounts(t.byInstanceOutcome),
    definitions: count(t.definitions),
    executions: count(t.executions),
    instances: count(t.instances),
    retries: count(t.retries),
    zeroAttemptExecutions: count(t.zeroAttemptExecutions),
  };
  // The M8A counting invariants that the totals alone can express.
  if (
    sum(out.byInstanceOutcome) !== out.instances ||
    sum(out.byExecutionOutcome) !== out.executions ||
    out.executions < out.instances ||
    out.instances < out.definitions ||
    out.retries > out.attempts ||
    out.zeroAttemptExecutions >
      (out.byExecutionOutcome['did-not-run'] ?? 0) + (out.byExecutionOutcome.unclassified ?? 0)
  ) {
    throw new Reject('metrics-inconsistent');
  }
  return out;
}

function completeness(value: unknown): BundleCompleteness {
  const c = exactKeys(value, COMPLETENESS_KEYS);
  if (c.omissionDetection !== 'not-supported' || c.shardAttribution !== 'not-available') {
    throw new Reject('invalid-value');
  }
  return {
    ambiguousIdentities: count(c.ambiguousIdentities),
    droppedTags: count(c.droppedTags),
    inconsistentExecutions: count(c.inconsistentExecutions),
    invalidDurations: count(c.invalidDurations),
    invalidRetries: count(c.invalidRetries),
    omissionDetection: 'not-supported',
    provisionalOutcomes: count(c.provisionalOutcomes),
    shardAttribution: 'not-available',
    statsCrossCheck: oneOf(STATS_CROSS_CHECK_VALUES, c.statsCrossCheck),
    unclassifiedAttempts: count(c.unclassifiedAttempts),
    unrecognizedProjectExecutions: count(c.unrecognizedProjectExecutions),
    unresolvedIdentities: count(c.unresolvedIdentities),
  };
}

function metrics(value: unknown): ManifestMetrics | null {
  if (value === null) return null;
  const m = exactKeys(value, [
    'authenticity',
    'freshness',
    'summarySchemaVersion',
    'totals',
    'completeness',
  ]);
  const version =
    typeof m.summarySchemaVersion === 'string' ? SEMVER.exec(m.summarySchemaVersion) : null;
  if (version === null || Number(version[1]) !== 1) throw new Reject('invalid-value');
  return {
    authenticity: oneOf(['BUILD_VERIFIED', 'SYNTHETIC'] as const, m.authenticity),
    freshness: oneOf(FRESHNESS_VALUES, m.freshness),
    summarySchemaVersion: version[0],
    totals: totals(m.totals),
    completeness: completeness(m.completeness),
  };
}

const ENTRY_KEYS = [
  'runId',
  'runAttempt',
  'headSha',
  'event',
  'gate',
  'summary',
  'artifact',
  'metrics',
];

function entry(value: unknown): ManifestEntry {
  const e = exactKeys(value, ENTRY_KEYS);
  const g = exactKeys(e.gate, ['state', 'reasons', 'authenticity', 'freshness', 'verifiedAt']);
  const s = exactKeys(e.summary, ['state', 'reasons', 'label']);
  const a = exactKeys(e.artifact, ['id', 'digest', 'integrity']);
  return {
    runId: positiveId(e.runId),
    runAttempt: runAttempt(e.runAttempt),
    headSha: matching(SHA, e.headSha),
    event: oneOf(EVENT_VALUES, e.event),
    gate: {
      state: oneOf(VERDICT_STATES, g.state),
      reasons: reasons(g.reasons),
      authenticity: oneOf(PUBLISHED_AUTHENTICITY, g.authenticity),
      freshness: oneOf(FRESHNESS_VALUES, g.freshness),
      verifiedAt: g.verifiedAt === null ? null : utc(g.verifiedAt),
    },
    summary: {
      state: oneOf(SUMMARY_STATES, s.state),
      reasons: reasons(s.reasons),
      label:
        s.label === null ? null : oneOf(['verified-origin', 'unverified-origin'] as const, s.label),
    },
    artifact: {
      id: a.id === null ? null : positiveId(a.id),
      digest: a.digest === null ? null : matching(DIGEST, a.digest),
      integrity: oneOf(INTEGRITY_VALUES, a.integrity),
    },
    metrics: metrics(e.metrics),
  };
}

function isTrustedCompleted(state: VerdictState): boolean {
  return (TRUSTED_COMPLETED_VERDICTS as readonly VerdictState[]).includes(state);
}

/** True when P1 would place the entry in `untrustedOrigin` rather than `results`. */
function isUntrusted(e: ManifestEntry): boolean {
  return e.event !== 'push' || e.gate.state === 'UNTRUSTED_PROVENANCE';
}

/** Cross-field rules every section shares (P1 projection and bundle consistency). */
function commonRules(e: ManifestEntry): void {
  // Identity conflicts are never publishable (ADR-0011 amendment, identity-mismatch).
  if (
    e.gate.reasons.includes('identity-run-id-mismatch') ||
    e.gate.reasons.includes('identity-attempt-mismatch')
  ) {
    throw new Reject('identity-conflict');
  }
  // A verified or pending verdict needs a push run; a non-push run is CONFLICT or untrusted.
  if ((isTrustedCompleted(e.gate.state) || e.gate.state === 'PENDING') && e.event !== 'push') {
    throw new Reject('trusted-in-untrusted-origin');
  }
  if (
    e.event !== 'push' &&
    e.gate.state !== 'CONFLICT' &&
    e.gate.state !== 'UNTRUSTED_PROVENANCE'
  ) {
    throw new Reject('trusted-in-untrusted-origin');
  }
  const expectedLabel =
    e.summary.state === 'SUMMARY_VERIFIED_ORIGIN'
      ? 'verified-origin'
      : e.summary.state === 'SUMMARY_INFORMATIVE'
        ? 'unverified-origin'
        : null;
  if (e.summary.label !== expectedLabel) throw new Reject('label-mismatch');
  if (
    e.summary.state === 'SUMMARY_VERIFIED_ORIGIN' &&
    (!isTrustedCompleted(e.gate.state) || e.event !== 'push' || e.artifact.id === null)
  ) {
    throw new Reject('label-mismatch');
  }
  if (e.artifact.digest !== null && e.artifact.id === null) throw new Reject('integrity-mismatch');
  if (e.artifact.integrity !== 'not-checked' && e.artifact.id === null) {
    throw new Reject('integrity-mismatch');
  }
  // Only this build can have checked an archive and found a mismatch.
  if (e.artifact.integrity === 'mismatch' && e.gate.authenticity !== 'BUILD_VERIFIED') {
    throw new Reject('integrity-mismatch');
  }
}

function realRules(e: ManifestEntry, builtAt: string): void {
  commonRules(e);
  if (e.gate.authenticity === 'BUILD_VERIFIED') {
    if (e.gate.freshness !== 'CURRENT') throw new Reject('freshness-mismatch');
    if (e.gate.verifiedAt !== builtAt) throw new Reject('freshness-mismatch');
    // Nothing that could not be retrieved is ever a BUILD_VERIFIED claim.
    if (e.gate.reasons.some((r) => r.startsWith('retrieval-'))) {
      throw new Reject('authenticity-mismatch');
    }
    if (e.artifact.integrity === 'retained-not-reverified') throw new Reject('integrity-mismatch');
    if (e.artifact.integrity === 'verified-in-build' && e.artifact.digest === null) {
      throw new Reject('integrity-mismatch');
    }
    // A verified origin in this build means the archive digest matched in this build.
    if (
      e.summary.state === 'SUMMARY_VERIFIED_ORIGIN' &&
      e.artifact.integrity !== 'verified-in-build'
    ) {
      throw new Reject('integrity-mismatch');
    }
    if (e.metrics !== null) {
      if (
        e.metrics.authenticity !== 'BUILD_VERIFIED' ||
        e.metrics.freshness !== 'CURRENT' ||
        e.summary.state !== 'SUMMARY_VERIFIED_ORIGIN' ||
        e.artifact.integrity !== 'verified-in-build'
      ) {
        throw new Reject('metrics-not-permitted');
      }
    }
  } else if (e.gate.authenticity === 'RETAINED_UNAUTHENTICATED') {
    if (e.gate.freshness !== 'HISTORICAL' || e.gate.verifiedAt !== null) {
      throw new Reject('freshness-mismatch');
    }
    if (
      e.artifact.digest !== null ||
      (e.artifact.integrity !== 'retained-not-reverified' && e.artifact.integrity !== 'not-checked')
    ) {
      throw new Reject('integrity-mismatch');
    }
    // Historical retained metrics are disabled (approved policy).
    if (e.metrics !== null) throw new Reject('metrics-not-permitted');
  } else {
    throw new Reject('authenticity-mismatch');
  }
}

function syntheticRules(e: ManifestEntry): void {
  commonRules(e);
  if (e.gate.authenticity !== 'SYNTHETIC') throw new Reject('synthetic-mismatch');
  if (e.gate.freshness !== 'NOT_APPLICABLE' || e.gate.verifiedAt !== null) {
    throw new Reject('synthetic-mismatch');
  }
  if (e.artifact.digest !== null || e.artifact.integrity !== 'not-checked') {
    throw new Reject('synthetic-mismatch');
  }
  if (e.metrics !== null) {
    if (
      e.metrics.authenticity !== 'SYNTHETIC' ||
      e.metrics.freshness !== 'NOT_APPLICABLE' ||
      e.summary.label === null
    ) {
      throw new Reject('synthetic-mismatch');
    }
  }
}

function entries(value: unknown): ManifestEntry[] {
  if (!Array.isArray(value)) throw new Reject('invalid-structure');
  return (value as readonly unknown[]).map(entry);
}

function sorted(list: readonly ManifestEntry[]): void {
  for (let i = 1; i < list.length; i += 1) {
    const prev = list[i - 1];
    const cur = list[i];
    if (prev === undefined || cur === undefined) continue;
    if (prev.runId > cur.runId || (prev.runId === cur.runId && prev.runAttempt >= cur.runAttempt)) {
      throw new Reject(
        prev.runId === cur.runId && prev.runAttempt === cur.runAttempt
          ? 'duplicate-entry'
          : 'entries-not-sorted',
      );
    }
  }
}

function unique(lists: readonly (readonly ManifestEntry[])[]): void {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const e of list) {
      const k = `${String(e.runId)}/${String(e.runAttempt)}`;
      if (seen.has(k)) throw new Reject('duplicate-entry');
      seen.add(k);
    }
  }
}

function structure(raw: unknown): PublicationManifest {
  const top = exactKeys(raw, [
    'manifestSchemaVersion',
    'kind',
    'build',
    'results',
    'untrustedOrigin',
    'synthetic',
  ]);
  if (top.kind !== PUBLICATION_KIND) throw new Reject('wrong-kind');
  if (top.manifestSchemaVersion !== PUBLICATION_SCHEMA_VERSION) {
    throw new Reject('unsupported-version');
  }
  const b = exactKeys(top.build, ['sourceCommit', 'builtAt', 'policy']);
  const build = {
    sourceCommit: matching(SHA, b.sourceCommit),
    builtAt: utc(b.builtAt),
    policy: policy(b.policy),
  };
  const results = entries(top.results);
  const untrustedOrigin = entries(top.untrustedOrigin);
  let synthetic: PublicationManifest['synthetic'] = null;
  if (top.synthetic !== null) {
    const s = exactKeys(top.synthetic, ['label', 'results']);
    if (s.label !== SYNTHETIC_SECTION_LABEL) throw new Reject('synthetic-mismatch');
    synthetic = { label: SYNTHETIC_SECTION_LABEL, results: entries(s.results) };
  }
  if (
    results.length + untrustedOrigin.length + (synthetic?.results.length ?? 0) >
    MAX_PUBLICATION_ENTRIES
  ) {
    throw new Reject('too-many-entries');
  }
  for (const e of results) {
    if (isUntrusted(e)) throw new Reject('untrusted-in-results');
    realRules(e, build.builtAt);
  }
  for (const e of untrustedOrigin) {
    if (!isUntrusted(e)) throw new Reject('trusted-in-untrusted-origin');
    realRules(e, build.builtAt);
    // Untrusted-origin results never carry metrics (P1 publishes none for them).
    if (e.metrics !== null) throw new Reject('metrics-not-permitted');
  }
  for (const e of synthetic?.results ?? []) syntheticRules(e);
  sorted(results);
  sorted(untrustedOrigin);
  sorted(synthetic?.results ?? []);
  unique([results, untrustedOrigin]);
  return {
    manifestSchemaVersion: PUBLICATION_SCHEMA_VERSION,
    kind: PUBLICATION_KIND,
    build,
    results,
    untrustedOrigin,
    synthetic,
  };
}

function orderedCounts(counts: Partial<Record<Outcome, number>>): Partial<Record<Outcome, number>> {
  const out: Partial<Record<Outcome, number>> = {};
  for (const key of SORTED_OUTCOMES) {
    const v = counts[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function orderedEntry(e: ManifestEntry): ManifestEntry {
  return {
    runId: e.runId,
    runAttempt: e.runAttempt,
    headSha: e.headSha,
    event: e.event,
    gate: {
      state: e.gate.state,
      reasons: [...e.gate.reasons],
      authenticity: e.gate.authenticity,
      freshness: e.gate.freshness,
      verifiedAt: e.gate.verifiedAt,
    },
    summary: { state: e.summary.state, reasons: [...e.summary.reasons], label: e.summary.label },
    artifact: { id: e.artifact.id, digest: e.artifact.digest, integrity: e.artifact.integrity },
    metrics:
      e.metrics === null
        ? null
        : {
            authenticity: e.metrics.authenticity,
            freshness: e.metrics.freshness,
            summarySchemaVersion: e.metrics.summarySchemaVersion,
            totals: {
              attempts: e.metrics.totals.attempts,
              byExecutionOutcome: orderedCounts(e.metrics.totals.byExecutionOutcome),
              byInstanceOutcome: orderedCounts(e.metrics.totals.byInstanceOutcome),
              definitions: e.metrics.totals.definitions,
              executions: e.metrics.totals.executions,
              instances: e.metrics.totals.instances,
              retries: e.metrics.totals.retries,
              zeroAttemptExecutions: e.metrics.totals.zeroAttemptExecutions,
            },
            completeness: {
              ambiguousIdentities: e.metrics.completeness.ambiguousIdentities,
              droppedTags: e.metrics.completeness.droppedTags,
              inconsistentExecutions: e.metrics.completeness.inconsistentExecutions,
              invalidDurations: e.metrics.completeness.invalidDurations,
              invalidRetries: e.metrics.completeness.invalidRetries,
              omissionDetection: e.metrics.completeness.omissionDetection,
              provisionalOutcomes: e.metrics.completeness.provisionalOutcomes,
              shardAttribution: e.metrics.completeness.shardAttribution,
              statsCrossCheck: e.metrics.completeness.statsCrossCheck,
              unclassifiedAttempts: e.metrics.completeness.unclassifiedAttempts,
              unrecognizedProjectExecutions: e.metrics.completeness.unrecognizedProjectExecutions,
              unresolvedIdentities: e.metrics.completeness.unresolvedIdentities,
            },
          },
  };
}

/**
 * The canonical P1 serialization (fixed key order, two-space indentation, LF,
 * one trailing newline) of a validated manifest. Byte-identical to
 * `serializeManifest` in publication-manifest.ts, which the tests prove.
 */
export function canonicalPublicationText(m: PublicationManifest): string {
  const ordered: PublicationManifest = {
    manifestSchemaVersion: m.manifestSchemaVersion,
    kind: m.kind,
    build: {
      sourceCommit: m.build.sourceCommit,
      builtAt: m.build.builtAt,
      policy: {
        repositoryId: m.build.policy.repositoryId,
        repositoryFullName: m.build.policy.repositoryFullName,
        workflowId: m.build.policy.workflowId,
        workflowPath: m.build.policy.workflowPath,
        workflowName: m.build.policy.workflowName,
        trustedEvent: m.build.policy.trustedEvent,
        trustedBranch: m.build.policy.trustedBranch,
      },
    },
    results: m.results.map(orderedEntry),
    untrustedOrigin: m.untrustedOrigin.map(orderedEntry),
    synthetic:
      m.synthetic === null
        ? null
        : { label: m.synthetic.label, results: m.synthetic.results.map(orderedEntry) },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Strictly validates publication text. The text must be exactly the canonical
 * serialization of what it contains, so duplicate keys, escaped spellings,
 * reordering, extra whitespace and a byte-order mark are all refused. Never
 * throws; a rejection carries one fixed code and no input value.
 */
export function parsePublication(text: unknown): ParsedPublication {
  if (typeof text !== 'string') return { state: 'rejected', code: 'input-type' };
  if (text.length > MAX_PUBLICATION_BYTES || byteLength(text) > MAX_PUBLICATION_BYTES) {
    return { state: 'rejected', code: 'too-large' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { state: 'rejected', code: 'invalid-json' };
  }
  if (!withinDepth(raw, MAX_PUBLICATION_DEPTH)) return { state: 'rejected', code: 'too-deep' };
  try {
    const manifest = structure(raw);
    if (canonicalPublicationText(manifest) !== text) {
      return { state: 'rejected', code: 'not-canonical' };
    }
    return { state: 'valid', manifest: deepFreeze(manifest) };
  } catch (error) {
    if (error instanceof Reject) return { state: 'rejected', code: error.code };
    return { state: 'rejected', code: 'invalid-structure' };
  }
}

/* ------------------------------------------------------------------ *
 * Freshness (approved 30-day rule; the caller supplies the time)
 * ------------------------------------------------------------------ */

export type PublicationAgeView =
  | { readonly state: 'current' | 'stale'; readonly ageDays: number }
  | { readonly state: 'unknown'; readonly reason: 'invalid-clock' | 'clock-before-build' };

/**
 * Publication age from `builtAt` to the supplied viewer time, compared as UTC
 * milliseconds. Exactly 30 days is current; more than 30 days is stale. An
 * invalid time, or a clock earlier than `builtAt`, is unknown — never current.
 * Same rule as P1 `publicationAge`. Staleness never changes any verdict.
 */
export function publicationAgeOf(builtAt: string, now: unknown): PublicationAgeView {
  if (!isCanonicalUtc(builtAt) || !isCanonicalUtc(now)) {
    return { state: 'unknown', reason: 'invalid-clock' };
  }
  const ms = Date.parse(now) - Date.parse(builtAt);
  if (ms < 0) return { state: 'unknown', reason: 'clock-before-build' };
  return {
    state: ms > STALE_AFTER_DAYS * DAY_MS ? 'stale' : 'current',
    ageDays: Math.floor(ms / DAY_MS),
  };
}

export type VerificationAgeView =
  | { readonly state: 'not-recorded' }
  | { readonly state: 'not-applicable' }
  | { readonly state: 'recorded'; readonly verifiedAt: string; readonly ageDays: number }
  | { readonly state: 'unknown'; readonly verifiedAt: string };

/** Verification age of one claim, tracked separately from publication age. */
export function verificationAgeOf(
  verifiedAt: string | null,
  freshness: Freshness,
  now: unknown,
): VerificationAgeView {
  if (freshness === 'NOT_APPLICABLE') return { state: 'not-applicable' };
  if (verifiedAt === null) return { state: 'not-recorded' };
  if (!isCanonicalUtc(verifiedAt) || !isCanonicalUtc(now)) return { state: 'unknown', verifiedAt };
  const ms = Date.parse(now) - Date.parse(verifiedAt);
  if (ms < 0) return { state: 'unknown', verifiedAt };
  return { state: 'recorded', verifiedAt, ageDays: Math.floor(ms / DAY_MS) };
}

/* ------------------------------------------------------------------ *
 * View model
 * ------------------------------------------------------------------ */

/**
 * Where the text came from. Only the dashboard build's embedded data module
 * is `build-embedded`; anything else (a picked or pasted file) is `imported`
 * and can never show publisher authenticity.
 */
export type PublicationOrigin = 'build-embedded' | 'imported';

export type Section = 'results' | 'untrusted-origin' | 'synthetic';

/** How a claim may be styled. Only `verified` may ever look like an established result. */
export type ClaimStyling = 'verified' | 'retained-claim' | 'untrusted' | 'synthetic' | 'imported';

export interface ReasonView {
  readonly code: ReasonCode;
  readonly text: string;
}

export interface OutcomeCountView {
  readonly outcome: Outcome;
  readonly count: number;
}

export type MetricsView =
  | {
      readonly status: 'available';
      readonly authenticity: DisplayedAuthenticity;
      readonly freshness: Freshness;
      readonly summarySchemaVersion: string;
      readonly definitions: number;
      readonly instances: number;
      readonly executions: number;
      readonly attempts: number;
      readonly retries: number;
      readonly zeroAttemptExecutions: number;
      /** Every outcome in M8A severity order; absent keys are zero (M8A contract). */
      readonly byInstanceOutcome: readonly OutcomeCountView[];
      readonly byExecutionOutcome: readonly OutcomeCountView[];
      readonly completeness: BundleCompleteness;
    }
  | {
      /** Null metrics: unavailable, never zero. */
      readonly status: 'unavailable';
      readonly summaryState: SummaryState;
      readonly text: string;
      readonly reasons: readonly ReasonView[];
    };

export interface EntryView {
  readonly section: Section;
  readonly runId: number;
  readonly runAttempt: number;
  readonly headSha: string;
  readonly event: ManifestEntry['event'];
  readonly gate: {
    readonly state: VerdictState;
    readonly symbol: string;
    readonly label: string;
    /** `neutral` unless the claim is build-verified. */
    readonly tone: Tone;
    readonly styling: ClaimStyling;
    /** True only for a BUILD_VERIFIED VERIFIED_PASS in the real results section. */
    readonly isVerifiedPass: boolean;
    readonly reasons: readonly ReasonView[];
    readonly authenticity: DisplayedAuthenticity;
    readonly authenticityText: string;
    readonly freshness: Freshness;
    readonly freshnessText: string;
    readonly verificationAge: VerificationAgeView;
  };
  readonly summary: {
    readonly state: SummaryState;
    readonly text: string;
    readonly reasons: readonly ReasonView[];
  };
  readonly artifact: {
    readonly id: number | null;
    readonly digest: string | null;
    readonly integrity: Integrity;
    readonly integrityText: string;
  };
  readonly metrics: MetricsView;
}

export interface VerifiedTotalsView {
  /** BUILD_VERIFIED real results only; retained, untrusted, synthetic and imported never count. */
  readonly buildVerifiedResults: number;
  readonly byVerdict: readonly { readonly state: VerdictState; readonly count: number }[];
  readonly verifiedPasses: number;
}

export type PublicationViewModel =
  | {
      readonly state: 'valid';
      readonly origin: PublicationOrigin;
      readonly assertion: 'publisher-build-statement' | 'imported-not-authenticated';
      readonly build: {
        readonly sourceCommit: string;
        readonly builtAt: string;
        readonly policy: PublicPolicy;
      };
      readonly publicationAge: PublicationAgeView;
      readonly verifiedTotals: VerifiedTotalsView;
      readonly results: readonly EntryView[];
      readonly untrustedOrigin: readonly EntryView[];
      readonly synthetic: {
        readonly label: typeof SYNTHETIC_SECTION_LABEL;
        readonly results: readonly EntryView[];
      } | null;
    }
  | {
      readonly state: 'rejected';
      readonly origin: PublicationOrigin;
      readonly code: PublicationRejection;
    };

function reasonViews(codes: readonly ReasonCode[]): ReasonView[] {
  return codes.map((code) => ({ code, text: reasonText(code) }));
}

function outcomeView(counts: Partial<Record<Outcome, number>>): OutcomeCountView[] {
  return OUTCOMES.map((outcome) => ({ outcome, count: counts[outcome] ?? 0 }));
}

function stylingOf(e: ManifestEntry, section: Section, origin: PublicationOrigin): ClaimStyling {
  if (origin === 'imported') return 'imported';
  if (section === 'synthetic') return 'synthetic';
  if (section === 'untrusted-origin') return 'untrusted';
  return e.gate.authenticity === 'BUILD_VERIFIED' ? 'verified' : 'retained-claim';
}

function entryView(
  e: ManifestEntry,
  section: Section,
  origin: PublicationOrigin,
  now: unknown,
): EntryView {
  const styling = stylingOf(e, section, origin);
  const verdict = VERDICT_TEXT[e.gate.state];
  const authenticity: DisplayedAuthenticity =
    origin === 'imported' ? 'IMPORTED_UNAUTHENTICATED' : e.gate.authenticity;
  const metricsView: MetricsView =
    e.metrics === null
      ? {
          status: 'unavailable',
          summaryState: e.summary.state,
          text: SUMMARY_TEXT[e.summary.state],
          reasons: reasonViews(e.summary.reasons),
        }
      : {
          status: 'available',
          authenticity: origin === 'imported' ? 'IMPORTED_UNAUTHENTICATED' : e.metrics.authenticity,
          freshness: e.metrics.freshness,
          summarySchemaVersion: e.metrics.summarySchemaVersion,
          definitions: e.metrics.totals.definitions,
          instances: e.metrics.totals.instances,
          executions: e.metrics.totals.executions,
          attempts: e.metrics.totals.attempts,
          retries: e.metrics.totals.retries,
          zeroAttemptExecutions: e.metrics.totals.zeroAttemptExecutions,
          byInstanceOutcome: outcomeView(e.metrics.totals.byInstanceOutcome),
          byExecutionOutcome: outcomeView(e.metrics.totals.byExecutionOutcome),
          completeness: e.metrics.completeness,
        };
  return {
    section,
    runId: e.runId,
    runAttempt: e.runAttempt,
    headSha: e.headSha,
    event: e.event,
    gate: {
      state: e.gate.state,
      symbol: verdict.symbol,
      label: verdict.label,
      tone: styling === 'verified' ? verdict.tone : 'neutral',
      styling,
      isVerifiedPass: styling === 'verified' && e.gate.state === 'VERIFIED_PASS',
      reasons: reasonViews(e.gate.reasons),
      authenticity,
      authenticityText: AUTHENTICITY_TEXT[authenticity],
      freshness: e.gate.freshness,
      freshnessText: FRESHNESS_TEXT[e.gate.freshness],
      verificationAge: verificationAgeOf(e.gate.verifiedAt, e.gate.freshness, now),
    },
    summary: {
      state: e.summary.state,
      text: SUMMARY_TEXT[e.summary.state],
      reasons: reasonViews(e.summary.reasons),
    },
    artifact: {
      id: e.artifact.id,
      digest: e.artifact.digest,
      integrity: e.artifact.integrity,
      integrityText: INTEGRITY_TEXT[e.artifact.integrity],
    },
    metrics: metricsView,
  };
}

function totalsOf(results: readonly EntryView[]): VerifiedTotalsView {
  const counted = results.filter((r) => r.section === 'results' && r.gate.styling === 'verified');
  return {
    buildVerifiedResults: counted.length,
    byVerdict: VERDICT_STATES.map((state) => ({
      state,
      count: counted.filter((r) => r.gate.state === state).length,
    })),
    verifiedPasses: counted.filter((r) => r.gate.isVerifiedPass).length,
  };
}

/**
 * Maps a parsed publication to a presentation-ready model. Pure: `now` is the
 * viewer's current time as canonical ISO 8601 UTC, supplied by the caller
 * (any other value gives an unknown publication age). The origin decides the
 * highest authenticity that can be displayed; nothing in the text can raise it.
 */
export function buildPublicationViewModel(
  parsed: ParsedPublication,
  origin: PublicationOrigin,
  now: unknown,
): PublicationViewModel {
  const safeOrigin: PublicationOrigin = origin === 'build-embedded' ? 'build-embedded' : 'imported';
  if (parsed.state !== 'valid') {
    return deepFreeze({ state: 'rejected', origin: safeOrigin, code: parsed.code });
  }
  const m = parsed.manifest;
  const results = m.results.map((e) => entryView(e, 'results', safeOrigin, now));
  return deepFreeze({
    state: 'valid',
    origin: safeOrigin,
    assertion:
      safeOrigin === 'build-embedded' ? 'publisher-build-statement' : 'imported-not-authenticated',
    build: {
      sourceCommit: m.build.sourceCommit,
      builtAt: m.build.builtAt,
      policy: { ...m.build.policy },
    },
    publicationAge: publicationAgeOf(m.build.builtAt, now),
    verifiedTotals: totalsOf(results),
    results,
    untrustedOrigin: m.untrustedOrigin.map((e) =>
      entryView(e, 'untrusted-origin', safeOrigin, now),
    ),
    synthetic:
      m.synthetic === null
        ? null
        : {
            label: SYNTHETIC_SECTION_LABEL,
            results: m.synthetic.results.map((e) => entryView(e, 'synthetic', safeOrigin, now)),
          },
  });
}
