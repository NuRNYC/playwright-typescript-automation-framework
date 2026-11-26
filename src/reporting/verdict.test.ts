/**
 * Unit tests for the quality verdict reconciler (ADR-0010, M8E-3).
 *
 * Same conventions as the other unit tests (ADR-0002). All evidence is
 * synthetic and shaped like the transport-normalized GitHub API responses
 * documented in ADR-0010; summaries come from the M8A normalizer and the
 * M8C-1 `parseSummary`. No network, credentials or live GitHub data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSummary, type ParsedSummary } from './dashboard-model.ts';
import { GATE_INPUT_NAMES, normalize, serialize } from './quality-summary.ts';
import {
  CANARY,
  SYNTHETIC_SHA,
  canaryReport,
  context,
  deepFreeze,
  twelveEighteenNineteen,
} from './fixtures.ts';
import {
  RETRIEVAL_FAILURES,
  SUMMARY_STATES,
  VERDICT_STATES,
  reconcile,
  type AncestryEvidence,
  type ArchiveEvidence,
  type ArtifactEvidence,
  type JobEvidence,
  type Retrieved,
  type RunAttemptEvidence,
  type StepEvidence,
  type TrustPolicy,
  type VerdictEvidence,
  type VerdictResult,
} from './verdict.ts';

/* ------------------------------------------------------------------ *
 * Synthetic evidence
 * ------------------------------------------------------------------ */

const REPO_ID = 900_000_001;
const REPO = 'example-owner/example-repo';
const WORKFLOW_ID = 800_000_001;
const RUN_ID = 1_000_001; // matches fixtures.context()
const HEAD = SYNTHETIC_SHA;
const MAIN_TIP = 'fedcba9876543210fedcba9876543210fedcba98';
const OTHER_SHA = '1111111111111111111111111111111111111111';

const POLICY: TrustPolicy = {
  repositoryId: REPO_ID,
  repositoryFullName: REPO,
  workflowId: WORKFLOW_ID,
  workflowPath: '.github/workflows/tests.yml',
  workflowName: 'Playwright UI Tests',
  trustedEvent: 'push',
  trustedBranch: 'main',
  testJobName: 'test',
  gateStepName: 'Gate',
  artifactNamePrefix: 'quality-summary-',
  digestContractConfirmed: true,
};

function ok<T>(value: T): Retrieved<T> {
  return { status: 'ok', value };
}
function failed<T>(reason: (typeof RETRIEVAL_FAILURES)[number]): Retrieved<T> {
  return { status: 'failed', reason };
}

function run(overrides: Partial<RunAttemptEvidence> = {}): RunAttemptEvidence {
  return {
    id: RUN_ID,
    runAttempt: 1,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    headSha: HEAD,
    headBranch: 'main',
    workflowId: WORKFLOW_ID,
    path: '.github/workflows/tests.yml',
    name: 'Playwright UI Tests',
    repository: { id: REPO_ID, fullName: REPO },
    headRepository: { fullName: REPO },
    runStartedAt: '2026-11-26T01:00:00Z',
    updatedAt: '2026-11-26T01:10:00Z',
    ...overrides,
  };
}

function step(
  name: string,
  conclusion: string | null = 'success',
  status = 'completed',
): StepEvidence {
  return { number: name.length, name, status, conclusion };
}

function testJob(
  gate: StepEvidence | null = step('Gate'),
  overrides: Partial<JobEvidence> = {},
): JobEvidence {
  return {
    id: 70_000_004,
    name: 'test',
    runAttempt: 1,
    headSha: HEAD,
    status: 'completed',
    conclusion: 'success',
    steps: [
      step('Triage'),
      step('Quality summary'),
      step('Upload quality summary'),
      ...(gate === null ? [] : [gate]),
    ],
    ...overrides,
  };
}

function otherJobs(): JobEvidence[] {
  return ['checks', 'shard (1, 2)', 'shard (2, 2)'].map((name, i) => ({
    id: 70_000_001 + i,
    name,
    runAttempt: 1,
    headSha: HEAD,
    status: 'completed',
    conclusion: 'success',
    steps: [step('Run')],
  }));
}

function jobs(job: JobEvidence | null = testJob()): JobEvidence[] {
  return [...otherJobs(), ...(job === null ? [] : [job])];
}

function ancestry(overrides: Partial<AncestryEvidence> = {}): AncestryEvidence {
  return { evaluatedSha: HEAD, mainTipSha: MAIN_TIP, relation: 'head-is-ancestor', ...overrides };
}

function artifact(overrides: Partial<ArtifactEvidence> = {}): ArtifactEvidence {
  return {
    id: 15_000_001,
    name: 'quality-summary-1',
    sizeInBytes: 2_700,
    digest: `sha256:${'ab'.repeat(32)}`,
    createdAt: '2026-11-26T01:09:00Z',
    expiresAt: '2026-12-03T01:09:00Z',
    expired: false,
    workflowRun: { id: RUN_ID, repositoryId: REPO_ID, headRepositoryId: REPO_ID, headSha: HEAD },
    ...overrides,
  };
}

const DOWNLOADED: ArchiveEvidence = {
  status: 'downloaded',
  artifactId: 15_000_001,
  digestCheck: 'match',
  contents: 'single-summary',
};

function evidence(overrides: Partial<VerdictEvidence> = {}): VerdictEvidence {
  return {
    request: { runId: RUN_ID, runAttempt: 1 },
    run: ok(run()),
    jobs: ok(jobs()),
    ancestry: ok(ancestry()),
    artifacts: ok([
      artifact({ id: 15_000_000, name: 'blob-report-1' }),
      artifact({ id: 15_000_002, name: 'playwright-report' }),
      artifact(),
    ]),
    archive: DOWNLOADED,
    ...overrides,
  };
}

/** A real summary from the M8A normalizer, parsed by M8C-1. */
function summary(overrides: Record<string, unknown> = {}): ParsedSummary {
  return parseSummary(serialize(normalize(twelveEighteenNineteen(), context(overrides))));
}

