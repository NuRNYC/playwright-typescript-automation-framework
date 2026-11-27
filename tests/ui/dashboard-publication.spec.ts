import type { Page } from '@playwright/test';

import { test, expect } from '@/fixtures/test';
import {
  CANARY,
  MALICIOUS_TITLE,
  PUBLICATION_BUILT_AT,
  PUBLICATION_SOURCE_COMMIT,
  REQUIRED_SUBRESOURCES,
  UNAVAILABLE,
  buildDashboard,
  chooseSummary,
  cspViolations,
  openDashboard,
  publicationEntry,
  publicationText,
  summaryText,
  withEmbeddedPublication,
  withPublicationModule,
  type DashboardBundle,
  type DashboardSession,
} from './dashboard-harness';

/**
 * Browser tests for the publisher-verified publication view (ADR-0011
 * P3-4). Runs in the public chromium, firefox and webkit projects.
 *
 * The dashboard is built once per worker (picker-only). Publication cases
 * replace the generated `publication-data.js` with the committed
 * generator's output for a synthetic manifest that the committed browser
 * reader accepts, exactly as a publication-enabled build would embed it. No
 * real publication generation is read and the publisher never runs.
 */

let bundle: DashboardBundle;

test.beforeAll(() => {
  bundle = buildDashboard();
});

test.afterAll(() => {
  bundle.remove();
});

const DAY_MS = 86_400_000;
const BUILT_MS = Date.parse(PUBLICATION_BUILT_AT);

function view(page: Page) {
  const publication = page.getByRole('region', { name: 'Publisher-verified publication' });
  return {
    publication,
    verdicts: publication.getByRole('table', { name: 'Gate verdicts of real results' }),
    units: publication.getByRole('table', { name: 'Counting units per run' }),
    integrity: publication.getByRole('table', { name: 'Summary and artifact integrity per run' }),
    untrusted: publication.getByRole('table', { name: 'Untrusted-origin results' }),
    synthetic: publication.getByRole('table', { name: 'Synthetic demonstration results' }),
    file: page.getByLabel('Quality summary file (quality-summary.json)'),
    status: page.getByRole('status'),
    overview: page.getByRole('region', { name: 'Executive quality overview' }),
  };
}

function row(page: Page, table: ReturnType<typeof view>['verdicts'], runId: number) {
  return table
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: `Run ${String(runId)}, attempt 1` }) });
}

