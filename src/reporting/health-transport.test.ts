/**
 * Unit tests for the live README health transport (ADR-0013, Phase C5B),
 * over a synthetic HTTP adapter. No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMPARE_FILE_LIMIT, createHealthTransport } from './health-transport.ts';
import { API_ORIGIN, type HttpAdapter, type HttpRequest, type HttpResult } from './verdict-cli.ts';

const REPO = 'example-owner/example-repo';
const TOKEN = `ghp_TOKENCANARY${'7'.repeat(24)}`;
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RUN_ID = 42;

const enc = new TextEncoder();
const headers = { location: null, rateLimitRemaining: null, retryAfter: null };

function json(value: unknown, status = 200): HttpResult {
  return { kind: 'response', status, headers, body: enc.encode(JSON.stringify(value)) };
}

/** Routes by path (after the repository prefix) and records every request. */
function http(routes: (path: string) => HttpResult | undefined): HttpAdapter & {
  requests: HttpRequest[];
} {
  const requests: HttpRequest[] = [];
  return {
    requests,
    get: (request) => {
      requests.push(request);
      const prefix = `${API_ORIGIN}/repos/${REPO}`;
      const path = request.url.startsWith(prefix) ? request.url.slice(prefix.length) : request.url;
      return Promise.resolve(routes(path) ?? json({ message: 'not found' }, 404));
    },
  };
}

function transport(routes: (path: string) => HttpResult | undefined) {
  const adapter = http(routes);
  return {
    t: createHealthTransport({ token: TOKEN, repository: REPO, branch: 'main', http: adapter }),
    adapter,
  };
}

function job(id: number, completedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    run_id: RUN_ID,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    completed_at: completedAt,
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * Composition and credentials
 * ------------------------------------------------------------------ */

test('the operator transport is composed unchanged and an invalid configuration throws', () => {
  const { t } = transport(() => undefined);
  for (const name of [
    'getRunAttempt',
    'listJobs',
    'listArtifacts',
    'downloadArtifact',
    'resolveBranchTip',
    'compare',
  ]) {
    assert.equal(typeof (t as unknown as Record<string, unknown>)[name], 'function', name);
  }
  assert.throws(() =>
    createHealthTransport({
      token: TOKEN,
      repository: 'not a repo',
      branch: 'main',
      http: http(() => undefined),
    }),
  );
});

test('every added request goes to the API origin with the token and never elsewhere', async () => {
  const { t, adapter } = transport((path) =>
    path === `/actions/runs/${String(RUN_ID)}` ? json({ id: RUN_ID, run_attempt: 2 }) : undefined,
  );
  await t.getLatestAttempt(RUN_ID);
  await t.getAttemptCompletion(RUN_ID, 1);
  await t.listChangedFiles(BASE, HEAD);
  assert.equal(adapter.requests.length, 3);
  for (const request of adapter.requests) {
    assert.ok(request.url.startsWith(`${API_ORIGIN}/repos/${REPO}/`), request.url);
    assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!request.url.includes(TOKEN));
  }
});

/* ------------------------------------------------------------------ *
 * Latest attempt
 * ------------------------------------------------------------------ */

test('latest attempt is read from the run record and validated', async () => {
  const good = transport(() => json({ id: RUN_ID, run_attempt: 3 }));
  assert.deepEqual(await good.t.getLatestAttempt(RUN_ID), { status: 'ok', value: 3 });
  for (const body of [
    { id: RUN_ID + 1, run_attempt: 3 },
    { id: RUN_ID, run_attempt: 0 },
    { id: RUN_ID },
    [],
  ]) {
    const r = await transport(() => json(body)).t.getLatestAttempt(RUN_ID);
    assert.equal(r.status, 'failed', JSON.stringify(body));
  }
  assert.deepEqual(await transport(() => json({}, 404)).t.getLatestAttempt(RUN_ID), {
    status: 'failed',
    reason: 'not-found',
  });
  assert.equal((await transport(() => undefined).t.getLatestAttempt(0)).status, 'failed');
});

