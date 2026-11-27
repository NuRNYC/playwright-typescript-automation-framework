/**
 * Synthetic demonstration publication (ADR-0011 P4, amendment 2026-11-27).
 *
 *   demoPublicationText()          -> DemoGeneration
 *   isSyntheticOnlyDemo(manifest)  -> boolean
 *
 * Produces ONE deterministic `quality-verdict-publication` 1.0.0 manifest for
 * the dashboard's `demo` data-module state. Every scenario is built from
 * fixed synthetic evidence through the committed operator path
 * (`reconcileCollected`, `buildBundle`, `serializeBundle`), the strict bundle
 * parser (`parseVerdictBundle`) and the P1 manifest builder, so it obeys the
 * existing vocabularies and cross-field rules. Nothing here reads a file,
 * the environment, the clock, git, GitHub, a token or a real publication
 * generation, and nothing here can produce `BUILD_VERIFIED`.
 *
 * The build metadata is ILLUSTRATIVE, NOT PROVENANCE: a 40-zero source
 * commit that is never the checkout's HEAD, a fictional repository and
 * workflow identity, and a fixed `builtAt`.
 *
 * `isSyntheticOnlyDemo` is the demo-only policy (ADR-0011 P4). The builder
 * and the P4-1 scanner import it; the browser restates it in
 * `dashboard/app.ts` because this module is Node-only. The general P3-2
 * reader (`parsePublication`) is deliberately unchanged.
 *
 * Free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import { parseSummary, type ParsedSummary } from './dashboard-model.ts';
import { GATE_INPUT_NAMES, normalize, serialize } from './quality-summary.ts';
import { context, twelveEighteenNineteen } from './fixtures.ts';
import {
  buildBundle,
  reconcileCollected,
  serializeBundle,
  type BaseTrustPolicy,
  type Collected,
} from './verdict-cli.ts';
import {
  parseVerdictBundle,
  type PublicPolicy,
  type UnauthenticatedBundle,
} from './verdict-bundle.ts';
import type {
  ArtifactEvidence,
  JobEvidence,
  RunAttemptEvidence,
  VerdictEvidence,
} from './verdict.ts';
import {
  SYNTHETIC_LABEL,
  buildPublicationManifest,
  serializeManifest,
  type PublicationManifest,
} from './publication-manifest.ts';
import { parsePublication } from './publication-view.ts';

/* ------------------------------------------------------------------ *
 * Illustrative metadata (ADR-0011 P4: not provenance)
 * ------------------------------------------------------------------ */

/** Forty zeros: never a real commit and never the checkout's HEAD. */
export const DEMO_SOURCE_COMMIT = '0'.repeat(40);
/** Fixed, documented build time of the demonstration manifest. */
export const DEMO_BUILT_AT = '2026-01-01T00:00:00.000Z';
/** Fictional head commit of every synthetic run. */
export const DEMO_HEAD_SHA = 'deadbeef'.repeat(5);
/** Fictional run identifiers of the six scenarios. */
export const DEMO_RUN_IDS = [
  9_000_001, 9_000_002, 9_000_003, 9_000_004, 9_000_005, 9_000_006,
] as const;

const REPOSITORY_ID = 900_000_777;
const WORKFLOW_ID = 800_000_777;
const ARTIFACT_BASE = 9_100_000;

/** The fictional, schema-valid policy recorded in the demonstration manifest. */
export const DEMO_POLICY: PublicPolicy = Object.freeze({
  repositoryId: REPOSITORY_ID,
  repositoryFullName: 'example-owner/example-demo',
  workflowId: WORKFLOW_ID,
  workflowPath: '.github/workflows/demo.yml',
  workflowName: 'Synthetic Demo Workflow',
  trustedEvent: 'push',
  trustedBranch: 'main',
});

const DEMO_BASE_POLICY: BaseTrustPolicy = Object.freeze({
  ...DEMO_POLICY,
  testJobName: 'test',
  gateStepName: 'Gate',
  artifactNamePrefix: 'quality-summary-',
});

/* ------------------------------------------------------------------ *
 * Fixed synthetic evidence for the six scenarios
 * ------------------------------------------------------------------ */

function run(runId: number, overrides: Partial<RunAttemptEvidence> = {}): RunAttemptEvidence {
  return {
    id: runId,
    runAttempt: 1,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    headSha: DEMO_HEAD_SHA,
    headBranch: 'main',
    workflowId: WORKFLOW_ID,
    path: DEMO_POLICY.workflowPath,
    name: DEMO_POLICY.workflowName,
    repository: { id: REPOSITORY_ID, fullName: DEMO_POLICY.repositoryFullName },
    headRepository: { fullName: DEMO_POLICY.repositoryFullName },
    runStartedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:10:00Z',
    ...overrides,
  };
}

function jobs(gate: string, job: string): JobEvidence[] {
  return [
    {
      id: 7_100_001,
      name: 'test',
      runAttempt: 1,
      headSha: DEMO_HEAD_SHA,
      status: 'completed',
      conclusion: job,
      steps: [{ number: 1, name: 'Gate', status: 'completed', conclusion: gate }],
    },
  ];
}

