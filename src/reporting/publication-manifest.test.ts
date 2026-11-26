/**
 * Unit tests for the publication manifest contract (ADR-0011 P1).
 *
 * Same conventions as the other unit tests (ADR-0002). All evidence is
 * synthetic and shaped like the operator transport output; retained bundles
 * are produced by the committed operator functions from synthetic evidence.
 * No retained local bundle is read and nothing contacts GitHub.
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
  twelveEighteenNineteen,
} from './fixtures.ts';
import {
  buildBundle,
  reconcileCollected,
  serializeBundle,
  type BaseTrustPolicy,
  type Collected,
} from './verdict-cli.ts';
import type {
  ArchiveEvidence,
  ArtifactEvidence,
  JobEvidence,
  RunAttemptEvidence,
  StepEvidence,
  VerdictEvidence,
} from './verdict.ts';
import {
  parseVerdictBundle,
  type PublicPolicy,
  type UnauthenticatedBundle,
} from './verdict-bundle.ts';
import {
  MAX_MANIFEST_ENTRIES,
  STALE_PUBLICATION_DAYS,
  SYNTHETIC_LABEL,
  buildPublicationManifest,
  outputScan,
  publicationAge,
  verificationAge,
  verifiedTotals,
  type ManifestEntry,
  type ManifestEntryInput,
  type ManifestInput,
  type ManifestOutcome,
  type PublicationManifest,
} from './publication-manifest.ts';

/* ------------------------------------------------------------------ *
 * Synthetic evidence
 * ------------------------------------------------------------------ */

const REPO_ID = 900_000_001;
const REPO = 'example-owner/example-repo';
const WORKFLOW_ID = 800_000_001;
const RUN_ID = 1_000_001; // matches fixtures.context()
const HEAD = SYNTHETIC_SHA;
const ARTIFACT_ID = 15_000_001;
const API_DIGEST = `sha256:${'ab'.repeat(32)}`;
const SOURCE_COMMIT = 'c0ffee0000000000000000000000000000c0ffee';
const BUILT_AT = '2026-11-26T12:00:00.000Z';
const TOKEN_CANARY = ['ghp', 'TOKENCANARY0123456789abcdefABCDEF'].join('_');
const PATH_CANARY = '/Users/example/QualityVerdictEvidence/quality-verdict-1-1.json';
const URL_CANARY = 'https://productionresultssa1.blob.core.windows.net/x?sig=SIGNEDURLCANARY9f8e7d';

const BASE_POLICY: BaseTrustPolicy = {
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
};

const POLICY: PublicPolicy = {
  repositoryId: REPO_ID,
  repositoryFullName: REPO,
  workflowId: WORKFLOW_ID,
  workflowPath: '.github/workflows/tests.yml',
  workflowName: 'Playwright UI Tests',
  trustedEvent: 'push',
  trustedBranch: 'main',
};

