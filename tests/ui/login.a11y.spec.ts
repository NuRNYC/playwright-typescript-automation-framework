import { test, expect } from '@/fixtures/test';

/**
 * Accessibility regression gate for the login page (ADR-0004).
 *
 * Runs logged out, in the public `chromium` project only, so it does not
 * depend on the authentication setup. The scan happens before anything is
 * typed, so no form value can appear in the DOM that axe reads.
 *
 * This is an automated check for a subset of WCAG 2.0–2.2 A/AA rules, not a
 * conformance claim.
 */
test.describe('Accessibility', { tag: '@a11y' }, () => {
  test('login page has no confirmed WCAG A/AA violations', async ({
    loginPage,
    scanAccessibility,
  }) => {
    await loginPage.open();
    // Ready before scanning: scanning mid-render is not deterministic.
    await expect(loginPage.submit).toBeVisible();

    const { failures } = await scanAccessibility('login');

    expect(failures).toEqual([]);
  });
});
