import type { Page } from '@playwright/test';

import { test, expect } from '@/fixtures/test';
import {
  buildDashboard,
  chooseSummary,
  editSummary,
  openDashboard,
  richReport,
  summaryText,
  type DashboardBundle,
} from './dashboard-harness';

/**
 * Accessibility checks for the static quality dashboard (ADR-0009, M8C-2B).
 * Chromium only, like every `*.a11y.spec.ts` (ADR-0004).
 *
 * EXPLORATORY SCAN, NOT THE GOVERNED GATE. ADR-0004's gate
 * (`scanAccessibility`) is scoped to the pages in `A11Y_PAGES` and their
 * reviewed exception list; the dashboard is not one of them, and adding it
 * is a separate decision. These scans therefore use the central
 * `makeAxeBuilder` fixture (same WCAG 2.0-2.2 A/AA tags; no `AxeBuilder` is
 * constructed here), accept no exceptions, and fail on any confirmed
 * violation. Only rule ids, impacts and node counts are reported; raw axe
 * results, HTML and selectors are never attached. `incomplete` findings are
 * annotated for manual review, as the gate does.
 *
 * Automated scans and the keyboard checks below cover part of WCAG 2.2 AA.
 * They are not a conformance claim.
 */

let bundle: DashboardBundle;

test.beforeAll(() => {
  bundle = buildDashboard();
});

test.afterAll(() => {
  bundle.remove();
});

interface ViolationSummary {
  readonly ruleId: string;
  readonly impact: string | null;
  readonly nodes: number;
}

function file(page: Page) {
  return page.getByLabel('Quality summary file (quality-summary.json)');
}

/** Viewport widths checked for WCAG 1.4.10 reflow, in CSS pixels. */
const REFLOW_WIDTHS = [320, 360, 375, 390, 768] as const;

/**
 * Page width, the right edge of the load controls, and any interactive
 * control outside a scrollable table region that extends past the viewport.
 */
async function reflowLayout(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const controls = Array.from(
      document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]'),
    ).filter((el) => el.closest('.table-wrap') === null && el.getClientRects().length > 0);
    const clipped = controls
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.left < -0.5 || rect.right > width + 0.5;
      })
      .map((el) => el.id || el.tagName.toLowerCase());
    const load = document.querySelector('.load-controls');
    return {
      scrollWidth: document.documentElement.scrollWidth,
      loadControlsRight:
        load === null ? Number.POSITIVE_INFINITY : load.getBoundingClientRect().right,
      clippedControls: clipped,
    };
  });
}

/**
 * Presses Tab until focus leaves the page or wraps to the skip link, and
 * returns a short descriptor (tag and id, label or text) for each stop.
 */
