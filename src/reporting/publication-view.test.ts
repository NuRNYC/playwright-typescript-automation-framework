/**
 * Unit tests for the browser-safe publication reader and view model
 * (ADR-0011 P3-2).
 *
 * Same conventions as the other unit tests (ADR-0002). Every manifest is
 * synthetic: produced by the committed P1 builder from synthetic transport
 * evidence, or written here from synthetic values. No real publication
 * generation, bundle, token or GitHub response is read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { parseSummary, type ParsedSummary } from './dashboard-model.ts';
import { GATE_INPUT_NAMES, normalize, serialize } from './quality-summary.ts';
import { CANARY, SYNTHETIC_SHA, context, twelveEighteenNineteen } from './fixtures.ts';
import {
  buildBundle,
  reconcileCollected,
  serializeBundle,
  type BaseTrustPolicy,
  type Collected,
} from './verdict-cli.ts';
import {
  VERDICT_STATES,
  type ReasonCode,
  type SummaryState,
  type VerdictState,
  type ArchiveEvidence,
  type ArtifactEvidence,
  type JobEvidence,
  type RunAttemptEvidence,
  type StepEvidence,
  type VerdictEvidence,
} from './verdict.ts';
import {
  EVENT_CLASSES,
  REASON_CODES,
  STATS_CROSS_CHECKS,
  TRUSTED_VERDICTS,
  parseVerdictBundle,
  type PublicPolicy,
  type UnauthenticatedBundle,
} from './verdict-bundle.ts';
import {
  AUTHENTICITY_STATES,
  FRESHNESS_STATES,
  INTEGRITY_STATES,
  MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_ENTRIES,
  STALE_PUBLICATION_DAYS,
  SYNTHETIC_LABEL,
  buildPublicationManifest,
  publicationAge,
  serializeManifest,
  type ManifestEntryInput,
  type ManifestInput,
  type ManifestOutcome,
} from './publication-manifest.ts';
import {
  EVENT_VALUES,
  FRESHNESS_VALUES,
  INTEGRITY_VALUES,
  MAX_PUBLICATION_BYTES,
  MAX_PUBLICATION_ENTRIES,
  PUBLICATION_KIND,
  PUBLICATION_REASON_CODES,
  PUBLICATION_SCHEMA_VERSION,
  PUBLISHED_AUTHENTICITY,
  STALE_AFTER_DAYS,
  STATS_CROSS_CHECK_VALUES,
  SYNTHETIC_SECTION_LABEL,
  TRUSTED_COMPLETED_VERDICTS,
  VERDICT_TEXT,
  buildPublicationViewModel,
  canonicalPublicationText,
  parsePublication,
  publicationAgeOf,
  reasonText,
  summaryReasonsFit,
  verdictReasonsFit,
  verificationAgeOf,
  type ParsedPublication,
  type PublicationViewModel,
} from './publication-view.ts';

/* ------------------------------------------------------------------ *
 * Synthetic evidence (shaped like the operator transport output)
 * ------------------------------------------------------------------ */

const REPO_ID = 900_000_001;
const REPO = 'example-owner/example-repo';
const WORKFLOW_ID = 800_000_001;
const RUN_ID = 1_000_001;
const HEAD = SYNTHETIC_SHA;
const ARTIFACT_ID = 15_000_001;
const API_DIGEST = `sha256:${'ab'.repeat(32)}`;
const SOURCE_COMMIT = 'c0ffee0000000000000000000000000000c0ffee';
const BUILT_AT = '2026-11-26T12:00:00.000Z';
const NOW = '2026-11-27T12:00:00.000Z';

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