function artifact(runId: number, overrides: Partial<ArtifactEvidence> = {}): ArtifactEvidence {
  return {
    id: ARTIFACT_BASE + (runId % 100),
    name: 'quality-summary-1',
    sizeInBytes: 2_700,
    digest: `sha256:${'cd'.repeat(32)}`,
    createdAt: '2026-01-01T00:09:00Z',
    expiresAt: '2026-01-08T00:09:00Z',
    expired: false,
    workflowRun: {
      id: runId,
      repositoryId: REPOSITORY_ID,
      headRepositoryId: REPOSITORY_ID,
      headSha: DEMO_HEAD_SHA,
    },
    ...overrides,
  };
}

function summaryFor(runId: number, overrides: Record<string, unknown> = {}): ParsedSummary {
  return parseSummary(
    serialize(
      normalize(twelveEighteenNineteen(), context({ runId, headSha: DEMO_HEAD_SHA, ...overrides })),
    ),
  );
}

function collected(
  runId: number,
  evidence: Partial<VerdictEvidence> = {},
  extra: Partial<Collected> = {},
): Collected {
  return {
    evidence: {
      request: { runId, runAttempt: 1 },
      run: { status: 'ok', value: run(runId) },
      jobs: { status: 'ok', value: jobs('success', 'success') },
      ancestry: {
        status: 'ok',
        value: {
          evaluatedSha: DEMO_HEAD_SHA,
          mainTipSha: 'feedface'.repeat(5),
          relation: 'head-is-ancestor',
        },
      },
      artifacts: { status: 'ok', value: [artifact(runId)] },
      archive: {
        status: 'downloaded',
        artifactId: ARTIFACT_BASE + (runId % 100),
        digestCheck: 'match',
        contents: 'single-summary',
      },
      ...evidence,
    },
    summary: summaryFor(runId),
    // Not confirmed by default: a demonstration never reaches SUMMARY_VERIFIED_ORIGIN.
    digest: 'not-checked',
    redirectRefused: false,
    ...extra,
  };
}

const ABSENT: Partial<VerdictEvidence> = {
  artifacts: { status: 'ok', value: [] },
  archive: { status: 'not-attempted' },
};

/** One scenario: its fixed evidence and the outcome the committed reconciler must reach. */
export interface DemoScenario {
  readonly runId: number;
  readonly title: string;
  readonly gate: { readonly state: string; readonly reasons: readonly string[] };
  readonly summary: { readonly state: string; readonly reasons: readonly string[] };
  readonly metrics: boolean;
  readonly evidence: () => Collected;
}

const [S1, S2, S3, S4, S5, S6] = DEMO_RUN_IDS;

/** The six approved scenarios, in run-identifier order. */
export const DEMO_SCENARIOS: readonly DemoScenario[] = Object.freeze([
  {
    runId: S1,
    title: 'Successful Gate',
    gate: { state: 'VERIFIED_PASS', reasons: ['gate-success'] },
    summary: { state: 'SUMMARY_INFORMATIVE', reasons: ['digest-contract-unconfirmed'] },
    metrics: true,
    evidence: () => collected(S1),
  },
  {
    runId: S2,
    title: 'Failed Gate',
    gate: { state: 'VERIFIED_FAIL', reasons: ['gate-failure'] },
    summary: { state: 'SUMMARY_INFORMATIVE', reasons: ['digest-contract-unconfirmed'] },
    metrics: true,
    evidence: () =>
      collected(
        S2,
        {
          run: { status: 'ok', value: run(S2, { conclusion: 'failure' }) },
          jobs: { status: 'ok', value: jobs('failure', 'failure') },
        },
        {
          summary: summaryFor(S2, {
            gateInputs: Object.fromEntries(
              GATE_INPUT_NAMES.map((n) => [n, n === 'SHARDS' ? 'failure' : 'success']),
            ),
          }),
        },
      ),
  },
  {
    runId: S3,
    title: 'Unknown evidence',
    gate: { state: 'UNKNOWN', reasons: ['gate-not-decisive'] },
    summary: { state: 'SUMMARY_INFORMATIVE', reasons: ['verdict-not-trusted'] },
    metrics: true,
    evidence: () =>
      collected(
        S3,
        { jobs: { status: 'ok', value: jobs('skipped', 'success') } },
        { digest: 'verified' },
      ),
  },
  {
    runId: S4,
    title: 'Cancelled execution',
    gate: { state: 'CANCELLED', reasons: ['run-cancelled'] },
    summary: { state: 'SUMMARY_UNAVAILABLE', reasons: ['artifact-absent'] },
    metrics: false,
    evidence: () =>
      collected(
        S4,
        { run: { status: 'ok', value: run(S4, { conclusion: 'cancelled' }) }, ...ABSENT },
        { summary: null },
      ),
  },
  {
    runId: S5,
    title: 'Missing summary',
    gate: { state: 'VERIFIED_PASS', reasons: ['gate-success'] },
    summary: { state: 'SUMMARY_UNAVAILABLE', reasons: ['artifact-expired'] },
    metrics: false,
    evidence: () =>
      collected(
        S5,
        {
          artifacts: { status: 'ok', value: [artifact(S5, { expired: true })] },
          archive: { status: 'failed', reason: 'expired' },
        },
        { summary: null },
      ),
  },
  {
    runId: S6,
    title: 'Untrusted provenance',
    gate: { state: 'UNTRUSTED_PROVENANCE', reasons: ['provenance-event'] },
    summary: { state: 'SUMMARY_UNAVAILABLE', reasons: ['artifact-absent'] },
    metrics: false,
    evidence: () =>
      collected(
        S6,
        { run: { status: 'ok', value: run(S6, { event: 'pull_request' }) }, ...ABSENT },
        { summary: null },
      ),
  },
]);

