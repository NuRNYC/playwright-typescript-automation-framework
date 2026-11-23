import { test, expect } from '@/fixtures/test';
import { users } from '@/data/users';

/**
 * Split out of the original combined "sign in and add an item" test. A
 * failure here now points at the cart; a failure in login.spec.ts points at
 * authentication. The old single test could not distinguish the two.
 */
test.describe('Cart', { tag: '@smoke' }, () => {
  test('adding a product increments the cart badge', async ({ loginPage, inventoryPage }) => {
    await test.step('sign in as the standard user', async () => {
      await loginPage.open();
      await loginPage.logIn(users.standard);
    });

    await expect(inventoryPage.title).toHaveText('Products');

    // `expect.poll` retries the FUNCTION until it satisfies the matcher.
    // A bare `expect(await inventoryPage.cartCount()).toBe(0)` would read
    // the value once and fail on any async lag -- poll preserves the
    // auto-waiting that web-first assertions give for free.
    await expect.poll(() => inventoryPage.cartCount()).toBe(0);

    // The slug is checked against the `ProductSlug` union at compile time,
    // so a typo here never reaches the browser.
    await inventoryPage.addToCart('sauce-labs-backpack');

    // Two views of the same outcome: the locator-based web-first assertion...
    await expect(inventoryPage.cartBadge).toHaveText('1');
    // ...and the semantic getter, which returns a number rather than a string.
    await expect.poll(() => inventoryPage.cartCount()).toBe(1);
  });
});
