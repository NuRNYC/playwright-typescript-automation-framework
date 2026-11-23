import { test, expect } from '@/fixtures/test';
import { users } from '@/data/users';

/**
 * `{ tag: '@smoke' }` is Playwright's structured tag API. Tags live in
 * metadata rather than in the test title, so `--grep @smoke` filters without
 * depending on how the title happens to be worded.
 *
 * Note what is absent: no `new LoginPage(page)`. The `loginPage` fixture is
 * requested by name in the destructured argument and Playwright constructs
 * it. Declaring a fixture a spec does not use costs nothing -- fixtures are
 * instantiated lazily.
 */
test.describe('Authentication', { tag: '@smoke' }, () => {
  test('valid credentials land on the inventory page', async ({
    loginPage,
    inventoryPage,
    page,
  }) => {
    await loginPage.open();

    await test.step('sign in as the standard user', async () => {
      await loginPage.logIn(users.standard);
    });

    // Assertions live here, not in the page object, and they are the
    // auto-retrying `expect(locator)` / `expect(page)` forms -- so they poll
    // until the condition holds or the timeout expires.
    await expect(page).toHaveURL(/inventory\.html/);
    await expect(inventoryPage.title).toHaveText('Products');
  });

  test('invalid credentials show an error and stay on the login page', async ({
    loginPage,
    page,
  }) => {
    await loginPage.open();
    await loginPage.logIn(users.invalid);

    await expect(loginPage.error).toContainText('Username and password do not match');
    await expect(page).not.toHaveURL(/inventory\.html/);
  });
});
