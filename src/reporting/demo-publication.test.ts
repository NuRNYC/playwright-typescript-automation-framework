/**
 * Unit tests for the synthetic demonstration publication (ADR-0011 P4).
 *
 * Same conventions as the other unit tests (ADR-0002). Everything is
 * synthetic and in memory; no real publication, token, git or network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CANARY } from './fixtures.ts';
import { outputScan, serializeManifest, type PublicationManifest } from './publication-manifest.ts';
import { parsePublication } from './publication-view.ts';
import {
  DEMO_BUILT_AT,
  DEMO_HEAD_SHA,
  DEMO_POLICY,
  DEMO_RUN_IDS,
  DEMO_SCENARIOS,
  DEMO_SOURCE_COMMIT,
  demoBundles,
  demoPublicationText,
  isSyntheticOnlyDemo,
  type DemoScenario,
} from './demo-publication.ts';

function demo() {
  const out = demoPublicationText();
  assert.equal(out.status, 'ok');
  if (out.status !== 'ok') throw new Error('unreachable');
  return out;
}

type Json = Record<string, unknown>;

function clone(m: PublicationManifest): Json {
  return JSON.parse(JSON.stringify(m)) as Json;
}

function entry(m: Json, i: number): Json {
  return ((m.synthetic as Json).results as Json[])[i] as Json;
}

/* ------------------------------------------------------------------ *
 * Generator output
 * ------------------------------------------------------------------ */

test('the demonstration manifest is deterministic and canonical', () => {
  const a = demo();
  const b = demo();
  assert.equal(a.text, b.text);
  assert.equal(serializeManifest(a.manifest), a.text);
  const parsed = parsePublication(a.text);
  assert.equal(parsed.state, 'valid');
  assert.equal(Object.isFrozen(a), true);
});

test('the build metadata is the fixed, fictional, illustrative set', () => {
  const m = demo().manifest;
  assert.equal(m.manifestSchemaVersion, '1.0.0');
  assert.equal(m.kind, 'quality-verdict-publication');
  assert.equal(m.build.sourceCommit, '0'.repeat(40));
  assert.equal(DEMO_SOURCE_COMMIT, '0'.repeat(40));
  assert.equal(m.build.builtAt, DEMO_BUILT_AT);
  assert.equal(DEMO_BUILT_AT, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(m.build.policy, DEMO_POLICY);
  assert.equal(m.build.policy.repositoryFullName, 'example-owner/example-demo');
  assert.equal(m.build.policy.workflowPath, '.github/workflows/demo.yml');
});

test('the manifest is synthetic-only: no real, untrusted, retained or verified claims', () => {
  const m = demo().manifest;
  assert.deepEqual(m.results, []);
  assert.deepEqual(m.untrustedOrigin, []);
  assert.equal(m.synthetic?.label, 'SYNTHETIC DEMONSTRATION DATA');
  const entries = m.synthetic?.results ?? [];
  assert.equal(entries.length, 6);
  for (const e of entries) {
    assert.equal(e.gate.authenticity, 'SYNTHETIC');
    assert.equal(e.gate.freshness, 'NOT_APPLICABLE');
    assert.equal(e.gate.verifiedAt, null);
    assert.equal(e.artifact.digest, null);
    assert.equal(e.artifact.integrity, 'not-checked');
    assert.notEqual(e.summary.state, 'SUMMARY_VERIFIED_ORIGIN');
    assert.notEqual(e.summary.label, 'verified-origin');
    assert.equal(e.headSha, DEMO_HEAD_SHA);
    if (e.metrics !== null) {
      assert.equal(e.metrics.authenticity, 'SYNTHETIC');
      assert.equal(e.metrics.freshness, 'NOT_APPLICABLE');
    }
  }
  const text = demo().text;
  for (const marker of [
    'BUILD_VERIFIED',
    'RETAINED_UNAUTHENTICATED',
    'SUMMARY_VERIFIED_ORIGIN',
    'verified-in-build',
  ]) {
    assert.equal(text.includes(marker), false, marker);
  }
  assert.equal(isSyntheticOnlyDemo(m), true);
});

test('the six scenarios have the approved verdict, summary and metrics mapping', () => {
  const entries = demo().manifest.synthetic?.results ?? [];
  const expected = [
    [
      9_000_001,
      'push',
      'VERIFIED_PASS',
      ['gate-success'],
      'SUMMARY_INFORMATIVE',
      ['digest-contract-unconfirmed'],
      true,
    ],
    [
      9_000_002,
      'push',
      'VERIFIED_FAIL',
      ['gate-failure'],
      'SUMMARY_INFORMATIVE',
      ['digest-contract-unconfirmed'],
      true,
    ],
    [
      9_000_003,
      'push',
      'UNKNOWN',
      ['gate-not-decisive'],
      'SUMMARY_INFORMATIVE',
      ['verdict-not-trusted'],
      true,
    ],
    [
      9_000_004,
      'push',
      'CANCELLED',
      ['run-cancelled'],
      'SUMMARY_UNAVAILABLE',
      ['artifact-absent'],
      false,
    ],
    [
      9_000_005,
      'push',
      'VERIFIED_PASS',
      ['gate-success'],
      'SUMMARY_UNAVAILABLE',
      ['artifact-expired'],
      false,
    ],
    [
      9_000_006,
      'pull_request',
      'UNTRUSTED_PROVENANCE',
      ['provenance-event'],
      'SUMMARY_UNAVAILABLE',
      ['artifact-absent'],
      false,
    ],
  ];
  assert.deepEqual(
    entries.map((e) => [
      e.runId,
      e.event,
      e.gate.state,
      e.gate.reasons,
      e.summary.state,
      e.summary.reasons,
      e.metrics !== null,
    ]),
    expected,
  );
  assert.deepEqual(
    [...DEMO_RUN_IDS],
    expected.map((x) => x[0]),
  );
  assert.deepEqual(
    DEMO_SCENARIOS.map((s) => s.title),
    [
      'Successful Gate',
      'Failed Gate',
      'Unknown evidence',
      'Cancelled execution',
      'Missing summary',
      'Untrusted provenance',
    ],
  );
  // Synthetic metrics use the existing counting units and satisfy their invariants.
  const m = entries[0]?.metrics;
  assert.ok(m !== null && m !== undefined);
  assert.ok(
    m.totals.executions >= m.totals.instances && m.totals.instances >= m.totals.definitions,
  );
});

test('every scenario passes the committed strict bundle parser', () => {
  const bundles = demoBundles();
  assert.equal(bundles?.length, 6);
  for (const b of bundles ?? []) assert.equal(b.authenticity, 'UNAUTHENTICATED');
});

test('generation needs no network, token or clock', () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('network used');
  };
  try {
    assert.equal(demoPublicationText().status, 'ok');
  } finally {
    globalThis.fetch = original;
  }
  const text = demo().text;
  assert.equal(outputScan(text), true);
  assert.equal(text.includes(CANARY), false);
});

