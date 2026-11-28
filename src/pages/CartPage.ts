import type { Locator, Page } from '@playwright/test';
import { BasePage } from '@/pages/BasePage';
import { HeaderComponent } from '@/pages/components/HeaderComponent';
import type { ProductSlug } from '@/data/products';
import { parsePriceCents } from '@/data/checkout';

/**
 * The cart page (`/cart.html`, title "Your Cart"). Locators verified in
 * Chromium, Firefox and WebKit (M9-1-1). Reached through the header's cart
 * link in specs, so the cart contents come from the test's own actions.
 */
export class CartPage extends BasePage {
  readonly title: Locator;
  readonly header: HeaderComponent;
  /** One element per cart line. */
  readonly items: Locator;
  readonly itemNames: Locator;
  readonly itemPrices: Locator;
  readonly itemQuantities: Locator;
  readonly continueShoppingButton: Locator;
  readonly checkoutButton: Locator;

  constructor(page: Page) {
    super(page, '/cart.html');
    this.title = page.getByTestId('title');
    this.header = new HeaderComponent(page);
    this.items = page.getByTestId('inventory-item');
    this.itemNames = page.getByTestId('inventory-item-name');
    this.itemPrices = page.getByTestId('inventory-item-price');
    this.itemQuantities = page.getByTestId('item-quantity');
    this.continueShoppingButton = page.getByTestId('continue-shopping');
    this.checkoutButton = page.getByTestId('checkout');
  }

  removeButton(product: ProductSlug): Locator {
    return this.page.getByTestId(`remove-${product}`);
  }

  async remove(product: ProductSlug): Promise<void> {
    await this.removeButton(product).click();
  }

  async continueShopping(): Promise<void> {
    await this.continueShoppingButton.click();
  }

  async checkout(): Promise<void> {
    await this.checkoutButton.click();
  }

  /** Line-item prices in display order, as integer cents. */
  async productPricesCents(): Promise<number[]> {
    return (await this.itemPrices.allTextContents()).map(parsePriceCents);
  }
}
