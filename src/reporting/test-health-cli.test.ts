/**
 * Tests for the test-health CLI (ADR-0012 amendment, Phase C2).
 *
 * Every case runs in a fresh temporary working directory with the real
 * no-follow filesystem adapter; all inputs are synthetic. Nothing reads the
 * environment, a real report, an artifact or the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANARY, SYNTHETIC_SHA, canaryReport, context, passing, report, spec } from './fixtures.ts';
import { normalize } from './quality-summary.ts';
import { nodeFs } from './quality-summary-cli.ts';
import {
  HEALTH_JSON,
  HEALTH_MARKDOWN,
  healthMessage,
  parseHealthArgs,
  runTestHealth,
  type HealthCliDeps,
  type HealthFs,
} from './test-health-cli.ts';
import { serializeUnitResults, type UnitResultsDocument } from './unit-results.ts';

const ID = ['--run-id', '1000001', '--run-attempt', '1', '--source-sha', SYNTHETIC_SHA];
const NOW = '2026-11-28T12:00:00.000Z';

function unitDoc(overrides: Partial<UnitResultsDocument> = {}): UnitResultsDocument {
  const counts = { tests: 4, passed: 2, failed: 2, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
  return {
    kind: 'unit-test-results',
    schemaVersion: '1.0.0',
    nodeVersion: 'v24.22.3',
    success: false,
    counts,
    events: counts,
    execution: { startedAt: '2026-11-28T11:00:00.000Z', finishedAt: '2026-11-28T11:00:05.000Z' },
    provenance: null,
    ...overrides,
  };
}

function summaryText(runId = 1_000_001, reportValue: unknown = undefined): string {
  const r =
    reportValue ??
    report([
      spec('ui/dashboard.spec.ts', 10, 'synthetic dashboard', [passing('chromium')]),
      spec('api/products.spec.ts', 11, 'synthetic api', [passing('api')]),
    ]);
  return JSON.stringify(normalize(r, context({ runId })));
}

const HEALTH_FS: HealthFs = {
  ...nodeFs,
  removeEmptyDir: (path) => {
    rmdirSync(path);
  },
};

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `synthetic-staging-${String(idCounter).padStart(4, '0')}`;
}

function withCwd(fn: (cwd: string, deps: HealthCliDeps) => void): void {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'test-health-cli-')));
  try {
    fn(cwd, { cwd, now: () => NOW, randomId: nextId, fs: HEALTH_FS });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function put(cwd: string, name: string, data: string): string {
  writeFileSync(join(cwd, name), data);
  return name;
}

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

test('invalid arguments are usage errors with exit status 2', () => {
  for (const argv of [
    [],
    ['bogus'],
    ['stamp', '--unit', 'u.json', '--out', 'o.json'],
    ['stamp', '--unit', 'u.json', '--out', 'o.json', ...ID, '--mode', 'ci'],
    ['render', '--mode', 'local', '--out', 'out'],
    ['render', '--mode', 'local', '--unit', 'u.json', '--out', 'out', ...ID],
    ['render', '--mode', 'local', '--unit', 'u.json', '--summary', 's.json', '--out', 'out'],
    ['render', '--mode', 'ci', ...ID, '--out', 'out'],
    ['render', '--mode', 'ci', '--unit', 'u.json', '--out', 'out'],
    ['render', '--mode', 'other', '--unit', 'u.json', '--out', 'out'],
    ['render', '--mode', 'local', '--unit', 'u.json', '--unit', 'v.json', '--out', 'out'],
    [
      'render',
      '--mode',
      'ci',
      '--unit',
      'u.json',
      '--out',
      'out',
      '--run-id',
      '0',
      '--run-attempt',
      '1',
      '--source-sha',
      SYNTHETIC_SHA,
    ],
    [
      'render',
      '--mode',
      'ci',
      '--unit',
      'u.json',
      '--out',
      'out',
      '--run-id',
      '1',
      '--run-attempt',
      '1',
      '--source-sha',
      'ABC',
    ],
    ['render', '--mode', 'local', '--unit', '', '--out', 'out'],
    ['render', '--mode', 'local', '--unit', 'u.json', '--out'],
  ]) {
    assert.equal(parseHealthArgs(argv), undefined, argv.join(' '));
    withCwd((_cwd, deps) => {
      assert.deepEqual(runTestHealth(argv, deps), { exitCode: 2, code: 'usage' });
    });
  }
});

/* ------------------------------------------------------------------ *
 * Stamp
 * ------------------------------------------------------------------ */