/* ------------------------------------------------------------------ *
 * Attempt completion
 * ------------------------------------------------------------------ */

function jobsRoutes(pages: unknown[][], total: number | number[]) {
  return (path: string): HttpResult | undefined => {
    const match = /\/jobs\?per_page=100&page=(\d+)$/.exec(path);
    if (match === null) return undefined;
    const page = Number(match[1]);
    const totals = Array.isArray(total) ? total : pages.map(() => total);
    return json({ total_count: totals[page - 1] ?? totals[0], jobs: pages[page - 1] ?? [] });
  };
}

test('completion is the latest completed_at over every job of every page', async () => {
  const pages = [
    [job(1, '2026-11-28T16:00:17Z'), job(2, '2026-11-28T15:57:40Z')],
    [job(3, '2026-11-28T16:00:29Z')],
  ];
  const { t } = transport(jobsRoutes(pages, 3));
  assert.deepEqual(await t.getAttemptCompletion(RUN_ID, 1), {
    status: 'ok',
    value: '2026-11-28T16:00:29Z',
  });
});

test('incomplete, unfinished or malformed job listings make the completion unavailable', async () => {
  const cases: [unknown[][], number | number[], string][] = [
    [[[job(1, '2026-11-28T16:00:17Z')]], 2, 'incomplete-pagination'],
    [
      [[job(1, '2026-11-28T16:00:17Z')], [job(2, '2026-11-28T16:00:18Z')]],
      [2, 3],
      'incomplete-pagination',
    ],
    [[[job(1, '2026-11-28T16:00:17Z', { status: 'in_progress' })]], 1, 'malformed'],
    [[[job(1, '2026-11-28T16:00:17Z', { run_attempt: 2 })]], 1, 'malformed'],
    [[[job(1, '2026-02-30T16:00:17Z')]], 1, 'malformed'],
    [[[job(1, '2026-11-28T16:00:17.000Z')]], 1, 'malformed'],
    [[[{ ...job(1, 'x'), completed_at: null }]], 1, 'malformed'],
    [[[]], 0, 'malformed'],
  ];
  for (const [pages, total, reason] of cases) {
    const r = await transport(jobsRoutes(pages, total)).t.getAttemptCompletion(RUN_ID, 1);
    assert.deepEqual(r, { status: 'failed', reason }, JSON.stringify(pages));
  }
});

test('duplicate jobs, foreign-run jobs and invalid job ids make the completion unavailable', async () => {
  const a = job(1, '2026-11-28T16:00:17Z');
  const b = job(2, '2026-11-28T16:00:18Z');
  const cases: [unknown[][], number][] = [
    [[[a, a]], 2], // duplicate within a page
    [[[a], [a]], 2], // duplicate across pages
    [
      [
        [a, b],
        [a, b],
      ],
      4,
    ], // a repeated page
    [[[a, job(2, '2026-11-28T16:00:18Z', { run_id: RUN_ID + 1 })]], 2], // foreign run
    [[[a, { ...b, run_id: undefined }]], 2],
    [[[a, { ...b, id: 0 }]], 2],
    [[[a, { ...b, id: 1.5 }]], 2],
    [[[a, { ...b, id: '2' }]], 2],
  ];
  for (const [pages, total] of cases) {
    const r = await transport(jobsRoutes(pages, total)).t.getAttemptCompletion(RUN_ID, 1);
    assert.deepEqual(
      r,
      { status: 'failed', reason: 'malformed' },
      JSON.stringify(pages).slice(0, 120),
    );
  }
});

test('job pagination is capped and never assumed complete', async () => {
  // Unique ids on every page, so only the page cap can stop the listing.
  const page = (p: number) =>
    Array.from({ length: 100 }, (_, i) => job(p * 100 + i + 1, '2026-11-28T16:00:17Z'));
  const { t, adapter } = transport(
    jobsRoutes(
      Array.from({ length: 20 }, (_, p) => page(p)),
      5000,
    ),
  );
  assert.deepEqual(await t.getAttemptCompletion(RUN_ID, 1), {
    status: 'failed',
    reason: 'incomplete-pagination',
  });
  assert.equal(adapter.requests.length, 10);
});

