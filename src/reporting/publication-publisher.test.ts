/**
 * Unit tests for the trusted publication publisher (ADR-0011 P2).
 *
 * Same conventions as the other unit tests (ADR-0002). GitHub is a synthetic
 * in-memory router serving transport-shaped JSON and stored ZIP archives;
 * filesystems are real, isolated `mkdtemp` sandboxes outside the repository
 * (plus targeted adapter overrides for failures a real filesystem cannot
 * produce on demand). No live GitHub call, real token, real artifact or
 * retained local evidence is used. Retained bundles are produced by the
 * committed operator functions from the same synthetic evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GATE_INPUT_NAMES, normalize, serialize } from './quality-summary.ts';
import { CANARY, SYNTHETIC_SHA, context, twelveEighteenNineteen } from './fixtures.ts';
import { ENTRY_NAME, crc32 } from './zip-entry.ts';
import {
  API_ORIGIN,
  TRUST_POLICY,
  buildBundle,
  bundleFileName,
  collectEvidence,
  createTransport,
  reconcileCollected,
  serializeBundle,
  sha256Digest,
  type HttpAdapter,
  type HttpRequest,
  type HttpResult,
  type ResponseHeaders,
} from './verdict-cli.ts';
import {
  buildPublicationManifest,
  verifiedTotals,
  type PublicationManifest,
} from './publication-manifest.ts';
import {
  BUILD_RECORD_FILE,
  GENERATION_NAME,
  MANIFEST_FILE,
  MAX_ALLOWLIST_ENTRIES,
  PUBLISHER_CODES,
  UNSAFE_ENVIRONMENT,
  generationName,
  isStrictJson,
  nodeGit,
  nodePublisherFs,
  parseAllowList,
  parsePublicationArgs,
  resultMessage,
  runPublication,
  runPublicationWith,
  type PublicationArgs,
  type PublicationResult,
  type PublisherDeps,
  type PublisherFs,
} from './publication-publisher.ts';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const REPO = TRUST_POLICY.repositoryFullName;
const BASE = `${API_ORIGIN}/repos/${REPO}`;
const HEAD = SYNTHETIC_SHA;
const SOURCE = 'c0ffee0000000000000000000000000000c0ffee';
const TIP = 'fedcba9876543210fedcba9876543210fedcba98';
const RUN_ID = 1_000_001;
const NOW = '2026-11-26T12:00:00.000Z';
const BUILT_AT = '2026-11-26T11:55:00.000Z';
const TOKEN = `ghp_TOKENCANARY${'7'.repeat(24)}`;
const SIGNATURE = 'SIGNEDURLCANARY9f8e7d';
const STORAGE = 'productionresultssa11.blob.core.windows.net';
const POSIX = process.platform !== 'win32' && typeof process.getuid === 'function';

const enc = new TextEncoder();
type Json = Record<string, unknown>;

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/* ------------------------------------------------------------------ *
 * Synthetic archives
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

/** A stored (uncompressed) ZIP with the given entries. */
function storedZip(entries: readonly { name: string; content: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.content);
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

function summaryZip(runId: number, overrides: Record<string, unknown> = {}): Uint8Array {
  const text = serialize(normalize(twelveEighteenNineteen(), context({ runId, ...overrides })));
  return storedZip([{ name: ENTRY_NAME, content: enc.encode(text) }]);
}

/* ------------------------------------------------------------------ *
 * Synthetic GitHub
 * ------------------------------------------------------------------ */

interface RunWorld {
  run: Json;
  jobs: Json[];
  artifacts: Json[];
  archive: Uint8Array;
}

interface World {
  runs: Map<number, RunWorld>;
  tip: string;
  /** Compare bodies keyed by the evaluated SHA (`compare/{sha}...{tip}`). */
  compare: Map<string, Json>;
  location: (artifactId: number) => string | null;
  override?: (url: URL, request: HttpRequest) => HttpResult | undefined;
}

function artifactIdFor(runId: number): number {
  return 700_000_000 + (runId % 1_000_000);
}

function aheadOf(sha: string): Json {
  // The tip is ahead of `sha`: `sha` is an ancestor of main.
  return { status: 'ahead', base_commit: { sha }, merge_base_commit: { sha }, files: [CANARY] };
}

function runWorld(runId: number): RunWorld {
  const archive = summaryZip(runId);
  const artifactId = artifactIdFor(runId);
  const workflowRun = {
    id: runId,
    repository_id: TRUST_POLICY.repositoryId,
    head_repository_id: TRUST_POLICY.repositoryId,
    head_sha: HEAD,
  };
  return {
    run: {
      id: runId,
      run_attempt: 1,
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      head_sha: HEAD,
      head_branch: 'main',
      workflow_id: TRUST_POLICY.workflowId,
      path: TRUST_POLICY.workflowPath,
      name: TRUST_POLICY.workflowName,
      display_title: `commit ${CANARY}`,
      repository: { id: TRUST_POLICY.repositoryId, full_name: REPO, description: CANARY },
      head_repository: { full_name: REPO },
      run_started_at: '2026-11-25T00:00:00Z',
      updated_at: '2026-11-25T01:00:00Z',
    },
    jobs: [
      {
        id: 600_000_001,
        name: 'test',
        run_attempt: 1,
        head_sha: HEAD,
        status: 'completed',
        conclusion: 'success',
        runner_name: CANARY,
        steps: [
          { number: 1, name: `Run ${CANARY}`, status: 'completed', conclusion: 'success' },
          { number: 9, name: 'Gate', status: 'completed', conclusion: 'success' },
        ],
      },
    ],
    artifacts: [
      {
        id: artifactId - 1,
        name: `blob-report-${CANARY}`,
        size_in_bytes: 10,
        digest: `sha256:${'a'.repeat(64)}`,
        created_at: '2026-11-25T00:20:00Z',
        expires_at: '2026-12-02T00:20:00Z',
        expired: false,
        workflow_run: workflowRun,
      },
      {
        id: artifactId,
        name: 'quality-summary-1',
        size_in_bytes: archive.length,
        digest: sha256Digest(archive),
        created_at: '2026-11-25T00:30:00Z',
        expires_at: '2026-12-02T00:30:00Z',
        expired: false,
        workflow_run: workflowRun,
      },
    ],
    archive,
  };
}

function world(...runIds: number[]): World {
  const ids = runIds.length === 0 ? [RUN_ID] : runIds;
  return {
    runs: new Map(ids.map((id) => [id, runWorld(id)])),
    tip: TIP,
    compare: new Map([
      [SOURCE, aheadOf(SOURCE)],
      [HEAD, aheadOf(HEAD)],
    ]),
    location: (id) => `https://${STORAGE}/actions-results/${String(id)}.zip?sv=1&sig=${SIGNATURE}`,
  };
}

function rw(w: World, runId = RUN_ID): RunWorld {
  const r = w.runs.get(runId);
  assert.ok(r);
  return r;
}
function summaryArtifact(r: RunWorld): Json {
  const a = r.artifacts.find((x) => x.name === 'quality-summary-1');
  assert.ok(a);
  return a;
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
  return json(status, { message: `error ${CANARY} ${TOKEN}`, documentation_url: CANARY }, headers);
}
function page(list: Json[], key: string, url: URL): HttpResult {
  const n = Number(url.searchParams.get('page'));
  return json(200, { total_count: list.length, [key]: list.slice((n - 1) * 100, n * 100) });
}

interface Recorder {
  readonly requests: HttpRequest[];
  readonly http: HttpAdapter;
}

function fakeHttp(w: World): Recorder {
  const requests: HttpRequest[] = [];
  const http: HttpAdapter = {
    get: (request) => {
      requests.push(request);
      const url = new URL(request.url);
      const overridden = w.override?.(url, request);
      if (overridden !== undefined) return Promise.resolve(overridden);
      const path = `${url.origin}${url.pathname}`;
      if (url.hostname === STORAGE) {
        const id = Number(/\/(\d+)\.zip$/.exec(url.pathname)?.[1]);
        const run = [...w.runs.values()].find((r) => summaryArtifact(r).id === id);
        return Promise.resolve(
          run === undefined
            ? errorBody(404)
            : { kind: 'response', status: 200, headers: NO_HEADERS, body: run.archive },
        );
      }
      let m = /\/actions\/runs\/(\d+)\/attempts\/(\d+)(\/jobs)?$/.exec(path);
      if (m !== null) {
        const r = w.runs.get(Number(m[1]));
        if (r === undefined || Number(m[2]) !== 1) return Promise.resolve(errorBody(404));
        return Promise.resolve(m[3] === undefined ? json(200, r.run) : page(r.jobs, 'jobs', url));
      }
      m = /\/actions\/runs\/(\d+)\/artifacts$/.exec(path);
      if (m !== null) {
        const r = w.runs.get(Number(m[1]));
        return Promise.resolve(
          r === undefined ? errorBody(404) : page(r.artifacts, 'artifacts', url),
        );
      }
      if (path === `${BASE}/git/ref/heads/main`) {
        return Promise.resolve(
          json(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: w.tip } }),
        );
      }
      m = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
      if (m !== null && path.startsWith(BASE)) {
        const body = m[2] === w.tip ? w.compare.get(m[1] ?? '') : undefined;
        return Promise.resolve(body === undefined ? errorBody(404) : json(200, body));
      }
      m = /\/actions\/artifacts\/(\d+)\/zip$/.exec(path);
      if (m !== null && path.startsWith(BASE)) {
        return Promise.resolve({
          kind: 'response',
          status: 302,
          headers: { ...NO_HEADERS, location: w.location(Number(m[1])) },
          body: new Uint8Array(0),
        });
      }
      return Promise.resolve(errorBody(404));
    },
  };
  return { requests, http };
}

