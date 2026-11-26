/**
 * Unit tests for the local quality-verdict operator (ADR-0010, M8E-4).
 *
 * Same conventions as the other unit tests (ADR-0002). Every response is
 * synthetic and shaped like the GitHub REST API responses observed in the
 * M8E audit and the Phase 2A experiment; HTTP and the filesystem are
 * in-memory fakes. No network, no real credentials, no live GitHub data.
 * The token and the signed storage URL below are canaries: tests assert
 * they never appear in any output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';

import type { FileInfo, FsAdapter, WriteOutcome } from './quality-summary-cli.ts';
import { GATE_INPUT_NAMES, normalize, serialize } from './quality-summary.ts';
import { CANARY, SYNTHETIC_SHA, context, twelveEighteenNineteen } from './fixtures.ts';
import {
  API_ORIGIN,
  MAX_PAGES,
  bundleFileName,
  classifyStatus,
  createTransport,
  parseVerdictArgs,
  resultMessage,
  runVerdict,
  sha256Digest,
  storageTarget,
  type BaseTrustPolicy,
  type HttpAdapter,
  type HttpRequest,
  type HttpResult,
  type ResponseHeaders,
  type VerdictBundle,
  type VerdictCliResult,
} from './verdict-cli.ts';
import { crc32, ENTRY_NAME } from './zip-entry.ts';

/* ------------------------------------------------------------------ *
 * Synthetic identity
 * ------------------------------------------------------------------ */

const REPO_ID = 900_000_001;
const REPO = 'example-owner/example-repo';
const WORKFLOW_ID = 800_000_001;
const RUN_ID = 1_000_001; // matches fixtures.context()
const ATTEMPT = 1;
const HEAD = SYNTHETIC_SHA;
const MAIN_TIP = 'fedcba9876543210fedcba9876543210fedcba98';
const OTHER_SHA = '1111111111111111111111111111111111111111';
const ARTIFACT_ID = 700_000_001;
const TEST_JOB_ID = 600_000_001;

const POLICY: BaseTrustPolicy = Object.freeze({
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
});

/** Canary secrets: must never appear in any output. */
const TOKEN = `ghp_TOKENCANARY${'7'.repeat(24)}`;
const SIGNATURE = 'SIGNEDURLCANARY9f8e7d';
const SIGNED_URL = `https://productionresultssa11.blob.core.windows.net/actions-results/abc/quality-summary-1.zip?sv=2025&se=2026-11-26&sig=${SIGNATURE}`;
const STORAGE_HOSTNAME = 'productionresultssa11.blob.core.windows.net';

const OUT_DIR = '/operator/out';
const REPO_ROOT = '/work/repo';

const enc = new TextEncoder();

/* ------------------------------------------------------------------ *
 * Synthetic archives (stored entries)
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

interface StoredEntry {
  name?: string;
  content: Uint8Array;
  mode?: number;
  crc?: number;
}

function storedZip(entries: StoredEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name ?? ENTRY_NAME);
    const crc = e.crc ?? crc32(e.content);
    const size = e.content.length;
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(size),
      u32(size),
      u16(name.length),
      u16(0),
      name,
      e.content,
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
        u32(size),
        u32(size),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(((e.mode ?? 0o100644) << 16) >>> 0),
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

function summaryText(overrides: Record<string, unknown> = {}): string {
  return serialize(normalize(twelveEighteenNineteen(), context(overrides)));
}

function summaryZip(overrides: Record<string, unknown> = {}): Uint8Array {
  return storedZip([{ content: enc.encode(summaryText(overrides)) }]);
}

/* ------------------------------------------------------------------ *
 * Synthetic GitHub API
 * ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function step(number: number, name: string, conclusion: string | null = 'success'): Json {
  return { number, name, status: 'completed', conclusion, started_at: CANARY };
}

interface World {
  run: Json;
  jobs: Json[];
  artifacts: Json[];
  tip: string;
  compare: Json;
  archive: Uint8Array;
  location: string | null;
  /** Return a response for a URL to replace the default routing. */
  override?: (url: string) => HttpResult | undefined;
  /** Page size the fake serves (the client always asks for 100). */
  pageSize: number;
}

function world(): World {
  const archive = summaryZip();
  return {
    run: {
      id: RUN_ID,
      run_attempt: ATTEMPT,
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      head_sha: HEAD,
      head_branch: 'main',
      workflow_id: WORKFLOW_ID,
      path: '.github/workflows/tests.yml',
      name: 'Playwright UI Tests',
      display_title: `commit message ${CANARY}`,
      html_url: `https://github.com/${REPO}/actions/runs/${String(RUN_ID)}?${CANARY}`,
      repository: { id: REPO_ID, full_name: REPO, description: CANARY },
      head_repository: { id: REPO_ID, full_name: REPO },
      head_commit: { message: CANARY, author: { email: `${CANARY}@example.invalid` } },
      run_started_at: '2026-11-25T00:00:00Z',
      updated_at: '2026-11-25T01:00:00Z',
    },
    jobs: [
      {
        id: TEST_JOB_ID,
        name: 'test',
        run_attempt: ATTEMPT,
        head_sha: HEAD,
        status: 'completed',
        conclusion: 'success',
        runner_name: CANARY,
        steps: [step(1, 'Set up job'), step(2, `Run tests ${CANARY}`), step(9, 'Gate')],
      },
      {
        id: TEST_JOB_ID + 1,
        name: 'checks',
        run_attempt: ATTEMPT,
        head_sha: HEAD,
        status: 'completed',
        conclusion: 'success',
        steps: [step(1, 'Lint')],
      },
    ],
    artifacts: [
      {
        id: ARTIFACT_ID - 1,
        name: 'blob-report-1',
        size_in_bytes: 1234,
        digest: `sha256:${'a'.repeat(64)}`,
        created_at: '2026-11-25T00:20:00Z',
        expires_at: '2026-12-02T00:20:00Z',
        expired: false,
        workflow_run: {
          id: RUN_ID,
          repository_id: REPO_ID,
          head_repository_id: REPO_ID,
          head_branch: 'main',
          head_sha: HEAD,
        },
      },
      {
        id: ARTIFACT_ID,
        name: 'quality-summary-1',
        size_in_bytes: archive.length,
        digest: sha256Digest(archive),
        created_at: '2026-11-25T00:30:00Z',
        expires_at: '2026-12-02T00:30:00Z',
        expired: false,
        archive_download_url: `${API_ORIGIN}/repos/${REPO}/actions/artifacts/${String(ARTIFACT_ID)}/zip?${CANARY}`,
        workflow_run: {
          id: RUN_ID,
          repository_id: REPO_ID,
          head_repository_id: REPO_ID,
          head_branch: 'main',
          head_sha: HEAD,
        },
      },
    ],
    tip: HEAD,
    compare: {
      status: 'identical',
      base_commit: { sha: HEAD },
      merge_base_commit: { sha: HEAD },
      files: [{ patch: CANARY }],
    },
    archive,
    location: SIGNED_URL,
    pageSize: 100,
  };
}

/** Serves `bytes` as the archive and updates the summary artifact's size and digest to match. */
function serve(w: World, bytes: Uint8Array): void {
  w.archive = bytes;
  const a = summaryArtifact(w);
  a.size_in_bytes = bytes.length;
  a.digest = sha256Digest(bytes);
}