const VALID = summary();

function check(
  ev: VerdictEvidence = evidence(),
  parsed: ParsedSummary | null = VALID,
  policy: TrustPolicy = POLICY,
): VerdictResult {
  return reconcile(parsed, ev, policy);
}

/* ------------------------------------------------------------------ *
 * Verified results
 * ------------------------------------------------------------------ */

test('trusted main push with a successful Gate is VERIFIED_PASS with verified-origin metrics', () => {
  const r = check();
  assert.deepEqual(r.verdict, { state: 'VERIFIED_PASS', reasons: ['gate-success'] });
  assert.deepEqual(r.summary, {
    state: 'SUMMARY_VERIFIED_ORIGIN',
    reasons: ['verified-origin'],
    metricsAvailable: true,
    label: 'verified-origin',
  });
  assert.deepEqual(r.identity, {
    runId: RUN_ID,
    runAttempt: 1,
    headSha: HEAD,
    event: 'push',
    testJobId: 70_000_004,
    artifactId: 15_000_001,
  });
});

test('identical head and main tip is accepted ancestry', () => {
  const r = check(
    evidence({ ancestry: ok(ancestry({ mainTipSha: HEAD, relation: 'identical' })) }),
  );
  assert.equal(r.verdict.state, 'VERIFIED_PASS');
});

test('trusted main push with a failed Gate is VERIFIED_FAIL', () => {
  const failingSummary = summary({
    gateInputs: {
      ...Object.fromEntries(GATE_INPUT_NAMES.map((n) => [n, 'success'])),
      SHARDS: 'failure',
    },
  });
  const r = check(
    evidence({
      run: ok(run({ conclusion: 'failure' })),
      jobs: ok(jobs(testJob(step('Gate', 'failure'), { conclusion: 'failure' }))),
    }),
    failingSummary,
  );
  assert.deepEqual(r.verdict, { state: 'VERIFIED_FAIL', reasons: ['gate-failure'] });
  assert.equal(r.summary.state, 'SUMMARY_VERIFIED_ORIGIN');
});

/* ------------------------------------------------------------------ *
 * Execution failed, cancelled, pending
 * ------------------------------------------------------------------ */

test('a job failure before the Gate is EXECUTION_FAILED, never VERIFIED_FAIL', () => {
  for (const gate of [null, step('Gate', 'skipped'), step('Gate', null, 'in_progress')]) {
    const r = check(
      evidence({
        run: ok(run({ conclusion: 'failure' })),
        jobs: ok(jobs(testJob(gate, { conclusion: 'failure' }))),
      }),
    );
    assert.deepEqual(r.verdict, { state: 'EXECUTION_FAILED', reasons: ['job-failed-before-gate'] });
  }
  const timedOut = check(
    evidence({
      run: ok(run({ conclusion: 'timed_out' })),
      jobs: ok(jobs(testJob(null, { conclusion: 'timed_out' }))),
    }),
  );
  assert.equal(timedOut.verdict.state, 'EXECUTION_FAILED');
});

test('a failed run without any test job is EXECUTION_FAILED', () => {
  const r = check(evidence({ run: ok(run({ conclusion: 'startup_failure' })), jobs: ok([]) }));
  assert.deepEqual(r.verdict, {
    state: 'EXECUTION_FAILED',
    reasons: ['run-failed-without-test-job'],
  });
});

test('a cancelled run is CANCELLED even when a Gate executed', () => {
  const r = check(
    evidence({
      run: ok(run({ conclusion: 'cancelled' })),
      jobs: ok(jobs(testJob(step('Gate', 'failure'), { conclusion: 'cancelled' }))),
    }),
  );
  assert.deepEqual(r.verdict, { state: 'CANCELLED', reasons: ['job-cancelled', 'run-cancelled'] });
  assert.equal(
    check(evidence({ run: ok(run({ conclusion: 'cancelled' })) })).verdict.state,
    'CANCELLED',
  );
});

test('an identity contradiction outranks cancellation', () => {
  const r = check(evidence({ run: ok(run({ conclusion: 'cancelled', runAttempt: 2 })) }));
  assert.deepEqual(r.verdict, { state: 'CONFLICT', reasons: ['identity-attempt-mismatch'] });
});

test('a run attempt in progress is PENDING', () => {
  for (const status of ['queued', 'in_progress', 'waiting']) {
    const r = check(
      evidence({
        run: ok(run({ status, conclusion: null })),
        jobs: ok(jobs(testJob(null, { status: 'in_progress', conclusion: null }))),
      }),
    );
    assert.deepEqual(r.verdict, { state: 'PENDING', reasons: ['run-not-completed'] });
    assert.equal(r.summary.state, 'SUMMARY_INFORMATIVE');
  }
});

/* ------------------------------------------------------------------ *
 * Provenance
 * ------------------------------------------------------------------ */

test('a same-repository pull request is UNTRUSTED_PROVENANCE even with a successful Gate', () => {
  const r = check(
    evidence({ run: ok(run({ event: 'pull_request', headBranch: 'feature-branch' })) }),
    summary({ event: 'pull_request', branch: 'feature-branch' }),
  );
  assert.deepEqual(r.verdict, {
    state: 'UNTRUSTED_PROVENANCE',
    reasons: ['provenance-branch', 'provenance-event'],
  });
  assert.deepEqual(r.summary, {
    state: 'SUMMARY_INFORMATIVE',
    reasons: ['verdict-not-trusted'],
    metricsAvailable: true,
    label: 'unverified-origin',
  });
});

test('a fork pull request is UNTRUSTED_PROVENANCE', () => {
  const r = check(
    evidence({
      run: ok(
        run({
          event: 'pull_request',
          headBranch: 'main',
          headRepository: { fullName: 'fork/example-repo' },
        }),
      ),
    }),
  );
  assert.equal(r.verdict.state, 'UNTRUSTED_PROVENANCE');
  assert.ok(r.verdict.reasons.includes('provenance-head-repository'));
  const deletedFork = check(
    evidence({ run: ok(run({ event: 'pull_request', headRepository: null })) }),
  );
  assert.ok(deletedFork.verdict.reasons.includes('provenance-head-repository'));
});

