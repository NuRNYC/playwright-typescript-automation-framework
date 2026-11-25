/**
 * Synthetic fixtures for the quality-summary normalizer tests (ADR-0009, M8A).
 *
 * Reports are shaped like the merged JSON report of Playwright 1.64.1
 * (`config.projects[].repeatEach`, `suites[].specs[].tests[].results[]`,
 * `stats`). Every value is synthetic; nothing is read from a real run, a CI
 * artifact or saved authentication state. Spec files are relative to
 * `testDir`, as the JSON reporter writes them.
 *
 * Kept free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import {
  GATE_INPUT_NAMES,
  KNOWN_PROJECTS,
  validateRunContext,
  type ValidatedRunContext,
} from './quality-summary.ts';

export const SYNTHETIC_SHA = '0123456789abcdef0123456789abcdef01234567';
export const SYNTHETIC_TIME = '2026-11-25T00:00:00.000Z';

/**
 * A unique marker placed in every prohibited input field. Built at runtime so
 * no literal resembling a credential is committed. The serialized summary
 * must never contain it.
 */
export const CANARY = ['canary', 'SYNTHETIC'.repeat(3), '7f3a9e'].join('-');

export function contextInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 1_000_001,
    runAttempt: 1,
    event: 'push',
    headSha: SYNTHETIC_SHA,
    branch: 'main',
    generatedAt: SYNTHETIC_TIME,
    reportState: 'provided',
    gateInputs: Object.fromEntries(GATE_INPUT_NAMES.map((name) => [name, 'success'])),
    ...overrides,
  };
}

export function context(overrides: Record<string, unknown> = {}): ValidatedRunContext {
  const result = validateRunContext(contextInput(overrides));
  if (!result.ok) {
    throw new Error(`synthetic context rejected: ${result.problem}`);
  }
  return result.context;
}

export interface SyntheticResult {
  readonly status: unknown;
  readonly retry: unknown;
  readonly duration: unknown;
  readonly [extra: string]: unknown;
}

export interface SyntheticTest {
  readonly projectName: unknown;
  readonly status: unknown;
  readonly expectedStatus: unknown;
  readonly results: readonly SyntheticResult[];
  readonly [extra: string]: unknown;
}

export interface SyntheticSpec {
  readonly title: unknown;
  readonly file: unknown;
  readonly line: unknown;
  readonly column: unknown;
  readonly tags: readonly unknown[];
  readonly tests: readonly SyntheticTest[];
  readonly [extra: string]: unknown;
}

export function attempt(
  status: unknown,
  retry: unknown = 0,
  duration: unknown = 25,
): SyntheticResult {
  return {
    workerIndex: 0,
    parallelIndex: 0,
    status,
    duration,
    retry,
    startTime: SYNTHETIC_TIME,
    errors: [],
    stdout: [],
    stderr: [],
    attachments: [],
    annotations: [],
  };
}

export function testEntry(
  projectName: unknown,
  status: unknown,
  results: readonly SyntheticResult[],
  expectedStatus: unknown = 'passed',
): SyntheticTest {
  return {
    timeout: 30_000,
    annotations: [],
    expectedStatus,
    projectId: typeof projectName === 'string' ? projectName : 'synthetic',
    projectName,
    results,
    status,
  };
}

/** One passing attempt in `project`. */
export function passing(project: string): SyntheticTest {
  return testEntry(project, 'expected', [attempt('passed')]);
}

export function spec(
  file: unknown,
  line: unknown,
  title: unknown,
  tests: readonly SyntheticTest[],
  options: { column?: unknown; tags?: readonly unknown[] } = {},
): SyntheticSpec {
  return {
    title,
    ok: true,
    tags: options.tags ?? [],
    tests,
    id: `synthetic-${String(line)}`,
    file,
    line,
    column: options.column ?? 3,
  };
}

export interface ProjectConfig {
  readonly name: string;
  readonly repeatEach: unknown;
}

export const DEFAULT_PROJECTS: readonly ProjectConfig[] = Object.keys(KNOWN_PROJECTS).map(
  (name) => ({ name, repeatEach: 1 }),
);

/** Playwright-style stats for the given specs: one entry per test (execution). */
export function statsFor(specs: readonly SyntheticSpec[]): Record<string, number> {
  const stats: Record<string, number> = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  for (const s of specs) {
    for (const t of s.tests) {
      if (typeof t.status === 'string' && t.status in stats) {
        stats[t.status] = (stats[t.status] ?? 0) + 1;
      }
    }
  }
  return stats;
}

export function report(
  specs: readonly SyntheticSpec[],
  options: { projects?: readonly ProjectConfig[]; stats?: unknown } = {},
): Record<string, unknown> {
  return {
    config: {
      rootDir: '/home/runner/work/synthetic/tests',
      projects: (options.projects ?? DEFAULT_PROJECTS).map((p) => ({
        name: p.name,
        id: p.name,
        repeatEach: p.repeatEach,
        retries: 2,
        outputDir: '/home/runner/work/synthetic/test-results',
        testDir: '/home/runner/work/synthetic/tests',
        metadata: {},
      })),
      metadata: {},
    },
    suites: [{ title: 'synthetic', file: 'synthetic', line: 0, column: 0, specs, suites: [] }],
    errors: [],
    stats: options.stats ?? { ...statsFor(specs), startTime: SYNTHETIC_TIME, duration: 1000 },
  };
}