function summaryArtifact(w: World): Json {
  const a = w.artifacts.find((x) => x.name === 'quality-summary-1');
  assert.ok(a);
  return a;
}
function testJob(w: World): Json {
  const j = w.jobs.find((x) => x.name === 'test');
  assert.ok(j);
  return j;
}
function gateStep(w: World): Json {
  const steps = testJob(w).steps as Json[];
  const g = steps.find((s) => s.name === 'Gate');
  assert.ok(g);
  return g;
}

const NO_HEADERS: ResponseHeaders = { location: null, rateLimitRemaining: null, retryAfter: null };

function json(status: number, body: unknown, headers: Partial<ResponseHeaders> = {}): HttpResult {
  return {
    kind: 'response',
    status,
    headers: { ...NO_HEADERS, ...headers },
    body: enc.encode(JSON.stringify(body)),
  };
}

function errorBody(status: number, headers: Partial<ResponseHeaders> = {}): HttpResult {
  return json(status, { message: `error ${CANARY}`, documentation_url: CANARY }, headers);
}

function page(list: Json[], key: string, url: URL, size: number): HttpResult {
  const n = Number(url.searchParams.get('page'));
  assert.equal(url.searchParams.get('per_page'), '100');
  return json(200, { total_count: list.length, [key]: list.slice((n - 1) * size, n * size) });
}

interface Recorder {
  readonly requests: HttpRequest[];
  readonly http: HttpAdapter;
}

function fakeHttp(w: World): Recorder {
  const requests: HttpRequest[] = [];
  const base = `${API_ORIGIN}/repos/${REPO}`;
  const http: HttpAdapter = {
    get: (request) => {
      requests.push(request);
      const overridden = w.override?.(request.url);
      if (overridden !== undefined) return Promise.resolve(overridden);
      const url = new URL(request.url);
      const path = `${url.origin}${url.pathname}`;
      let r: HttpResult;
      if (url.hostname.endsWith('.blob.core.windows.net')) {
        r = { kind: 'response', status: 200, headers: NO_HEADERS, body: w.archive };
      } else if (path === `${base}/actions/runs/${String(RUN_ID)}/attempts/${String(ATTEMPT)}`) {
        r = json(200, w.run);
      } else if (
        path === `${base}/actions/runs/${String(RUN_ID)}/attempts/${String(ATTEMPT)}/jobs`
      ) {
        r = page(w.jobs, 'jobs', url, w.pageSize);
      } else if (path === `${base}/actions/runs/${String(RUN_ID)}/artifacts`) {
        r = page(w.artifacts, 'artifacts', url, w.pageSize);
      } else if (path === `${base}/git/ref/heads/main`) {
        r = json(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: w.tip } });
      } else if (path === `${base}/compare/${HEAD}...${w.tip}`) {
        r = json(200, w.compare);
      } else if (path.startsWith(`${base}/actions/artifacts/`) && path.endsWith('/zip')) {
        r = {
          kind: 'response',
          status: 302,
          headers: { ...NO_HEADERS, location: w.location },
          body: new Uint8Array(0),
        };
      } else {
        r = errorBody(404);
      }
      return Promise.resolve(r);
    },
  };
  return { requests, http };
}

/* ------------------------------------------------------------------ *
 * In-memory filesystem
 * ------------------------------------------------------------------ */

interface Node {
  kind: 'file' | 'directory' | 'symlink';
  data?: string;
  target?: string;
  id: number;
}

interface MemFs extends FsAdapter {
  readonly nodes: Map<string, Node>;
  /** File names (basenames) whose first exclusive create reports `exists`. */
  readonly collide: Set<string>;
  mutations: number;
}

