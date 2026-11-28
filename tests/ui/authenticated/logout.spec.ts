import { test, expect } from '@/fixtures/test';
import { config } from '@/config';

/**
 * Logout through the header menu (M9-1). Logging out deletes the session
 * cookie in this test's own browser context only; the saved session file is
 * read, never modified, so other tests are unaffected. The cookie itself is
 * never read or printed here.
 */
test.describe('Header', () => {
  test.use({ authenticatedAs: 'standard' });

  test('logging out returns to the login page', async ({ inventoryPage, loginPage, page }) => {
    const loginURL = new URL('/', config.baseURL).href;

    await inventoryPage.open();
    await expect(inventoryPage.title).toHaveText('Products');

    await inventoryPage.header.logOut();

    await expect(page).toHaveURL(loginURL);
    await expect(loginPage.submit).toBeVisible();
    await expect(loginPage.username).toBeVisible();

    // The session must be gone, not merely the page changed: a direct visit
    // to the protected inventory is refused and lands back on the login page.
    await inventoryPage.open();

    await expect(page).toHaveURL(loginURL);
    await expect(loginPage.submit).toBeVisible();
    await expect(loginPage.error).toBeVisible();
    await expect(inventoryPage.title).toHaveCount(0);
    await expect(inventoryPage.itemNames).toHaveCount(0);
  });
});