/* ------------------------------------------------------------------ *
 * Sandboxes and runs
 * ------------------------------------------------------------------ */

interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly privateDir: string;
  readonly allowlist: string;
  readonly out: string;
  readonly evidence: string;
  readonly cleanup: () => void;
}

function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qvp-test-')));
  chmodSync(root, 0o700);
  const repo = join(root, 'repo');
  const privateDir = join(root, 'private');
  const out = join(root, 'out');
  const evidence = join(root, 'evidence');
  for (const d of [repo, privateDir, out, evidence]) {
    mkdirSync(d);
    chmodSync(d, 0o700);
  }
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
  return {
    root,
    repo,
    privateDir,
    allowlist: join(privateDir, 'allowlist.json'),
    out,
    evidence,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function allowListText(
  entries: readonly { runId: number; runAttempt?: number; retained?: string | null }[],
  includeUntrustedOrigin = false,
): string {
  return `${JSON.stringify(
    {
      allowListSchemaVersion: '1.0.0',
      kind: 'quality-verdict-publication-allowlist',
      includeUntrustedOrigin,
      entries: entries.map((e) => ({
        runId: e.runId,
        runAttempt: e.runAttempt ?? 1,
        retained: e.retained === undefined || e.retained === null ? null : { sha256: e.retained },
      })),
    },
    null,
    2,
  )}\n`;
}

function writePrivate(path: string, text: string | Uint8Array): void {
  writeFileSync(path, text);
  chmodSync(path, 0o600);
}

interface RunOptions {
  allowList?: string;
  args?: Partial<PublicationArgs>;
  deps?: Partial<PublisherDeps>;
  fs?: Partial<PublisherFs>;
}

interface Outcome {
  readonly result: PublicationResult;
  readonly requests: readonly HttpRequest[];
  readonly box: Sandbox;
  readonly message: string;
}

let counter = 0;
function randomId(): string {
  counter += 1;
  return `staging-${String(counter).padStart(12, '0')}`;
}

async function publish(w: World, options: RunOptions = {}, box = sandbox()): Promise<Outcome> {
  if (options.allowList !== undefined || !Object.hasOwn(options, 'allowList')) {
    writePrivate(box.allowlist, options.allowList ?? allowListText([{ runId: RUN_ID }]));
  }
  const recorder = fakeHttp(w);
  const args: PublicationArgs = {
    allowlist: box.allowlist,
    outParent: box.out,
    sourceCommit: SOURCE,
    builtAt: BUILT_AT,
    evidenceDir: null,
    ...options.args,
  };
  const deps: PublisherDeps = {
    runtime: { execArgv: [], isSet: () => false },
    token: TOKEN,
    now: () => NOW,
    nodeVersion: 'v24.0.0',
    repoRoot: box.repo,
    http: recorder.http,
    git: { head: () => SOURCE, status: () => '' },
    fs: { ...nodePublisherFs, ...options.fs },
    randomId,
    ...options.deps,
  };
  const result = await runPublication(args, deps);
  return { result, requests: recorder.requests, box, message: resultMessage(result) };
}

/** Runs, asserts the code, checks no leak and (on failure) that nothing was written. */
async function expectCode(
  w: World,
  code: string,
  options: RunOptions = {},
  box?: Sandbox,
): Promise<Outcome> {
  const o = await publish(w, options, box);
  try {
    assert.equal(o.result.code, code, o.message);
    assertNoLeak(o);
    if (code !== 'committed') {
      assert.equal(o.result.exitCode, code === 'usage' ? 2 : 1);
      assert.deepEqual(readdirSync(o.box.out), [], 'nothing may be written on failure');
    }
  } finally {
    if (box === undefined) o.box.cleanup();
  }
  return o;
}

function assertNoLeak(o: Outcome): void {
  const texts = [o.message, JSON.stringify(o.result)];
  for (const name of readdirSync(o.box.out)) {
    const dir = join(o.box.out, name);
    if (lstatSync(dir).isDirectory()) {
      for (const f of readdirSync(dir)) texts.push(readFileSync(join(dir, f), 'utf8'));
    }
  }
  for (const text of texts) {
    for (const secret of [TOKEN, SIGNATURE, CANARY, STORAGE, o.box.root, 'Bearer', 'http']) {
      assert.equal(text.includes(secret), false, `leaked ${secret.slice(0, 12)}`);
    }
  }
}

function readGeneration(o: Outcome): {
  dir: string;
  manifest: PublicationManifest;
  manifestText: string;
  record: Json;
} {
  const names = readdirSync(o.box.out);
  assert.deepEqual(names, [o.result.generation]);
  const dir = join(o.box.out, names[0] ?? '');
  const manifestText = readFileSync(join(dir, MANIFEST_FILE), 'utf8');
  return {
    dir,
    manifest: JSON.parse(manifestText) as PublicationManifest,
    manifestText,
    record: JSON.parse(readFileSync(join(dir, BUILD_RECORD_FILE), 'utf8')) as Json,
  };
}

/** A retained bundle written exactly as the operator writes it, from this world's evidence. */
async function retainBundle(w: World, box: Sandbox, runId = RUN_ID): Promise<string> {
  const transport = createTransport({
    token: TOKEN,
    repository: REPO,
    branch: 'main',
    http: fakeHttp(w).http,
  });
  const collected = await collectEvidence(transport, { runId, runAttempt: 1 }, TRUST_POLICY);
  const text = serializeBundle(
    buildBundle(reconcileCollected(collected, TRUST_POLICY), collected, TRUST_POLICY),
  );
  writePrivate(join(box.evidence, bundleFileName(runId, 1)), text);
  return sha256(text);
}

/* ------------------------------------------------------------------ *
 * Committed generations
 * ------------------------------------------------------------------ */

test('a clean run commits one generation with exactly two private files', async () => {
  const o = await publish(world());
  try {
    assert.equal(o.result.code, 'committed', o.message);
    assert.equal(o.result.exitCode, 0);
    assert.match(o.result.generation ?? '', GENERATION_NAME);
    const g = readGeneration(o);
    assert.equal(lstatSync(g.dir).mode & 0o7777, 0o700);
    assert.deepEqual(readdirSync(g.dir).sort(), [BUILD_RECORD_FILE, MANIFEST_FILE].sort());
    for (const f of readdirSync(g.dir)) {
      const s = lstatSync(join(g.dir, f));
      assert.ok(s.isFile());
      assert.equal(s.mode & 0o7777, 0o600);
    }
    const e = g.manifest.results[0];
    assert.equal(g.manifest.results.length, 1);
    assert.equal(e?.gate.state, 'VERIFIED_PASS');
    assert.equal(e?.gate.authenticity, 'BUILD_VERIFIED');
    assert.equal(e?.gate.verifiedAt, BUILT_AT);
    assert.equal(e?.metrics?.authenticity, 'BUILD_VERIFIED');
    assert.equal(g.manifest.build.sourceCommit, SOURCE);
    // Build record: exact keys, explicit inputs, hashes of the real bytes.
    assert.deepEqual(g.record, {
      buildRecordSchemaVersion: '1.0.0',
      kind: 'quality-verdict-publication-build-record',
      sourceCommit: SOURCE,
      builtAt: BUILT_AT,
      nodeVersion: 'v24.0.0',
      allowListSha256: sha256(readFileSync(o.box.allowlist)),
      packageLockSha256: sha256(readFileSync(join(o.box.repo, 'package-lock.json'))),
      manifestSha256: sha256(g.manifestText),
    });
    assert.equal(o.result.manifestSha256, sha256(g.manifestText));
    assert.equal(o.result.generation, generationName(BUILT_AT, sha256(g.manifestText)));
    assert.equal(o.result.generation?.startsWith('qvp-20261126T115500Z-'), true);
    assertNoLeak(o);
  } finally {
    o.box.cleanup();
  }
});

test('the token goes only to the API; storage requests carry no credentials', async () => {
  const o = await publish(world());
  try {
    assert.equal(o.result.code, 'committed');
    for (const r of o.requests) {
      const isApi = r.url.startsWith(`${API_ORIGIN}/`);
      assert.equal('Authorization' in r.headers, isApi, r.url.slice(0, 40));
      if (isApi) assert.equal(r.headers.Authorization, `Bearer ${TOKEN}`);
    }
    assert.ok(o.requests.some((r) => new URL(r.url).hostname === STORAGE));
  } finally {
    o.box.cleanup();
  }
});

test('allow-list order never changes the manifest or the generation name', async () => {
  const ids = [RUN_ID + 2, RUN_ID, RUN_ID + 1];
  const a = await publish(world(...ids), {
    allowList: allowListText(ids.map((runId) => ({ runId }))),
  });
  const b = await publish(world(...ids), {
    allowList: allowListText([...ids].sort().map((runId) => ({ runId }))),
  });
  try {
    assert.equal(a.result.code, 'committed');
    assert.equal(b.result.code, 'committed');
    assert.equal(a.result.generation, b.result.generation);
    assert.equal(readGeneration(a).manifestText, readGeneration(b).manifestText);
    assert.deepEqual(
      readGeneration(a).manifest.results.map((e) => e.runId),
      [RUN_ID, RUN_ID + 1, RUN_ID + 2],
    );
  } finally {
    a.box.cleanup();
    b.box.cleanup();
  }
});

test('the console line has a fixed shape and no path', async () => {
  const o = await publish(world());
  try {
    assert.match(
      o.message,
      /^quality-publication: committed generation=qvp-\d{8}T\d{6}Z-[0-9a-f]{16} manifest-sha256=[0-9a-f]{64} — publication generation committed$/,
    );
    for (const code of PUBLISHER_CODES) {
      const line = resultMessage({ exitCode: 1, code, generation: null, manifestSha256: null });
      assert.equal(line.includes('/Users'), false);
      assert.ok(line.startsWith(`quality-publication: ${code} — `));
    }
  } finally {
    o.box.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Pre-flight: refused with zero network requests
 * ------------------------------------------------------------------ */

test('every listed unsafe environment variable is refused before any request', async () => {
  for (const name of UNSAFE_ENVIRONMENT) {
    const o = await expectCode(world(), 'unsafe-runtime', {
      deps: { runtime: { execArgv: [], isSet: (n) => n === name } },
    });
    assert.equal(o.requests.length, 0, name);
  }
});

test('Node startup flags are refused before any request', async () => {
  for (const flag of [['--require=x'], ['--import', 'x'], ['--inspect']]) {
    const o = await expectCode(world(), 'unsafe-runtime', {
      deps: { runtime: { execArgv: flag, isSet: () => false } },
    });
    assert.equal(o.requests.length, 0);
  }
});

test('a missing or malformed token is refused before any request', async () => {
  for (const token of [undefined, '', 'short', `${TOKEN} `, 'x'.repeat(256)]) {
    const o = await expectCode(world(), 'missing-token', { deps: { token } });
    assert.equal(o.requests.length, 0);
  }
});

test('builtAt must be canonical UTC within 15 minutes of the clock', async () => {
  for (const builtAt of [
    '2026-11-26T11:44:59.999Z',
    '2026-11-26T12:15:00.001Z',
    '2026-11-26T12:00:00+00:00',
    '2026-11-26',
    'yesterday',
  ]) {
    const o = await expectCode(world(), 'invalid-built-at', { args: { builtAt } });
    assert.equal(o.requests.length, 0, builtAt);
  }
  await expectCode(world(), 'committed', { args: { builtAt: '2026-11-26T11:45:00Z' } });
  await expectCode(world(), 'committed', { args: { builtAt: '2026-11-26T12:15:00.000Z' } });
});

test('HEAD must equal the source commit and the tree must be clean', async () => {
  const cases: [Partial<PublisherDeps>, string][] = [
    [{ git: { head: () => TIP, status: () => '' } }, 'source-commit-mismatch'],
    [{ git: { head: () => undefined, status: () => '' } }, 'source-commit-mismatch'],
    [{ git: { head: () => SOURCE, status: () => ' M src/x.ts\n' } }, 'dirty-tree'],
    [{ git: { head: () => SOURCE, status: () => '?? untracked.txt\n' } }, 'dirty-tree'],
    [{ git: { head: () => SOURCE, status: () => undefined } }, 'dirty-tree'],
  ];
  for (const [deps, code] of cases) {
    const o = await expectCode(world(), code, { deps });
    assert.equal(o.requests.length, 0, code);
  }
});

const VALID_ALLOWLIST = JSON.parse(allowListText([{ runId: RUN_ID }])) as Json;

function allowListWith(edit: (a: Json, entry: Json) => void): string {
  const a = structuredClone(VALID_ALLOWLIST);
  const entries = a.entries as Json[];
  edit(a, entries[0] ?? {});
  return JSON.stringify(a);
}

test('the allow-list parser is strict', () => {
  assert.notEqual(parseAllowList(enc.encode(allowListText([{ runId: RUN_ID }]))), undefined);
  const bad: [string, string | Uint8Array][] = [
    ['not json', '{'],
    ['BOM', `\uFEFF${allowListText([{ runId: RUN_ID }])}`],
    ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
    ['top-level unknown field', allowListWith((a) => (a.publish = true))],
    ['entry verdict claim', allowListWith((_, e) => (e.verdict = 'VERIFIED_PASS'))],
    ['entry authenticity claim', allowListWith((_, e) => (e.authenticity = 'BUILD_VERIFIED'))],
    ['entry summary claim', allowListWith((_, e) => (e.summary = 'SUMMARY_VERIFIED_ORIGIN'))],
    ['entry path', allowListWith((_, e) => (e.path = '/tmp/bundle.json'))],
    [
      'retained path',
      allowListWith((_, e) => (e.retained = { sha256: 'a'.repeat(64), path: 'x' })),
    ],
    ['retained bad hash', allowListWith((_, e) => (e.retained = { sha256: 'A'.repeat(64) }))],
    ['retained as string', allowListWith((_, e) => (e.retained = 'a'.repeat(64)))],
    ['runId zero', allowListWith((_, e) => (e.runId = 0))],
    ['runId string', allowListWith((_, e) => (e.runId = String(RUN_ID)))],
    ['runAttempt fraction', allowListWith((_, e) => (e.runAttempt = 1.5))],
    ['runAttempt too large', allowListWith((_, e) => (e.runAttempt = 1001))],
    ['wrong version', allowListWith((a) => (a.allowListSchemaVersion = '2.0.0'))],
    ['wrong kind', allowListWith((a) => (a.kind = 'quality-verdict-publication'))],
    ['includeUntrustedOrigin string', allowListWith((a) => (a.includeUntrustedOrigin = 'false'))],
    ['empty entries', allowListText([])],
    ['duplicate', allowListText([{ runId: RUN_ID }, { runId: RUN_ID }])],
    [
      'too many',
      allowListText(
        Array.from({ length: MAX_ALLOWLIST_ENTRIES + 1 }, (_, i) => ({ runId: i + 1 })),
      ),
    ],
    ['too large', `${allowListText([{ runId: RUN_ID }])}${' '.repeat(64 * 1024)}`],
  ];
  for (const [label, input] of bad) {
    const bytes = typeof input === 'string' ? enc.encode(input) : input;
    assert.equal(parseAllowList(bytes), undefined, label);
  }
  const many = allowListText(
    Array.from({ length: MAX_ALLOWLIST_ENTRIES }, (_, i) => ({ runId: i + 1 })),
  );
  assert.equal(parseAllowList(enc.encode(many))?.entries.length, MAX_ALLOWLIST_ENTRIES);
});

/** A valid allow-list document written by hand, so keys can be repeated or escaped. */
function rawAllowList(entry: string, top = ''): string {
  return `{${top}"allowListSchemaVersion":"1.0.0","kind":"quality-verdict-publication-allowlist","includeUntrustedOrigin":false,"entries":[${entry}]}`;
}
const ENTRY = `{"runId":${String(RUN_ID)},"runAttempt":1,"retained":null}`;

test('duplicate keys are rejected at every level, including escaped equivalents', () => {
  assert.notEqual(parseAllowList(enc.encode(rawAllowList(ENTRY))), undefined);
  const pin = `{"sha256":"${'a'.repeat(64)}"}`;
  const duplicates: [string, string][] = [
    ['root key', rawAllowList(ENTRY, '"kind":"quality-verdict-publication-allowlist",')],
    [
      'root key escaped',
      rawAllowList(ENTRY, '"\\u006bind":"quality-verdict-publication-allowlist",'),
    ],
    ['root includeUntrustedOrigin', rawAllowList(ENTRY, '"includeUntrustedOrigin":true,')],
    [
      'entry runId',
      rawAllowList(`{"runId":1,"runId":${String(RUN_ID)},"runAttempt":1,"retained":null}`),
    ],
    [
      'entry runId escaped',
      rawAllowList(`{"\\u0072unId":1,"runId":${String(RUN_ID)},"runAttempt":1,"retained":null}`),
    ],
    [
      'entry runAttempt',
      rawAllowList(`{"runId":${String(RUN_ID)},"runAttempt":2,"runAttempt":1,"retained":null}`),
    ],
    [
      'entry runAttempt fully escaped',
      rawAllowList(
        `{"runId":${String(RUN_ID)},"\\u0072\\u0075\\u006e\\u0041ttempt":2,"runAttempt":1,"retained":null}`,
      ),
    ],
    [
      'retained sha256',
      rawAllowList(
        `{"runId":${String(RUN_ID)},"runAttempt":1,"retained":{"sha256":"${'b'.repeat(64)}","sha256":"${'a'.repeat(64)}"}}`,
      ),
    ],
    [
      'retained sha256 escaped',
      rawAllowList(
        `{"runId":${String(RUN_ID)},"runAttempt":1,"retained":{"sha\\u0032\\u0035\\u0036":"${'b'.repeat(64)}","sha256":"${'a'.repeat(64)}"}}`,
      ),
    ],
    [
      'entry retained',
      rawAllowList(`{"runId":${String(RUN_ID)},"runAttempt":1,"retained":${pin},"retained":null}`),
    ],
  ];
  for (const [label, text] of duplicates) {
    assert.equal(isStrictJson(text), false, label);
    assert.equal(parseAllowList(enc.encode(text)), undefined, label);
  }
  // A single escaped spelling is the same key and is accepted.
  const escaped = rawAllowList(`{"\\u0072unId":${String(RUN_ID)},"runAttempt":1,"retained":null}`);
  assert.equal(parseAllowList(enc.encode(escaped))?.entries[0]?.runId, RUN_ID);
});

test('invalid escapes, malformed Unicode, control characters and malformed nesting are rejected', () => {
  const bad: [string, string][] = [
    ['unknown escape', '{"a":"\\x41"}'],
    ['short unicode escape', '{"a":"\\u12"}'],
    ['non-hex unicode escape', '{"a":"\\uZZZZ"}'],
    ['lone high surrogate', '{"a":"\\uD800"}'],
    ['lone high surrogate before text', '{"a":"\\uD800x"}'],
    ['high surrogate + non-low', '{"a":"\\uD800\\u0041"}'],
    ['lone low surrogate', '{"a":"\\uDC00"}'],
    ['lone surrogate in a key', '{"\\uD800":1}'],
    ['raw lone surrogate', `{"a":"${String.fromCharCode(0xd800)}"}`],
    ['unescaped tab', '{"a":"x\ty"}'],
    ['unescaped newline', '{"a":"x\ny"}'],
    ['unescaped NUL', `{"a":"x${String.fromCharCode(0)}"}`],
    ['unterminated string', '{"a":"x'],
    ['trailing comma', '{"a":1,}'],
    ['array trailing comma', '[1,]'],
    ['mismatched brackets', '{"a":[1}'],
    ['missing colon', '{"a" 1}'],
    ['unquoted key', '{a:1}'],
    ['single quotes', "{'a':1}"],
    ['leading zero', '{"a":01}'],
    ['bare plus', '{"a":+1}'],
    ['NaN', '{"a":NaN}'],
    ['two values', '{} {}'],
    ['too deep', `${'['.repeat(20)}${']'.repeat(20)}`],
    ['empty', ''],
  ];
  for (const [label, text] of bad) {
    assert.equal(isStrictJson(text), false, label);
  }
  const good: [string, string][] = [
    ['escaped BMP character', '{"a":"\\u00e9"}'],
    ['escaped surrogate pair', '{"a":"\\ud83d\\ude00"}'],
    ['raw non-ASCII', '{"a":"é€"}'],
    ['raw astral character', '{"a":"😀"}'],
    ['all simple escapes', '{"a":"\\"\\\\\\/\\b\\f\\n\\r\\t"}'],
    ['numbers', '{"a":[0,-1,1.5,2e10,-3.25E-2]}'],
    ['literals and nesting', '{"a":{"b":[true,false,null,{}]},"c":[]}'],
    ['whitespace', ' \t\r\n{ "a" : 1 } \n'],
    ['same key in different objects', '{"a":{"a":1},"b":{"a":2}}'],
  ];
  for (const [label, text] of good) {
    assert.equal(isStrictJson(text), true, label);
  }
});

test('a duplicate-key allow-list is refused with a fixed code before any request', async () => {
  const text = rawAllowList(
    `{"\\u0072unId":${String(RUN_ID + 99)},"runId":${String(RUN_ID)},"runAttempt":1,"retained":null}`,
  );
  const o = await expectCode(world(), 'invalid-allowlist', { allowList: text });
  assert.equal(o.requests.length, 0);
  assert.equal(o.message.includes(String(RUN_ID + 99)), false);
});

test('an invalid or duplicate allow-list is refused before any request', async () => {
  for (const allowList of [
    allowListText([{ runId: RUN_ID }, { runId: RUN_ID }]),
    allowListWith((_, e) => (e.verdict = 'VERIFIED_PASS')),
  ]) {
    const o = await expectCode(world(), 'invalid-allowlist', { allowList });
    assert.equal(o.requests.length, 0);
  }
});

test('the allow-list must be a private file outside the repository', async () => {
  // Wrong mode.
  let box = sandbox();
  writePrivate(box.allowlist, allowListText([{ runId: RUN_ID }]));
  chmodSync(box.allowlist, 0o644);
  let o = await expectCode(world(), 'invalid-allowlist', { allowList: undefined }, box);
  assert.equal(o.requests.length, 0);
  box.cleanup();

  // Symlink to a valid private file.
  box = sandbox();
  const real = join(box.privateDir, 'real.json');
  writePrivate(real, allowListText([{ runId: RUN_ID }]));
  symlinkSync(real, box.allowlist);
  await expectCode(world(), 'invalid-allowlist', { allowList: undefined }, box);
  box.cleanup();

  // Hard link (two names for one file).
  box = sandbox();
  writePrivate(box.allowlist, allowListText([{ runId: RUN_ID }]));
  linkSync(box.allowlist, join(box.privateDir, 'second-name.json'));
  await expectCode(world(), 'invalid-allowlist', { allowList: undefined }, box);
  box.cleanup();

  // Inside the repository.
  box = sandbox();
  const inRepo = join(box.repo, 'allowlist.json');
  writePrivate(inRepo, allowListText([{ runId: RUN_ID }]));
  await expectCode(world(), 'invalid-allowlist', { args: { allowlist: inRepo } }, box);
  box.cleanup();

  // In a group-writable directory.
  box = sandbox();
  writePrivate(box.allowlist, allowListText([{ runId: RUN_ID }]));
  chmodSync(box.privateDir, 0o770);
  await expectCode(world(), 'invalid-allowlist', { allowList: undefined }, box);
  box.cleanup();

  // Owned by another user (simulated).
  o = await expectCode(world(), 'invalid-allowlist', {
    fs: {
      readHandle: (path, max) => {
        const r = nodePublisherFs.readHandle(path, max);
        return r.status === 'ok' ? { ...r, uid: r.uid + 1 } : r;
      },
    },
  });
  assert.equal(o.requests.length, 0);
});

test('the output parent must be an existing private directory outside the repository', async () => {
  const cases: [string, (box: Sandbox) => Partial<PublicationArgs>][] = [
    ['mode 0755', (box) => (chmodSync(box.out, 0o755), {})],
    ['missing', (box) => ({ outParent: join(box.root, 'missing') })],
    ['inside repository', (box) => ({ outParent: box.repo })],
    [
      'symlink',
      (box) => {
        const link = join(box.root, 'out-link');
        symlinkSync(box.out, link);
        return { outParent: link };
      },
    ],
    [
      '.git segment',
      (box) => {
        const dir = join(box.root, '.git');
        mkdirSync(dir, { mode: 0o700 });
        chmodSync(dir, 0o700);
        return { outParent: dir };
      },
    ],
    [
      'group-writable ancestor',
      (box) => {
        const mid = join(box.root, 'shared');
        const dir = join(mid, 'out');
        mkdirSync(dir, { recursive: true });
        chmodSync(mid, 0o777);
        chmodSync(dir, 0o700);
        return { outParent: dir };
      },
    ],
  ];
  for (const [label, setup] of cases) {
    const box = sandbox();
    try {
      const o = await publish(world(), { args: setup(box) }, box);
      assert.equal(o.result.code, 'unsafe-output-path', label);
      assert.equal(o.requests.length, 0, label);
    } finally {
      box.cleanup();
    }
  }
});

test('--evidence-dir is required exactly when a retained bundle is pinned', async () => {
  const box = sandbox();
  try {
    let o = await publish(
      world(),
      { allowList: allowListText([{ runId: RUN_ID, retained: 'a'.repeat(64) }]) },
      box,
    );
    assert.equal(o.result.code, 'usage');
    assert.equal(o.result.exitCode, 2);
    o = await publish(world(), { args: { evidenceDir: box.evidence } }, box);
    assert.equal(o.result.code, 'usage');
    assert.equal(o.requests.length, 0);
  } finally {
    box.cleanup();
  }
});

test('an unsafe evidence directory is refused', async () => {
  const box = sandbox();
  try {
    chmodSync(box.evidence, 0o755);
    const o = await publish(
      world(),
      {
        allowList: allowListText([{ runId: RUN_ID, retained: 'a'.repeat(64) }]),
        args: { evidenceDir: box.evidence },
      },
      box,
    );
    assert.equal(o.result.code, 'unsafe-evidence-dir');
    assert.equal(o.requests.length, 0);
  } finally {
    box.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Retained bundles
 * ------------------------------------------------------------------ */

test('a pinned retained bundle that agrees with fresh evidence is a cross-check only', async () => {
  const w = world();
  const box = sandbox();
  try {
    const pin = await retainBundle(w, box);
    const o = await publish(
      w,
      {
        allowList: allowListText([{ runId: RUN_ID, retained: pin }]),
        args: { evidenceDir: box.evidence },
      },
      box,
    );
    assert.equal(o.result.code, 'committed', o.message);
    const e = readGeneration(o).manifest.results[0];
    assert.equal(e?.gate.authenticity, 'BUILD_VERIFIED');
    assertNoLeak(o);
  } finally {
    box.cleanup();
  }
});

test('a retained bundle that disagrees with fresh evidence fails the build', async () => {
  const w = world();
  const box = sandbox();
  try {
    // The bundle records a verified pass; GitHub now reports a failed Gate.
    const pin = await retainBundle(w, box);
    const r = rw(w);
    r.run.conclusion = 'failure';
    (r.jobs[0] as Json).conclusion = 'failure';
    ((r.jobs[0] as Json).steps as Json[])[1] = {
      number: 9,
      name: 'Gate',
      status: 'completed',
      conclusion: 'failure',
    };
    r.archive = summaryZip(RUN_ID, {
      gateInputs: failingInputs(),
    });
    summaryArtifact(r).digest = sha256Digest(r.archive);
    summaryArtifact(r).size_in_bytes = r.archive.length;
    const o = await publish(
      w,
      {
        allowList: allowListText([{ runId: RUN_ID, retained: pin }]),
        args: { evidenceDir: box.evidence },
      },
      box,
    );
    assert.equal(o.result.code, 'retained-disagrees', o.message);
    assert.deepEqual(readdirSync(box.out), []);
  } finally {
    box.cleanup();
  }
});

/** Observed Gate inputs with the first one failed (consistent with VERIFIED_FAIL). */
function failingInputs(): Record<string, string> {
  const inputs: Record<string, string> = Object.fromEntries(
    GATE_INPUT_NAMES.map((name) => [name, 'success']),
  );
  inputs[GATE_INPUT_NAMES[0]] = 'failure';
  return inputs;
}

test('retained-bundle tampering, pin and metadata failures are rejected before any request', async () => {
  const cases: [string, (box: Sandbox, file: string, pin: string) => string][] = [
    [
      'altered byte',
      (_box, file, pin) => (writePrivate(file, `${readFileSync(file, 'utf8')} `), pin),
    ],
    ['wrong pin', () => 'b'.repeat(64)],
    ['mode 0644', (_box, file, pin) => (chmodSync(file, 0o644), pin)],
    ['mode 0400', (_box, file, pin) => (chmodSync(file, 0o400), pin)],
    [
      'symlink',
      (box, file, pin) => {
        const real = join(box.root, 'elsewhere.json');
        writePrivate(real, readFileSync(file));
        rmSync(file);
        symlinkSync(real, file);
        return pin;
      },
    ],
    ['hard link', (box, file, pin) => (linkSync(file, join(box.evidence, 'copy.json')), pin)],
    ['missing', (_box, file, pin) => (rmSync(file), pin)],
    [
      'forged and re-pinned',
      (_box, file) => {
        const forged = readFileSync(file, 'utf8').replace(
          '"SUMMARY_VERIFIED_ORIGIN"',
          '"SUMMARY_INFORMATIVE"',
        );
        writePrivate(file, forged);
        return sha256(forged);
      },
    ],
  ];
  for (const [label, tamper] of cases) {
    const w = world();
    const box = sandbox();
    try {
      const original = await retainBundle(w, box);
      const pin = tamper(box, join(box.evidence, bundleFileName(RUN_ID, 1)), original);
      const o = await publish(
        w,
        {
          allowList: allowListText([{ runId: RUN_ID, retained: pin }]),
          args: { evidenceDir: box.evidence },
        },
        box,
      );
      assert.equal(o.result.code, 'retained-rejected', label);
      assert.equal(o.requests.length, 0, label);
      assert.deepEqual(readdirSync(box.out), [], label);
    } finally {
      box.cleanup();
    }
  }
});

test('a retained bundle owned by another user is rejected (simulated owner)', async () => {
  const w = world();
  const box = sandbox();
  try {
    const pin = await retainBundle(w, box);
    const bundlePath = join(box.evidence, bundleFileName(RUN_ID, 1));
    const o = await publish(
      w,
      {
        allowList: allowListText([{ runId: RUN_ID, retained: pin }]),
        args: { evidenceDir: box.evidence },
        fs: {
          readHandle: (path, max) => {
            const r = nodePublisherFs.readHandle(path, max);
            return path === bundlePath && r.status === 'ok' ? { ...r, uid: r.uid + 1 } : r;
          },
        },
      },
      box,
    );
    assert.equal(o.result.code, 'retained-rejected');
  } finally {
    box.cleanup();
  }
});

test('a retained bundle never substitutes for unavailable GitHub evidence', async () => {
  const w = world();
  const box = sandbox();
  try {
    const pin = await retainBundle(w, box);
    w.runs.delete(RUN_ID); // every run endpoint now answers 404
    const o = await publish(
      w,
      {
        allowList: allowListText([{ runId: RUN_ID, retained: pin }]),
        args: { evidenceDir: box.evidence },
      },
      box,
    );
    assert.equal(o.result.code, 'evidence-unavailable');
    assert.deepEqual(readdirSync(box.out), []);
  } finally {
    box.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * GitHub evidence: the failure matrix
 * ------------------------------------------------------------------ */

const OPERATIONS: Record<string, (url: URL) => boolean> = {
  'run attempt': (u) => /\/actions\/runs\/\d+\/attempts\/\d+$/.test(u.pathname),
  jobs: (u) => /\/attempts\/\d+\/jobs$/.test(u.pathname),
  artifacts: (u) => /\/actions\/runs\/\d+\/artifacts$/.test(u.pathname),
  'main ref': (u) => u.pathname.endsWith('/git/ref/heads/main'),
  'compare (run head)': (u) => u.pathname.includes(`/compare/${HEAD}...`),
  'compare (source commit)': (u) => u.pathname.includes(`/compare/${SOURCE}...`),
  'artifact archive': (u) => /\/actions\/artifacts\/\d+\/zip$/.test(u.pathname),
};

test('a 404 from each GitHub operation fails with evidence-unavailable; nothing is omitted', async () => {
  for (const [label, matches] of Object.entries(OPERATIONS)) {
    const w = world();
    w.override = (url) => (matches(url) ? errorBody(404) : undefined);
    const o = await expectCode(w, 'evidence-unavailable', {});
    assert.ok(o.requests.length > 0, label);
  }
});

test('a 404 with a pinned retained bundle still fails with evidence-unavailable', async () => {
  for (const [label, matches] of Object.entries(OPERATIONS)) {
    const w = world();
    const box = sandbox();
    try {
      const pin = await retainBundle(w, box);
      w.override = (url) => (matches(url) ? errorBody(404) : undefined);
      await expectCode(
        w,
        'evidence-unavailable',
        {
          allowList: allowListText([{ runId: RUN_ID, retained: pin }]),
          args: { evidenceDir: box.evidence },
        },
        box,
      );
    } finally {
      box.cleanup();
    }
    assert.ok(label);
  }
});

test('permission failures fail with token-rejected', async () => {
  for (const status of [401, 403]) {
    for (const matches of Object.values(OPERATIONS)) {
      const w = world();
      w.override = (url) => (matches(url) ? errorBody(status) : undefined);
      await expectCode(w, 'token-rejected');
    }
  }
});

test('rate limits fail with rate-limited and nothing is retried', async () => {
  const limits: HttpResult[] = [
    errorBody(429),
    errorBody(403, { rateLimitRemaining: '0' }),
    errorBody(403, { retryAfter: '60' }),
  ];
  for (const limit of limits) {
    const w = world();
    let jobsCalls = 0;
    w.override = (url) => {
      if (!OPERATIONS.jobs?.(url)) return undefined;
      jobsCalls += 1;
      return limit;
    };
    await expectCode(w, 'rate-limited');
    assert.equal(jobsCalls, 1);
  }
});

test('transport failures and ambiguous metadata fail closed', async () => {
  const failures: [string, HttpResult][] = [
    ['timeout', { kind: 'error', error: 'timeout' }],
    ['network', { kind: 'error', error: 'network' }],
    ['500', errorBody(500)],
    ['malformed', { kind: 'response', status: 200, headers: NO_HEADERS, body: enc.encode('{') }],
  ];
  for (const [label, failure] of failures) {
    const w = world();
    w.override = (url) => (OPERATIONS['run attempt']?.(url) ? failure : undefined);
    const o = await expectCode(w, 'evidence-unavailable');
    assert.ok(o.requests.length > 0, label);
  }
  // Incomplete pagination of the artifact listing.
  const w = world();
  w.override = (url) =>
    OPERATIONS.artifacts?.(url) ? json(200, { total_count: 5, artifacts: [] }) : undefined;
  await expectCode(w, 'evidence-unavailable');
});

test('the source commit must be on main', async () => {
  for (const status of ['behind', 'diverged']) {
    const w = world();
    w.compare.set(SOURCE, {
      status,
      base_commit: { sha: SOURCE },
      merge_base_commit: { sha: status === 'behind' ? TIP : HEAD },
    });
    await expectCode(w, 'source-commit-not-on-main');
  }
});

test('pull-request origin fails the build unless explicitly isolated', async () => {
  const pr = (): World => {
    const w = world();
    Object.assign(rw(w).run, { event: 'pull_request', head_branch: 'feature' });
    rw(w).archive = summaryZip(RUN_ID, { event: 'pull_request', branch: 'feature' });
    summaryArtifact(rw(w)).digest = sha256Digest(rw(w).archive);
    summaryArtifact(rw(w)).size_in_bytes = rw(w).archive.length;
    return w;
  };
  await expectCode(pr(), 'untrusted-origin');
  const o = await publish(pr(), {
    allowList: allowListText([{ runId: RUN_ID }], true),
  });
  try {
    assert.equal(o.result.code, 'committed', o.message);
    const m = readGeneration(o).manifest;
    assert.deepEqual(m.results, []);
    assert.equal(m.untrustedOrigin.length, 1);
    assert.equal(m.untrustedOrigin[0]?.gate.state, 'UNTRUSTED_PROVENANCE');
    assert.equal(m.untrustedOrigin[0]?.metrics, null);
    assert.deepEqual(verifiedTotals(m), {});
  } finally {
    o.box.cleanup();
  }
});

test('PENDING and UNKNOWN verdicts fail the build', async () => {
  const pending = world();
  Object.assign(rw(pending).run, { status: 'in_progress', conclusion: null });
  await expectCode(pending, 'run-not-completed');

  const noTestJob = world();
  (rw(noTestJob).jobs[0] as Json).name = 'not-the-test-job';
  await expectCode(noTestJob, 'verdict-undetermined');

  const undecided = world();
  ((rw(undecided).jobs[0] as Json).steps as Json[]).pop(); // no Gate step
  await expectCode(undecided, 'verdict-undetermined');
});

test('identity contradictions fail with identity-mismatch', async () => {
  const attempt = world();
  rw(attempt).run.run_attempt = 2;
  await expectCode(attempt, 'identity-mismatch');

  const runId = world();
  rw(runId).run.id = RUN_ID + 7;
  await expectCode(runId, 'identity-mismatch');

  const jobSha = world();
  (rw(jobSha).jobs[0] as Json).head_sha = TIP;
  await expectCode(jobSha, 'identity-mismatch');
});

test('a digest mismatch fails the build', async () => {
  const w = world();
  summaryArtifact(rw(w)).digest = `sha256:${'0'.repeat(64)}`;
  await expectCode(w, 'digest-mismatch');
});

test('artifact substitution fails with summary-conflict', async () => {
  // The listing's summary artifact belongs to another run: never selected for
  // download, and reconciled as a conflict.
  const otherRun = world();
  (summaryArtifact(rw(otherRun)).workflow_run as Json).id = RUN_ID + 9;
  await expectCode(otherRun, 'summary-conflict');

  // A summary for another run inside the correctly bound artifact.
  const inner = world();
  rw(inner).archive = summaryZip(RUN_ID + 9);
  summaryArtifact(rw(inner)).digest = sha256Digest(rw(inner).archive);
  summaryArtifact(rw(inner)).size_in_bytes = rw(inner).archive.length;
  await expectCode(inner, 'summary-conflict');

  // Created outside the attempt window.
  const late = world();
  summaryArtifact(rw(late)).created_at = '2026-11-25T02:00:00Z';
  await expectCode(late, 'summary-conflict');
});

test('a redirect outside the storage allow-list fails the build', async () => {
  for (const location of [
    `https://evil.example.invalid/x.zip?sig=${SIGNATURE}`,
    `http://${STORAGE}/x.zip`,
    null,
  ]) {
    const w = world();
    w.location = () => location;
    await expectCode(w, 'storage-redirect-refused');
  }
});

test('an absent or expired summary is published without metrics', async () => {
  const absent = world();
  rw(absent).artifacts = rw(absent).artifacts.filter((a) => a.name !== 'quality-summary-1');
  const listed = world();
  summaryArtifact(rw(listed)).expired = true;
  const gone = world();
  gone.override = (url) => (OPERATIONS['artifact archive']?.(url) ? errorBody(410) : undefined);
  const cases: [World, string][] = [
    [absent, 'artifact-absent'],
    [listed, 'artifact-expired'],
    [gone, 'artifact-expired'],
  ];
  for (const [w, reason] of cases) {
    const o = await expectCode(w, 'committed', {}, sandbox());
    try {
      const e = readGeneration(o).manifest.results[0];
      assert.equal(e?.gate.state, 'VERIFIED_PASS');
      assert.equal(e?.summary.state, 'SUMMARY_UNAVAILABLE');
      assert.deepEqual(e?.summary.reasons, [reason]);
      assert.equal(e?.metrics, null);
    } finally {
      o.box.cleanup();
    }
  }
});

test('an artifact that was listed but not downloadable is unavailable evidence', async () => {
  const noDigest = world();
  summaryArtifact(rw(noDigest)).digest = null;
  await expectCode(noDigest, 'evidence-unavailable');

  const declaredTooLarge = world();
  summaryArtifact(rw(declaredTooLarge)).size_in_bytes = 7 * 1024 * 1024;
  await expectCode(declaredTooLarge, 'evidence-unavailable');
});

test('an invalid archive after a matching digest is published as SUMMARY_INVALID', async () => {
  const twoEntries = world();
  rw(twoEntries).archive = storedZip([
    { name: ENTRY_NAME, content: enc.encode('{}') },
    { name: 'extra.txt', content: enc.encode(CANARY) },
  ]);
  const notJson = world();
  rw(notJson).archive = storedZip([{ name: ENTRY_NAME, content: enc.encode(`x ${CANARY}`) }]);
  for (const w of [twoEntries, notJson]) {
    summaryArtifact(rw(w)).digest = sha256Digest(rw(w).archive);
    summaryArtifact(rw(w)).size_in_bytes = rw(w).archive.length;
    const o = await expectCode(w, 'committed', {}, sandbox());
    try {
      const e = readGeneration(o).manifest.results[0];
      assert.equal(e?.summary.state, 'SUMMARY_INVALID');
      assert.equal(e?.metrics, null);
      assert.equal(e?.artifact.integrity, 'verified-in-build');
    } finally {
      o.box.cleanup();
    }
  }
});

test('established failure outcomes are published and never counted as passes', async () => {
  const failed = world();
  rw(failed).run.conclusion = 'failure';
  (rw(failed).jobs[0] as Json).conclusion = 'failure';
  ((rw(failed).jobs[0] as Json).steps as Json[])[1] = {
    number: 9,
    name: 'Gate',
    status: 'completed',
    conclusion: 'failure',
  };
  rw(failed).archive = summaryZip(RUN_ID, {
    gateInputs: failingInputs(),
  });
  summaryArtifact(rw(failed)).digest = sha256Digest(rw(failed).archive);
  summaryArtifact(rw(failed)).size_in_bytes = rw(failed).archive.length;

  const conflict = world();
  (rw(conflict).jobs[0] as Json).conclusion = 'failure'; // Gate success, job failure

  for (const [w, state] of [
    [failed, 'VERIFIED_FAIL'],
    [conflict, 'CONFLICT'],
  ] as const) {
    const o = await expectCode(w, 'committed', {}, sandbox());
    try {
      const m = readGeneration(o).manifest;
      assert.equal(m.results[0]?.gate.state, state);
      assert.equal(verifiedTotals(m).VERIFIED_PASS, undefined);
    } finally {
      o.box.cleanup();
    }
  }
});

test('one failing entry fails the whole build; no allow-listed run is dropped', async () => {
  const w = world(RUN_ID, RUN_ID + 1);
  w.runs.delete(RUN_ID + 1);
  await expectCode(w, 'evidence-unavailable', {
    allowList: allowListText([{ runId: RUN_ID }, { runId: RUN_ID + 1 }]),
  });
});

/* ------------------------------------------------------------------ *
 * Generation output: exclusive claim, staging and commit
 * ------------------------------------------------------------------ */

/** The deterministic generation name for the default world and inputs. */
async function defaultGeneration(): Promise<string> {
  const o = await publish(world());
  try {
    assert.equal(o.result.code, 'committed');
    assert.ok(o.result.generation);
    return o.result.generation;
  } finally {
    o.box.cleanup();
  }
}

function inode(path: string): number {
  return lstatSync(path).ino;
}

function isStaging(name: string): boolean {
  return name.startsWith('.qvp-staging-');
}

/** Counts mkdirPrivate calls, split into the claim and staging directories. */
function countingMkdir(counts: { claim: number; staging: number }): Partial<PublisherFs> {
  return {
    mkdirPrivate: (path) => {
      if (isStaging(path.split('/').pop() ?? '')) counts.staging += 1;
      else counts.claim += 1;
      return nodePublisherFs.mkdirPrivate(path);
    },
  };
}

test('every pre-existing entry type at the generation name is refused and left untouched', async () => {
  const name = await defaultGeneration();
  const cases: [string, (target: string, box: Sandbox) => void][] = [
    ['empty directory', (t) => mkdirSync(t, { mode: 0o700 })],
    [
      'non-empty directory',
      (t) => {
        mkdirSync(t, { mode: 0o700 });
        writeFileSync(join(t, 'inside'), CANARY);
      },
    ],
    ['regular file', (t) => writeFileSync(t, CANARY)],
    ['symlink', (t, box) => symlinkSync(box.privateDir, t)],
    ['dangling symlink', (t, box) => symlinkSync(join(box.root, 'nowhere'), t)],
  ];
  for (const [label, plant] of cases) {
    const box = sandbox();
    try {
      const target = join(box.out, name);
      plant(target, box);
      const before = lstatSync(target);
      const counts = { claim: 0, staging: 0 };
      const o = await publish(world(), { fs: countingMkdir(counts) }, box);
      assert.equal(o.result.code, 'output-exists', label);
      const after = lstatSync(target);
      assert.equal(after.ino, before.ino, `${label}: same entry`);
      assert.equal(after.mode, before.mode, `${label}: same mode`);
      if (label === 'non-empty directory') {
        assert.equal(readFileSync(join(target, 'inside'), 'utf8'), CANARY);
      }
      if (label === 'regular file') assert.equal(readFileSync(target, 'utf8'), CANARY);
      assert.deepEqual(counts, { claim: 1, staging: 0 }, `${label}: no staging created`);
      assert.deepEqual(readdirSync(box.out), [name], label);
    } finally {
      box.cleanup();
    }
  }
});

test('an existing completed generation is never replaced or modified', async () => {
  const box = sandbox();
  try {
    const first = await publish(world(), {}, box);
    assert.equal(first.result.code, 'committed');
    const g = readGeneration(first);
    const before = { ino: inode(g.dir), manifest: readFileSync(join(g.dir, MANIFEST_FILE)) };
    const second = await publish(world(), {}, box);
    assert.equal(second.result.code, 'output-exists');
    assert.equal(inode(g.dir), before.ino);
    assert.deepEqual(readFileSync(join(g.dir, MANIFEST_FILE)), before.manifest);
    assert.deepEqual(readdirSync(box.out), [first.result.generation]);
  } finally {
    box.cleanup();
  }
});

test('two publishers racing for the same name: exactly one commits', async () => {
  const box = sandbox();
  try {
    const [a, b] = await Promise.all([publish(world(), {}, box), publish(world(), {}, box)]);
    assert.deepEqual([a.result.code, b.result.code].sort(), ['committed', 'output-exists']);
    const names = readdirSync(box.out);
    assert.equal(names.length, 1);
    assert.match(names[0] ?? '', GENERATION_NAME);
    assert.deepEqual(
      readdirSync(join(box.out, names[0] ?? '')).sort(),
      [BUILD_RECORD_FILE, MANIFEST_FILE].sort(),
    );
  } finally {
    box.cleanup();
  }
});

/** Runs with a hook that fires after the staged files are fsynced, before validation. */
async function withStagedHook(
  name: string,
  hook: (claim: string) => void,
  box: Sandbox,
): Promise<Outcome> {
  let fired = false;
  return publish(
    world(),
    {
      fs: {
        fsyncDir: (path) => {
          const ok = nodePublisherFs.fsyncDir(path);
          if (!fired && isStaging(path.split('/').pop() ?? '')) {
            fired = true;
            hook(join(box.out, name));
          }
          return ok;
        },
      },
    },
    box,
  );
}

test('a claim whose identity changed before validation fails and the substitute is kept', async () => {
  // The original claim is moved aside (its inode stays allocated), so the
  // substitute is guaranteed a different identity on every filesystem. A
  // remove-and-recreate may reuse the inode number (observed on Linux) and is
  // then indistinguishable by dev:ino: that case is the accepted residual
  // race documented by the RESIDUAL RACE test below.
  const name = await defaultGeneration();
  const box = sandbox();
  try {
    let substitute = -1;
    const o = await withStagedHook(
      name,
      (claim) => {
        renameSync(claim, join(box.out, 'moved-claim'));
        mkdirSync(claim, { mode: 0o700 });
        chmodSync(claim, 0o700);
        substitute = inode(claim);
      },
      box,
    );
    assert.equal(o.result.code, 'commit-failed');
    // Neither the substitute nor the moved original is deleted; staging is removed.
    assert.deepEqual(readdirSync(box.out).sort(), ['moved-claim', name].sort());
    assert.equal(inode(join(box.out, name)), substitute);
    assertNoLeak(o);
  } finally {
    box.cleanup();
  }
});

test('data inserted into the claim before the commit fails and is left untouched', async () => {
  const name = await defaultGeneration();
  const box = sandbox();
  try {
    let claimInode = -1;
    const o = await withStagedHook(
      name,
      (claim) => {
        claimInode = inode(claim);
        writeFileSync(join(claim, 'inserted'), CANARY);
      },
      box,
    );
    assert.equal(o.result.code, 'commit-failed');
    assert.deepEqual(readdirSync(box.out), [name]);
    assert.equal(inode(join(box.out, name)), claimInode);
    assert.equal(readFileSync(join(box.out, name, 'inserted'), 'utf8'), CANARY);
  } finally {
    box.cleanup();
  }
});

test('RESIDUAL RACE (accepted by ADR-0011): a same-user empty directory substituted at the rename boundary is replaced', async () => {
  // Node's rename is not a no-replace primitive. A process of the publisher's
  // own OS user that swaps the empty claim for its own empty directory after
  // the final validation loses that empty directory to the rename. This test
  // documents the accepted limitation; it does not assert it away.
  const box = sandbox();
  try {
    let substitute = -1;
    const o = await publish(
      world(),
      {
        fs: {
          rename: (from, to) => {
            rmSync(to, { recursive: true });
            mkdirSync(to, { mode: 0o700 });
            substitute = inode(to);
            return nodePublisherFs.rename(from, to);
          },
        },
      },
      box,
    );
    assert.equal(o.result.code, 'committed');
    const g = readGeneration(o);
    assert.notEqual(inode(g.dir), substitute, 'the empty substitute was replaced');
    assert.deepEqual(readdirSync(g.dir).sort(), [BUILD_RECORD_FILE, MANIFEST_FILE].sort());
  } finally {
    box.cleanup();
  }
});

test('a non-empty directory or a file swapped in at the rename boundary is never replaced', async () => {
  const swaps: [string, (to: string) => void][] = [
    [
      'non-empty directory',
      (to) => {
        mkdirSync(to);
        writeFileSync(join(to, MANIFEST_FILE), CANARY);
      },
    ],
    ['file', (to) => writeFileSync(to, CANARY)],
  ];
  for (const [label, plant] of swaps) {
    const box = sandbox();
    try {
      let planted = '';
      const o = await publish(
        world(),
        {
          fs: {
            rename: (from, to) => {
              rmSync(to, { recursive: true });
              plant(to);
              planted = to;
              return nodePublisherFs.rename(from, to);
            },
          },
        },
        box,
      );
      assert.equal(o.result.code, 'output-exists', label);
      const content =
        label === 'file'
          ? readFileSync(planted, 'utf8')
          : readFileSync(join(planted, MANIFEST_FILE), 'utf8');
      assert.equal(content, CANARY, label);
      // Staging removed; the planted entry (not this run's claim) kept.
      assert.deepEqual(readdirSync(box.out), [planted.split('/').pop()], label);
    } finally {
      box.cleanup();
    }
  }
});

test('handled failures remove only this run’s claim and staging', async () => {
  let writes = 0;
  const stagingOnly = (result: 'failed' | 'exists'): Partial<PublisherFs> => ({
    mkdirPrivate: (path) =>
      isStaging(path.split('/').pop() ?? '') ? result : nodePublisherFs.mkdirPrivate(path),
  });
  const cases: [string, string, Partial<PublisherFs>, Partial<PublisherDeps>][] = [
    ['claim mkdir fails', 'staging-failed', { mkdirPrivate: () => 'failed' }, {}],
    ['staging mkdir fails', 'staging-failed', stagingOnly('failed'), {}],
    ['staging name always taken', 'staging-failed', stagingOnly('exists'), {}],
    ['invalid staging id', 'staging-failed', {}, { randomId: () => '../escape' }],
    [
      'second file write fails',
      'staging-failed',
      {
        writeNewPrivate: (path, data) => {
          writes += 1;
          return writes % 2 === 0
            ? { status: 'failed' }
            : nodePublisherFs.writeNewPrivate(path, data);
        },
      },
      {},
    ],
    ['staging fsync fails', 'staging-failed', { fsyncDir: () => false }, {}],
    ['rename fails', 'commit-failed', { rename: () => 'failed' }, {}],
  ];
  for (const [label, code, fsOverride, depsOverride] of cases) {
    writes = 0;
    const o = await publish(world(), { fs: fsOverride, deps: depsOverride });
    try {
      assert.equal(o.result.code, code, label);
      assert.deepEqual(readdirSync(o.box.out), [], `${label}: claim and staging removed`);
    } finally {
      o.box.cleanup();
    }
  }
});

test('a foreign file in staging aborts the commit and is never deleted', async () => {
  const o = await publish(world(), {
    fs: {
      fsyncDir: (path) => {
        if (isStaging(path.split('/').pop() ?? '')) writeFileSync(join(path, 'foreign'), 'x');
        return nodePublisherFs.fsyncDir(path);
      },
    },
  });
  try {
    assert.equal(o.result.code, 'staging-failed');
    // The empty claim is removed; staging stays because it holds a file this
    // run did not create.
    const names = readdirSync(o.box.out);
    assert.equal(names.length, 1);
    assert.equal(isStaging(names[0] ?? ''), true);
    assert.deepEqual(readdirSync(join(o.box.out, names[0] ?? '')), ['foreign']);
  } finally {
    o.box.cleanup();
  }
});

/** Simulates a process killed mid-commit: nothing is cleaned up. */
const NO_CLEANUP: Partial<PublisherFs> = {
  removeFile: () => undefined,
  removeDir: () => undefined,
};

test('a crash after the exclusive claim leaves an empty claim; the next run refuses it', async () => {
  const name = await defaultGeneration();
  const box = sandbox();
  try {
    const crashed = await publish(
      world(),
      {
        fs: {
          ...NO_CLEANUP,
          mkdirPrivate: (path) =>
            isStaging(path.split('/').pop() ?? '') ? 'failed' : nodePublisherFs.mkdirPrivate(path),
        },
      },
      box,
    );
    assert.equal(crashed.result.code, 'staging-failed');
    const claim = join(box.out, name);
    assert.deepEqual(readdirSync(box.out), [name]);
    assert.deepEqual(readdirSync(claim), [], 'debris: an empty claim');
    const claimInode = inode(claim);
    const next = await publish(world(), {}, box);
    assert.equal(next.result.code, 'output-exists');
    assert.equal(inode(claim), claimInode, 'the debris is not touched');
  } finally {
    box.cleanup();
  }
});

test('a crash before the commit leaves claim and staging debris; the next run refuses', async () => {
  const name = await defaultGeneration();
  const box = sandbox();
  try {
    const crashed = await publish(world(), { fs: { ...NO_CLEANUP, rename: () => 'failed' } }, box);
    assert.equal(crashed.result.code, 'commit-failed');
    const names = readdirSync(box.out).sort();
    assert.equal(names.length, 2);
    const staging = names.find(isStaging) ?? '';
    assert.deepEqual(
      readdirSync(join(box.out, staging)).sort(),
      [BUILD_RECORD_FILE, MANIFEST_FILE].sort(),
    );
    assert.deepEqual(readdirSync(join(box.out, name)), []);
    const next = await publish(world(), {}, box);
    assert.equal(next.result.code, 'output-exists');
    assert.deepEqual(readdirSync(box.out).sort(), names, 'debris untouched; nothing added');
  } finally {
    box.cleanup();
  }
});

test('a failed parent fsync after the commit is reported, and the generation is left intact', async () => {
  const box = sandbox();
  try {
    const o = await publish(
      world(),
      {
        fs: {
          fsyncDir: (path) => (path === box.out ? false : nodePublisherFs.fsyncDir(path)),
        },
      },
      box,
    );
    assert.equal(o.result.code, 'commit-failed');
    const names = readdirSync(box.out);
    assert.equal(names.length, 1);
    assert.match(names[0] ?? '', GENERATION_NAME);
    assert.deepEqual(
      readdirSync(join(box.out, names[0] ?? '')).sort(),
      [BUILD_RECORD_FILE, MANIFEST_FILE].sort(),
    );
  } finally {
    box.cleanup();
  }
});

test('claim, staging and file modes stay exact under any umask', { skip: !POSIX }, async () => {
  for (const mask of [0o000, 0o002, 0o022, 0o077]) {
    const previous = process.umask(mask);
    try {
      const modes: number[] = [];
      let claimDir = '';
      const o = await publish(world(), {
        fs: {
          mkdirPrivate: (path) => {
            const r = nodePublisherFs.mkdirPrivate(path);
            if (!isStaging(path.split('/').pop() ?? '')) claimDir = path;
            return r;
          },
          fsyncDir: (path) => {
            if (isStaging(path.split('/').pop() ?? '') && claimDir !== '') {
              modes.push(lstatSync(claimDir).mode & 0o7777, lstatSync(path).mode & 0o7777);
            }
            return nodePublisherFs.fsyncDir(path);
          },
        },
      });
      try {
        assert.equal(o.result.code, 'committed', `umask ${mask.toString(8)}`);
        assert.deepEqual(modes, [0o700, 0o700], `claim and staging at umask ${mask.toString(8)}`);
        const g = readGeneration(o);
        assert.equal(lstatSync(g.dir).mode & 0o7777, 0o700);
        for (const f of readdirSync(g.dir)) {
          assert.equal(lstatSync(join(g.dir, f)).mode & 0o7777, 0o600);
        }
      } finally {
        o.box.cleanup();
      }
    } finally {
      process.umask(previous);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Production surface
 * ------------------------------------------------------------------ */

test('the CLI accepts exactly the documented options and no evidence input', () => {
  const good = [
    '--allowlist',
    '/a/allow.json',
    '--out-parent',
    '/a/out',
    '--source-commit',
    SOURCE,
    '--built-at',
    BUILT_AT,
  ];
  assert.equal(parsePublicationArgs(good).ok, true);
  assert.equal(parsePublicationArgs([...good, '--evidence-dir', '/a/evidence']).ok, true);
  const bad: string[][] = [
    [],
    good.slice(0, -1),
    [...good, '--allowlist', '/b/allow.json'],
    [...good, 'positional'],
    ...['--collected', '--verdict', '--authenticity', '--policy', '--token', '--http', '--fs'].map(
      (flag) => [...good, flag, 'x'],
    ),
    good.map((v) => (v === '/a/out' ? 'relative/out' : v)),
    good.map((v) => (v === '/a/out' ? '/a/../out' : v)),
    good.map((v) => (v === SOURCE ? 'HEAD' : v)),
    good.map((v) => (v === '/a/allow.json' ? '--out-parent' : v)),
  ];
  for (const argv of bad) assert.equal(parsePublicationArgs(argv).ok, false, argv.join(' '));
});

test('the module exposes no evidence, verdict or authenticity input', async () => {
  // runPublication has exactly two parameters: parsed options and adapters.
  assert.equal(runPublication.length, 2);
  const o = await publish(world(), {
    args: {
      verdict: 'VERIFIED_PASS',
      authenticity: 'BUILD_VERIFIED',
      collected: {},
    } as unknown as Partial<PublicationArgs>,
  });
  try {
    // Extra properties are ignored; GitHub evidence alone decides.
    assert.equal(o.result.code, 'committed');
    assert.equal(readGeneration(o).manifest.results[0]?.gate.authenticity, 'BUILD_VERIFIED');
  } finally {
    o.box.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Git probe (real git, temporary repository)
 * ------------------------------------------------------------------ */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test(
  'the git probe reports HEAD and a clean or dirty tree without inherited configuration',
  { skip: !hasGit() },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'qvp-git-')));
    try {
      const git = (...args: string[]): string =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      git('init', '-q');
      writeFileSync(join(root, 'file.txt'), 'x\n');
      git('add', 'file.txt');
      git('commit', '-q', '-m', 'synthetic');
      const head = git('rev-parse', 'HEAD').trim();
      const probe = nodeGit(root);
      assert.equal(probe.head(), head);
      assert.equal(probe.status(), '');
      writeFileSync(join(root, 'untracked.txt'), 'y\n');
      assert.match(probe.status() ?? '', /\?\? untracked\.txt/);
      rmSync(join(root, 'untracked.txt'));
      writeFileSync(join(root, 'file.txt'), 'changed\n');
      assert.match(probe.status() ?? '', /M file\.txt/);
      // Not a repository: no HEAD.
      const empty = realpathSync(mkdtempSync(join(tmpdir(), 'qvp-nogit-')));
      try {
        assert.equal(nodeGit(empty).head(), undefined);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

/* ------------------------------------------------------------------ *
 * P1 omission guard (isolated, through the test-only builder seam)
 * ------------------------------------------------------------------ */

async function publishWithBuilder(
  builder: typeof buildPublicationManifest,
  allowList = allowListText([{ runId: RUN_ID }]),
  w = world(),
): Promise<Outcome> {
  const box = sandbox();
  writePrivate(box.allowlist, allowList);
  const recorder = fakeHttp(w);
  const result = await runPublicationWith(
    {
      allowlist: box.allowlist,
      outParent: box.out,
      sourceCommit: SOURCE,
      builtAt: BUILT_AT,
      evidenceDir: null,
    },
    {
      runtime: { execArgv: [], isSet: () => false },
      token: TOKEN,
      now: () => NOW,
      nodeVersion: 'v24.0.0',
      repoRoot: box.repo,
      http: recorder.http,
      git: { head: () => SOURCE, status: () => '' },
      fs: nodePublisherFs,
      randomId,
    },
    builder,
  );
  return { result, requests: recorder.requests, box, message: resultMessage(result) };
}

test('the seam with the real builder behaves exactly like runPublication', async () => {
  const o = await publishWithBuilder(buildPublicationManifest);
  try {
    assert.equal(o.result.code, 'committed');
  } finally {
    o.box.cleanup();
  }
});

test('a non-empty P1 omission list is internal-error and commits nothing', async () => {
  for (const reason of ['run-not-retrievable', 'untrusted-origin-excluded'] as const) {
    const o = await publishWithBuilder((input) => {
      const real = buildPublicationManifest(input);
      assert.equal(real.status, 'built');
      return real.status === 'built'
        ? { ...real, omitted: [{ runId: RUN_ID + 1, runAttempt: 1, reason }] }
        : real;
    });
    try {
      assert.equal(o.result.code, 'internal-error', reason);
      assert.deepEqual(readdirSync(o.box.out), [], 'no generation or debris');
      assertNoLeak(o);
      assert.equal(o.message.includes(String(RUN_ID + 1)), false);
    } finally {
      o.box.cleanup();
    }
  }
});

test('a published count that differs from the allow-list is internal-error', async () => {
  const shrink = (input: Parameters<typeof buildPublicationManifest>[0]) => {
    const real = buildPublicationManifest(input);
    if (real.status !== 'built') return real;
    return { ...real, manifest: { ...real.manifest, results: real.manifest.results.slice(1) } };
  };
  const o = await publishWithBuilder(
    shrink,
    allowListText([{ runId: RUN_ID }, { runId: RUN_ID + 1 }]),
    world(RUN_ID, RUN_ID + 1),
  );
  try {
    assert.equal(o.result.code, 'internal-error');
    assert.deepEqual(readdirSync(o.box.out), []);
  } finally {
    o.box.cleanup();
  }
});

test('the production entry point cannot reach the builder seam', () => {
  // The unit tests run from the repository root (`npm run test:unit`).
  const entry = readFileSync(join(process.cwd(), 'scripts', 'build-publication.ts'), 'utf8');
  assert.equal(entry.includes('runPublicationWith'), false);
  assert.equal(entry.includes('buildPublicationManifest'), false);
  assert.match(entry, /runPublication\(parsed\.args, \{/);
  // The CLI parser has no option that could carry a builder.
  const base = [
    '--allowlist',
    '/a/allow.json',
    '--out-parent',
    '/a/out',
    '--source-commit',
    SOURCE,
    '--built-at',
    BUILT_AT,
  ];
  for (const flag of ['--builder', '--manifest-builder', '--build-manifest']) {
    assert.equal(parsePublicationArgs([...base, flag, 'x']).ok, false, flag);
  }
});
