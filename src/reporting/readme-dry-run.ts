/**
 * Local README health refresh dry run (ADR-0013, Phase C5B).
 *
 *   parseDryRunArgs(argv)        -> DryRunArgs | undefined
 *   runReadmeDryRun(args, deps)  -> Promise<DryRunReport>
 *
 * Evaluates ONE candidate run attempt against the README's current pinned
 * snapshot with the C5A decision and renderer, and returns a report that is
 * explicitly labelled a dry run: the decision, its fixed reasons and
 * diagnostics, and — only for `refresh` — the proposed section text.
 *
 * Boundaries:
 *
 * - Explicit arguments only (`--run-id`, `--run-attempt`, `--readme`,
 *   `--prepared-on`); this module reads no environment variable.
 * - The README is read through an injected, bounded reader and validated
 *   before use: size, UTF-8, exactly one marker pair, an exact pin for the
 *   expected repository. An invalid README blocks; it is never guessed.
 * - Nothing is written: no README, file, branch, pull request or setting.
 *   No downloaded evidence or private verifier bundle is stored anywhere;
 *   archives are read in memory by `health-evidence.ts`.
 * - The transport is injected (`HealthEvidenceTransport`); the live one is
 *   `createHealthTransport` (`health-transport.ts`), wired by the entry
 *   script `scripts/readme-health-dry-run.ts`, which is the only reader of
 *   the token in this flow.
 * - `nodeReadReadme` is the one filesystem adapter: read-only, no-follow,
 *   regular files only, bounded, strict UTF-8.
 *
 * Free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

import {
  compareMetrics,
  isCalendarInstant,
  locateSection,
  metricIdentity,
  parseMetricsDigest,
  parseSnapshotPin,
  renderReadmeSection,
  replaceSection,
  type MetricComparison,
} from './readme-health.ts';
import {
  REFRESH_POLICY,
  decideRefresh,
  type RefreshAction,
  type RefreshReason,
} from './refresh-decision.ts';
import {
  EVIDENCE_POLICIES,
  assessHistory,
  collectHealthEvidence,
  type EvidenceDiagnostic,
  type EvidencePolicies,
  type HealthEvidenceTransport,
  type HistoryDiagnostic,
} from './health-evidence.ts';

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

export interface DryRunArgs {
  readonly runId: number;
  readonly runAttempt: number;
  /** Path of the README to evaluate against (read only). */
  readonly readme: string;
  /** `YYYY-MM-DD`, shown in a proposed section; no clock is read. */
  readonly preparedOn: string;
}

const FLAGS = ['--run-id', '--run-attempt', '--readme', '--prepared-on'] as const;
const POSITIVE = /^[1-9]\d{0,15}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ARG_LENGTH = 4096;

/** Every flag exactly once, each with a value; anything else is a usage error. */
export function parseDryRunArgs(argv: readonly string[]): DryRunArgs | undefined {
  if (argv.length !== FLAGS.length * 2) return undefined;
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || value === undefined) return undefined;
    if (!(FLAGS as readonly string[]).includes(flag) || values.has(flag)) return undefined;
    if (value.length === 0 || value.length > MAX_ARG_LENGTH || value.includes('\0')) {
      return undefined;
    }
    values.set(flag, value);
  }
  const runId = values.get('--run-id') ?? '';
  const runAttempt = values.get('--run-attempt') ?? '';
  const preparedOn = values.get('--prepared-on') ?? '';
  if (!POSITIVE.test(runId) || !POSITIVE.test(runAttempt) || !DAY.test(preparedOn)) {
    return undefined;
  }
  if (!isCalendarInstant(`${preparedOn}T00:00:00Z`)) return undefined;
  const id = Number(runId);
  const attempt = Number(runAttempt);
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(attempt)) return undefined;
  return { runId: id, runAttempt: attempt, readme: values.get('--readme') ?? '', preparedOn };
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

export const MAX_README_BYTES = 256 * 1024;

export type ReadmeReadResult =
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'missing' | 'too-large' | 'not-utf8' | 'unsafe' };

export interface DryRunDeps {
  readonly transport: HealthEvidenceTransport;
  /** Bounded, no-follow, read-only. Must not throw. */
  readonly readReadme: (path: string, maxBytes: number) => ReadmeReadResult;
  readonly policies?: EvidencePolicies;
}

export type ReadmeDiagnostic =
  | 'readme-unreadable'
  | 'readme-markers-invalid'
  | 'readme-pin-unreadable'
  | 'readme-metrics-digest-absent'
  | 'proposal-not-renderable'
  | 'proposal-not-applicable';

export interface DryRunReport {
  readonly kind: 'readme-health-dry-run';
  readonly dryRun: true;
  readonly action: RefreshAction;
  readonly reasons: readonly RefreshReason[];
  readonly candidate: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly sourceSha: string | null;
  };
  readonly metrics: MetricComparison;
  readonly diagnostics: readonly (EvidenceDiagnostic | HistoryDiagnostic | ReadmeDiagnostic)[];
  /** The section a refresh PR would contain; only for `refresh`. Never written. */
  readonly proposedSection: string | null;
}

const SHA = /^[0-9a-f]{40}$/;

/** Only a validated commit id ever reaches the report; anything else is null. */
function safeSha(value: unknown): string | null {
  return typeof value === 'string' && SHA.test(value) ? value : null;
}