function run(runId: number, overrides: Partial<RunAttemptEvidence> = {}): RunAttemptEvidence {
  return {
    id: runId,
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

function step(name: string, conclusion: string | null = 'success'): StepEvidence {
  return { number: name.length, name, status: 'completed', conclusion };
}

function jobs(): JobEvidence[] {
  return [
    {
      // Unused job and step names carry canaries; none may reach the manifest.
      id: 70_000_001,
      name: `checks ${TOKEN_CANARY}`,
      runAttempt: 1,
      headSha: HEAD,
      status: 'completed',
      conclusion: 'success',
      steps: [step(PATH_CANARY), step(URL_CANARY)],
    },
    {
      id: 70_000_004,
      name: 'test',
      runAttempt: 1,
      headSha: HEAD,
      status: 'completed',
      conclusion: 'success',
      steps: [step(CANARY), step('Gate')],
    },
  ];
}

function artifact(runId: number, overrides: Partial<ArtifactEvidence> = {}): ArtifactEvidence {
  return {
    id: ARTIFACT_ID,
    name: 'quality-summary-1',
    sizeInBytes: 2_700,
    digest: API_DIGEST,
    createdAt: '2026-11-26T01:09:00Z',
    expiresAt: '2026-12-03T01:09:00Z',
    expired: false,
    workflowRun: { id: runId, repositoryId: REPO_ID, headRepositoryId: REPO_ID, headSha: HEAD },
    ...overrides,
  };
}

const MATCHED: ArchiveEvidence = {
  status: 'downloaded',
  artifactId: ARTIFACT_ID,
  digestCheck: 'match',
  contents: 'single-summary',
};

function summaryFor(runId: number, overrides: Record<string, unknown> = {}): ParsedSummary {
  return parseSummary(
    serialize(normalize(twelveEighteenNineteen(), context({ runId, ...overrides }))),
  );
}

/** Raw transport evidence for one run attempt (VERIFIED_PASS, verified origin by default). */
function collected(
  runId = RUN_ID,
  overrides: Partial<VerdictEvidence> = {},
  extra: Partial<Collected> = {},
): Collected {
  return {
    evidence: {
      request: { runId, runAttempt: 1 },
      run: { status: 'ok', value: run(runId) },
      jobs: { status: 'ok', value: jobs() },
      ancestry: {
        status: 'ok',
        value: {
          evaluatedSha: HEAD,
          mainTipSha: 'fedcba9876543210fedcba9876543210fedcba98',
          relation: 'head-is-ancestor',
        },
      },
      artifacts: {
        status: 'ok',
        value: [artifact(runId, { id: 15_000_000, name: PATH_CANARY }), artifact(runId)],
      },
      archive: MATCHED,
      ...overrides,
    },
    summary: summaryFor(runId),
    digest: 'verified',
    redirectRefused: false,
    ...extra,
  };
}

function prCollected(runId: number): Collected {
  return collected(
    runId,
    { run: { status: 'ok', value: run(runId, { event: 'pull_request', headBranch: 'feature' }) } },
    { summary: summaryFor(runId, { event: 'pull_request', branch: 'feature' }) },
  );
}

/** A retained bundle exactly as the operator wrote it, parsed (unauthenticated). */
function retainedFrom(c: Collected): UnauthenticatedBundle {
  const text = serializeBundle(buildBundle(reconcileCollected(c, BASE_POLICY), c, BASE_POLICY));
  const parsed = parseVerdictBundle(text, POLICY);
  if (parsed.status !== 'valid') throw new Error(`synthetic bundle rejected: ${parsed.code}`);
  return parsed.bundle;
}

function verified(c: Collected, retained: UnauthenticatedBundle | null = null): ManifestEntryInput {
  return {
    kind: 'build-verified',
    runId: c.evidence.request.runId,
    runAttempt: c.evidence.request.runAttempt,
    collected: c,
    retained,
  };
}

function retained(b: UnauthenticatedBundle): ManifestEntryInput {
  return {
    kind: 'retained',
    runId: b.content.request.runId,
    runAttempt: b.content.request.runAttempt,
    bundle: b,
  };
}

function input(
  entries: readonly ManifestEntryInput[],
  overrides: Partial<ManifestInput> = {},
): ManifestInput {
  return {
    build: {
      sourceCommit: SOURCE_COMMIT,
      builtAt: BUILT_AT,
      workingTree: 'clean',
      policy: BASE_POLICY,
    },
    entries,
    synthetic: null,
    includeUntrustedOrigin: false,
    ...overrides,
  };
}

type Built = Extract<ManifestOutcome, { status: 'built' }>;

function built(outcome: ManifestOutcome): Built {
  assert.equal(outcome.status, 'built', JSON.stringify(outcome));
  if (outcome.status !== 'built') throw new Error('unreachable');
  return outcome;
}

function rejected(outcome: ManifestOutcome): string {
  assert.equal(outcome.status, 'rejected', 'expected a rejection');
  if (outcome.status !== 'rejected') throw new Error('unreachable');
  return outcome.code;
}

function only(manifest: PublicationManifest): ManifestEntry {
  assert.equal(manifest.results.length, 1);
  const entry = manifest.results[0];
  if (entry === undefined) throw new Error('unreachable');
  return entry;
}

/* ------------------------------------------------------------------ *
 * Build-verified results
 * ------------------------------------------------------------------ */

test('a build-verified pass is BUILD_VERIFIED, CURRENT, verified at builtAt, with verified metrics', () => {
  const out = built(buildPublicationManifest(input([verified(collected())])));
  const e = only(out.manifest);
  assert.deepEqual(e.gate, {
    state: 'VERIFIED_PASS',
    reasons: ['gate-success'],
    authenticity: 'BUILD_VERIFIED',
    freshness: 'CURRENT',
    verifiedAt: BUILT_AT,
  });
  assert.deepEqual(e.summary, {
    state: 'SUMMARY_VERIFIED_ORIGIN',
    reasons: ['verified-origin'],
    label: 'verified-origin',
  });
  assert.deepEqual(e.artifact, {
    id: ARTIFACT_ID,
    digest: API_DIGEST,
    integrity: 'verified-in-build',
  });
  assert.equal(e.metrics?.authenticity, 'BUILD_VERIFIED');
  assert.equal(e.metrics?.freshness, 'CURRENT');
  assert.equal(e.metrics?.totals.instances, 18);
  assert.deepEqual(out.manifest.build, {
    sourceCommit: SOURCE_COMMIT,
    builtAt: BUILT_AT,
    policy: POLICY,
  });
  assert.equal(out.manifest.manifestSchemaVersion, '1.0.0');
  assert.equal(out.manifest.kind, 'quality-verdict-publication');
  assert.deepEqual(out.omitted, []);
});

test('the input has no field through which a verdict or authenticity can be asserted', () => {
  // The evidence says the Gate failed; an injected claim is ignored.
  const c = collected(RUN_ID, {
    run: { status: 'ok', value: run(RUN_ID, { conclusion: 'failure' }) },
    jobs: {
      status: 'ok',
      value: jobs().map((j) =>
        j.name === 'test' ? { ...j, conclusion: 'failure', steps: [step('Gate', 'failure')] } : j,
      ),
    },
  });
  const forged = {
    ...verified(c),
    verdict: { state: 'VERIFIED_PASS', reasons: ['gate-success'] },
    authenticity: 'BUILD_VERIFIED',
  } as unknown as ManifestEntryInput;
  const e = only(built(buildPublicationManifest(input([forged]))).manifest);
  assert.equal(e.gate.state, 'VERIFIED_FAIL');
  // The summary's observed inputs all succeeded: a conflict, so no metrics.
  assert.equal(e.summary.state, 'SUMMARY_CONFLICT');
  assert.equal(e.metrics, null);
});

test('the digest flag comes only from the archive evidence, never from collected.digest alone', () => {
  const c = collected(RUN_ID, { archive: { status: 'not-attempted' } }, { digest: 'verified' });
  const e = only(built(buildPublicationManifest(input([verified(c)]))).manifest);
  assert.equal(e.summary.state, 'SUMMARY_UNAVAILABLE');
  assert.equal(e.artifact.integrity, 'not-checked');
  assert.equal(e.metrics, null);
});

test('a build-verified Gate with an unchecked digest keeps metrics unavailable', () => {
  const c = collected(RUN_ID, {}, { digest: 'not-checked' });
  const e = only(built(buildPublicationManifest(input([verified(c)]))).manifest);
  assert.equal(e.gate.authenticity, 'BUILD_VERIFIED');
  assert.equal(e.summary.state, 'SUMMARY_INFORMATIVE');
  assert.equal(e.summary.label, 'unverified-origin');
  assert.equal(e.metrics, null);
});

test('a build-verified Gate with an absent summary artifact has no metrics, never zeros', () => {
  const c = collected(
    RUN_ID,
    { artifacts: { status: 'ok', value: [] }, archive: { status: 'not-attempted' } },
    { summary: null, digest: 'not-checked' },
  );
  const out = built(buildPublicationManifest(input([verified(c)])));
  const e = only(out.manifest);
  assert.equal(e.gate.state, 'VERIFIED_PASS');
  assert.equal(e.gate.authenticity, 'BUILD_VERIFIED');
  assert.deepEqual(e.summary.reasons, ['artifact-absent']);
  assert.deepEqual(e.artifact, { id: null, digest: null, integrity: 'not-checked' });
  assert.equal(e.metrics, null);
  assert.equal(/"metrics": \{/.test(out.text), false);
});

test('an expired summary artifact is unavailable with metrics omitted', () => {
  const c = collected(
    RUN_ID,
    {
      artifacts: { status: 'ok', value: [artifact(RUN_ID, { expired: true })] },
      archive: { status: 'failed', reason: 'expired' },
    },
    { summary: null, digest: 'not-checked' },
  );
  const e = only(built(buildPublicationManifest(input([verified(c)]))).manifest);
  assert.equal(e.gate.freshness, 'CURRENT');
  assert.equal(e.summary.state, 'SUMMARY_UNAVAILABLE');
  assert.deepEqual(e.summary.reasons, ['artifact-expired']);
  assert.equal(e.artifact.integrity, 'not-checked');
  assert.equal(e.metrics, null);
});

test('a digest mismatch is published as a conflict with integrity mismatch and no metrics', () => {
  const c = collected(
    RUN_ID,
    { archive: { ...MATCHED, digestCheck: 'mismatch', contents: 'unexpected-entries' } },
    { summary: null, digest: 'mismatch' },
  );
  const e = only(built(buildPublicationManifest(input([verified(c)]))).manifest);
  assert.equal(e.summary.state, 'SUMMARY_CONFLICT');
  assert.equal(e.artifact.integrity, 'mismatch');
  assert.equal(e.metrics, null);
});

test('run metadata that cannot be retrieved yields no BUILD_VERIFIED claim', () => {
  const c = collected(RUN_ID, { run: { status: 'failed', reason: 'not-found' } });
  const out = built(buildPublicationManifest(input([verified(c)])));
  assert.deepEqual(out.manifest.results, []);
  assert.deepEqual(out.omitted, [{ runId: RUN_ID, runAttempt: 1, reason: 'run-not-retrievable' }]);
});

test('an unretrievable run with a retained bundle is shown only as historical retained evidence', () => {
  const kept = retainedFrom(collected());
  const c = collected(RUN_ID, { jobs: { status: 'failed', reason: 'timeout' } });
  const e = only(built(buildPublicationManifest(input([verified(c, kept)]))).manifest);
  assert.equal(e.gate.authenticity, 'RETAINED_UNAUTHENTICATED');
  assert.equal(e.gate.freshness, 'HISTORICAL');
  assert.equal(e.gate.verifiedAt, null);
  assert.equal(e.metrics, null);
});

test('evidence for another attempt or another run is rejected', () => {
  const c = collected();
  const wrongAttempt = { ...verified(c), runAttempt: 2 } as ManifestEntryInput;
  assert.equal(rejected(buildPublicationManifest(input([wrongAttempt]))), 'request-mismatch');
  const otherRun = collected(RUN_ID, { run: { status: 'ok', value: run(RUN_ID + 5) } });
  assert.equal(
    rejected(buildPublicationManifest(input([verified(otherRun)]))),
    'identity-mismatch',
  );
});

test('malformed raw evidence is rejected, not published', () => {
  const broken = { ...verified(collected()), collected: { evidence: null } } as unknown;
  assert.equal(
    rejected(buildPublicationManifest(input([broken as ManifestEntryInput]))),
    'invalid-evidence',
  );
  const noRequest = collected();
  const badRequest = {
    ...verified(noRequest),
    collected: {
      ...noRequest,
      evidence: { ...noRequest.evidence, request: { runId: 0, runAttempt: 1 } },
    },
    runId: 0,
  } as unknown as ManifestEntryInput;
  assert.equal(rejected(buildPublicationManifest(input([badRequest]))), 'invalid-entry');
});

/* ------------------------------------------------------------------ *
 * Retained bundles: never promoted
 * ------------------------------------------------------------------ */

test('a retained bundle claiming VERIFIED_PASS stays RETAINED_UNAUTHENTICATED and HISTORICAL', () => {
  const kept = retainedFrom(collected());
  assert.equal(kept.content.verdict.state, 'VERIFIED_PASS');
  const out = built(buildPublicationManifest(input([retained(kept)])));
  const e = only(out.manifest);
  assert.deepEqual(e.gate, {
    state: 'VERIFIED_PASS',
    reasons: ['gate-success'],
    authenticity: 'RETAINED_UNAUTHENTICATED',
    freshness: 'HISTORICAL',
    verifiedAt: null,
  });
  // The bundle records a digest status only; the value is not invented.
  assert.deepEqual(e.artifact, {
    id: ARTIFACT_ID,
    digest: null,
    integrity: 'retained-not-reverified',
  });
  // Historical retained metrics are disabled by default.
  assert.equal(e.metrics, null);
  assert.equal(out.text.includes('BUILD_VERIFIED'), false);
  assert.deepEqual(verifiedTotals(out.manifest), {});
});

test('a hand-built retained object claiming BUILD_VERIFIED is rejected', () => {
  const kept = retainedFrom(collected());
  const claims = [
    { ...kept, authenticity: 'BUILD_VERIFIED' },
    { ...kept, content: { ...kept.content, authenticity: 'BUILD_VERIFIED' } },
    {
      ...kept,
      content: {
        ...kept.content,
        verdict: { ...kept.content.verdict, authenticity: 'BUILD_VERIFIED' },
      },
    },
    { ...kept, verifiedAt: BUILT_AT },
  ];
  for (const bundle of claims) {
    const entry = { ...retained(kept), bundle } as unknown as ManifestEntryInput;
    assert.equal(rejected(buildPublicationManifest(input([entry]))), 'retained-invalid');
  }
});

test('a hand-built retained object with forged content is re-validated and rejected', () => {
  const pr = retainedFrom(prCollected(RUN_ID));
  const forged = {
    authenticity: 'UNAUTHENTICATED',
    content: {
      ...pr.content,
      verdict: { state: 'VERIFIED_PASS', reasons: ['gate-success'] },
    },
  } as UnauthenticatedBundle;
  assert.equal(rejected(buildPublicationManifest(input([retained(forged)]))), 'retained-invalid');
  const missing = { ...retained(pr), bundle: null } as unknown as ManifestEntryInput;
  assert.equal(rejected(buildPublicationManifest(input([missing]))), 'retained-invalid');
});

test('a retained bundle must belong to the allow-listed attempt', () => {
  const kept = retainedFrom(collected());
  const entry = { ...retained(kept), runId: RUN_ID + 1 } as ManifestEntryInput;
  assert.equal(rejected(buildPublicationManifest(input([entry]))), 'request-mismatch');
});

test('a retained bundle that agrees with the rebuilt verdict yields the build-verified entry', () => {
  const kept = retainedFrom(collected());
  const e = only(built(buildPublicationManifest(input([verified(collected(), kept)]))).manifest);
  assert.equal(e.gate.authenticity, 'BUILD_VERIFIED');
});

test('a retained bundle that disagrees with the rebuilt verdict fails the build', () => {
  const kept = retainedFrom(collected());
  const now = collected(RUN_ID, {
    run: { status: 'ok', value: run(RUN_ID, { status: 'in_progress', conclusion: null }) },
  });
  const out = buildPublicationManifest(input([verified(now, kept)]));
  assert.deepEqual(out, {
    status: 'rejected',
    code: 'retained-disagrees',
    runId: RUN_ID,
    runAttempt: 1,
  });
});

test('a retained bundle without an established identity cannot be published', () => {
  const kept = retainedFrom(collected(RUN_ID, { run: { status: 'failed', reason: 'timeout' } }));
  assert.equal(
    rejected(buildPublicationManifest(input([retained(kept)]))),
    'retained-identity-incomplete',
  );
});

/* ------------------------------------------------------------------ *
 * Untrusted origin, synthetic data and totals
 * ------------------------------------------------------------------ */

test('pull-request runs are excluded by default and never verified', () => {
  const out = built(buildPublicationManifest(input([verified(prCollected(RUN_ID))])));
  assert.deepEqual(out.manifest.results, []);
  assert.deepEqual(out.manifest.untrustedOrigin, []);
  assert.deepEqual(out.omitted, [
    { runId: RUN_ID, runAttempt: 1, reason: 'untrusted-origin-excluded' },
  ]);
});

test('opted-in pull-request runs appear only in untrustedOrigin and never in totals', () => {
  const out = built(
    buildPublicationManifest(
      input([verified(prCollected(RUN_ID)), verified(collected(RUN_ID + 1))], {
        includeUntrustedOrigin: true,
      }),
    ),
  );
  assert.equal(out.manifest.untrustedOrigin.length, 1);
  assert.equal(out.manifest.untrustedOrigin[0]?.gate.state, 'UNTRUSTED_PROVENANCE');
  assert.equal(out.manifest.untrustedOrigin[0]?.metrics, null);
  assert.equal(out.manifest.results.length, 1);
  assert.deepEqual(verifiedTotals(out.manifest), { VERIFIED_PASS: 1 });
});

test('synthetic results live in a separate labelled section and are excluded from verified totals', () => {
  const demo = [retainedFrom(collected(2_000_002)), retainedFrom(collected(2_000_001))];
  const out = built(buildPublicationManifest(input([verified(collected())], { synthetic: demo })));
  assert.equal(out.manifest.synthetic?.label, SYNTHETIC_LABEL);
  assert.deepEqual(
    out.manifest.synthetic?.results.map((e) => [
      e.runId,
      e.gate.authenticity,
      e.metrics?.authenticity,
    ]),
    [
      [2_000_001, 'SYNTHETIC', 'SYNTHETIC'],
      [2_000_002, 'SYNTHETIC', 'SYNTHETIC'],
    ],
  );
  assert.equal(out.manifest.results.length, 1);
  assert.deepEqual(verifiedTotals(out.manifest), { VERIFIED_PASS: 1 });
});

test('synthetic-only manifests have no verified totals', () => {
  const out = built(
    buildPublicationManifest(input([], { synthetic: [retainedFrom(collected())] })),
  );
  assert.deepEqual(out.manifest.results, []);
  assert.deepEqual(verifiedTotals(out.manifest), {});
});

test('invalid or duplicate synthetic bundles are rejected', () => {
  const demo = retainedFrom(collected());
  assert.equal(
    rejected(buildPublicationManifest(input([], { synthetic: [demo, demo] }))),
    'duplicate-entry',
  );
  const forged = {
    authenticity: 'SYNTHETIC',
    content: demo.content,
  } as unknown as UnauthenticatedBundle;
  assert.equal(
    rejected(buildPublicationManifest(input([], { synthetic: [forged] }))),
    'synthetic-invalid',
  );
});

test('duplicate run/attempt records fail the build', () => {
  const kept = retainedFrom(collected());
  for (const entries of [
    [verified(collected()), verified(collected())],
    [verified(collected()), retained(kept)],
  ]) {
    const out = buildPublicationManifest(input(entries));
    assert.equal(rejected(out), 'duplicate-entry');
  }
});

/* ------------------------------------------------------------------ *
 * Build inputs and limits
 * ------------------------------------------------------------------ */

test('build inputs are validated explicitly', () => {
  const build = input([]).build;
  const cases: [Partial<ManifestInput>, string][] = [
    [{ build: { ...build, sourceCommit: 'HEAD' } }, 'invalid-source-commit'],
    [{ build: { ...build, builtAt: '2026-11-26T12:00:00+01:00' } }, 'invalid-built-at'],
    [{ build: { ...build, builtAt: '2026-02-30T12:00:00Z' } }, 'invalid-built-at'],
    [{ build: { ...build, builtAt: '2026-11-26' } }, 'invalid-built-at'],
    [{ build: { ...build, workingTree: 'dirty' as 'clean' } }, 'working-tree-not-clean'],
    [
      {
        build: {
          ...build,
          policy: { ...BASE_POLICY, digestContractConfirmed: true } as BaseTrustPolicy,
        },
      },
      'invalid-policy',
    ],
    [
      { build: { ...build, policy: { ...BASE_POLICY, repositoryFullName: PATH_CANARY } } },
      'invalid-policy',
    ],
    [{ includeUntrustedOrigin: 'yes' as unknown as boolean }, 'invalid-input'],
  ];
  for (const [override, code] of cases) {
    assert.equal(rejected(buildPublicationManifest(input([], override))), code, code);
  }
  assert.equal(
    rejected(buildPublicationManifest(null as unknown as ManifestInput)),
    'invalid-input',
  );
  assert.equal(
    rejected(
      buildPublicationManifest(input([{ kind: 'imported' } as unknown as ManifestEntryInput])),
    ),
    'invalid-entry',
  );
});

test('builtAt without milliseconds is accepted and published as supplied', () => {
  const out = built(
    buildPublicationManifest(
      input([], { build: { ...input([]).build, builtAt: '2026-11-26T12:00:00Z' } }),
    ),
  );
  assert.equal(out.manifest.build.builtAt, '2026-11-26T12:00:00Z');
});

test('more than 500 entries are rejected', () => {
  const demo = retainedFrom(collected());
  const many = Array.from({ length: MAX_MANIFEST_ENTRIES + 1 }, () => demo);
  assert.equal(
    rejected(buildPublicationManifest(input([], { synthetic: many }))),
    'too-many-entries',
  );
});

test('500 full entries stay within the 1 MiB limit', () => {
  const demo = Array.from({ length: MAX_MANIFEST_ENTRIES }, (_, i) =>
    retainedFrom(collected(3_000_000 + i)),
  );
  const out = built(buildPublicationManifest(input([], { synthetic: demo })));
  assert.ok(new TextEncoder().encode(out.text).byteLength <= 1024 * 1024);
});

/* ------------------------------------------------------------------ *
 * Deterministic serialization and leakage
 * ------------------------------------------------------------------ */

test('identical inputs in any order give byte-identical output and hash', () => {
  const entries = [
    verified(collected(RUN_ID + 2)),
    verified(collected(RUN_ID)),
    retained(retainedFrom(collected(RUN_ID + 1))),
  ];
  const a = built(buildPublicationManifest(input(entries)));
  const b = built(buildPublicationManifest(input([...entries].reverse())));
  assert.equal(a.text, b.text);
  assert.equal(a.sha256, b.sha256);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    a.manifest.results.map((e) => e.runId),
    [RUN_ID, RUN_ID + 1, RUN_ID + 2],
  );
  assert.equal(a.text.endsWith('}\n'), true);
  assert.equal(a.text.endsWith('\n\n'), false);
  assert.equal(a.text.includes('\r'), false);
  assert.deepEqual(Object.keys(a.manifest), [
    'manifestSchemaVersion',
    'kind',
    'build',
    'results',
    'untrustedOrigin',
    'synthetic',
  ]);
  assert.deepEqual(Object.keys(a.manifest.results[0] ?? {}), [
    'runId',
    'runAttempt',
    'headSha',
    'event',
    'gate',
    'summary',
    'artifact',
    'metrics',
  ]);
  assert.deepEqual(Object.keys(a.manifest.results[0]?.gate ?? {}), [
    'state',
    'reasons',
    'authenticity',
    'freshness',
    'verifiedAt',
  ]);
});

test('the outcome is frozen and the inputs are not mutated', () => {
  const c = collected();
  const before = JSON.stringify(c);
  const out = built(buildPublicationManifest(input([verified(c)])));
  assert.equal(JSON.stringify(c), before);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.manifest.results[0]?.gate.reasons), true);
});