test('wrong repository, workflow id, path or name is UNTRUSTED_PROVENANCE', () => {
  const cases: [Partial<RunAttemptEvidence>, string][] = [
    [{ repository: { id: 42, fullName: REPO } }, 'provenance-repository'],
    [{ repository: { id: REPO_ID, fullName: 'other/repo' } }, 'provenance-repository'],
    [{ workflowId: 12345 }, 'provenance-workflow-id'],
    [{ path: '.github/workflows/other.yml' }, 'provenance-workflow-path'],
    [{ name: 'Other workflow' }, 'provenance-workflow-name'],
    [{ headBranch: null }, 'provenance-branch'],
  ];
  for (const [override, reason] of cases) {
    const r = check(evidence({ run: ok(run(override)) }));
    assert.equal(r.verdict.state, 'UNTRUSTED_PROVENANCE', reason);
    assert.ok(r.verdict.reasons.includes(reason as never), reason);
  }
});

test('diverged or ahead ancestry is UNTRUSTED_PROVENANCE', () => {
  assert.deepEqual(check(evidence({ ancestry: ok(ancestry({ relation: 'diverged' })) })).verdict, {
    state: 'UNTRUSTED_PROVENANCE',
    reasons: ['provenance-diverged-from-main'],
  });
  assert.deepEqual(
    check(evidence({ ancestry: ok(ancestry({ relation: 'head-ahead' })) })).verdict,
    {
      state: 'UNTRUSTED_PROVENANCE',
      reasons: ['provenance-head-ahead-of-main'],
    },
  );
});

test('missing or malformed ancestry evidence is UNKNOWN, never trusted', () => {
  for (const [value, reason] of [
    [failed<AncestryEvidence>('http-error'), 'retrieval-ancestry-http-error'],
    [
      ok({ evaluatedSha: HEAD, mainTipSha: MAIN_TIP, relation: 'probably' } as never),
      'retrieval-ancestry-malformed',
    ],
    [
      ok({ evaluatedSha: HEAD, mainTipSha: MAIN_TIP, relation: 'identical' }),
      'retrieval-ancestry-malformed',
    ],
    [
      ok({ evaluatedSha: 'abc', mainTipSha: MAIN_TIP, relation: 'head-is-ancestor' }),
      'retrieval-ancestry-malformed',
    ],
    [{ status: 'ok' } as never, 'retrieval-ancestry-malformed'],
  ] as const) {
    const r = check(evidence({ ancestry: value as Retrieved<AncestryEvidence> }));
    assert.deepEqual(r.verdict, { state: 'UNKNOWN', reasons: [reason] });
  }
});

test('ancestry evaluated for another commit is CONFLICT', () => {
  const r = check(evidence({ ancestry: ok(ancestry({ evaluatedSha: OTHER_SHA })) }));
  assert.deepEqual(r.verdict, { state: 'CONFLICT', reasons: ['identity-ancestry-sha-mismatch'] });
});

/* ------------------------------------------------------------------ *
 * Identity binding
 * ------------------------------------------------------------------ */

test('wrong run id, attempt or head SHA is CONFLICT', () => {
  assert.deepEqual(check(evidence({ run: ok(run({ id: RUN_ID + 1 })) })).verdict.reasons, [
    'identity-run-id-mismatch',
  ]);
  assert.deepEqual(check(evidence({ run: ok(run({ runAttempt: 2 })) })).verdict.reasons, [
    'identity-attempt-mismatch',
  ]);
  const wrongSha = check(evidence({ run: ok(run({ headSha: OTHER_SHA })) }));
  assert.equal(wrongSha.verdict.state, 'CONFLICT');
  assert.deepEqual(wrongSha.verdict.reasons, [
    'identity-ancestry-sha-mismatch',
    'identity-job-sha-mismatch',
  ]);
});

test('jobs from another attempt or another commit are CONFLICT, never borrowed', () => {
  const otherAttempt = check(
    evidence({ jobs: ok(jobs(testJob(step('Gate'), { runAttempt: 2 }))) }),
  );
  assert.deepEqual(otherAttempt.verdict, {
    state: 'CONFLICT',
    reasons: ['identity-job-attempt-mismatch'],
  });
  const otherCommit = check(
    evidence({ jobs: ok(jobs(testJob(step('Gate'), { headSha: OTHER_SHA }))) }),
  );
  assert.deepEqual(otherCommit.verdict, {
    state: 'CONFLICT',
    reasons: ['identity-job-sha-mismatch'],
  });
});

test('duplicate test jobs or duplicate Gate steps are CONFLICT', () => {
  const dupJobs = check(
    evidence({ jobs: ok([...jobs(), testJob(step('Gate'), { id: 70_000_009 })]) }),
  );
  assert.deepEqual(dupJobs.verdict, {
    state: 'CONFLICT',
    reasons: ['identity-duplicate-test-job'],
  });
  const job = testJob();
  const dupGate = check(
    evidence({ jobs: ok(jobs({ ...job, steps: [...job.steps, step('Gate')] })) }),
  );
  assert.deepEqual(dupGate.verdict, {
    state: 'CONFLICT',
    reasons: ['identity-duplicate-gate-step'],
  });
});

/* ------------------------------------------------------------------ *
 * Missing evidence and precedence
 * ------------------------------------------------------------------ */

test('missing jobs evidence without an established conflict is UNKNOWN', () => {
  const r = check(evidence({ jobs: failed('timeout') }));
  assert.deepEqual(r.verdict, { state: 'UNKNOWN', reasons: ['retrieval-jobs-timeout'] });
  assert.equal(r.identity.testJobId, null);
});

