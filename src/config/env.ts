/**
 * Typed, validated test configuration -- the pure core.
 *
 * This module has **no side effects and never reads `process.env`**. It
 * exports types, the target registry, the validating parsers, and
 * `resolveConfig(env)`, which takes the environment as a parameter.
 *
 * The runtime singleton lives in `src/config/index.ts`, which is the only
 * place that injects the real `process.env`. Application code imports
 * `config` from `@/config`; unit tests import the parsers from here and pass
 * plain object literals.
 *
 * That split is what makes the logic testable without touching global state.
 * Were the singleton defined here, merely importing this file for a test
 * would parse the ambient environment -- so a developer with `APP_TARGET`
 * exported in their shell would see unrelated unit tests fail to import.
 *
 * Three concepts are kept separate on purpose, because conflating them is the
 * usual source of "which environment is this actually testing?" confusion:
 *
 *   - `AppTarget`       WHICH deployed application the browser points at
 *   - `DeploymentTier`  WHAT KIND of deployment that target is (drives policy)
 *   - `ExecutionContext` WHERE the tests are running (a property of the runner)
 *
 * Sauce Demo is a third-party hosted public sample, so its tier is
 * `public-demo`. It is deliberately **not** called "local" -- nothing is
 * deployed locally, and that mislabel would imply a safety it does not have.
 *
 * Deliberately absent: credentials. This object holds no secrets, so it
 * cannot leak them through a log line, a serialised report or an error.
 * Test accounts live in `src/data/users.ts`; real secrets belong in the
 * environment of a private pipeline. See `docs/security-testing-policy.md`.
 *
 * NOTE ON PROCESS BOUNDARIES: Playwright runs tests in worker processes
 * separate from the main runner. Workers inherit environment variables but
 * re-evaluate both this module *and* `playwright.config.ts`, so everything
 * here executes once per process. That is safe because parsing is
 * deterministic -- same input, same output -- but it is why no mutable state
 * may live here: a counter or cache would be re-initialised per worker and
 * would never cross the boundary.
 *
 * It is also why the startup banner carries an explicit main-process guard in
 * `playwright.config.ts`. Logging there unconditionally printed the banner 10
 * times for a 9-test run; being in the config file is not the same as running
 * once.
 */

/** What kind of deployment a target is. Drives policy decisions, never URLs. */
export type DeploymentTier = 'public-demo' | 'internal-staging' | 'production';

/** Where the tests are executing. Independent of which app is targeted. */
export type ExecutionContext = 'local' | 'ci';

/** Whether `baseURL` came from the registry or from an explicit override. */
export type BaseURLSource = 'registry' | 'override';

/**
 * A discriminated union on `tier` (ADR-0005, rule I9): a `public-demo` entry
 * cannot compile without the exact origins it is allowed to point at, and a
 * restricted entry cannot carry a default URL.
 */
type TargetDefinition =
  | {
      readonly tier: 'public-demo';
      /** The built-in URL. Its origin must appear in `publicOrigins`. */
      readonly defaultBaseURL: string;
      /** Exact `URL.origin` values this demo target may use. Never empty. */
      readonly publicOrigins: readonly [string, ...string[]];
    }
  | {
      readonly tier: 'internal-staging' | 'production';
      /** No safe default: these targets must be configured explicitly. */
      readonly defaultBaseURL: undefined;
    };

/**
 * The target registry: the single source of truth for what may be tested.
 *
 * Only `saucedemo` carries a default URL. `staging` and `production` are
 * declared but intentionally have none, so selecting them without an explicit
 * `BASE_URL` is a hard error rather than a silent fall back to the demo site.
 */
const TARGETS = {
  saucedemo: {
    tier: 'public-demo',
    defaultBaseURL: 'https://www.saucedemo.com',
    publicOrigins: ['https://www.saucedemo.com'],
  },
  staging: { tier: 'internal-staging', defaultBaseURL: undefined },
  production: { tier: 'production', defaultBaseURL: undefined },
} as const satisfies Record<string, TargetDefinition>;

