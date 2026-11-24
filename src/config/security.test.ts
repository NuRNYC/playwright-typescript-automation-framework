/**
 * Unit tests for the fail-closed execution and recording boundary (ADR-0005).
 *
 * Same conventions as `env.test.ts` (ADR-0002): Node's built-in runner, an
 * explicit `.ts` import, no ambient state. argv and runtime facts are plain
 * literals shaped like the ones measured in Playwright 1.64.1. Targets and
 * values are synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SecurityPolicyError,
  classifyProcess,
  effectiveConfigProblems,
  enforce,
  executionProblems,
  isRestricted,
  launchShapeProblems,
  recordingPolicy,
  type EffectiveRunConfig,
  type ExecutionSubject,
  type RuntimeFacts,
} from './security.ts';
import type { DeploymentTier } from './env.ts';

const CLI = '/repo/node_modules/.bin/playwright';
const WORKER = '/repo/node_modules/playwright/lib/worker/workerProcessEntry.js';
const LOADER = '/repo/node_modules/playwright/lib/loader/loaderProcessEntry.js';
const NODE = '/usr/local/bin/node';

const TIERS = [
  'public-demo',
  'internal-staging',
  'production',
] as const satisfies readonly DeploymentTier[];

function facts(overrides: Partial<RuntimeFacts> = {}): RuntimeFacts {
  return {
    argv: [NODE, CLI, 'test'],
    githubActions: undefined,
    restrictedAcknowledgment: undefined,
    pwDebug: undefined,
    pwTestReporter: undefined,
    ...overrides,
  };
}

const DEMO: ExecutionSubject = { target: 'saucedemo', tier: 'public-demo', execution: 'local' };
const STAGING: ExecutionSubject = {
  target: 'staging',
  tier: 'internal-staging',
  execution: 'local',
};
const ACK = { restrictedAcknowledgment: 'staging' } as const;

/* ------------------------------------------------------------------ *
 * Tiers and process classification
 * ------------------------------------------------------------------ */

test('every tier is classified; only public-demo is unrestricted', () => {
  assert.deepEqual(
    TIERS.map((tier) => [tier, isRestricted(tier)]),
    [
      ['public-demo', false],
      ['internal-staging', true],
      ['production', true],
    ],
  );
});

test('processes are classified from argv, never from an environment variable', () => {
  assert.equal(classifyProcess([NODE, CLI, 'test', 'tests/ui']), 'cli-test');
  assert.equal(
    classifyProcess([NODE, '/repo/node_modules/@playwright/test/cli.js', 'test']),
    'cli-test',
  );
  assert.equal(
    classifyProcess([NODE, 'C:\\repo\\node_modules\\.bin\\playwright.cmd', 'test']),
    'cli-test',
  );
  assert.equal(classifyProcess([NODE, WORKER]), 'worker');
  // UI mode's loader child, the test server (IDE path) and anything unknown:
  assert.equal(classifyProcess([NODE, LOADER]), 'other');
  assert.equal(classifyProcess([NODE, CLI, 'test-server']), 'other');
  assert.equal(classifyProcess([NODE, CLI, 'show-report']), 'other');
  assert.equal(classifyProcess([NODE, '/repo/scripts/run.js', 'test']), 'other');
  assert.equal(classifyProcess([]), 'other');
});

/* ------------------------------------------------------------------ *
 * Launch shape (I5a)
 * ------------------------------------------------------------------ */

test('the plain CLI shape with permitted options is accepted', () => {
  for (const args of [
    [],
    ['tests/ui/login.spec.ts'],
    ['--project=chromium'],
    ['--project', 'chromium', 'tests/ui'],
    ['-g', 'login', '--workers=2', '--retries', '0', '--list'],
    ['-x', '--max-failures=1', '--forbid-only', '--quiet'],
  ]) {
    assert.deepEqual(launchShapeProblems([NODE, CLI, 'test', ...args]), [], args.join(' '));
  }
});

