/**
 * Fail-closed execution and recording boundary (ADR-0005). Pure.
 *
 * Every decision here takes its inputs as parameters -- the resolved
 * configuration, a snapshot of runtime facts, or the effective Playwright
 * settings -- so `security.test.ts` can cover each rule with plain objects.
 * The real `process.env` / `process.argv` are read only in `./index.ts`.
 *
 * What this is: a safety rail against ACCIDENTAL misconfiguration, such as a
 * real target running in public CI or with recording switched on.
 * What this is not: authentication, a sandbox, or proof that a machine is
 * private. Anyone who can set environment variables or edit this code can get
 * past it; review and branch protection are the controls for that.
 *
 * Kept free of `@/` imports and runtime imports (type-only imports are erased)
 * so Node's type-stripping test runner can load it directly (ADR-0002).
 */
import type { AppTarget, DeploymentTier, ExecutionContext } from './env';

/** Thrown when a run violates the execution or recording boundary. */
export class SecurityPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityPolicyError';
  }
}

function assertNever(value: never): never {
  throw new SecurityPolicyError(`Unhandled deployment tier: ${String(value)}`);
}

/** Restricted tiers are everything that is not a public demo. Exhaustive. */
export function isRestricted(tier: DeploymentTier): boolean {
  switch (tier) {
    case 'public-demo':
      return false;
    case 'internal-staging':
    case 'production':
      return true;
    default:
      return assertNever(tier);
  }
}

/** Runtime facts captured once by `index.ts`. Values are never echoed. */
export interface RuntimeFacts {
  readonly argv: readonly string[];
  /** `GITHUB_ACTIONS`: any non-empty value is treated as a CI marker. */
  readonly githubActions: string | undefined;
  /** `ALLOW_RESTRICTED_TARGET`: an operator acknowledgment, not authentication. */
  readonly restrictedAcknowledgment: string | undefined;
  /** `PWDEBUG`: set by `--debug`, or directly. */
  readonly pwDebug: string | undefined;
  /** `PW_TEST_REPORTER`: an internal reporter override invisible in FullConfig. */
  readonly pwTestReporter: string | undefined;
}

/** The parts of the resolved configuration these rules need. */
export interface ExecutionSubject {
  readonly target: AppTarget;
  readonly tier: DeploymentTier;
  readonly execution: ExecutionContext;
}

/* ------------------------------------------------------------------ *
 * Process classification (by argv, never by TEST_WORKER_INDEX)
 * ------------------------------------------------------------------ */

/**
 * Which kind of process is loading the configuration.
 *
 * Classified from the executed entry point, not from `TEST_WORKER_INDEX`:
 * that variable can be set in the parent environment (verified), so trusting
 * it would let a main process skip the launch checks. Worker processes run
 * Playwright's own worker entry file, which an environment variable cannot
 * fake.
 */
export type ProcessKind = 'cli-test' | 'worker' | 'other';

const WORKER_ENTRY = '/playwright/lib/worker/workerProcessEntry.js';
const CLI_ENTRIES = ['/@playwright/test/cli.js', '/playwright/cli.js'];
const CLI_BASENAMES = new Set(['playwright', 'playwright.cmd', 'playwright.ps1']);

function normalise(path: string): string {
  return path.replace(/\\/g, '/');
}

export function classifyProcess(argv: readonly string[]): ProcessKind {
  const entry = normalise(argv[1] ?? '');
  if (entry.endsWith(WORKER_ENTRY)) {
    return 'worker';
  }
  const basename = entry.slice(entry.lastIndexOf('/') + 1);
  const isCli = CLI_BASENAMES.has(basename) || CLI_ENTRIES.some((suffix) => entry.endsWith(suffix));
  return isCli && argv[2] === 'test' ? 'cli-test' : 'other';
}

/* ------------------------------------------------------------------ *
 * Launch shape (rule I5a)
 * ------------------------------------------------------------------ */

/**
 * The only options a restricted run may pass, and whether each takes a value.
 * Anything else -- including every reporter, trace, headed, debug, UI and
 * config option -- is refused. An allow-list fails closed for options a
 * future Playwright version adds.
 */
const ALLOWED_OPTIONS: ReadonlyMap<string, boolean> = new Map([
  ['--project', true],
  ['-g', true],
  ['--grep', true],
  ['--grep-invert', true],
  ['-j', true],
  ['--workers', true],
  ['--retries', true],
  ['--repeat-each', true],
  ['--timeout', true],
  ['--max-failures', true],
  ['-x', false],
  ['--list', false],
  ['--pass-with-no-tests', false],
  ['--forbid-only', false],
  ['--fully-parallel', false],
  ['--quiet', false],
  ['--no-deps', false],
]);

/**
 * Problems with how a restricted run was launched. Empty means allowed.
 * Only option NAMES are reported, never their values.
 */
