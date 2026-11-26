/**
 * Strict parser for local quality-verdict bundles (ADR-0011 P1). Pure.
 *
 *   parseVerdictBundle(input, expectedPolicy)          -> BundleParseResult
 *   parseRetainedBundle(bytes, pin, expectedPolicy)    -> BundleParseResult
 *   classifyImported(input, expectedPolicy)            -> ImportedClassification
 *
 * Reads the bundle written by the M8E-4 operator (`buildBundle` /
 * `serializeBundle` in `./verdict-cli.ts`, `bundleSchemaVersion` 1.0.0) and
 * accepts it only when every field, vocabulary and consistency rule holds and
 * the input is byte-identical to the operator's canonical serialization.
 *
 * VALIDATED STRUCTURE IS NOT AUTHENTICATED ORIGIN. A bundle is unsigned local
 * JSON: anyone who can edit the file can write any state into it, and its
 * SHA-256 only pins which file was selected. Every accepted bundle is
 * therefore returned with `authenticity: 'UNAUTHENTICATED'`. Nothing in this
 * module, and nothing built from its output, can carry `BUILD_VERIFIED`
 * (ADR-0011 "No self-promotion"); that claim exists only in
 * `./publication-manifest.ts`, for evidence the publication build itself
 * retrieved and reconciled.
 *
 * Consistency rules are derived from the committed reconciler
 * (`./verdict.ts`): a bundle the operator wrote always satisfies them, so a
 * violation means the file was not written by it unchanged.
 *
 * Diagnostics are fixed codes plus a schema path built from fixed key names;
 * no input value (and no unknown key name) is ever echoed.
 *
 * No filesystem, environment, network, clock or randomness; `node:crypto` is
 * used only to hash bytes the caller supplies. Free of `@/` imports so Node's
 * type-stripping test runner can load it directly (ADR-0002).
 */
import { createHash } from 'node:crypto';

import type { BUNDLE_KIND, BUNDLE_SCHEMA_VERSION } from './verdict-cli.ts';
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

/* ------------------------------------------------------------------ *
 * Limits and constants
 * ------------------------------------------------------------------ */

/** Largest bundle accepted, in UTF-8 bytes (ADR-0011 retained-bundle safeguard 2). */
export const MAX_BUNDLE_BYTES = 64 * 1024;
/** The deepest bundle structure is four levels (metrics.totals.byInstanceOutcome.<outcome>). */
export const MAX_BUNDLE_DEPTH = 6;
/** Largest counter accepted in metrics (matches the dashboard summary parser). */
export const MAX_COUNT = 100_000_000;
/** Largest run attempt accepted (GitHub allows at most 50 reruns). */
export const MAX_RUN_ATTEMPT = 1_000;

export const SUPPORTED_BUNDLE_SCHEMA_VERSION = '1.0.0' satisfies typeof BUNDLE_SCHEMA_VERSION;
export const SUPPORTED_BUNDLE_KIND = 'quality-verdict-bundle' satisfies typeof BUNDLE_KIND;

/** Verdicts that represent a completed, trusted pipeline (ADR-0010; `TRUSTED_COMPLETED` in verdict.ts). */
export const TRUSTED_VERDICTS = [
  'VERIFIED_PASS',
  'VERIFIED_FAIL',
  'EXECUTION_FAILED',
  'CANCELLED',
] as const satisfies readonly VerdictState[];

export const DIGEST_STATUSES = ['verified', 'mismatch', 'not-checked'] as const;
export type BundleDigestStatus = (typeof DIGEST_STATUSES)[number];

export const EVENT_CLASSES = ['push', 'pull_request', 'other'] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

export const STATS_CROSS_CHECKS = ['match', 'mismatch', 'unavailable'] as const;

/* ------------------------------------------------------------------ *
 * Reason-code vocabulary (runtime copy of the ReasonCode union)
 * ------------------------------------------------------------------ */

const SOURCES = ['run', 'jobs', 'ancestry', 'artifacts', 'archive'] as const;
type Source = (typeof SOURCES)[number];

function retrievalCodes(sources: readonly Source[]): ReasonCode[] {
  return sources.flatMap((s) => RETRIEVAL_FAILURES.map((f): ReasonCode => `retrieval-${s}-${f}`));
}

const IDENTITY_CONFLICTS = [
  'identity-run-id-mismatch',
  'identity-attempt-mismatch',
  'identity-job-attempt-mismatch',
  'identity-job-sha-mismatch',
  'identity-ancestry-sha-mismatch',
  'identity-duplicate-test-job',
  'identity-duplicate-gate-step',
] as const satisfies readonly ReasonCode[];

const OUTCOME_CONFLICTS = [
  'outcome-job-not-completed',
  'outcome-gate-success-job-not-success',
  'outcome-gate-failure-job-success',
  'outcome-run-success-job-not-success',
  'outcome-run-not-success-job-and-gate-success',
] as const satisfies readonly ReasonCode[];

