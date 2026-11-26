/**
 * Publication manifest contract (ADR-0011 P1). Pure.
 *
 *   buildPublicationManifest(input) -> ManifestOutcome
 *
 * Projects explicitly supplied evidence into the deterministic, allow-listed
 * `quality-verdict-publication` 1.0.0 document that a later dashboard build
 * (P3) embeds. Five dimensions stay separate on every claim: the ADR-0010
 * Gate verdict, the ADR-0010 summary state, publication authenticity,
 * freshness, and real versus synthetic source.
 *
 * THE TRUSTED-EVIDENCE BOUNDARY
 *
 * A pure function cannot authenticate its caller, and TypeScript types give
 * no cryptographic assurance. What this module can guarantee is narrower and
 * explicit:
 *
 * - `BUILD_VERIFIED` is never accepted as an input value. There is no field
 *   through which a caller states a verdict, a summary state or an
 *   authenticity. A `build-verified` entry supplies only the RAW transport
 *   evidence (`Collected`: run attempt, jobs, ancestry, artifacts, archive
 *   check and parsed summary), and this module derives the Gate verdict and
 *   summary state itself, with the committed ADR-0010 reconciler, and the
 *   digest flag only from the archive's own `match` evidence.
 * - Anything read from a file (`UnauthenticatedBundle`, from
 *   `./verdict-bundle.ts`) can only become `RETAINED_UNAUTHENTICATED` or
 *   `SYNTHETIC`, whatever it claims, and is re-validated here.
 * - What remains a PUBLISHER ASSERTION, outside what any pure function can
 *   check: that `collected` came from the committed operator transport
 *   (`collectEvidence` in `./verdict-cli.ts`) in this same build process,
 *   talking to GitHub; that the working tree was clean at `sourceCommit`;
 *   and that `builtAt` is the real build time. The P2 controlled adapter is
 *   the only intended caller and must establish these (ADR-0011 trust
 *   boundary). Forged raw evidence passed by another caller is a residual
 *   risk of Model A, not something this module claims to detect.
 *
 * Fails closed: any rejection returns no manifest at all.
 *
 * No filesystem, environment, network, clock or randomness (`builtAt` and
 * any viewer time are explicit inputs); `node:crypto` only hashes the output
 * text. Free of `@/` imports (ADR-0002).
 */
import { createHash } from 'node:crypto';

import type { ParsedSummary } from './dashboard-model.ts';
import type { BaseTrustPolicy, Collected } from './verdict-cli.ts';
import {
  canonicalBundleText,
  isPositiveId,
  isRunAttempt,
  isSha,
  orderedCompleteness,
  orderedTotals,
  parseVerdictBundle,
  publicPolicy,
  validMetrics,
  type BundleCompleteness,
  type BundleContent,
  type BundleTotals,
  type EventClass,
  type PublicPolicy,
  type UnauthenticatedBundle,
} from './verdict-bundle.ts';
import {
  reconcile,
  type ReasonCode,
  type SummaryState,
  type VerdictResult,
  type VerdictState,
} from './verdict.ts';

/* ------------------------------------------------------------------ *
 * Contract constants
 * ------------------------------------------------------------------ */

export const MANIFEST_SCHEMA_VERSION = '1.0.0';
export const MANIFEST_KIND = 'quality-verdict-publication';
/** Largest serialized manifest, in UTF-8 bytes. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Largest number of entries across results, untrustedOrigin and synthetic. */
export const MAX_MANIFEST_ENTRIES = 500;
/** Approved: a publication older than this shows a stale notice (ADR-0011, 2026-11-26). */
export const STALE_PUBLICATION_DAYS = 30;
export const SYNTHETIC_LABEL = 'SYNTHETIC DEMONSTRATION DATA';

export const AUTHENTICITY_STATES = [
  'BUILD_VERIFIED',
  'RETAINED_UNAUTHENTICATED',
  'IMPORTED_UNAUTHENTICATED',
  'SYNTHETIC',
  'REJECTED',
] as const;
export type Authenticity = (typeof AUTHENTICITY_STATES)[number];
/** Authenticity values a published manifest entry can carry. */
export type PublishedAuthenticity = 'BUILD_VERIFIED' | 'RETAINED_UNAUTHENTICATED' | 'SYNTHETIC';

