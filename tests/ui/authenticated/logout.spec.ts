import { test, expect } from '@/fixtures/test';

/**
 * Logout through the header menu (M9-1). Logging out deletes the session
 * cookie in this test's own browser context only; the saved session file is
 * read, never modified, so other tests are unaffected.
 */
test.describe('Header', () => {
  test.use({ authenticatedAs: 'standard' });

  test('logging out returns to the login page', async ({ inventoryPage, loginPage, page }) => {
    await inventoryPage.open();
    await expect(inventoryPage.title).toHaveText('Products');

    await inventoryPage.header.logOut();

    await expect(loginPage.submit).toBeVisible();
    await expect(loginPage.username).toBeVisible();
    await expect(page).not.toHaveURL(/inventory\.html/);
  });
});
