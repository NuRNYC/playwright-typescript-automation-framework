import { test } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { InventoryPage } from '../pages/InventoryPage';
import { users } from '../fixtures/users';

test.describe('Authentication and inventory smoke tests', () => {
  test('valid user can sign in and add an item', async ({ page }) => {
    const login = new LoginPage(page);
    await login.open();
    await login.logIn(users.standard.username, users.standard.password);
    const inventory = new InventoryPage(page);
    await inventory.expectLoaded();
    await inventory.addBackpack();
    await inventory.expectCartCount('1');
  });

  test('invalid credentials display an error', async ({ page }) => {
    const login = new LoginPage(page);
    await login.open();
    await login.logIn(users.invalid.username, users.invalid.password);
    await login.expectError('Username and password do not match');
  });
});