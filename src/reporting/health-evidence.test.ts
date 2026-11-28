/**
 * Unit tests for the README health evidence adapter, history assessment and
 * local dry run (ADR-0013, Phase C5B). Everything is synthetic: an in-memory
 * transport serves run metadata, jobs, artifacts and archives. No network,
 * no filesystem, no credentials.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assessHistory,
  changedPaths,
  collectHealthEvidence,
  type ChangedFiles,
  type EvidenceDiagnostic,
  type EvidencePolicies,
  type HistoryDiagnostic,
  type HealthEvidenceTransport,
} from './health-evidence.ts';
import {
  EVIDENCE_DIAGNOSTIC_CODES,
  HISTORY_DIAGNOSTIC_CODES,
  MAX_REPORT_BYTES,
  nodeReadReadme,
  parseDryRunArgs,
  parseDryRunReport,
  renderDryRunSummary,
  runReadmeDryRun,
  serializeDryRunReport,
  type DryRunDeps,
  type ReadmeReadResult,
} from './readme-dry-run.ts';
import {
  SECTION_END,
  SECTION_START,
  metricIdentity,
  metricsDigest,
  renderReadmeSection,
} from './readme-health.ts';
import { REFRESH_POLICY } from './refresh-decision.ts';
import { sha256Digest, type BaseTrustPolicy, type DownloadOutcome } from './verdict-cli.ts';
import type {
  AncestryEvidence,
  ArtifactEvidence,
  JobEvidence,
  Retrieved,
  RunAttemptEvidence,
} from './verdict.ts';
import { normalize, serialize } from './quality-summary.ts';
import { parseSummary } from './dashboard-model.ts';
import { context, passing, report, spec, type SyntheticSpec } from './fixtures.ts';
import { parseUnitResults, serializeUnitResults } from './unit-results.ts';
import { healthModel, renderHealthMarkdown, type HealthModel } from './test-health.ts';
import { crc32 } from './zip-entry.ts';

/* ------------------------------------------------------------------ *
 * Identities and canaries
 * ------------------------------------------------------------------ */

const REPO = 'example-owner/example-repo';
const REPO_ID = 900_000_001;
const WORKFLOW_ID = 800_000_001;
const RUN_ID = 1_000_001; // matches fixtures.context()
const ATTEMPT = 1;
const HEAD = '0123456789abcdef0123456789abcdef01234567'; // fixtures SYNTHETIC_SHA
const SNAPSHOT_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MAIN_TIP = 'fedcba9876543210fedcba9876543210fedcba98';
const GENERATED = '2026-11-25T00:00:40.000Z';
const COMPLETED = '2026-11-25T00:01:00Z';

const POLICIES: EvidencePolicies = {
  trust: Object.freeze({
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
  }) satisfies BaseTrustPolicy,
  refresh: { ...REFRESH_POLICY, repository: REPO } as unknown as typeof REFRESH_POLICY,
};

/** Must never appear in any output. */
const TOKEN_CANARY = `ghp_TOKENCANARY${'7'.repeat(24)}`;
const SIGNED_URL_CANARY = 'sig=SIGNEDURLCANARY9f8e7d';
const TITLE_CANARY = 'synthetic dashboard a';

const enc = new TextEncoder();

/* ------------------------------------------------------------------ *
 * Synthetic artifacts
 * ------------------------------------------------------------------ */

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

