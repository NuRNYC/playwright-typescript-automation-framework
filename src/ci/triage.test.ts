/**
 * Unit tests for the failure-triage policy (ADR-0008).
 *
 * Same conventions as the other unit tests (ADR-0002): Node's built-in
 * runner, an explicit `.ts` import, plain-object inputs. Reports are shaped
 * like the JSON reporter output measured in Playwright 1.64.1. Every value is
 * synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  annotations,
  classify,
  escapeData,
  escapeProperty,
  sourceLocation,
  runTriage,
  summary,
  triage,
  type TriageIo,
  type TriageResult,
} from './triage.ts';

// Token-shaped, built at runtime so no literal resembling a credential is committed.
const SECRET = ['ghp', 'SYNTHETIC'.repeat(4)].join('_');
const HOSTILE_TITLE = `title %0A::error ::set-env\n<script>${SECRET}</script>`;

interface Attempt {
  status: string;
}

function spec(
  opts: {
    file?: unknown;
    line?: unknown;
    id?: unknown;
    title?: unknown;
    project?: unknown;
    status?: unknown;
    expectedStatus?: unknown;
    results?: Attempt[];
  } = {},
): Record<string, unknown> {
  return {
    title: opts.title ?? HOSTILE_TITLE,
    file: opts.file ?? 'api/products.spec.ts',
    line: opts.line ?? 13,
    id: opts.id ?? 'abc123-def456',
    ok: false,
    tests: [
      {
        projectName: opts.project ?? 'api',
        status: opts.status ?? 'expected',
        expectedStatus: opts.expectedStatus ?? 'passed',
        annotations: [{ type: 'issue', description: SECRET }],
        results: (opts.results ?? [{ status: 'passed' }]).map((r) => ({
          ...r,
          errors: [{ message: `Error: ${SECRET}`, stack: '/home/runner/work/x.ts:1:1' }],
          stdout: [{ text: SECRET }],
          attachments: [{ name: 'trace', path: '/home/runner/trace.zip' }],
        })),
      },
    ],
  };
}

function report(...specs: Record<string, unknown>[]): unknown {
  return {
    config: { rootDir: '/home/runner/work/repo/tests', metadata: { gitCommit: { email: SECRET } } },
    suites: [{ title: 'api/products.spec.ts', specs, suites: [] }],
    errors: [],
    stats: {},
  };
}

function triaged(result: TriageResult): Extract<TriageResult, { kind: 'triaged' }> {
  if (result.kind !== 'triaged') {
    throw new assert.AssertionError({ message: `expected a triaged result, got ${result.reason}` });
  }
  return result;
}

test('classification uses structured statuses only', () => {
  assert.equal(classify('expected', 'passed', ['passed']), 'passed');
  assert.equal(classify('expected', 'failed', ['failed']), 'expected-failure');
  assert.equal(classify('flaky', 'passed', ['failed', 'passed']), 'flaky');
  assert.equal(classify('skipped', 'skipped', ['skipped']), 'skipped');
  assert.equal(classify('skipped', 'passed', []), 'did-not-run');
  assert.equal(classify('unexpected', 'passed', ['failed', 'failed', 'failed']), 'failed');
  assert.equal(classify('unexpected', 'passed', ['timedOut', 'timedOut']), 'timed-out');
  assert.equal(classify('unexpected', 'passed', ['interrupted']), 'interrupted');
  assert.equal(classify('unexpected', 'failed', ['passed']), 'unexpected-pass');
});

test('unknown or inconsistent statuses fail closed as unclassified', () => {
  assert.equal(classify('passed-ish', 'passed', ['passed']), 'unclassified');
  assert.equal(classify('expected', 'passed', ['weird']), 'unclassified');
  assert.equal(classify('unexpected', 'passed', []), 'unclassified');
  assert.equal(classify('unexpected', 'passed', ['skipped']), 'unclassified');
  assert.equal(classify(undefined, undefined, [undefined]), 'unclassified');
});

test('only repository-relative spec paths and positive lines are accepted', () => {
  assert.deepEqual(sourceLocation('api/products.spec.ts', 13), {
    file: 'tests/api/products.spec.ts',
    line: 13,
  });
  assert.deepEqual(sourceLocation('auth.setup.ts', 24), { file: 'tests/auth.setup.ts', line: 24 });
  for (const file of [
    '/home/runner/work/repo/tests/api/products.spec.ts',
    '../secrets.spec.ts',
    'api/../../x.spec.ts',
    'api\\products.spec.ts',
    'api/products.ts',
    'api/products.spec.ts\n::error::x',
    'api/pro%ducts.spec.ts',
    'C:/x.spec.ts',
    '',
    42,
  ]) {
    assert.equal(sourceLocation(file, 13), undefined, String(file));
  }
  for (const line of [0, -1, 1.5, Number.NaN, 10_000_000, '13', undefined]) {
    assert.equal(sourceLocation('api/products.spec.ts', line), undefined, String(line));
  }
});

test('unknown projects are labelled, never echoed', () => {
  const result = triaged(
    triage(
      report(
        spec({ project: `evil${SECRET}`, status: 'unexpected', results: [{ status: 'failed' }] }),
      ),
    ),
  );
  assert.equal(result.items[0]?.project, 'unrecognized-project');
});

test('invalid locations are withheld rather than published', () => {
  const result = triaged(
    triage(
      report(
        spec({ file: '/abs/x.spec.ts', status: 'unexpected', results: [{ status: 'failed' }] }),
      ),
    ),
  );
  assert.equal(result.items[0]?.location, undefined);
  assert.match(annotations(result, { errors: 10, warnings: 10 })[0] ?? '', /location withheld/);
  assert.doesNotMatch(annotations(result, { errors: 10, warnings: 10 })[0] ?? '', /file=/);
});

test('duplicate executions of one spec (setup per shard) are one logical test', () => {
  // Merging suffixes a repeated spec id (observed in 1.64.1), so ids differ.
  const setup = (id: string, status: string, results: Attempt[]): Record<string, unknown> =>
    spec({ file: 'auth.setup.ts', line: 24, id, project: 'setup', status, results });
  const ok = triaged(
    triage(
      report(
        setup('17e3-2bb8', 'expected', [{ status: 'passed' }]),
        setup('17e3-2bb81', 'expected', [{ status: 'passed' }]),
      ),
    ),
  );
  assert.equal(ok.logicalTests, 1);
  assert.equal(ok.executions, 2);
  assert.equal(ok.items[0]?.executions, 2);
  assert.equal(ok.executionCounts.passed, 2);
  assert.equal(ok.logicalCounts.passed, 1);

  // The most severe execution wins for the logical test.
  const mixed = triaged(
    triage(
      report(
        setup('17e3-2bb8', 'expected', [{ status: 'passed' }]),
        setup('17e3-2bb81', 'unexpected', [{ status: 'failed' }]),
      ),
    ),
  );
  assert.equal(mixed.items[0]?.category, 'failed');
  assert.deepEqual([mixed.executionCounts.passed, mixed.executionCounts.failed], [1, 1]);
});

test('specs without a safe identity, or with different titles, are not merged', () => {
  const noLocation = triaged(
    triage(report(spec({ file: '/abs/x.spec.ts' }), spec({ file: '/abs/x.spec.ts' }))),
  );
  assert.equal(noLocation.logicalTests, 2);
  // Loop-generated tests share a file and line but not a title.
  const looped = triaged(triage(report(spec({ title: 'case a' }), spec({ title: 'case b' }))));
  assert.equal(looped.logicalTests, 2);
  const untitled = triaged(triage(report(spec({ title: 7 }), spec({ title: 7 }))));
  assert.equal(untitled.logicalTests, 2);
});

test('invalid, empty, malformed and oversized reports are unavailable, never "all passed"', () => {
  for (const input of [
    null,
    [],
    'x',
    42,
    {},
    { suites: 'x' },
    { suites: [1] },
    { suites: [{ specs: 'x' }] },
  ]) {
    const result = triage(input);
    assert.equal(result.kind, 'unavailable', JSON.stringify(input));
  }
  assert.deepEqual(triage({ suites: [] }), { kind: 'unavailable', reason: 'report-empty' });
  assert.deepEqual(triage({ suites: [{ specs: [{ tests: [{ results: 'x' }] }] }] }), {
    kind: 'unavailable',
    reason: 'report-invalid-shape',
  });

  let deep: Record<string, unknown> = { specs: [] };
  for (let i = 0; i < 40; i++) {
    deep = { suites: [deep] };
  }
  assert.deepEqual(triage({ suites: [deep] }), {
    kind: 'unavailable',
    reason: 'report-invalid-shape',
  });

  const many = Array.from({ length: 10_001 }, (_, i) => spec({ id: `id-${i}` }));
  assert.deepEqual(triage(report(...many)), { kind: 'unavailable', reason: 'report-too-large' });
});

test('annotations are capped at the approved maximum and ordered deterministically', () => {
  const failing = Array.from({ length: 15 }, (_, i) =>
    spec({ id: `f-${i}`, line: 100 - i, status: 'unexpected', results: [{ status: 'failed' }] }),
  );
  const flaky = Array.from({ length: 12 }, (_, i) =>
    spec({
      id: `k-${i}`,
      line: i + 1,
      status: 'flaky',
      results: [{ status: 'failed' }, { status: 'passed' }],
    }),
  );
  const result = triaged(triage(report(...flaky, ...failing)));
  const out = annotations(result, { errors: 99, warnings: 99 });
  assert.equal(out.filter((l) => l.startsWith('::error ')).length, 10);
  assert.equal(out.filter((l) => l.startsWith('::warning ')).length, 10);
  assert.deepEqual(annotations(result, { errors: 3, warnings: 0 }).length, 3);
  assert.deepEqual(annotations(result, { errors: -5, warnings: 1.5 }), []);
  // Errors first, then by line; the same input gives byte-identical output.
  assert.match(out[0] ?? '', /line=86,/);
  assert.deepEqual(
    annotations(triaged(triage(report(...failing, ...flaky))), { errors: 99, warnings: 99 }),
    out,
  );
  // Counts in the summary stay complete even when annotations are capped.
  const text = summary(result);
  assert.match(text, /\| failed \| 15 \| 15 \|/);
  assert.match(text, /\| flaky \| 12 \| 12 \|/);
});

test('output never contains titles, messages, stacks, stdout, attachments, paths or metadata', () => {
  const result = triage(
    report(
      spec({ status: 'unexpected', results: [{ status: 'failed' }] }),
      spec({ line: 20, status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] }),
      spec({ line: 30, status: 'unexpected', results: [{ status: 'timedOut' }] }),
    ),
  );
  const text = [...annotations(result, { errors: 10, warnings: 10 }), summary(result)].join('\n');
  for (const forbidden of [
    SECRET,
    'ghp_',
    '<script>',
    'set-env',
    '/home/runner',
    'trace.zip',
    'Error:',
    'title %',
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  // Each annotation is exactly one line: no injected newlines or commands.
  for (const line of annotations(result, { errors: 10, warnings: 10 })) {
    assert.match(line, /^::(error|warning) [^\n]*::[^\n]*$/);
    assert.equal(line.split('::').length, 3, line);
  }
});

test('workflow-command escaping handles percent, newlines, colons and commas', () => {
  assert.equal(escapeData('a%b\r\nc'), 'a%25b%0D%0Ac');
  assert.equal(escapeProperty('a:b,c%\n'), 'a%3Ab%2Cc%25%0A');
});

test('summary and unavailable output use fixed text only', () => {
  const unavailable = triage('not a report');
  assert.deepEqual(annotations(unavailable, { errors: 10, warnings: 10 }), [
    '::warning title=Test triage unavailable::Test triage unavailable (report-invalid-shape). This is not a test result; see the gate.',
  ]);
  assert.match(summary(unavailable), /\*\*Unavailable\*\* \(`report-invalid-shape`\)/);
  assert.doesNotMatch(summary(unavailable), /No failed or flaky/);

  const passing = triaged(
    triage(report(spec(), spec({ line: 40, status: 'skipped', results: [] }))),
  );
  const text = summary(passing);
  assert.match(text, /Logical tests: 2 · Executions: 2/);
  assert.match(text, /\| did-not-run \| 1 \| 1 \|/);
  assert.match(text, /No failed or flaky tests\./);
  assert.deepEqual(annotations(passing, { errors: 10, warnings: 10 }), []);
});

test('annotation format is stable for a failed test', () => {
  const result = triage(
    report(spec({ status: 'unexpected', results: [{ status: 'failed' }, { status: 'failed' }] })),
  );
  assert.deepEqual(annotations(result, { errors: 10, warnings: 10 }), [
    '::error file=tests/api/products.spec.ts,line=13,title=Test triage%3A failed::failed · [api] · tests/api/products.spec.ts:13',
  ]);
});

/* ------------------------------------------------------------------ *
 * runTriage: fallback and crash paths (R1)
 * ------------------------------------------------------------------ */

