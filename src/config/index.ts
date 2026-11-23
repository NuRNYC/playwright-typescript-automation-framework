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
 */
import { resolveConfig, type TestConfig } from './env';

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
 * Re-exported so consumers have a single import surface (`@/config`) for both
 * the resolved value and the types and helpers that describe it.
 */
export * from './env';