/**
 * CURRENT: established by this build. HISTORICAL: real retained evidence, not
 * re-verified. NOT_APPLICABLE: synthetic data, which is not evidence of any
 * real run and so has no freshness.
 */
export const FRESHNESS_STATES = ['CURRENT', 'HISTORICAL', 'NOT_APPLICABLE'] as const;
export type Freshness = (typeof FRESHNESS_STATES)[number];

export const INTEGRITY_STATES = [
  'verified-in-build',
  'retained-not-reverified',
  'mismatch',
  'not-checked',
] as const;
export type Integrity = (typeof INTEGRITY_STATES)[number];

/* ------------------------------------------------------------------ *
 * Output types (fixed key order is the declaration order)
 * ------------------------------------------------------------------ */

export interface ManifestMetrics {
  readonly authenticity: 'BUILD_VERIFIED' | 'SYNTHETIC';
  readonly freshness: Freshness;
  readonly summarySchemaVersion: string;
  readonly totals: BundleTotals;
  readonly completeness: BundleCompleteness;
}

export interface ManifestEntry {
  readonly runId: number;
  readonly runAttempt: number;
  readonly headSha: string;
  readonly event: EventClass;
  readonly gate: {
    readonly state: VerdictState;
    readonly reasons: readonly ReasonCode[];
    readonly authenticity: PublishedAuthenticity;
    readonly freshness: Freshness;
    readonly verifiedAt: string | null;
  };
  readonly summary: {
    readonly state: SummaryState;
    readonly reasons: readonly ReasonCode[];
    readonly label: 'verified-origin' | 'unverified-origin' | null;
  };
  readonly artifact: {
    readonly id: number | null;
    readonly digest: string | null;
    readonly integrity: Integrity;
  };
  readonly metrics: ManifestMetrics | null;
}

export interface PublicationManifest {
  readonly manifestSchemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly kind: typeof MANIFEST_KIND;
  readonly build: {
    readonly sourceCommit: string;
    readonly builtAt: string;
    readonly policy: PublicPolicy;
  };
  readonly results: readonly ManifestEntry[];
  readonly untrustedOrigin: readonly ManifestEntry[];
  readonly synthetic: {
    readonly label: typeof SYNTHETIC_LABEL;
    readonly results: readonly ManifestEntry[];
  } | null;
}

/* ------------------------------------------------------------------ *
 * Input types
 * ------------------------------------------------------------------ */

/**
 * Raw evidence for one allow-listed attempt, as returned by the committed
 * operator transport during THIS build. Carries no verdict, summary state or
 * authenticity: those are derived here.
 */
export interface BuildVerifiedInput {
  readonly kind: 'build-verified';
  readonly runId: number;
  readonly runAttempt: number;
  readonly collected: Pick<Collected, 'evidence' | 'summary' | 'digest'>;
  /** An allow-listed retained bundle for the same attempt, cross-checked (safeguard 5). */
  readonly retained: UnauthenticatedBundle | null;
}

/** A retained bundle published without re-verification (historical). */
export interface RetainedInput {
  readonly kind: 'retained';
  readonly runId: number;
  readonly runAttempt: number;
  readonly bundle: UnauthenticatedBundle;
}

export type ManifestEntryInput = BuildVerifiedInput | RetainedInput;

export interface ManifestInput {
  readonly build: {
    /** 40-hex commit the dashboard and operator are built from. */
    readonly sourceCommit: string;
    /** Explicit build time, ISO 8601 UTC. Never read from a clock here. */
    readonly builtAt: string;
    /** Publisher assertion, checked by the P2 adapter: must be exactly 'clean'. */
    readonly workingTree: 'clean';
    /** The project trust policy; `digestContractConfirmed` must be absent. */
    readonly policy: BaseTrustPolicy;
  };
  readonly entries: readonly ManifestEntryInput[];
  /** Bundles generated from repository fixtures for the demonstration view. */
  readonly synthetic: readonly UnauthenticatedBundle[] | null;
  /** Default false: pull-request and other untrusted-origin runs are excluded (open decision 1). */
  readonly includeUntrustedOrigin: boolean;
}

