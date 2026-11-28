/**
 * Unit tests for the README health refresh decision (ADR-0013, Phase C5A).
 * Pure: every fact is injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REFRESH_POLICY,
  REFRESH_REASONS,
  candidateProblems,
  classifyChanges,
  classifyPath,
  decideRefresh,
  evidenceProblems,
  type CandidateEvidence,
  type CandidateRun,
  type RefreshFacts,
} from './refresh-decision.ts';
import { VERDICT_STATES } from './verdict.ts';

const SNAPSHOT_SHA = '305665bd54df997d7040078e7e57becf83f86b0c';
const CANDIDATE_SHA = 'bf3c489d0665c7119dce98d19c69b25fe61209bf';

function candidate(overrides: Partial<CandidateRun> = {}): CandidateRun {
  return {
    repository: REFRESH_POLICY.repository,
    workflowPath: REFRESH_POLICY.workflowPath,
    event: 'push',
    headBranch: 'main',
    headRepository: REFRESH_POLICY.repository,
    status: 'completed',
    runId: 46164539112,
    runAttempt: 1,
    latestAttempt: 1,
    headSha: CANDIDATE_SHA,
    completedAt: '2026-11-28T16:24:00Z',
    ...overrides,
  };
}

function evidence(overrides: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    verdict: 'VERIFIED_PASS',
    summary: 'SUMMARY_VERIFIED_ORIGIN',
    unit: 'complete',
    playwright: 'complete',
    identity: 'match',
    healthBundle: 'match',
    ...overrides,
  };
}

/** A test-affecting change since the snapshot, measured by a run at `main`. */
function facts(overrides: Partial<RefreshFacts> = {}): RefreshFacts {
  return {
    candidate: candidate(),
    evidence: evidence(),
    snapshot: {
      sourceSha: SNAPSHOT_SHA,
      runId: 46162493309,
      runAttempt: 1,
      completedAt: '2026-11-28T16:00:29Z',
    },
    candidateVsSnapshot: 'descendant',
    candidateVsMain: 'same',
    changesSinceSnapshotSource: ['src/reporting/readme-health.ts', 'README.md'],
    changesSinceCandidateSource: [],
    metrics: 'different',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Path impact
 * ------------------------------------------------------------------ */

test('paths are classified by the ADR-0012 minimum list, documentation is a closed list', () => {
  const cases: [string, string][] = [
    ['tests/ui/login.spec.ts', 'test-affecting'],
    ['src/reporting/verdict.ts', 'test-affecting'],
    ['dashboard/app.ts', 'test-affecting'],
    ['scripts/test-health.ts', 'test-affecting'],
    ['.github/workflows/tests.yml', 'test-affecting'],
    ['playwright.config.ts', 'test-affecting'],
    ['package.json', 'test-affecting'],
    ['package-lock.json', 'test-affecting'],
    ['README.md', 'documentation'],
    ['CLAUDE.md', 'documentation'],
    ['docs/adr/0013-automated-readme-health-refresh.md', 'documentation'],
    ['docs/security-testing-policy.md', 'documentation'],
    ['.nvmrc', 'unknown-impact'],
    ['tsconfig.json', 'unknown-impact'],
    ['eslint.config.mjs', 'unknown-impact'],
    ['.github/CODEOWNERS', 'unknown-impact'],
    ['docs/diagram.png', 'unknown-impact'],
    ['.env.example', 'unknown-impact'],
    ['a/b.md', 'unknown-impact'],
    ['/README.md', 'unknown-impact'],
    ['docs/../src/x.md', 'unknown-impact'],
    ['docs//x.md', 'unknown-impact'],
    ['', 'unknown-impact'],
    ['docs/with space.md', 'unknown-impact'],
  ];
  for (const [path, impact] of cases) assert.equal(classifyPath(path), impact, path);
});

test('change classes: unknown impact outranks test-affecting; null is unavailable', () => {
  assert.deepEqual(classifyChanges(null), { kind: 'unavailable' });
  assert.equal(classifyChanges([]).kind, 'none');
  assert.equal(classifyChanges(['README.md', 'docs/adr/x.md']).kind, 'documentation-only');
  assert.equal(classifyChanges(['README.md', 'src/a.ts']).kind, 'test-affecting');
  assert.deepEqual(classifyChanges(['src/a.ts', '.nvmrc', 'README.md']), {
    kind: 'unknown-impact',
    testAffecting: 1,
    documentation: 1,
    unknownImpact: 1,
  });
});

/* ------------------------------------------------------------------ *
 * Eligibility and evidence
 * ------------------------------------------------------------------ */

test('an eligible run with a test-affecting change since the snapshot is a refresh', () => {
  assert.deepEqual(decideRefresh(facts()), {
    action: 'refresh',
    reasons: ['test-affecting-change-since-snapshot', 'substantive-change'],
  });
});

test('every candidate eligibility problem is reported together, never as a pass', () => {
  const reasons = candidateProblems(
    candidate({
      repository: 'someone/fork',
      workflowPath: '.github/workflows/other.yml',
      event: 'pull_request',
      headBranch: 'feature',
      headRepository: 'someone/fork',
      status: 'in_progress',
      completedAt: null,
    }),
  );
  assert.deepEqual(reasons, [
    'wrong-repository',
    'wrong-workflow',
    'not-push-event',
    'not-main-branch',
    'foreign-head-repository',
    'run-not-completed',
    'completion-time-missing',
  ]);
  assert.deepEqual(decideRefresh(facts({ candidate: candidate({ event: 'pull_request' }) })), {
    action: 'skip',
    reasons: ['not-push-event'],
  });
});

test('a fork head is rejected even when the event claims a push to main', () => {
  const decision = decideRefresh(
    facts({
      candidate: candidate({
        headRepository: 'attacker/playwright-typescript-automation-framework',
      }),
    }),
  );
  assert.deepEqual(decision, { action: 'skip', reasons: ['foreign-head-repository'] });
});

test('a superseded attempt and an invalid identity are rejected', () => {
  assert.deepEqual(candidateProblems(candidate({ runAttempt: 1, latestAttempt: 2 })), [
    'attempt-superseded',
  ]);
  // An attempt newer than the run's newest attempt is impossible, not eligible.
  assert.deepEqual(candidateProblems(candidate({ runAttempt: 3, latestAttempt: 2 })), [
    'invalid-run-identity',
  ]);
  assert.deepEqual(candidateProblems(candidate({ runAttempt: 2, latestAttempt: 2 })), []);
  for (const bad of [
    { runId: 0 },
    { runAttempt: 0 },
    { runAttempt: 1.5 },
    { latestAttempt: -1 },
    { headSha: 'ABC' },
    { headSha: CANDIDATE_SHA.toUpperCase() },
  ]) {
    assert.deepEqual(
      candidateProblems(candidate(bad)),
      ['invalid-run-identity'],
      JSON.stringify(bad),
    );
  }
  for (const completedAt of [
    '2026-11-28T16:24:00.000Z',
    '2026-02-30T16:24:00Z',
    '2026-11-28T24:00:00Z',
    '2026-11-31T00:00:00Z',
  ]) {
    assert.deepEqual(
      candidateProblems(candidate({ completedAt })),
      ['completion-time-missing'],
      completedAt,
    );
  }
});

test('every non-VERIFIED_PASS verdict yields its own reason; CONFLICT needs review', () => {
  for (const verdict of VERDICT_STATES.filter((state) => state !== 'VERIFIED_PASS')) {
    const decision = decideRefresh(facts({ evidence: evidence({ verdict }) }));
    assert.equal(decision.reasons.length, 1, verdict);
    assert.ok(decision.reasons[0]?.startsWith('verdict-'), verdict);
    assert.equal(decision.action, verdict === 'CONFLICT' ? 'blocked' : 'skip', verdict);
  }
});

test('partial, missing or conflicting evidence is never publishable', () => {
  assert.deepEqual(
    evidenceProblems(
      evidence({
        summary: 'SUMMARY_INFORMATIVE',
        unit: 'partial',
        playwright: 'unavailable',
        identity: 'mismatch',
        healthBundle: 'mismatch',
      }),
    ),
    [
      'summary-not-verified-origin',
      'unit-evidence-partial',
      'playwright-evidence-unavailable',
      'evidence-identity-mismatch',
      'health-bundle-mismatch',
    ],
  );
  assert.deepEqual(evidenceProblems(evidence({ unit: 'unavailable', playwright: 'partial' })), [
    'unit-evidence-unavailable',
    'playwright-evidence-partial',
  ]);
  assert.deepEqual(decideRefresh(facts({ evidence: evidence({ healthBundle: 'unavailable' }) })), {
    action: 'skip',
    reasons: ['health-bundle-unavailable'],
  });
  assert.equal(
    decideRefresh(facts({ evidence: evidence({ identity: 'mismatch' }) })).action,
    'blocked',
  );
});

test('a failed run never falls back to the older snapshot as if it were current', () => {
  const decision = decideRefresh(
    facts({ evidence: evidence({ verdict: 'VERIFIED_FAIL', unit: 'complete' }) }),
  );
  assert.deepEqual(decision, { action: 'skip', reasons: ['verdict-verified-fail'] });
  assert.notEqual(decision.action, 'no-op');
});

test('an unreadable README pin blocks publication', () => {
  assert.deepEqual(decideRefresh(facts({ snapshot: undefined })), {
    action: 'blocked',
    reasons: ['snapshot-pin-unreadable'],
  });
});

/* ------------------------------------------------------------------ *
 * Ordering: ancestry and attempt, never run id alone
 * ------------------------------------------------------------------ */

test('a run with a larger run id but an older source commit is rejected', () => {
  const decision = decideRefresh(
    facts({ candidate: candidate({ runId: 99999999999 }), candidateVsSnapshot: 'ancestor' }),
  );
  assert.deepEqual(decision, { action: 'skip', reasons: ['candidate-older-than-snapshot'] });
});

test('divergent sources are rejected and unknown ancestry needs review', () => {
  assert.deepEqual(decideRefresh(facts({ candidateVsSnapshot: 'diverged' })), {
    action: 'skip',
    reasons: ['divergent-source'],
  });
  assert.deepEqual(decideRefresh(facts({ candidateVsSnapshot: 'unknown' })), {
    action: 'blocked',
    reasons: ['ancestry-unknown'],
  });
  assert.deepEqual(decideRefresh(facts({ candidateVsMain: 'diverged' })), {
    action: 'skip',
    reasons: ['divergent-source'],
  });
  assert.deepEqual(decideRefresh(facts({ candidateVsMain: 'unknown' })), {
    action: 'blocked',
    reasons: ['ancestry-unknown'],
  });
  assert.deepEqual(decideRefresh(facts({ candidateVsMain: 'descendant' })), {
    action: 'blocked',
    reasons: ['candidate-ahead-of-main'],
  });
});

test('the same source is ordered by attempt within the same run only', () => {
  const same = {
    candidateVsSnapshot: 'same' as const,
    changesSinceSnapshotSource: [],
  };
  const pinned = { headSha: SNAPSHOT_SHA, runId: 46162493309 };
  assert.deepEqual(
    decideRefresh(facts({ ...same, candidate: candidate({ ...pinned, runAttempt: 1 }) })),
    { action: 'no-op', reasons: ['same-evidence-as-snapshot'] },
  );
  const olderSnapshot = facts({ ...same, candidate: candidate({ ...pinned, runAttempt: 1 }) });
  assert.deepEqual(
    decideRefresh({ ...olderSnapshot, snapshot: { ...olderSnapshot.snapshot!, runAttempt: 2 } }),
    { action: 'skip', reasons: ['attempt-older-than-snapshot'] },
  );
  assert.deepEqual(
    decideRefresh(
      facts({ ...same, candidate: candidate({ ...pinned, runAttempt: 2, latestAttempt: 2 }) }),
    ),
    { action: 'refresh', reasons: ['newer-attempt-of-snapshot-source', 'substantive-change'] },
  );
  assert.deepEqual(
    decideRefresh(
      facts({
        ...same,
        metrics: 'same',
        candidate: candidate({ ...pinned, runAttempt: 2, latestAttempt: 2 }),
      }),
    ),
    { action: 'no-op', reasons: ['newer-attempt-of-snapshot-source', 'no-substantive-change'] },
  );
  assert.deepEqual(
    decideRefresh(facts({ ...same, candidate: candidate({ headSha: SNAPSHOT_SHA, runId: 1 }) })),
    { action: 'blocked', reasons: ['same-source-different-run'] },
  );
});

/* ------------------------------------------------------------------ *
 * The two comparisons
 * ------------------------------------------------------------------ */

test('candidate..main: documentation-only changes on main do not stop a refresh', () => {
  const decision = decideRefresh(
    facts({ candidateVsMain: 'ancestor', changesSinceCandidateSource: ['README.md'] }),
  );
  assert.equal(decision.action, 'refresh');
});

test('candidate..main: a test-affecting change supersedes the run; unknown impact needs review', () => {
  assert.deepEqual(
    decideRefresh(
      facts({ candidateVsMain: 'ancestor', changesSinceCandidateSource: ['src/x.ts'] }),
    ),
    { action: 'skip', reasons: ['superseded-by-test-affecting-change'] },
  );
  assert.deepEqual(
    decideRefresh(facts({ candidateVsMain: 'ancestor', changesSinceCandidateSource: ['.nvmrc'] })),
    { action: 'blocked', reasons: ['unknown-impact-since-candidate'] },
  );
  assert.deepEqual(
    decideRefresh(facts({ candidateVsMain: 'ancestor', changesSinceCandidateSource: null })),
    { action: 'blocked', reasons: ['changes-since-candidate-unavailable'] },
  );
});

test('snapshot..candidate: unknown impact blocks; an unavailable list blocks', () => {
  assert.deepEqual(decideRefresh(facts({ changesSinceSnapshotSource: ['tsconfig.json'] })), {
    action: 'blocked',
    reasons: ['unknown-impact-since-snapshot'],
  });
  assert.deepEqual(decideRefresh(facts({ changesSinceSnapshotSource: null })), {
    action: 'blocked',
    reasons: ['changes-since-snapshot-unavailable'],
  });
});

test('a test-affecting change re-pins the snapshot even when the figures are unchanged', () => {
  assert.deepEqual(decideRefresh(facts({ metrics: 'same' })), {
    action: 'refresh',
    reasons: ['test-affecting-change-since-snapshot'],
  });
});

/* ------------------------------------------------------------------ *
 * Loop prevention without hiding substantive changes
 * ------------------------------------------------------------------ */

test('the push run of a merged README refresh is a no-op (no docs-merge loop)', () => {
  const decision = decideRefresh(
    facts({ changesSinceSnapshotSource: ['README.md'], metrics: 'same' }),
  );
  assert.deepEqual(decision, {
    action: 'no-op',
    reasons: ['documentation-only-no-substantive-change'],
  });
});

test('documentation-only changes never hide a substantive change', () => {
  assert.deepEqual(
    decideRefresh(facts({ changesSinceSnapshotSource: ['docs/adr/x.md'], metrics: 'different' })),
    { action: 'refresh', reasons: ['substantive-change'] },
  );
});

test('the ADR-0012 30-day age limit applies even without a substantive change', () => {
  const docsOnly = { changesSinceSnapshotSource: ['README.md'], metrics: 'same' as const };
  assert.deepEqual(
    decideRefresh(
      facts({ ...docsOnly, candidate: candidate({ completedAt: '2026-12-28T16:00:30Z' }) }),
    ),
    { action: 'refresh', reasons: ['snapshot-age-exceeded'] },
  );
  assert.deepEqual(
    decideRefresh(
      facts({ ...docsOnly, candidate: candidate({ completedAt: '2026-12-28T16:00:29Z' }) }),
    ),
    { action: 'no-op', reasons: ['documentation-only-no-substantive-change'] },
  );
});

test('unknown snapshot metrics block a no-op but not a justified refresh', () => {
  assert.deepEqual(
    decideRefresh(facts({ changesSinceSnapshotSource: ['README.md'], metrics: 'unavailable' })),
    { action: 'blocked', reasons: ['snapshot-metrics-unavailable'] },
  );
  assert.deepEqual(decideRefresh(facts({ metrics: 'unavailable' })), {
    action: 'refresh',
    reasons: ['test-affecting-change-since-snapshot'],
  });
});

test('an empty change range is treated like documentation-only', () => {
  assert.deepEqual(decideRefresh(facts({ changesSinceSnapshotSource: [], metrics: 'same' })), {
    action: 'no-op',
    reasons: ['documentation-only-no-substantive-change'],
  });
});

test('every reason the decision can return is a declared reason code', () => {
  const declared = new Set<string>(REFRESH_REASONS);
  const samples = [
    facts(),
    facts({ snapshot: undefined }),
    facts({ candidateVsSnapshot: 'ancestor' }),
    facts({ changesSinceSnapshotSource: ['README.md'], metrics: 'same' }),
    facts({ evidence: evidence({ verdict: 'UNKNOWN', identity: 'mismatch' }) }),
  ];
  for (const sample of samples) {
    for (const reason of decideRefresh(sample).reasons) assert.ok(declared.has(reason), reason);
  }
  assert.equal(new Set(REFRESH_REASONS).size, REFRESH_REASONS.length);
});