test('API permission failure and rate limiting are UNKNOWN, not negative evidence', () => {
  assert.deepEqual(check(evidence({ run: failed('permission') })).verdict, {
    state: 'UNKNOWN',
    reasons: ['retrieval-run-permission'],
  });
  assert.deepEqual(check(evidence({ jobs: failed('rate-limited') })).verdict, {
    state: 'UNKNOWN',
    reasons: ['retrieval-jobs-rate-limited'],
  });
  const all = check(
    evidence({
      run: failed('rate-limited'),
      jobs: failed('rate-limited'),
      ancestry: failed('rate-limited'),
    }),
  );
  assert.deepEqual(all.verdict.reasons, [
    'retrieval-ancestry-rate-limited',
    'retrieval-jobs-rate-limited',
    'retrieval-run-rate-limited',
  ]);
  assert.equal(all.summary.state, 'SUMMARY_UNKNOWN');
  assert.equal(all.summary.metricsAvailable, false);
});

test('an attempt mismatch plus a failed jobs request is CONFLICT', () => {
  const r = check(evidence({ run: ok(run({ runAttempt: 2 })), jobs: failed('http-error') }));
  assert.deepEqual(r.verdict, { state: 'CONFLICT', reasons: ['identity-attempt-mismatch'] });
});

test('a confirmed pull-request run plus a failed jobs request is UNTRUSTED_PROVENANCE', () => {
  const r = check(
    evidence({
      run: ok(run({ event: 'pull_request', headBranch: 'feature' })),
      jobs: failed('http-error'),
    }),
  );
  assert.equal(r.verdict.state, 'UNTRUSTED_PROVENANCE');
});

test('a known contradiction outranks a confirmed untrusted origin and missing responses', () => {
  const r = check(
    evidence({
      run: ok(run({ event: 'pull_request', runAttempt: 3 })),
      jobs: failed('timeout'),
      ancestry: failed('timeout'),
    }),
  );
  assert.deepEqual(r.verdict, { state: 'CONFLICT', reasons: ['identity-attempt-mismatch'] });
});

test('supplementary evidence never upgrades a pull-request run', () => {
  const r = check(
    evidence({
      run: ok(run({ event: 'pull_request' })),
      ancestry: ok(ancestry({ mainTipSha: HEAD, relation: 'identical' })),
    }),
    VALID,
    { ...POLICY, digestContractConfirmed: true },
  );
  assert.equal(r.verdict.state, 'UNTRUSTED_PROVENANCE');
  assert.notEqual(r.summary.state, 'SUMMARY_VERIFIED_ORIGIN');
});

/* ------------------------------------------------------------------ *
 * Gate step shapes and outcome contradictions
 * ------------------------------------------------------------------ */

test('a missing, skipped or incomplete Gate with a successful job is UNKNOWN', () => {
  for (const gate of [null, step('Gate', 'skipped'), step('Gate', null, 'in_progress')]) {
    const r = check(evidence({ jobs: ok(jobs(testJob(gate))) }));
    assert.deepEqual(r.verdict, { state: 'UNKNOWN', reasons: ['gate-not-decisive'] });
  }
});

test('a completed run without a test job is UNKNOWN', () => {
  assert.deepEqual(check(evidence({ jobs: ok(jobs(null)) })).verdict, {
    state: 'UNKNOWN',
    reasons: ['no-test-job'],
  });
});

test('contradictory job, Gate and run conclusions are CONFLICT', () => {
  const cases: [JobEvidence, Partial<RunAttemptEvidence>, string][] = [
    [
      testJob(step('Gate', 'success'), { conclusion: 'failure' }),
      { conclusion: 'failure' },
      'outcome-gate-success-job-not-success',
    ],
    [
      testJob(step('Gate', 'failure'), { conclusion: 'success' }),
      { conclusion: 'success' },
      'outcome-gate-failure-job-success',
    ],
    [
      testJob(step('Gate'), { status: 'in_progress', conclusion: null }),
      {},
      'outcome-job-not-completed',
    ],
    [
      testJob(null, { conclusion: 'failure' }),
      { conclusion: 'success' },
      'outcome-run-success-job-not-success',
    ],
  ];
  for (const [job, runOverride, reason] of cases) {
    const r = check(evidence({ run: ok(run(runOverride)), jobs: ok(jobs(job)) }));
    assert.equal(r.verdict.state, 'CONFLICT', reason);
    assert.ok(r.verdict.reasons.includes(reason as never), reason);
  }
});

test('unmapped conclusions are UNKNOWN', () => {
  const r = check(
    evidence({
      run: ok(run({ conclusion: 'neutral' })),
      jobs: ok(jobs(testJob(step('Gate', 'neutral'), { conclusion: 'neutral' }))),
    }),
  );
  assert.equal(r.verdict.state, 'UNKNOWN');
});

test('only the Gate step decides: advisory continue-on-error steps are ignored', () => {
  // With continue-on-error a failed advisory step reports conclusion "success";
  // the reconciler never reads those steps, so their values cannot change the verdict.
  const job = testJob(step('Gate', 'failure'), { conclusion: 'failure' });
  const masked: JobEvidence = {
    ...job,
    steps: job.steps.map((s) => (s.name === 'Gate' ? s : { ...s, conclusion: 'success' })),
  };
  const r = check(evidence({ run: ok(run({ conclusion: 'failure' })), jobs: ok(jobs(masked)) }));
  assert.equal(r.verdict.state, 'VERIFIED_FAIL');
  const advisoryFailed: JobEvidence = {
    ...testJob(),
    steps: testJob().steps.map((s) => (s.name === 'Gate' ? s : { ...s, conclusion: 'failure' })),
  };
  assert.equal(check(evidence({ jobs: ok(jobs(advisoryFailed)) })).verdict.state, 'VERIFIED_PASS');
});

/* ------------------------------------------------------------------ *
 * Summary integrity
 * ------------------------------------------------------------------ */

test('an absent artifact keeps a verified verdict but makes metrics unavailable', () => {
  const r = check(
    evidence({
      artifacts: ok([artifact({ name: 'playwright-report' })]),
      archive: { status: 'not-attempted' },
    }),
    null,
  );
  assert.equal(r.verdict.state, 'VERIFIED_PASS');
  assert.deepEqual(r.summary, {
    state: 'SUMMARY_UNAVAILABLE',
    reasons: ['artifact-absent'],
    metricsAvailable: false,
    label: null,
  });
});