export const MANIFEST_REJECTIONS = [
  'invalid-input',
  'invalid-source-commit',
  'invalid-built-at',
  'working-tree-not-clean',
  'invalid-policy',
  'too-many-entries',
  'invalid-entry',
  'duplicate-entry',
  'request-mismatch',
  'invalid-evidence',
  'identity-mismatch',
  'retained-invalid',
  'retained-disagrees',
  'retained-identity-incomplete',
  'synthetic-invalid',
  'metrics-invalid',
  'too-large',
  'output-scan-failed',
] as const;
export type ManifestRejection = (typeof MANIFEST_REJECTIONS)[number];

/** An allow-listed attempt that was deliberately left out, with a fixed reason. */
export interface Omission {
  readonly runId: number;
  readonly runAttempt: number;
  readonly reason: 'run-not-retrievable' | 'untrusted-origin-excluded';
}

export type ManifestOutcome =
  | {
      readonly status: 'built';
      readonly manifest: PublicationManifest;
      /** Deterministic serialization: identical inputs give identical bytes. */
      readonly text: string;
      /** SHA-256 of `text` (UTF-8), 64 lowercase hex, for the build record. */
      readonly sha256: string;
      readonly omitted: readonly Omission[];
    }
  | {
      readonly status: 'rejected';
      readonly code: ManifestRejection;
      readonly runId: number | null;
      readonly runAttempt: number | null;
    };

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;

class Reject extends Error {
  readonly code: ManifestRejection;
  readonly runId: number | null;
  readonly runAttempt: number | null;
  constructor(code: ManifestRejection, at?: { runId: number; runAttempt: number }) {
    super(code);
    this.code = code;
    this.runId = at?.runId ?? null;
    this.runAttempt = at?.runAttempt ?? null;
  }
}

type Rec = Readonly<Record<string, unknown>>;
function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A real calendar instant written in canonical UTC form. */
export function isIsoUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  const iso = new Date(ms).toISOString();
  return iso === value || iso === value.replace('Z', '.000Z');
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function key(runId: number, runAttempt: number): string {
  return `${String(runId)}/${String(runAttempt)}`;
}

function byRun(a: ManifestEntry, b: ManifestEntry): number {
  return a.runId - b.runId || a.runAttempt - b.runAttempt;
}

function validPolicy(value: unknown): { full: BaseTrustPolicy; public: PublicPolicy } | undefined {
  if (!isRec(value) || Object.prototype.hasOwnProperty.call(value, 'digestContractConfirmed')) {
    return undefined;
  }
  const pub = publicPolicy(value);
  const name = (v: unknown): v is string =>
    typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(v);
  if (
    pub === undefined ||
    !name(value.testJobName) ||
    !name(value.gateStepName) ||
    !name(value.artifactNamePrefix)
  ) {
    return undefined;
  }
  return {
    full: {
      ...pub,
      testJobName: value.testJobName,
      gateStepName: value.gateStepName,
      artifactNamePrefix: value.artifactNamePrefix,
    },
    public: pub,
  };
}

/** Exact JSON-value equality: same keys at every level, same primitives, same array order. */
function sameJson(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return Object.is(a, b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v: unknown, i) => sameJson(v, b[i], depth + 1));
  }
  const ra = a as Rec;
  const rb = b as Rec;
  const ka = Object.keys(ra).sort();
  const kb = Object.keys(rb).sort();
  return (
    ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJson(ra[k], rb[k], depth + 1))
  );
}

/**
 * Re-validates a bundle object through the strict parser. A hand-built object
 * gains nothing: any field the parser would not produce (including an extra
 * authenticity claim at any level) is a rejection, not silently dropped.
 */
function revalidate(bundle: unknown, policy: PublicPolicy): BundleContent | undefined {
  if (
    !isRec(bundle) ||
    !sameJson(Object.keys(bundle).sort(), ['authenticity', 'content']) ||
    bundle.authenticity !== 'UNAUTHENTICATED' ||
    !isRec(bundle.content)
  ) {
    return undefined;
  }
  let text: string;
  try {
    text = canonicalBundleText(bundle.content as unknown as BundleContent);
  } catch {
    return undefined;
  }
  const parsed = parseVerdictBundle(text, policy);
  if (parsed.status !== 'valid' || !sameJson(parsed.bundle.content, bundle.content)) {
    return undefined;
  }
  return parsed.bundle.content;
}

function copyMetrics(
  value: unknown,
  authenticity: ManifestMetrics['authenticity'],
  freshness: Freshness,
): ManifestMetrics | undefined {
  const m = validMetrics(value);
  if (m === undefined) return undefined;
  return {
    authenticity,
    freshness,
    summarySchemaVersion: m.summarySchemaVersion,
    totals: orderedTotals(m.totals),
    completeness: orderedCompleteness(m.completeness),
  };
}