test('no path, token, URL or canary from the evidence reaches the manifest', () => {
  const c = collected(
    RUN_ID,
    {},
    { summary: parseSummary(serialize(normalize(canaryReport(), context()))) },
  );
  const out = built(
    buildPublicationManifest(
      input([verified(c), verified(prCollected(RUN_ID + 1))], {
        includeUntrustedOrigin: true,
        synthetic: [retainedFrom(collected(RUN_ID + 2))],
      }),
    ),
  );
  for (const secret of [
    CANARY,
    TOKEN_CANARY,
    PATH_CANARY,
    URL_CANARY,
    'SIGNEDURLCANARY',
    'blob.core',
  ]) {
    assert.equal(out.text.includes(secret), false, secret);
  }
  assert.equal(outputScan(out.text), true);
});

test('the output scan refuses forbidden markers', () => {
  for (const marker of [TOKEN_CANARY, PATH_CANARY, URL_CANARY, 'Bearer x', '~/evidence', CANARY]) {
    assert.equal(outputScan(`{"x": "${marker}"}`), false, marker);
  }
  assert.equal(outputScan('{"workflowPath": ".github/workflows/tests.yml"}'), true);
});

test('the observed gate inputs never decide a verdict; metrics stay summary-derived only', () => {
  const inputs = Object.fromEntries(GATE_INPUT_NAMES.map((n) => [n, 'success']));
  const c = collected(RUN_ID, {}, { summary: summaryFor(RUN_ID, { gateInputs: inputs }) });
  const e = only(built(buildPublicationManifest(input([verified(c)]))).manifest);
  assert.equal(e.gate.state, 'VERIFIED_PASS');
  assert.deepEqual(Object.keys(e.metrics ?? {}), [
    'authenticity',
    'freshness',
    'summarySchemaVersion',
    'totals',
    'completeness',
  ]);
});