const PROVENANCE = [
  'provenance-event',
  'provenance-branch',
  'provenance-repository',
  'provenance-head-repository',
  'provenance-workflow-id',
  'provenance-workflow-path',
  'provenance-workflow-name',
  'provenance-head-ahead-of-main',
  'provenance-diverged-from-main',
] as const satisfies readonly ReasonCode[];

const SUMMARY_CONFLICTS = [
  'artifact-duplicate',
  'artifact-run-mismatch',
  'artifact-repository-mismatch',
  'artifact-head-repository-mismatch',
  'artifact-sha-mismatch',
  'artifact-created-outside-attempt',
  'artifact-id-mismatch',
  'digest-mismatch',
  'summary-run-mismatch',
  'summary-attempt-mismatch',
  'summary-event-mismatch',
  'summary-sha-mismatch',
  'observed-inputs-contradict-gate',
] as const satisfies readonly ReasonCode[];

const OTHER_REASONS = [
  'invalid-request',
  'invalid-policy',
  'run-not-completed',
  'run-cancelled',
  'job-cancelled',
  'gate-success',
  'gate-failure',
  'job-failed-before-gate',
  'run-failed-without-test-job',
  'no-test-job',
  'gate-not-decisive',
  'unmapped-conclusion',
  'binding-run-attempt-unavailable',
  'artifact-absent',
  'artifact-expired',
  'archive-not-downloaded',
  'archive-unexpected-entries',
  'archive-too-large',
  'summary-missing',
  'summary-invalid',
  'summary-schema-mismatch',
  'verdict-not-trusted',
  'digest-contract-unconfirmed',
  'verified-origin',
] as const satisfies readonly ReasonCode[];

/** Every reason code the reconciler can emit, in a fixed order. */
export const REASON_CODES: readonly ReasonCode[] = Object.freeze([
  ...IDENTITY_CONFLICTS,
  ...OUTCOME_CONFLICTS,
  ...PROVENANCE,
  ...SUMMARY_CONFLICTS,
  ...OTHER_REASONS,
  ...retrievalCodes(SOURCES),
]);

type Listed =
  | (typeof IDENTITY_CONFLICTS)[number]
  | (typeof OUTCOME_CONFLICTS)[number]
  | (typeof PROVENANCE)[number]
  | (typeof SUMMARY_CONFLICTS)[number]
  | (typeof OTHER_REASONS)[number]
  | `retrieval-${Source}-${RetrievalFailure}`;
type AssertNever<T extends never> = T;
/** Compile-time proof that REASON_CODES covers the whole ReasonCode union. */
export type ReasonCodesCovered = AssertNever<Exclude<ReasonCode, Listed>>;

/**
 * Which reasons each state may carry, and how many. `one`: exactly one of the
 * set; `some`: a non-empty subset. Mirrors the reconciler's return sites.
 */
interface ReasonRule {
  readonly allowed: ReadonlySet<ReasonCode>;
  readonly arity: 'one' | 'some';
}
function rule(arity: 'one' | 'some', codes: readonly ReasonCode[]): ReasonRule {
  return { allowed: new Set(codes), arity };
}

const VERDICT_REASON_RULES: Readonly<Record<VerdictState, readonly ReasonRule[]>> = {
  VERIFIED_PASS: [rule('one', ['gate-success'])],
  VERIFIED_FAIL: [rule('one', ['gate-failure'])],
  EXECUTION_FAILED: [rule('one', ['job-failed-before-gate', 'run-failed-without-test-job'])],
  CANCELLED: [rule('some', ['job-cancelled', 'run-cancelled'])],
  PENDING: [rule('one', ['run-not-completed'])],
  UNTRUSTED_PROVENANCE: [rule('some', PROVENANCE)],
  // Identity conflicts return before outcome conflicts: never mixed.
  CONFLICT: [rule('some', IDENTITY_CONFLICTS), rule('some', OUTCOME_CONFLICTS)],
  UNKNOWN: [
    rule('some', retrievalCodes(['run', 'jobs', 'ancestry'])),
    rule('one', [
      'invalid-request',
      'invalid-policy',
      'no-test-job',
      'gate-not-decisive',
      'unmapped-conclusion',
    ]),
  ],
};

const SUMMARY_REASON_RULES: Readonly<Record<SummaryState, readonly ReasonRule[]>> = {
  SUMMARY_CONFLICT: [rule('some', SUMMARY_CONFLICTS)],
  SUMMARY_UNKNOWN: [
    rule('one', [
      ...retrievalCodes(['artifacts', 'archive']),
      'binding-run-attempt-unavailable',
      'invalid-request',
      'invalid-policy',
    ]),
  ],
  SUMMARY_UNAVAILABLE: [
    rule('one', ['artifact-absent', 'artifact-expired', 'archive-not-downloaded']),
  ],
  SUMMARY_INVALID: [
    rule('one', [
      'archive-too-large',
      'archive-unexpected-entries',
      'summary-missing',
      'summary-schema-mismatch',
      'summary-invalid',
    ]),
  ],
  SUMMARY_INFORMATIVE: [rule('some', ['digest-contract-unconfirmed', 'verdict-not-trusted'])],
  SUMMARY_VERIFIED_ORIGIN: [rule('one', ['verified-origin'])],
};