/* ------------------------------------------------------------------ *
 * Demo-only policy
 * ------------------------------------------------------------------ */

/**
 * ADR-0011 P4 synthetic-only rules for a `demo` manifest, applied to a
 * manifest the strict reader has already accepted: no real or
 * untrusted-origin results; a non-empty, exactly labelled synthetic section;
 * every entry SYNTHETIC / NOT_APPLICABLE with no verification time, digest
 * or checked integrity; no SUMMARY_VERIFIED_ORIGIN; metrics only as
 * SYNTHETIC / NOT_APPLICABLE; and the fictional 40-zero source commit.
 */
export function isSyntheticOnlyDemo(m: PublicationManifest): boolean {
  if (m.results.length !== 0 || m.untrustedOrigin.length !== 0) return false;
  if (m.build.sourceCommit !== DEMO_SOURCE_COMMIT) return false;
  const s = m.synthetic;
  if (s === null || s.label !== SYNTHETIC_LABEL || s.results.length === 0) return false;
  return s.results.every(
    (e) =>
      e.gate.authenticity === 'SYNTHETIC' &&
      e.gate.freshness === 'NOT_APPLICABLE' &&
      e.gate.verifiedAt === null &&
      e.artifact.digest === null &&
      e.artifact.integrity === 'not-checked' &&
      e.summary.state !== 'SUMMARY_VERIFIED_ORIGIN' &&
      e.summary.label !== 'verified-origin' &&
      (e.metrics === null ||
        (e.metrics.authenticity === 'SYNTHETIC' && e.metrics.freshness === 'NOT_APPLICABLE')),
  );
}

/* ------------------------------------------------------------------ *
 * Generator
 * ------------------------------------------------------------------ */

export type DemoGeneration =
  | { readonly status: 'ok'; readonly text: string; readonly manifest: PublicationManifest }
  | { readonly status: 'failed'; readonly code: 'demo-generation-failed' };

const FAILED: DemoGeneration = Object.freeze({ status: 'failed', code: 'demo-generation-failed' });

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The bundles of the given scenarios, each through the committed strict bundle path. */
export function demoBundles(
  scenarios: readonly DemoScenario[] = DEMO_SCENARIOS,
): UnauthenticatedBundle[] | undefined {
  const bundles: UnauthenticatedBundle[] = [];
  for (const scenario of scenarios) {
    const evidence = scenario.evidence();
    const result = reconcileCollected(evidence, DEMO_BASE_POLICY);
    if (
      result.verdict.state !== scenario.gate.state ||
      !sameList(result.verdict.reasons, scenario.gate.reasons) ||
      result.summary.state !== scenario.summary.state ||
      !sameList(result.summary.reasons, scenario.summary.reasons) ||
      result.summary.metricsAvailable !== scenario.metrics
    ) {
      return undefined;
    }
    const parsed = parseVerdictBundle(
      serializeBundle(buildBundle(result, evidence, DEMO_BASE_POLICY)),
      DEMO_POLICY,
    );
    if (parsed.status !== 'valid') return undefined;
    bundles.push(parsed.bundle);
  }
  return bundles;
}

/**
 * Builds the demonstration manifest. Deterministic: identical output on
 * every call. Never throws; any broken invariant gives `demo-generation-failed`.
 */
export function demoPublicationText(
  scenarios: readonly DemoScenario[] = DEMO_SCENARIOS,
): DemoGeneration {
  try {
    if (scenarios.length === 0) return FAILED;
    const bundles = demoBundles(scenarios);
    if (bundles === undefined) return FAILED;
    const built = buildPublicationManifest({
      build: {
        sourceCommit: DEMO_SOURCE_COMMIT,
        builtAt: DEMO_BUILT_AT,
        workingTree: 'clean',
        policy: DEMO_BASE_POLICY,
      },
      entries: [],
      synthetic: bundles,
      includeUntrustedOrigin: false,
    });
    if (built.status !== 'built' || built.omitted.length !== 0) return FAILED;
    const parsed = parsePublication(built.text);
    if (
      parsed.state !== 'valid' ||
      serializeManifest(parsed.manifest) !== built.text ||
      !isSyntheticOnlyDemo(parsed.manifest) ||
      parsed.manifest.synthetic?.results.length !== scenarios.length
    ) {
      return FAILED;
    }
    return Object.freeze({ status: 'ok', text: built.text, manifest: parsed.manifest });
  } catch {
    return FAILED;
  }
}