test('stamp records the supplied identity once and refuses to relabel', () => {
  withCwd((cwd, deps) => {
    put(cwd, 'raw.json', serializeUnitResults(unitDoc()));
    const first = runTestHealth(
      ['stamp', '--unit', 'raw.json', '--out', 'stamped.json', ...ID],
      deps,
    );
    assert.deepEqual(first, { exitCode: 0, code: 'stamped' });
    const stamped = JSON.parse(readFileSync(join(cwd, 'stamped.json'), 'utf8')) as {
      provenance: unknown;
    };
    assert.deepEqual(stamped.provenance, {
      mode: 'ci',
      runId: 1_000_001,
      runAttempt: 1,
      sourceSha: SYNTHETIC_SHA,
    });
    const again = runTestHealth(
      ['stamp', '--unit', 'stamped.json', '--out', 'again.json', ...ID],
      deps,
    );
    assert.deepEqual(again, { exitCode: 1, code: 'already-stamped' });
    assert.equal(existsSync(join(cwd, 'again.json')), false);
    // Existing output is never overwritten.
    const exists = runTestHealth(
      ['stamp', '--unit', 'raw.json', '--out', 'stamped.json', ...ID],
      deps,
    );
    assert.deepEqual(exists, { exitCode: 1, code: 'output-exists' });
    assert.deepEqual(
      runTestHealth(['stamp', '--unit', 'missing.json', '--out', 'x.json', ...ID], deps),
      { exitCode: 1, code: 'input-missing' },
    );
    put(cwd, 'empty.json', '');
    assert.deepEqual(
      runTestHealth(['stamp', '--unit', 'empty.json', '--out', 'x.json', ...ID], deps),
      { exitCode: 1, code: 'input-unusable' },
    );
    assert.equal(existsSync(join(cwd, 'x.json')), false);
  });
});

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function stamped(cwd: string, deps: HealthCliDeps, doc = unitDoc()): string {
  put(cwd, 'raw.json', serializeUnitResults(doc));
  assert.equal(
    runTestHealth(['stamp', '--unit', 'raw.json', '--out', 'unit.json', ...ID], deps).exitCode,
    0,
  );
  return 'unit.json';
}