function memFs(): MemFs {
  let next = 1;
  const nodes = new Map<string, Node>();
  const add = (path: string, node: Omit<Node, 'id'>): void => {
    nodes.set(path, { ...node, id: next++ });
  };
  for (const dir of ['/', '/operator', OUT_DIR, '/work', REPO_ROOT, `${REPO_ROOT}/out`]) {
    add(dir, { kind: 'directory' });
  }
  add('/operator/link-to-repo', { kind: 'symlink', target: `${REPO_ROOT}/out` });
  add('/operator/alias', { kind: 'symlink', target: OUT_DIR });
  add('/operator/not-a-dir', { kind: 'file', data: '' });

  function real(path: string): string {
    const parts = path.split('/').filter((p) => p !== '');
    let current = '/';
    for (let i = 0; i < parts.length; i++) {
      const candidate = join(current, parts[i] as string);
      const node = nodes.get(candidate);
      if (node === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      current = node.kind === 'symlink' ? real(node.target as string) : candidate;
    }
    return current;
  }
  function locate(path: string): string | undefined {
    try {
      return join(real(dirname(path)), basename(path));
    } catch {
      return undefined;
    }
  }

  const fs: MemFs = {
    nodes,
    collide: new Set<string>(),
    mutations: 0,
    lstat: (path): FileInfo | undefined => {
      if (path === '/') return { kind: 'directory', size: 0 };
      const at = locate(path);
      const node = at === undefined ? undefined : nodes.get(at);
      return node === undefined ? undefined : { kind: node.kind, size: node.data?.length ?? 0 };
    },
    realpath: (path) => real(path),
    identity: (path) => {
      try {
        const node = nodes.get(real(path));
        return node === undefined ? undefined : String(node.id);
      } catch {
        return undefined;
      }
    },
    readNoFollow: () => ({ status: 'unreadable' }),
    mkdir: (path) => {
      fs.mutations++;
      add(path, { kind: 'directory' });
    },
    writeNew: (path, data): WriteOutcome => {
      const name = basename(path);
      for (const prefix of fs.collide) {
        if (name.includes(prefix)) {
          fs.collide.delete(prefix);
          return { status: 'exists' };
        }
      }
      const at = locate(path);
      if (at === undefined) return { status: 'failed' };
      if (nodes.has(at)) return { status: 'exists' };
      fs.mutations++;
      add(at, { kind: 'file', data });
      return { status: 'ok', identity: String((nodes.get(at) as Node).id) };
    },
    rename: (from, to) => {
      fs.mutations++;
      const node = nodes.get(from);
      if (node === undefined) throw new Error('ENOENT');
      nodes.delete(from);
      nodes.set(to, node);
    },
    remove: (path) => {
      fs.mutations++;
      nodes.delete(path);
    },
  };
  return fs;
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

interface Outcome {
  readonly result: VerdictCliResult;
  readonly message: string;
  readonly bundle: VerdictBundle | undefined;
  readonly text: string | undefined;
  readonly requests: HttpRequest[];
  readonly fs: MemFs;
}

interface RunOptions {
  token?: string | undefined;
  outputDir?: string;
  fs?: MemFs;
  policy?: BaseTrustPolicy;
  randomId?: () => string;
}

let counter = 0;
function defaultRandomId(): string {
  counter++;
  return `temp-${String(counter).padStart(16, '0')}`;
}

async function execute(w: World, options: RunOptions = {}): Promise<Outcome> {
  const fs = options.fs ?? memFs();
  const { requests, http } = fakeHttp(w);
  const result = await runVerdict(
    { runId: RUN_ID, runAttempt: ATTEMPT, outputDir: options.outputDir ?? OUT_DIR },
    {
      token: 'token' in options ? options.token : TOKEN,
      http,
      fs,
      repoRoot: REPO_ROOT,
      randomId: options.randomId ?? defaultRandomId,
      policy: options.policy ?? POLICY,
    },
  );
  const file = fs.nodes.get(join(OUT_DIR, bundleFileName(RUN_ID, ATTEMPT)));
  // Only a bundle this run wrote is parsed; pre-existing files are left alone.
  const text = result.code === 'written' ? file?.data : undefined;
  return {
    result,
    message: resultMessage(result),
    bundle: text === undefined ? undefined : (JSON.parse(text) as VerdictBundle),
    text,
    requests,
    fs,
  };
}

async function bundleOf(w: World): Promise<VerdictBundle> {
  const o = await execute(w);
  assert.equal(o.result.code, 'written', o.message);
  assert.ok(o.bundle);
  return o.bundle;
}

function storageRequests(requests: readonly HttpRequest[]): HttpRequest[] {
  return requests.filter((r) => !r.url.startsWith(`${API_ORIGIN}/`));
}
function zipRequests(requests: readonly HttpRequest[]): HttpRequest[] {
  return requests.filter((r) => r.url.endsWith('/zip'));
}

function assertNoSecrets(o: Outcome): void {
  const outputs = [o.text ?? '', o.message, JSON.stringify(o.result)];
  for (const out of outputs) {
    for (const secret of [TOKEN, 'TOKENCANARY', SIGNATURE, SIGNED_URL, STORAGE_HOSTNAME, CANARY]) {
      assert.equal(out.includes(secret), false, `output leaked ${secret}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Successful trusted run
 * ------------------------------------------------------------------ */

test('a verified main run produces VERIFIED_PASS with verified-origin metrics', async () => {
  const o = await execute(world());
  assert.equal(o.result.exitCode, 0);
  assert.equal(o.result.code, 'written');
  assert.equal(o.result.verdict, 'VERIFIED_PASS');
  assert.equal(o.result.summary, 'SUMMARY_VERIFIED_ORIGIN');
  const b = o.bundle;
  assert.ok(b);
  assert.equal(b.bundleSchemaVersion, '1.0.0');
  assert.equal(b.kind, 'quality-verdict-bundle');
  assert.deepEqual(b.verdict, { state: 'VERIFIED_PASS', reasons: ['gate-success'] });
  assert.deepEqual(b.summary, {
    state: 'SUMMARY_VERIFIED_ORIGIN',
    reasons: ['verified-origin'],
    metricsAvailable: true,
    label: 'verified-origin',
  });
  assert.deepEqual(b.identity, {
    runId: RUN_ID,
    runAttempt: ATTEMPT,
    headSha: HEAD,
    event: 'push',
    testJobId: TEST_JOB_ID,
    artifactId: ARTIFACT_ID,
  });
  assert.deepEqual(b.artifact, { id: ARTIFACT_ID, digest: 'verified' });
  assert.deepEqual(b.request, { runId: RUN_ID, runAttempt: ATTEMPT });
  assert.equal(b.policy.repositoryFullName, REPO);
  assert.ok(b.metrics);
  assert.equal(b.metrics.summarySchemaVersion, '1.0.0');
  assert.ok(b.metrics.totals !== null && typeof b.metrics.totals === 'object');
  assert.equal(o.message.includes('VERIFIED_PASS'), true);
  assertNoSecrets(o);
});

test('the bundle has exactly the allow-listed top-level fields', async () => {
  const b = await bundleOf(world());
  assert.deepEqual(Object.keys(b), [
    'bundleSchemaVersion',
    'kind',
    'policy',
    'request',
    'identity',
    'verdict',
    'summary',
    'artifact',
    'metrics',
  ]);
  assert.deepEqual(Object.keys(b.metrics ?? {}), [
    'summarySchemaVersion',
    'totals',
    'completeness',
  ]);
});

test('the six read-only operations are each requested once with GET to api.github.com', async () => {
  const o = await execute(world());
  const api = o.requests.filter((r) => r.url.startsWith(`${API_ORIGIN}/`));
  const paths = api.map((r) => new URL(r.url).pathname);
  const base = `/repos/${REPO}`;
  assert.deepEqual(paths, [
    `${base}/actions/runs/${String(RUN_ID)}/attempts/1`,
    `${base}/actions/runs/${String(RUN_ID)}/attempts/1/jobs`,
    `${base}/git/ref/heads/main`,
    `${base}/compare/${HEAD}...${HEAD}`,
    `${base}/actions/runs/${String(RUN_ID)}/artifacts`,
    `${base}/actions/artifacts/${String(ARTIFACT_ID)}/zip`,
  ]);
  for (const r of api) {
    assert.equal(r.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(r.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(r.headers.Accept, 'application/vnd.github+json');
    assert.ok(r.timeoutMs > 0 && r.maxBytes >= 0);
  }
  assert.equal(storageRequests(o.requests).length, 1);
});

test('an ancestor of the main tip is accepted as on main', async () => {
  const w = world();
  w.tip = MAIN_TIP;
  w.compare = { status: 'ahead', base_commit: { sha: HEAD }, merge_base_commit: { sha: HEAD } };
  assert.equal((await bundleOf(w)).verdict.state, 'VERIFIED_PASS');
});

test('output is deterministic for equal evidence', async () => {
  const a = await execute(world());
  const b = await execute(world());
  assert.ok(a.text);
  assert.equal(a.text, b.text);
});

/* ------------------------------------------------------------------ *
 * Gate verdicts
 * ------------------------------------------------------------------ */

test('a completed failed Gate is VERIFIED_FAIL', async () => {
  const w = world();
  w.run.conclusion = 'failure';
  testJob(w).conclusion = 'failure';
  gateStep(w).conclusion = 'failure';
  const gates = Object.fromEntries(GATE_INPUT_NAMES.map((n) => [n, 'success']));
  serve(w, summaryZip({ gateInputs: { ...gates, VERIFY: 'failure' } }));
  const b = await bundleOf(w);
  assert.deepEqual(b.verdict, { state: 'VERIFIED_FAIL', reasons: ['gate-failure'] });
  assert.equal(b.summary.state, 'SUMMARY_VERIFIED_ORIGIN');
  assert.equal(b.summary.metricsAvailable, false);
  assert.equal(b.metrics, null);
});

test('a pull-request run is UNTRUSTED_PROVENANCE and never verified-origin', async () => {
  const w = world();
  w.run.event = 'pull_request';
  w.run.head_branch = 'feature/x';
  const b = await bundleOf(w);
  assert.equal(b.verdict.state, 'UNTRUSTED_PROVENANCE');
  assert.deepEqual(b.verdict.reasons, ['provenance-branch', 'provenance-event']);
  assert.notEqual(b.summary.label, 'verified-origin');
});

test('a head commit that diverged from main is UNTRUSTED_PROVENANCE', async () => {
  const w = world();
  w.tip = MAIN_TIP;
  w.compare = {
    status: 'diverged',
    base_commit: { sha: HEAD },
    merge_base_commit: { sha: OTHER_SHA },
  };
  const b = await bundleOf(w);
  assert.deepEqual(b.verdict, {
    state: 'UNTRUSTED_PROVENANCE',
    reasons: ['provenance-diverged-from-main'],
  });
  assert.equal(b.summary.state, 'SUMMARY_INFORMATIVE');
  assert.equal(b.summary.label, 'unverified-origin');
});

test('a head commit ahead of main is UNTRUSTED_PROVENANCE', async () => {
  const w = world();
  w.tip = MAIN_TIP;
  w.compare = {
    status: 'behind',
    base_commit: { sha: HEAD },
    merge_base_commit: { sha: MAIN_TIP },
  };
  assert.deepEqual((await bundleOf(w)).verdict.reasons, ['provenance-head-ahead-of-main']);
});

test('an inconsistent comparison is malformed ancestry, never trust', async () => {
  const w = world();
  w.tip = MAIN_TIP;
  // Claims "ahead" but the merge base is not the evaluated commit.
  w.compare = {
    status: 'ahead',
    base_commit: { sha: HEAD },
    merge_base_commit: { sha: OTHER_SHA },
  };
  assert.deepEqual((await bundleOf(w)).verdict, {
    state: 'UNKNOWN',
    reasons: ['retrieval-ancestry-malformed'],
  });
});

test('a comparison against another base commit is malformed', async () => {
  const w = world();
  w.compare = { ...w.compare, base_commit: { sha: OTHER_SHA } };
  assert.deepEqual((await bundleOf(w)).verdict.reasons, ['retrieval-ancestry-malformed']);
});

test('a missing main tip leaves ancestry unretrieved: UNKNOWN', async () => {
  const w = world();
  w.override = (url) => (url.includes('/git/ref/heads/main') ? errorBody(404) : undefined);
  const o = await execute(w);
  assert.deepEqual(o.bundle?.verdict, {
    state: 'UNKNOWN',
    reasons: ['retrieval-ancestry-not-found'],
  });
  assert.equal(
    o.requests.some((r) => r.url.includes('/compare/')),
    false,
  );
});

test('a main ref that is not a commit is malformed ancestry', async () => {
  const w = world();
  w.override = (url) =>
    url.includes('/git/ref/heads/main')
      ? json(200, { ref: 'refs/heads/main', object: { type: 'tag', sha: HEAD } })
      : undefined;
  assert.deepEqual((await bundleOf(w)).verdict.reasons, ['retrieval-ancestry-malformed']);
});

test('a failed comparison request is UNKNOWN', async () => {
  const w = world();
  w.override = (url) => (url.includes('/compare/') ? errorBody(500) : undefined);
  assert.deepEqual((await bundleOf(w)).verdict.reasons, ['retrieval-ancestry-http-error']);
});

test('duplicate test jobs are CONFLICT', async () => {
  const w = world();
  w.jobs.push({ ...testJob(w), id: TEST_JOB_ID + 5 });
  assert.deepEqual((await bundleOf(w)).verdict, {
    state: 'CONFLICT',
    reasons: ['identity-duplicate-test-job'],
  });
});

test('duplicate Gate steps are CONFLICT', async () => {
  const w = world();
  (testJob(w).steps as Json[]).push(step(10, 'Gate'));
  assert.deepEqual((await bundleOf(w)).verdict.reasons, ['identity-duplicate-gate-step']);
});

test('a job from another attempt is CONFLICT', async () => {
  const w = world();
  w.jobs[1] = { ...(w.jobs[1] as Json), run_attempt: 2 };
  assert.deepEqual((await bundleOf(w)).verdict.reasons, ['identity-job-attempt-mismatch']);
});

test('a run attempt response for another attempt is CONFLICT', async () => {
  const w = world();
  w.run.run_attempt = 2;
  assert.equal((await bundleOf(w)).verdict.state, 'CONFLICT');
});

test('a job for another commit is CONFLICT', async () => {
  const w = world();
  testJob(w).head_sha = OTHER_SHA;
  assert.deepEqual((await bundleOf(w)).verdict.reasons, ['identity-job-sha-mismatch']);
});

test('a cancelled run is CANCELLED', async () => {
  const w = world();
  w.run.conclusion = 'cancelled';
  testJob(w).conclusion = 'cancelled';
  const b = await bundleOf(w);
  assert.deepEqual(b.verdict, { state: 'CANCELLED', reasons: ['job-cancelled', 'run-cancelled'] });
});

test('a pending run is PENDING and its summary only informative', async () => {
  const w = world();
  w.run.status = 'in_progress';
  w.run.conclusion = null;
  testJob(w).status = 'in_progress';
  testJob(w).conclusion = null;
  const b = await bundleOf(w);
  assert.deepEqual(b.verdict, { state: 'PENDING', reasons: ['run-not-completed'] });
  assert.equal(b.summary.state, 'SUMMARY_INFORMATIVE');
  assert.deepEqual(b.summary.reasons, ['verdict-not-trusted']);
});

test('a run on another workflow is UNTRUSTED_PROVENANCE', async () => {
  const w = world();
  w.run.workflow_id = WORKFLOW_ID + 1;
  w.run.path = '.github/workflows/other.yml';
  assert.deepEqual((await bundleOf(w)).verdict.reasons, [
    'provenance-workflow-id',
    'provenance-workflow-path',
  ]);
});

/* ------------------------------------------------------------------ *
 * Summary availability, independent of the verdict
 * ------------------------------------------------------------------ */

test('no summary artifact: verified Gate with unavailable summary, never zero metrics', async () => {
  const w = world();
  w.artifacts = w.artifacts.filter((a) => a.name !== 'quality-summary-1');
  const o = await execute(w);
  const b = o.bundle;
  assert.ok(b);
  assert.equal(b.verdict.state, 'VERIFIED_PASS');
  assert.deepEqual(b.summary, {
    state: 'SUMMARY_UNAVAILABLE',
    reasons: ['artifact-absent'],
    metricsAvailable: false,
    label: null,
  });
  assert.equal(b.metrics, null);
  assert.deepEqual(b.artifact, { id: null, digest: 'not-checked' });
  assert.equal(zipRequests(o.requests).length, 0);
});

test('an artifact from another run is SUMMARY_CONFLICT and is not downloaded', async () => {
  const w = world();
  (summaryArtifact(w).workflow_run as Json).id = RUN_ID + 1;
  const o = await execute(w);
  assert.equal(o.bundle?.verdict.state, 'VERIFIED_PASS');
  assert.deepEqual(o.bundle?.summary.reasons, ['artifact-run-mismatch']);
  assert.equal(o.bundle?.summary.state, 'SUMMARY_CONFLICT');
  assert.equal(zipRequests(o.requests).length, 0);
});

test('an artifact for another commit is not downloaded', async () => {
  const w = world();
  (summaryArtifact(w).workflow_run as Json).head_sha = OTHER_SHA;
  const o = await execute(w);
  assert.deepEqual(o.bundle?.summary.reasons, ['artifact-sha-mismatch']);
  assert.equal(zipRequests(o.requests).length, 0);
});

test('an artifact created outside the attempt window is SUMMARY_CONFLICT', async () => {
  const w = world();
  summaryArtifact(w).created_at = '2026-11-25T02:00:00Z';
  assert.deepEqual((await bundleOf(w)).summary.reasons, ['artifact-created-outside-attempt']);
});

test('duplicate summary artifacts are SUMMARY_CONFLICT and none is downloaded', async () => {
  const w = world();
  w.artifacts.push({ ...summaryArtifact(w), id: ARTIFACT_ID + 9 });
  const o = await execute(w);
  assert.deepEqual(o.bundle?.summary.reasons, ['artifact-duplicate']);
  assert.equal(zipRequests(o.requests).length, 0);
});

test('a digest mismatch is SUMMARY_CONFLICT, not parsed, and not retried', async () => {
  const w = world();
  w.archive = summaryZip({ headSha: OTHER_SHA }); // different bytes than the published digest
  const o = await execute(w);
  const b = o.bundle;
  assert.ok(b);
  assert.equal(b.verdict.state, 'VERIFIED_PASS');
  assert.deepEqual(b.summary, {
    state: 'SUMMARY_CONFLICT',
    reasons: ['digest-mismatch'],
    metricsAvailable: false,
    label: null,
  });
  assert.equal(b.artifact.digest, 'mismatch');
  assert.equal(b.metrics, null);
  assert.equal(zipRequests(o.requests).length, 1);
  assert.equal(storageRequests(o.requests).length, 1);
});

test('a null digest is never downloaded', async () => {
  const w = world();
  summaryArtifact(w).digest = null;
  const o = await execute(w);
  assert.deepEqual(o.bundle?.summary.reasons, ['archive-not-downloaded']);
  assert.equal(o.bundle?.artifact.digest, 'not-checked');
  assert.equal(zipRequests(o.requests).length, 0);
});

test('an absent digest field is treated as null', async () => {
  const w = world();
  delete summaryArtifact(w).digest;
  const o = await execute(w);
  assert.deepEqual(o.bundle?.summary.reasons, ['archive-not-downloaded']);
  assert.equal(zipRequests(o.requests).length, 0);
});

test('an unsupported digest format makes the artifact list malformed', async () => {
  const w = world();
  summaryArtifact(w).digest = `sha1:${'a'.repeat(40)}`;
  const o = await execute(w);
  assert.deepEqual(o.bundle?.summary.reasons, ['retrieval-artifacts-malformed']);
  assert.equal(zipRequests(o.requests).length, 0);
});

test('an expired artifact is unavailable and never downloaded', async () => {
  const w = world();
  summaryArtifact(w).expired = true;
  const o = await execute(w);
  assert.deepEqual(o.bundle?.summary.reasons, ['artifact-expired']);
  assert.equal(o.bundle?.verdict.state, 'VERIFIED_PASS');
  assert.equal(zipRequests(o.requests).length, 0);
});

test('HTTP 410 on the archive download is artifact-expired', async () => {
  const w = world();
  w.override = (url) => (url.endsWith('/zip') ? errorBody(410) : undefined);
  const o = await execute(w);
  assert.deepEqual(o.bundle?.summary.reasons, ['artifact-expired']);
  assert.equal(storageRequests(o.requests).length, 0);
});

test('a declared archive size over 6 MiB is never downloaded', async () => {
  const w = world();
  summaryArtifact(w).size_in_bytes = 6 * 1024 * 1024 + 1;
  const o = await execute(w);
  assert.deepEqual(o.bundle?.summary.reasons, ['archive-not-downloaded']);
  assert.equal(zipRequests(o.requests).length, 0);
});

test('a storage body over the cap is a failed retrieval', async () => {
  const w = world();
  w.override = (url) => (url === SIGNED_URL ? { kind: 'error', error: 'too-large' } : undefined);
  const o = await execute(w);
  assert.equal(o.bundle?.summary.state, 'SUMMARY_UNKNOWN');
  assert.deepEqual(o.bundle?.summary.reasons, ['retrieval-archive-malformed']);
  const storage = storageRequests(o.requests);
  assert.equal(storage.length, 1);
  assert.equal(storage[0]?.maxBytes, 6 * 1024 * 1024);
});

test('a storage timeout is retrieval-archive-timeout', async () => {
  const w = world();
  w.override = (url) => (url === SIGNED_URL ? { kind: 'error', error: 'timeout' } : undefined);
  assert.deepEqual((await bundleOf(w)).summary.reasons, ['retrieval-archive-timeout']);
});

/* ------------------------------------------------------------------ *
 * Archive contents (digest matches, contents do not)
 * ------------------------------------------------------------------ */

async function contentsCase(bytes: Uint8Array): Promise<VerdictBundle> {
  const w = world();
  serve(w, bytes);
  const b = await bundleOf(w);
  assert.equal(b.verdict.state, 'VERIFIED_PASS');
  assert.equal(b.artifact.digest, 'verified');
  assert.equal(b.metrics, null);
  return b;
}

const SUMMARY_BYTES = enc.encode(summaryText());

test('a malformed archive is SUMMARY_INVALID', async () => {
  const b = await contentsCase(enc.encode('this is not a zip archive at all, not even close'));
  assert.deepEqual(b.summary.reasons, ['archive-unexpected-entries']);
  assert.equal(b.summary.state, 'SUMMARY_INVALID');
});

test('a traversal entry name is SUMMARY_INVALID', async () => {
  const b = await contentsCase(
    storedZip([{ name: '../quality-summary.json', content: SUMMARY_BYTES }]),
  );
  assert.deepEqual(b.summary.reasons, ['archive-unexpected-entries']);
});

test('a symlink entry is SUMMARY_INVALID', async () => {
  const b = await contentsCase(storedZip([{ content: enc.encode('/etc/passwd'), mode: 0o120777 }]));
  assert.deepEqual(b.summary.reasons, ['archive-unexpected-entries']);
});

test('duplicate archive entries are SUMMARY_INVALID', async () => {
  const b = await contentsCase(storedZip([{ content: SUMMARY_BYTES }, { content: SUMMARY_BYTES }]));
  assert.deepEqual(b.summary.reasons, ['archive-unexpected-entries']);
});

test('an extra archive entry is SUMMARY_INVALID', async () => {
  const b = await contentsCase(
    storedZip([{ content: SUMMARY_BYTES }, { name: 'trace.zip', content: enc.encode(CANARY) }]),
  );
  assert.deepEqual(b.summary.reasons, ['archive-unexpected-entries']);
});

test('a CRC mismatch is SUMMARY_INVALID', async () => {
  const b = await contentsCase(storedZip([{ content: SUMMARY_BYTES, crc: 0xdeadbeef }]));
  assert.deepEqual(b.summary.reasons, ['archive-unexpected-entries']);
});

test('an uncompressed entry over 5 MiB is SUMMARY_INVALID (too large)', async () => {
  const content = new Uint8Array(5 * 1024 * 1024 + 1).fill(0x20);
  const b = await contentsCase(storedZip([{ content }]));
  assert.deepEqual(b.summary.reasons, ['archive-too-large']);
});

test('a zip bomb is SUMMARY_INVALID (too large)', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const content = new Uint8Array(4 * 1024 * 1024).fill(0x20);
  const data = new Uint8Array(deflateRawSync(content));
  const name = enc.encode(ENTRY_NAME);
  const crc = crc32(content);
  const local = concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(crc),
    u32(data.length),
    u32(content.length),
    u16(name.length),
    u16(0),
    name,
    data,
  ]);
  const central = concat([
    u32(0x02014b50),
    u16((3 << 8) | 20),
    u16(20),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(crc),
    u32(data.length),
    u32(content.length),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32((0o100644 << 16) >>> 0),
    u32(0),
    name,
  ]);
  const eocd = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  const b = await contentsCase(concat([local, central, eocd]));
  assert.deepEqual(b.summary.reasons, ['archive-too-large']);
});

test('a valid archive with an invalid summary is SUMMARY_INVALID', async () => {
  const b = await contentsCase(storedZip([{ content: enc.encode('{"schemaVersion":"1.0.0"}') }]));
  assert.deepEqual(b.summary.reasons, ['summary-invalid']);
});

test('a summary for another commit inside a verified archive is SUMMARY_CONFLICT', async () => {
  const w = world();
  serve(w, summaryZip({ headSha: OTHER_SHA }));
  assert.deepEqual((await bundleOf(w)).summary.reasons, ['summary-sha-mismatch']);
});

/* ------------------------------------------------------------------ *
 * HTTP failures
 * ------------------------------------------------------------------ */

const RUN_PATH = `/actions/runs/${String(RUN_ID)}/attempts/${String(ATTEMPT)}`;

for (const [status, headers, reason] of [
  [401, {}, 'retrieval-run-permission'],
  [403, {}, 'retrieval-run-permission'],
  [403, { rateLimitRemaining: '0' }, 'retrieval-run-rate-limited'],
  [403, { retryAfter: '60' }, 'retrieval-run-rate-limited'],
  [429, {}, 'retrieval-run-rate-limited'],
  [404, {}, 'retrieval-run-not-found'],
  [410, {}, 'retrieval-run-http-error'],
  [500, {}, 'retrieval-run-http-error'],
  [502, {}, 'retrieval-run-http-error'],
  [503, {}, 'retrieval-run-http-error'],
  [301, { location: 'https://api.github.com/elsewhere' }, 'retrieval-run-http-error'],
] as const) {
  test(`HTTP ${String(status)} on the run attempt is UNKNOWN (${reason})`, async () => {
    const w = world();
    w.override = (url) =>
      url === `${API_ORIGIN}/repos/${REPO}${RUN_PATH}` ? errorBody(status, headers) : undefined;
    const o = await execute(w);
    const b = o.bundle;
    assert.ok(b);
    assert.equal(b.verdict.state, 'UNKNOWN');
    assert.equal(b.verdict.reasons.includes(reason), true, JSON.stringify(b.verdict));
    assert.notEqual(b.summary.state, 'SUMMARY_VERIFIED_ORIGIN');
    assert.equal(b.metrics, null);
    assertNoSecrets(o);
    // Nothing is followed and nothing is retried.
    assert.equal(o.requests.filter((r) => r.url.endsWith(RUN_PATH)).length, 1);
  });
}

for (const status of [401, 403, 404, 429, 500] as const) {
  test(`HTTP ${String(status)} on jobs is UNKNOWN`, async () => {
    const w = world();
    w.override = (url) => (url.includes('/jobs?') ? errorBody(status) : undefined);
    assert.equal((await bundleOf(w)).verdict.state, 'UNKNOWN');
  });
  test(`HTTP ${String(status)} on artifacts is SUMMARY_UNKNOWN with the verdict intact`, async () => {
    const w = world();
    w.override = (url) => (url.includes('/artifacts?') ? errorBody(status) : undefined);
    const b = await bundleOf(w);
    assert.equal(b.verdict.state, 'VERIFIED_PASS');
    assert.equal(b.summary.state, 'SUMMARY_UNKNOWN');
  });
  test(`HTTP ${String(status)} on the archive request is SUMMARY_UNKNOWN`, async () => {
    const w = world();
    w.override = (url) => (url.endsWith('/zip') ? errorBody(status) : undefined);
    const o = await execute(w);
    assert.equal(o.bundle?.summary.state, 'SUMMARY_UNKNOWN');
    assert.equal(storageRequests(o.requests).length, 0);
  });
}

test('a network timeout is retrieval-run-timeout', async () => {
  const w = world();
  w.override = (url) => (url.endsWith(RUN_PATH) ? { kind: 'error', error: 'timeout' } : undefined);
  assert.deepEqual((await bundleOf(w)).verdict.reasons.includes('retrieval-run-timeout'), true);
});

test('a malformed JSON body is retrieval-run-malformed', async () => {
  const w = world();
  w.override = (url) =>
    url.endsWith(RUN_PATH)
      ? { kind: 'response', status: 200, headers: NO_HEADERS, body: enc.encode('{not json') }
      : undefined;
  assert.equal((await bundleOf(w)).verdict.reasons.includes('retrieval-run-malformed'), true);
});

test('a run attempt with a wrong field type is malformed, never trusted', async () => {
  const w = world();
  w.run.id = String(RUN_ID);
  assert.equal((await bundleOf(w)).verdict.reasons.includes('retrieval-run-malformed'), true);
});

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

function manyJobs(w: World, extra: number): void {
  for (let i = 0; i < extra; i++) {
    w.jobs.push({
      id: TEST_JOB_ID + 100 + i,
      name: `shard ${String(i)}`,
      run_attempt: ATTEMPT,
      head_sha: HEAD,
      status: 'completed',
      conclusion: 'success',
      steps: [],
    });
  }
}

test('jobs are collected across pages until total_count', async () => {
  const w = world();
  manyJobs(w, 248);
  const o = await execute(w);
  assert.equal(o.bundle?.verdict.state, 'VERIFIED_PASS');
  const pages = o.requests.filter((r) => r.url.includes('/jobs?'));
  assert.deepEqual(
    pages.map((r) => new URL(r.url).searchParams.get('page')),
    ['1', '2', '3'],
  );
});

test('a short page before total_count is incomplete pagination', async () => {
  const w = world();
  manyJobs(w, 150);
  w.override = (url) =>
    url.includes('/jobs?') && url.endsWith('page=2')
      ? json(200, { total_count: w.jobs.length, jobs: [] })
      : undefined;
  assert.deepEqual((await bundleOf(w)).verdict, {
    state: 'UNKNOWN',
    reasons: ['retrieval-jobs-incomplete-pagination'],
  });
});

test('a total_count that changes between pages is incomplete pagination', async () => {
  const w = world();
  manyJobs(w, 150);
  w.override = (url) =>
    url.includes('/jobs?') && url.endsWith('page=2')
      ? json(200, { total_count: 999, jobs: w.jobs.slice(100) })
      : undefined;
  assert.deepEqual((await bundleOf(w)).verdict.reasons, ['retrieval-jobs-incomplete-pagination']);
});

test('more items than total_count is malformed', async () => {
  const w = world();
  w.override = (url) =>
    url.includes('/jobs?') ? json(200, { total_count: 1, jobs: w.jobs }) : undefined;
  assert.deepEqual((await bundleOf(w)).verdict.reasons, ['retrieval-jobs-malformed']);
});

test('pagination stops at the page bound', async () => {
  const w = world();
  w.pageSize = 1;
  manyJobs(w, MAX_PAGES + 5);
  const o = await execute(w);
  assert.deepEqual(o.bundle?.verdict.reasons, ['retrieval-jobs-incomplete-pagination']);
  assert.equal(o.requests.filter((r) => r.url.includes('/jobs?')).length, MAX_PAGES);
});

test('artifacts are collected across pages', async () => {
  const w = world();
  for (let i = 0; i < 120; i++) {
    w.artifacts.unshift({
      ...(w.artifacts[0] as Json),
      id: ARTIFACT_ID + 1000 + i,
      name: `blob-${String(i)}`,
    });
  }
  const o = await execute(w);
  assert.equal(o.bundle?.summary.state, 'SUMMARY_VERIFIED_ORIGIN');
  assert.equal(o.requests.filter((r) => r.url.includes('/artifacts?')).length, 2);
});

test('a rate-limited second page is retrieval-artifacts-rate-limited', async () => {
  const w = world();
  for (let i = 0; i < 120; i++) {
    w.artifacts.unshift({
      ...(w.artifacts[0] as Json),
      id: ARTIFACT_ID + 1000 + i,
      name: `blob-${String(i)}`,
    });
  }
  w.override = (url) =>
    url.includes('/artifacts?') && url.endsWith('page=2')
      ? errorBody(403, { rateLimitRemaining: '0' })
      : undefined;
  const b = await bundleOf(w);
  assert.deepEqual(b.summary.reasons, ['retrieval-artifacts-rate-limited']);
  assert.equal(b.verdict.state, 'VERIFIED_PASS');
});

/* ------------------------------------------------------------------ *
 * Redirect and credential security
 * ------------------------------------------------------------------ */

test('the token is sent only to api.github.com; storage gets no Authorization or cookies', async () => {
  const o = await execute(world());
  const storage = storageRequests(o.requests);
  assert.equal(storage.length, 1);
  const headerNames = Object.keys(storage[0]?.headers ?? {}).map((h) => h.toLowerCase());
  assert.equal(headerNames.includes('authorization'), false);
  assert.equal(headerNames.includes('cookie'), false);
  assert.equal(JSON.stringify(storage[0]?.headers).includes(TOKEN), false);
  for (const r of o.requests) {
    if (JSON.stringify(r.headers).includes(TOKEN)) {
      assert.equal(new URL(r.url).origin, API_ORIGIN);
    }
  }
});

for (const [label, location] of [
  ['plain http', SIGNED_URL.replace('https://', 'http://')],
  ['another host', 'https://pipelines.actions.githubusercontent.com/artifact.zip?sig=x'],
  [
    'a lookalike suffix',
    'https://productionresultssa11.blob.core.windows.net.attacker.example/a.zip',
  ],
  ['a lookalike prefix', 'https://evilproductionresultssa11.blob.core.windows.net/a.zip'],
  ['another blob account', 'https://attacker.blob.core.windows.net/a.zip'],
  ['userinfo', 'https://user:pass@productionresultssa11.blob.core.windows.net/a.zip'],
  ['a nonstandard port', 'https://productionresultssa11.blob.core.windows.net:8443/a.zip'],
  ['a relative location', '/actions-results/a.zip'],
  ['a protocol-relative location', '//productionresultssa11.blob.core.windows.net/a.zip'],
  ['a trailing-dot host', 'https://productionresultssa11.blob.core.windows.net./a.zip'],
  ['a backslash', 'https://productionresultssa11.blob.core.windows.net\\@attacker.example/a.zip'],
  ['no location', null],
] as const) {
  test(`a storage redirect to ${label} is refused and nothing is written`, async () => {
    const w = world();
    w.location = location;
    const o = await execute(w);
    assert.equal(o.result.code, 'storage-redirect-refused');
    assert.equal(o.result.exitCode, 1);
    assert.equal(o.bundle, undefined);
    assert.equal(o.fs.mutations, 0);
    assert.equal(storageRequests(o.requests).length, 0);
    assertNoSecrets(o);
  });
}

test('another account in the reviewed storage family is accepted', async () => {
  const w = world();
  w.location = SIGNED_URL.replace('productionresultssa11', 'productionresultssa7');
  const o = await execute(w);
  assert.equal(o.bundle?.artifact.digest, 'verified');
});

test('a second redirect from storage is not followed', async () => {
  const w = world();
  w.override = (url) =>
    url === SIGNED_URL
      ? {
          kind: 'response',
          status: 302,
          headers: {
            ...NO_HEADERS,
            location: 'https://productionresultssa12.blob.core.windows.net/x',
          },
          body: new Uint8Array(0),
        }
      : undefined;
  const o = await execute(w);
  assert.deepEqual(o.bundle?.summary.reasons, ['retrieval-archive-http-error']);
  assert.equal(storageRequests(o.requests).length, 1);
});

test('a 200 from the archive endpoint instead of a redirect is not trusted', async () => {
  const w = world();
  w.override = (url) =>
    url.endsWith('/zip')
      ? { kind: 'response', status: 200, headers: NO_HEADERS, body: w.archive }
      : undefined;
  const o = await execute(w);
  assert.equal(o.bundle?.summary.state, 'SUMMARY_UNKNOWN');
  assert.equal(o.bundle?.artifact.digest, 'not-checked');
});

test('the signed URL and canaries never appear in any output', async () => {
  for (const w of [
    world(),
    (() => {
      const x = world();
      x.archive = new Uint8Array([1]);
      return x;
    })(),
  ]) {
    const o = await execute(w);
    assertNoSecrets(o);
  }
});

test('secret canaries in every response never reach the bundle', async () => {
  const w = world();
  // Error bodies, titles, step names and URLs all carry CANARY (see world()).
  w.override = (url) => (url.includes('/compare/') ? errorBody(500) : undefined);
  const o = await execute(w);
  assertNoSecrets(o);
  const ok = await execute(world());
  assertNoSecrets(ok);
});

/* ------------------------------------------------------------------ *
 * Token and policy
 * ------------------------------------------------------------------ */

for (const [label, token] of [
  ['missing', undefined],
  ['empty', ''],
  ['too short', 'ghp_short'],
  ['with whitespace', `ghp_${'a'.repeat(30)} `],
  ['with a newline', `ghp_${'a'.repeat(30)}\nX-Injected: 1`],
] as const) {
  test(`a ${label} token fails closed before any request`, async () => {
    const o = await execute(world(), { token });
    assert.equal(o.result.code, 'missing-token');
    assert.equal(o.result.exitCode, 1);
    assert.equal(o.requests.length, 0);
    assert.equal(o.fs.mutations, 0);
  });
}

test('a policy that tries to pre-confirm the digest contract is refused', async () => {
  const policy = { ...POLICY, digestContractConfirmed: true } as unknown as BaseTrustPolicy;
  const o = await execute(world(), { policy });
  assert.equal(o.result.code, 'invalid-policy');
  assert.equal(o.requests.length, 0);
});

test('a policy with an unsafe repository slug is refused', async () => {
  const o = await execute(world(), { policy: { ...POLICY, repositoryFullName: '../../evil' } });
  assert.equal(o.result.code, 'invalid-policy');
  assert.equal(o.requests.length, 0);
});

/* ------------------------------------------------------------------ *
 * Output safety and atomic write
 * ------------------------------------------------------------------ */

for (const [label, dir] of [
  ['inside the repository', `${REPO_ROOT}/out`],
  ['the repository root', REPO_ROOT],
  ['a symlink into the repository', '/operator/link-to-repo'],
  ['a symlink final component', '/operator/alias'],
  ['a missing directory', '/operator/missing'],
  ['a file', '/operator/not-a-dir'],
  ['an .auth directory', '/operator/.auth'],
  ['a .git directory', '/operator/.git'],
] as const) {
  test(`an output directory that is ${label} is refused before any request`, async () => {
    const o = await execute(world(), { outputDir: dir });
    assert.equal(o.result.code, 'unsafe-output-path');
    assert.equal(o.requests.length, 0);
    assert.equal(o.fs.mutations, 0);
  });
}

test('an existing bundle is never overwritten', async () => {
  const fs = memFs();
  fs.nodes.set(join(OUT_DIR, bundleFileName(RUN_ID, ATTEMPT)), {
    kind: 'file',
    data: 'old',
    id: 999,
  });
  const o = await execute(world(), { fs });
  assert.equal(o.result.code, 'output-exists');
  assert.equal(o.requests.length, 0);
  assert.equal(fs.nodes.get(join(OUT_DIR, bundleFileName(RUN_ID, ATTEMPT)))?.data, 'old');
});

test('a bundle that appears during retrieval is not replaced', async () => {
  const fs = memFs();
  const w = world();
  w.override = (url) => {
    if (url.endsWith('/zip')) {
      fs.nodes.set(join(OUT_DIR, bundleFileName(RUN_ID, ATTEMPT)), {
        kind: 'file',
        data: 'raced',
        id: 998,
      });
    }
    return undefined;
  };
  const o = await execute(w, { fs });
  assert.equal(o.result.code, 'output-exists');
  assert.equal(fs.nodes.get(join(OUT_DIR, bundleFileName(RUN_ID, ATTEMPT)))?.data, 'raced');
  // The temporary file was removed.
  assert.deepEqual(
    [...fs.nodes.keys()].filter((k) => k.startsWith(OUT_DIR) && k.endsWith('.tmp')),
    [],
  );
});

test('the bundle is written through an exclusive temporary file and renamed', async () => {
  const fs = memFs();
  fs.collide.add('temp-');
  const o = await execute(world(), { fs });
  assert.equal(o.result.code, 'written');
  const names = [...fs.nodes.keys()].filter((k) => k.startsWith(`${OUT_DIR}/`));
  assert.deepEqual(names, [join(OUT_DIR, bundleFileName(RUN_ID, ATTEMPT))]);
});

test('an invalid temporary name fails the write without touching the target', async () => {
  const o = await execute(world(), { randomId: () => '../../x' });
  assert.equal(o.result.code, 'write-failed');
  assert.equal(o.bundle, undefined);
});

test('the output directory is resolved through symlinked ancestors', async () => {
  const fs = memFs();
  fs.nodes.set('/alias-root', { kind: 'symlink', target: '/operator', id: 997 });
  const o = await execute(world(), { fs, outputDir: '/alias-root/out' });
  assert.equal(o.result.code, 'written');
});

/* ------------------------------------------------------------------ *
 * Arguments and helpers
 * ------------------------------------------------------------------ */

test('parseVerdictArgs accepts exactly <run-id> <attempt> <absolute-dir>', () => {
  assert.deepEqual(parseVerdictArgs(['45822924582', '1', '/tmp/out']), {
    ok: true,
    args: { runId: 45_822_924_582, runAttempt: 1, outputDir: '/tmp/out' },
  });
  for (const argv of [
    [],
    ['1', '1'],
    ['1', '1', 'relative/dir'],
    ['0', '1', '/tmp'],
    ['1', '0', '/tmp'],
    ['01', '1', '/tmp'],
    ['1e3', '1', '/tmp'],
    ['-1', '1', '/tmp'],
    ['1', '1', '/tmp', 'extra'],
    ['1', '1', '/tmp/\0x'],
    ['99999999999999999', '1', '/tmp'],
    [TOKEN, '1', '/tmp'],
  ]) {
    assert.deepEqual(parseVerdictArgs(argv), { ok: false }, JSON.stringify(argv));
  }
});

test('storageTarget enforces the reviewed policy', () => {
  assert.equal(storageTarget(SIGNED_URL)?.hostname, STORAGE_HOSTNAME);
  assert.equal(storageTarget('https://productionresultssa1.blob.core.windows.net/x')?.port, '');
  assert.ok(storageTarget('https://productionresultssa11.blob.core.windows.net:443/x'));
  assert.equal(
    storageTarget('https://PRODUCTIONRESULTSSA11.BLOB.CORE.WINDOWS.NET/x')?.hostname,
    STORAGE_HOSTNAME,
  );
  assert.equal(storageTarget('https://productionresultssa1234.blob.core.windows.net/x'), undefined);
  assert.equal(storageTarget('https://productionresultssa.blob.core.windows.net/x'), undefined);
  assert.equal(storageTarget('https://blob.core.windows.net/x'), undefined);
  assert.equal(storageTarget('ftp://productionresultssa11.blob.core.windows.net/x'), undefined);
  assert.equal(storageTarget(' https://productionresultssa11.blob.core.windows.net/x'), undefined);
  assert.equal(storageTarget(null), undefined);
});

test('classifyStatus maps statuses to fixed failures', () => {
  assert.equal(classifyStatus(401, NO_HEADERS), 'permission');
  assert.equal(classifyStatus(403, NO_HEADERS), 'permission');
  assert.equal(classifyStatus(403, { ...NO_HEADERS, rateLimitRemaining: '0' }), 'rate-limited');
  assert.equal(classifyStatus(429, NO_HEADERS), 'rate-limited');
  assert.equal(classifyStatus(404, NO_HEADERS), 'not-found');
  assert.equal(classifyStatus(500, NO_HEADERS), 'http-error');
  assert.equal(classifyStatus(302, NO_HEADERS), 'http-error');
});

test('createTransport refuses an unsafe repository or branch', () => {
  const { http } = fakeHttp(world());
  assert.throws(() => createTransport({ token: TOKEN, repository: 'a/b/c', branch: 'main', http }));
  assert.throws(() => createTransport({ token: TOKEN, repository: REPO, branch: '../x', http }));
});

test('transport compare rejects non-SHA input without a request', async () => {
  const rec = fakeHttp(world());
  const t = createTransport({ token: TOKEN, repository: REPO, branch: 'main', http: rec.http });
  assert.deepEqual(await t.compare('main', HEAD), { status: 'failed', reason: 'malformed' });
  assert.equal(rec.requests.length, 0);
});

test('result messages are fixed text', () => {
  assert.equal(
    resultMessage({
      exitCode: 0,
      code: 'written',
      verdict: 'VERIFIED_PASS',
      summary: 'SUMMARY_UNAVAILABLE',
    }),
    'quality-verdict: written [verdict VERIFIED_PASS, summary SUMMARY_UNAVAILABLE] — bundle written',
  );
  assert.match(
    resultMessage({ exitCode: 2, code: 'usage', verdict: null, summary: null }),
    /^quality-verdict: usage — usage: /,
  );
});