/* ------------------------------------------------------------------ *
 * Freshness: publication age and verification age
 * ------------------------------------------------------------------ */

const DAY = 86_400_000;
function plus(ms: number): string {
  return new Date(Date.parse(BUILT_AT) + ms).toISOString();
}

test('a publication is stale only when more than 30 days old', () => {
  assert.equal(STALE_PUBLICATION_DAYS, 30);
  assert.deepEqual(publicationAge(BUILT_AT, BUILT_AT), { state: 'current', ageDays: 0 });
  assert.deepEqual(publicationAge(BUILT_AT, plus(30 * DAY)), { state: 'current', ageDays: 30 });
  assert.deepEqual(publicationAge(BUILT_AT, plus(30 * DAY + 1)), { state: 'stale', ageDays: 30 });
  assert.deepEqual(publicationAge(BUILT_AT, plus(90 * DAY)), { state: 'stale', ageDays: 90 });
});

test('a viewer clock before the build, or an invalid time, is unknown rather than current', () => {
  assert.deepEqual(publicationAge(BUILT_AT, plus(-1)), { state: 'unknown' });
  assert.deepEqual(publicationAge('yesterday', BUILT_AT), { state: 'unknown' });
  assert.deepEqual(verificationAge(BUILT_AT, plus(-DAY)), { state: 'unknown' });
});