test('CI render combines matching inputs; failing tests still produce exit 0 output', () => {
  withCwd((cwd, deps) => {
    stamped(cwd, deps);
    put(cwd, 'summary.json', summaryText());
    const result = runTestHealth(
      [
        'render',
        '--mode',
        'ci',
        ...ID,
        '--unit',
        'unit.json',
        '--summary',
        'summary.json',
        '--out',
        'health',
      ],
      deps,
    );
    // Exit 0: the health output was produced. The unit tests themselves failed.
    assert.deepEqual(result, {
      exitCode: 0,
      code: 'written',
      states: { unit: 'complete', playwright: 'partial' },
    });
    assert.equal(
      healthMessage(result),
      'test health written (unit: complete; playwright: partial)',
    );
    assert.deepEqual(readdirSync(join(cwd, 'health')).sort(), [HEALTH_JSON, HEALTH_MARKDOWN]);
    const markdown = readFileSync(join(cwd, 'health', HEALTH_MARKDOWN), 'utf8');
    assert.match(markdown, /^## Test health — CI diagnostic/);
    assert.match(markdown, /\| 4 \| 2 \| 2 \| 0 \| 0 \| 0 \| 0 \|/);
    const model = JSON.parse(readFileSync(join(cwd, 'health', HEALTH_JSON), 'utf8')) as {
      generatedAt: string;
      unit: { counts: { failed: number } };
    };
    assert.equal(model.generatedAt, NOW);
    assert.equal(model.unit.counts.failed, 2);
    for (const text of [markdown, readFileSync(join(cwd, 'health', HEALTH_JSON), 'utf8')]) {
      assert.equal(text.includes(cwd), false);
      assert.equal(text.includes('synthetic dashboard'), false);
    }
  });
});

test('mismatched provenance refuses the render and writes nothing', () => {
  withCwd((cwd, deps) => {
    stamped(cwd, deps);
    put(cwd, 'summary.json', summaryText(1_000_002));
    const summaryMismatch = runTestHealth(
      [
        'render',
        '--mode',
        'ci',
        ...ID,
        '--unit',
        'unit.json',
        '--summary',
        'summary.json',
        '--out',
        'h1',
      ],
      deps,
    );
    assert.deepEqual(summaryMismatch, { exitCode: 1, code: 'provenance-mismatch' });
    assert.equal(existsSync(join(cwd, 'h1')), false);
    const otherRun = ['--run-id', '1000001', '--run-attempt', '2', '--source-sha', SYNTHETIC_SHA];
    const unitMismatch = runTestHealth(
      ['render', '--mode', 'ci', ...otherRun, '--unit', 'unit.json', '--out', 'h2'],
      deps,
    );
    assert.deepEqual(unitMismatch, { exitCode: 1, code: 'provenance-mismatch' });
    assert.equal(existsSync(join(cwd, 'h2')), false);
    // A stamped (CI) result is never rendered as local output.
    const local = runTestHealth(
      ['render', '--mode', 'local', '--unit', 'unit.json', '--out', 'h3'],
      deps,
    );
    assert.deepEqual(local, { exitCode: 1, code: 'provenance-mismatch' });
    assert.equal(existsSync(join(cwd, 'h3')), false);
  });
});

test('a missing or unusable input only makes its own section unavailable', () => {
  withCwd((cwd, deps) => {
    put(cwd, 'summary.json', summaryText());
    const noUnit = runTestHealth(
      [
        'render',
        '--mode',
        'ci',
        ...ID,
        '--unit',
        'absent.json',
        '--summary',
        'summary.json',
        '--out',
        'a',
      ],
      deps,
    );
    assert.deepEqual(noUnit.states, { unit: 'unavailable', playwright: 'partial' });
    assert.match(readFileSync(join(cwd, 'a', HEALTH_MARKDOWN), 'utf8'), /`unit-results-missing`/);

    stamped(cwd, deps);
    const noSummary = runTestHealth(
      [
        'render',
        '--mode',
        'ci',
        ...ID,
        '--unit',
        'unit.json',
        '--summary',
        'absent.json',
        '--out',
        'b',
      ],
      deps,
    );
    assert.deepEqual(noSummary.states, { unit: 'complete', playwright: 'unavailable' });

    put(cwd, 'malformed.json', '{not json');
    put(cwd, 'large.json', ' '.repeat(17 * 1024));
    put(cwd, 'empty.json', '');
    for (const [file, reason] of [
      ['malformed.json', 'unit-results-invalid'],
      ['large.json', 'unit-results-invalid'],
      ['empty.json', 'unit-results-incomplete'],
    ] as const) {
      const out = `c-${file}`;
      const r = runTestHealth(
        [
          'render',
          '--mode',
          'ci',
          ...ID,
          '--unit',
          file,
          '--summary',
          'summary.json',
          '--out',
          out,
        ],
        deps,
      );
      assert.equal(r.exitCode, 0);
      assert.match(
        readFileSync(join(cwd, out, HEALTH_MARKDOWN), 'utf8'),
        new RegExp(`\`${reason}\``),
      );
    }
    put(cwd, 'bad-summary.json', '{not json');
    const badSummary = runTestHealth(
      [
        'render',
        '--mode',
        'ci',
        ...ID,
        '--unit',
        'unit.json',
        '--summary',
        'bad-summary.json',
        '--out',
        'd',
      ],
      deps,
    );
    assert.deepEqual(badSummary.states, { unit: 'complete', playwright: 'unavailable' });
  });
});

test('local render is labelled local and accepts only unstamped results', () => {
  withCwd((cwd, deps) => {
    put(cwd, 'raw.json', serializeUnitResults(unitDoc()));
    const result = runTestHealth(
      ['render', '--mode', 'local', '--unit', 'raw.json', '--out', 'local'],
      deps,
    );
    assert.equal(result.exitCode, 0);
    const markdown = readFileSync(join(cwd, 'local', HEALTH_MARKDOWN), 'utf8');
    assert.match(markdown, /^## Test health — LOCAL output, not CI evidence/);
    assert.doesNotMatch(markdown, /Run ID|Source commit/);
  });
});

test('unsafe paths and existing outputs are refused', () => {
  withCwd((cwd, deps) => {
    put(cwd, 'raw.json', serializeUnitResults(unitDoc()));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'test-health-outside-')));
    try {
      writeFileSync(join(outside, 'raw.json'), serializeUnitResults(unitDoc()));
      mkdirSync(join(cwd, '.auth'));
      put(cwd, '.auth/raw.json', serializeUnitResults(unitDoc()));
      symlinkSync(join(cwd, 'raw.json'), join(cwd, 'link.json'));
      for (const unit of [
        join(outside, 'raw.json'),
        '../raw.json',
        '.auth/raw.json',
        'link.json',
      ]) {
        assert.deepEqual(
          runTestHealth(['render', '--mode', 'local', '--unit', unit, '--out', 'o'], deps),
          { exitCode: 1, code: 'unsafe-path' },
          unit,
        );
      }
      for (const out of [join(outside, 'out'), '.auth/out', 'missing-parent/out', '.']) {
        assert.deepEqual(
          runTestHealth(['render', '--mode', 'local', '--unit', 'raw.json', '--out', out], deps),
          { exitCode: 1, code: 'unsafe-path' },
          out,
        );
      }
      assert.deepEqual(readdirSync(outside), ['raw.json']);
      mkdirSync(join(cwd, 'existing'));
      writeFileSync(join(cwd, 'existing', 'keep.txt'), 'keep\n');
      assert.deepEqual(
        runTestHealth(
          ['render', '--mode', 'local', '--unit', 'raw.json', '--out', 'existing'],
          deps,
        ),
        { exitCode: 1, code: 'output-exists' },
      );
      assert.deepEqual(readdirSync(join(cwd, 'existing')), ['keep.txt']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('rendered output is aggregate-only even for a canary-laden summary', () => {
  withCwd((cwd, deps) => {
    put(cwd, 'summary.json', summaryText(1_000_001, canaryReport()));
    const r = runTestHealth(
      ['render', '--mode', 'ci', ...ID, '--summary', 'summary.json', '--out', 'h'],
      deps,
    );
    assert.equal(r.exitCode, 0);
    for (const name of [HEALTH_JSON, HEALTH_MARKDOWN]) {
      const text = readFileSync(join(cwd, 'h', name), 'utf8');
      assert.equal(text.includes(CANARY), false, name);
      assert.equal(/\/home\/|\/Users\//.test(text), false, name);
    }
  });
});

test('the entry script prints one fixed line and sets the exit status', () => {
  withCwd((cwd) => {
    put(cwd, 'raw.json', serializeUnitResults(unitDoc()));
    const script = join(process.cwd(), 'scripts', 'test-health.ts');
    const ok = spawnSync(
      process.execPath,
      ['--no-warnings', script, 'render', '--mode', 'local', '--unit', 'raw.json', '--out', 'h'],
      { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'test health written (unit: complete; playwright: unavailable)\n');
    const usage = spawnSync(process.execPath, ['--no-warnings', script], {
      cwd,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /^usage: /);
    assert.equal(`${ok.stdout}${usage.stderr}`.includes(cwd), false);
  });
});

/* ------------------------------------------------------------------ *
 * Review fixes
 * ------------------------------------------------------------------ */

test('run IDs and attempts must be positive safe integers before any file I/O', () => {
  const max = String(Number.MAX_SAFE_INTEGER);
  const over = '9007199254740992';
  const identity = (runId: string, runAttempt: string) => [
    '--run-id',
    runId,
    '--run-attempt',
    runAttempt,
    '--source-sha',
    SYNTHETIC_SHA,
  ];
  const render = (id: string[]) => [
    'render',
    '--mode',
    'ci',
    ...id,
    '--unit',
    'u.json',
    '--out',
    'o',
  ];
  assert.notEqual(parseHealthArgs(render(identity(max, max))), undefined);
  for (const [runId, runAttempt] of [
    [over, '1'],
    ['1', over],
    ['1', '0'],
    ['1', '-1'],
    ['1', '1.5'],
    ['1', '01'],
  ] as const) {
    assert.equal(parseHealthArgs(render(identity(runId, runAttempt))), undefined, runAttempt);
    let calls = 0;
    const counting = new Proxy(HEALTH_FS, {
      get(target, key, receiver) {
        calls += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const result = runTestHealth(render(identity(runId, runAttempt)), {
      cwd: tmpdir(),
      now: () => NOW,
      randomId: nextId,
      fs: counting,
    });
    assert.deepEqual(result, { exitCode: 2, code: 'usage' });
    assert.equal(calls, 0, 'no filesystem access before arguments are valid');
  }
});

test('a failed second write publishes no bundle and leaves existing files unchanged', () => {
  withCwd((cwd, deps) => {
    put(cwd, 'raw.json', serializeUnitResults(unitDoc()));
    mkdirSync(join(cwd, 'reports'));
    writeFileSync(join(cwd, 'reports', 'keep.txt'), 'keep\n');
    let writes = 0;
    const failing: HealthFs = {
      ...HEALTH_FS,
      writeNew: (path, data) => {
        writes += 1;
        return writes === 2 ? { status: 'failed' } : HEALTH_FS.writeNew(path, data);
      },
    };
    const result = runTestHealth(
      ['render', '--mode', 'local', '--unit', 'raw.json', '--out', 'reports/health'],
      { ...deps, fs: failing },
    );
    assert.deepEqual(result, { exitCode: 1, code: 'write-failed' });
    assert.equal(writes, 2);
    // No final bundle, no leftover staging directory, unrelated files intact.
    assert.deepEqual(readdirSync(join(cwd, 'reports')), ['keep.txt']);
    assert.equal(readFileSync(join(cwd, 'reports', 'keep.txt'), 'utf8'), 'keep\n');
    assert.equal(readFileSync(join(cwd, 'raw.json'), 'utf8'), serializeUnitResults(unitDoc()));
    // A later render with a working filesystem succeeds normally.
    const ok = runTestHealth(
      ['render', '--mode', 'local', '--unit', 'raw.json', '--out', 'reports/health'],
      deps,
    );
    assert.equal(ok.exitCode, 0);
    assert.deepEqual(readdirSync(join(cwd, 'reports')).sort(), ['health', 'keep.txt']);
    assert.deepEqual(readdirSync(join(cwd, 'reports', 'health')).sort(), [
      HEALTH_JSON,
      HEALTH_MARKDOWN,
    ]);
  });
});

test('an output created while rendering is never replaced', () => {
  withCwd((cwd, deps) => {
    put(cwd, 'raw.json', serializeUnitResults(unitDoc()));
    let writes = 0;
    const racing: HealthFs = {
      ...HEALTH_FS,
      writeNew: (path, data) => {
        writes += 1;
        if (writes === 2) {
          mkdirSync(join(cwd, 'health'));
          writeFileSync(join(cwd, 'health', 'other.txt'), 'other\n');
        }
        return HEALTH_FS.writeNew(path, data);
      },
    };
    const result = runTestHealth(
      ['render', '--mode', 'local', '--unit', 'raw.json', '--out', 'health'],
      { ...deps, fs: racing },
    );
    assert.deepEqual(result, { exitCode: 1, code: 'output-exists' });
    assert.deepEqual(readdirSync(join(cwd, 'health')), ['other.txt']);
    assert.deepEqual(readdirSync(cwd).sort(), ['health', 'raw.json']);
  });
});
