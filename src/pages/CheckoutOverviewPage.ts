import type { Locator, Page } from '@playwright/test';
import { BasePage } from '@/pages/BasePage';
import { HeaderComponent } from '@/pages/components/HeaderComponent';
import { parsePriceCents } from '@/data/checkout';

/** The overview's money summary, in integer cents. */
export interface CheckoutTotals {
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

/**
 * Checkout step two (`/checkout-step-two.html`, title "Checkout: Overview").
 * Locators verified in Chromium, Firefox and WebKit (M9-1-1).
 *
 * The page object parses the displayed amounts; whether they add up is a
 * business expectation, so that check lives in the spec.
 */
export class CheckoutOverviewPage extends BasePage {
  readonly title: Locator;
  readonly header: HeaderComponent;
  readonly itemNames: Locator;
  readonly itemPrices: Locator;
  /** "Item total: $…" */
  readonly subtotal: Locator;
  /** "Tax: $…" */
  readonly tax: Locator;
  /** "Total: $…" */
  readonly total: Locator;
  readonly finishButton: Locator;
  readonly cancelButton: Locator;

  constructor(page: Page) {
    super(page, '/checkout-step-two.html');
    this.title = page.getByTestId('title');
    this.header = new HeaderComponent(page);
    this.itemNames = page.getByTestId('inventory-item-name');
    this.itemPrices = page.getByTestId('inventory-item-price');
    this.subtotal = page.getByTestId('subtotal-label');
    this.tax = page.getByTestId('tax-label');
    this.total = page.getByTestId('total-label');
    this.finishButton = page.getByTestId('finish');
    this.cancelButton = page.getByTestId('cancel');
  }

  /** Line-item prices in display order, as integer cents. */
  async productPricesCents(): Promise<number[]> {
    return (await this.itemPrices.allTextContents()).map(parsePriceCents);
  }

  /** Derived: assert with `expect.poll`. */
  async totals(): Promise<CheckoutTotals> {
    return {
      subtotalCents: parsePriceCents(await this.subtotal.textContent()),
      taxCents: parsePriceCents(await this.tax.textContent()),
      totalCents: parsePriceCents(await this.total.textContent()),
    };
  }

  async finish(): Promise<void> {
    await this.finishButton.click();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }
}
