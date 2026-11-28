import type { Locator, Page } from '@playwright/test';

/**
 * The primary header shown on every signed-in Sauce Demo page: cart link,
 * cart badge and the side menu with its logout control.
 *
 * A component, not a page: it has no path of its own and does not extend
 * `BasePage`. Page objects that show the header compose it as a
 * `readonly header` field. Assertions stay in specs.
 *
 * Locators were verified in Chromium, Firefox and WebKit (M9-1-1). The menu
 * buttons have no `data-test` of their own, so they are located by role and
 * accessible name; the logout control is exposed as a button, not a link.
 */
export class HeaderComponent {
  readonly cartLink: Locator;
  readonly cartBadge: Locator;
  readonly menuButton: Locator;
  readonly closeMenuButton: Locator;
  readonly logoutLink: Locator;

  constructor(page: Page) {
    this.cartLink = page.getByTestId('shopping-cart-link');
    this.cartBadge = page.getByTestId('shopping-cart-badge');
    this.menuButton = page.getByRole('button', { name: 'Open Menu' });
    this.closeMenuButton = page.getByRole('button', { name: 'Close Menu' });
    this.logoutLink = page.getByTestId('logout-sidebar-link');
  }

  /**
   * Sauce Demo removes the badge element entirely while the cart is empty,
   * so an absent badge means zero rather than a failure. Derived, so specs
   * assert on it with `expect.poll`.
   */
  async cartCount(): Promise<number> {
    if ((await this.cartBadge.count()) === 0) {
      return 0;
    }
    const text = await this.cartBadge.textContent();
    return Number(text?.trim() ?? '0');
  }

  async openCart(): Promise<void> {
    await this.cartLink.click();
  }

  async openMenu(): Promise<void> {
    await this.menuButton.click();
  }

  /**
   * Opens the side menu and signs out. `click()` waits for the link to be
   * visible and stable, which covers the menu's opening animation.
   */
  async logOut(): Promise<void> {
    await this.openMenu();
    await this.logoutLink.click();
  }
}
