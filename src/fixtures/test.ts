import { readFileSync } from 'node:fs';
import { test as base } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { LoginPage } from '@/pages/LoginPage';
import { InventoryPage } from '@/pages/InventoryPage';
import { CartPage } from '@/pages/CartPage';
import { CheckoutInformationPage } from '@/pages/CheckoutInformationPage';
import { CheckoutOverviewPage } from '@/pages/CheckoutOverviewPage';
import { CheckoutCompletePage } from '@/pages/CheckoutCompletePage';
import { config } from '@/config';
import {
  SETUP_PROJECT,
  SessionStateError,
  assertSupportedTarget,
  checkSavedSession,
  sessionStatePath,
  type SessionRole,
} from '@/auth/session';
import {
  A11Y_TAGS,
  evaluateGate,
  toReportSummary,
  type A11yPage,
  type A11yReportSummary,
  type GateFailure,
} from '@/a11y/policy';
import { A11Y_EXCEPTIONS } from '@/a11y/exceptions';
import { ApiClient } from '@/api/client';
import { MAX_REDIRECTS } from '@/api/request-policy';
import { startApiStub, startRedirectTrap, type ApiStub, type RedirectTrap } from '@/api/stub';

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
  cartPage: CartPage;
  checkoutInformationPage: CheckoutInformationPage;
  checkoutOverviewPage: CheckoutOverviewPage;
  checkoutCompletePage: CheckoutCompletePage;
}

/**
 * Authentication is opt-in. Every test starts logged out unless its spec
 * declares `test.use({ authenticatedAs: 'standard' })`. This is an option,
 * not a page object, so it is a separate interface from `Pages`. See ADR-0003.
 */
export interface AuthOptions {
  authenticatedAs: SessionRole | undefined;
}

/** Outcome of one accessibility scan, after the gate policy is applied. */
export interface A11yScanOutcome {
  /** Empty means the strict gate passes. */
  readonly failures: readonly GateFailure[];
  /** The sanitized summary that was attached to the report. */
  readonly summary: A11yReportSummary;
}

/**
 * Accessibility scanning (ADR-0004). Configuration lives here only: specs
 * never construct their own `AxeBuilder`, so every scan uses the same tags.
 */
export interface Scanners {
  /** A fresh builder preconfigured with the WCAG 2.0–2.2 A/AA tag set. */
  makeAxeBuilder: () => AxeBuilder;
  /**
   * Scan the current page, apply the gate, attach a sanitized summary and
   * annotate any incomplete findings. Call only after the page is ready and
   * before any `fill()`, so no typed value can be in the DOM.
   */
  scanAccessibility: (page: A11yPage) => Promise<A11yScanOutcome>;
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
/**
 * API layer fixtures (ADR-0006). Test-scoped: one typed client per test,
 * backed by a fresh request context; and the redirect trap, used only by the
 * redirect negative test.
 */
export interface ApiClients {
  apiClient: ApiClient;
  redirectTrap: RedirectTrap;
}

/**
 * Worker-scoped: the in-process synthetic stub, started once per worker that
 * actually requests an API fixture, on 127.0.0.1 with an OS-assigned port.
 */
export interface ApiWorkerFixtures {
  apiStub: ApiStub;
}

export const test = base.extend<Pages & AuthOptions & Scanners & ApiClients, ApiWorkerFixtures>({
  apiStub: [
    async ({ playwright: _playwright }, use) => {
      const stub = await startApiStub();
      try {
        await use(stub);
      } finally {
        // Runs on teardown even when a test in this worker failed.
        await stub.close();
      }
    },
    { scope: 'worker' },
  ],

  apiClient: async ({ playwright, apiStub }, use) => {
    // A fresh context per test, pointed only at the verified loopback origin,
    // never following redirects. Not the built-in `request` fixture, whose
    // baseURL is the application target.
    const context = await playwright.request.newContext({
      baseURL: apiStub.origin,
      maxRedirects: MAX_REDIRECTS,
    });
    try {
      await use(new ApiClient(context));
    } finally {
      await context.dispose();
    }
  },

  redirectTrap: async ({ apiStub }, use) => {
    const trap = await startRedirectTrap();
    apiStub.setRedirectTarget(trap.origin);
    try {
      await use(trap);
    } finally {
      apiStub.setRedirectTarget(undefined);
      await trap.close();
    }
  },

  authenticatedAs: [undefined, { option: true }],

  makeAxeBuilder: async ({ page }, use) => {
    // A factory, so each call starts from the same central configuration.
    await use(() => new AxeBuilder({ page }).withTags([...A11Y_TAGS]));
  },

  scanAccessibility: async ({ makeAxeBuilder }, use, testInfo) => {
    await use(async (pageName) => {
      // Raw results stay in memory; only the allow-listed summary leaves.
      const results = await makeAxeBuilder().analyze();
      const gate = evaluateGate(pageName, results.violations, A11Y_EXCEPTIONS, new Date());
      const summary = toReportSummary(pageName, results, gate);

      await testInfo.attach(`a11y-summary-${pageName}.json`, {
        body: JSON.stringify(summary, null, 2),
        contentType: 'application/json',
      });
      // Incomplete findings are reported, never gated: axe could not decide.
      for (const finding of summary.incomplete) {
        testInfo.annotations.push({
          type: 'a11y-incomplete',
          description: `${pageName}: ${finding.ruleId} (${finding.nodeCount} node(s)) needs manual review`,
        });
      }
      return { failures: gate.failures, summary };
    });
  },

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

  // M9-1 checkout flow. The shared header is reached through each page's
  // `header` field (composition), so it has no fixture of its own.
  cartPage: async ({ page }, use) => {
    await use(new CartPage(page));
  },

  checkoutInformationPage: async ({ page }, use) => {
    await use(new CheckoutInformationPage(page));
  },

  checkoutOverviewPage: async ({ page }, use) => {
    await use(new CheckoutOverviewPage(page));
  },

  checkoutCompletePage: async ({ page }, use) => {
    await use(new CheckoutCompletePage(page));
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