/* ------------------------------------------------------------------ *
 * Build-verified projection
 * ------------------------------------------------------------------ */

function archiveMatched(collected: BuildVerifiedInput['collected'], artifactId: number | null) {
  const archive = collected.evidence.archive;
  return (
    archive.status === 'downloaded' &&
    archive.digestCheck === 'match' &&
    artifactId !== null &&
    archive.artifactId === artifactId
  );
}

function apiDigest(collected: BuildVerifiedInput['collected'], artifactId: number | null) {
  const artifacts = collected.evidence.artifacts;
  if (artifactId === null || artifacts.status !== 'ok' || !Array.isArray(artifacts.value)) {
    return null;
  }
  const matches = (artifacts.value as readonly unknown[]).filter(
    (a): a is Rec => isRec(a) && a.id === artifactId,
  );
  const digest: unknown = matches.length === 1 ? matches[0]?.digest : null;
  return typeof digest === 'string' && DIGEST.test(digest) ? digest : null;
}

function buildMetrics(
  result: VerdictResult,
  summary: ParsedSummary | null,
  matched: boolean,
  at: { runId: number; runAttempt: number },
): ManifestMetrics | null {
  // BUILD_VERIFIED metrics only: verified origin, digest matched in this build.
  if (
    result.summary.state !== 'SUMMARY_VERIFIED_ORIGIN' ||
    !result.summary.metricsAvailable ||
    !matched ||
    summary === null ||
    summary.state !== 'valid'
  ) {
    return null;
  }
  const v = summary.validated;
  const m = copyMetrics(
    {
      summarySchemaVersion: v.schemaVersion,
      totals: v.summary.totals,
      completeness: v.summary.completeness,
    },
    'BUILD_VERIFIED',
    'CURRENT',
  );
  if (m === undefined) throw new Reject('metrics-invalid', at);
  return m;
}

type Projected =
  { readonly kind: 'entry'; readonly entry: ManifestEntry } | { readonly kind: 'not-retrievable' };

