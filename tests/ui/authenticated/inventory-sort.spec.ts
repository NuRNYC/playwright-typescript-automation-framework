import { test, expect } from '@/fixtures/test';
import { SORT_OPTIONS } from '@/pages/InventoryPage';

/**
 * Inventory sorting (M9-1). Orders are checked by comparing adjacent values,
 * so equal prices (two products share one) are allowed and no catalogue data
 * is hard-coded.
 */
function isNonDecreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? value) <= value);
}

function isDescendingByName(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || (values[index - 1] ?? value).localeCompare(value, 'en') >= 0,
  );
}

test.describe('Inventory sorting', () => {
  test.use({ authenticatedAs: 'standard' });

  test.beforeEach(async ({ inventoryPage }) => {
    await inventoryPage.open();
    await expect(inventoryPage.title).toHaveText('Products');
    // At least two products, or an order check would pass vacuously.
    await expect.poll(async () => (await inventoryPage.productNames()).length).toBeGreaterThan(1);
  });

  test('price low to high lists non-decreasing prices', async ({ inventoryPage }) => {
    await inventoryPage.sortBy(SORT_OPTIONS.priceLowToHigh);

    await expect(inventoryPage.activeSortOption).toHaveText('Price (low to high)');
    await expect
      .poll(async () => isNonDecreasing(await inventoryPage.productPricesCents()))
      .toBe(true);
  });

  test('name Z to A lists names in descending order', async ({ inventoryPage }) => {
    await inventoryPage.sortBy(SORT_OPTIONS.nameZToA);

    await expect(inventoryPage.activeSortOption).toHaveText('Name (Z to A)');
    await expect
      .poll(async () => isDescendingByName(await inventoryPage.productNames()))
      .toBe(true);
  });
});