/* ------------------------------------------------------------------ *
 * Fail-closed generation
 * ------------------------------------------------------------------ */

test('a broken invariant fails closed with the fixed code', () => {
  const failed = { status: 'failed', code: 'demo-generation-failed' };
  assert.deepEqual(demoPublicationText([]), failed);
  const wrongOutcome: DemoScenario = {
    ...(DEMO_SCENARIOS[0] as DemoScenario),
    gate: { state: 'VERIFIED_FAIL', reasons: ['gate-failure'] },
  };
  assert.deepEqual(demoPublicationText([wrongOutcome]), failed);
  const wrongSummary: DemoScenario = { ...(DEMO_SCENARIOS[3] as DemoScenario), metrics: true };
  assert.deepEqual(demoPublicationText([wrongSummary]), failed);
  const throwing: DemoScenario = {
    ...(DEMO_SCENARIOS[0] as DemoScenario),
    evidence: () => {
      throw new Error(`boom ${CANARY}`);
    },
  };
  const out = demoPublicationText([throwing]);
  assert.deepEqual(out, failed);
  assert.equal(JSON.stringify(out).includes(CANARY), false);
  // A duplicated scenario is refused by the P1 builder.
  const first = DEMO_SCENARIOS[0] as DemoScenario;
  assert.deepEqual(demoPublicationText([first, first]), failed);
});

/* ------------------------------------------------------------------ *
 * Demo-only policy
 * ------------------------------------------------------------------ */

test('the demo policy refuses every mixed or mislabelled manifest', () => {
  const base = demo().manifest;
  const cases: [string, (m: Json) => void][] = [
    ['real result', (m) => (m.results = [entry(m, 0)])],
    ['untrusted-origin result', (m) => (m.untrustedOrigin = [entry(m, 5)])],
    ['no synthetic section', (m) => (m.synthetic = null)],
    ['empty synthetic section', (m) => ((m.synthetic as Json).results = [])],
    ['wrong label', (m) => ((m.synthetic as Json).label = 'DEMO')],
    ['real source commit', (m) => ((m.build as Json).sourceCommit = 'c0ffee'.padEnd(40, '0'))],
    ['BUILD_VERIFIED', (m) => ((entry(m, 0).gate as Json).authenticity = 'BUILD_VERIFIED')],
    ['retained', (m) => ((entry(m, 0).gate as Json).authenticity = 'RETAINED_UNAUTHENTICATED')],
    ['CURRENT freshness', (m) => ((entry(m, 0).gate as Json).freshness = 'CURRENT')],
    ['verification time', (m) => ((entry(m, 0).gate as Json).verifiedAt = DEMO_BUILT_AT)],
    ['digest', (m) => ((entry(m, 0).artifact as Json).digest = `sha256:${'ab'.repeat(32)}`)],
    ['checked integrity', (m) => ((entry(m, 0).artifact as Json).integrity = 'verified-in-build')],
    [
      'verified-origin summary',
      (m) =>
        (entry(m, 0).summary = {
          state: 'SUMMARY_VERIFIED_ORIGIN',
          reasons: ['verified-origin'],
          label: 'verified-origin',
        }),
    ],
    [
      'verified-origin state without its label',
      (m) =>
        (entry(m, 0).summary = {
          state: 'SUMMARY_VERIFIED_ORIGIN',
          reasons: ['verified-origin'],
          label: 'unverified-origin',
        }),
    ],
    ['verified metrics', (m) => ((entry(m, 0).metrics as Json).authenticity = 'BUILD_VERIFIED')],
    ['current metrics', (m) => ((entry(m, 0).metrics as Json).freshness = 'CURRENT')],
  ];
  for (const [name, change] of cases) {
    const m = clone(base);
    change(m);
    assert.equal(isSyntheticOnlyDemo(m as unknown as PublicationManifest), false, name);
  }
  assert.equal(isSyntheticOnlyDemo(clone(base) as unknown as PublicationManifest), true);
});
