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
  REFRESH_REASONS,
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

export const README_DIAGNOSTICS = [
  'readme-unreadable',
  'readme-markers-invalid',
  'readme-pin-unreadable',
  'readme-metrics-digest-absent',
  'proposal-not-renderable',
  'proposal-not-applicable',
] as const;
export type ReadmeDiagnostic = (typeof README_DIAGNOSTICS)[number];

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

/* ------------------------------------------------------------------ *
 * Reading a report back and summarising it (C5C workflow summary)
 * ------------------------------------------------------------------ */

export const MAX_REPORT_BYTES = 512 * 1024;
const ACTIONS: readonly RefreshAction[] = ['refresh', 'no-op', 'skip', 'blocked'];
const METRICS: readonly MetricComparison[] = ['same', 'different', 'unavailable'];
const REPORT_KEYS = [
  'kind',
  'dryRun',
  'action',
  'reasons',
  'candidate',
  'metrics',
  'diagnostics',
  'proposedSection',
];
/**
 * Every evidence and history diagnostic code, as runtime lists. `satisfies`
 * rejects a code the types do not define; the unit tests also assert at
 * compile time that no defined code is missing.
 */
export const EVIDENCE_DIAGNOSTIC_CODES = [
  ...(['unit', 'health'] as const).flatMap((kind) =>
    (
      [
        'missing',
        'duplicate',
        'unbound',
        'expired',
        'declared-too-large',
        'digest-missing',
        'download-failed',
        'download-expired',
        'download-too-large',
        'digest-mismatch',
        'unexpected-entries',
        'archive-too-large',
        'archive-malformed',
      ] as const
    ).map((problem) => `${kind}-artifact-${problem}` as const),
  ),
  'run-metadata-unavailable',
  'run-identity-mismatch',
  'latest-attempt-unavailable',
  'attempt-completion-unavailable',
  'artifact-list-unavailable',
  'storage-redirect-refused',
  'summary-digest-mismatch',
  'health-bundle-json-invalid',
  'health-bundle-recompute-mismatch',
  'unit-provenance-mismatch',
  'playwright-provenance-mismatch',
] as const satisfies readonly EvidenceDiagnostic[];

export const HISTORY_DIAGNOSTIC_CODES = [
  'main-tip-unavailable',
  'snapshot-comparison-unavailable',
  'main-comparison-unavailable',
  'changes-since-snapshot-incomplete',
  'changes-since-candidate-incomplete',
] as const satisfies readonly HistoryDiagnostic[];

/** The exact set of diagnostic codes a report may carry. */
const KNOWN_DIAGNOSTICS: ReadonlySet<string> = new Set<string>([
  ...EVIDENCE_DIAGNOSTIC_CODES,
  ...HISTORY_DIAGNOSTIC_CODES,
  ...README_DIAGNOSTICS,
]);
const MAX_SECTION_CHARS = 64 * 1024;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function positiveSafe(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Strictly re-validates a serialized report before it is summarised: at most
 * `MAX_REPORT_BYTES` before parsing, exact keys, the dry-run label, known
 * actions, reasons and metric states, diagnostics from the exact known set,
 * a validated SHA or null, and — for `refresh` only — a validated SHA and a
 * non-empty proposed section (every other action has a null proposal).
 * Anything else is `undefined`; nothing is guessed.
 */
export function parseDryRunReport(text: string): DryRunReport | undefined {
  // Bounded before parsing: an oversized report is never handed to JSON.parse.
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_REPORT_BYTES) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!exactKeys(value, REPORT_KEYS)) return undefined;
  const { kind, dryRun, action, reasons, candidate, metrics, diagnostics, proposedSection } = value;
  if (kind !== 'readme-health-dry-run' || dryRun !== true) return undefined;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return undefined;
  }
  if (typeof metrics !== 'string' || !(METRICS as readonly string[]).includes(metrics)) {
    return undefined;
  }
  const known = new Set<string>(REFRESH_REASONS);
  if (!Array.isArray(reasons) || !reasons.every((r) => typeof r === 'string' && known.has(r))) {
    return undefined;
  }
  if (
    !Array.isArray(diagnostics) ||
    diagnostics.length > 64 ||
    !diagnostics.every((d) => typeof d === 'string' && KNOWN_DIAGNOSTICS.has(d))
  ) {
    return undefined;
  }
  if (!exactKeys(candidate, ['runId', 'runAttempt', 'sourceSha'])) return undefined;
  if (!positiveSafe(candidate.runId) || !positiveSafe(candidate.runAttempt)) return undefined;
  if (candidate.sourceSha !== null && safeSha(candidate.sourceSha) === null) return undefined;
  if (action === 'refresh') {
    // A refresh names a validated commit and carries a non-empty proposal.
    if (safeSha(candidate.sourceSha) === null) return undefined;
    if (typeof proposedSection !== 'string' || proposedSection.length === 0) return undefined;
    if (proposedSection.length > MAX_SECTION_CHARS) return undefined;
  } else if (proposedSection !== null) {
    return undefined;
  }
  return value as unknown as DryRunReport;
}

function codes(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.map((v) => `\`${v}\``).join(', ');
}

/**
 * The job-summary Markdown for one validated report. Every interpolated value
 * is a fixed code, an integer or a validated SHA. The proposed section is
 * shown only as literal text inside a tilde fence, never as rendered
 * Markdown, and is omitted if it could close that fence.
 */
export function renderDryRunSummary(report: DryRunReport): string {
  const sha =
    report.candidate.sourceSha === null ? 'not validated' : `\`${report.candidate.sourceSha}\``;
  const lines = [
    '## README health dry run',
    '',
    '**Dry run only.** Nothing was written: no README change, branch, pull request or setting.',
    '',
    '| Item | Value |',
    '| --- | --- |',
    '| Dry-run command | completed; report produced |',
    `| Candidate run | \`${String(report.candidate.runId)}\`, attempt \`${String(report.candidate.runAttempt)}\` |`,
    `| Source commit | ${sha} |`,
    `| Decision | \`${report.action}\` |`,
    `| Eligible for a refresh pull request | ${report.action === 'refresh' ? 'yes' : 'no'} |`,
    `| Reasons | ${codes(report.reasons)} |`,
    `| Metric comparison | \`${report.metrics}\` |`,
    `| Diagnostics | ${codes(report.diagnostics)} |`,
    '',
    'A completed command means a report was produced; only the decision says whether the candidate is eligible.',
  ];
  if (report.proposedSection !== null) {
    if (report.proposedSection.includes('~~~')) {
      lines.push(
        '',
        'The proposed section is withheld from this summary (it contains a fence marker).',
      );
    } else {
      lines.push(
        '',
        'Proposed README section (data only; not applied):',
        '',
        '~~~~text',
        report.proposedSection.replace(/\n$/, ''),
        '~~~~',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

// Re-exported so a future entry script needs a single import surface.
export { REFRESH_POLICY };