export function launchShapeProblems(argv: readonly string[]): string[] {
  const kind = classifyProcess(argv);
  if (kind === 'worker') {
    // A worker is spawned by a main process only after that process loaded
    // this configuration and passed these checks (and global setup). Its
    // argv carries no CLI options to inspect.
    return [];
  }
  if (kind === 'other') {
    return [
      'only a plain `playwright test` invocation may run a restricted target ' +
        '(UI mode, test-server, IDE and other launch modes are refused)',
    ];
  }

  const problems: string[] = [];
  const args = argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? '';
    if (!token.startsWith('-')) {
      continue; // a test-file filter
    }
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    const takesValue = ALLOWED_OPTIONS.get(name);
    if (takesValue === undefined) {
      problems.push(`option ${name} is not permitted for restricted targets`);
      continue;
    }
    if (takesValue && equals === -1) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        problems.push(`option ${name} requires a value`);
      } else {
        i++;
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Checkpoint A: execution rules I3, I4, I5a, I10
 * ------------------------------------------------------------------ */

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

/**
 * Every reason the run may not proceed, in check order. Empty means allowed.
 *
 * Order matters: the CI refusal (I3) is decided before the acknowledgment is
 * even read, so no acknowledgment can override it.
 */
export function executionProblems(subject: ExecutionSubject, facts: RuntimeFacts): string[] {
  if (!isRestricted(subject.tier)) {
    // I10: a leftover acknowledgment on a demo run is a misconfiguration.
    return isSet(facts.restrictedAcknowledgment)
      ? [
          'ALLOW_RESTRICTED_TARGET is set, but the selected target is a public demo; ' +
            'unset it (it applies only to restricted targets)',
        ]
      : [];
  }

  // I3: environment variables cannot prove a runner is private, so any
  // recognised CI marker refuses. They only ever ADD refusals.
  if (subject.execution === 'ci' || isSet(facts.githubActions)) {
    return [
      `restricted target "${subject.target}" may not run in CI; ` +
        'this repository has no approved private runner',
    ];
  }

  const problems: string[] = [];
  // I4: an exact, target-specific acknowledgment. Not authentication.
  if (facts.restrictedAcknowledgment !== subject.target) {
    problems.push(
      `restricted target "${subject.target}" requires ALLOW_RESTRICTED_TARGET to equal ` +
        'the target name exactly (an operator acknowledgment)',
    );
  }
  // I5a: only the verified plain CLI shape, with no recording overrides.
  problems.push(...launchShapeProblems(facts.argv));
  if (isSet(facts.pwDebug)) {
    problems.push('PWDEBUG (debug mode) is not permitted for restricted targets');
  }
  if (isSet(facts.pwTestReporter)) {
    problems.push('PW_TEST_REPORTER is not permitted for restricted targets');
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Recording policy (rules I6, I7)
 * ------------------------------------------------------------------ */

export type ReporterEntry = readonly ['list'] | readonly ['html', { readonly open: 'never' }];

export interface RecordingPolicy {
  readonly trace: 'retain-on-failure' | 'off';
  readonly screenshot: 'only-on-failure' | 'off';
  /** `undefined` keeps Playwright's default (not recording) for public demos. */
  readonly video: 'off' | undefined;
  readonly reporter: readonly ReporterEntry[];
}

const PUBLIC_DEMO_RECORDING: RecordingPolicy = {
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
  video: undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
};

const RESTRICTED_RECORDING: RecordingPolicy = {
  trace: 'off',
  screenshot: 'off',
  video: 'off',
  reporter: [['list']],
};

/**
 * Recording settings decided only by tier. These reduce what is recorded;
 * they do not prevent exposure on their own -- the list reporter still prints
 * failure messages, and failures still write error-context.md locally.
 */
export function recordingPolicy(tier: DeploymentTier): RecordingPolicy {
  return isRestricted(tier) ? RESTRICTED_RECORDING : PUBLIC_DEMO_RECORDING;
}

/* ------------------------------------------------------------------ *
 * Checkpoint B: effective settings (rule I5b)
 * ------------------------------------------------------------------ */

/** The effective, post-CLI settings global setup reads from FullConfig. */
export interface EffectiveRunConfig {
  readonly reporters: readonly string[];
  readonly projects: readonly {
    readonly name: string;
    readonly trace: unknown;
    readonly screenshot: unknown;
    readonly video: unknown;
    readonly headless: unknown;
  }[];
}

/** Playwright accepts either `'mode'` or `{ mode: 'mode', ... }`. */
function modeOf(setting: unknown): unknown {
  return typeof setting === 'object' && setting !== null && 'mode' in setting
    ? setting.mode
    : setting;
}

/**
 * Re-checks the EFFECTIVE configuration for restricted tiers, after command
 * line overrides have been applied. Independent of checkpoint A: it catches
 * unsafe settings however they arrived.
 */
export function effectiveConfigProblems(
  tier: DeploymentTier,
  effective: EffectiveRunConfig,
  facts: RuntimeFacts,
): string[] {
  if (!isRestricted(tier)) {
    return [];
  }
  const problems: string[] = [];
  if (effective.reporters.length !== 1 || effective.reporters[0] !== 'list') {
    problems.push(
      `effective reporters must be exactly [list]; got [${effective.reporters.join(', ')}]`,
    );
  }
  for (const project of effective.projects) {
    for (const [field, value] of [
      ['trace', project.trace],
      ['screenshot', project.screenshot],
      ['video', project.video],
    ] as const) {
      if (modeOf(value) !== 'off') {
        problems.push(`project "${project.name}": ${field} must be off`);
      }
    }
    if (project.headless === false) {
      problems.push(`project "${project.name}": headed mode is not permitted`);
    }
  }
  if (isSet(facts.pwDebug)) {
    problems.push('PWDEBUG (debug mode) is not permitted for restricted targets');
  }
  return problems;
}

/** Throws one error listing every problem, or returns if there are none. */
export function enforce(checkpoint: string, problems: readonly string[]): void {
  if (problems.length > 0) {
    throw new SecurityPolicyError(
      `${checkpoint} refused this run (ADR-0005):\n- ${problems.join('\n- ')}`,
    );
  }
}