test('an expired artifact is SUMMARY_UNAVAILABLE, with the verdict preserved', () => {
  const flagged = check(
    evidence({
      artifacts: ok([artifact({ expired: true })]),
      archive: { status: 'not-attempted' },
    }),
    null,
  );
  assert.equal(flagged.summary.state, 'SUMMARY_UNAVAILABLE');
  assert.deepEqual(flagged.summary.reasons, ['artifact-expired']);
  const gone = check(evidence({ archive: { status: 'failed', reason: 'expired' } }), null);
  assert.deepEqual(gone.summary.reasons, ['artifact-expired']);
  assert.equal(gone.verdict.state, 'VERIFIED_PASS');
});

test('an artifact not downloaded is SUMMARY_UNAVAILABLE', () => {
  const r = check(evidence({ archive: { status: 'not-attempted' } }), null);
  assert.deepEqual(r.summary.reasons, ['archive-not-downloaded']);
});

test('a digest mismatch is SUMMARY_CONFLICT, not SUMMARY_UNKNOWN', () => {
  const r = check(
    evidence({ archive: { ...DOWNLOADED, digestCheck: 'mismatch' } as ArchiveEvidence }),
  );
  assert.deepEqual(r.summary.reasons, ['digest-mismatch']);
  assert.equal(r.summary.state, 'SUMMARY_CONFLICT');
  assert.equal(r.summary.metricsAvailable, false);
  assert.equal(r.verdict.state, 'VERIFIED_PASS');
});

test('an artifact bound to another run, repository or commit is SUMMARY_CONFLICT', () => {
  const wr = artifact().workflowRun;
  const cases: [Partial<ArtifactEvidence>, string][] = [
    [{ workflowRun: { ...wr, id: RUN_ID + 1 } }, 'artifact-run-mismatch'],
    [{ workflowRun: { ...wr, repositoryId: 7 } }, 'artifact-repository-mismatch'],
    [{ workflowRun: { ...wr, headRepositoryId: 7 } }, 'artifact-head-repository-mismatch'],
    [{ workflowRun: { ...wr, headSha: OTHER_SHA } }, 'artifact-sha-mismatch'],
    [{ createdAt: '2026-11-26T00:59:59Z' }, 'artifact-created-outside-attempt'],
    [{ createdAt: '2026-11-26T01:10:01Z' }, 'artifact-created-outside-attempt'],
    [{ id: 15_000_099 }, 'artifact-id-mismatch'],
  ];
  for (const [override, reason] of cases) {
    const r = check(evidence({ artifacts: ok([artifact(override)]) }));
    assert.equal(r.summary.state, 'SUMMARY_CONFLICT', reason);
    assert.deepEqual(r.summary.reasons, [reason], reason);
  }
});

test("another attempt's artifact is never borrowed", () => {
  const r = check(
    evidence({
      request: { runId: RUN_ID, runAttempt: 2 },
      run: ok(run({ runAttempt: 2 })),
      jobs: ok(
        jobs(testJob(step('Gate'), { runAttempt: 2 })).map((j) => ({ ...j, runAttempt: 2 })),
      ),
      artifacts: ok([artifact({ name: 'quality-summary-1' })]),
      archive: { status: 'not-attempted' },
    }),
    null,
  );
  assert.equal(r.verdict.state, 'VERIFIED_PASS');
  assert.deepEqual(r.summary.reasons, ['artifact-absent']);
});

test('a summary recording another attempt, run, event or commit is SUMMARY_CONFLICT', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ runAttempt: 2 }, 'summary-attempt-mismatch'],
    [{ runId: RUN_ID + 5 }, 'summary-run-mismatch'],
    [{ event: 'pull_request' }, 'summary-event-mismatch'],
    [{ headSha: OTHER_SHA }, 'summary-sha-mismatch'],
  ];
  for (const [override, reason] of cases) {
    const r = check(evidence(), summary(override));
    assert.equal(r.summary.state, 'SUMMARY_CONFLICT', reason);
    assert.ok(r.summary.reasons.includes(reason as never), reason);
  }
});

test('observed Gate inputs contradicting a trusted Gate are SUMMARY_CONFLICT', () => {
  const failedInputs = summary({
    gateInputs: {
      ...Object.fromEntries(GATE_INPUT_NAMES.map((n) => [n, 'success'])),
      MERGE: 'failure',
    },
  });
  assert.deepEqual(check(evidence(), failedInputs).summary.reasons, [
    'observed-inputs-contradict-gate',
  ]);
  const passSummaryFailGate = check(
    evidence({
      run: ok(run({ conclusion: 'failure' })),
      jobs: ok(jobs(testJob(step('Gate', 'failure'), { conclusion: 'failure' }))),
    }),
  );
  assert.deepEqual(passSummaryFailGate.summary.reasons, ['observed-inputs-contradict-gate']);
  assert.equal(passSummaryFailGate.verdict.state, 'VERIFIED_FAIL');
});

test('an established summary conflict outranks an artifact retrieval failure', () => {
  const r = check(
    evidence({ archive: { status: 'failed', reason: 'timeout' } }),
    summary({ runAttempt: 4 }),
  );
  assert.equal(r.summary.state, 'SUMMARY_CONFLICT');
  const listFailed = check(
    evidence({ artifacts: failed('rate-limited') }),
    summary({ headSha: OTHER_SHA }),
  );
  assert.deepEqual(listFailed.summary.reasons, ['summary-sha-mismatch']);
});

test('artifact retrieval failures without a conflict are SUMMARY_UNKNOWN', () => {
  assert.deepEqual(check(evidence({ artifacts: failed('permission') }), null).summary.reasons, [
    'retrieval-artifacts-permission',
  ]);
  assert.deepEqual(
    check(evidence({ archive: { status: 'failed', reason: 'http-error' } }), null).summary.reasons,
    ['retrieval-archive-http-error'],
  );
});