function reasonsFit(rules: readonly ReasonRule[], reasons: readonly ReasonCode[]): boolean {
  return rules.some(
    (r) =>
      reasons.length > 0 &&
      (r.arity === 'some' || reasons.length === 1) &&
      reasons.every((code) => r.allowed.has(code)),
  );
}

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** The public trust-policy fields recorded in a bundle and a manifest. */
export interface PublicPolicy {
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly workflowName: string;
  readonly trustedEvent: 'push';
  readonly trustedBranch: string;
}

export type OutcomeCounts = Readonly<Partial<Record<Outcome, number>>>;

export interface BundleTotals {
  readonly attempts: number;
  readonly byExecutionOutcome: OutcomeCounts;
  readonly byInstanceOutcome: OutcomeCounts;
  readonly definitions: number;
  readonly executions: number;
  readonly instances: number;
  readonly retries: number;
  readonly zeroAttemptExecutions: number;
}

export interface BundleCompleteness {
  readonly ambiguousIdentities: number;
  readonly droppedTags: number;
  readonly inconsistentExecutions: number;
  readonly invalidDurations: number;
  readonly invalidRetries: number;
  readonly omissionDetection: 'not-supported';
  readonly provisionalOutcomes: number;
  readonly shardAttribution: 'not-available';
  readonly statsCrossCheck: (typeof STATS_CROSS_CHECKS)[number];
  readonly unclassifiedAttempts: number;
  readonly unrecognizedProjectExecutions: number;
  readonly unresolvedIdentities: number;
}

export interface BundleMetrics {
  readonly summarySchemaVersion: string;
  readonly totals: BundleTotals;
  readonly completeness: BundleCompleteness;
}

/** A bundle's content after strict validation. Shape and key order of `VerdictBundle`. */
export interface BundleContent {
  readonly bundleSchemaVersion: typeof SUPPORTED_BUNDLE_SCHEMA_VERSION;
  readonly kind: typeof SUPPORTED_BUNDLE_KIND;
  readonly policy: PublicPolicy;
  readonly request: { readonly runId: number; readonly runAttempt: number };
  readonly identity: {
    readonly runId: number | null;
    readonly runAttempt: number | null;
    readonly headSha: string | null;
    readonly event: EventClass | null;
    readonly testJobId: number | null;
    readonly artifactId: number | null;
  };
  readonly verdict: { readonly state: VerdictState; readonly reasons: readonly ReasonCode[] };
  readonly summary: {
    readonly state: SummaryState;
    readonly reasons: readonly ReasonCode[];
    readonly metricsAvailable: boolean;
    readonly label: 'verified-origin' | 'unverified-origin' | null;
  };
  readonly artifact: { readonly id: number | null; readonly digest: BundleDigestStatus };
  readonly metrics: BundleMetrics | null;
}

/**
 * A structurally valid bundle. Always unauthenticated: the parser proves the
 * file is well formed and internally consistent, never who produced it.
 */
export interface UnauthenticatedBundle {
  readonly authenticity: 'UNAUTHENTICATED';
  readonly content: BundleContent;
}

export const BUNDLE_REJECTIONS = [
  'input-type',
  'too-large',
  'invalid-encoding',
  'invalid-json',
  'too-deep',
  'invalid-structure',
  'unknown-field',
  'missing-field',
  'invalid-value',
  'unsupported-version',
  'wrong-kind',
  'policy-mismatch',
  'request-identity-mismatch',
  'identity-incomplete',
  'artifact-id-mismatch',
  'reason-state-mismatch',
  'reasons-not-canonical',
  'invalid-request-inconsistent',
  'untrusted-verified-state',
  'verified-origin-without-digest',
  'digest-state-mismatch',
  'label-state-mismatch',
  'metrics-not-permitted',
  'metrics-missing',
  'non-canonical',
  'pin-invalid',
  'pin-mismatch',
  'hash-mismatch',
] as const;
export type BundleRejection = (typeof BUNDLE_REJECTIONS)[number];

export type BundleParseResult =
  | { readonly status: 'valid'; readonly bundle: UnauthenticatedBundle }
  | { readonly status: 'rejected'; readonly code: BundleRejection; readonly path: string | null };

/* ------------------------------------------------------------------ *
 * Primitive validation
 * ------------------------------------------------------------------ */

const SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SEMVER = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/;
const REPO_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml$/;
const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

type Rec = Readonly<Record<string, unknown>>;

