import type { Locator, Page } from '@playwright/test';
import { BasePage } from '@/pages/BasePage';
import { HeaderComponent } from '@/pages/components/HeaderComponent';

/**
 * Checkout completion (`/checkout-complete.html`, title "Checkout:
 * Complete!"). Locators verified in Chromium, Firefox and WebKit (M9-1-2).
 *
 * The page also offers a `generate-pdf-order` control. It is deliberately not
 * modelled here: it was never inspected and is outside M9-1.
 */
export class CheckoutCompletePage extends BasePage {
  readonly title: Locator;
  /** The shared page header (cart link, badge, menu). */
  readonly header: HeaderComponent;
  /** The order confirmation heading (an `h2`). */
  readonly completeHeader: Locator;
  readonly completeMessage: Locator;
  readonly backHomeButton: Locator;

  constructor(page: Page) {
    super(page, '/checkout-complete.html');
    this.title = page.getByTestId('title');
    this.header = new HeaderComponent(page);
    this.completeHeader = page.getByTestId('complete-header');
    this.completeMessage = page.getByTestId('complete-text');
    this.backHomeButton = page.getByTestId('back-to-products');
  }

  async backHome(): Promise<void> {
    await this.backHomeButton.click();
  }
}