async function tabOrder(page: Page, limit: number): Promise<string[]> {
  const order: string[] = [];
  while (order.length < limit) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) return 'body';
      const label = el.id || el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}|${label ?? ''}`;
    });
    order.push(stop);
    if (stop === 'body' || stop === 'a|Skip to main content') break;
  }
  return order;
}

async function loadValid(page: Page): Promise<void> {
  await openDashboard(page, bundle);
  await chooseSummary(file(page), summaryText());
  await expect(page.getByRole('status')).toHaveText('Summary loaded and validated.');
}

test.describe('Quality dashboard accessibility (exploratory)', { tag: '@a11y' }, () => {
  let scan: (state: string) => Promise<readonly ViolationSummary[]>;

  test.beforeEach(({ makeAxeBuilder }, testInfo) => {
    scan = async (state) => {
      const results = await makeAxeBuilder().analyze();
      for (const finding of results.incomplete) {
        testInfo.annotations.push({
          type: 'a11y-incomplete',
          description: `dashboard ${state}: ${finding.id} (${String(finding.nodes.length)} node(s)) needs manual review`,
        });
      }
      return results.violations.map((v) => ({
        ruleId: v.id,
        impact: v.impact ?? null,
        nodes: v.nodes.length,
      }));
    };
  });

  test('no-summary state has no confirmed WCAG A/AA violations', async ({ page }) => {
    await openDashboard(page, bundle);
    await expect(page.getByRole('status')).toHaveText('No summary loaded.');
    expect(await scan('no-summary')).toEqual([]);
  });

  test('valid summary has no confirmed WCAG A/AA violations', async ({ page }) => {
    await loadValid(page);
    expect(await scan('valid')).toEqual([]);
  });

  test('unavailable summary has no confirmed WCAG A/AA violations', async ({ page }) => {
    await openDashboard(page, bundle);
    await chooseSummary(file(page), summaryText(richReport(), { reportState: 'report-missing' }));
    await expect(page.getByRole('alert')).toContainText('test data is unavailable');
    expect(await scan('unavailable')).toEqual([]);
  });

  test('schema-mismatch state has no confirmed WCAG A/AA violations', async ({ page }) => {
    await openDashboard(page, bundle);
    await chooseSummary(
      file(page),
      editSummary(summaryText(), (root) => {
        root.schemaVersion = '2.0.0';
      }),
    );
    await expect(page.getByRole('alert')).toContainText('Found major version 2');
    expect(await scan('schema-mismatch')).toEqual([]);
  });

  test('filtered state has no confirmed WCAG A/AA violations', async ({ page }) => {
    await loadValid(page);
    await page
      .getByRole('group', { name: 'Project', exact: true })
      .getByRole('checkbox', { name: 'chromium', exact: true })
      .check();
    await expect(page.locator('#filter-state')).toHaveText(/^Filters active/);
    expect(await scan('filtered')).toEqual([]);
  });

  test('expanded attempt details have no confirmed WCAG A/AA violations', async ({ page }) => {
    await loadValid(page);
    const toggle = page.getByText('Attempt details (2 executions)');
    await toggle.click();
    await expect(page.getByText(/^Execution 2:/)).toBeVisible();
    expect(await scan('expanded-details')).toEqual([]);
  });

  test('landmarks, headings, filter labels and table headers are semantic', async ({ page }) => {
    await loadValid(page);

    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Dashboard sections' })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('contentinfo')).toHaveCount(1);

    await expect(page.getByRole('heading', { level: 1 })).toHaveText([
      'Enterprise Test Reporting Dashboard',
    ]);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText([
      'Load a summary',
      'Filters',
      'Executive quality overview',
      'Test run explorer',
      'Project comparison',
      'Failure and retry intelligence',
      'CI gate and artifact health',
    ]);
    // Every h3 sits under an h2: no level is skipped.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const levels = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) =>
            Number(h.tagName.slice(1)),
          );
          return levels.every((level, i) => i === 0 || level <= (levels[i - 1] ?? 0) + 1);
        }),
      )
      .toBe(true);

    const checkboxes = page.getByRole('checkbox');
    await expect(checkboxes).not.toHaveCount(0);
    await expect
      .poll(() =>
        checkboxes.evaluateAll((boxes) =>
          boxes.every(
            (b) =>
              b instanceof HTMLInputElement &&
              (b.labels?.length ?? 0) === 1 &&
              b.labels?.[0]?.textContent?.trim() !== '',
          ),
        ),
      )
      .toBe(true);
    await expect(page.locator('#filter-form').getByRole('group')).toHaveText([
      /^Project/,
      /^Browser/,
      /^Instance outcome/,
      /^Run classification/,
      /^Evidence and run scope/,
    ]);

    const explorer = page.getByRole('table', { name: 'Instances in the filtered view' });
    await expect(explorer.getByRole('columnheader')).toHaveCount(10);
    await expect(explorer.locator('tbody').getByRole('rowheader')).toHaveCount(
      await explorer.locator('tbody tr').count(),
    );
    // Every table has a caption and a header row.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('table')).every(
            (t) => t.caption !== null && t.querySelectorAll('thead th[scope="col"]').length > 0,
          ),
        ),
      )
      .toBe(true);
  });

  test('keyboard: skip link, visible focus, operable controls and no trap', async ({ page }) => {
    await loadValid(page);

    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();

    // Walk the whole tab order; it must reach the last control and leave it.
    const order = await tabOrder(page, 400);
    expect(order).toContain('input|summary-file');
    expect(order).toContain('button|clear-summary');
    expect(order).toContain('input|filter-projects-chromium');
    expect(order).toContain('button|Clear filters');
    expect(order).toContain('div|Instances');
    expect(order.some((entry) => entry.startsWith('summary|Attempt details'))).toBe(true);
    // Focus left the page content after the last control instead of being trapped.
    expect(['body', 'a|Skip to main content']).toContain(order.at(-1));
    expect(order.length).toBeLessThan(400);

    // Visible focus on a keyboard-focused control.
    const clear = page.getByRole('button', { name: 'Clear summary' });
    await clear.focus();
    await expect(clear).toHaveCSS('outline-style', 'solid');
    await expect(clear).toHaveCSS('outline-width', '3px');

    // Checkboxes toggle with Space.
    const chromium = page
      .getByRole('group', { name: 'Project', exact: true })
      .getByRole('checkbox', { name: 'chromium', exact: true });
    await chromium.focus();
    await page.keyboard.press('Space');
    await expect(chromium).toBeChecked();
    await expect(page.locator('#filter-state')).toHaveText(/^Filters active \(Project: chromium\)/);
  });

  test('live regions announce state and status text does not rely on colour', async ({ page }) => {
    await openDashboard(page, bundle);
    const status = page.getByRole('status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toHaveText('No summary loaded.');

    await chooseSummary(file(page), '{"schemaVersion":');
    await expect(page.getByRole('alert')).toHaveText(
      'Summary rejected: the file is not a valid quality summary. The file is not valid JSON.',
    );

    await chooseSummary(file(page), summaryText());
    await expect(status).toHaveText('Summary loaded and validated.');
    // An empty alert region is not rendered (display: none), so check it by id.
    await expect(page.locator('#alert')).toBeEmpty();
    // Every coloured tag carries its own text.
    await expect
      .poll(() =>
        page
          .locator('.tag')
          .evaluateAll(
            (tags) => tags.length > 0 && tags.every((t) => (t.textContent ?? '').trim() !== ''),
          ),
      )
      .toBe(true);
  });

  test('reflows at 320 px and honours reduced motion', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loadValid(page);

    // No horizontal page scrolling; wide tables scroll inside their own region.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(320);
    const tableRegion = page.getByRole('region', { name: 'Instances' });
    await expect(tableRegion).toHaveAttribute('tabindex', '0');
    await expect(tableRegion).toHaveCSS('overflow-x', 'auto');

    expect(
      await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    ).toBe(true);
    await expect(page.getByRole('button', { name: 'Clear summary' })).toHaveCSS(
      'transition-duration',
      '0s',
    );
    expect(await scan('reflow-320')).toEqual([]);

    // WCAG 1.4.10 regression (defect fixed in M8C-2B): the load controls once
    // widened the page to 362 px at 320 px. Checked at common narrow widths.
    const fileInput = file(page);
    for (const width of REFLOW_WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
      const layout = await reflowLayout(page);
      testInfo.annotations.push({
        type: 'reflow-measurement',
        description: `viewport ${String(width)} px: scrollWidth ${String(layout.scrollWidth)} px`,
      });
      expect(layout.clippedControls).toEqual([]);
      expect(layout.loadControlsRight).toBeLessThanOrEqual(width);
      await expect(page.getByText('Quality summary file (quality-summary.json)')).toBeVisible();
      await expect(page.locator('#summary-file-hint')).toBeVisible();
      await fileInput.focus();
      await expect(fileInput).toBeFocused();
      await expect(fileInput).toHaveCSS('outline-style', 'solid');
    }
    // The file input is still usable at the narrowest width.
    await page.setViewportSize({ width: 320, height: 800 });
    await chooseSummary(fileInput, summaryText(richReport(), { reportState: 'report-missing' }));
    await expect(page.getByRole('status')).toHaveText(
      'Summary loaded: test data is unavailable for this run.',
    );
  });
});
