import { test, expect } from '@/fixtures/test';
import type { ProductSlug } from '@/data/products';

/**
 * The cart page itself (M9-1). Runs in the `*-authenticated` projects with
 * the saved session; every test starts with an empty cart because the saved
 * state holds the session cookie only (ADR-0003).
 */
const PRODUCT = {
  slug: 'sauce-labs-backpack',
  name: 'Sauce Labs Backpack',
} as const satisfies { slug: ProductSlug; name: string };

test.describe('Cart page', () => {
  test.use({ authenticatedAs: 'standard' });

  test.beforeEach(async ({ inventoryPage }) => {
    await inventoryPage.open();
    await expect(inventoryPage.title).toHaveText('Products');
  });

  test('an added item is listed with its name and listed price', async ({
    inventoryPage,
    cartPage,
  }) => {
    // The price shown on the inventory page is the expectation, so the test
    // does not hard-code catalogue prices.
    await expect(inventoryPage.itemNames).not.toHaveCount(0);
    const names = await inventoryPage.productNames();
    const prices = await inventoryPage.productPricesCents();
    const index = names.indexOf(PRODUCT.name);
    expect(index).toBeGreaterThanOrEqual(0);
    const listedPrice = prices[index];

    await inventoryPage.addToCart(PRODUCT.slug);
    await inventoryPage.header.openCart();

    await expect(cartPage.title).toHaveText('Your Cart');
    await expect(cartPage.items).toHaveCount(1);
    await expect(cartPage.itemNames).toHaveText([PRODUCT.name]);
    await expect(cartPage.itemQuantities).toHaveText(['1']);
    await expect.poll(() => cartPage.productPricesCents()).toEqual([listedPrice]);
  });

  test('removing the item empties the cart and clears the badge', async ({
    inventoryPage,
    cartPage,
  }) => {
    await inventoryPage.addToCart(PRODUCT.slug);
    await inventoryPage.header.openCart();
    await expect(cartPage.title).toHaveText('Your Cart');
    await expect(cartPage.items).toHaveCount(1);

    await cartPage.remove(PRODUCT.slug);

    await expect(cartPage.items).toHaveCount(0);
    await expect(cartPage.header.cartBadge).toHaveCount(0);
    await expect.poll(() => cartPage.header.cartCount()).toBe(0);
  });

  test('Continue Shopping returns to the inventory', async ({ inventoryPage, cartPage, page }) => {
    await inventoryPage.addToCart(PRODUCT.slug);
    await inventoryPage.header.openCart();
    await expect(cartPage.title).toHaveText('Your Cart');

    await cartPage.continueShopping();

    await expect(inventoryPage.title).toHaveText('Products');
    await expect(page).toHaveURL(/inventory\.html/);
    await expect.poll(() => inventoryPage.cartCount()).toBe(1);
  });
});
