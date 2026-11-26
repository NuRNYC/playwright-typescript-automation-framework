/**
 * Unit tests for the strict verdict-bundle parser (ADR-0011 P1).
 *
 * Same conventions as the other unit tests (ADR-0002). Every bundle is
 * synthetic: produced by the committed operator functions (`buildBundle`,
 * `serializeBundle`, `reconcileCollected`) from synthetic evidence shaped
 * like the transport output, or a hand-edited copy of one. No retained local
 * bundle is read and nothing contacts GitHub.
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
  AncestryEvidence,
  ArchiveEvidence,
  ArtifactEvidence,
  JobEvidence,
  ReasonCode,
  RunAttemptEvidence,
  StepEvidence,
  VerdictEvidence,
} from './verdict.ts';
import {
  BUNDLE_REJECTIONS,
  MAX_BUNDLE_BYTES,
  REASON_CODES,
  canonicalBundleText,
  classifyImported,
  parseRetainedBundle,
  parseVerdictBundle,
  sha256Hex,
  type BundleParseResult,
  type PublicPolicy,
} from './verdict-bundle.ts';

/* ------------------------------------------------------------------ *
 * Synthetic evidence (transport-normalized shapes)
 * ------------------------------------------------------------------ */

const REPO_ID = 900_000_001;
const REPO = 'example-owner/example-repo';
const WORKFLOW_ID = 800_000_001;
const RUN_ID = 1_000_001; // matches fixtures.context()
const HEAD = SYNTHETIC_SHA;
const ARTIFACT_ID = 15_000_001;

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

function step(name: string, conclusion: string | null = 'success'): StepEvidence {
  return { number: name.length, name, status: 'completed', conclusion };
}

function testJob(overrides: Partial<JobEvidence> = {}, gate = step('Gate')): JobEvidence {
  return {
    id: 70_000_004,
    name: 'test',
    runAttempt: 1,
    headSha: HEAD,
    status: 'completed',
    conclusion: 'success',
    steps: [step('Quality summary'), gate],
    ...overrides,
  };
}

function ancestry(): AncestryEvidence {
  return {
    evaluatedSha: HEAD,
    mainTipSha: 'fedcba9876543210fedcba9876543210fedcba98',
    relation: 'head-is-ancestor',
  };
}