test('duplicate candidate artifacts are SUMMARY_CONFLICT', () => {
  const r = check(evidence({ artifacts: ok([artifact(), artifact({ id: 15_000_005 })]) }));
  assert.deepEqual(r.summary.reasons, ['artifact-duplicate']);
});

test('invalid archives and summaries are SUMMARY_INVALID', () => {
  assert.deepEqual(
    check(
      evidence({ archive: { ...DOWNLOADED, contents: 'unexpected-entries' } as ArchiveEvidence }),
    ).summary.reasons,
    ['archive-unexpected-entries'],
  );
  assert.deepEqual(
    check(evidence({ archive: { ...DOWNLOADED, contents: 'too-large' } as ArchiveEvidence }))
      .summary.reasons,
    ['archive-too-large'],
  );
  assert.deepEqual(check(evidence(), null).summary.reasons, ['summary-missing']);
  assert.deepEqual(check(evidence(), parseSummary('{')).summary.reasons, ['summary-invalid']);
  assert.deepEqual(check(evidence(), parseSummary('{"schemaVersion":"2.0.0"}')).summary.reasons, [
    'summary-schema-mismatch',
  ]);
});

test('the summary cannot be bound without the run attempt', () => {
  const r = check(evidence({ run: failed('timeout') }));
  assert.equal(r.verdict.state, 'UNKNOWN');
  assert.deepEqual(r.summary.reasons, ['binding-run-attempt-unavailable']);
  assert.equal(r.summary.metricsAvailable, false);
});

test('an unconfirmed digest byte contract caps metrics at unverified origin', () => {
  const r = check(evidence(), VALID, { ...POLICY, digestContractConfirmed: false });
  assert.equal(r.verdict.state, 'VERIFIED_PASS');
  assert.deepEqual(r.summary, {
    state: 'SUMMARY_INFORMATIVE',
    reasons: ['digest-contract-unconfirmed'],
    metricsAvailable: true,
    label: 'unverified-origin',
  });
});

test('an unavailable-test-data summary keeps its state without metrics', () => {
  const r = check(evidence(), summary({ reportState: 'report-missing' }));
  assert.equal(r.summary.state, 'SUMMARY_VERIFIED_ORIGIN');
  assert.equal(r.summary.metricsAvailable, false);
});

/* ------------------------------------------------------------------ *
 * Malformed input, determinism, immutability, leakage
 * ------------------------------------------------------------------ */

test('malformed evidence counts as not retrieved', () => {
  const cases: [Partial<VerdictEvidence>, string][] = [
    [{ run: ok({ ...run(), headSha: 'not-a-sha' }) }, 'retrieval-run-malformed'],
    [{ run: ok({ ...run(), status: 'Completed!' }) }, 'retrieval-run-malformed'],
    [{ run: ok({ ...run(), runStartedAt: 'yesterday' }) }, 'retrieval-run-malformed'],
    [{ run: { status: 'failed', reason: 'no idea' } as never }, 'retrieval-run-malformed'],
    [{ jobs: ok([{ ...testJob(), steps: 'none' }] as never) }, 'retrieval-jobs-malformed'],
    [{ jobs: ok([{ ...testJob(), id: -1 }]) }, 'retrieval-jobs-malformed'],
    [{ jobs: null as never }, 'retrieval-jobs-malformed'],
  ];
  for (const [override, reason] of cases) {
    const r = check(evidence(override));
    assert.equal(r.verdict.state, 'UNKNOWN', reason);
    assert.ok(r.verdict.reasons.includes(reason as never), reason);
  }
  assert.equal(
    check(evidence({ artifacts: ok([{ ...artifact(), digest: 'md5:x' }]) })).summary.state,
    'SUMMARY_UNKNOWN',
  );
  assert.deepEqual(
    check(evidence({ archive: { status: 'downloaded' } as never })).summary.reasons,
    ['retrieval-archive-malformed'],
  );
});

test('invalid requests and policies are UNKNOWN', () => {
  const badRequest = check(evidence({ request: { runId: 0, runAttempt: 1 } }));
  assert.deepEqual(badRequest.verdict, { state: 'UNKNOWN', reasons: ['invalid-request'] });
  const badPolicy = check(evidence(), VALID, { ...POLICY, trustedEvent: 'pull_request' as never });
  assert.deepEqual(badPolicy.verdict, { state: 'UNKNOWN', reasons: ['invalid-policy'] });
  assert.equal(badPolicy.summary.metricsAvailable, false);
});

test('unexpected input fields never reach the result', () => {
  const leaky = evidence({
    run: ok({
      ...run(),
      [CANARY]: CANARY,
      displayTitle: CANARY,
      headBranch: 'main',
    } as RunAttemptEvidence),
    jobs: ok(
      jobs().map((j) => ({ ...j, htmlUrl: `https://example.test/${CANARY}`, [CANARY]: CANARY })),
    ),
    artifacts: ok([
      { ...artifact(), archiveDownloadUrl: `https://example.test/${CANARY}` } as ArtifactEvidence,
    ]),
  });
  const r = check(leaky);
  assert.equal(r.verdict.state, 'VERIFIED_PASS');
  assert.equal(JSON.stringify(r).includes(CANARY), false);
  assert.equal(JSON.stringify(r).includes('https:'), false);
});

test('canaries in branch names, errors and summaries never appear in results', () => {
  const branches = [`feature/${CANARY}`, `probe/${CANARY}`];
  for (const headBranch of branches) {
    const r = check(
      evidence({ run: ok(run({ event: 'pull_request', headBranch })) }),
      summary({ branch: headBranch }),
    );
    assert.equal(JSON.stringify(r).includes(CANARY), false);
  }
  const fromCanaryReport = parseSummary(serialize(normalize(canaryReport(), context())));
  assert.equal(JSON.stringify(check(evidence(), fromCanaryReport)).includes(CANARY), false);
});