/**
 * The repository's shape at ADR-0009 time, as a regression fixture only:
 * 12 definitions, 18 project-expanded instances and 19 executions (the setup
 * test appears once per shard). Not a production expectation.
 */
export function twelveEighteenNineteen(): Record<string, unknown> {
  const browsers = ['chromium', 'firefox', 'webkit'];
  const authenticated = browsers.map((b) => `${b}-authenticated`);
  const specs: SyntheticSpec[] = [
    spec('ui/login.spec.ts', 15, 'synthetic login valid', browsers.map(passing), {
      tags: ['smoke'],
    }),
    spec('ui/login.spec.ts', 33, 'synthetic login invalid', browsers.map(passing), {
      tags: ['smoke'],
    }),
    spec('ui/login.a11y.spec.ts', 14, 'synthetic login a11y', [passing('chromium')], {
      tags: ['a11y'],
    }),
    spec('ui/authenticated/cart.spec.ts', 16, 'synthetic cart', authenticated.map(passing), {
      tags: ['smoke'],
    }),
    spec(
      'ui/authenticated/inventory.a11y.spec.ts',
      14,
      'synthetic inventory a11y',
      [passing('chromium-authenticated')],
      { tags: ['a11y'] },
    ),
    // One entry per shard, as merge-reports produces them (mergeTestCases: false).
    spec('auth.setup.ts', 24, 'synthetic setup', [passing('setup')], { column: 1 }),
    spec('auth.setup.ts', 24, 'synthetic setup', [passing('setup')], { column: 1 }),
    ...[13, 19, 25, 31, 45, 51].map((line) =>
      spec('api/products.spec.ts', line, `synthetic api ${line}`, [passing('api')], {
        tags: ['api'],
      }),
    ),
  ];
  return report(specs);
}

/** A report with the canary in every prohibited field at every level. */
export function canaryReport(): Record<string, unknown> {
  const leakyResult = (status: string, retry: number): SyntheticResult => ({
    ...attempt(status, retry),
    error: { message: CANARY, stack: `/home/runner/${CANARY}.ts:1:1`, value: CANARY },
    errors: [{ message: CANARY, location: { file: `/home/${CANARY}`, line: 1, column: 1 } }],
    errorLocation: { file: `/abs/${CANARY}.ts`, line: 1, column: 1 },
    stdout: [{ text: CANARY }, { buffer: CANARY }],
    stderr: [{ text: CANARY }],
    steps: [{ title: CANARY, duration: 1, steps: [{ title: CANARY, duration: 1 }] }],
    attachments: [
      { name: CANARY, path: `/home/runner/${CANARY}/trace.zip`, contentType: 'application/zip' },
      { name: 'screenshot', body: CANARY, contentType: 'image/png' },
    ],
    annotations: [{ type: CANARY, description: CANARY }],
    [CANARY]: CANARY,
  });
  const leakyTest = (projectName: string, results: SyntheticResult[]): SyntheticTest => ({
    ...testEntry(projectName, 'flaky', results),
    annotations: [{ type: 'issue', description: CANARY }],
    projectId: CANARY,
    [CANARY]: CANARY,
  });
  const specs: SyntheticSpec[] = [
    {
      ...spec(
        'ui/login.spec.ts',
        15,
        `${CANARY} title`,
        [leakyTest('chromium', [leakyResult('failed', 0), leakyResult('passed', 1)])],
        { tags: ['smoke', CANARY] },
      ),
      id: CANARY,
      [CANARY]: CANARY,
    },
    // Prohibited values in identity fields: never emitted.
    spec(`/home/runner/${CANARY}/x.spec.ts`, 1, CANARY, [passing('chromium')]),
    spec('ui/login.spec.ts', 40, CANARY, [
      testEntry(CANARY, CANARY, [attempt(CANARY, CANARY, CANARY)], CANARY),
    ]),
  ];
  return {
    ...report(specs, { stats: { expected: 1, unexpected: 0, flaky: 1, skipped: 0, [CANARY]: 1 } }),
    config: {
      rootDir: `/home/runner/${CANARY}`,
      argv: [CANARY],
      projects: [
        ...DEFAULT_PROJECTS.map((p) => ({ name: p.name, repeatEach: 1, outputDir: CANARY })),
        { name: CANARY, repeatEach: 1 },
      ],
      metadata: {
        gitCommit: { author: { name: CANARY, email: `${CANARY}@example.com` }, subject: CANARY },
        gitDiff: CANARY,
        ci: { prTitle: CANARY, commitHref: CANARY },
      },
    },
    errors: [{ message: CANARY }],
    [CANARY]: CANARY,
  };
}

/** Deep copy with object keys reversed, to prove output does not depend on key order. */
export function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reorderKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reorderKeys(v)]),
    );
  }
  return value;
}

/** Deep freeze, to prove `normalize` does not mutate its input. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
