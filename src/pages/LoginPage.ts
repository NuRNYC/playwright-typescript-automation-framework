import type { Locator, Page } from '@playwright/test';
import { BasePage } from '@/pages/BasePage';
import type { Credentials } from '@/data/users';

/**
 * The Sauce Demo sign-in page.
 *
 * Locators are stored as `readonly Locator` fields rather than rebuilt on
 * each call. A `Locator` is a lazy description of how to find an element, not
 * the element itself, so building it in the constructor costs nothing and
 * resolves fresh on every use.
 *
 * Exposing the locators publicly is deliberate: specs assert on them with
 * Playwright's auto-retrying `expect(locator)` matchers, which keeps the
 * waiting behaviour that a plain `expect(await ...)` would throw away.
 */
export class LoginPage extends BasePage {
  readonly username: Locator;
  readonly password: Locator;
  readonly submit: Locator;
  readonly error: Locator;

  constructor(page: Page) {
    super(page, '/');
    this.username = page.getByTestId('username');
    this.password = page.getByTestId('password');
    this.submit = page.getByTestId('login-button');
    this.error = page.getByTestId('error');
  }

  /**
   * Accepts the structural `Credentials` shape, so both the fixed accounts in
   * `src/data/users.ts` and ad-hoc values in a negative test are valid.
   */
  async logIn(credentials: Credentials): Promise<void> {
    await this.username.fill(credentials.username);
    await this.password.fill(credentials.password);
    await this.submit.click();
  }
}
