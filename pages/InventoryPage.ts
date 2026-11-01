import { expect, Page } from '@playwright/test';

export class InventoryPage {
  constructor(private readonly page: Page) {}
  async expectLoaded() {
    await expect(this.page).toHaveURL(/inventory\.html/);
    await expect(this.page.locator('[data-test="title"]')).toHaveText('Products');
  }
  async addBackpack() {
    await this.page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  }
  async expectCartCount(count: string) {
    await expect(this.page.locator('[data-test="shopping-cart-badge"]')).toHaveText(count);
  }
}