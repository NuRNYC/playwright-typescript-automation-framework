import type { Page } from '@playwright/test';

import { test, expect } from '@/fixtures/test';
import {
  CANARY,
  MALICIOUS_TITLE,
  PUBLICATION_BUILT_AT,
  REQUIRED_SUBRESOURCES,
  buildDashboard,
  chooseSummary,
  cspViolations,
  demoManifestText,
  openDashboard,
  publicationEntry,
  publicationText,
  summaryText,
  withDemoPublication,
  type DashboardBundle,
  type DashboardSession,
} from './dashboard-harness';

/**
 * Browser tests for the synthetic demonstration mode (ADR-0011 P4).
 * Runs in the public chromium, firefox and webkit projects.
 *
 * The picker-only build is built once per worker; demo cases substitute the
 * generated `publication-data.js` with the committed generator's
 * `PUBLICATION_STATE = 'demo'` module, exactly as `build-dashboard.ts --demo`
 * writes it. Everything is synthetic; nothing is fetched.
 */

let bundle: DashboardBundle;

test.beforeAll(() => {
  bundle = buildDashboard();
});

test.afterAll(() => {
  bundle.remove();
});

function view(page: Page) {
  const main = page.getByRole('main');
  const banner = page.getByRole('region', { name: 'SYNTHETIC DEMONSTRATION DATA' });
  const section = page.getByRole('region', { name: 'Synthetic demonstration scenarios' });
  return {
    main,
    banner,
    section,
    verdicts: section.getByRole('table', { name: 'Synthetic scenario verdicts' }),
    metrics: section.getByRole('table', { name: 'Synthetic counting units per scenario' }),
    file: page.getByLabel('Quality summary file (quality-summary.json)'),
    status: page.getByRole('status'),
  };
}

function row(page: Page, table: ReturnType<typeof view>['verdicts'], runId: number) {
  return table.getByRole('row').filter({
    has: page.getByRole('rowheader', { name: `Synthetic Run ${String(runId)}, attempt 1` }),
  });
}

async function openDemo(page: Page, text?: string): Promise<DashboardSession> {
  const session = await openDashboard(page, withDemoPublication(bundle, text));
  await expect(page.locator('#filter-form fieldset').first()).toBeVisible();
  return session;
}

function clean(session: DashboardSession): void {
  expect([...new Set(session.served)].sort()).toEqual(
    ['/dashboard/', ...REQUIRED_SUBRESOURCES].sort(),
  );
  expect(session.missing).toEqual([]);
  expect(session.blocked).toEqual([]);
  expect(session.pageErrors).toEqual([]);
}

function edited(change: (m: Record<string, unknown>) => void): string {
  const m = JSON.parse(demoManifestText()) as Record<string, unknown>;
  change(m);
  return `${JSON.stringify(m, null, 2)}\n`;
}