/** Thrown internally only; converted to a fixed result at the module boundary. */
class Reject extends Error {
  readonly code: BundleRejection;
  readonly at: string | null;
  constructor(code: BundleRejection, at: string | null) {
    super(code);
    this.code = code;
    this.at = at;
  }
}

function isRec(value: unknown): value is Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

export function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function isRunAttempt(value: unknown): value is number {
  return isPositiveId(value) && value <= MAX_RUN_ATTEMPT;
}
export function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}
function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Exactly these keys, each present. Unknown key names are never echoed. */
function exactKeys(value: unknown, keys: readonly string[], at: string): Rec {
  if (!isRec(value)) throw new Reject('invalid-structure', at);
  const own = Object.keys(value);
  for (const key of own) {
    if (!keys.includes(key)) throw new Reject('unknown-field', at);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Reject('missing-field', `${at}.${key}`);
    }
  }
  return value;
}

function check<T>(ok: (v: unknown) => v is T, value: unknown, at: string): T {
  if (!ok(value)) throw new Reject('invalid-value', at);
  return value;
}

function count(value: unknown, at: string, min = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > MAX_COUNT
  ) {
    throw new Reject('invalid-value', at);
  }
  return value;
}

function nullable<T>(ok: (v: unknown) => v is T, value: unknown, at: string): T | null {
  return value === null ? null : check(ok, value, at);
}