test('a missing verification time is not recorded and never inferred', () => {
  const out = built(buildPublicationManifest(input([retained(retainedFrom(collected()))])));
  const e = only(out.manifest);
  assert.equal(e.gate.verifiedAt, null);
  assert.deepEqual(verificationAge(e.gate.verifiedAt, plus(DAY)), { state: 'not-recorded' });
  // Publication age is still known: the two are tracked separately.
  assert.deepEqual(publicationAge(out.manifest.build.builtAt, plus(DAY)), {
    state: 'current',
    ageDays: 1,
  });
});

test('verification age is tracked separately from publication age', () => {
  const e = only(built(buildPublicationManifest(input([verified(collected())]))).manifest);
  assert.deepEqual(verificationAge(e.gate.verifiedAt, plus(40 * DAY)), {
    state: 'recorded',
    ageDays: 40,
  });
  assert.equal(publicationAge(BUILT_AT, plus(40 * DAY)).state, 'stale');
});

/* ------------------------------------------------------------------ *
 * Identity conflicts and conflict totals
 * ------------------------------------------------------------------ */

test('genuine identity-conflict evidence is never published, built or retained', () => {
  const runConflict = collected(RUN_ID, { run: { status: 'ok', value: run(RUN_ID + 7) } });
  const attemptConflict = collected(RUN_ID, {
    run: { status: 'ok', value: run(RUN_ID, { runAttempt: 2 }) },
  });
  for (const c of [runConflict, attemptConflict]) {
    const bundle = retainedFrom(c);
    assert.equal(bundle.content.verdict.state, 'CONFLICT');
    for (const entry of [verified(c), retained(bundle)]) {
      const out = buildPublicationManifest(input([entry]));
      assert.deepEqual(out, {
        status: 'rejected',
        code: 'identity-mismatch',
        runId: RUN_ID,
        runAttempt: 1,
      });
    }
    assert.equal(
      rejected(buildPublicationManifest(input([], { synthetic: [bundle] }))),
      'identity-mismatch',
    );
  }
});