test('results contain only allow-listed keys and fixed vocabulary', () => {
  const r = check();
  assert.deepEqual(Object.keys(r), ['verdict', 'summary', 'identity']);
  assert.deepEqual(Object.keys(r.verdict), ['state', 'reasons']);
  assert.deepEqual(Object.keys(r.summary), ['state', 'reasons', 'metricsAvailable', 'label']);
  assert.ok((VERDICT_STATES as readonly string[]).includes(r.verdict.state));
  assert.ok((SUMMARY_STATES as readonly string[]).includes(r.summary.state));
  for (const reason of [...r.verdict.reasons, ...r.summary.reasons]) {
    assert.match(reason, /^[a-z][a-z0-9-]*$/);
  }
});

test('results are deterministic and frozen', () => {
  const ev = evidence();
  const first = check(ev);
  assert.deepEqual(check(ev), first);
  assert.ok(
    Object.isFrozen(first) &&
      Object.isFrozen(first.verdict) &&
      Object.isFrozen(first.verdict.reasons),
  );
  assert.throws(() => {
    (first.verdict as { state: string }).state = 'VERIFIED_PASS';
  }, TypeError);
});

test('inputs are not mutated', () => {
  const ev = deepFreeze(evidence());
  const parsed = deepFreeze(summary());
  const policy = deepFreeze({ ...POLICY });
  const before = JSON.stringify([ev, parsed, policy]);
  assert.doesNotThrow(() => reconcile(parsed, ev, policy));
  assert.equal(JSON.stringify([ev, parsed, policy]), before);
});

test('every verdict state is reachable and none is fabricated as a pass', () => {
  const seen = new Set<string>([
    check().verdict.state,
    check(
      evidence({
        run: ok(run({ conclusion: 'failure' })),
        jobs: ok(jobs(testJob(step('Gate', 'failure'), { conclusion: 'failure' }))),
      }),
    ).verdict.state,
    check(
      evidence({
        run: ok(run({ conclusion: 'failure' })),
        jobs: ok(jobs(testJob(null, { conclusion: 'failure' }))),
      }),
    ).verdict.state,
    check(evidence({ run: ok(run({ conclusion: 'cancelled' })) })).verdict.state,
    check(evidence({ run: ok(run({ status: 'in_progress', conclusion: null })) })).verdict.state,
    check(evidence({ run: ok(run({ event: 'pull_request' })) })).verdict.state,
    check(evidence({ run: ok(run({ runAttempt: 9 })) })).verdict.state,
    check(evidence({ jobs: failed('timeout') })).verdict.state,
  ]);
  assert.deepEqual([...seen].sort(), [...VERDICT_STATES].sort());
  // Without the Gate step no combination of other evidence produces a pass.
  for (const conclusion of ['success', 'failure', 'neutral', null]) {
    const r = check(evidence({ jobs: ok(jobs(testJob(null, { conclusion }))) }));
    assert.notEqual(r.verdict.state, 'VERIFIED_PASS');
  }
});

/* ------------------------------------------------------------------ *
 * Outcome consistency (PR #30 correction): run, job and Gate must agree
 * ------------------------------------------------------------------ */

function outcomes(
  runConclusion: string | null,
  jobConclusion: string | null,
  gate: StepEvidence | null,
  overrides: Partial<RunAttemptEvidence> = {},
): VerdictResult {
  return check(
    evidence({
      run: ok(run({ conclusion: runConclusion, ...overrides })),
      jobs: ok(jobs(testJob(gate, { conclusion: jobConclusion }))),
    }),
  );
}

test('run failure with job and Gate success is CONFLICT, not UNKNOWN', () => {
  assert.deepEqual(outcomes('failure', 'success', step('Gate', 'success')).verdict, {
    state: 'CONFLICT',
    reasons: ['outcome-run-not-success-job-and-gate-success'],
  });
  for (const runConclusion of ['timed_out', 'startup_failure', 'neutral']) {
    assert.equal(
      outcomes(runConclusion, 'success', step('Gate', 'success')).verdict.state,
      'CONFLICT',
      runConclusion,
    );
  }
});

test('run success with job and Gate failure is CONFLICT', () => {
  assert.deepEqual(outcomes('success', 'failure', step('Gate', 'failure')).verdict, {
    state: 'CONFLICT',
    reasons: ['outcome-run-success-job-not-success'],
  });
});

test('consistent outcomes still verify: all success passes, all failure fails', () => {
  assert.deepEqual(outcomes('success', 'success', step('Gate', 'success')).verdict, {
    state: 'VERIFIED_PASS',
    reasons: ['gate-success'],
  });
  assert.deepEqual(outcomes('failure', 'failure', step('Gate', 'failure')).verdict, {
    state: 'VERIFIED_FAIL',
    reasons: ['gate-failure'],
  });
});

test('a job failure before a completed Gate stays EXECUTION_FAILED', () => {
  for (const gate of [null, step('Gate', 'skipped'), step('Gate', null, 'in_progress')]) {
    assert.deepEqual(outcomes('failure', 'failure', gate).verdict, {
      state: 'EXECUTION_FAILED',
      reasons: ['job-failed-before-gate'],
    });
  }
});

test('a cancelled run with a completed successful Gate stays CANCELLED', () => {
  assert.deepEqual(outcomes('cancelled', 'success', step('Gate', 'success')).verdict, {
    state: 'CANCELLED',
    reasons: ['run-cancelled'],
  });
});

test('an identity mismatch with cancellation is CONFLICT', () => {
  const r = outcomes('cancelled', 'cancelled', step('Gate', 'success'), { id: RUN_ID + 7 });
  assert.deepEqual(r.verdict, { state: 'CONFLICT', reasons: ['identity-run-id-mismatch'] });
});

test('missing jobs evidence without a conflict stays UNKNOWN', () => {
  const r = check(
    evidence({ run: ok(run({ conclusion: 'failure' })), jobs: failed('http-error') }),
  );
  assert.deepEqual(r.verdict, { state: 'UNKNOWN', reasons: ['retrieval-jobs-http-error'] });
});