interface Captured {
  readonly lines: string[];
  readonly summaries: string[];
}

function io(overrides: Partial<TriageIo>, captured: Captured): TriageIo {
  return {
    loadReport: () => Promise.resolve({ kind: 'parsed', value: report(spec()) }),
    print: (line) => captured.lines.push(line),
    appendSummary: (markdown) => {
      captured.summaries.push(markdown);
      return Promise.resolve();
    },
    ...overrides,
  };
}

function capture(): Captured {
  return { lines: [], summaries: [] };
}

const INTERNAL_WARNING = annotations(
  { kind: 'unavailable', reason: 'internal-error' },
  {
    errors: 10,
    warnings: 10,
  },
)[0];
const INTERNAL_SUMMARY = summary({ kind: 'unavailable', reason: 'internal-error' });

function assertNoLeak(captured: Captured): void {
  const text = [...captured.lines, ...captured.summaries].join('\n');
  for (const forbidden of [
    SECRET,
    'ghp_',
    '/home/runner',
    'Error:',
    '    at ',
    'synthetic-crash',
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
}

test('a valid report produces exactly the policy output and exit 0', async () => {
  const value = report(spec({ status: 'unexpected', results: [{ status: 'failed' }] }));
  const captured = capture();
  const code = await runTriage(
    io({ loadReport: () => Promise.resolve({ kind: 'parsed', value }) }, captured),
  );
  const expected = triage(value);
  assert.equal(code, 0);
  assert.deepEqual(captured.lines, [
    ...annotations(expected, { errors: 10, warnings: 10 }),
    'test triage: 1 logical tests, 1 executions classified',
  ]);
  assert.deepEqual(captured.summaries, [`${summary(expected)}\n`]);
});

test('a known unavailable reason keeps its own fixed output and exit 1', async () => {
  const captured = capture();
  const code = await runTriage(
    io(
      {
        loadReport: () => Promise.resolve({ kind: 'unavailable', reason: 'merge-not-successful' }),
      },
      captured,
    ),
  );
  assert.equal(code, 1);
  assert.deepEqual(captured.lines, [
    '::warning title=Test triage unavailable::Test triage unavailable (merge-not-successful). This is not a test result; see the gate.',
    'test triage: unavailable (merge-not-successful)',
  ]);
  assert.match(captured.summaries[0] ?? '', /\*\*Unavailable\*\* \(`merge-not-successful`\)/);
});

test('an exception while loading becomes internal-error, with no exception detail', async () => {
  const captured = capture();
  const code = await runTriage(
    io(
      { loadReport: () => Promise.reject(new Error(`synthetic-crash ${SECRET} /home/runner/x`)) },
      captured,
    ),
  );
  assert.equal(code, 1);
  assert.deepEqual(captured.lines, [INTERNAL_WARNING, 'test triage: unavailable (internal-error)']);
  assert.deepEqual(captured.summaries, [`${INTERNAL_SUMMARY}\n`]);
  assert.doesNotMatch(captured.summaries[0] ?? '', /Logical tests|\| failed \|/);
  assertNoLeak(captured);
});

test('an exception during classification becomes internal-error', async () => {
  const captured = capture();
  const code = await runTriage(
    io(
      {
        classify: () => {
          throw new Error(`synthetic-crash ${SECRET}`);
        },
      },
      captured,
    ),
  );
  assert.equal(code, 1);
  assert.deepEqual(captured.lines, [INTERNAL_WARNING, 'test triage: unavailable (internal-error)']);
  assertNoLeak(captured);
});

test('a rendering failure falls back to the fixed internal-error output', async () => {
  const captured = capture();
  // A malformed result makes rendering throw; the fallback uses constants only.
  const broken = { kind: 'triaged', items: null } as unknown as TriageResult;
  const code = await runTriage(io({ classify: () => broken }, captured));
  assert.equal(code, 1);
  assert.deepEqual(captured.lines, [INTERNAL_WARNING, 'test triage: unavailable (internal-error)']);
  assert.deepEqual(captured.summaries, [`${INTERNAL_SUMMARY}\n`]);
});

test('an unwritable summary prints one fixed warning and exits 1', async () => {
  const failingSummary = (): Promise<void> =>
    Promise.reject(new Error(`EACCES ${SECRET} /home/runner/summary`));

  const ok = capture();
  assert.equal(await runTriage(io({ appendSummary: failingSummary }, ok)), 1);
  assert.deepEqual(ok.lines.slice(-2), [
    '::warning title=Test triage::Test triage summary could not be written.',
    'test triage: 1 logical tests, 1 executions classified',
  ]);
  assertNoLeak(ok);

  // Combined with an internal error: still exactly one unavailable warning.
  const both = capture();
  const code = await runTriage(
    io(
      { loadReport: () => Promise.reject(new Error(SECRET)), appendSummary: failingSummary },
      both,
    ),
  );
  assert.equal(code, 1);
  assert.equal(both.lines.filter((l) => l.includes('Test triage unavailable')).length, 1);
  assertNoLeak(both);
});