test('conflict evidence never enters verified-success totals', () => {
  // An outcome conflict (Gate success, job failure) is published as CONFLICT.
  const c = collected(RUN_ID + 1, {
    jobs: {
      status: 'ok',
      value: jobs().map((j) => (j.name === 'test' ? { ...j, conclusion: 'failure' } : j)),
    },
  });
  const out = built(buildPublicationManifest(input([verified(c), verified(collected())])));
  assert.deepEqual(
    out.manifest.results.map((e) => e.gate.state),
    ['VERIFIED_PASS', 'CONFLICT'],
  );
  assert.deepEqual(verifiedTotals(out.manifest), { VERIFIED_PASS: 1, CONFLICT: 1 });
  assert.equal(out.manifest.results[1]?.metrics, null);
});

/* ------------------------------------------------------------------ *
 * Synthetic freshness: NOT_APPLICABLE, never historical real evidence
 * ------------------------------------------------------------------ */

test('synthetic entries carry NOT_APPLICABLE freshness and a null verification time', () => {
  const out = built(
    buildPublicationManifest(input([], { synthetic: [retainedFrom(collected(2_000_001))] })),
  );
  const e = out.manifest.synthetic?.results[0];
  assert.equal(e?.gate.authenticity, 'SYNTHETIC');
  assert.equal(e?.gate.freshness, 'NOT_APPLICABLE');
  assert.equal(e?.gate.verifiedAt, null);
  assert.equal(e?.metrics?.authenticity, 'SYNTHETIC');
  assert.equal(e?.metrics?.freshness, 'NOT_APPLICABLE');
  assert.deepEqual(verificationAge(e?.gate.verifiedAt ?? null, BUILT_AT), {
    state: 'not-recorded',
  });
});