function artifact(overrides: Partial<ArtifactEvidence> = {}): ArtifactEvidence {
  return {
    id: ARTIFACT_ID,
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

const MATCHED: ArchiveEvidence = {
  status: 'downloaded',
  artifactId: ARTIFACT_ID,
  digestCheck: 'match',
  contents: 'single-summary',
};

function summary(overrides: Record<string, unknown> = {}): ParsedSummary {
  return parseSummary(serialize(normalize(twelveEighteenNineteen(), context(overrides))));
}

/** A summary whose observed Gate inputs include a failure (consistent with VERIFIED_FAIL). */
function failingSummary(): ParsedSummary {
  const inputs = Object.fromEntries(GATE_INPUT_NAMES.map((name) => [name, 'success']));
  inputs[GATE_INPUT_NAMES[0]] = 'failure';
  return summary({ gateInputs: inputs });
}

function collected(
  overrides: Partial<VerdictEvidence> = {},
  extra: Partial<Collected> = {},
): Collected {
  return {
    evidence: {
      request: { runId: RUN_ID, runAttempt: 1 },
      run: { status: 'ok', value: run() },
      jobs: { status: 'ok', value: [testJob()] },
      ancestry: { status: 'ok', value: ancestry() },
      artifacts: { status: 'ok', value: [artifact()] },
      archive: MATCHED,
      ...overrides,
    },
    summary: summary(),
    digest: 'verified',
    redirectRefused: false,
    ...extra,
  };
}

/** The exact text the committed operator writes for this evidence. */
function operatorBundle(c: Collected = collected()): string {
  return serializeBundle(buildBundle(reconcileCollected(c, BASE_POLICY), c, BASE_POLICY));
}

const VALID_TEXT = operatorBundle();

type Json = Record<string, unknown>;

/** Hand-edits a valid bundle and re-serializes it in the operator's layout. */
function forge(edit: (b: Json) => void, base: string = VALID_TEXT): string {
  const b = JSON.parse(base) as Json;
  edit(b);
  return `${JSON.stringify(b, null, 2)}\n`;
}

function obj(b: Json, key: string): Json {
  return b[key] as Json;
}

function rejection(result: BundleParseResult): { code: string; path: string | null } {
  assert.equal(result.status, 'rejected', 'expected a rejection');
  if (result.status !== 'rejected') throw new Error('unreachable');
  return { code: result.code, path: result.path };
}

function parse(text: string | Uint8Array): BundleParseResult {
  return parseVerdictBundle(text, POLICY);
}

/* ------------------------------------------------------------------ *
 * Valid operator bundles
 * ------------------------------------------------------------------ */

test('a valid operator bundle parses, unauthenticated, byte-identical to the operator output', () => {
  const result = parse(VALID_TEXT);
  assert.equal(result.status, 'valid');
  if (result.status !== 'valid') return;
  assert.equal(result.bundle.authenticity, 'UNAUTHENTICATED');
  const c = result.bundle.content;
  assert.equal(c.verdict.state, 'VERIFIED_PASS');
  assert.equal(c.summary.state, 'SUMMARY_VERIFIED_ORIGIN');
  assert.equal(c.summary.label, 'verified-origin');
  assert.equal(c.artifact.digest, 'verified');
  assert.notEqual(c.metrics, null);
  assert.equal(canonicalBundleText(c), VALID_TEXT);
});

test('the same bundle as UTF-8 bytes parses identically', () => {
  const fromText = parse(VALID_TEXT);
  const fromBytes = parse(new TextEncoder().encode(VALID_TEXT));
  assert.deepEqual(fromBytes, fromText);
});

const OPERATOR_SCENARIOS: Record<string, () => Collected> = {
  'verified fail': () =>
    collected(
      {
        jobs: {
          status: 'ok',
          value: [testJob({ conclusion: 'failure' }, step('Gate', 'failure'))],
        },
        run: { status: 'ok', value: run({ conclusion: 'failure' }) },
      },
      { summary: failingSummary() },
    ),
  'pull request (untrusted provenance)': () =>
    collected(
      {
        run: { status: 'ok', value: run({ event: 'pull_request', headBranch: 'feature' }) },
      },
      { summary: summary({ event: 'pull_request', branch: 'feature' }) },
    ),
  'run not retrieved': () => collected({ run: { status: 'failed', reason: 'not-found' } }),
  'run and jobs not retrieved': () =>
    collected({
      run: { status: 'failed', reason: 'timeout' },
      jobs: { status: 'failed', reason: 'rate-limited' },
    }),
  pending: () =>
    collected({ run: { status: 'ok', value: run({ status: 'in_progress', conclusion: null }) } }),
  cancelled: () => collected({ run: { status: 'ok', value: run({ conclusion: 'cancelled' }) } }),
  'artifact absent': () =>
    collected(
      { artifacts: { status: 'ok', value: [] }, archive: { status: 'not-attempted' } },
      { summary: null, digest: 'not-checked' },
    ),
  'artifact expired': () =>
    collected(
      {
        artifacts: { status: 'ok', value: [artifact({ expired: true })] },
        archive: { status: 'failed', reason: 'expired' },
      },
      { summary: null, digest: 'not-checked' },
    ),
  'digest mismatch': () =>
    collected(
      { archive: { ...MATCHED, digestCheck: 'mismatch', contents: 'unexpected-entries' } },
      { summary: null, digest: 'mismatch' },
    ),
  'declared too large': () =>
    collected(
      { archive: { status: 'rejected', artifactId: ARTIFACT_ID, reason: 'declared-too-large' } },
      { summary: null, digest: 'not-checked' },
    ),
  'artifacts not retrieved': () =>
    collected(
      {
        artifacts: { status: 'failed', reason: 'permission' },
        archive: { status: 'not-attempted' },
      },
      { summary: null, digest: 'not-checked' },
    ),
  'informative (untrusted verdict, valid summary)': () =>
    collected({ ancestry: { status: 'failed', reason: 'http-error' } }),
  'summary missing': () => collected({}, { summary: null }),
};

/** The states each scenario must reach, so the parser is tested against every path. */
const EXPECTED_STATES: Record<string, string> = {
  'verified fail': 'VERIFIED_FAIL/SUMMARY_VERIFIED_ORIGIN',
  'pull request (untrusted provenance)': 'UNTRUSTED_PROVENANCE/SUMMARY_INFORMATIVE',
  'run not retrieved': 'UNKNOWN/SUMMARY_UNKNOWN',
  'run and jobs not retrieved': 'UNKNOWN/SUMMARY_UNKNOWN',
  pending: 'PENDING/SUMMARY_INFORMATIVE',
  cancelled: 'CANCELLED/SUMMARY_VERIFIED_ORIGIN',
  'artifact absent': 'VERIFIED_PASS/SUMMARY_UNAVAILABLE',
  'artifact expired': 'VERIFIED_PASS/SUMMARY_UNAVAILABLE',
  'digest mismatch': 'VERIFIED_PASS/SUMMARY_CONFLICT',
  'declared too large': 'VERIFIED_PASS/SUMMARY_INVALID',
  'artifacts not retrieved': 'VERIFIED_PASS/SUMMARY_UNKNOWN',
  'informative (untrusted verdict, valid summary)': 'UNKNOWN/SUMMARY_INFORMATIVE',
  'summary missing': 'VERIFIED_PASS/SUMMARY_INVALID',
};

for (const [name, scenario] of Object.entries(OPERATOR_SCENARIOS)) {
  test(`operator bundle parses: ${name}`, () => {
    const text = operatorBundle(scenario());
    const result = parse(text);
    assert.equal(result.status, 'valid', JSON.stringify(result));
    if (result.status !== 'valid') return;
    const c = result.bundle.content;
    assert.equal(`${c.verdict.state}/${c.summary.state}`, EXPECTED_STATES[name]);
  });
}

test('a canary-laden report yields a valid bundle with no canary', () => {
  const c = collected(
    {},
    { summary: parseSummary(serialize(normalize(canaryReport(), context()))) },
  );
  const text = operatorBundle(c);
  assert.equal(text.includes(CANARY), false);
  assert.equal(parse(text).status, 'valid');
});

/* ------------------------------------------------------------------ *
 * Schema, kind, unknown and missing fields
 * ------------------------------------------------------------------ */

test('a wrong schema version is unsupported', () => {
  for (const version of ['1.0.1', '2.0.0', '0.9.0', 1, null]) {
    const text = forge((b) => {
      b.bundleSchemaVersion = version;
    });
    assert.equal(rejection(parse(text)).code, 'unsupported-version', String(version));
  }
});

test('a wrong kind is rejected', () => {
  const text = forge((b) => {
    b.kind = 'quality-verdict-publication';
  });
  assert.equal(rejection(parse(text)).code, 'wrong-kind');
});

test('unknown fields are rejected at every level without echoing the key', () => {
  const edits: [string, (b: Json) => void][] = [
    ['$', (b) => (b[CANARY] = 1)],
    ['$', (b) => (b.authenticity = 'BUILD_VERIFIED')],
    ['identity', (b) => (obj(b, 'identity')[CANARY] = null)],
    ['verdict', (b) => (obj(b, 'verdict').verifiedAt = '2026-11-26T00:00:00Z')],
    ['artifact', (b) => (obj(b, 'artifact').url = 'https://example.invalid/x')],
    ['metrics.totals', (b) => (obj(obj(b, 'metrics'), 'totals').titles = [])],
    [
      'metrics.totals.byInstanceOutcome',
      (b) => (obj(obj(obj(b, 'metrics'), 'totals'), 'byInstanceOutcome').exploded = 1),
    ],
    ['metrics', (b) => (obj(b, 'metrics').attachments = [])],
  ];
  for (const [path, edit] of edits) {
    const r = rejection(parse(forge(edit)));
    assert.equal(r.code, 'unknown-field', path);
    assert.equal(r.path, path);
    assert.equal(JSON.stringify(r).includes(CANARY), false);
  }
});

test('missing fields are rejected with a schema path', () => {
  const r = rejection(
    parse(
      forge((b) => {
        delete obj(b, 'summary').label;
      }),
    ),
  );
  assert.deepEqual(r, { code: 'missing-field', path: 'summary.label' });
  assert.equal(
    rejection(
      parse(
        forge((b) => {
          delete b.metrics;
        }),
      ),
    ).code,
    'missing-field',
  );
});

/* ------------------------------------------------------------------ *
 * Size, encoding, malformed and nested data
 * ------------------------------------------------------------------ */

test('input over 64 KiB is rejected before parsing, as text and as bytes', () => {
  const big = VALID_TEXT + ' '.repeat(MAX_BUNDLE_BYTES);
  assert.equal(rejection(parse(big)).code, 'too-large');
  assert.equal(rejection(parse(new TextEncoder().encode(big))).code, 'too-large');
  // Multi-byte characters count as bytes, not characters.
  assert.equal(rejection(parse('é'.repeat(MAX_BUNDLE_BYTES / 2 + 1))).code, 'too-large');
});

test('malformed input never throws and yields fixed codes', () => {
  const cases: [unknown, string][] = [
    ['', 'invalid-json'],
    ['{', 'invalid-json'],
    ['null', 'invalid-structure'],
    ['[]', 'invalid-structure'],
    ['"bundle"', 'invalid-structure'],
    [`\uFEFF${VALID_TEXT}`, 'invalid-json'],
    [VALID_TEXT.replace(/\n/g, '\r\n'), 'non-canonical'],
    [42, 'input-type'],
    [null, 'input-type'],
    [{ bundleSchemaVersion: '1.0.0' }, 'input-type'],
  ];
  for (const [input, code] of cases) {
    const r = parseVerdictBundle(input as string, POLICY);
    assert.equal(rejection(r).code, code, JSON.stringify(input)?.slice(0, 40));
  }
});

test('invalid UTF-8 bytes are rejected', () => {
  const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
  assert.equal(rejection(parse(bytes)).code, 'invalid-encoding');
});

test('deep nesting is rejected without recursion', () => {
  const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`;
  assert.equal(rejection(parse(deep)).code, 'too-deep');
  const nested = forge((b) => {
    obj(b, 'identity').headSha = { a: { b: { c: { d: { e: { f: 1 } } } } } };
  });
  assert.equal(rejection(parse(nested)).code, 'too-deep');
});

test('wrong primitive types and formats are invalid values', () => {
  const edits: [string, (b: Json) => void][] = [
    ['request.runId', (b) => (obj(b, 'request').runId = '1000001')],
    ['request.runId', (b) => (obj(b, 'request').runId = 1.5)],
    ['request.runAttempt', (b) => (obj(b, 'request').runAttempt = 0)],
    ['identity.headSha', (b) => (obj(b, 'identity').headSha = HEAD.toUpperCase())],
    ['identity.headSha', (b) => (obj(b, 'identity').headSha = HEAD.slice(1))],
    ['identity.event', (b) => (obj(b, 'identity').event = 'workflow_dispatch')],
    ['verdict.state', (b) => (obj(b, 'verdict').state = 'VERIFIED')],
    ['verdict.reasons[]', (b) => (obj(b, 'verdict').reasons = ['gate-success', 'looks-good'])],
    ['summary.metricsAvailable', (b) => (obj(b, 'summary').metricsAvailable = 1)],
    ['artifact.digest', (b) => (obj(b, 'artifact').digest = `sha256:${'ab'.repeat(32)}`)],
    ['metrics.totals.retries', (b) => (obj(obj(b, 'metrics'), 'totals').retries = -1)],
    [
      'metrics.totals.byInstanceOutcome.passed',
      (b) => (obj(obj(obj(b, 'metrics'), 'totals'), 'byInstanceOutcome').passed = 0),
    ],
    ['metrics.summarySchemaVersion', (b) => (obj(b, 'metrics').summarySchemaVersion = '2.0.0')],
    [
      'metrics.completeness.omissionDetection',
      (b) => (obj(obj(b, 'metrics'), 'completeness').omissionDetection = 'supported'),
    ],
  ];
  for (const [path, edit] of edits) {
    const r = rejection(parse(forge(edit)));
    assert.deepEqual(r, { code: 'invalid-value', path }, path);
  }
});

test('reasons must be sorted and unique', () => {
  const unsorted = forge((b) => {
    obj(b, 'summary').state = 'SUMMARY_INFORMATIVE';
    obj(b, 'summary').reasons = ['verdict-not-trusted', 'digest-contract-unconfirmed'];
  });
  assert.equal(rejection(parse(unsorted)).code, 'reasons-not-canonical');
  const duplicated = forge((b) => {
    obj(b, 'verdict').reasons = ['gate-success', 'gate-success'];
  });
  assert.equal(rejection(parse(duplicated)).code, 'reasons-not-canonical');
});

test('non-canonical layout and duplicate keys are rejected', () => {
  const compact = `${JSON.stringify(JSON.parse(VALID_TEXT))}\n`;
  assert.equal(rejection(parse(compact)).code, 'non-canonical');
  assert.equal(rejection(parse(VALID_TEXT.trimEnd())).code, 'non-canonical');
  const reordered = forge((b) => {
    const kind = b.kind;
    delete b.kind;
    b.kind = kind;
  });
  assert.equal(rejection(parse(reordered)).code, 'non-canonical');
  // A duplicated key: JSON.parse keeps the last value; the bytes differ.
  const duplicated = VALID_TEXT.replace(
    '"kind": "quality-verdict-bundle",',
    '"kind": "x",\n  "kind": "quality-verdict-bundle",',
  );
  assert.equal(rejection(parse(duplicated)).code, 'non-canonical');
});

test('a bundle for another repository policy is rejected', () => {
  const r = parseVerdictBundle(VALID_TEXT, { ...POLICY, repositoryId: REPO_ID + 1 });
  assert.deepEqual(rejection(r), { code: 'policy-mismatch', path: 'policy' });
  const forged = forge((b) => {
    obj(b, 'policy').trustedBranch = 'release';
  });
  assert.equal(rejection(parse(forged)).code, 'policy-mismatch');
});

/* ------------------------------------------------------------------ *
 * Forgery and consistency
 * ------------------------------------------------------------------ */

const PR_TEXT = operatorBundle(OPERATOR_SCENARIOS['pull request (untrusted provenance)']!());

test('a forged VERIFIED_PASS from a pull request is rejected', () => {
  const forged = forge((b) => {
    obj(b, 'verdict').state = 'VERIFIED_PASS';
    obj(b, 'verdict').reasons = ['gate-success'];
  }, PR_TEXT);
  assert.equal(rejection(parse(forged)).code, 'untrusted-verified-state');
  // Keeping the provenance reasons is a reason/state mismatch instead.
  const lazy = forge((b) => {
    obj(b, 'verdict').state = 'VERIFIED_PASS';
  }, PR_TEXT);
  assert.equal(rejection(parse(lazy)).code, 'reason-state-mismatch');
});

test('a VERIFIED state without an established run identity is rejected', () => {
  const forged = forge((b) => {
    const id = obj(b, 'identity');
    id.runId = null;
    id.runAttempt = null;
    id.headSha = null;
    id.event = null;
  });
  assert.equal(rejection(parse(forged)).code, 'untrusted-verified-state');
  const partial = forge((b) => {
    obj(b, 'identity').event = null;
  });
  assert.equal(rejection(parse(partial)).code, 'identity-incomplete');
});

test('a forged verified-origin summary without verified digest evidence is rejected', () => {
  const notChecked = forge((b) => {
    obj(b, 'artifact').digest = 'not-checked';
  });
  assert.equal(rejection(parse(notChecked)).code, 'verified-origin-without-digest');

  const untrustedVerdict = forge((b) => {
    obj(b, 'verdict').state = 'UNKNOWN';
    obj(b, 'verdict').reasons = ['gate-not-decisive'];
  });
  assert.equal(rejection(parse(untrustedVerdict)).code, 'verified-origin-without-digest');

  const fromInformative = forge(
    (b) => {
      const s = obj(b, 'summary');
      s.state = 'SUMMARY_VERIFIED_ORIGIN';
      s.reasons = ['verified-origin'];
      s.label = 'verified-origin';
    },
    operatorBundle(collected({}, { digest: 'not-checked' })),
  );
  assert.equal(rejection(parse(fromInformative)).code, 'verified-origin-without-digest');
});

test('an informative summary must match the verdict and digest evidence', () => {
  const lyingAboutDigest = forge(
    (b) => {
      obj(b, 'summary').reasons = ['verdict-not-trusted'];
    },
    operatorBundle(
      collected(
        { ancestry: { status: 'failed', reason: 'http-error' } },
        { digest: 'not-checked' },
      ),
    ),
  );
  assert.equal(rejection(parse(lyingAboutDigest)).code, 'verified-origin-without-digest');
  const lyingAboutVerdict = forge(
    (b) => {
      obj(b, 'summary').reasons = ['digest-contract-unconfirmed'];
    },
    operatorBundle(
      collected(
        { ancestry: { status: 'failed', reason: 'http-error' } },
        { digest: 'not-checked' },
      ),
    ),
  );
  assert.equal(rejection(parse(lyingAboutVerdict)).code, 'reason-state-mismatch');
});

test('metrics attached to an unavailable summary are rejected', () => {
  const metrics = (JSON.parse(VALID_TEXT) as Json).metrics;
  const expired = operatorBundle(OPERATOR_SCENARIOS['artifact expired']!());
  const attached = forge((b) => {
    b.metrics = metrics;
  }, expired);
  assert.equal(rejection(parse(attached)).code, 'metrics-not-permitted');
  const flagged = forge((b) => {
    obj(b, 'summary').metricsAvailable = true;
    b.metrics = metrics;
  }, expired);
  assert.equal(rejection(parse(flagged)).code, 'metrics-not-permitted');
});

test('metricsAvailable and metrics must agree', () => {
  const dropped = forge((b) => {
    b.metrics = null;
  });
  assert.equal(rejection(parse(dropped)).code, 'metrics-missing');
  const unflagged = forge((b) => {
    obj(b, 'summary').metricsAvailable = false;
  });
  assert.equal(rejection(parse(unflagged)).code, 'metrics-not-permitted');
});

test('a label that does not match the summary state is rejected', () => {
  const forged = forge((b) => {
    obj(b, 'summary').label = 'unverified-origin';
  });
  assert.equal(rejection(parse(forged)).code, 'label-state-mismatch');
});

test('a request/identity mismatch is rejected', () => {
  for (const field of ['runId', 'runAttempt'] as const) {
    const forged = forge((b) => {
      obj(b, 'request')[field] = 2;
    });
    assert.equal(rejection(parse(forged)).code, 'request-identity-mismatch', field);
  }
});

test('artifact.id must equal identity.artifactId', () => {
  const forged = forge((b) => {
    obj(b, 'artifact').id = ARTIFACT_ID + 1;
  });
  assert.equal(rejection(parse(forged)).code, 'artifact-id-mismatch');
});

test('a digest status inconsistent with the summary is rejected', () => {
  const hidden = forge((b) => {
    obj(b, 'artifact').digest = 'verified';
  }, operatorBundle(OPERATOR_SCENARIOS['digest mismatch']!()));
  assert.equal(rejection(parse(hidden)).code, 'digest-state-mismatch');
  const claimed = forge((b) => {
    obj(b, 'artifact').digest = 'mismatch';
  });
  assert.equal(rejection(parse(claimed)).code, 'digest-state-mismatch');
});

test('reason codes must belong to their state', () => {
  const cases: [string, (b: Json) => void][] = [
    ['verdict', (b) => (obj(b, 'verdict').reasons = ['gate-failure'])],
    ['verdict', (b) => (obj(b, 'verdict').reasons = [])],
    ['verdict', (b) => (obj(b, 'verdict').reasons = ['gate-failure', 'gate-success'])],
    [
      'verdict',
      (b) => {
        obj(b, 'verdict').state = 'CONFLICT';
        obj(b, 'verdict').reasons = ['identity-run-id-mismatch', 'outcome-job-not-completed'];
      },
    ],
    ['summary', (b) => (obj(b, 'summary').reasons = ['artifact-absent'])],
  ];
  for (const [where, edit] of cases) {
    const r = rejection(parse(forge(edit)));
    assert.deepEqual(r, { code: 'reason-state-mismatch', path: `${where}.reasons` });
  }
});

test('invalid-request bundles must be uniformly unresolved', () => {
  const forged = forge((b) => {
    obj(b, 'verdict').state = 'UNKNOWN';
    obj(b, 'verdict').reasons = ['invalid-request'];
  }, operatorBundle(OPERATOR_SCENARIOS['run not retrieved']!()));
  assert.equal(rejection(parse(forged)).code, 'invalid-request-inconsistent');
});

/* ------------------------------------------------------------------ *
 * Retained pins and imported files
 * ------------------------------------------------------------------ */

const VALID_BYTES = new TextEncoder().encode(VALID_TEXT);
const PIN = { runId: RUN_ID, runAttempt: 1, sha256: sha256Hex(VALID_BYTES) };

test('a pinned retained bundle parses only with its exact hash and attempt', () => {
  assert.equal(parseRetainedBundle(VALID_BYTES, PIN, POLICY).status, 'valid');
  const tampered = new TextEncoder().encode(
    VALID_TEXT.replace('"gate-success"', '"gate-success" '),
  );
  assert.equal(rejection(parseRetainedBundle(tampered, PIN, POLICY)).code, 'hash-mismatch');
  assert.equal(
    rejection(parseRetainedBundle(VALID_BYTES, { ...PIN, runAttempt: 2 }, POLICY)).code,
    'pin-mismatch',
  );
  for (const pin of [
    { ...PIN, sha256: PIN.sha256.toUpperCase() },
    { ...PIN, sha256: `sha256:${PIN.sha256}` },
    { ...PIN, runId: 0 },
    null,
  ]) {
    assert.equal(
      rejection(parseRetainedBundle(VALID_BYTES, pin as typeof PIN, POLICY)).code,
      'pin-invalid',
    );
  }
});

test('a matching hash does not make a forged bundle acceptable', () => {
  const forged = new TextEncoder().encode(
    forge((b) => {
      obj(b, 'verdict').state = 'VERIFIED_PASS';
      obj(b, 'verdict').reasons = ['gate-success'];
    }, PR_TEXT),
  );
  const pin = { runId: RUN_ID, runAttempt: 1, sha256: sha256Hex(forged) };
  assert.equal(
    rejection(parseRetainedBundle(forged, pin, POLICY)).code,
    'untrusted-verified-state',
  );
});

test('an imported bundle claiming VERIFIED_PASS is only an unauthenticated claim', () => {
  const imported = classifyImported(VALID_TEXT, POLICY);
  assert.equal(imported.authenticity, 'IMPORTED_UNAUTHENTICATED');
  if (imported.authenticity !== 'IMPORTED_UNAUTHENTICATED') return;
  assert.equal(imported.claimedVerdict, 'VERIFIED_PASS');
  assert.equal(JSON.stringify(imported).includes('BUILD_VERIFIED'), false);
});

test('an imported bundle claiming BUILD_VERIFIED is rejected', () => {
  const forged = forge((b) => {
    b.authenticity = 'BUILD_VERIFIED';
  });
  assert.deepEqual(classifyImported(forged, POLICY), {
    authenticity: 'REJECTED',
    code: 'unknown-field',
  });
});

/* ------------------------------------------------------------------ *
 * Determinism, leakage and vocabulary
 * ------------------------------------------------------------------ */

test('parsing is deterministic, frozen and never mutates its input', () => {
  const a = parse(VALID_TEXT);
  const b = parse(VALID_TEXT);
  assert.deepEqual(a, b);
  assert.equal(Object.isFrozen(a), true);
  if (a.status === 'valid') {
    assert.equal(Object.isFrozen(a.bundle.content.verdict.reasons), true);
  }
  const bytes = new TextEncoder().encode(VALID_TEXT);
  const copy = bytes.slice();
  parse(bytes);
  assert.deepEqual(bytes, copy);
});

test('rejections never echo input values', () => {
  const secrets = [
    CANARY,
    'ghp_TOKENCANARY0123456789abcdef',
    '/Users/example/secret',
    'https://x.invalid/?sig=SIGNEDURLCANARY',
  ];
  for (const secret of secrets) {
    for (const edit of [
      (b: Json) => (b[secret] = secret),
      (b: Json) => (obj(b, 'identity').headSha = secret),
      (b: Json) => (obj(b, 'verdict').reasons = [secret]),
      (b: Json) => (obj(b, 'policy').workflowName = secret),
    ]) {
      const r = parse(forge(edit));
      assert.equal(r.status, 'rejected');
      assert.equal(JSON.stringify(r).includes(secret), false, secret);
    }
  }
});

test('random single-byte corruption never throws', () => {
  let seed = 7;
  const next = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
  for (let i = 0; i < 400; i++) {
    const bytes = VALID_BYTES.slice();
    bytes[next() % bytes.length] = next() % 256;
    const r = parse(bytes);
    assert.ok(r.status === 'valid' || BUNDLE_REJECTIONS.includes(r.code));
  }
});

test('REASON_CODES is a duplicate-free list of every reconciler reason', () => {
  assert.equal(new Set(REASON_CODES).size, REASON_CODES.length);
  // 7 + 5 + 9 + 13 + 24 fixed codes and 5 sources x 7 retrieval failures.
  assert.equal(REASON_CODES.length, 58 + 35);
  const sample: ReasonCode[] = ['retrieval-archive-incomplete-pagination', 'verified-origin'];
  for (const code of sample) assert.ok(REASON_CODES.includes(code));
});

/* ------------------------------------------------------------------ *
 * Identity conflicts: genuine operator CONFLICT bundles vs forgeries
 * ------------------------------------------------------------------ */

/** The run-attempt response describes another run (reconciler rule 1). */
const RUN_ID_CONFLICT = (): Collected =>
  collected({ run: { status: 'ok', value: run({ id: RUN_ID + 7 }) } });
/** The run-attempt response describes another attempt of the requested run. */
const ATTEMPT_CONFLICT = (): Collected =>
  collected({ run: { status: 'ok', value: run({ runAttempt: 2 }) } });
const BOTH_CONFLICT = (): Collected =>
  collected({ run: { status: 'ok', value: run({ id: RUN_ID + 7, runAttempt: 2 }) } });

function validContent(text: string) {
  const r = parse(text);
  assert.equal(r.status, 'valid', JSON.stringify(r));
  if (r.status !== 'valid') throw new Error('unreachable');
  return r.bundle;
}

test('a genuine operator run-ID conflict bundle parses and keeps the response identity', () => {
  const bundle = validContent(operatorBundle(RUN_ID_CONFLICT()));
  const c = bundle.content;
  assert.equal(bundle.authenticity, 'UNAUTHENTICATED');
  assert.deepEqual(c.verdict, { state: 'CONFLICT', reasons: ['identity-run-id-mismatch'] });
  assert.deepEqual(c.request, { runId: RUN_ID, runAttempt: 1 });
  assert.equal(c.identity.runId, RUN_ID + 7);
  assert.equal(c.identity.runAttempt, 1);
  assert.notEqual(c.summary.state, 'SUMMARY_VERIFIED_ORIGIN');
});

test('a genuine operator attempt conflict bundle parses and keeps the response identity', () => {
  const c = validContent(operatorBundle(ATTEMPT_CONFLICT())).content;
  assert.deepEqual(c.verdict, { state: 'CONFLICT', reasons: ['identity-attempt-mismatch'] });
  assert.equal(c.identity.runId, RUN_ID);
  assert.equal(c.identity.runAttempt, 2);
});

test('a genuine operator conflict on both run ID and attempt carries both reasons', () => {
  const c = validContent(operatorBundle(BOTH_CONFLICT())).content;
  assert.deepEqual(c.verdict.reasons, ['identity-attempt-mismatch', 'identity-run-id-mismatch']);
});

test('a genuine conflict bundle remains an unauthenticated claim when imported', () => {
  const imported = classifyImported(operatorBundle(RUN_ID_CONFLICT()), POLICY);
  assert.equal(imported.authenticity, 'IMPORTED_UNAUTHENTICATED');
  if (imported.authenticity !== 'IMPORTED_UNAUTHENTICATED') return;
  assert.equal(imported.claimedVerdict, 'CONFLICT');
});

test('a mismatch without its exact reason is rejected (run ID and attempt separately)', () => {
  const runText = operatorBundle(RUN_ID_CONFLICT());
  const attemptText = operatorBundle(ATTEMPT_CONFLICT());
  const cases: [string, string, string][] = [
    // Swap the reason for the other field's reason.
    [
      runText,
      'identity.runId',
      forge((b) => (obj(b, 'verdict').reasons = ['identity-attempt-mismatch']), runText),
    ],
    [
      attemptText,
      'identity.runId',
      forge((b) => (obj(b, 'verdict').reasons = ['identity-run-id-mismatch']), attemptText),
    ],
    // Keep the mismatch under another identity conflict reason only.
    [
      runText,
      'identity.runId',
      forge((b) => (obj(b, 'verdict').reasons = ['identity-job-sha-mismatch']), runText),
    ],
    [
      attemptText,
      'identity.runAttempt',
      forge((b) => (obj(b, 'verdict').reasons = ['identity-duplicate-gate-step']), attemptText),
    ],
  ];
  for (const [, path, text] of cases) {
    assert.deepEqual(rejection(parse(text)), { code: 'request-identity-mismatch', path });
  }
});

test('a mismatch reason without a mismatch is rejected', () => {
  const runText = operatorBundle(RUN_ID_CONFLICT());
  const restored = forge((b) => (obj(b, 'identity').runId = RUN_ID), runText);
  assert.deepEqual(rejection(parse(restored)), {
    code: 'request-identity-mismatch',
    path: 'identity.runId',
  });
  const attemptText = operatorBundle(ATTEMPT_CONFLICT());
  const restoredAttempt = forge((b) => (obj(b, 'identity').runAttempt = 1), attemptText);
  assert.deepEqual(rejection(parse(restoredAttempt)), {
    code: 'request-identity-mismatch',
    path: 'identity.runAttempt',
  });
  // An unrelated genuine CONFLICT gaining a mismatch reason.
  const added = forge(
    (b) => (obj(b, 'verdict').reasons = ['identity-job-sha-mismatch', 'identity-run-id-mismatch']),
    operatorBundle(
      collected({ jobs: { status: 'ok', value: [testJob({ headSha: 'f'.repeat(40) })] } }),
    ),
  );
  assert.equal(rejection(parse(added)).code, 'request-identity-mismatch');
});

test('a mismatch reason without an established identity is rejected', () => {
  const forged = forge((b) => {
    obj(b, 'verdict').state = 'CONFLICT';
    obj(b, 'verdict').reasons = ['identity-run-id-mismatch'];
  }, operatorBundle(OPERATOR_SCENARIOS['run not retrieved']!()));
  assert.deepEqual(rejection(parse(forged)), {
    code: 'request-identity-mismatch',
    path: 'identity',
  });
});

test('an identity mismatch is never accepted under a trusted or pending verdict', () => {
  const states: [string, string[]][] = [
    ['VERIFIED_PASS', ['gate-success']],
    ['VERIFIED_FAIL', ['gate-failure']],
    ['EXECUTION_FAILED', ['job-failed-before-gate']],
    ['CANCELLED', ['run-cancelled']],
    ['PENDING', ['run-not-completed']],
  ];
  for (const base of [operatorBundle(RUN_ID_CONFLICT()), operatorBundle(ATTEMPT_CONFLICT())]) {
    for (const [state, reasons] of states) {
      // With the state's own reasons: the mismatch is unexplained.
      const plain = forge((b) => {
        obj(b, 'verdict').state = state;
        obj(b, 'verdict').reasons = reasons;
      }, base);
      assert.equal(rejection(parse(plain)).code, 'request-identity-mismatch', state);
      // Keeping the mismatch reason: it is CONFLICT-only.
      const kept = forge((b) => {
        obj(b, 'verdict').state = state;
      }, base);
      assert.equal(rejection(parse(kept)).code, 'reason-state-mismatch', state);
    }
  }
});

test('artifact, digest and summary checks still apply to genuine conflict bundles', () => {
  const text = operatorBundle(RUN_ID_CONFLICT());
  const artifactId = forge((b) => (obj(b, 'artifact').id = ARTIFACT_ID + 1), text);
  assert.equal(rejection(parse(artifactId)).code, 'artifact-id-mismatch');
  const promoted = forge((b) => {
    const s = obj(b, 'summary');
    s.state = 'SUMMARY_VERIFIED_ORIGIN';
    s.reasons = ['verified-origin'];
    s.label = 'verified-origin';
  }, text);
  assert.equal(rejection(parse(promoted)).code, 'verified-origin-without-digest');
  const digest = forge((b) => (obj(b, 'artifact').digest = 'mismatch'), text);
  assert.equal(rejection(parse(digest)).code, 'digest-state-mismatch');
});