async function open(
  page: Page,
  text: string | null,
  now: number = BUILT_MS + DAY_MS,
): Promise<DashboardSession> {
  await page.clock.setFixedTime(new Date(now));
  const b = text === null ? bundle : withEmbeddedPublication(bundle, text);
  const session = await openDashboard(page, b);
  // The module graph loaded: app.js built the filter form.
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

/** A manifest covering verified pass and failure, exceptional states and missing metrics. */
function mixedText(): string {
  return publicationText({
    results: [
      publicationEntry({ runId: 1_000_001 }),
      publicationEntry({
        runId: 1_000_002,
        state: 'VERIFIED_FAIL',
        reasons: ['gate-failure'],
      }),
      publicationEntry({ runId: 1_000_003, ...UNAVAILABLE }),
      publicationEntry({
        runId: 1_000_004,
        state: 'UNKNOWN',
        reasons: ['gate-not-decisive'],
        ...UNAVAILABLE,
      }),
      publicationEntry({
        runId: 1_000_005,
        state: 'CANCELLED',
        reasons: ['run-cancelled'],
        ...UNAVAILABLE,
      }),
      publicationEntry({
        runId: 1_000_006,
        state: 'EXECUTION_FAILED',
        reasons: ['job-failed-before-gate'],
        ...UNAVAILABLE,
      }),
      publicationEntry({
        runId: 1_000_007,
        state: 'PENDING',
        reasons: ['run-not-completed'],
        ...UNAVAILABLE,
      }),
      publicationEntry({
        runId: 1_000_008,
        state: 'CONFLICT',
        reasons: ['outcome-gate-failure-job-success'],
        ...UNAVAILABLE,
      }),
    ],
  });
}

function isolationText(): string {
  return publicationText({
    results: [
      publicationEntry({ runId: 1_000_001 }),
      publicationEntry({
        runId: 1_000_010,
        authenticity: 'RETAINED_UNAUTHENTICATED',
        artifact: { id: 15_000_010, digest: null, integrity: 'retained-not-reverified' },
        metrics: null,
      }),
    ],
    untrustedOrigin: [
      publicationEntry({
        runId: 1_000_020,
        event: 'pull_request',
        state: 'UNTRUSTED_PROVENANCE',
        reasons: ['provenance-event'],
        summary: { state: 'SUMMARY_UNAVAILABLE', reasons: ['artifact-absent'], label: null },
        artifact: { id: null, digest: null, integrity: 'not-checked' },
        metrics: null,
      }),
    ],
    synthetic: [
      publicationEntry({
        runId: 9_000_001,
        authenticity: 'SYNTHETIC',
        summary: { state: 'SUMMARY_UNAVAILABLE', reasons: ['artifact-absent'], label: null },
        artifact: { id: null, digest: null, integrity: 'not-checked' },
        metrics: null,
      }),
    ],
  });
}

test.describe('Quality dashboard publication', () => {
  test('picker-only build: no publication data, picker unchanged', async ({ page }) => {
    const session = await open(page, null);
    const v = view(page);
    await expect(v.publication).toContainText(
      'No publisher-verified publication is embedded in this build.',
    );
    await expect(v.publication.getByRole('heading')).toHaveText(['Publisher-verified publication']);
    await expect(v.publication).not.toContainText('Verified pass');
    await expect(v.publication.getByRole('table')).toHaveCount(0);
    await chooseSummary(v.file, summaryText());
    await expect(v.status).toHaveText('Summary loaded and validated.');
    await expect(page.getByText('Imported file — not authenticated.')).toBeVisible();
    clean(session);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('embedded publication: overview, verdicts and only one verified-pass style', async ({
    page,
  }) => {
    const session = await open(page, mixedText());
    const v = view(page);
    await expect(v.publication).toContainText('Publisher build statement');
    await expect(v.publication).toContainText(PUBLICATION_BUILT_AT);
    await expect(v.publication).toContainText(PUBLICATION_SOURCE_COMMIT);
    await expect(v.publication).toContainText('within the 30-day freshness window');
    await expect(v.publication).toContainText('not a claim that the run was verified again');

    const expected: [number, string, RegExp][] = [
      [1_000_001, '✓ Verified pass', /tone-good/],
      [1_000_002, '✗ Verified Gate failure', /tone-bad/],
      [1_000_004, '? Could not verify', /tone-warn/],
      [1_000_005, '⊘ Cancelled', /tone-warn/],
      [1_000_006, '⚠ Pipeline failed before a verdict (not a test failure)', /tone-bad/],
      [1_000_007, '… In progress', /tone-warn/],
      [1_000_008, '⚠ Evidence conflict', /tone-warn/],
    ];
    for (const [runId, label, tone] of expected) {
      const tag = row(page, v.verdicts, runId).locator('.tag');
      await expect(tag).toHaveText(label);
      await expect(tag).toHaveClass(tone);
    }
    await expect(v.verdicts.locator('.tone-good')).toHaveCount(2);
    await expect(row(page, v.verdicts, 1_000_004)).toContainText('Gate outcome not decisive');
    await expect(row(page, v.verdicts, 1_000_002)).toContainText('Gate step failed');
    // Two verified-pass tags: 1_000_001 and 1_000_003 (a pass with missing metrics).
    await expect(v.publication.getByText('VERIFIED_PASS: 2 build-verified results')).toBeVisible();
    clean(session);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('metrics keep units apart; missing metrics are unavailable, not zero', async ({ page }) => {
    await open(page, mixedText());
    const v = view(page);
    const verified = row(page, v.units, 1_000_001).getByRole('cell');
    await expect(verified).toHaveText([
      '12',
      '18',
      '19',
      '20',
      '1',
      '0',
      'Verified by the publisher build',
    ]);
    const missing = row(page, v.units, 1_000_003).getByRole('cell');
    await expect(missing).toHaveText([
      'Unavailable',
      'Unavailable',
      'Unavailable',
      'Unavailable',
      'Unavailable',
      'Unavailable',
      'Metrics unavailable: Summary artifact expired',
    ]);
    const outcomes = v.publication.getByRole('table', {
      name: 'Outcomes for run 1000001 attempt 1',
    });
    await expect(outcomes).toBeVisible();
    await expect(
      v.publication.getByRole('table', { name: 'Outcomes for run 1000003 attempt 1' }),
    ).toHaveCount(0);
    await expect(v.publication).toContainText('Executions with provisional outcome');
    const integrity = row(page, v.integrity, 1_000_003).getByRole('cell');
    await expect(integrity.nth(0)).toHaveText('Metrics unavailable');
    await expect(integrity.nth(5)).toHaveText('No');
    await expect(row(page, v.integrity, 1_000_001).getByRole('cell').nth(5)).toHaveText('Yes');
    await expect(v.publication).toContainText('does not, on its own, prove who produced');
  });

  test('provenance shows the policy, commits and verification time as plain text', async ({
    page,
  }) => {
    await open(page, mixedText());
    const v = view(page);
    for (const text of [
      'example-owner/example-repo',
      'Playwright UI Tests',
      '.github/workflows/tests.yml',
      '800000001',
      '0123456789abcdef0123456789abcdef01234567',
      `${PUBLICATION_BUILT_AT} (1 day before viewing)`,
    ]) {
      await expect(v.publication).toContainText(text);
    }
    await expect(v.publication.locator('a')).toHaveCount(0);
  });

  test('untrusted-origin, retained and synthetic entries stay separate and uncounted', async ({
    page,
  }) => {
    await open(page, isolationText());
    const v = view(page);
    await expect(v.publication.getByText('VERIFIED_PASS: 1 build-verified result')).toBeVisible();
    const retained = row(page, v.verdicts, 1_000_010);
    await expect(retained.locator('.tag')).toHaveClass(/tone-neutral/);
    await expect(retained).toContainText(
      "Historical retained evidence — publisher's record, not re-verified",
    );
    await expect(row(page, v.verdicts, 1_000_020)).toHaveCount(0);
    await expect(row(page, v.untrusted, 1_000_020).locator('.tag')).toHaveText(
      '? Unverified origin (pull request)',
    );
    await expect(row(page, v.untrusted, 1_000_020).locator('.tag')).toHaveClass(/tone-neutral/);
    await expect(v.publication).toContainText(
      'SYNTHETIC DEMONSTRATION DATA: not a real CI result.',
    );
    const synthetic = row(page, v.synthetic, 9_000_001);
    await expect(synthetic.locator('.tag')).toHaveClass(/tone-neutral/);
    await expect(synthetic).toContainText('SYNTHETIC DEMONSTRATION DATA — not a real CI result');
    await expect(row(page, v.verdicts, 9_000_001)).toHaveCount(0);
    // Only the build-verified pass is styled as one; outcome tags are not verdicts.
    await expect(v.verdicts.locator('.tone-good')).toHaveCount(1);
    await expect(v.untrusted.locator('.tone-good')).toHaveCount(0);
    await expect(v.synthetic.locator('.tone-good')).toHaveCount(0);
  });

  test('an invalid publication or data module is rejected with no data', async ({ context }) => {
    const contradictory = publicationText(
      { results: [publicationEntry({ runId: 1_000_001, reasons: ['gate-failure'] })] },
      { allowInvalid: true },
    );
    const cases: [DashboardBundle, string][] = [
      [withEmbeddedPublication(bundle, contradictory), 'reason-state-mismatch'],
      [withEmbeddedPublication(bundle, `${MALICIOUS_TITLE}\n`), 'invalid-json'],
      [
        withPublicationModule(
          bundle,
          "export const PUBLICATION_STATE = 'trusted';\nexport const PUBLICATION_TEXT = '';\n",
        ),
        'invalid-data-module',
      ],
      [
        withPublicationModule(
          bundle,
          `export const PUBLICATION_STATE = 'none';\nexport const PUBLICATION_TEXT = ${JSON.stringify(mixedText())};\n`,
        ),
        'invalid-data-module',
      ],
      [
        withPublicationModule(
          bundle,
          `export const PUBLICATION_STATE = 'embedded';\nexport const PUBLICATION_TEXT = ${JSON.stringify(mixedText())};\nexport const VERIFIED = true;\n`,
        ),
        'invalid-data-module',
      ],
    ];
    for (const [b, code] of cases) {
      // A fresh page per case: each open installs its own observers.
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(BUILT_MS + DAY_MS));
      const session = await openDashboard(page, b);
      const v = view(page);
      await expect(v.publication).toContainText('Publication rejected');
      await expect(v.publication).toContainText(`Rejection code: ${code}.`);
      await expect(v.publication.getByRole('table')).toHaveCount(0);
      await expect(v.publication).not.toContainText('Verified pass');
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

  test('an imported file never becomes, or merges with, the publication', async ({ page }) => {
    const text = mixedText();
    await open(page, text);
    const v = view(page);
    const before = (await v.publication.textContent()) ?? '';
    // A manifest chosen in the picker is not a quality summary and is refused.
    await chooseSummary(v.file, text, 'quality-verdict-publication.json');
    await expect(v.status).toHaveText('Summary rejected: the file is not a valid quality summary.');
    await expect(v.publication).toHaveText(before);
    // A valid imported summary is shown separately, with its own unverified verdict.
    await chooseSummary(v.file, summaryText());
    await expect(v.status).toHaveText('Summary loaded and validated.');
    await expect(v.overview).toContainText('Final CI verdict: UNVERIFIED');
    await expect(v.publication).toHaveText(before);
  });

  test('freshness: exactly 30 days is current, later is stale, verdicts unchanged', async ({
    page,
    context,
  }) => {
    await open(page, mixedText(), BUILT_MS + 30 * DAY_MS);
    const v = view(page);
    await expect(v.publication).toContainText(
      'Built 30 days ago, within the 30-day freshness window.',
    );
    await expect(v.publication).not.toContainText('Stale publication');

    const later = await context.newPage();
    await open(later, mixedText(), BUILT_MS + 30 * DAY_MS + 1_000);
    const w = view(later);
    await expect(w.publication).toContainText('Stale publication: built 30 days ago');
    await expect(w.publication.locator('.alert')).toContainText('have not been re-verified');
    await expect(row(later, w.verdicts, 1_000_001).locator('.tag')).toHaveText('✓ Verified pass');
    await expect(w.publication.getByText('VERIFIED_PASS: 2 build-verified results')).toBeVisible();
  });

  test('a clock earlier than the build gives an unknown age, never current', async ({ page }) => {
    await open(page, mixedText(), BUILT_MS - 60_000);
    const v = view(page);
    await expect(v.publication).toContainText(
      'Publication age unknown: this device clock is earlier than the build time.',
    );
    await expect(v.publication).not.toContainText('within the 30-day freshness window');
    await expect(v.publication).toContainText('age unknown: viewer clock unusable or earlier');
  });

  test('keyboard: the publication is reachable from the section navigation', async ({ page }) => {
    await open(page, mixedText());
    const link = page
      .getByRole('navigation', { name: 'Dashboard sections' })
      .getByRole('link', { name: 'Publication' });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#publication$/);
    const table = page.getByRole('region', { name: 'Gate verdicts of real results' });
    await table.focus();
    await expect(table).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(table).not.toBeFocused();
  });
});