function jobs(gate: 'success' | 'failure' = 'success'): JobEvidence[] {
  return [
    {
      id: 70_000_004,
      name: 'test',
      runAttempt: 1,
      headSha: HEAD,
      status: 'completed',
      conclusion: gate,
      // A canary in an unused step name must never reach the manifest.
      steps: [step(CANARY), step('Gate', gate)],
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
      artifacts: { status: 'ok', value: [artifact(runId)] },
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

function bundleFrom(c: Collected): UnauthenticatedBundle {
  const text = serializeBundle(buildBundle(reconcileCollected(c, BASE_POLICY), c, BASE_POLICY));
  const parsed = parseVerdictBundle(text, POLICY);
  if (parsed.status !== 'valid') throw new Error(`synthetic bundle rejected: ${parsed.code}`);
  return parsed.bundle;
}

function verified(c: Collected): ManifestEntryInput {
  return {
    kind: 'build-verified',
    runId: c.evidence.request.runId,
    runAttempt: c.evidence.request.runAttempt,
    collected: c,
    retained: null,
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

function p1(entries: readonly ManifestEntryInput[], overrides: Partial<ManifestInput> = {}) {
  const out: ManifestOutcome = buildPublicationManifest({
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
  });
  if (out.status !== 'built') throw new Error(`P1 rejected the synthetic input: ${out.code}`);
  return out;
}

/** A P1 manifest covering every section and the main summary states. */
function fullText(): string {
  const failed = collected(
    1_000_002,
    {
      run: { status: 'ok', value: run(1_000_002, { conclusion: 'failure' }) },
      jobs: { status: 'ok', value: jobs('failure') },
    },
    {
      summary: summaryFor(1_000_002, {
        gateInputs: Object.fromEntries(
          GATE_INPUT_NAMES.map((name) => [name, name === 'SHARDS' ? 'failure' : 'success']),
        ),
      }),
    },
  );
  const expired = collected(
    1_000_003,
    {
      artifacts: { status: 'ok', value: [artifact(1_000_003, { expired: true })] },
      archive: { status: 'failed', reason: 'expired' },
    },
    { summary: null, digest: 'not-checked' },
  );
  return p1(
    [
      verified(collected()),
      verified(failed),
      verified(expired),
      retained(bundleFrom(collected(1_000_004))),
      verified(prCollected(1_000_005)),
    ],
    { includeUntrustedOrigin: true, synthetic: [bundleFrom(collected(9_000_001))] },
  ).text;
}

function valid(parsed: ParsedPublication) {
  assert.equal(parsed.state, 'valid', JSON.stringify(parsed));
  if (parsed.state !== 'valid') throw new Error('unreachable');
  return parsed.manifest;
}

function rejection(text: string): string {
  const parsed = parsePublication(text);
  assert.equal(parsed.state, 'rejected', 'expected a rejection');
  if (parsed.state !== 'rejected') throw new Error('unreachable');
  assert.deepEqual(Object.keys(parsed).sort(), ['code', 'state']);
  return parsed.code;
}

type Json = Record<string, unknown>;

/** Re-serializes canonically after a mutation, so the targeted rule (not canonicity) is what fails. */
function mutate(text: string, change: (m: Json) => void): string {
  const m = JSON.parse(text) as Json;
  change(m);
  return `${JSON.stringify(m, null, 2)}\n`;
}

function at(m: Json, ...path: (string | number)[]): Json {
  let cur: unknown = m;
  for (const p of path) cur = (cur as Record<string | number, unknown>)[p];
  return cur as Json;
}

/** One permitted reason set per verdict state (the reconciler's return sites). */
const REASONS_FOR: Readonly<Record<VerdictState, readonly ReasonCode[]>> = {
  VERIFIED_PASS: ['gate-success'],
  VERIFIED_FAIL: ['gate-failure'],
  EXECUTION_FAILED: ['job-failed-before-gate'],
  CANCELLED: ['run-cancelled'],
  PENDING: ['run-not-completed'],
  UNTRUSTED_PROVENANCE: ['provenance-event'],
  CONFLICT: ['outcome-job-not-completed'],
  UNKNOWN: ['gate-not-decisive'],
};

/** A hand-written real entry in canonical key order. */
function entryObj(
  overrides: Partial<
    Record<'runId' | 'gate' | 'summary' | 'artifact' | 'metrics' | 'event', unknown>
  > = {},
): Json {
  return {
    runId: RUN_ID,
    runAttempt: 1,
    headSha: HEAD,
    event: 'push',
    gate: {
      state: 'UNKNOWN',
      reasons: ['gate-not-decisive'],
      authenticity: 'BUILD_VERIFIED',
      freshness: 'CURRENT',
      verifiedAt: BUILT_AT,
    },
    summary: { state: 'SUMMARY_UNAVAILABLE', reasons: ['artifact-absent'], label: null },
    artifact: { id: null, digest: null, integrity: 'not-checked' },
    metrics: null,
    ...overrides,
  };
}

function manifestText(
  results: Json[],
  untrustedOrigin: Json[] = [],
  synthetic: Json | null = null,
): string {
  return `${JSON.stringify(
    {
      manifestSchemaVersion: '1.0.0',
      kind: 'quality-verdict-publication',
      build: { sourceCommit: SOURCE_COMMIT, builtAt: BUILT_AT, policy: POLICY },
      results,
      untrustedOrigin,
      synthetic,
    },
    null,
    2,
  )}\n`;
}

function vm(
  text: string,
  origin: 'build-embedded' | 'imported' = 'build-embedded',
  now: unknown = NOW,
) {
  const model: PublicationViewModel = buildPublicationViewModel(
    parsePublication(text),
    origin,
    now,
  );
  assert.equal(model.state, 'valid', JSON.stringify(model));
  if (model.state !== 'valid') throw new Error('unreachable');
  return model;
}

/* ------------------------------------------------------------------ *
 * Compatibility with the committed P1 contract
 * ------------------------------------------------------------------ */

test('every P1-built manifest is accepted and its canonical text is byte-identical', () => {
  const texts = [
    p1([verified(collected())]).text,
    p1([verified(collected(RUN_ID, {}, { digest: 'not-checked' }))]).text,
    p1([verified(collected(RUN_ID, { archive: { ...MATCHED, digestCheck: 'mismatch' } }))]).text,
    p1([retained(bundleFrom(collected()))]).text,
    fullText(),
  ];
  for (const text of texts) {
    const manifest = valid(parsePublication(text));
    assert.equal(canonicalPublicationText(manifest), text);
    assert.equal(serializeManifest(manifest), text);
  }
});

test('the full P1 manifest has one entry in each section and state', () => {
  const m = valid(parsePublication(fullText()));
  assert.deepEqual(
    m.results.map((e) => [e.runId, e.gate.state, e.gate.authenticity, e.summary.state]),
    [
      [1_000_001, 'VERIFIED_PASS', 'BUILD_VERIFIED', 'SUMMARY_VERIFIED_ORIGIN'],
      [1_000_002, 'VERIFIED_FAIL', 'BUILD_VERIFIED', 'SUMMARY_VERIFIED_ORIGIN'],
      [1_000_003, 'VERIFIED_PASS', 'BUILD_VERIFIED', 'SUMMARY_UNAVAILABLE'],
      [1_000_004, 'VERIFIED_PASS', 'RETAINED_UNAUTHENTICATED', 'SUMMARY_VERIFIED_ORIGIN'],
    ],
  );
  assert.deepEqual(
    m.untrustedOrigin.map((e) => [e.runId, e.gate.state]),
    [[1_000_005, 'UNTRUSTED_PROVENANCE']],
  );
  assert.equal(m.synthetic?.results[0]?.gate.authenticity, 'SYNTHETIC');
});

test('restated vocabularies and limits equal the committed P1 and ADR-0010 sources', () => {
  assert.deepEqual([...PUBLICATION_REASON_CODES].sort(), [...REASON_CODES].sort());
  assert.equal(new Set(PUBLICATION_REASON_CODES).size, PUBLICATION_REASON_CODES.length);
  assert.deepEqual(
    [...PUBLISHED_AUTHENTICITY].sort(),
    AUTHENTICITY_STATES.filter((a) => a !== 'IMPORTED_UNAUTHENTICATED' && a !== 'REJECTED').sort(),
  );
  assert.deepEqual([...FRESHNESS_VALUES], [...FRESHNESS_STATES]);
  assert.deepEqual([...INTEGRITY_VALUES], [...INTEGRITY_STATES]);
  assert.deepEqual([...EVENT_VALUES], [...EVENT_CLASSES]);
  assert.deepEqual([...STATS_CROSS_CHECK_VALUES], [...STATS_CROSS_CHECKS]);
  assert.deepEqual([...TRUSTED_COMPLETED_VERDICTS], [...TRUSTED_VERDICTS]);
  assert.equal(PUBLICATION_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION);
  assert.equal(PUBLICATION_KIND, MANIFEST_KIND);
  assert.equal(MAX_PUBLICATION_BYTES, MAX_MANIFEST_BYTES);
  assert.equal(MAX_PUBLICATION_ENTRIES, MAX_MANIFEST_ENTRIES);
  assert.equal(STALE_AFTER_DAYS, STALE_PUBLICATION_DAYS);
  assert.equal(SYNTHETIC_SECTION_LABEL, SYNTHETIC_LABEL);
  for (const code of REASON_CODES) assert.notEqual(reasonText(code), 'Unrecognized reason', code);
});

/* ------------------------------------------------------------------ *
 * Strict reader: rejections
 * ------------------------------------------------------------------ */

test('non-string, oversized and non-JSON input is rejected', () => {
  assert.deepEqual(parsePublication(42), { state: 'rejected', code: 'input-type' });
  assert.deepEqual(parsePublication(null), { state: 'rejected', code: 'input-type' });
  assert.equal(rejection(' '.repeat(MAX_PUBLICATION_BYTES + 1)), 'too-large');
  assert.equal(rejection('{"a":'), 'invalid-json');
  assert.equal(rejection('[]'), 'invalid-structure');
  assert.equal(rejection('{"a":[[[[[[[[[1]]]]]]]]]}'), 'too-deep');
});

test('any deviation from the canonical serialization is rejected', () => {
  const text = p1([verified(collected())]).text;
  const cases: Record<string, string> = {
    'duplicate key': text.replace(
      '"kind": "quality-verdict-publication",',
      '"kind": "quality-verdict-publication",\n  "kind": "quality-verdict-publication",',
    ),
    'escaped key spelling': text.replace('"runId"', '"\\u0072unId"'),
    'byte-order mark': `\uFEFF${text}`,
    'CRLF line endings': text.replace(/\n/g, '\r\n'),
    'no trailing newline': text.slice(0, -1),
    'compact whitespace': `${JSON.stringify(JSON.parse(text))}\n`,
    'reordered keys': mutate(text, (m) => {
      const build = m.build;
      delete m.build;
      m.build = build;
    }),
    'extra whitespace': text.replace('"results": [', '"results":  ['),
    'unsorted outcome keys': mutate(text, (m) => {
      at(m, 'results', 0, 'metrics', 'totals').byInstanceOutcome = { skipped: 1, failed: 17 };
    }),
    'reordered nested keys': mutate(text, (m) => {
      const metrics = at(m, 'results', 0, 'metrics');
      metrics.completeness = Object.fromEntries(
        Object.entries(metrics.completeness as Json).reverse(),
      );
    }),
  };
  for (const [name, bad] of Object.entries(cases)) {
    assert.equal(parsePublication(bad).state, 'rejected', name);
    const code = rejection(bad);
    assert.ok(
      ['not-canonical', 'invalid-json', 'unknown-field'].includes(code),
      `${name}: ${code}`,
    );
  }
  assert.equal(rejection(cases['duplicate key'] ?? ''), 'not-canonical');
  assert.equal(rejection(cases['escaped key spelling'] ?? ''), 'not-canonical');
});

test('unsupported schemas, wrong kind, unknown and missing fields are rejected', () => {
  const text = p1([verified(collected())]).text;
  assert.equal(
    rejection(mutate(text, (m) => (m.manifestSchemaVersion = '2.0.0'))),
    'unsupported-version',
  );
  assert.equal(
    rejection(mutate(text, (m) => (m.manifestSchemaVersion = '1.0.1'))),
    'unsupported-version',
  );
  assert.equal(rejection(mutate(text, (m) => (m.kind = 'quality-verdict-bundle'))), 'wrong-kind');
  assert.equal(rejection(mutate(text, (m) => (m.extra = true))), 'unknown-field');
  assert.equal(
    rejection(
      mutate(text, (m) => (at(m, 'results', 0, 'gate').authenticityOverride = 'BUILD_VERIFIED')),
    ),
    'unknown-field',
  );
  assert.equal(rejection(mutate(text, (m) => (at(m, 'build').verified = true))), 'unknown-field');
  assert.equal(rejection(mutate(text, (m) => delete at(m, 'results', 0).metrics)), 'missing-field');
  assert.equal(rejection(mutate(text, (m) => delete m.synthetic)), 'missing-field');
  assert.equal(
    rejection(
      mutate(
        text,
        (m) => (at(m, 'results', 0, 'metrics', 'totals', 'byInstanceOutcome').bogus = 1),
      ),
    ),
    'unknown-field',
  );
  assert.equal(
    rejection(mutate(text, (m) => (at(m, 'results', 0, 'metrics').summarySchemaVersion = '2.0.0'))),
    'invalid-value',
  );
});

test('policy, identity and format values are validated', () => {
  const text = p1([verified(collected())]).text;
  const cases: [string, (m: Json) => void][] = [
    ['trusted event', (m) => (at(m, 'build', 'policy').trustedEvent = 'pull_request')],
    ['repository slug', (m) => (at(m, 'build', 'policy').repositoryFullName = 'https://example')],
    ['workflow path', (m) => (at(m, 'build', 'policy').workflowPath = '../tests.yml')],
    ['source commit', (m) => (at(m, 'build').sourceCommit = 'abc')],
    ['builtAt', (m) => (at(m, 'build').builtAt = '2026-11-26 12:00:00')],
    ['builtAt calendar', (m) => (at(m, 'build').builtAt = '2026-02-30T12:00:00Z')],
    ['run id', (m) => (at(m, 'results', 0).runId = 0)],
    ['run id type', (m) => (at(m, 'results', 0).runId = '1000001')],
    ['run attempt', (m) => (at(m, 'results', 0).runAttempt = 1001)],
    ['head sha', (m) => (at(m, 'results', 0).headSha = 'ZZ')],
    ['event', (m) => (at(m, 'results', 0).event = 'workflow_dispatch')],
    ['verdict', (m) => (at(m, 'results', 0, 'gate').state = 'PASS')],
    ['summary state', (m) => (at(m, 'results', 0, 'summary').state = 'SUMMARY_OK')],
    [
      'authenticity',
      (m) => (at(m, 'results', 0, 'gate').authenticity = 'IMPORTED_UNAUTHENTICATED'),
    ],
    ['digest', (m) => (at(m, 'results', 0, 'artifact').digest = 'sha256:xyz')],
    ['negative count', (m) => (at(m, 'results', 0, 'metrics', 'totals').retries = -1)],
    ['fractional count', (m) => (at(m, 'results', 0, 'metrics', 'totals').retries = 0.5)],
    [
      'zero outcome key',
      (m) => (at(m, 'results', 0, 'metrics', 'totals', 'byInstanceOutcome').failed = 0),
    ],
  ];
  for (const [name, change] of cases) {
    assert.ok(
      ['invalid-value', 'authenticity-mismatch'].includes(rejection(mutate(text, change))),
      name,
    );
  }
});

test('reason codes must be known, unique and sorted', () => {
  const text = p1([verified(collected())]).text;
  assert.equal(
    rejection(mutate(text, (m) => (at(m, 'results', 0, 'gate').reasons = ['made-up']))),
    'invalid-reason',
  );
  assert.equal(
    rejection(mutate(text, (m) => (at(m, 'results', 0, 'gate').reasons = [CANARY]))),
    'invalid-reason',
  );
  assert.equal(
    rejection(
      mutate(text, (m) => (at(m, 'results', 0, 'gate').reasons = ['gate-success', 'gate-success'])),
    ),
    'reasons-not-canonical',
  );
  assert.equal(
    rejection(
      mutate(
        text,
        (m) => (at(m, 'results', 0, 'gate').reasons = ['run-cancelled', 'gate-success']),
      ),
    ),
    'reasons-not-canonical',
  );
});

test('duplicate, unsorted and misplaced run identities are rejected', () => {
  const a = entryObj();
  const b = entryObj({ runId: RUN_ID + 1 });
  assert.equal(rejection(manifestText([a, a])), 'duplicate-entry');
  assert.equal(rejection(manifestText([b, a])), 'entries-not-sorted');
  const pr = entryObj({
    event: 'pull_request',
    gate: {
      ...(entryObj().gate as Json),
      state: 'UNTRUSTED_PROVENANCE',
      reasons: ['provenance-event'],
    },
  });
  assert.equal(rejection(manifestText([pr])), 'untrusted-in-results');
  assert.equal(rejection(manifestText([a], [a])), 'trusted-in-untrusted-origin');
  assert.equal(rejection(manifestText([a], [pr])), 'duplicate-entry');
  const many = Array.from({ length: MAX_PUBLICATION_ENTRIES + 1 }, (_, i) =>
    entryObj({ runId: RUN_ID + i }),
  );
  assert.equal(rejection(manifestText(many)), 'too-many-entries');
});

test('identity-conflict evidence is never publishable', () => {
  const conflict = entryObj({
    gate: {
      ...(entryObj().gate as Json),
      state: 'CONFLICT',
      reasons: ['identity-run-id-mismatch'],
    },
  });
  assert.equal(rejection(manifestText([conflict])), 'identity-conflict');
});

test('authenticity and freshness combinations follow the P1 projection', () => {
  const gate = entryObj().gate as Json;
  const cases: [string, Json, string][] = [
    [
      'build-verified historical',
      entryObj({ gate: { ...gate, freshness: 'HISTORICAL' } }),
      'freshness-mismatch',
    ],
    [
      'build-verified at another time',
      entryObj({ gate: { ...gate, verifiedAt: NOW } }),
      'freshness-mismatch',
    ],
    [
      'build-verified without time',
      entryObj({ gate: { ...gate, verifiedAt: null } }),
      'freshness-mismatch',
    ],
    [
      'build-verified not retrieved',
      entryObj({ gate: { ...gate, reasons: ['retrieval-jobs-not-found'] } }),
      'authenticity-mismatch',
    ],
    [
      'retained current',
      entryObj({ gate: { ...gate, authenticity: 'RETAINED_UNAUTHENTICATED' } }),
      'freshness-mismatch',
    ],
    [
      'retained with time',
      entryObj({
        gate: { ...gate, authenticity: 'RETAINED_UNAUTHENTICATED', freshness: 'HISTORICAL' },
      }),
      'freshness-mismatch',
    ],
    [
      'synthetic in results',
      entryObj({
        gate: { ...gate, authenticity: 'SYNTHETIC', freshness: 'NOT_APPLICABLE', verifiedAt: null },
      }),
      'authenticity-mismatch',
    ],
    [
      'not-applicable real',
      entryObj({ gate: { ...gate, freshness: 'NOT_APPLICABLE' } }),
      'freshness-mismatch',
    ],
  ];
  for (const [name, e, code] of cases) assert.equal(rejection(manifestText([e])), code, name);
});

test('summary labels and artifact integrity must agree with the states', () => {
  const text = p1([verified(collected())]).text;
  assert.equal(
    rejection(mutate(text, (m) => (at(m, 'results', 0, 'summary').label = null))),
    'label-mismatch',
  );
  assert.equal(
    rejection(mutate(text, (m) => (at(m, 'results', 0, 'summary').label = 'unverified-origin'))),
    'label-mismatch',
  );
  assert.equal(
    rejection(
      manifestText([
        entryObj({
          summary: {
            state: 'SUMMARY_UNAVAILABLE',
            reasons: ['artifact-absent'],
            label: 'verified-origin',
          },
        }),
      ]),
    ),
    'label-mismatch',
  );
  // Digest and artifact binding.
  assert.equal(
    rejection(mutate(text, (m) => (at(m, 'results', 0, 'artifact').digest = null))),
    'integrity-mismatch',
  );
  assert.equal(
    rejection(mutate(text, (m) => (at(m, 'results', 0, 'artifact').id = null))),
    'label-mismatch',
  );
  assert.equal(
    rejection(mutate(text, (m) => (at(m, 'results', 0, 'artifact').integrity = 'not-checked'))),
    'integrity-mismatch',
  );
  assert.equal(
    rejection(
      mutate(text, (m) => (at(m, 'results', 0, 'artifact').integrity = 'retained-not-reverified')),
    ),
    'integrity-mismatch',
  );
  assert.equal(
    rejection(
      manifestText([
        entryObj({ artifact: { id: null, digest: API_DIGEST, integrity: 'not-checked' } }),
      ]),
    ),
    'integrity-mismatch',
  );
  const retainedText = p1([retained(bundleFrom(collected()))]).text;
  assert.equal(
    rejection(mutate(retainedText, (m) => (at(m, 'results', 0, 'artifact').digest = API_DIGEST))),
    'integrity-mismatch',
  );
  assert.equal(
    rejection(
      mutate(
        retainedText,
        (m) => (at(m, 'results', 0, 'artifact').integrity = 'verified-in-build'),
      ),
    ),
    'integrity-mismatch',
  );
  assert.equal(
    rejection(
      mutate(retainedText, (m) => (at(m, 'results', 0, 'artifact').integrity = 'mismatch')),
    ),
    'integrity-mismatch',
  );
});

test('metrics are permitted only for build-verified, verified-origin, digest-matched results', () => {
  const text = p1([verified(collected())]).text;
  const metrics = at(JSON.parse(text) as Json, 'results', 0).metrics;
  // SUMMARY_INFORMATIVE never carries metrics.
  const informative = p1([verified(collected(RUN_ID, {}, { digest: 'not-checked' }))]).text;
  assert.equal(valid(parsePublication(informative)).results[0]?.metrics, null);
  assert.equal(
    rejection(mutate(informative, (m) => (at(m, 'results', 0).metrics = metrics))),
    'metrics-not-permitted',
  );
  // Retained (unauthenticated) evidence never carries metrics.
  const retainedText = p1([retained(bundleFrom(collected()))]).text;
  assert.equal(
    rejection(mutate(retainedText, (m) => (at(m, 'results', 0).metrics = metrics))),
    'metrics-not-permitted',
  );
  // Metrics claiming another authenticity or freshness.
  assert.equal(
    rejection(mutate(text, (m) => (at(m, 'results', 0, 'metrics').authenticity = 'SYNTHETIC'))),
    'metrics-not-permitted',
  );
  assert.equal(
    rejection(mutate(text, (m) => (at(m, 'results', 0, 'metrics').freshness = 'HISTORICAL'))),
    'metrics-not-permitted',
  );
  // Untrusted-origin results never carry metrics.
  const pr = valid(parsePublication(fullText())).untrustedOrigin[0];
  assert.equal(pr?.metrics, null);
});

test('metrics counts must satisfy the M8A counting invariants', () => {
  const text = p1([verified(collected())]).text;
  const totals = (m: Json) => at(m, 'results', 0, 'metrics', 'totals');
  const cases: [string, (m: Json) => void][] = [
    ['instance outcomes sum', (m) => (totals(m).instances = (totals(m).instances as number) + 1)],
    [
      'execution outcomes sum',
      (m) => (totals(m).executions = (totals(m).executions as number) + 1),
    ],
    [
      'instances below definitions',
      (m) => (totals(m).definitions = (totals(m).instances as number) + 1),
    ],
    ['retries above attempts', (m) => (totals(m).retries = (totals(m).attempts as number) + 1)],
    ['zero-attempt executions', (m) => (totals(m).zeroAttemptExecutions = 1)],
  ];
  for (const [name, change] of cases)
    assert.equal(rejection(mutate(text, change)), 'metrics-inconsistent', name);
});

test('the synthetic section stays synthetic and NOT_APPLICABLE', () => {
  const text = fullText();
  const syn = (m: Json) => at(m, 'synthetic', 'results', 0);
  assert.equal(
    rejection(mutate(text, (m) => (at(m, 'synthetic').label = 'REAL DATA'))),
    'synthetic-mismatch',
  );
  assert.equal(
    rejection(mutate(text, (m) => (at(syn(m), 'gate').authenticity = 'BUILD_VERIFIED'))),
    'synthetic-mismatch',
  );
  assert.equal(
    rejection(mutate(text, (m) => (at(syn(m), 'gate').freshness = 'CURRENT'))),
    'synthetic-mismatch',
  );
  assert.equal(
    rejection(mutate(text, (m) => (at(syn(m), 'artifact').integrity = 'verified-in-build'))),
    'synthetic-mismatch',
  );
  assert.equal(
    rejection(mutate(text, (m) => (at(syn(m), 'metrics').authenticity = 'BUILD_VERIFIED'))),
    'synthetic-mismatch',
  );
  // A synthetic entry moved into the real results is refused.
  assert.equal(
    rejection(
      mutate(text, (m) => {
        (m.results as Json[]).push(syn(m));
        (m.results as Json[]).sort((x, y) => (x.runId as number) - (y.runId as number));
      }),
    ),
    'authenticity-mismatch',
  );
});

/* ------------------------------------------------------------------ *
 * View model
 * ------------------------------------------------------------------ */

test('a build-embedded verified pass is labelled as the publisher build statement', () => {
  const model = vm(p1([verified(collected())]).text);
  assert.equal(model.assertion, 'publisher-build-statement');
  const r = model.results[0];
  assert.equal(r?.gate.isVerifiedPass, true);
  assert.equal(r?.gate.styling, 'verified');
  assert.equal(r?.gate.tone, 'pass');
  assert.equal(r?.gate.label, 'Verified pass');
  assert.equal(r?.gate.authenticityText, "Verified by the publisher's build (publisher statement)");
  assert.equal(r?.artifact.integrity, 'verified-in-build');
  assert.equal(r?.metrics.status, 'available');
  if (r?.metrics.status === 'available') {
    assert.equal(r.metrics.instances, 18);
    assert.equal(r.metrics.byInstanceOutcome.length, 10);
    // Every outcome is listed; outcomes absent from the manifest map are zero.
    assert.equal(
      r.metrics.byInstanceOutcome.reduce((a, o) => a + o.count, 0),
      r.metrics.instances,
    );
    assert.ok(r.metrics.byInstanceOutcome.some((o) => o.count === 0));
  }
  assert.deepEqual(model.verifiedTotals.verifiedPasses, 1);
  assert.deepEqual(model.verifiedTotals.buildVerifiedResults, 1);
});

test('every verdict state keeps its own label and only VERIFIED_PASS can be a pass', () => {
  for (const state of VERDICT_STATES) {
    const event = state === 'UNTRUSTED_PROVENANCE' ? 'pull_request' : 'push';
    const e = entryObj({
      event,
      gate: { ...(entryObj().gate as Json), state, reasons: REASONS_FOR[state] },
    });
    const text = state === 'UNTRUSTED_PROVENANCE' ? manifestText([], [e]) : manifestText([e]);
    const model = vm(text);
    const view = model.results[0] ?? model.untrustedOrigin[0];
    assert.equal(view?.gate.label, VERDICT_TEXT[state].label, state);
    assert.equal(view?.gate.isVerifiedPass, state === 'VERIFIED_PASS', state);
    if (state !== 'VERIFIED_PASS') assert.notEqual(view?.gate.tone, 'pass', state);
    assert.equal(model.verifiedTotals.verifiedPasses, state === 'VERIFIED_PASS' ? 1 : 0, state);
  }
  assert.equal(
    new Set(VERDICT_STATES.map((s) => VERDICT_TEXT[s].label)).size,
    VERDICT_STATES.length,
  );
});

test('UNKNOWN, PENDING and CONFLICT are never presented as a pass', () => {
  for (const state of ['UNKNOWN', 'PENDING', 'CONFLICT'] as const) {
    const model = vm(
      manifestText([
        entryObj({ gate: { ...(entryObj().gate as Json), state, reasons: REASONS_FOR[state] } }),
      ]),
    );
    const g = model.results[0]?.gate;
    assert.equal(g?.isVerifiedPass, false);
    assert.equal(g?.tone, 'warn');
    assert.equal(model.verifiedTotals.verifiedPasses, 0);
  }
});

test('SUMMARY_UNAVAILABLE and other null metrics are unavailable, never zero', () => {
  const model = vm(fullText());
  const expired = model.results.find((r) => r.runId === 1_000_003);
  assert.equal(expired?.metrics.status, 'unavailable');
  if (expired?.metrics.status === 'unavailable') {
    assert.equal(expired.metrics.summaryState, 'SUMMARY_UNAVAILABLE');
    assert.equal(expired.metrics.text, 'Metrics unavailable');
    assert.deepEqual(
      expired.metrics.reasons.map((r) => r.code),
      ['artifact-expired'],
    );
    assert.equal('instances' in expired.metrics, false);
  }
});

test('retained, untrusted-origin and synthetic entries never enter verified totals', () => {
  const model = vm(fullText());
  assert.equal(model.verifiedTotals.buildVerifiedResults, 3);
  assert.equal(model.verifiedTotals.verifiedPasses, 2);
  assert.equal(model.verifiedTotals.byVerdict.find((v) => v.state === 'VERIFIED_FAIL')?.count, 1);
  const retainedView = model.results.find((r) => r.runId === 1_000_004);
  assert.equal(retainedView?.gate.styling, 'retained-claim');
  assert.equal(retainedView?.gate.isVerifiedPass, false);
  assert.equal(retainedView?.gate.tone, 'neutral');
  assert.equal(retainedView?.gate.freshness, 'HISTORICAL');
  assert.deepEqual(retainedView?.gate.verificationAge, { state: 'not-recorded' });
  assert.equal(model.untrustedOrigin[0]?.gate.styling, 'untrusted');
  assert.equal(model.untrustedOrigin[0]?.gate.tone, 'neutral');
  const syn = model.synthetic?.results[0];
  assert.equal(syn?.gate.styling, 'synthetic');
  assert.equal(syn?.gate.isVerifiedPass, false);
  assert.equal(syn?.gate.authenticityText, 'SYNTHETIC DEMONSTRATION DATA — not a real CI result');
  assert.deepEqual(syn?.gate.verificationAge, { state: 'not-applicable' });
  assert.equal(syn?.gate.freshness, 'NOT_APPLICABLE');
});

test('imported text can never establish publication authenticity', () => {
  const model = vm(fullText(), 'imported');
  assert.equal(model.assertion, 'imported-not-authenticated');
  assert.equal(model.verifiedTotals.buildVerifiedResults, 0);
  assert.equal(model.verifiedTotals.verifiedPasses, 0);
  for (const r of [
    ...model.results,
    ...model.untrustedOrigin,
    ...(model.synthetic?.results ?? []),
  ]) {
    assert.equal(r.gate.styling, 'imported');
    assert.equal(r.gate.authenticity, 'IMPORTED_UNAUTHENTICATED');
    assert.equal(r.gate.isVerifiedPass, false);
    assert.equal(r.gate.tone, 'neutral');
    if (r.metrics.status === 'available')
      assert.equal(r.metrics.authenticity, 'IMPORTED_UNAUTHENTICATED');
  }
  // An unrecognized origin value is treated as imported.
  const odd = buildPublicationViewModel(parsePublication(fullText()), 'trusted' as 'imported', NOW);
  assert.equal(odd.origin, 'imported');
});

test('a rejected publication gives a fixed rejected model with no data', () => {
  const model = buildPublicationViewModel(parsePublication(`${CANARY}`), 'build-embedded', NOW);
  assert.deepEqual(model, { state: 'rejected', origin: 'build-embedded', code: 'invalid-json' });
});

/* ------------------------------------------------------------------ *
 * Freshness
 * ------------------------------------------------------------------ */

test('publication age: exactly 30 days is current, a millisecond more is stale', () => {
  const day = 86_400_000;
  const at30 = new Date(Date.parse(BUILT_AT) + 30 * day).toISOString();
  const over = new Date(Date.parse(BUILT_AT) + 30 * day + 1).toISOString();
  assert.deepEqual(publicationAgeOf(BUILT_AT, BUILT_AT), { state: 'current', ageDays: 0 });
  assert.deepEqual(publicationAgeOf(BUILT_AT, at30), { state: 'current', ageDays: 30 });
  assert.deepEqual(publicationAgeOf(BUILT_AT, over), { state: 'stale', ageDays: 30 });
  assert.equal(publicationAgeOf('2026-11-26T12:00:00Z', '2026-12-26T12:00:00Z').state, 'current');
  assert.equal(publicationAgeOf('2026-11-26T12:00:00Z', '2026-12-26T12:00:01Z').state, 'stale');
});

test('an invalid clock or a clock before builtAt gives an unknown age, never current', () => {
  for (const now of [
    undefined,
    null,
    0,
    '',
    'not a time',
    '2026-11-27',
    '2026-11-27T12:00:00+01:00',
    '2026-13-01T00:00:00Z',
    Number.NaN,
  ]) {
    assert.deepEqual(
      publicationAgeOf(BUILT_AT, now),
      { state: 'unknown', reason: 'invalid-clock' },
      String(now),
    );
  }
  assert.deepEqual(publicationAgeOf(BUILT_AT, '2026-11-26T11:59:59.999Z'), {
    state: 'unknown',
    reason: 'clock-before-build',
  });
  assert.equal(vm(fullText(), 'build-embedded', 'garbage').publicationAge.state, 'unknown');
});

test('publication age agrees with the committed P1 rule', () => {
  const samples = [
    '2026-11-26T12:00:00.000Z',
    '2026-12-26T12:00:00.000Z',
    '2026-12-26T12:00:00.001Z',
    '2027-03-01T00:00:00Z',
    '2026-11-25T00:00:00Z',
    'bad',
  ];
  for (const now of samples) {
    const ours = publicationAgeOf(BUILT_AT, now);
    const theirs = publicationAge(BUILT_AT, now);
    assert.equal(ours.state, theirs.state, now);
    if (ours.state !== 'unknown' && theirs.state !== 'unknown')
      assert.equal(ours.ageDays, theirs.ageDays);
  }
});

test('staleness never changes a verdict, and verification age is tracked separately', () => {
  const late = '2027-06-01T00:00:00.000Z';
  const fresh = vm(fullText(), 'build-embedded', NOW);
  const stale = vm(fullText(), 'build-embedded', late);
  assert.equal(stale.publicationAge.state, 'stale');
  assert.deepEqual(
    stale.results.map((r) => [r.gate.state, r.gate.isVerifiedPass, r.gate.freshness]),
    fresh.results.map((r) => [r.gate.state, r.gate.isVerifiedPass, r.gate.freshness]),
  );
  assert.deepEqual(stale.verifiedTotals, fresh.verifiedTotals);
  assert.equal(stale.results[0]?.gate.verificationAge.state, 'recorded');
  assert.deepEqual(verificationAgeOf(BUILT_AT, 'CURRENT', 'bad'), {
    state: 'unknown',
    verifiedAt: BUILT_AT,
  });
  assert.deepEqual(verificationAgeOf(BUILT_AT, 'CURRENT', '2026-11-25T00:00:00Z'), {
    state: 'unknown',
    verifiedAt: BUILT_AT,
  });
  assert.deepEqual(verificationAgeOf(null, 'HISTORICAL', NOW), { state: 'not-recorded' });
  assert.deepEqual(verificationAgeOf(null, 'NOT_APPLICABLE', NOW), { state: 'not-applicable' });
});

/* ------------------------------------------------------------------ *
 * Safety properties
 * ------------------------------------------------------------------ */

test('canaries from evidence never reach the parsed manifest or the view model', () => {
  const text = fullText();
  assert.equal(text.includes(CANARY), false);
  const serialized = JSON.stringify(vm(text));
  for (const marker of [CANARY, '://', '/Users/', 'token', 'Bearer']) {
    assert.equal(serialized.includes(marker), false, marker);
  }
});

test('parsing and view building are deterministic, frozen and do not mutate input', () => {
  const text = fullText();
  const parsed = parsePublication(text);
  const a = buildPublicationViewModel(parsed, 'build-embedded', NOW);
  const b = buildPublicationViewModel(parsePublication(text), 'build-embedded', NOW);
  assert.deepEqual(a, b);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(valid(parsed).results[0]?.gate), true);
  assert.equal(canonicalPublicationText(valid(parsed)), text);
});

/* ------------------------------------------------------------------ *
 * Browser compatibility (existing dashboard build constraints)
 * ------------------------------------------------------------------ */

/** The compiled-output prohibitions of scripts/build-dashboard.ts. */
const FORBIDDEN = [
  /\binnerHTML\b/,
  /\bouterHTML\b/,
  /\binsertAdjacentHTML\b/,
  /\bdocument\.write/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bFunction\s*\(/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bsendBeacon\b/,
  /\bimport\s*\(/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /https?:\/\//,
];

function compileLikeDashboard(path: string): string {
  const source = readFileSync(join(process.cwd(), 'src', 'reporting', path), 'utf8');
  const result = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      rewriteRelativeImportExtensions: true,
      isolatedModules: true,
      removeComments: true,
      sourceMap: false,
      inlineSourceMap: false,
      importHelpers: false,
    },
  });
  assert.deepEqual(result.diagnostics ?? [], [], path);
  return result.outputText;
}

test('the module compiles like the dashboard and imports only browser-safe modules', () => {
  const allowed = new Map([
    ['publication-view.ts', ['./quality-summary.js', './verdict.js']],
    ['verdict.ts', ['./quality-summary.js']],
    ['quality-summary.ts', []],
  ]);
  for (const [file, expected] of allowed) {
    const js = compileLikeDashboard(file);
    for (const pattern of FORBIDDEN)
      assert.equal(pattern.test(js), false, `${file}: ${String(pattern)}`);
    const imports = ts
      .preProcessFile(js, true, false)
      .importedFiles.map((f) => f.fileName)
      .sort();
    assert.deepEqual(imports, expected, file);
    assert.equal(/\bnode:|\brequire\s*\(|\bprocess\.|\bDate\.now\b/.test(js), false, file);
  }
});

/* ------------------------------------------------------------------ *
 * Verdict/reason and summary/reason semantics
 * ------------------------------------------------------------------ */

/**
 * Oracle: the committed strict bundle parser. Its consistency check tests the
 * verdict and summary reason rules first and reports the failing one by
 * path, so "rejected with reason-state-mismatch at that path" means the
 * committed rule refuses the combination.
 */
function bundleAccepts(
  part: 'verdict' | 'summary',
  state: string,
  reasons: readonly ReasonCode[],
): boolean {
  const base = bundleFrom(collected()).content;
  const content =
    part === 'verdict'
      ? { ...base, verdict: { ...base.verdict, state, reasons } }
      : {
          ...base,
          // `verdict-not-trusted` is permitted only with a non-trusted verdict.
          verdict: reasons.includes('verdict-not-trusted')
            ? { ...base.verdict, state: 'UNKNOWN', reasons: ['gate-not-decisive'] }
            : base.verdict,
          summary: { ...base.summary, state, reasons },
        };
  const parsed = parseVerdictBundle(JSON.stringify(content), POLICY);
  return !(
    parsed.status === 'rejected' &&
    parsed.code === 'reason-state-mismatch' &&
    parsed.path === `${part}.reasons`
  );
}

function candidates(
  accepts: (reasons: readonly ReasonCode[]) => boolean,
): (readonly ReasonCode[])[] {
  const singles = REASON_CODES.map((c) => [c]);
  const fitting = REASON_CODES.filter((c) => accepts([c]));
  const unfitting = REASON_CODES.find((c) => !accepts([c]));
  const pairs: ReasonCode[][] = [];
  for (let i = 0; i < fitting.length; i += 1) {
    for (let j = i + 1; j < fitting.length; j += 1) {
      pairs.push([fitting[i] as ReasonCode, fitting[j] as ReasonCode].sort());
    }
    if (unfitting !== undefined && fitting[i] !== undefined) {
      pairs.push([fitting[i] as ReasonCode, unfitting].sort());
    }
  }
  return [[], ...singles, ...pairs];
}

test('restated verdict reason rules equal the committed bundle rules', () => {
  let compared = 0;
  for (const state of VERDICT_STATES) {
    const oracle = (r: readonly ReasonCode[]) => bundleAccepts('verdict', state, r);
    for (const reasons of candidates(oracle)) {
      assert.equal(
        verdictReasonsFit(state, reasons),
        oracle(reasons),
        `${state} ${reasons.join()}`,
      );
      compared += 1;
    }
  }
  assert.ok(compared > VERDICT_STATES.length * REASON_CODES.length);
});

test('restated summary reason rules equal the committed bundle rules', () => {
  const states: readonly SummaryState[] = [
    'SUMMARY_UNKNOWN',
    'SUMMARY_UNAVAILABLE',
    'SUMMARY_CONFLICT',
    'SUMMARY_INVALID',
    'SUMMARY_INFORMATIVE',
    'SUMMARY_VERIFIED_ORIGIN',
  ];
  for (const state of states) {
    const oracle = (r: readonly ReasonCode[]) => bundleAccepts('summary', state, r);
    for (const reasons of candidates(oracle)) {
      assert.equal(
        summaryReasonsFit(state, reasons),
        oracle(reasons),
        `${state} ${reasons.join()}`,
      );
    }
  }
});

test('canonical manifests with contradictory verdict reasons are rejected', () => {
  const gate = entryObj().gate as Json;
  const cases: [string, Json][] = [
    ['pass with a failure reason', { ...gate, state: 'VERIFIED_PASS', reasons: ['gate-failure'] }],
    ['pass with no reason', { ...gate, state: 'VERIFIED_PASS', reasons: [] }],
    [
      'pass with an extra reason',
      { ...gate, state: 'VERIFIED_PASS', reasons: ['gate-success', 'run-cancelled'] },
    ],
    [
      'failure with a success reason',
      { ...gate, state: 'VERIFIED_FAIL', reasons: ['gate-success'] },
    ],
    ['pending with a success reason', { ...gate, state: 'PENDING', reasons: ['gate-success'] }],
    ['cancelled without a reason', { ...gate, state: 'CANCELLED', reasons: [] }],
    ['unknown claiming success', { ...gate, state: 'UNKNOWN', reasons: ['gate-success'] }],
    [
      'unknown with two exclusive reasons',
      { ...gate, state: 'UNKNOWN', reasons: ['gate-not-decisive', 'no-test-job'] },
    ],
    [
      'unknown mixing retrieval and decision',
      { ...gate, state: 'UNKNOWN', reasons: ['gate-not-decisive', 'retrieval-jobs-timeout'] },
    ],
    [
      'conflict mixing families',
      {
        ...gate,
        state: 'CONFLICT',
        reasons: ['identity-job-sha-mismatch', 'outcome-job-not-completed'],
      },
    ],
    [
      'conflict with a provenance reason',
      { ...gate, state: 'CONFLICT', reasons: ['provenance-branch'] },
    ],
    [
      'execution failure with a summary reason',
      { ...gate, state: 'EXECUTION_FAILED', reasons: ['artifact-absent'] },
    ],
    [
      'established run not retrieved',
      { ...gate, state: 'UNKNOWN', reasons: ['retrieval-run-not-found'] },
    ],
    [
      'established run with invalid request',
      { ...gate, state: 'UNKNOWN', reasons: ['invalid-request'] },
    ],
  ];
  for (const [name, g] of cases) {
    assert.equal(rejection(manifestText([entryObj({ gate: g })])), 'reason-state-mismatch', name);
  }
  // A P1 manifest edited into a contradiction, still canonical and well-formed.
  const text = p1([verified(collected())]).text;
  const edited = mutate(text, (m) => (at(m, 'results', 0, 'gate').reasons = ['gate-failure']));
  assert.equal(edited, canonicalPublicationText(JSON.parse(edited) as never));
  assert.equal(rejection(edited), 'reason-state-mismatch');
});

test('canonical manifests with contradictory summary reasons are rejected', () => {
  const s = (state: string, reasons: string[], label: string | null = null): Json => ({
    state,
    reasons,
    label,
  });
  const cases: [string, Json][] = [
    [
      'verified origin with an absence reason',
      s('SUMMARY_VERIFIED_ORIGIN', ['artifact-absent'], 'verified-origin'),
    ],
    ['unavailable claiming verified origin', s('SUMMARY_UNAVAILABLE', ['verified-origin'])],
    [
      'unavailable with two reasons',
      s('SUMMARY_UNAVAILABLE', ['artifact-absent', 'artifact-expired']),
    ],
    ['unavailable without a reason', s('SUMMARY_UNAVAILABLE', [])],
    ['conflict with an absence reason', s('SUMMARY_CONFLICT', ['artifact-absent'])],
    ['invalid with a conflict reason', s('SUMMARY_INVALID', ['digest-mismatch'])],
    ['unknown with a verdict reason', s('SUMMARY_UNKNOWN', ['gate-success'])],
    ['unknown with run retrieval', s('SUMMARY_UNKNOWN', ['retrieval-run-timeout'])],
    ['unknown with invalid policy', s('SUMMARY_UNKNOWN', ['invalid-policy'])],
  ];
  for (const [name, summary] of cases) {
    assert.equal(rejection(manifestText([entryObj({ summary })])), 'reason-state-mismatch', name);
  }
});

test('SUMMARY_INFORMATIVE reasons must match the verdict trust and name an artifact', () => {
  const pass = { ...(entryObj().gate as Json), state: 'VERIFIED_PASS', reasons: ['gate-success'] };
  const unknown = entryObj().gate as Json;
  const artifact = { id: 15_000_001, digest: null, integrity: 'not-checked' };
  const informative = (reasons: string[]): Json => ({
    state: 'SUMMARY_INFORMATIVE',
    reasons,
    label: 'unverified-origin',
  });
  // Permitted: the committed reconciler's two INFORMATIVE return sites.
  vm(
    manifestText([
      entryObj({ gate: pass, artifact, summary: informative(['digest-contract-unconfirmed']) }),
    ]),
  );
  vm(
    manifestText([
      entryObj({ gate: unknown, artifact, summary: informative(['verdict-not-trusted']) }),
    ]),
  );
  vm(
    manifestText([
      entryObj({
        gate: unknown,
        artifact,
        summary: informative(['digest-contract-unconfirmed', 'verdict-not-trusted']),
      }),
    ]),
  );
  // Contradictions.
  const bad: [string, Json][] = [
    [
      'trusted verdict called not trusted',
      entryObj({ gate: pass, artifact, summary: informative(['verdict-not-trusted']) }),
    ],
    [
      'untrusted verdict without the reason',
      entryObj({ gate: unknown, artifact, summary: informative(['digest-contract-unconfirmed']) }),
    ],
    [
      'no artifact',
      entryObj({ gate: pass, summary: informative(['digest-contract-unconfirmed']) }),
    ],
  ];
  for (const [name, e] of bad)
    assert.equal(rejection(manifestText([e])), 'reason-state-mismatch', name);
});

test('exceptional states with their own reasons remain publishable', () => {
  const gate = entryObj().gate as Json;
  const ok: [string, Json][] = [
    [
      'cancelled run and job',
      entryObj({
        gate: { ...gate, state: 'CANCELLED', reasons: ['job-cancelled', 'run-cancelled'] },
      }),
    ],
    [
      'execution failed without a test job',
      entryObj({
        gate: { ...gate, state: 'EXECUTION_FAILED', reasons: ['run-failed-without-test-job'] },
      }),
    ],
    [
      'outcome conflicts',
      entryObj({
        gate: {
          ...gate,
          state: 'CONFLICT',
          reasons: ['outcome-gate-failure-job-success', 'outcome-job-not-completed'],
        },
      }),
    ],
    [
      // Retained only: nothing that could not be retrieved is a BUILD_VERIFIED claim.
      'retained unknown from jobs and ancestry retrieval',
      entryObj({
        gate: {
          ...gate,
          reasons: ['retrieval-ancestry-timeout', 'retrieval-jobs-rate-limited'],
          authenticity: 'RETAINED_UNAUTHENTICATED',
          freshness: 'HISTORICAL',
          verifiedAt: null,
        },
      }),
    ],
    [
      'summary conflict',
      entryObj({
        summary: {
          state: 'SUMMARY_CONFLICT',
          reasons: ['artifact-sha-mismatch', 'summary-sha-mismatch'],
          label: null,
        },
      }),
    ],
    [
      'summary invalid',
      entryObj({
        summary: { state: 'SUMMARY_INVALID', reasons: ['archive-too-large'], label: null },
      }),
    ],
    [
      'summary unknown',
      entryObj({
        summary: { state: 'SUMMARY_UNKNOWN', reasons: ['retrieval-archive-timeout'], label: null },
      }),
    ],
  ];
  for (const [name, e] of ok) {
    const model = vm(manifestText([e]));
    assert.equal(model.verifiedTotals.verifiedPasses, 0, name);
    assert.equal(model.results[0]?.gate.isVerifiedPass, false, name);
    assert.equal(model.results[0]?.metrics.status, 'unavailable', name);
  }
  // A P1 digest mismatch (SUMMARY_CONFLICT) is accepted and never verified data.
  const mismatch = vm(
    p1([verified(collected(RUN_ID, { archive: { ...MATCHED, digestCheck: 'mismatch' } }))]).text,
  );
  assert.equal(mismatch.results[0]?.summary.state, 'SUMMARY_CONFLICT');
  assert.equal(mismatch.results[0]?.artifact.integrity, 'mismatch');
  assert.equal(mismatch.results[0]?.metrics.status, 'unavailable');
});

test('contradictory evidence is never promoted to verified styling or totals', () => {
  const forged = entryObj({
    gate: { ...(entryObj().gate as Json), state: 'VERIFIED_PASS', reasons: ['gate-failure'] },
  });
  for (const origin of ['build-embedded', 'imported'] as const) {
    const model = buildPublicationViewModel(parsePublication(manifestText([forged])), origin, NOW);
    assert.deepEqual(model, { state: 'rejected', origin, code: 'reason-state-mismatch' });
    assert.equal(JSON.stringify(model).includes('gate-failure'), false);
  }
});
