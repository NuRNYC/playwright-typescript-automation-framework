/**
 * Unit tests for the accessibility gate policy.
 *
 * Same conventions as the configuration and session tests (ADR-0002): Node's
 * built-in runner, explicit `.ts` imports, no ambient state. The clock is
 * injected, so expiry is tested at its exact boundary.
 *
 * Rule ids, URLs and node contents below are synthetic. Nodes are opaque
 * placeholders that deliberately carry `html` and `target` fields, so the
 * summary tests can prove those fields never reach the report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  A11Y_TAGS,
  evaluateGate,
  exceptionProblem,
  toReportSummary,
  type A11yException,
  type AxeRuleResult,
  type AxeScan,
} from './policy.ts';
import { A11Y_EXCEPTIONS } from './exceptions.ts';

const NOW = new Date('2026-11-24T12:00:00Z');
const SECRET_HTML = '<input value="synthetic-secret">';
const SECRET_SELECTOR = '#synthetic-generated-selector';

function node(): unknown {
  return { html: SECRET_HTML, target: [SECRET_SELECTOR], failureSummary: 'synthetic' };
}

function violation(id: string, impact: AxeRuleResult['impact'], nodes = 1): AxeRuleResult {
  return {
    id,
    impact,
    tags: ['wcag2a', 'wcag111', 'cat.text-alternatives'],
    helpUrl: `https://example.invalid/rules/${id}`,
    nodes: Array.from({ length: nodes }, node),
  };
}

function exception(overrides: Partial<A11yException> = {}): A11yException {
  return {
    page: 'login',
    ruleId: 'image-alt',
    impact: 'critical',
    maxNodes: 2,
    reason: 'Synthetic third-party markup',
    owner: 'QE maintainer',
    reviewBy: '2026-12-31',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Strict gating
 * ------------------------------------------------------------------ */

test('a scan with no violations passes', () => {
  const gate = evaluateGate('login', [], [], NOW);

  assert.deepEqual(gate, { page: 'login', failures: [], excepted: [] });
});

test('any violation fails, whatever its impact', () => {
  for (const impact of ['minor', 'moderate', 'serious', 'critical', null] as const) {
    const gate = evaluateGate('login', [violation('some-rule', impact, 3)], [], NOW);

    assert.deepEqual(gate.failures, [
      { kind: 'violation', ruleId: 'some-rule', impact, nodeCount: 3 },
    ]);
  }
});

/* ------------------------------------------------------------------ *
 * Exceptions
 * ------------------------------------------------------------------ */

test('a valid exception suppresses only its own page, rule and impact', () => {
  const exceptions = [exception()];

  const suppressed = evaluateGate(
    'login',
    [violation('image-alt', 'critical', 2)],
    exceptions,
    NOW,
  );
  assert.deepEqual(suppressed.failures, []);
  assert.deepEqual(suppressed.excepted, [
    { ruleId: 'image-alt', nodeCount: 2, reviewBy: '2026-12-31' },
  ]);

  // Same rule on another page is not excused...
  const otherPage = evaluateGate(
    'inventory',
    [violation('image-alt', 'critical')],
    exceptions,
    NOW,
  );
  assert.deepEqual(otherPage.failures, [
    { kind: 'violation', ruleId: 'image-alt', impact: 'critical', nodeCount: 1 },
  ]);

  // ...nor is another rule on the same page, and the exception is then unused.
  const otherRule = evaluateGate('login', [violation('label', 'critical')], exceptions, NOW);
  assert.deepEqual(otherRule.failures, [
    { kind: 'violation', ruleId: 'label', impact: 'critical', nodeCount: 1 },
    { kind: 'unused', ruleId: 'image-alt' },
  ]);
});

test('a severity-mismatched exception fails instead of suppressing', () => {
  const gate = evaluateGate('login', [violation('image-alt', 'serious')], [exception()], NOW);

  assert.deepEqual(gate.failures, [
    { kind: 'impact-mismatch', ruleId: 'image-alt', expected: 'critical', actual: 'serious' },
  ]);
  assert.deepEqual(gate.excepted, []);
});

test('an exception is exceeded when more nodes are affected than allowed', () => {
  const atCap = evaluateGate('login', [violation('image-alt', 'critical', 2)], [exception()], NOW);
  assert.deepEqual(atCap.failures, []);

  const overCap = evaluateGate(
    'login',
    [violation('image-alt', 'critical', 3)],
    [exception()],
    NOW,
  );
  assert.deepEqual(overCap.failures, [
    { kind: 'exceeded', ruleId: 'image-alt', maxNodes: 2, nodeCount: 3 },
  ]);
});