/* ------------------------------------------------------------------ *
 * Changed files
 * ------------------------------------------------------------------ */

function compareBody(files: unknown, overrides: Record<string, unknown> = {}) {
  return {
    status: 'ahead',
    base_commit: { sha: BASE },
    merge_base_commit: { sha: BASE },
    files,
    ...overrides,
  };
}

test('changed files of a descendant comparison are returned with renames', async () => {
  const { t } = transport(() =>
    json(
      compareBody([
        { filename: 'README.md', status: 'modified', patch: 'secret patch text' },
        { filename: 'docs/new.md', status: 'renamed', previous_filename: 'docs/old.md' },
      ]),
    ),
  );
  assert.deepEqual(await t.listChangedFiles(BASE, HEAD), {
    status: 'ok',
    value: {
      complete: true,
      files: [
        { filename: 'README.md', status: 'modified', previousFilename: null },
        { filename: 'docs/new.md', status: 'renamed', previousFilename: 'docs/old.md' },
      ],
    },
  });
});

test("a list at GitHub's file limit is never marked complete", async () => {
  const files = Array.from({ length: COMPARE_FILE_LIMIT }, (_, i) => ({
    filename: `docs/f${String(i)}.md`,
    status: 'modified',
  }));
  const r = await transport(() => json(compareBody(files))).t.listChangedFiles(BASE, HEAD);
  assert.ok(r.status === 'ok');
  assert.equal(r.value.complete, false);
  const below = await transport(() => json(compareBody(files.slice(1)))).t.listChangedFiles(
    BASE,
    HEAD,
  );
  assert.ok(below.status === 'ok' && below.value.complete);
});

test('diverged, behind, mismatched or malformed comparisons are unavailable', async () => {
  const bodies = [
    compareBody([], { status: 'diverged' }),
    compareBody([], { status: 'behind' }),
    compareBody([], { merge_base_commit: { sha: HEAD } }),
    compareBody([], { base_commit: { sha: HEAD } }),
    compareBody('nope'),
    compareBody([{ filename: 7, status: 'modified' }]),
    compareBody([{ filename: 'a.md' }]),
    [],
  ];
  for (const body of bodies) {
    const r = await transport(() => json(body)).t.listChangedFiles(BASE, HEAD);
    assert.equal(r.status, 'failed', JSON.stringify(body).slice(0, 80));
  }
  assert.deepEqual(
    await transport(() => json(compareBody(undefined, { status: 'identical' }))).t.listChangedFiles(
      BASE,
      HEAD,
    ),
    {
      status: 'ok',
      value: { files: [], complete: true },
    },
  );
  assert.equal((await transport(() => undefined).t.listChangedFiles('x', HEAD)).status, 'failed');
});

test('oversized, non-JSON, rate-limited and redirected responses fail with fixed codes', async () => {
  const tooLarge: HttpResult = { kind: 'error', error: 'too-large' };
  assert.deepEqual(await transport(() => tooLarge).t.listChangedFiles(BASE, HEAD), {
    status: 'failed',
    reason: 'malformed',
  });
  const notJson: HttpResult = {
    kind: 'response',
    status: 200,
    headers,
    body: enc.encode('<html>'),
  };
  assert.deepEqual(await transport(() => notJson).t.getLatestAttempt(RUN_ID), {
    status: 'failed',
    reason: 'malformed',
  });
  const limited: HttpResult = {
    kind: 'response',
    status: 403,
    headers: { ...headers, rateLimitRemaining: '0' },
    body: new Uint8Array(),
  };
  assert.deepEqual(await transport(() => limited).t.getLatestAttempt(RUN_ID), {
    status: 'failed',
    reason: 'rate-limited',
  });
  const redirect: HttpResult = {
    kind: 'response',
    status: 302,
    headers: { ...headers, location: 'https://evil.example/' },
    body: new Uint8Array(),
  };
  const r = await transport(() => redirect).t.getLatestAttempt(RUN_ID);
  assert.equal(r.status, 'failed');
});
