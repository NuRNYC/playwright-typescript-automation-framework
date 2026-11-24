/**
 * The runtime configuration singleton.
 *
 * This is the **only** module in the framework that reads `process.env`. It
 * injects the real environment into the pure resolver from `./env`, freezes
 * the result, and exports it for application code to consume as `@/config`.
 *
 * Keeping this one line separate from `./env` is what lets the parsing logic
 * be unit-tested with injected objects: importing `./env` has no side effects,
 * while importing this module deliberately does.
 *
 * Validation happens here, at import time, on purpose. Playwright imports this
 * via `playwright.config.ts` before any browser is launched, so a bad
 * `APP_TARGET` or a malformed `BASE_URL` aborts the run in milliseconds rather
 * than surfacing as a confusing mid-test navigation failure.
 *
 * Since ADR-0005 the same import is also **checkpoint A** of the execution
 * boundary: it captures the runtime facts the security rules need and refuses
 * a restricted run before any browser, worker or global setup exists. It runs
 * in every process that loads the configuration -- the CLI process, each
 * worker, and any UI or loader process -- and `./security` decides per
 * process kind (classified from argv, never from `TEST_WORKER_INDEX`).
 */
import { resolveConfig, type TestConfig } from './env';
import { enforce, executionProblems, type RuntimeFacts } from './security';

/**
 * `Object.freeze` is the runtime half of immutability; the `readonly` members
 * of `TestConfig` are the compile-time half and are erased when the code runs.
 * Both are wanted: `readonly` catches mistakes while editing, `freeze` catches
 * them in a JavaScript consumer that has no types at all.
 *
 * A shallow freeze is a complete freeze here, because `TestConfig` is flat --
 * every member is a primitive. Were a nested object ever added, this would
 * need to become a deep freeze, and the unit tests assert the current shape
 * so that change cannot pass unnoticed.
 */
export const config: TestConfig = Object.freeze(resolveConfig(process.env));

/**
 * The runtime facts the security rules read, captured once. Exported for the
 * global setup (checkpoint B) so it, too, never reads `process.env` itself.
 * Holds no secrets: an acknowledgment is a target name, and the rest are
 * mode flags. Never logged.
 */
export const runtimeFacts: RuntimeFacts = Object.freeze({
  argv: Object.freeze([...process.argv]),
  githubActions: process.env.GITHUB_ACTIONS,
  restrictedAcknowledgment: process.env.ALLOW_RESTRICTED_TARGET,
  pwDebug: process.env.PWDEBUG,
  pwTestReporter: process.env.PW_TEST_REPORTER,
});

// Checkpoint A (rules I3, I4, I5a, I10). Throws before anything else runs.
enforce('Configuration checkpoint', executionProblems(config, runtimeFacts));

/**
 * Re-exported so consumers have a single import surface (`@/config`) for both
 * the resolved value and the types and helpers that describe it.
 */
export * from './env';