test('an exception expires after its review-by day, using the injected clock', () => {
  const entry = exception({ reviewBy: '2026-11-24' });
  const violations = [violation('image-alt', 'critical')];

  const lastDay = evaluateGate('login', violations, [entry], new Date('2026-11-24T23:59:59Z'));
  assert.deepEqual(lastDay.failures, []);

  const dayAfter = evaluateGate('login', violations, [entry], new Date('2026-11-25T00:00:00Z'));
  assert.deepEqual(dayAfter.failures, [
    { kind: 'expired', ruleId: 'image-alt', reviewBy: '2026-11-24' },
  ]);
});

test('an unused exception fails so it must be retired; expiry takes precedence', () => {
  const unused = evaluateGate('login', [], [exception()], NOW);
  assert.deepEqual(unused.failures, [{ kind: 'unused', ruleId: 'image-alt' }]);

  const expiredAndUnused = evaluateGate('login', [], [exception({ reviewBy: '2026-01-01' })], NOW);
  assert.deepEqual(expiredAndUnused.failures, [
    { kind: 'expired', ruleId: 'image-alt', reviewBy: '2026-01-01' },
  ]);
});

test('malformed or duplicate exceptions fail and never suppress', () => {
  const cases: [Partial<A11yException>, RegExp][] = [
    [{ maxNodes: 0 }, /maxNodes/],
    [{ maxNodes: 1.5 }, /maxNodes/],
    [{ reason: ' ' }, /reason/],
    [{ owner: '' }, /owner/],
    [{ ruleId: '' }, /ruleId/],
    [{ reviewBy: '31/12/2026' }, /ISO date/],
    [{ reviewBy: '2026-02-30' }, /ISO date/],
  ];
  for (const [overrides, problem] of cases) {
    assert.match(exceptionProblem(exception(overrides)) ?? '', problem);

    const gate = evaluateGate(
      'login',
      [violation('image-alt', 'critical')],
      [exception(overrides)],
      NOW,
    );
    assert.ok(gate.failures.some((f) => f.kind === 'invalid-exception'));
    assert.ok(gate.failures.some((f) => f.kind === 'violation'));
    assert.deepEqual(gate.excepted, []);
  }

  const duplicate = evaluateGate(
    'login',
    [violation('image-alt', 'critical')],
    [exception(), exception()],
    NOW,
  );
  assert.deepEqual(duplicate.failures, [
    {
      kind: 'invalid-exception',
      ruleId: 'image-alt',
      problem: 'duplicate exception for this page and rule',
    },
  ]);
  assert.equal(duplicate.excepted.length, 1);
});

test('the committed exception list is empty and well formed', () => {
  assert.equal(A11Y_EXCEPTIONS.length, 0);
  for (const entry of A11Y_EXCEPTIONS as readonly A11yException[]) {
    assert.equal(exceptionProblem(entry), undefined);
  }
});

/* ------------------------------------------------------------------ *
 * Safe reporting
 * ------------------------------------------------------------------ */

function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => allKeys(item, keys));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      allKeys(inner, keys);
    }
  }
  return keys;
}

test('the report summary carries counts and incomplete findings, never raw nodes', () => {
  const scan: AxeScan = {
    violations: [violation('image-alt', 'critical', 2)],
    incomplete: [violation('color-contrast', 'serious', 3)],
    passes: [{}, {}, {}],
    testEngine: { version: '4.14.1' },
  };
  const gate = evaluateGate('login', scan.violations, [], NOW);

  const summary = toReportSummary('login', scan, gate);

  assert.deepEqual(summary.counts, { violations: 1, affectedNodes: 2, incomplete: 1, passes: 3 });
  assert.deepEqual(summary.incomplete, [{ ruleId: 'color-contrast', nodeCount: 3 }]);
  assert.deepEqual(summary.violations[0]?.wcagTags, ['wcag2a', 'wcag111']);
  assert.deepEqual(summary.tags, [...A11Y_TAGS]);
  assert.equal(summary.failures.length, 1);

  const keys = allKeys(summary);
  for (const forbidden of ['html', 'target', 'failureSummary', 'nodes', 'any', 'all', 'none']) {
    assert.ok(!keys.has(forbidden), `summary must not contain "${forbidden}"`);
  }
  const serialised = JSON.stringify(summary);
  assert.ok(!serialised.includes(SECRET_HTML));
  assert.ok(!serialised.includes(SECRET_SELECTOR));
});