/**
 * Derived from the registry rather than hand-written, so the type and the data
 * cannot drift apart. Adding an entry to `TARGETS` extends this union
 * automatically; there is no second list to forget to update.
 */
export type AppTarget = keyof typeof TARGETS;

/** Valid target names, for error messages and documentation. */
export const APP_TARGETS = Object.keys(TARGETS) as readonly AppTarget[];

const DEFAULT_TARGET = 'saucedemo' satisfies AppTarget;

/** The resolved, validated configuration. Contains no credentials. */
export interface TestConfig {
  readonly target: AppTarget;
  readonly tier: DeploymentTier;
  readonly baseURL: string;
  readonly baseURLSource: BaseURLSource;
  readonly execution: ExecutionContext;
}

/** Thrown for any invalid configuration, before the runner starts browsers. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Return type `never` is what makes this usable as a narrowing guard: after a
 * call to `fail(...)`, TypeScript knows execution cannot continue, so the
 * compiler accepts the surrounding code as exhaustive without a cast.
 */
function fail(message: string): never {
  throw new ConfigError(message);
}

function tryParseURL(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/**
 * A type predicate (`value is AppTarget`) narrows a plain `string` to the
 * registry's key union, which is what lets the caller index `TARGETS` safely.
 *
 * `hasOwnProperty` via `Object.prototype` rather than `value in TARGETS`:
 * the `in` operator also walks the prototype chain, so inputs like
 * `__proto__`, `constructor` or `toString` would wrongly pass.
 */
function isAppTarget(value: string): value is AppTarget {
  return Object.prototype.hasOwnProperty.call(TARGETS, value);
}

function parseTarget(raw: string | undefined): AppTarget {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    return DEFAULT_TARGET;
  }
  if (!isAppTarget(value)) {
    fail(`Invalid APP_TARGET "${value}". Valid targets: ${APP_TARGETS.join(', ')}.`);
  }
  return value;
}