/** Iterative bound on nesting depth, so hostile input cannot exhaust the stack. */
function withinDepth(root: unknown, maxDepth: number): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (typeof item.value !== 'object' || item.value === null) continue;
    if (item.depth > maxDepth) return false;
    for (const child of Object.values(item.value)) {
      stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

const POLICY_KEYS = [
  'repositoryId',
  'repositoryFullName',
  'workflowId',
  'workflowPath',
  'workflowName',
  'trustedEvent',
  'trustedBranch',
] as const;

/** Validates and copies the public policy fields, in the fixed key order. Returns undefined if invalid. */
export function publicPolicy(value: unknown): PublicPolicy | undefined {
  if (!isRec(value)) return undefined;
  const v = value;
  if (
    !isPositiveId(v.repositoryId) ||
    typeof v.repositoryFullName !== 'string' ||
    !REPO_SLUG.test(v.repositoryFullName) ||
    !isPositiveId(v.workflowId) ||
    typeof v.workflowPath !== 'string' ||
    !WORKFLOW_PATH.test(v.workflowPath) ||
    typeof v.workflowName !== 'string' ||
    !WORKFLOW_NAME.test(v.workflowName) ||
    v.trustedEvent !== 'push' ||
    typeof v.trustedBranch !== 'string' ||
    !BRANCH.test(v.trustedBranch)
  ) {
    return undefined;
  }
  return {
    repositoryId: v.repositoryId,
    repositoryFullName: v.repositoryFullName,
    workflowId: v.workflowId,
    workflowPath: v.workflowPath,
    workflowName: v.workflowName,
    trustedEvent: 'push',
    trustedBranch: v.trustedBranch,
  };
}

export function samePolicy(a: PublicPolicy, b: PublicPolicy): boolean {
  return POLICY_KEYS.every((k) => a[k] === b[k]);
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

function outcomeCounts(value: unknown, at: string): OutcomeCounts {
  if (!isRec(value)) throw new Reject('invalid-structure', at);
  for (const key of Object.keys(value)) {
    if (!oneOf(OUTCOMES, key)) throw new Reject('unknown-field', at);
  }
  // Alphabetical, as the operator's `plain()` copy writes them.
  const out: Partial<Record<Outcome, number>> = {};
  for (const key of [...OUTCOMES].sort()) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      out[key] = count(value[key], `${at}.${key}`, 1);
    }
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

function totals(value: unknown, at: string): BundleTotals {
  const t = exactKeys(value, TOTALS_KEYS, at);
  return {
    attempts: count(t.attempts, `${at}.attempts`),
    byExecutionOutcome: outcomeCounts(t.byExecutionOutcome, `${at}.byExecutionOutcome`),
    byInstanceOutcome: outcomeCounts(t.byInstanceOutcome, `${at}.byInstanceOutcome`),
    definitions: count(t.definitions, `${at}.definitions`),
    executions: count(t.executions, `${at}.executions`),
    instances: count(t.instances, `${at}.instances`),
    retries: count(t.retries, `${at}.retries`),
    zeroAttemptExecutions: count(t.zeroAttemptExecutions, `${at}.zeroAttemptExecutions`),
  };
}

function completeness(value: unknown, at: string): BundleCompleteness {
  const c = exactKeys(value, COMPLETENESS_KEYS, at);
  if (c.omissionDetection !== 'not-supported') {
    throw new Reject('invalid-value', `${at}.omissionDetection`);
  }
  if (c.shardAttribution !== 'not-available') {
    throw new Reject('invalid-value', `${at}.shardAttribution`);
  }
  return {
    ambiguousIdentities: count(c.ambiguousIdentities, `${at}.ambiguousIdentities`),
    droppedTags: count(c.droppedTags, `${at}.droppedTags`),
    inconsistentExecutions: count(c.inconsistentExecutions, `${at}.inconsistentExecutions`),
    invalidDurations: count(c.invalidDurations, `${at}.invalidDurations`),
    invalidRetries: count(c.invalidRetries, `${at}.invalidRetries`),
    omissionDetection: 'not-supported',
    provisionalOutcomes: count(c.provisionalOutcomes, `${at}.provisionalOutcomes`),
    shardAttribution: 'not-available',
    statsCrossCheck: check(
      (v): v is BundleCompleteness['statsCrossCheck'] => oneOf(STATS_CROSS_CHECKS, v),
      c.statsCrossCheck,
      `${at}.statsCrossCheck`,
    ),
    unclassifiedAttempts: count(c.unclassifiedAttempts, `${at}.unclassifiedAttempts`),
    unrecognizedProjectExecutions: count(
      c.unrecognizedProjectExecutions,
      `${at}.unrecognizedProjectExecutions`,
    ),
    unresolvedIdentities: count(c.unresolvedIdentities, `${at}.unresolvedIdentities`),
  };
}

function summarySchemaVersion(value: unknown, at: string): string {
  const match = typeof value === 'string' ? SEMVER.exec(value) : null;
  if (match === null || Number(match[1]) !== 1) throw new Reject('invalid-value', at);
  return match[0];
}

/** Strict metrics validation. Shared with the manifest, which copies these fields only. */
export function validMetrics(value: unknown): BundleMetrics | undefined {
  try {
    return metrics(value, 'metrics');
  } catch (error) {
    if (error instanceof Reject) return undefined;
    throw error;
  }
}

function metrics(value: unknown, at: string): BundleMetrics {
  const m = exactKeys(value, ['summarySchemaVersion', 'totals', 'completeness'], at);
  return {
    summarySchemaVersion: summarySchemaVersion(
      m.summarySchemaVersion,
      `${at}.summarySchemaVersion`,
    ),
    totals: totals(m.totals, `${at}.totals`),
    completeness: completeness(m.completeness, `${at}.completeness`),
  };
}

/* ------------------------------------------------------------------ *
 * Content
 * ------------------------------------------------------------------ */

const TOP_KEYS = [
  'bundleSchemaVersion',
  'kind',
  'policy',
  'request',
  'identity',
  'verdict',
  'summary',
  'artifact',
  'metrics',
] as const;

function reasons(value: unknown, at: string): ReasonCode[] {
  if (!Array.isArray(value)) throw new Reject('invalid-structure', at);
  const codes = value.map((code: unknown) =>
    check((v): v is ReasonCode => oneOf(REASON_CODES, v), code, `${at}[]`),
  );
  const canonical = [...new Set(codes)].sort();
  if (canonical.length !== codes.length || canonical.some((c, i) => c !== codes[i])) {
    throw new Reject('reasons-not-canonical', at);
  }
  return codes;
}

function structure(raw: unknown): BundleContent {
  const top = exactKeys(raw, TOP_KEYS, '$');
  if (top.kind !== SUPPORTED_BUNDLE_KIND) throw new Reject('wrong-kind', 'kind');
  if (top.bundleSchemaVersion !== SUPPORTED_BUNDLE_SCHEMA_VERSION) {
    throw new Reject('unsupported-version', 'bundleSchemaVersion');
  }

  const p = exactKeys(top.policy, POLICY_KEYS, 'policy');
  const policy = publicPolicy(p);
  if (policy === undefined) throw new Reject('invalid-value', 'policy');

  const rq = exactKeys(top.request, ['runId', 'runAttempt'], 'request');
  const request = {
    runId: check(isPositiveId, rq.runId, 'request.runId'),
    runAttempt: check(isRunAttempt, rq.runAttempt, 'request.runAttempt'),
  };

  const id = exactKeys(
    top.identity,
    ['runId', 'runAttempt', 'headSha', 'event', 'testJobId', 'artifactId'],
    'identity',
  );
  const identity = {
    runId: nullable(isPositiveId, id.runId, 'identity.runId'),
    runAttempt: nullable(isRunAttempt, id.runAttempt, 'identity.runAttempt'),
    headSha: nullable(isSha, id.headSha, 'identity.headSha'),
    event: nullable((v): v is EventClass => oneOf(EVENT_CLASSES, v), id.event, 'identity.event'),
    testJobId: nullable(isPositiveId, id.testJobId, 'identity.testJobId'),
    artifactId: nullable(isPositiveId, id.artifactId, 'identity.artifactId'),
  };

  const v = exactKeys(top.verdict, ['state', 'reasons'], 'verdict');
  const verdict = {
    state: check((x): x is VerdictState => oneOf(VERDICT_STATES, x), v.state, 'verdict.state'),
    reasons: reasons(v.reasons, 'verdict.reasons'),
  };

  const s = exactKeys(top.summary, ['state', 'reasons', 'metricsAvailable', 'label'], 'summary');
  const summary = {
    state: check((x): x is SummaryState => oneOf(SUMMARY_STATES, x), s.state, 'summary.state'),
    reasons: reasons(s.reasons, 'summary.reasons'),
    metricsAvailable: check(
      (x): x is boolean => typeof x === 'boolean',
      s.metricsAvailable,
      'summary.metricsAvailable',
    ),
    label: nullable(
      (x): x is 'verified-origin' | 'unverified-origin' =>
        x === 'verified-origin' || x === 'unverified-origin',
      s.label,
      'summary.label',
    ),
  };

  const a = exactKeys(top.artifact, ['id', 'digest'], 'artifact');
  const artifact = {
    id: nullable(isPositiveId, a.id, 'artifact.id'),
    digest: check(
      (x): x is BundleDigestStatus => oneOf(DIGEST_STATUSES, x),
      a.digest,
      'artifact.digest',
    ),
  };

  return {
    bundleSchemaVersion: SUPPORTED_BUNDLE_SCHEMA_VERSION,
    kind: SUPPORTED_BUNDLE_KIND,
    policy,
    request,
    identity,
    verdict,
    summary,
    artifact,
    metrics: top.metrics === null ? null : metrics(top.metrics, 'metrics'),
  };
}

const TRUSTED: readonly VerdictState[] = TRUSTED_VERDICTS;

/** Cross-field rules, derived from the reconciler and ADR-0011 safeguard 4. */
function consistency(b: BundleContent): void {
  const { identity, verdict, summary, artifact } = b;

  // Identity: established together from one run-attempt response, or not at all.
  const runFields = [identity.runId, identity.runAttempt, identity.headSha, identity.event];
  const established = runFields.every((f) => f !== null);
  if (!established && runFields.some((f) => f !== null)) {
    throw new Reject('identity-incomplete', 'identity');
  }
  // Fixed reason vocabulary per state (checked first: it confines the
  // identity-mismatch reasons to CONFLICT).
  if (!reasonsFit(VERDICT_REASON_RULES[verdict.state], verdict.reasons)) {
    throw new Reject('reason-state-mismatch', 'verdict.reasons');
  }
  if (!reasonsFit(SUMMARY_REASON_RULES[summary.state], summary.reasons)) {
    throw new Reject('reason-state-mismatch', 'summary.reasons');
  }

  // `request` equals `identity` wherever identity was established, EXCEPT for
  // the reconciler's own identity conflict (rule 1): it copies the run-attempt
  // response's `id` / `run_attempt` into `identity` and emits exactly
  // `identity-run-id-mismatch` / `identity-attempt-mismatch` when they differ
  // from the request. Each mismatch must carry its exact reason and each
  // reason its mismatch (biconditional); those reasons are CONFLICT-only
  // (reason rules above), so no other state can carry a mismatch.
  const runIdReason = verdict.reasons.includes('identity-run-id-mismatch');
  const attemptReason = verdict.reasons.includes('identity-attempt-mismatch');
  if (established) {
    if ((identity.runId !== b.request.runId) !== runIdReason) {
      throw new Reject('request-identity-mismatch', 'identity.runId');
    }
    if ((identity.runAttempt !== b.request.runAttempt) !== attemptReason) {
      throw new Reject('request-identity-mismatch', 'identity.runAttempt');
    }
  } else if (runIdReason || attemptReason) {
    // Emitted only when the run attempt was retrieved.
    throw new Reject('request-identity-mismatch', 'identity');
  }
  if (artifact.id !== identity.artifactId) throw new Reject('artifact-id-mismatch', 'artifact.id');

  const invalidInput = (r: readonly ReasonCode[]): boolean =>
    r.includes('invalid-request') || r.includes('invalid-policy');
  if (invalidInput(verdict.reasons) || invalidInput(summary.reasons)) {
    if (
      verdict.reasons.join() !== summary.reasons.join() ||
      runFields.some((f) => f !== null) ||
      identity.testJobId !== null ||
      identity.artifactId !== null
    ) {
      throw new Reject('invalid-request-inconsistent', 'verdict.reasons');
    }
  }
  const runNotRetrieved = verdict.reasons.some((r) => r.startsWith('retrieval-run-'));
  if (runNotRetrieved && established) throw new Reject('identity-incomplete', 'identity');

  // No verified (or pending) verdict without an established trusted push run.
  if (
    (TRUSTED.includes(verdict.state) || verdict.state === 'PENDING') &&
    identity.event !== 'push'
  ) {
    throw new Reject('untrusted-verified-state', 'verdict.state');
  }
  // A known non-push run is always CONFLICT or UNTRUSTED_PROVENANCE.
  if (
    identity.event !== null &&
    identity.event !== 'push' &&
    verdict.state !== 'CONFLICT' &&
    verdict.state !== 'UNTRUSTED_PROVENANCE'
  ) {
    throw new Reject('untrusted-verified-state', 'verdict.state');
  }

  // Digest status mirrors the summary exactly.
  const digestConflict = summary.reasons.includes('digest-mismatch');
  if ((artifact.digest === 'mismatch') !== digestConflict) {
    throw new Reject('digest-state-mismatch', 'artifact.digest');
  }
  if (artifact.digest !== 'not-checked' && artifact.id === null) {
    throw new Reject('digest-state-mismatch', 'artifact.id');
  }

  if (summary.state === 'SUMMARY_VERIFIED_ORIGIN') {
    if (
      !TRUSTED.includes(verdict.state) ||
      identity.event !== 'push' ||
      artifact.digest !== 'verified' ||
      artifact.id === null
    ) {
      throw new Reject('verified-origin-without-digest', 'summary.state');
    }
  }
  if (summary.state === 'SUMMARY_INFORMATIVE') {
    const notTrusted = summary.reasons.includes('verdict-not-trusted');
    const unconfirmed = summary.reasons.includes('digest-contract-unconfirmed');
    if (notTrusted === TRUSTED.includes(verdict.state)) {
      throw new Reject('reason-state-mismatch', 'summary.reasons');
    }
    if (artifact.id === null || (!unconfirmed && artifact.digest !== 'verified')) {
      throw new Reject('verified-origin-without-digest', 'summary.reasons');
    }
  }

  const expectedLabel =
    summary.state === 'SUMMARY_VERIFIED_ORIGIN'
      ? 'verified-origin'
      : summary.state === 'SUMMARY_INFORMATIVE'
        ? 'unverified-origin'
        : null;
  if (summary.label !== expectedLabel) throw new Reject('label-state-mismatch', 'summary.label');

  // Metrics only where the reconciler made them available; never zero-filled.
  if (summary.metricsAvailable && summary.label === null) {
    throw new Reject('metrics-not-permitted', 'summary.metricsAvailable');
  }
  if (b.metrics !== null && !summary.metricsAvailable) {
    throw new Reject('metrics-not-permitted', 'metrics');
  }
  if (b.metrics === null && summary.metricsAvailable)
    throw new Reject('metrics-missing', 'metrics');
}

/* ------------------------------------------------------------------ *
 * Canonical serialization (byte-identical to the operator's)
 * ------------------------------------------------------------------ */

/** Serializes validated content exactly as `serializeBundle` writes it. */
export function canonicalBundleText(content: BundleContent): string {
  const c = content;
  const ordered = {
    bundleSchemaVersion: c.bundleSchemaVersion,
    kind: c.kind,
    policy: {
      repositoryId: c.policy.repositoryId,
      repositoryFullName: c.policy.repositoryFullName,
      workflowId: c.policy.workflowId,
      workflowPath: c.policy.workflowPath,
      workflowName: c.policy.workflowName,
      trustedEvent: c.policy.trustedEvent,
      trustedBranch: c.policy.trustedBranch,
    },
    request: { runId: c.request.runId, runAttempt: c.request.runAttempt },
    identity: {
      runId: c.identity.runId,
      runAttempt: c.identity.runAttempt,
      headSha: c.identity.headSha,
      event: c.identity.event,
      testJobId: c.identity.testJobId,
      artifactId: c.identity.artifactId,
    },
    verdict: { state: c.verdict.state, reasons: [...c.verdict.reasons] },
    summary: {
      state: c.summary.state,
      reasons: [...c.summary.reasons],
      metricsAvailable: c.summary.metricsAvailable,
      label: c.summary.label,
    },
    artifact: { id: c.artifact.id, digest: c.artifact.digest },
    metrics:
      c.metrics === null
        ? null
        : {
            summarySchemaVersion: c.metrics.summarySchemaVersion,
            totals: orderedTotals(c.metrics.totals),
            completeness: orderedCompleteness(c.metrics.completeness),
          },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function orderedCounts(counts: OutcomeCounts): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...OUTCOMES].sort()) {
    const value = counts[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function orderedTotals(t: BundleTotals): BundleTotals {
  return {
    attempts: t.attempts,
    byExecutionOutcome: orderedCounts(t.byExecutionOutcome),
    byInstanceOutcome: orderedCounts(t.byInstanceOutcome),
    definitions: t.definitions,
    executions: t.executions,
    instances: t.instances,
    retries: t.retries,
    zeroAttemptExecutions: t.zeroAttemptExecutions,
  };
}

export function orderedCompleteness(c: BundleCompleteness): BundleCompleteness {
  return {
    ambiguousIdentities: c.ambiguousIdentities,
    droppedTags: c.droppedTags,
    inconsistentExecutions: c.inconsistentExecutions,
    invalidDurations: c.invalidDurations,
    invalidRetries: c.invalidRetries,
    omissionDetection: c.omissionDetection,
    provisionalOutcomes: c.provisionalOutcomes,
    shardAttribution: c.shardAttribution,
    statsCrossCheck: c.statsCrossCheck,
    unclassifiedAttempts: c.unclassifiedAttempts,
    unrecognizedProjectExecutions: c.unrecognizedProjectExecutions,
    unresolvedIdentities: c.unresolvedIdentities,
  };
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function rejected(code: BundleRejection, path: string | null): BundleParseResult {
  return deepFreeze({ status: 'rejected', code, path });
}

function decode(input: unknown): string | BundleParseResult {
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > MAX_BUNDLE_BYTES)
      return rejected('too-large', null);
    return input;
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_BUNDLE_BYTES) return rejected('too-large', null);
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      return rejected('invalid-encoding', null);
    }
  }
  return rejected('input-type', null);
}

/**
 * Strictly parses one bundle (UTF-8 text or bytes) against the expected
 * public trust policy. Deterministic and side-effect-free; never throws.
 * A `valid` result is still UNAUTHENTICATED.
 */
export function parseVerdictBundle(
  input: string | Uint8Array,
  expectedPolicy: PublicPolicy,
): BundleParseResult {
  const expected = publicPolicy(expectedPolicy);
  if (expected === undefined) return rejected('policy-mismatch', null);
  const text = decode(input);
  if (typeof text !== 'string') return text;

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return rejected('invalid-json', null);
  }
  if (!withinDepth(raw, MAX_BUNDLE_DEPTH)) return rejected('too-deep', null);

  let content: BundleContent;
  try {
    content = structure(raw);
    if (!samePolicy(content.policy, expected)) throw new Reject('policy-mismatch', 'policy');
    consistency(content);
  } catch (error) {
    if (error instanceof Reject) return rejected(error.code, error.at);
    return rejected('invalid-structure', null);
  }
  // Byte-identical to the operator's own serialization: rejects reordered or
  // duplicated keys, altered whitespace and any other hand edit.
  if (canonicalBundleText(content) !== text) return rejected('non-canonical', null);

  return deepFreeze({ status: 'valid', bundle: { authenticity: 'UNAUTHENTICATED', content } });
}

