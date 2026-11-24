import { readFileSync } from 'node:fs';
import { test as base } from '@playwright/test';
import { LoginPage } from '@/pages/LoginPage';
import { InventoryPage } from '@/pages/InventoryPage';
import { config } from '@/config';
import {
  SETUP_PROJECT,
  SessionStateError,
  assertSupportedTarget,
  checkSavedSession,
  sessionStatePath,
  type SessionRole,
} from '@/auth/session';

/**
 * The fixture contract.
 *
 * This interface is the type argument to `base.extend<...>()` below, and it
 * is what makes `async ({ loginPage }) => {}` autocomplete and typecheck
 * inside a spec. Playwright merges it into the built-in fixtures (`page`,
 * `browser`, `request`, ...) rather than replacing them.
 *
 * Add a fixture here and every spec can request it immediately, with no
 * change to any existing spec. That is the seam the rest of the platform --
 * API clients, accessibility scanners, authenticated sessions -- attaches to.
 */
export interface Pages {
  loginPage: LoginPage;
  inventoryPage: InventoryPage;
}

/**
 * Authentication is opt-in. Every test starts logged out unless its spec
 * declares `test.use({ authenticatedAs: 'standard' })`. This is an option,
 * not a page object, so it is a separate interface from `Pages`. See ADR-0003.
 */
export interface AuthOptions {
  authenticatedAs: SessionRole | undefined;
}

/**
 * Each fixture receives `(builtInFixtures, use)`.
 *
 * The `use(value)` call -- rather than `return value` -- is what gives a
 * fixture a lifecycle: everything before `use` is setup, everything after it
 * is teardown, and the test body runs *during* the await. These page objects
 * need no teardown, so there is nothing after the `use` call.
 *
 * Fixtures are also lazy and dependency-ordered: requesting `inventoryPage`
 * instantiates only `page` and `inventoryPage`. A spec that never mentions
 * `loginPage` never constructs one.
 *
 * Scope here is per-test (the default), which is correct for a page object
 * because `page` itself is per-test. A worker-scoped fixture (`{ scope:
 * 'worker' }`) would be right for something expensive and stateless, such as
 * an auth token shared across the tests in one worker.
 */
export const test = base.extend<Pages & AuthOptions>({
  authenticatedAs: [undefined, { option: true }],

  /**
   * Overrides Playwright's built-in `storageState` option. Requesting the
   * fixture by its own name yields the configured value, which is passed
   * through untouched for logged-out tests.
   *
   * For an authenticated test, every precondition is checked before a
   * browser context exists, so a broken precondition fails as one clear
   * message instead of a confusing redirect to the login page.
   */
  storageState: async ({ authenticatedAs, storageState }, use, testInfo) => {
    if (authenticatedAs === undefined) {
      await use(storageState);
      return;
    }

    // Without this, a spec placed outside tests/ui/authenticated/ would run
    // in a public project, possibly before setup has written the state.
    if (!testInfo.project.dependencies.includes(SETUP_PROJECT)) {
      throw new SessionStateError(
        `authenticatedAs is set, but project "${testInfo.project.name}" does not depend on ` +
          `"${SETUP_PROJECT}". Authenticated specs belong under tests/ui/authenticated/.`,
      );
    }
    assertSupportedTarget(config.target, config.baseURL);

    const filePath = sessionStatePath(authenticatedAs, testInfo.config.configFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      throw new SessionStateError(
        `No readable saved session for "${authenticatedAs}". Run the "${SETUP_PROJECT}" ` +
          'project first (do not pass --no-deps).',
      );
    }
    checkSavedSession(parsed, Date.now() / 1000);

    await use(filePath);
  },

  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  inventoryPage: async ({ page }, use) => {
    await use(new InventoryPage(page));
  },
});

/**
 * Re-exported so a spec has a single import surface:
 *   import { test, expect } from '@/fixtures/test';
 *
 * Importing `expect` from here rather than from '@playwright/test' keeps
 * specs from depending on two different modules for one concern.
 */
export { expect } from '@playwright/test';