function parseBaseURL(raw: string): string {
  const parsed = tryParseURL(raw);
  if (parsed === undefined) {
    fail(
      `Invalid BASE_URL "${raw}" -- must be an absolute http(s) URL, for example https://example.com.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(
      `Invalid BASE_URL "${raw}" -- protocol "${parsed.protocol}" is not supported; use http or https.`,
    );
  }
  return raw;
}

const CI_TRUE = new Set(['1', 'true', 'yes', 'on']);
const CI_FALSE = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Parsed explicitly rather than with `!!process.env.CI`.
 *
 * Truthiness is wrong here: every non-empty string is truthy in JavaScript, so
 * `CI=0` and `CI=false` would both have selected CI mode -- enabling retries
 * and `forbidOnly` for someone who explicitly asked for neither.
 */
function parseExecution(raw: string | undefined): ExecutionContext {
  if (raw === undefined) {
    return 'local';
  }
  const value = raw.trim().toLowerCase();
  if (CI_TRUE.has(value)) {
    return 'ci';
  }
  if (CI_FALSE.has(value)) {
    return 'local';
  }
  fail(
    `Invalid CI value "${raw}". Expected one of: ${[...CI_TRUE].join(', ')} (CI) or ${[...CI_FALSE].join(', ')} (local), or leave it unset.`,
  );
}

/**
 * Reduce a URL to origin plus path for display.
 *
 * `URL.origin` is protocol + host + port only, so any embedded
 * `user:password@` credentials are dropped by construction rather than by a
 * regular expression. The query string and fragment are dropped as well,
 * since both are common carriers of tokens and session identifiers.
 */
export function redactBaseURL(raw: string): string {
  const parsed = tryParseURL(raw);
  if (parsed === undefined) {
    return '<unparseable>';
  }
  return `${parsed.origin}${parsed.pathname}`;
}

/**
 * Resolve a configuration from an arbitrary environment object.
 *
 * This is the injectable core of the module, and the reason this file has no
 * side effects: the environment arrives as a *parameter* rather than being
 * read from `process.env` internally. That makes the function pure -- same
 * input, same output, no ambient reads -- so a unit test can pass a plain
 * object literal and needs neither `process.env` mutation nor module-cache
 * busting, both of which make tests order-dependent and flaky.
 *
 * The runtime singleton that injects the real `process.env` lives in
 * `src/config/index.ts`, deliberately separated so that importing *this*
 * module can never trigger a parse of the ambient environment.
 */
/**
 * Rule I2 (ADR-0005): a `public-demo` run may only point at an exact
 * registered origin. The URL never ASSIGNS a tier (ADR-0001); it can only
 * DISQUALIFY the registry's public-demo classification, so a real host can
 * never run under demo recording and CI rules by accident.
 *
 * Messages never echo the URL: the input may embed credentials. They name the
 * rule that failed, plus the origin, which by definition contains no userinfo.
 */
function assertPublicDemoOrigin(
  target: AppTarget,
  baseURL: string,
  publicOrigins: readonly string[],
): void {
  const parsed = tryParseURL(baseURL);
  const reason =
    parsed === undefined
      ? 'it is not a valid URL'
      : parsed.protocol !== 'https:'
        ? 'it must use https'
        : parsed.username !== '' || parsed.password !== ''
          ? 'it must not embed credentials'
          : parsed.search !== '' || parsed.hash !== ''
            ? 'it must not include a query string or fragment'
            : !publicOrigins.includes(parsed.origin)
              ? `origin ${parsed.origin} is not registered`
              : undefined;
  if (reason !== undefined) {
    fail(
      `BASE_URL is not a registered public-demo origin for APP_TARGET "${target}": ${reason}. ` +
        'Select APP_TARGET=staging or production to test any other host.',
    );
  }
}

export function resolveConfig(env: NodeJS.ProcessEnv): TestConfig {
  const target = parseTarget(env.APP_TARGET);
  const definition: TargetDefinition = TARGETS[target];
  const override = env.BASE_URL?.trim();

  let baseURL: string;
  let baseURLSource: BaseURLSource;

  if (override !== undefined && override !== '') {
    // An override is treated as intentional configuration. It is NOT evidence
    // that the deployment is what the operator believes it to be, so `tier`
    // is still taken from APP_TARGET and never re-derived from the URL. The
    // source is recorded so the startup banner can make the override visible.
    baseURL = parseBaseURL(override);
    baseURLSource = 'override';
  } else if (definition.defaultBaseURL !== undefined) {
    baseURL = definition.defaultBaseURL;
    baseURLSource = 'registry';
  } else {
    fail(
      `APP_TARGET "${target}" requires BASE_URL to be set explicitly -- no default URL is assumed for ${definition.tier} targets.`,
    );
  }

  if (definition.tier === 'public-demo') {
    assertPublicDemoOrigin(target, baseURL, definition.publicOrigins);
  }

  return {
    target,
    tier: definition.tier,
    baseURL,
    baseURLSource,
    execution: parseExecution(env.CI),
  };
}

/**
 * A one-line, allow-listed summary for the startup banner.
 *
 * Built from an explicit list of fields rather than by serialising the whole
 * object, so a field added later cannot start appearing in logs by accident.
 *
 * The parameter is required rather than defaulting to a module-level singleton:
 * a default would reintroduce the ambient `process.env` dependency this module
 * exists to avoid.
 */
export function describeConfig(current: TestConfig): string {
  return [
    `target=${current.target}`,
    `tier=${current.tier}`,
    `baseURL=${redactBaseURL(current.baseURL)}`,
    `baseURLSource=${current.baseURLSource}`,
    `execution=${current.execution}`,
  ].join(' ');
}
