import type { Locator, Page } from '@playwright/test';
import { BasePage } from '@/pages/BasePage';
import { HeaderComponent } from '@/pages/components/HeaderComponent';
import type { CheckoutCustomer } from '@/data/checkout';

/**
 * Checkout step one (`/checkout-step-one.html`, title "Checkout: Your
 * Information"). Locators verified in Chromium, Firefox and WebKit (M9-1-1).
 *
 * Only synthetic customers from `@/data/checkout` should be typed here: the
 * typed values appear in report step titles (S1).
 */
export class CheckoutInformationPage extends BasePage {
  readonly title: Locator;
  readonly header: HeaderComponent;
  readonly firstName: Locator;
  readonly lastName: Locator;
  readonly postalCode: Locator;
  readonly continueButton: Locator;
  readonly cancelButton: Locator;
  /** The validation message; absent until a submit fails. */
  readonly error: Locator;

  constructor(page: Page) {
    super(page, '/checkout-step-one.html');
    this.title = page.getByTestId('title');
    this.header = new HeaderComponent(page);
    this.firstName = page.getByTestId('firstName');
    this.lastName = page.getByTestId('lastName');
    this.postalCode = page.getByTestId('postalCode');
    this.continueButton = page.getByTestId('continue');
    this.cancelButton = page.getByTestId('cancel');
    this.error = page.getByTestId('error');
  }

  /**
   * Fills every field from the customer. An empty value (from the builder's
   * `without`) leaves that field empty, which is how negative cases are built.
   */
  async fillCustomer(customer: CheckoutCustomer): Promise<void> {
    await this.firstName.fill(customer.firstName);
    await this.lastName.fill(customer.lastName);
    await this.postalCode.fill(customer.postalCode);
  }

  async continueToOverview(): Promise<void> {
    await this.continueButton.click();
  }

  /** Fill the form and press Continue. */
  async submit(customer: CheckoutCustomer): Promise<void> {
    await this.fillCustomer(customer);
    await this.continueToOverview();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }
}
