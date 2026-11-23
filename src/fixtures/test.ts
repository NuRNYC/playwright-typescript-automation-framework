import { test as base } from '@playwright/test';
import { LoginPage } from '@/pages/LoginPage';
import { InventoryPage } from '@/pages/InventoryPage';

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
export const test = base.extend<Pages>({
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