function report(
  args: DryRunArgs,
  fields: Omit<DryRunReport, 'kind' | 'dryRun' | 'candidate'> & { sourceSha: string | null },
): DryRunReport {
  return {
    kind: 'readme-health-dry-run',
    dryRun: true,
    action: fields.action,
    reasons: fields.reasons,
    candidate: {
      runId: args.runId,
      runAttempt: args.runAttempt,
      sourceSha: safeSha(fields.sourceSha),
    },
    metrics: fields.metrics,
    diagnostics: fields.diagnostics,
    proposedSection: fields.proposedSection,
  };
}

/** Evaluates one candidate; never writes, never throws for remote data. */
export async function runReadmeDryRun(args: DryRunArgs, deps: DryRunDeps): Promise<DryRunReport> {
  const policies = deps.policies ?? EVIDENCE_POLICIES;
  const repository = policies.refresh.repository;
  const diagnostics: (EvidenceDiagnostic | HistoryDiagnostic | ReadmeDiagnostic)[] = [];

  // 1. The README, validated before anything is trusted.
  const readme = deps.readReadme(args.readme, MAX_README_BYTES);
  const readmeText = readme.status === 'ok' ? readme.text : undefined;
  if (readmeText === undefined) diagnostics.push('readme-unreadable');
  const located = readmeText === undefined ? undefined : locateSection(readmeText);
  if (located !== undefined && !located.ok) diagnostics.push('readme-markers-invalid');
  const section = located?.ok === true ? located.section : undefined;
  const pin = section === undefined ? undefined : parseSnapshotPin(section, repository);
  if (section !== undefined && pin === undefined) diagnostics.push('readme-pin-unreadable');
  const digest = section === undefined ? undefined : parseMetricsDigest(section);
  if (section !== undefined && digest === undefined) {
    diagnostics.push('readme-metrics-digest-absent');
  }

  // 2. Evidence (eligibility first; nothing is downloaded for an ineligible run).
  const evidence = await collectHealthEvidence(
    deps.transport,
    { runId: args.runId, runAttempt: args.runAttempt },
    policies,
  );
  diagnostics.push(...evidence.diagnostics);
  if (evidence.status === 'ineligible') {
    return report(args, {
      action: 'skip',
      reasons: evidence.reasons,
      sourceSha: evidence.candidate?.headSha ?? null,
      metrics: 'unavailable',
      diagnostics,
      proposedSection: null,
    });
  }

  // 3. History, only with a readable pin; otherwise the decision blocks.
  const history =
    pin === undefined
      ? undefined
      : await assessHistory(deps.transport, pin.sourceSha, evidence.candidate.headSha);
  if (history !== undefined) diagnostics.push(...history.diagnostics);
  const metrics = compareMetrics(digest, metricIdentity(evidence.model, evidence.verification));

  const decision = decideRefresh(
    {
      candidate: evidence.candidate,
      evidence: evidence.evidence,
      snapshot: pin,
      candidateVsSnapshot: history?.candidateVsSnapshot ?? 'unknown',
      candidateVsMain: history?.candidateVsMain ?? 'unknown',
      changesSinceSnapshotSource: history?.changesSinceSnapshotSource ?? null,
      changesSinceCandidateSource: history?.changesSinceCandidateSource ?? null,
      metrics,
    },
    policies.refresh,
  );

  // 4. The proposal, only for a refresh, checked against the real README.
  let proposedSection: string | null = null;
  if (decision.action === 'refresh' && readmeText !== undefined) {
    const rendered =
      evidence.verification.verdict === 'VERIFIED_PASS' &&
      evidence.verification.summary === 'SUMMARY_VERIFIED_ORIGIN' &&
      evidence.candidate.completedAt !== null
        ? renderReadmeSection({
            repository,
            completedAt: evidence.candidate.completedAt,
            verdict: 'VERIFIED_PASS',
            summary: 'SUMMARY_VERIFIED_ORIGIN',
            verdictSource: 'local-operator',
            preparedOn: args.preparedOn,
            maintenance: 'reviewed-automation-pr',
            model: evidence.model,
          })
        : undefined;
    if (rendered?.ok === true) {
      if (replaceSection(readmeText, rendered.section).ok) proposedSection = rendered.section;
      else diagnostics.push('proposal-not-applicable');
    } else {
      diagnostics.push('proposal-not-renderable');
    }
    if (proposedSection === null) {
      return report(args, {
        action: 'blocked',
        reasons: decision.reasons,
        sourceSha: evidence.candidate.headSha,
        metrics,
        diagnostics,
        proposedSection: null,
      });
    }
  }

  return report(args, {
    action: decision.action,
    reasons: decision.reasons,
    sourceSha: evidence.candidate.headSha,
    metrics,
    diagnostics,
    proposedSection,
  });
}

/**
 * Read-only README adapter: opens with `O_NOFOLLOW`, accepts a regular file
 * only, refuses anything over `maxBytes` before reading, and decodes strict
 * UTF-8. Never throws; never writes; never follows a symbolic link.
 */
export function nodeReadReadme(path: string, maxBytes: number): ReadmeReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile()) return { status: 'unsafe' };
    if (info.size > maxBytes) return { status: 'too-large' };
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > info.size) return { status: 'too-large' }; // grew while reading
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      return { status: 'ok', text };
    } catch {
      return { status: 'not-utf8' };
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === 'ELOOP' || code === 'EMLINK' ? { status: 'unsafe' } : { status: 'missing' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One labelled JSON document; aggregate fields only. */
export function serializeDryRunReport(report: DryRunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// Re-exported so a future entry script needs a single import surface.
export { REFRESH_POLICY };