/** A stored (uncompressed) ZIP of the given named text entries. */
function storedZip(entries: [string, string][]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [entryName, text] of entries) {
    const name = enc.encode(entryName);
    const content = enc.encode(text);
    const crc = crc32(content);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(content.length),
      u32(content.length),
      u16(name.length),
      u16(0),
      name,
      content,
    ]);
    centrals.push(
      concat([
        u32(0x02014b50),
        u16((3 << 8) | 20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(content.length),
        u32(content.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32((0o100644 << 16) >>> 0),
        u32(offset),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(centrals);
  return concat([
    ...locals,
    cd,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(offset),
    u16(0),
  ]);
}

const BROWSERS = ['chromium', 'firefox', 'webkit'];
const AUTHENTICATED = BROWSERS.map((b) => `${b}-authenticated`);

function specs(): SyntheticSpec[] {
  return [
    spec('ui/dashboard.spec.ts', 10, TITLE_CANARY, BROWSERS.map(passing)),
    spec('ui/dashboard.a11y.spec.ts', 13, 'synthetic dashboard a11y', [passing('chromium')]),
    spec('ui/login.spec.ts', 14, 'synthetic login', BROWSERS.map(passing)),
    spec('ui/authenticated/cart.spec.ts', 16, 'synthetic cart', AUTHENTICATED.map(passing)),
    spec('api/products.spec.ts', 18, 'synthetic api', [passing('api')]),
    spec('auth.setup.ts', 20, 'synthetic setup', [passing('setup')]),
  ];
}

function summaryText(): string {
  return serialize(normalize(report(specs()), context()));
}

function unitText(identity: { runAttempt?: number; sourceSha?: string } = {}): string {
  const counts = { tests: 10, passed: 10, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
  return serializeUnitResults({
    kind: 'unit-test-results',
    schemaVersion: '1.0.0',
    nodeVersion: 'v24.22.3',
    success: true,
    counts,
    events: counts,
    execution: { startedAt: '2026-11-25T00:00:01.000Z', finishedAt: '2026-11-25T00:00:20.000Z' },
    provenance: {
      mode: 'ci',
      runId: RUN_ID,
      runAttempt: identity.runAttempt ?? ATTEMPT,
      sourceSha: identity.sourceSha ?? HEAD,
    },
  });
}

/** The CI health bundle exactly as the C2 CLI writes it. */
function healthBundle(unit = unitText()): { json: string; markdown: string; model: HealthModel } {
  const built = healthModel(parseSummary(summaryText()), parseUnitResults(unit), {
    mode: 'ci',
    generatedAt: GENERATED,
    runId: RUN_ID,
    runAttempt: ATTEMPT,
    sourceSha: HEAD,
  });
  assert.ok(built.ok);
  return {
    json: `${JSON.stringify(built.model, null, 2)}\n`,
    markdown: renderHealthMarkdown(built.model),
    model: built.model,
  };
}

/* ------------------------------------------------------------------ *
 * Synthetic transport
 * ------------------------------------------------------------------ */

interface World {
  run: RunAttemptEvidence;
  latestAttempt: Retrieved<number>;
  completion: Retrieved<string>;
  jobs: JobEvidence[];
  artifacts: ArtifactEvidence[];
  archives: Map<number, DownloadOutcome>;
  tip: string;
  /** Keyed `${evaluated}...${tip}`. */
  comparisons: Map<string, Retrieved<AncestryEvidence>>;
  /** Keyed `${base}...${head}`. */
  files: Map<string, Retrieved<ChangedFiles>>;
  calls: string[];
}

const ok = <T>(value: T): Retrieved<T> => ({ status: 'ok', value });
const failed = <T>(): Retrieved<T> => ({ status: 'failed', reason: 'http-error' });

function artifact(id: number, name: string, bytes: Uint8Array): ArtifactEvidence {
  return {
    id,
    name,
    sizeInBytes: bytes.length,
    digest: sha256Digest(bytes),
    createdAt: '2026-11-25T00:00:50Z',
    expiresAt: '2026-12-02T00:00:50Z',
    expired: false,
    workflowRun: { id: RUN_ID, repositoryId: REPO_ID, headRepositoryId: REPO_ID, headSha: HEAD },
  };
}

function world(): World {
  const summaryZip = storedZip([['quality-summary.json', summaryText()]]);
  const unitZip = storedZip([['unit-results.stamped.json', unitText()]]);
  const bundle = healthBundle();
  const healthZip = storedZip([
    ['test-health.json', bundle.json],
    ['test-health.md', bundle.markdown],
  ]);
  const step = (number: number, name: string) => ({
    number,
    name,
    status: 'completed',
    conclusion: 'success',
  });
  return {
    run: {
      id: RUN_ID,
      runAttempt: ATTEMPT,
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
      runStartedAt: '2026-11-25T00:00:00Z',
      updatedAt: '2026-11-25T00:01:01Z',
    },
    latestAttempt: ok(ATTEMPT),
    completion: ok(COMPLETED),
    jobs: [
      {
        id: 600_000_001,
        name: 'test',
        runAttempt: ATTEMPT,
        headSha: HEAD,
        status: 'completed',
        conclusion: 'success',
        steps: [step(1, 'Set up job'), step(9, 'Gate')],
      },
      {
        id: 600_000_002,
        name: 'checks',
        runAttempt: ATTEMPT,
        headSha: HEAD,
        status: 'completed',
        conclusion: 'success',
        steps: [step(1, 'Unit tests')],
      },
    ],
    artifacts: [
      artifact(700_000_001, 'quality-summary-1', summaryZip),
      artifact(700_000_002, 'unit-results-1', unitZip),
      artifact(700_000_003, 'test-health-1', healthZip),
    ],
    archives: new Map<number, DownloadOutcome>([
      [700_000_001, { status: 'ok', bytes: summaryZip }],
      [700_000_002, { status: 'ok', bytes: unitZip }],
      [700_000_003, { status: 'ok', bytes: healthZip }],
    ]),
    tip: HEAD,
    comparisons: new Map(),
    files: new Map(),
    calls: [],
  };
}

function transport(w: World): HealthEvidenceTransport {
  const relationOf = (evaluated: string, tip: string): Retrieved<AncestryEvidence> =>
    w.comparisons.get(`${evaluated}...${tip}`) ??
    (evaluated === tip
      ? ok({ evaluatedSha: evaluated, mainTipSha: tip, relation: 'identical' })
      : failed());
  /** Records the call and resolves with `value`. */
  const served = <T>(call: string, value: T): Promise<T> => {
    w.calls.push(call);
    return Promise.resolve(value);
  };
  return {
    getRunAttempt: () => served('run', ok(w.run)),
    listJobs: () => served('jobs', ok(w.jobs)),
    listArtifacts: () => served('artifacts', ok(w.artifacts)),
    downloadArtifact: (id: number) =>
      served<DownloadOutcome>(
        `download:${String(id)}`,
        w.archives.get(id) ?? { status: 'failed', reason: 'not-found' },
      ),
    resolveBranchTip: () => served('tip', ok(w.tip)),
    compare: (evaluated: string, tip: string) =>
      served(`compare:${evaluated.slice(0, 4)}:${tip.slice(0, 4)}`, relationOf(evaluated, tip)),
    getLatestAttempt: () => served('latest', w.latestAttempt),
    getAttemptCompletion: () => served('completion', w.completion),
    listChangedFiles: (base: string, head: string) =>
      served(
        `files:${base.slice(0, 4)}:${head.slice(0, 4)}`,
        w.files.get(`${base}...${head}`) ?? failed<ChangedFiles>(),
      ),
  };
}

async function evaluate(w: World) {
  return collectHealthEvidence(transport(w), { runId: RUN_ID, runAttempt: ATTEMPT }, POLICIES);
}

function setArchive(w: World, name: string, bytes: Uint8Array): void {
  const index = w.artifacts.findIndex((a) => a.name === name);
  const existing = w.artifacts[index];
  assert.ok(existing);
  w.artifacts[index] = artifact(existing.id, name, bytes);
  w.archives.set(existing.id, { status: 'ok', bytes });
}

function noDownloads(w: World): void {
  assert.ok(!w.calls.includes('artifacts'), w.calls.join(','));
  assert.ok(!w.calls.some((call) => call.startsWith('download:')), w.calls.join(','));
}

/* ------------------------------------------------------------------ *
 * Evidence: the eligible path
 * ------------------------------------------------------------------ */

test('a complete, verified push-to-main attempt is evaluated with matching evidence', async () => {
  const result = await evaluate(world());
  assert.equal(result.status, 'evaluated');
  if (result.status !== 'evaluated') return;
  assert.deepEqual(result.evidence, {
    verdict: 'VERIFIED_PASS',
    summary: 'SUMMARY_VERIFIED_ORIGIN',
    unit: 'complete',
    playwright: 'complete',
    identity: 'match',
    healthBundle: 'match',
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.candidate.completedAt, COMPLETED);
  assert.equal(result.model.generatedAt, GENERATED, 'recomputed with the recorded time');
});

/* ------------------------------------------------------------------ *
 * Evidence: rejection before any download
 * ------------------------------------------------------------------ */

test('pull request, fork and wrong-workflow candidates are rejected before downloads', async () => {
  const cases: [(w: World) => void, string][] = [
    [(w) => (w.run = { ...w.run, event: 'pull_request' }), 'not-push-event'],
    [(w) => (w.run = { ...w.run, headBranch: 'feature' }), 'not-main-branch'],
    [
      (w) => (w.run = { ...w.run, headRepository: { fullName: 'attacker/example-repo' } }),
      'foreign-head-repository',
    ],
    [(w) => (w.run = { ...w.run, path: '.github/workflows/other.yml' }), 'wrong-workflow'],
    [(w) => (w.run = { ...w.run, workflowId: 1 }), 'wrong-workflow'],
    [(w) => (w.run = { ...w.run, repository: { id: 1, fullName: REPO } }), 'wrong-repository'],
    [
      (w) => (w.run = { ...w.run, repository: { id: REPO_ID, fullName: 'other/repo' } }),
      'wrong-repository',
    ],
    [(w) => (w.run = { ...w.run, status: 'in_progress' }), 'run-not-completed'],
    [(w) => (w.latestAttempt = ok(2)), 'attempt-superseded'],
    [(w) => (w.completion = failed()), 'completion-time-missing'],
  ];
  for (const [mutate, reason] of cases) {
    const w = world();
    mutate(w);
    const result = await evaluate(w);
    assert.equal(result.status, 'ineligible', reason);
    if (result.status === 'ineligible')
      assert.ok(result.reasons.includes(reason as never), `${reason}: ${result.reasons.join(',')}`);
    noDownloads(w);
  }
});

test('an impossible attempt, a mismatched id and unavailable metadata are rejected', async () => {
  const future = world();
  future.latestAttempt = ok(0);
  const r1 = await evaluate(future);
  assert.equal(r1.status, 'ineligible');
  noDownloads(future);

  const other = world();
  other.run = { ...other.run, id: RUN_ID + 1 };
  const r2 = await evaluate(other);
  assert.ok(r2.status === 'ineligible' && r2.diagnostics.includes('run-identity-mismatch'));
  noDownloads(other);

  const latestDown = world();
  latestDown.latestAttempt = failed();
  const r3 = await evaluate(latestDown);
  assert.ok(r3.status === 'ineligible' && r3.reasons.includes('run-metadata-unavailable'));
  noDownloads(latestDown);

  const w = world();
  const t = transport(w);
  const r4 = await collectHealthEvidence(
    { ...t, getRunAttempt: () => Promise.resolve(failed<RunAttemptEvidence>()) },
    { runId: RUN_ID, runAttempt: ATTEMPT },
    POLICIES,
  );
  assert.deepEqual(r4, {
    status: 'ineligible',
    candidate: null,
    reasons: ['run-metadata-unavailable'],
    diagnostics: ['run-metadata-unavailable'],
  });
  noDownloads(w);

  const r5 = await collectHealthEvidence(transport(world()), { runId: 0, runAttempt: 1 }, POLICIES);
  assert.equal(r5.status, 'ineligible');
});

/* ------------------------------------------------------------------ *
 * Evidence: artifacts
 * ------------------------------------------------------------------ */

async function diagnosticsFor(mutate: (w: World) => void) {
  const w = world();
  mutate(w);
  const result = await evaluate(w);
  assert.equal(result.status, 'evaluated');
  if (result.status !== 'evaluated') throw new Error('unreachable');
  return { result, w };
}

test('missing, duplicate, expired and unbound artifacts are reported, never substituted', async () => {
  const cases: [(w: World) => void, string, 'unit' | 'health'][] = [
    [
      (w) => (w.artifacts = w.artifacts.filter((a) => a.name !== 'unit-results-1')),
      'unit-artifact-missing',
      'unit',
    ],
    [
      (w) => w.artifacts.push({ ...(w.artifacts[2] as ArtifactEvidence), id: 700_000_009 }),
      'health-artifact-duplicate',
      'health',
    ],
    [
      (w) => (w.artifacts[1] = { ...(w.artifacts[1] as ArtifactEvidence), expired: true }),
      'unit-artifact-expired',
      'unit',
    ],
    [
      (w) =>
        (w.artifacts[2] = {
          ...(w.artifacts[2] as ArtifactEvidence),
          workflowRun: { id: 42, repositoryId: REPO_ID, headRepositoryId: REPO_ID, headSha: HEAD },
        }),
      'health-artifact-unbound',
      'health',
    ],
    [
      (w) =>
        (w.artifacts[2] = {
          ...(w.artifacts[2] as ArtifactEvidence),
          sizeInBytes: 7 * 1024 * 1024,
        }),
      'health-artifact-declared-too-large',
      'health',
    ],
    [
      (w) => (w.artifacts[1] = { ...(w.artifacts[1] as ArtifactEvidence), digest: null }),
      'unit-artifact-digest-missing',
      'unit',
    ],
    [
      (w) => w.archives.set(700_000_003, { status: 'failed', reason: 'expired' }),
      'health-artifact-download-expired',
      'health',
    ],
    [
      (w) => w.archives.set(700_000_002, { status: 'too-large' }),
      'unit-artifact-download-too-large',
      'unit',
    ],
    [
      (w) =>
        w.archives.set(700_000_003, {
          status: 'ok',
          bytes: storedZip([['test-health.json', '{}']]),
        }),
      'health-artifact-digest-mismatch',
      'health',
    ],
  ];
  for (const [mutate, diagnostic, kind] of cases) {
    const { result, w } = await diagnosticsFor(mutate);
    assert.ok(
      result.diagnostics.includes(diagnostic as never),
      `${diagnostic}: ${result.diagnostics.join(',')}`,
    );
    if (kind === 'unit') assert.equal(result.evidence.unit, 'unavailable', diagnostic);
    if (kind === 'health') assert.equal(result.evidence.healthBundle, 'unavailable', diagnostic);
    // Only exact names of THIS attempt are ever requested.
    assert.ok(!w.calls.includes('download:700000009'));
  }
});

test('unexpected bundle entries and malformed archives are rejected after digest checks', async () => {
  const extra = await diagnosticsFor((w) =>
    setArchive(
      w,
      'test-health-1',
      storedZip([
        ['test-health.json', '{}'],
        ['test-health.md', '#'],
        ['evil.sh', 'x'],
      ]),
    ),
  );
  assert.ok(extra.result.diagnostics.includes('health-artifact-unexpected-entries'));
  const malformed = await diagnosticsFor((w) =>
    setArchive(
      w,
      'unit-results-1',
      enc.encode('not a zip at all, but long enough to read past headers..........'),
    ),
  );
  assert.ok(malformed.result.diagnostics.includes('unit-artifact-archive-malformed'));
});

test('a refused storage redirect is reported with a fixed code', async () => {
  const { result } = await diagnosticsFor((w) =>
    w.archives.set(700_000_003, { status: 'redirect-refused' }),
  );
  assert.ok(result.diagnostics.includes('storage-redirect-refused'));
  assert.ok(result.diagnostics.includes('health-artifact-download-failed'));
});

/* ------------------------------------------------------------------ *
 * Evidence: recomputation and identity
 * ------------------------------------------------------------------ */

test('a health bundle that differs from the recomputed model is a mismatch', async () => {
  const bundle = healthBundle();
  const tamperedJson = bundle.json.replace('"tests": 10', '"tests": 11');
  assert.notEqual(tamperedJson, bundle.json);
  const json = await diagnosticsFor((w) =>
    setArchive(
      w,
      'test-health-1',
      storedZip([
        ['test-health.json', tamperedJson],
        ['test-health.md', bundle.markdown],
      ]),
    ),
  );
  assert.equal(json.result.evidence.healthBundle, 'mismatch');
  assert.ok(json.result.diagnostics.includes('health-bundle-recompute-mismatch'));

  const markdown = await diagnosticsFor((w) =>
    setArchive(
      w,
      'test-health-1',
      storedZip([
        ['test-health.json', bundle.json],
        ['test-health.md', `${bundle.markdown}x`],
      ]),
    ),
  );
  assert.equal(markdown.result.evidence.healthBundle, 'mismatch');

  const invalid = await diagnosticsFor((w) =>
    setArchive(
      w,
      'test-health-1',
      storedZip([
        ['test-health.json', '{"generatedAt":"yesterday"}'],
        ['test-health.md', '#'],
      ]),
    ),
  );
  assert.ok(invalid.result.diagnostics.includes('health-bundle-json-invalid'));
  assert.equal(invalid.result.evidence.healthBundle, 'mismatch');
});

test('a unit result stamped for another attempt is an identity mismatch', async () => {
  const { result } = await diagnosticsFor((w) =>
    setArchive(
      w,
      'unit-results-1',
      storedZip([['unit-results.stamped.json', unitText({ runAttempt: 2 })]]),
    ),
  );
  assert.equal(result.evidence.identity, 'mismatch');
  assert.ok(result.diagnostics.includes('unit-provenance-mismatch'));
});

test('the verdict comes from the reconciler, not from any artifact', async () => {
  const { result } = await diagnosticsFor((w) => {
    const test = w.jobs[0] as JobEvidence;
    w.jobs[0] = {
      ...test,
      conclusion: 'failure',
      steps: [{ number: 9, name: 'Gate', status: 'completed', conclusion: 'failure' }],
    };
    w.run = { ...w.run, conclusion: 'failure' };
  });
  assert.notEqual(result.evidence.verdict, 'VERIFIED_PASS');
  assert.equal(result.verification.verdict, result.evidence.verdict);
});

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

test('changed paths: renames and copies give both paths; anything incomplete is unknown', () => {
  const files = (list: ChangedFiles['files'], complete = true): Retrieved<ChangedFiles> =>
    ok({ files: list, complete });
  assert.deepEqual(
    changedPaths(
      files([
        { filename: 'docs/new.md', previousFilename: 'docs/old.md', status: 'renamed' },
        { filename: 'README.md', previousFilename: null, status: 'modified' },
        { filename: 'docs/copy.md', previousFilename: 'docs/source.md', status: 'copied' },
      ]),
    ),
    ['README.md', 'docs/copy.md', 'docs/new.md', 'docs/old.md', 'docs/source.md'],
  );
  assert.equal(changedPaths(files([], false)), null, 'truncated');
  assert.equal(changedPaths(failed()), null, 'unavailable');
  assert.equal(
    changedPaths(files([{ filename: 'a.md', previousFilename: null, status: 'mystery' }])),
    null,
  );
  assert.equal(
    changedPaths(files([{ filename: 'a.md', previousFilename: null, status: 'renamed' }])),
    null,
  );
  assert.deepEqual(changedPaths(files([])), []);
});

function ancestry(
  w: World,
  evaluated: string,
  tip: string,
  relation: AncestryEvidence['relation'],
): void {
  w.comparisons.set(
    `${evaluated}...${tip}`,
    ok({ evaluatedSha: evaluated, mainTipSha: tip, relation }),
  );
}

test('history: both comparisons use the right orientation and paths', async () => {
  const w = world();
  w.tip = MAIN_TIP;
  ancestry(w, SNAPSHOT_SHA, HEAD, 'head-is-ancestor'); // snapshot is older than the candidate
  ancestry(w, HEAD, MAIN_TIP, 'head-is-ancestor'); // the candidate is older than main
  w.files.set(
    `${SNAPSHOT_SHA}...${HEAD}`,
    ok({
      files: [{ filename: 'src/a.ts', previousFilename: null, status: 'modified' }],
      complete: true,
    }),
  );
  w.files.set(
    `${HEAD}...${MAIN_TIP}`,
    ok({
      files: [{ filename: 'README.md', previousFilename: null, status: 'modified' }],
      complete: true,
    }),
  );
  const facts = await assessHistory(transport(w), SNAPSHOT_SHA, HEAD);
  assert.deepEqual(facts, {
    mainTip: MAIN_TIP,
    candidateVsSnapshot: 'descendant',
    candidateVsMain: 'ancestor',
    changesSinceSnapshotSource: ['src/a.ts'],
    changesSinceCandidateSource: ['README.md'],
    diagnostics: [],
  });
});

test('history: unavailable tips, comparisons and truncated listings are unknown', async () => {
  const noTip = world();
  const t = transport(noTip);
  const facts = await assessHistory(
    { ...t, resolveBranchTip: () => Promise.resolve(failed<string>()) },
    SNAPSHOT_SHA,
    HEAD,
  );
  assert.equal(facts.candidateVsMain, 'unknown');
  assert.equal(facts.candidateVsSnapshot, 'unknown');
  assert.ok(facts.diagnostics.includes('main-tip-unavailable'));

  const truncated = world();
  ancestry(truncated, SNAPSHOT_SHA, HEAD, 'head-is-ancestor');
  truncated.files.set(`${SNAPSHOT_SHA}...${HEAD}`, ok({ files: [], complete: false }));
  const t2 = await assessHistory(transport(truncated), SNAPSHOT_SHA, HEAD);
  assert.equal(t2.changesSinceSnapshotSource, null);
  assert.ok(t2.diagnostics.includes('changes-since-snapshot-incomplete'));

  const diverged = world();
  ancestry(diverged, SNAPSHOT_SHA, HEAD, 'diverged');
  const t3 = await assessHistory(transport(diverged), SNAPSHOT_SHA, HEAD);
  assert.equal(t3.candidateVsSnapshot, 'diverged');
  assert.equal(t3.changesSinceSnapshotSource, null);

  const bad = await assessHistory(transport(world()), 'not-a-sha', HEAD);
  assert.equal(bad.candidateVsSnapshot, 'unknown');
});

/* ------------------------------------------------------------------ *
 * Dry run
 * ------------------------------------------------------------------ */

const ARGS = [
  '--run-id',
  String(RUN_ID),
  '--run-attempt',
  '1',
  '--readme',
  'README.md',
  '--prepared-on',
  '2026-11-25',
];

test('dry-run arguments are explicit, complete and strictly validated', () => {
  assert.deepEqual(parseDryRunArgs(ARGS), {
    runId: RUN_ID,
    runAttempt: 1,
    readme: 'README.md',
    preparedOn: '2026-11-25',
  });
  for (const bad of [
    [],
    ARGS.slice(0, 6),
    [...ARGS, '--extra', 'x'],
    ARGS.map((a) => (a === '--run-id' ? '--run' : a)),
    ARGS.map((a, i) => (i === 1 ? '0' : a)),
    ARGS.map((a, i) => (i === 3 ? '01' : a)),
    ARGS.map((a, i) => (i === 7 ? '2026-02-30' : a)),
    ARGS.map((a, i) => (i === 5 ? '' : a)),
    ['--run-id', '1', '--run-id', '1', '--readme', 'R', '--prepared-on', '2026-11-25'],
  ]) {
    assert.equal(parseDryRunArgs(bad), undefined, JSON.stringify(bad));
  }
});

/** A README whose section is an automated snapshot pinned to `SNAPSHOT_SHA`. */
function readmeFor(snapshotModel: HealthModel): string {
  const pinned: HealthModel = {
    ...snapshotModel,
    run: { ...snapshotModel.run!, runId: 999_999, sourceSha: SNAPSHOT_SHA },
  };
  const rendered = renderReadmeSection({
    repository: REPO,
    completedAt: '2026-11-24T10:00:00Z',
    verdict: 'VERIFIED_PASS',
    summary: 'SUMMARY_VERIFIED_ORIGIN',
    verdictSource: 'local-operator',
    preparedOn: '2026-11-24',
    maintenance: 'reviewed-automation-pr',
    model: pinned,
  });
  assert.ok(rendered.ok);
  return `# Title\n\n## Test Automation Health\n\n${SECTION_START}\n${rendered.section}${SECTION_END}\n\n## Next\n`;
}

function deps(w: World, readme: ReadmeReadResult): DryRunDeps & { reads: [string, number][] } {
  const reads: [string, number][] = [];
  return {
    transport: transport(w),
    readReadme: (path, max) => (reads.push([path, max]), readme),
    policies: POLICIES,
    reads,
  };
}

function historyWorld(sinceSnapshot: string[], sinceCandidate: string[] = []): World {
  const w = world();
  ancestry(w, SNAPSHOT_SHA, HEAD, 'head-is-ancestor');
  w.files.set(
    `${SNAPSHOT_SHA}...${HEAD}`,
    ok({
      files: sinceSnapshot.map((filename) => ({
        filename,
        previousFilename: null,
        status: 'modified',
      })),
      complete: true,
    }),
  );
  if (sinceCandidate.length > 0) {
    w.tip = MAIN_TIP;
    ancestry(w, HEAD, MAIN_TIP, 'head-is-ancestor');
    w.files.set(
      `${HEAD}...${MAIN_TIP}`,
      ok({
        files: sinceCandidate.map((filename) => ({
          filename,
          previousFilename: null,
          status: 'modified',
        })),
        complete: true,
      }),
    );
  }
  return w;
}

async function dryRun(w: World, readme: ReadmeReadResult) {
  const d = deps(w, readme);
  const args = parseDryRunArgs(ARGS);
  assert.ok(args);
  return { report: await runReadmeDryRun(args, d), d };
}

test('dry run: a test-affecting change proposes a labelled section and writes nothing', async () => {
  const w = historyWorld(['src/reporting/x.ts']);
  const { report, d } = await dryRun(w, { status: 'ok', text: readmeFor(healthBundle().model) });
  assert.equal(report.kind, 'readme-health-dry-run');
  assert.equal(report.dryRun, true);
  assert.equal(report.action, 'refresh');
  assert.deepEqual(report.reasons, ['test-affecting-change-since-snapshot']);
  assert.equal(report.metrics, 'same');
  assert.ok(report.proposedSection?.includes(HEAD));
  assert.ok(report.proposedSection?.includes('<!-- test-health-metrics: sha256:'));
  assert.ok(report.proposedSection?.includes('refreshed by reviewed pull request'));
  assert.deepEqual(d.reads, [['README.md', 256 * 1024]], 'the README is only read, once, bounded');
});

test('dry run: identical metrics after a docs-only change are a no-op without a proposal', async () => {
  const w = historyWorld(['README.md']);
  const { report } = await dryRun(w, { status: 'ok', text: readmeFor(healthBundle().model) });
  assert.equal(report.action, 'no-op');
  assert.deepEqual(report.reasons, ['documentation-only-no-substantive-change']);
  assert.equal(report.proposedSection, null);
});

test('dry run: invalid or unreadable READMEs block; nothing is guessed', async () => {
  const cases: ReadmeReadResult[] = [
    { status: 'too-large' },
    { status: 'missing' },
    { status: 'not-utf8' },
    { status: 'ok', text: 'no markers here\n' },
    { status: 'ok', text: `${SECTION_START}\nno pin\n${SECTION_END}\n` },
  ];
  for (const readme of cases) {
    const { report } = await dryRun(historyWorld(['src/x.ts']), readme);
    assert.equal(report.action, 'blocked', JSON.stringify(readme));
    assert.deepEqual(report.reasons, ['snapshot-pin-unreadable']);
    assert.equal(report.proposedSection, null);
  }
});

test('dry run: unknown or incomplete history blocks publication', async () => {
  const readme = { status: 'ok' as const, text: readmeFor(healthBundle().model) };
  const unknown = await dryRun(world(), readme); // no comparison registered
  assert.equal(unknown.report.action, 'blocked');
  assert.deepEqual(unknown.report.reasons, ['ancestry-unknown']);

  const truncated = historyWorld([]);
  truncated.files.set(`${SNAPSHOT_SHA}...${HEAD}`, ok({ files: [], complete: false }));
  const t = await dryRun(truncated, readme);
  assert.equal(t.report.action, 'blocked');
  assert.deepEqual(t.report.reasons, ['changes-since-snapshot-unavailable']);

  const unknownImpact = await dryRun(historyWorld(['README.md'], ['.nvmrc']), readme);
  assert.deepEqual(unknownImpact.report.reasons, ['unknown-impact-since-candidate']);
});

test('dry run: failed or partial evidence keeps explicit reasons and proposes nothing', async () => {
  const readme = { status: 'ok' as const, text: readmeFor(healthBundle().model) };
  const missing = historyWorld(['src/x.ts']);
  missing.artifacts = missing.artifacts.filter((a) => a.name !== 'test-health-1');
  const r1 = await dryRun(missing, readme);
  assert.equal(r1.report.action, 'skip');
  assert.deepEqual(r1.report.reasons, ['health-bundle-unavailable']);
  assert.equal(r1.report.proposedSection, null);

  const failing = historyWorld(['src/x.ts']);
  failing.jobs[0] = {
    ...(failing.jobs[0] as JobEvidence),
    conclusion: 'failure',
    steps: [{ number: 9, name: 'Gate', status: 'completed', conclusion: 'failure' }],
  };
  failing.run = { ...failing.run, conclusion: 'failure' };
  const r2 = await dryRun(failing, readme);
  assert.notEqual(r2.report.action, 'refresh');
  assert.ok(
    r2.report.reasons.some((reason) => reason.startsWith('verdict-')),
    r2.report.reasons.join(','),
  );
  assert.equal(r2.report.proposedSection, null);

  const pr = historyWorld(['src/x.ts']);
  pr.run = { ...pr.run, event: 'pull_request' };
  const r3 = await dryRun(pr, readme);
  assert.equal(r3.report.action, 'skip');
  assert.deepEqual(r3.report.reasons, ['not-push-event']);
  noDownloads(pr);
});

test('dry run: the report leaks no token, signed URL, path or per-test content', async () => {
  const w = historyWorld(['src/x.ts']);
  const { report } = await dryRun(w, { status: 'ok', text: readmeFor(healthBundle().model) });
  const text = serializeDryRunReport(report);
  for (const canary of [
    TOKEN_CANARY,
    SIGNED_URL_CANARY,
    TITLE_CANARY,
    'blob.core.windows.net',
    '/home/runner',
    'ui/dashboard.spec.ts',
    'tests/',
  ]) {
    assert.ok(!text.includes(canary), canary);
  }
  assert.ok(text.startsWith('{\n  "kind": "readme-health-dry-run",\n  "dryRun": true,'));
});

test('dry run: the proposal carries the candidate metric identity digest', async () => {
  const w = historyWorld(['src/x.ts']);
  const { report } = await dryRun(w, { status: 'ok', text: readmeFor(healthBundle().model) });
  const digest = metricsDigest(
    metricIdentity(healthBundle().model, {
      verdict: 'VERIFIED_PASS',
      summary: 'SUMMARY_VERIFIED_ORIGIN',
    }),
  );
  assert.ok(report.proposedSection?.includes(digest));
});

/* ------------------------------------------------------------------ *
 * Report sanitization and the README adapter
 * ------------------------------------------------------------------ */

test('dry run: arbitrary remote metadata text never reaches the serialized report', async () => {
  const canary = 'REMOTE<script>CANARY\n"injected": true';
  const w = historyWorld(['src/x.ts']);
  w.run = {
    ...w.run,
    headSha: canary,
    headBranch: canary,
    event: canary,
    path: canary,
    status: canary,
    name: canary,
    repository: { id: REPO_ID, fullName: canary },
    headRepository: { fullName: canary },
  };
  const { report } = await dryRun(w, { status: 'ok', text: readmeFor(healthBundle().model) });
  assert.equal(report.action, 'skip');
  assert.equal(report.candidate.sourceSha, null);
  const text = serializeDryRunReport(report);
  assert.ok(!text.includes('CANARY'), text);
  assert.ok(!text.includes('<script>'));
  noDownloads(w);
});

test('dry run: sourceSha is a validated lowercase SHA or null on every path', async () => {
  const readme = { status: 'ok' as const, text: readmeFor(healthBundle().model) };
  const upper = historyWorld(['src/x.ts']);
  upper.run = { ...upper.run, headSha: HEAD.toUpperCase(), event: 'pull_request' };
  assert.equal((await dryRun(upper, readme)).report.candidate.sourceSha, null);
  const short = historyWorld(['src/x.ts']);
  short.run = { ...short.run, headSha: HEAD.slice(0, 39) };
  assert.equal((await dryRun(short, readme)).report.candidate.sourceSha, null);
  const good = (await dryRun(historyWorld(['src/x.ts']), readme)).report.candidate.sourceSha;
  assert.equal(good, HEAD);
});

test('the README adapter reads regular UTF-8 files only, bounded and without following links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readme-dry-run-'));
  try {
    const file = join(dir, 'README.md');
    writeFileSync(file, 'hello\n');
    assert.deepEqual(nodeReadReadme(file, 1024), { status: 'ok', text: 'hello\n' });
    assert.deepEqual(nodeReadReadme(file, 3), { status: 'too-large' });
    const link = join(dir, 'link.md');
    symlinkSync(file, link);
    assert.deepEqual(nodeReadReadme(link, 1024), { status: 'unsafe' });
    assert.deepEqual(nodeReadReadme(dir, 1024), { status: 'unsafe' });
    assert.deepEqual(nodeReadReadme(join(dir, 'absent.md'), 1024), { status: 'missing' });
    const binary = join(dir, 'binary.md');
    writeFileSync(binary, Uint8Array.from([0xff, 0xfe]));
    assert.deepEqual(nodeReadReadme(binary, 1024), { status: 'not-utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Report re-validation and the workflow summary (C5C)
 * ------------------------------------------------------------------ */

test('a serialized report round-trips through the strict parser', async () => {
  const { report } = await dryRun(historyWorld(['src/x.ts']), {
    status: 'ok',
    text: readmeFor(healthBundle().model),
  });
  assert.deepEqual(parseDryRunReport(serializeDryRunReport(report)), report);
});

test('malformed, unlabelled or widened reports are rejected', async () => {
  const { report } = await dryRun(historyWorld(['src/x.ts']), {
    status: 'ok',
    text: readmeFor(healthBundle().model),
  });
  const base = JSON.parse(serializeDryRunReport(report)) as Record<string, unknown>;
  const variants: Record<string, unknown>[] = [
    { ...base, dryRun: false },
    { ...base, kind: 'other' },
    { ...base, action: 'publish' },
    { ...base, metrics: 'maybe' },
    { ...base, reasons: ['made-up-reason'] },
    { ...base, diagnostics: ['Not A Code'] },
    { ...base, diagnostics: ['$(rm -rf /)'] },
    { ...base, extra: true },
    { ...base, candidate: { runId: 1, runAttempt: 1, sourceSha: 'ABC' } },
    { ...base, candidate: { runId: 0, runAttempt: 1, sourceSha: null } },
    { ...base, action: 'skip' }, // a proposed section only belongs to a refresh
  ];
  for (const variant of variants) {
    assert.equal(
      parseDryRunReport(JSON.stringify(variant)),
      undefined,
      JSON.stringify(variant).slice(0, 90),
    );
  }
  assert.equal(parseDryRunReport('not json'), undefined);
});

test('the summary is labelled, separates execution from eligibility and fences the proposal', async () => {
  const refresh = (
    await dryRun(historyWorld(['src/x.ts']), {
      status: 'ok',
      text: readmeFor(healthBundle().model),
    })
  ).report;
  const summary = renderDryRunSummary(refresh);
  assert.ok(summary.startsWith('## README health dry run\n'));
  assert.ok(summary.includes('**Dry run only.** Nothing was written'));
  assert.ok(summary.includes('| Dry-run command | completed; report produced |'));
  assert.ok(summary.includes('| Eligible for a refresh pull request | yes |'));
  assert.ok(summary.includes('~~~~text\n'));
  assert.ok(summary.trimEnd().endsWith('~~~~'));

  const skip = (
    await dryRun(
      (() => {
        const w = historyWorld(['src/x.ts']);
        w.run = { ...w.run, event: 'pull_request' };
        return w;
      })(),
      { status: 'ok', text: readmeFor(healthBundle().model) },
    )
  ).report;
  const skipped = renderDryRunSummary(skip);
  assert.ok(skipped.includes('| Decision | `skip` |'));
  assert.ok(skipped.includes('| Eligible for a refresh pull request | no |'));
  assert.ok(skipped.includes('`not-push-event`'));
  assert.ok(!skipped.includes('~~~~'));

  const fenced = renderDryRunSummary({ ...refresh, proposedSection: 'x\n~~~\ny\n' });
  assert.ok(fenced.includes('withheld'));
  assert.ok(!fenced.includes('~~~~text'));
});

test('report parsing is bounded, uses the exact diagnostic set and enforces proposal rules', async () => {
  const { report } = await dryRun(historyWorld(['src/x.ts']), {
    status: 'ok',
    text: readmeFor(healthBundle().model),
  });
  assert.equal(report.action, 'refresh');
  const base = JSON.parse(serializeDryRunReport(report)) as Record<string, unknown>;
  const reject = (variant: Record<string, unknown> | string, label: string): void => {
    const text = typeof variant === 'string' ? variant : JSON.stringify(variant);
    assert.equal(parseDryRunReport(text), undefined, label);
  };

  // Oversized: refused before JSON.parse, even though it would otherwise parse.
  const oversized = JSON.stringify({ ...base, proposedSection: 'x'.repeat(MAX_REPORT_BYTES) });
  assert.ok(Buffer.byteLength(oversized) > MAX_REPORT_BYTES);
  reject(oversized, 'oversized report');
  reject(' '.repeat(MAX_REPORT_BYTES + 1), 'oversized whitespace');

  // Unknown but code-shaped diagnostics are rejected; known ones pass.
  reject({ ...base, diagnostics: ['made-up-code'] }, 'unknown code-shaped diagnostic');
  reject({ ...base, diagnostics: ['unit-artifact-vanished'] }, 'unknown artifact diagnostic');
  assert.ok(
    parseDryRunReport(
      JSON.stringify({
        ...base,
        diagnostics: [
          'health-artifact-digest-mismatch',
          'main-tip-unavailable',
          'readme-unreadable',
        ],
      }),
    ),
  );

  // A refresh needs a validated SHA and a non-empty proposal.
  const candidate = base.candidate as Record<string, unknown>;
  reject({ ...base, candidate: { ...candidate, sourceSha: null } }, 'refresh without SHA');
  reject({ ...base, proposedSection: '' }, 'refresh with an empty proposal');
  reject({ ...base, proposedSection: null }, 'refresh without a proposal');

  // Every other action has a null proposal.
  for (const action of ['no-op', 'skip', 'blocked']) {
    reject({ ...base, action, proposedSection: 'section\n' }, `${action} with a proposal`);
    assert.ok(
      parseDryRunReport(JSON.stringify({ ...base, action, proposedSection: null })),
      action,
    );
  }
});

test('the runtime diagnostic lists cover every defined code exactly once', () => {
  // Compile-time: no EvidenceDiagnostic or HistoryDiagnostic is missing from the lists.
  type MissingEvidence = Exclude<EvidenceDiagnostic, (typeof EVIDENCE_DIAGNOSTIC_CODES)[number]>;
  type MissingHistory = Exclude<HistoryDiagnostic, (typeof HISTORY_DIAGNOSTIC_CODES)[number]>;
  const evidenceComplete: [MissingEvidence] extends [never] ? true : false = true;
  const historyComplete: [MissingHistory] extends [never] ? true : false = true;
  assert.ok(evidenceComplete && historyComplete);
  // Run time: no duplicates.
  assert.equal(new Set(EVIDENCE_DIAGNOSTIC_CODES).size, EVIDENCE_DIAGNOSTIC_CODES.length);
  assert.equal(EVIDENCE_DIAGNOSTIC_CODES.length, 2 * 13 + 11);
  assert.equal(new Set(HISTORY_DIAGNOSTIC_CODES).size, HISTORY_DIAGNOSTIC_CODES.length);
});
