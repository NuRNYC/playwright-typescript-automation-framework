import type { Locator, Page } from '@playwright/test';
import { BasePage } from '@/pages/BasePage';
import { HeaderComponent } from '@/pages/components/HeaderComponent';
import type { ProductSlug } from '@/data/products';
import { parsePriceCents } from '@/data/checkout';

/**
 * The sort control's option values, read off the live page (M9-1-1). Keyed by
 * meaning so specs say `SORT_OPTIONS.priceLowToHigh`, not the site's `'lohi'`.
 */
export const SORT_OPTIONS = {
  nameAToZ: 'az',
  nameZToA: 'za',
  priceLowToHigh: 'lohi',
  priceHighToLow: 'hilo',
} as const;

/** `'az' | 'za' | 'lohi' | 'hilo'`, derived from the data above. */
export type SortOption = (typeof SORT_OPTIONS)[keyof typeof SORT_OPTIONS];

/** The product listing shown after a successful sign-in. */
export class InventoryPage extends BasePage {
  readonly title: Locator;
  /** Shared header (cart link, badge, menu). Composed, not inherited. */
  readonly header: HeaderComponent;
  /**
   * Kept for the existing public interface; it is the header's badge locator.
   */
  readonly cartBadge: Locator;
  readonly sortSelect: Locator;
  /** The visible label of the currently selected sort option. */
  readonly activeSortOption: Locator;
  readonly itemNames: Locator;
  readonly itemPrices: Locator;

  constructor(page: Page) {
    super(page, '/inventory.html');
    this.title = page.getByTestId('title');
    this.header = new HeaderComponent(page);
    this.cartBadge = this.header.cartBadge;
    this.sortSelect = page.getByTestId('product-sort-container');
    this.activeSortOption = page.getByTestId('active-option');
    this.itemNames = page.getByTestId('inventory-item-name');
    this.itemPrices = page.getByTestId('inventory-item-price');
  }

  /**
   * Returns the button's `Locator` instead of clicking it, so a spec can
   * assert on the control itself (visible, enabled, correct label) rather
   * than only on the effect of pressing it.
   */
  addToCartButton(product: ProductSlug): Locator {
    return this.page.getByTestId(`add-to-cart-${product}`);
  }

  async addToCart(product: ProductSlug): Promise<void> {
    await this.addToCartButton(product).click();
  }

  /**
   * Delegates to the shared header: an absent badge means zero. Because the
   * value is derived (not a locator), specs must assert on it with
   * `expect.poll` to keep auto-retrying behaviour.
   */
  async cartCount(): Promise<number> {
    return this.header.cartCount();
  }

  async sortBy(option: SortOption): Promise<void> {
    await this.sortSelect.selectOption(option);
  }

  /** Product names in display order. Derived: assert with `expect.poll`. */
  async productNames(): Promise<string[]> {
    return this.itemNames.allTextContents();
  }

  /** Product prices in display order, as integer cents. */
  async productPricesCents(): Promise<number[]> {
    return (await this.itemPrices.allTextContents()).map(parsePriceCents);
  }
}