function projectBuildVerified(
  input: BuildVerifiedInput,
  policy: BaseTrustPolicy,
  builtAt: string,
): Projected {
  const at = { runId: input.runId, runAttempt: input.runAttempt };
  const collected = input.collected;
  if (!isRec(collected) || !isRec(collected.evidence) || !isRec(collected.evidence.request)) {
    throw new Reject('invalid-evidence', at);
  }
  const request = collected.evidence.request;
  if (request.runId !== input.runId || request.runAttempt !== input.runAttempt) {
    throw new Reject('request-mismatch', at);
  }

  // The digest flag is decided by THIS archive's own evidence, as the operator does.
  const archive = collected.evidence.archive;
  const digestContractConfirmed =
    collected.digest === 'verified' &&
    isRec(archive) &&
    archive.status === 'downloaded' &&
    archive.digestCheck === 'match';
  const result = reconcile(collected.summary, collected.evidence, {
    ...policy,
    digestContractConfirmed,
  });

  const reasons = result.verdict.reasons;
  if (reasons.includes('invalid-request') || reasons.includes('invalid-policy')) {
    throw new Reject('invalid-evidence', at);
  }
  // Nothing re-established: no BUILD_VERIFIED claim (approved freshness policy).
  if (reasons.some((r) => r.startsWith('retrieval-'))) return { kind: 'not-retrievable' };

  const id = result.identity;
  if (
    id.runId !== input.runId ||
    id.runAttempt !== input.runAttempt ||
    id.headSha === null ||
    id.event === null
  ) {
    throw new Reject('identity-mismatch', at);
  }

  const matched = archiveMatched(collected, id.artifactId);
  const integrity: Integrity = matched
    ? 'verified-in-build'
    : isRec(archive) && archive.status === 'downloaded' && archive.digestCheck === 'mismatch'
      ? 'mismatch'
      : 'not-checked';

  return {
    kind: 'entry',
    entry: {
      runId: input.runId,
      runAttempt: input.runAttempt,
      headSha: id.headSha,
      event: id.event,
      gate: {
        state: result.verdict.state,
        reasons: [...result.verdict.reasons],
        authenticity: 'BUILD_VERIFIED',
        freshness: 'CURRENT',
        verifiedAt: builtAt,
      },
      summary: {
        state: result.summary.state,
        reasons: [...result.summary.reasons],
        label: result.summary.label,
      },
      artifact: { id: id.artifactId, digest: apiDigest(collected, id.artifactId), integrity },
      metrics: buildMetrics(result, collected.summary, matched, at),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Retained and synthetic projection
 * ------------------------------------------------------------------ */

function projectFromBundle(
  content: BundleContent,
  authenticity: 'RETAINED_UNAUTHENTICATED' | 'SYNTHETIC',
): ManifestEntry | undefined {
  const id = content.identity;
  if (id.headSha === null || id.event === null) return undefined;
  // An identity conflict (the response was for another run or attempt) has no
  // head SHA attributable to the requested attempt: never published.
  if (id.runId !== content.request.runId || id.runAttempt !== content.request.runAttempt) {
    throw new Reject('identity-mismatch', content.request);
  }
  const synthetic = authenticity === 'SYNTHETIC';
  return {
    runId: content.request.runId,
    runAttempt: content.request.runAttempt,
    headSha: id.headSha,
    event: id.event,
    gate: {
      state: content.verdict.state,
      reasons: [...content.verdict.reasons],
      authenticity,
      freshness: synthetic ? 'NOT_APPLICABLE' : 'HISTORICAL',
      // Bundle schema 1.0.0 records no verification time; never inferred.
      verifiedAt: null,
    },
    summary: {
      state: content.summary.state,
      reasons: [...content.summary.reasons],
      label: content.summary.label,
    },
    artifact: {
      id: content.artifact.id,
      // The bundle records only a digest status, never the digest value.
      digest: null,
      integrity:
        synthetic || content.artifact.digest === 'not-checked'
          ? 'not-checked'
          : 'retained-not-reverified',
    },
    // Historical retained metrics are disabled (approved policy); synthetic
    // metrics stay in the synthetic section only.
    metrics:
      synthetic && content.metrics !== null
        ? (copyMetrics(content.metrics, 'SYNTHETIC', 'NOT_APPLICABLE') ?? null)
        : null,
  };
}

function sameGate(a: ManifestEntry, b: ManifestEntry): boolean {
  return (
    a.gate.state === b.gate.state &&
    a.gate.reasons.join() === b.gate.reasons.join() &&
    a.headSha === b.headSha &&
    a.event === b.event
  );
}

function untrusted(entry: ManifestEntry): boolean {
  return entry.event !== 'push' || entry.gate.state === 'UNTRUSTED_PROVENANCE';
}

/* ------------------------------------------------------------------ *
 * Serialization and output checks
 * ------------------------------------------------------------------ */

function orderedEntry(e: ManifestEntry): ManifestEntry {
  return {
    runId: e.runId,
    runAttempt: e.runAttempt,
    headSha: e.headSha,
    event: e.event,
    gate: {
      state: e.gate.state,
      reasons: [...e.gate.reasons].sort(),
      authenticity: e.gate.authenticity,
      freshness: e.gate.freshness,
      verifiedAt: e.gate.verifiedAt,
    },
    summary: {
      state: e.summary.state,
      reasons: [...e.summary.reasons].sort(),
      label: e.summary.label,
    },
    artifact: { id: e.artifact.id, digest: e.artifact.digest, integrity: e.artifact.integrity },
    metrics:
      e.metrics === null
        ? null
        : {
            authenticity: e.metrics.authenticity,
            freshness: e.metrics.freshness,
            summarySchemaVersion: e.metrics.summarySchemaVersion,
            totals: orderedTotals(e.metrics.totals),
            completeness: orderedCompleteness(e.metrics.completeness),
          },
  };
}

/** Fixed key order, two-space indentation, LF, one trailing newline. */
export function serializeManifest(manifest: PublicationManifest): string {
  const m = manifest;
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
    results: [...m.results].sort(byRun).map(orderedEntry),
    untrustedOrigin: [...m.untrustedOrigin].sort(byRun).map(orderedEntry),
    synthetic:
      m.synthetic === null
        ? null
        : {
            label: m.synthetic.label,
            results: [...m.synthetic.results].sort(byRun).map(orderedEntry),
          },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Defence in depth over the serialized text: every value is already drawn
 * from fixed vocabularies and validated formats, so none of these markers can
 * appear unless a validation rule regressed.
 */
const FORBIDDEN_MARKERS = [
  '://',
  'http:',
  'https:',
  'bearer',
  'token',
  'ghp_',
  'gho_',
  'ghs_',
  'ghu_',
  'github_pat_',
  'sig=',
  'se=',
  'blob.core.windows.net',
  '/users/',
  '/home/',
  '/private/',
  '/tmp/',
  '/var/',
  '~/',
  '\\\\',
  'qualityverdictevidence',
  'quality-verdict-bundle',
  'canary',
] as const;

export function outputScan(text: string): boolean {
  const lower = text.toLowerCase();
  return FORBIDDEN_MARKERS.every((marker) => !lower.includes(marker));
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function fail(
  code: ManifestRejection,
  runId: number | null = null,
  runAttempt: number | null = null,
): ManifestOutcome {
  return deepFreeze({ status: 'rejected', code, runId, runAttempt });
}

/**
 * Builds the publication manifest from explicitly supplied inputs.
 * Deterministic and side-effect-free; never throws. Any rejection returns
 * no manifest (fail closed).
 */
export function buildPublicationManifest(input: ManifestInput): ManifestOutcome {
  if (!isRec(input) || !isRec(input.build) || !Array.isArray(input.entries)) {
    return fail('invalid-input');
  }
  const { build } = input;
  if (!isSha(build.sourceCommit)) return fail('invalid-source-commit');
  if (!isIsoUtc(build.builtAt)) return fail('invalid-built-at');
  if (build.workingTree !== 'clean') return fail('working-tree-not-clean');
  const policy = validPolicy(build.policy);
  if (policy === undefined) return fail('invalid-policy');
  if (typeof input.includeUntrustedOrigin !== 'boolean') return fail('invalid-input');
  const synthetic = input.synthetic;
  if (synthetic !== null && !Array.isArray(synthetic)) return fail('invalid-input');
  if (input.entries.length + (synthetic?.length ?? 0) > MAX_MANIFEST_ENTRIES) {
    return fail('too-many-entries');
  }

  const results: ManifestEntry[] = [];
  const untrustedOrigin: ManifestEntry[] = [];
  const omitted: Omission[] = [];
  const seen = new Set<string>();

  try {
    for (const raw of input.entries as readonly unknown[]) {
      if (
        !isRec(raw) ||
        (raw.kind !== 'build-verified' && raw.kind !== 'retained') ||
        !isPositiveId(raw.runId) ||
        !isRunAttempt(raw.runAttempt)
      ) {
        throw new Reject('invalid-entry');
      }
      const at = { runId: raw.runId, runAttempt: raw.runAttempt };
      const k = key(at.runId, at.runAttempt);
      if (seen.has(k)) throw new Reject('duplicate-entry', at);
      seen.add(k);

      let entry: ManifestEntry | undefined;
      let retained: BundleContent | undefined;
      const retainedRaw = raw.kind === 'retained' ? raw.bundle : raw.retained;
      if (retainedRaw !== null && retainedRaw !== undefined) {
        retained = revalidate(retainedRaw, policy.public);
        if (retained === undefined) throw new Reject('retained-invalid', at);
        if (retained.request.runId !== at.runId || retained.request.runAttempt !== at.runAttempt) {
          throw new Reject('request-mismatch', at);
        }
      } else if (raw.kind === 'retained') {
        throw new Reject('retained-invalid', at);
      }
      const retainedEntry =
        retained === undefined
          ? undefined
          : projectFromBundle(retained, 'RETAINED_UNAUTHENTICATED');
      if (retained !== undefined && retainedEntry === undefined) {
        throw new Reject('retained-identity-incomplete', at);
      }

      if (raw.kind === 'build-verified') {
        const projected = projectBuildVerified(
          raw as unknown as BuildVerifiedInput,
          policy.full,
          build.builtAt,
        );
        if (projected.kind === 'entry') {
          // Safeguard 5: a rebuilt verdict and a retained record must agree.
          if (retainedEntry !== undefined && !sameGate(projected.entry, retainedEntry)) {
            throw new Reject('retained-disagrees', at);
          }
          entry = projected.entry;
        } else {
          entry = retainedEntry;
          if (entry === undefined) omitted.push({ ...at, reason: 'run-not-retrievable' });
        }
      } else {
        entry = retainedEntry;
      }

      if (entry === undefined) continue;
      if (untrusted(entry)) {
        if (input.includeUntrustedOrigin) untrustedOrigin.push(entry);
        else omitted.push({ ...at, reason: 'untrusted-origin-excluded' });
      } else {
        results.push(entry);
      }
    }

    let syntheticSection: PublicationManifest['synthetic'] = null;
    if (synthetic !== null) {
      const synthResults: ManifestEntry[] = [];
      const synthSeen = new Set<string>();
      for (const bundle of synthetic as readonly unknown[]) {
        const content = revalidate(bundle, policy.public);
        const entry = content === undefined ? undefined : projectFromBundle(content, 'SYNTHETIC');
        if (entry === undefined) throw new Reject('synthetic-invalid');
        const k = key(entry.runId, entry.runAttempt);
        if (synthSeen.has(k)) throw new Reject('duplicate-entry', entry);
        synthSeen.add(k);
        synthResults.push(entry);
      }
      syntheticSection = { label: SYNTHETIC_LABEL, results: synthResults };
    }

    const manifest: PublicationManifest = {
      manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: MANIFEST_KIND,
      build: { sourceCommit: build.sourceCommit, builtAt: build.builtAt, policy: policy.public },
      results,
      untrustedOrigin,
      synthetic: syntheticSection,
    };
    const text = serializeManifest(manifest);
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > MAX_MANIFEST_BYTES) return fail('too-large');
    if (!outputScan(text)) return fail('output-scan-failed');

    const finalManifest = JSON.parse(text) as PublicationManifest;
    return deepFreeze({
      status: 'built',
      manifest: finalManifest,
      text,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      omitted: [...omitted].sort((a, b) => a.runId - b.runId || a.runAttempt - b.runAttempt),
    });
  } catch (error) {
    if (error instanceof Reject) return fail(error.code, error.runId, error.runAttempt);
    return fail('invalid-input');
  }
}

/* ------------------------------------------------------------------ *
 * Totals and freshness (for the future dashboard view model)
 * ------------------------------------------------------------------ */

/**
 * Counts Gate verdicts that THIS build verified, by state. Only `results`
 * entries with `BUILD_VERIFIED` count: retained, untrusted-origin and
 * synthetic entries never do.
 */
export function verifiedTotals(
  manifest: PublicationManifest,
): Readonly<Partial<Record<VerdictState, number>>> {
  const totals: Partial<Record<VerdictState, number>> = {};
  for (const entry of manifest.results) {
    if (entry.gate.authenticity !== 'BUILD_VERIFIED') continue;
    totals[entry.gate.state] = (totals[entry.gate.state] ?? 0) + 1;
  }
  return totals;
}

export type PublicationAge =
  { readonly state: 'current' | 'stale'; readonly ageDays: number } | { readonly state: 'unknown' };

/**
 * Publication age against an explicit viewer time. Stale when the viewer's
 * clock is more than STALE_PUBLICATION_DAYS past `builtAt`. A viewer clock
 * before `builtAt`, or an invalid time, is `unknown` (never "current").
 */
export function publicationAge(builtAt: string, now: string): PublicationAge {
  if (!isIsoUtc(builtAt) || !isIsoUtc(now)) return { state: 'unknown' };
  const ms = Date.parse(now) - Date.parse(builtAt);
  if (ms < 0) return { state: 'unknown' };
  return {
    state: ms > STALE_PUBLICATION_DAYS * DAY_MS ? 'stale' : 'current',
    ageDays: Math.floor(ms / DAY_MS),
  };
}

export type VerificationAge =
  | { readonly state: 'not-recorded' }
  | { readonly state: 'recorded'; readonly ageDays: number }
  | { readonly state: 'unknown' };

/**
 * Verification age, tracked separately from publication age. A missing
 * `verifiedAt` is "not recorded" and is never inferred from any other time.
 */
export function verificationAge(verifiedAt: string | null, now: string): VerificationAge {
  if (verifiedAt === null) return { state: 'not-recorded' };
  if (!isIsoUtc(verifiedAt) || !isIsoUtc(now)) return { state: 'unknown' };
  const ms = Date.parse(now) - Date.parse(verifiedAt);
  if (ms < 0) return { state: 'unknown' };
  return { state: 'recorded', ageDays: Math.floor(ms / DAY_MS) };
}