test('UI, debug, reporter, trace, headed and config options are refused', () => {
  for (const option of [
    ['--ui'],
    ['--ui-host', '127.0.0.1'],
    ['--ui-port=0'],
    ['--debug'],
    ['--reporter', 'list'],
    ['--reporter=html'],
    ['--add-reporter=html'],
    ['--trace', 'on'],
    ['--trace=on'],
    ['--headed'],
    ['-c', 'other.config.ts'],
    ['--config=other.config.ts'],
    ['--update-snapshots'],
    ['--some-future-option'],
  ]) {
    const problems = launchShapeProblems([NODE, CLI, 'test', ...option]);
    assert.equal(problems.length >= 1, true, option.join(' '));
    assert.match(problems[0] ?? '', /is not permitted/, option.join(' '));
  }
});

test('non-CLI processes are refused, workers are not re-checked for options', () => {
  assert.match(launchShapeProblems([NODE, LOADER])[0] ?? '', /only a plain `playwright test`/);
  assert.match(launchShapeProblems([NODE, CLI, 'test-server'])[0] ?? '', /only a plain/);
  assert.deepEqual(launchShapeProblems([NODE, WORKER]), []);
});

test('option values are never echoed, and a missing value is reported', () => {
  const problems = launchShapeProblems([NODE, CLI, 'test', '--reporter=synthetic-secret-value']);
  assert.deepEqual(problems, ['option --reporter is not permitted for restricted targets']);
  assert.deepEqual(launchShapeProblems([NODE, CLI, 'test', '--project']), [
    'option --project requires a value',
  ]);
});

test('restricted targets refuse sharded and blob-reporting invocations (ADR-0007)', () => {
  // CI shards the public demo only. `--shard` is not on the allow-list, so a
  // restricted run cannot be split, and the shard job's blob reporter is
  // refused with it. Pinned here so a future allow-list edit is deliberate.
  for (const args of [
    ['--shard=1/2'],
    ['--shard', '2/2'],
    ['--shard=1/2', '--reporter=list,blob'],
  ]) {
    const problems = executionProblems(
      STAGING,
      facts({ ...ACK, argv: [NODE, CLI, 'test', ...args] }),
    );
    assert.equal(problems.length >= 1, true, args.join(' '));
    assert.match(problems[0] ?? '', /option --shard is not permitted/, args.join(' '));
  }
});

/* ------------------------------------------------------------------ *
 * Execution rules (I3, I4, I10)
 * ------------------------------------------------------------------ */

test('public-demo runs are unaffected by launch mode and CI', () => {
  for (const argv of [
    [NODE, CLI, 'test', '--ui'],
    [NODE, LOADER],
    [NODE, CLI, 'test', '--debug'],
  ]) {
    assert.deepEqual(executionProblems(DEMO, facts({ argv })), []);
  }
  assert.deepEqual(
    executionProblems({ ...DEMO, execution: 'ci' }, facts({ githubActions: 'true' })),
    [],
  );
});

test('a leftover acknowledgment on a public-demo run fails (I10)', () => {
  assert.match(
    executionProblems(DEMO, facts({ restrictedAcknowledgment: 'staging' }))[0] ?? '',
    /ALLOW_RESTRICTED_TARGET is set, but the selected target is a public demo/,
  );
});

test('CI markers refuse a restricted target even with a matching acknowledgment (I3)', () => {
  const ciByFlag = executionProblems({ ...STAGING, execution: 'ci' }, facts(ACK));
  const ciByGitHub = executionProblems(STAGING, facts({ ...ACK, githubActions: 'true' }));
  for (const problems of [ciByFlag, ciByGitHub]) {
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /may not run in CI/);
  }
});

test('the acknowledgment must equal the target name exactly (I4)', () => {
  for (const ack of [undefined, '', 'production', 'Staging', ' staging', 'staging ']) {
    assert.match(
      executionProblems(STAGING, facts({ restrictedAcknowledgment: ack })).join('\n'),
      /requires ALLOW_RESTRICTED_TARGET to equal the target name exactly/,
      JSON.stringify(ack),
    );
  }
  assert.deepEqual(executionProblems(STAGING, facts(ACK)), []);
  assert.deepEqual(
    executionProblems(
      { target: 'production', tier: 'production', execution: 'local' },
      facts({ restrictedAcknowledgment: 'production' }),
    ),
    [],
  );
});