/** The allow-list entry that selects one retained bundle (ADR-0011 safeguard 1). */
export interface RetainedPin {
  readonly runId: number;
  readonly runAttempt: number;
  /** Expected SHA-256 of the exact file bytes, 64 lowercase hex. */
  readonly sha256: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parses a retained bundle selected by an allow-list pin. The hash pins WHICH
 * file was selected; it proves nothing about who wrote it. File ownership,
 * mode and type (safeguard 2) are checked by the publication adapter before
 * the bytes reach this function.
 */
export function parseRetainedBundle(
  bytes: Uint8Array,
  pin: RetainedPin,
  expectedPolicy: PublicPolicy,
): BundleParseResult {
  if (
    !isRec(pin) ||
    !isPositiveId(pin.runId) ||
    !isRunAttempt(pin.runAttempt) ||
    typeof pin.sha256 !== 'string' ||
    !SHA256_HEX.test(pin.sha256)
  ) {
    return rejected('pin-invalid', null);
  }
  if (!(bytes instanceof Uint8Array)) return rejected('input-type', null);
  if (bytes.byteLength > MAX_BUNDLE_BYTES) return rejected('too-large', null);
  if (sha256Hex(bytes) !== pin.sha256) return rejected('hash-mismatch', null);
  const parsed = parseVerdictBundle(bytes, expectedPolicy);
  if (parsed.status !== 'valid') return parsed;
  const request = parsed.bundle.content.request;
  if (request.runId !== pin.runId || request.runAttempt !== pin.runAttempt) {
    return rejected('pin-mismatch', 'request');
  }
  return parsed;
}

/** What a viewer-opened file may be shown as: a claim, never a verified result. */
export type ImportedClassification =
  | {
      readonly authenticity: 'IMPORTED_UNAUTHENTICATED';
      readonly claimedVerdict: VerdictState;
      readonly claimedSummary: SummaryState;
      readonly content: BundleContent;
    }
  | { readonly authenticity: 'REJECTED'; readonly code: BundleRejection };

/** Classifies a file opened locally (file picker). Capped at IMPORTED_UNAUTHENTICATED. */
export function classifyImported(
  input: string | Uint8Array,
  expectedPolicy: PublicPolicy,
): ImportedClassification {
  const parsed = parseVerdictBundle(input, expectedPolicy);
  if (parsed.status !== 'valid') {
    return deepFreeze({ authenticity: 'REJECTED', code: parsed.code });
  }
  const content = parsed.bundle.content;
  return deepFreeze({
    authenticity: 'IMPORTED_UNAUTHENTICATED',
    claimedVerdict: content.verdict.state,
    claimedSummary: content.summary.state,
    content,
  });
}