test.describe('Quality dashboard synthetic demonstration', () => {
  test('the permanent banner is first in main, textual and not dismissible', async ({ page }) => {
    const session = await openDemo(page);
    const v = view(page);
    await expect(v.banner).toBeVisible();
    await expect(v.banner.getByRole('heading', { level: 2 })).toHaveText(
      'SYNTHETIC DEMONSTRATION DATA',
    );
    await expect(v.banner).toContainText('These are fictional examples, not real CI results.');
    await expect(v.banner).toContainText(
      'Nothing below was verified by a publisher or retrieved from GitHub.',
    );
    await expect(v.banner).not.toContainText('failed validation');
    await expect(v.banner.getByRole('button')).toHaveCount(0);
    await expect(v.banner.locator('a, [tabindex], input')).toHaveCount(0);
    // First element in main, before the scenario section and the picker.
    expect(
      await page.evaluate(() => {
        const main = document.getElementById('main');
        const first = main?.firstElementChild;
        return first?.id === 'demo-banner' && first.querySelector('#demo-banner-heading') !== null;
      }),
    ).toBe(true);
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText(
      'SYNTHETIC DEMONSTRATION DATA',
    );
    clean(session);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('every scenario verdict is labelled synthetic and none is styled or counted as verified', async ({
    page,
  }) => {
    await openDemo(page);
    const v = view(page);
    await expect(v.verdicts.locator('tbody tr')).toHaveCount(6);
    const expected: [number, string, string][] = [
      [
        9_000_001,
        'Synthetic: ✓ Verified pass',
        'Metrics from an unverified origin (not published)',
      ],
      [
        9_000_002,
        'Synthetic: ✗ Verified Gate failure',
        'Metrics from an unverified origin (not published)',
      ],
      [
        9_000_003,
        'Synthetic: ? Could not verify',
        'Metrics from an unverified origin (not published)',
      ],
      [9_000_004, 'Synthetic: ⊘ Cancelled', 'Metrics unavailable'],
      [9_000_005, 'Synthetic: ✓ Verified pass', 'Metrics unavailable'],
      [9_000_006, 'Synthetic: ? Unverified origin (pull request)', 'Metrics unavailable'],
    ];
    for (const [runId, label, summary] of expected) {
      const r = row(page, v.verdicts, runId);
      await expect(r.locator('.tag')).toHaveText(label);
      await expect(r.locator('.tag')).toHaveClass(/tone-neutral/);
      await expect(r).toContainText(summary);
    }
    const tags = await v.section.locator('.tag').allTextContents();
    expect(tags.every((t) => t.startsWith('Synthetic: '))).toBe(true);
    await expect(page.locator('#publication .tone-good')).toHaveCount(0);
    for (const forbidden of [
      'Publisher build statement',
      "Verified by the publisher's build",
      'Build-verified real results',
      'Verified passes',
      'Gate verdicts of real results',
      'Publication age',
      'freshness window',
      'Stale publication',
      'HEAD',
      '0000000000000000000000000000000000000000',
    ]) {
      await expect(v.section).not.toContainText(forbidden);
      await expect(v.banner).not.toContainText(forbidden);
    }
  });

  test('synthetic metrics are separate, labelled fictional, and unavailable where absent', async ({
    page,
  }) => {
    await openDemo(page);
    const v = view(page);
    await expect(
      v.section.getByRole('heading', { name: 'Synthetic metrics (fictional)' }),
    ).toBeVisible();
    await expect(row(page, v.metrics, 9_000_001).getByRole('cell').last()).toHaveText(
      'Fictional example counts (not verified)',
    );
    await expect(row(page, v.metrics, 9_000_001).getByRole('cell').first()).toHaveText(/^\d+$/);
    const missing = row(page, v.metrics, 9_000_004).getByRole('cell');
    await expect(missing.first()).toHaveText('Unavailable');
    await expect(missing.last()).toHaveText('Metrics unavailable: Summary artifact absent');
    await expect(v.section).not.toContainText('Verified by the publisher build');
  });

  test('malformed, mixed or real data in demo state is rejected with no scenarios', async ({
    context,
  }) => {
    const realOnly = publicationText({ results: [publicationEntry({ runId: 1_000_001 })] });
    // Parse-valid mixed data: real build-verified result plus the synthetic section.
    const mixed = edited((m) => {
      m.results = (JSON.parse(realOnly) as { results: unknown[] }).results;
      (m.build as Record<string, unknown>).builtAt = PUBLICATION_BUILT_AT;
    });
    // Parse-valid synthetic entry claiming a verified-origin summary.
    const verifiedOrigin = edited((m) => {
      const e = (
        (m.synthetic as Record<string, unknown>).results as Record<string, unknown>[]
      )[0] as Record<string, unknown>;
      e.summary = {
        state: 'SUMMARY_VERIFIED_ORIGIN',
        reasons: ['verified-origin'],
        label: 'verified-origin',
      };
    });
    const cases: [string, string][] = [
      [realOnly, 'demo-not-synthetic-only'],
      [edited((m) => (m.synthetic = null)), 'demo-not-synthetic-only'],
      [mixed, 'demo-not-synthetic-only'],
      [verifiedOrigin, 'demo-not-synthetic-only'],
      [`${MALICIOUS_TITLE}\n`, 'invalid-json'],
    ];
    for (const [text, code] of cases) {
      const page = await context.newPage();
      const session = await openDashboard(page, withDemoPublication(bundle, text));
      const v = view(page);
      await expect(v.banner).toContainText('failed validation, so no scenarios are shown');
      await expect(v.section).toContainText('Demonstration rejected');
      await expect(v.section).toContainText(new RegExp(`Rejection code: (${code})\\.`));
      await expect(v.section.getByRole('table')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(CANARY);
      expect(
        await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
      ).toBeUndefined();
      // The imported-file workflow stays usable.
      await chooseSummary(v.file, summaryText());
      await expect(v.status).toHaveText('Summary loaded and validated.');
      expect(session.pageErrors).toEqual([]);
      expect(session.blocked).toEqual([]);
      expect(await cspViolations(page)).toEqual([]);
      await page.close();
    }
  });

  test('imported files stay separate and unauthenticated in demo mode', async ({ page }) => {
    await openDemo(page);
    const v = view(page);
    await expect(page.getByText('Imported file — not authenticated.')).toBeVisible();
    const before = (await v.section.textContent()) ?? '';
    await chooseSummary(v.file, demoManifestText(), 'quality-verdict-publication.json');
    await expect(v.status).toHaveText('Summary rejected: the file is not a valid quality summary.');
    await expect(v.section).toHaveText(before);
    await chooseSummary(v.file, summaryText());
    await expect(v.status).toHaveText('Summary loaded and validated.');
    await expect(page.getByRole('region', { name: 'Executive quality overview' })).toContainText(
      'Final CI verdict: UNVERIFIED',
    );
    await expect(v.section).toHaveText(before);
    await expect(v.banner).toBeVisible();
  });

  test('keyboard focus is visible and the layout reflows at 320 px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openDemo(page);
    const region = page.getByRole('region', { name: 'Synthetic scenario verdicts' });
    await region.focus();
    await expect(region).toBeFocused();
    await expect(region).toHaveCSS('outline-style', 'solid');
    await expect(region).toHaveCSS('overflow-x', 'auto');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(320);
    expect(
      await page.evaluate(() => {
        const levels = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) =>
          Number(h.tagName.slice(1)),
        );
        return levels.every((level, i) => i === 0 || level <= (levels[i - 1] ?? 0) + 1);
      }),
    ).toBe(true);
  });
});
