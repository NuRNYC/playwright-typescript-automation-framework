import { test, expect } from '@/fixtures/test';

/**
 * Accessibility regression gate for the inventory page (ADR-0004).
 *
 * Lives under tests/ui/authenticated/ and opts in to the saved session, so it
 * runs only in `chromium-authenticated`, after the setup project. Incomplete
 * findings (axe could not decide, e.g. contrast over pseudo-content) are
 * attached and annotated for manual review, never gated.
 */
test.describe('Accessibility', { tag: '@a11y' }, () => {
  test.use({ authenticatedAs: 'standard' });

  test('inventory page has no confirmed WCAG A/AA violations', async ({
    inventoryPage,
    scanAccessibility,
  }) => {
    await inventoryPage.open();
    await expect(inventoryPage.title).toHaveText('Products');

    const { failures } = await scanAccessibility('inventory');

    expect(failures).toEqual([]);
  });
});
