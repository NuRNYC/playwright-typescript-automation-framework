import { test, expect } from '@/fixtures/test';
import { checkoutCustomer, parsePriceCents } from '@/data/checkout';
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

/** The product as the inventory page lists it, read before it is added. */
interface ListedProduct {
  readonly name: string;
  readonly priceCents: number;
}

const sumOf = (values: readonly number[]): number => values.reduce((sum, cents) => sum + cents, 0);

test.describe('Checkout', () => {
  test.use({ authenticatedAs: 'standard' });

  // Reassigned by every beforeEach, before any test body runs.
  let listed: ListedProduct;

  test.beforeEach(async ({ inventoryPage, cartPage, checkoutInformationPage, page }) => {
    await inventoryPage.open();
    await expect(inventoryPage.title).toHaveText('Products');

    // Name and price are read from the ONE inventory card that holds this
    // product's add-to-cart button, so they belong to the same product. Read
    // before adding: the button is then replaced by a Remove button.
    const card = page
      .getByTestId('inventory-item')
      .filter({ has: inventoryPage.addToCartButton(PRODUCT) });
    await expect(card).toHaveCount(1);
    await expect(card.locator(inventoryPage.itemNames)).not.toBeEmpty();
    listed = {
      name: (await card.locator(inventoryPage.itemNames).textContent())?.trim() ?? '',
      priceCents: parsePriceCents(await card.locator(inventoryPage.itemPrices).textContent()),
    };
    expect(listed.priceCents).toBeGreaterThan(0);

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

      // The overview shows exactly the product that was added, at the price
      // the inventory listed. Single-item order by design.
      await expect(checkoutOverviewPage.itemNames).toHaveText([listed.name]);
      await expect
        .poll(() => checkoutOverviewPage.productPricesCents())
        .toEqual([listed.priceCents]);

      // Integer cents, re-read from the page on every poll attempt. No tax
      // rate or price is assumed: only the relationships between the shown
      // amounts are checked.
      await expect
        .poll(async () => {
          const lineItemsCents = await checkoutOverviewPage.productPricesCents();
          const { subtotalCents, taxCents, totalCents } = await checkoutOverviewPage.totals();
          return {
            subtotalIsSumOfLineItems: subtotalCents === sumOf(lineItemsCents),
            subtotalPlusTaxIsTotal: subtotalCents + taxCents === totalCents,
            taxIsNonNegative: taxCents >= 0,
            totalIsAtLeastSubtotal: totalCents >= subtotalCents,
          };
        })
        .toEqual({
          subtotalIsSumOfLineItems: true,
          subtotalPlusTaxIsTotal: true,
          taxIsNonNegative: true,
          totalIsAtLeastSubtotal: true,
        });

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
