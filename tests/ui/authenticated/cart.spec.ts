import { test, expect } from '@/fixtures/test';

/**
 * Split out of the original combined "sign in and add an item" test. A
 * failure here now points at the cart; a failure in login.spec.ts points at
 * authentication. The old single test could not distinguish the two.
 *
 * Since M3b this spec no longer signs in itself. It lives under
 * tests/ui/authenticated/, so it runs only in the `*-authenticated` projects,
 * which depend on the `setup` project; `authenticatedAs` restores the saved
 * session before the page opens. See ADR-0003.
 */
test.describe('Cart', { tag: '@smoke' }, () => {
  test.use({ authenticatedAs: 'standard' });

  test('adding a product increments the cart badge', async ({ inventoryPage }) => {
    await inventoryPage.open();

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