test('synthetic data is never presented as historical real evidence', () => {
  const real = retained(retainedFrom(collected(RUN_ID)));
  const out = built(
    buildPublicationManifest(
      input([verified(collected(RUN_ID + 1)), real], {
        synthetic: [retainedFrom(collected(RUN_ID)), retainedFrom(collected(RUN_ID + 1))],
      }),
    ),
  );
  // Same run IDs in both sections: the sections stay separate and distinct.
  assert.deepEqual(
    out.manifest.results.map((e) => [e.runId, e.gate.authenticity, e.gate.freshness]),
    [
      [RUN_ID, 'RETAINED_UNAUTHENTICATED', 'HISTORICAL'],
      [RUN_ID + 1, 'BUILD_VERIFIED', 'CURRENT'],
    ],
  );
  const synth = out.manifest.synthetic?.results ?? [];
  assert.equal(synth.length, 2);
  for (const e of synth) {
    assert.equal(e.gate.authenticity, 'SYNTHETIC');
    assert.equal(e.gate.freshness, 'NOT_APPLICABLE');
    assert.equal(e.artifact.integrity, 'not-checked');
    assert.equal(e.artifact.digest, null);
  }
  const synthText = JSON.stringify(out.manifest.synthetic);
  for (const real of ['HISTORICAL', 'CURRENT', 'RETAINED_UNAUTHENTICATED', 'BUILD_VERIFIED']) {
    assert.equal(synthText.includes(real), false, real);
  }
  for (const e of out.manifest.results) {
    assert.notEqual(e.gate.freshness, 'NOT_APPLICABLE');
    assert.notEqual(e.gate.authenticity, 'SYNTHETIC');
  }
  assert.deepEqual(verifiedTotals(out.manifest), { VERIFIED_PASS: 1 });
});

test('synthetic serialization stays deterministic', () => {
  const demo = [retainedFrom(collected(2_000_002)), retainedFrom(collected(2_000_001))];
  const a = built(buildPublicationManifest(input([], { synthetic: demo })));
  const b = built(buildPublicationManifest(input([], { synthetic: [...demo].reverse() })));
  assert.equal(a.text, b.text);
  assert.equal(a.sha256, b.sha256);
});
