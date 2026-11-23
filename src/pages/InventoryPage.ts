import type { Locator, Page } from '@playwright/test';
import { BasePage } from '@/pages/BasePage';
import type { ProductSlug } from '@/data/products';

/** The product listing shown after a successful sign-in. */
export class InventoryPage extends BasePage {
  readonly title: Locator;
  readonly cartBadge: Locator;

  constructor(page: Page) {
    super(page, '/inventory.html');
    this.title = page.getByTestId('title');
    this.cartBadge = page.getByTestId('shopping-cart-badge');
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
   * Sauce Demo removes the badge element entirely while the cart is empty,
   * so an absent badge means zero rather than a failure.
   *
   * This returns a number, not the `string` the old `expectCartCount` took --
   * a cart count is numeric, and the type should say so. Because the value is
   * derived (not a locator), specs must assert on it with `expect.poll` to
   * keep auto-retrying behaviour.
   */
  async cartCount(): Promise<number> {
    if ((await this.cartBadge.count()) === 0) {
      return 0;
    }
    const text = await this.cartBadge.textContent();
    return Number(text?.trim() ?? '0');
  }
}