test('restricted runs refuse unsafe launch modes and debug or reporter variables (I5a)', () => {
  assert.match(
    executionProblems(STAGING, facts({ ...ACK, argv: [NODE, CLI, 'test', '--ui'] })).join(),
    /--ui is not permitted/,
  );
  assert.match(
    executionProblems(STAGING, facts({ ...ACK, argv: [NODE, LOADER] })).join(),
    /only a plain/,
  );
  assert.match(executionProblems(STAGING, facts({ ...ACK, pwDebug: '1' })).join(), /PWDEBUG/);
  assert.match(
    executionProblems(STAGING, facts({ ...ACK, pwTestReporter: 'html' })).join(),
    /PW_TEST_REPORTER/,
  );
  assert.deepEqual(executionProblems(STAGING, facts({ ...ACK, argv: [NODE, WORKER] })), []);
});

/* ------------------------------------------------------------------ *
 * Recording policy (I6, I7)
 * ------------------------------------------------------------------ */

test('the public-demo recording policy is exactly the pre-ADR-0005 configuration', () => {
  assert.deepEqual(recordingPolicy('public-demo'), {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: undefined,
    reporter: [['list'], ['html', { open: 'never' }]],
  });
});

test('restricted tiers record nothing and report to the console only', () => {
  for (const tier of ['internal-staging', 'production'] as const) {
    assert.deepEqual(recordingPolicy(tier), {
      trace: 'off',
      screenshot: 'off',
      video: 'off',
      reporter: [['list']],
    });
  }
});

/* ------------------------------------------------------------------ *
 * Effective configuration (I5b)
 * ------------------------------------------------------------------ */

function effective(
  overrides: Partial<EffectiveRunConfig['projects'][number]> = {},
  reporters = ['list'],
): EffectiveRunConfig {
  return {
    reporters,
    projects: [
      {
        name: 'chromium',
        trace: 'off',
        screenshot: 'off',
        video: 'off',
        headless: undefined,
        ...overrides,
      },
    ],
  };
}

test('the safe restricted effective configuration passes; public demos are never checked', () => {
  assert.deepEqual(effectiveConfigProblems('internal-staging', effective(), facts()), []);
  assert.deepEqual(
    effectiveConfigProblems('internal-staging', effective({ trace: { mode: 'off' } }), facts()),
    [],
  );
  assert.deepEqual(
    effectiveConfigProblems(
      'public-demo',
      effective({ trace: 'on' }, ['list', 'html']),
      facts({ pwDebug: '1' }),
    ),
    [],
  );
});

test('unsafe effective reporters are refused, including added reporters', () => {
  for (const reporters of [['list', 'html'], ['html'], ['list', 'html', 'html'], [], ['dot']]) {
    assert.match(
      effectiveConfigProblems('production', effective({}, reporters), facts()).join(),
      /effective reporters must be exactly \[list\]/,
      reporters.join(','),
    );
  }
});

test('any recording, headed mode or PWDEBUG is refused in the effective configuration', () => {
  const cases: [Partial<EffectiveRunConfig['projects'][number]>, RegExp][] = [
    [{ trace: 'on' }, /trace must be off/],
    [{ trace: 'retain-on-failure' }, /trace must be off/],
    [{ trace: { mode: 'on', snapshots: false } }, /trace must be off/],
    [{ screenshot: 'only-on-failure' }, /screenshot must be off/],
    [{ video: undefined }, /video must be off/],
    [{ headless: false }, /headed mode is not permitted/],
  ];
  for (const [project, problem] of cases) {
    assert.match(
      effectiveConfigProblems('internal-staging', effective(project), facts()).join(),
      problem,
    );
  }
  assert.match(
    effectiveConfigProblems('internal-staging', effective(), facts({ pwDebug: '1' })).join(),
    /PWDEBUG/,
  );
});

test('enforce throws one SecurityPolicyError listing every problem', () => {
  assert.doesNotThrow(() => enforce('Checkpoint', []));
  assert.throws(
    () => enforce('Checkpoint', ['first', 'second']),
    (error: unknown) => {
      assert.ok(error instanceof SecurityPolicyError);
      assert.match(error.message, /Checkpoint refused this run \(ADR-0005\):\n- first\n- second/);
      return true;
    },
  );
});
