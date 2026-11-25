import { test as setup, expect } from '@/fixtures/test';
import { config } from '@/config';
import { users } from '@/data/users';
import {
  assertSupportedTarget,
  checkSavedSession,
  selectSessionCookies,
  sessionStatePath,
  writeSessionState,
} from '@/auth/session';

/**
 * The `setup` project: signs in once per run through the real login form and
 * saves a cookie-only session for the `*-authenticated` projects.
 *
 * Only the session cookie is kept. Browser storage is never saved, so cart
 * contents and third-party telemetry identifiers cannot travel into another
 * test, whatever order actions happen in. See ADR-0003.
 *
 * This file is matched only by the `setup` project. Playwright's default
 * `testMatch` (`*.spec.ts` / `*.test.ts`) never matches `*.setup.ts`, so the
 * browser projects cannot pick it up a second time.
 */
setup('authenticate as the standard user', async ({ loginPage, inventoryPage, page }, testInfo) => {
  // M7 probe T4 only (probe branch, never merged): synthetic setup failure.
  throw new Error('synthetic t4 setup failure');
  // Fail closed before typing anything into a page we have not verified.
  assertSupportedTarget(config.target, config.baseURL);

  await loginPage.open();
  await loginPage.logIn(users.standard);
  await expect(page).toHaveURL(/inventory\.html/);
  await expect(inventoryPage.title).toHaveText('Products');

  const { cookies } = await page.context().storageState();
  const session = checkSavedSession(
    { cookies: selectSessionCookies(cookies), origins: [] },
    Date.now() / 1000,
  );

  writeSessionState(sessionStatePath('standard', testInfo.config.configFile), session);
});
