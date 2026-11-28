import { test, expect } from '@/fixtures/test';
import { checkoutCustomer } from '@/data/checkout';
import type { ProductSlug } from '@/data/products';

/**
 * The fictional Sauce Demo checkout (M9-1). Every typed value comes from the
 * synthetic builder; none appears in a test title or annotation (S1).
 *
 * After each navigation the spec waits for page-specific content -- the
 * page title -- rather than the URL alone: Sauce Demo updates the URL before
 * the new page has rendered (observed in M9-1-1).
 */
const PRODUCT: ProductSlug = 'sauce-labs-backpack';

test.describe('Checkout', () => {
  test.use({ authenticatedAs: 'standard' });

  test.beforeEach(async ({ inventoryPage, cartPage, checkoutInformationPage }) => {
    await inventoryPage.open();
    await expect(inventoryPage.title).toHaveText('Products');
    await inventoryPage.addToCart(PRODUCT);
    await inventoryPage.header.openCart();
    await expect(cartPage.title).toHaveText('Your Cart');
    await cartPage.checkout();
    await expect(checkoutInformationPage.title).toHaveText('Checkout: Your Information');
  });

  test(
    'a fictional order completes and Back Home returns to the inventory',
    { tag: '@smoke' },
    async ({
      checkoutInformationPage,
      checkoutOverviewPage,
      checkoutCompletePage,
      inventoryPage,
      page,
    }) => {
      await test.step('submit the synthetic customer', async () => {
        await checkoutInformationPage.submit(checkoutCustomer().build());
      });

      await expect(checkoutOverviewPage.title).toHaveText('Checkout: Overview');
      await expect(checkoutOverviewPage.itemNames).toHaveCount(1);

      // Integer cents: the subtotal is the sum of the line items, and
      // subtotal + tax = total. No tax rate is assumed.
      const lineItemsCents = await checkoutOverviewPage.productPricesCents();
      const totals = await checkoutOverviewPage.totals();
      expect(totals.subtotalCents).toBe(lineItemsCents.reduce((sum, cents) => sum + cents, 0));
      expect(totals.subtotalCents + totals.taxCents).toBe(totals.totalCents);

      await checkoutOverviewPage.finish();

      await expect(checkoutCompletePage.title).toHaveText('Checkout: Complete!');
      await expect(page).toHaveURL(/checkout-complete\.html/);
      await expect(checkoutCompletePage.completeHeader).toBeVisible();
      await expect(checkoutCompletePage.completeHeader).not.toBeEmpty();
      await expect(checkoutCompletePage.completeMessage).toBeVisible();
      await expect(checkoutCompletePage.header.cartBadge).toHaveCount(0);
      await expect.poll(() => checkoutCompletePage.header.cartCount()).toBe(0);

      await checkoutCompletePage.backHome();

      await expect(inventoryPage.title).toHaveText('Products');
      await expect(page).toHaveURL(/inventory\.html/);
    },
  );

  test('a missing first name shows the required-field error', async ({
    checkoutInformationPage,
    page,
  }) => {
    await checkoutInformationPage.submit(checkoutCustomer().without('firstName').build());

    await expect(checkoutInformationPage.error).toHaveText('Error: First Name is required');
    await expect(checkoutInformationPage.title).toHaveText('Checkout: Your Information');
    await expect(page).toHaveURL(/checkout-step-one\.html/);
  });

  test('a missing postal code shows the required-field error', async ({
    checkoutInformationPage,
    page,
  }) => {
    await checkoutInformationPage.submit(checkoutCustomer().without('postalCode').build());

    await expect(checkoutInformationPage.error).toHaveText('Error: Postal Code is required');
    await expect(checkoutInformationPage.title).toHaveText('Checkout: Your Information');
    await expect(page).toHaveURL(/checkout-step-one\.html/);
  });

  test('Cancel on the overview returns to the inventory with the cart kept', async ({
    checkoutInformationPage,
    checkoutOverviewPage,
    inventoryPage,
    page,
  }) => {
    await checkoutInformationPage.submit(checkoutCustomer().build());
    await expect(checkoutOverviewPage.title).toHaveText('Checkout: Overview');

    await checkoutOverviewPage.cancel();

    await expect(inventoryPage.title).toHaveText('Products');
    await expect(page).toHaveURL(/inventory\.html/);
    await expect.poll(() => inventoryPage.cartCount()).toBe(1);
  });
});