test('a pull-request run with an outcome discrepancy is UNTRUSTED_PROVENANCE', () => {
  const r = outcomes('failure', 'success', step('Gate', 'success'), {
    event: 'pull_request',
    headBranch: 'feature',
  });
  assert.deepEqual(r.verdict, {
    state: 'UNTRUSTED_PROVENANCE',
    reasons: ['provenance-branch', 'provenance-event'],
  });
  const withIdentity = outcomes('failure', 'success', step('Gate', 'success'), {
    event: 'pull_request',
    runAttempt: 5,
  });
  assert.deepEqual(withIdentity.verdict, {
    state: 'CONFLICT',
    reasons: ['identity-attempt-mismatch'],
  });
});

test('a failed advisory upload under continue-on-error does not alter the Gate verdict', () => {
  // The upload step really failed, but continue-on-error reports its
  // conclusion as success; either way only the Gate step is authoritative.
  for (const uploadConclusion of ['success', 'failure']) {
    const job = testJob(step('Gate', 'success'));
    const withUpload: JobEvidence = {
      ...job,
      steps: job.steps.map((s) =>
        s.name === 'Upload quality summary' ? { ...s, conclusion: uploadConclusion } : s,
      ),
    };
    const r = check(evidence({ jobs: ok(jobs(withUpload)) }));
    assert.equal(r.verdict.state, 'VERIFIED_PASS', uploadConclusion);
  }
});

test('outcome reason codes are fixed vocabulary, never response payloads', () => {
  const payload = `failure ${CANARY} {"message":"Bad credentials"}`;
  const cases = [
    outcomes('failure', 'success', step('Gate', 'success')),
    outcomes('success', 'failure', step('Gate', 'failure')),
    check(evidence({ run: ok(run({ conclusion: payload })) })),
    check(evidence({ jobs: { status: 'failed', reason: payload } as never })),
  ];
  for (const r of cases) {
    for (const reason of [...r.verdict.reasons, ...r.summary.reasons]) {
      assert.match(reason, /^[a-z][a-z0-9-]*$/);
    }
    assert.equal(JSON.stringify(r).includes(CANARY), false);
    assert.equal(JSON.stringify(r).includes('credentials'), false);
  }
});

/* ------------------------------------------------------------------ *
 * Size rejection (M8E-4 correction): declared or streamed over the limit
 * ------------------------------------------------------------------ */

const REJECTED_DECLARED: ArchiveEvidence = {
  status: 'rejected',
  artifactId: 15_000_001,
  reason: 'declared-too-large',
};
const REJECTED_STREAM: ArchiveEvidence = {
  status: 'rejected',
  artifactId: 15_000_001,
  reason: 'stream-too-large',
};

for (const archive of [REJECTED_DECLARED, REJECTED_STREAM]) {
  const label = archive.status === 'rejected' ? archive.reason : '';
  test(`a ${label} rejection is SUMMARY_INVALID archive-too-large without metrics`, () => {
    const r = check(evidence({ archive }), null);
    assert.deepEqual(r.verdict, { state: 'VERIFIED_PASS', reasons: ['gate-success'] });
    assert.deepEqual(r.summary, {
      state: 'SUMMARY_INVALID',
      reasons: ['archive-too-large'],
      metricsAvailable: false,
      label: null,
    });
    assert.equal(r.identity.artifactId, 15_000_001);
  });

  test(`a ${label} rejection never yields metrics even with a valid summary supplied`, () => {
    const r = check(evidence({ archive }), VALID);
    assert.equal(r.summary.state, 'SUMMARY_INVALID');
    assert.equal(r.summary.metricsAvailable, false);
  });
}

test('a size rejection does not change a VERIFIED_FAIL verdict', () => {
  const failedGate = testJob(step('Gate', 'failure'), { conclusion: 'failure' });
  const r = check(
    evidence({
      run: ok(run({ conclusion: 'failure' })),
      jobs: ok(jobs(failedGate)),
      archive: REJECTED_DECLARED,
    }),
    null,
  );
  assert.deepEqual(r.verdict, { state: 'VERIFIED_FAIL', reasons: ['gate-failure'] });
  assert.deepEqual(r.summary.reasons, ['archive-too-large']);
});

test('a size rejection for another artifact id is SUMMARY_CONFLICT', () => {
  const r = check(evidence({ archive: { ...REJECTED_DECLARED, artifactId: 15_000_009 } }), null);
  assert.deepEqual(r.summary.reasons, ['artifact-id-mismatch']);
});

test('established conflicts still precede a size rejection', () => {
  const r = check(
    evidence({
      artifacts: ok([artifact({ workflowRun: { ...artifact().workflowRun, id: RUN_ID + 1 } })]),
      archive: REJECTED_DECLARED,
    }),
    null,
  );
  assert.equal(r.summary.state, 'SUMMARY_CONFLICT');
  assert.deepEqual(r.summary.reasons, ['artifact-run-mismatch']);
});

test('expiry and absence still precede a size rejection', () => {
  assert.deepEqual(
    check(evidence({ artifacts: ok([artifact({ expired: true })]), archive: REJECTED_DECLARED }))
      .summary.reasons,
    ['artifact-expired'],
  );
  assert.deepEqual(
    check(evidence({ artifacts: ok([]), archive: REJECTED_DECLARED })).summary.reasons,
    ['artifact-absent'],
  );
});

test('a size rejection without the run attempt cannot be bound', () => {
  const r = check(evidence({ run: failed('timeout'), archive: REJECTED_DECLARED }), null);
  assert.deepEqual(r.summary.reasons, ['binding-run-attempt-unavailable']);
});

test('a malformed rejection is treated as malformed archive evidence', () => {
  for (const archive of [
    { status: 'rejected', artifactId: 15_000_001, reason: 'huge' },
    { status: 'rejected', artifactId: 0, reason: 'declared-too-large' },
    { status: 'rejected', reason: 'stream-too-large' },
  ]) {
    assert.deepEqual(check(evidence({ archive: archive as never }), null).summary.reasons, [
      'retrieval-archive-malformed',
    ]);
  }
});
