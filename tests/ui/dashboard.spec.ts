import type { Page } from '@playwright/test';

import { test, expect } from '@/fixtures/test';
import {
  CANARY,
  DASHBOARD_URL,
  EXPECTED_CSP,
  REQUIRED_SUBRESOURCES,
  buildDashboard,
  chooseSummary,
  cspViolations,
  editSummary,
  manyInstancesReport,
  openDashboard,
  oversizedInput,
  richReport,
  summaryOf,
  summaryText,
  type DashboardBundle,
  type DashboardSession,
} from './dashboard-harness';

/**
 * Functional browser tests for the static quality dashboard (ADR-0009,
 * M8C-2B). Runs in the public chromium, firefox and webkit projects.
 *
 * The dashboard is built once per worker into a temporary directory and
 * served through route fulfilment on a reserved origin; every other request
 * is aborted. All summaries are synthetic, produced by the M8A normalizer.
 * Expected numbers are derived from that same synthetic summary, never from
 * the repository's own test counts.
 */

let bundle: DashboardBundle;

test.beforeAll(() => {
  bundle = buildDashboard();
});

test.afterAll(() => {
  bundle.remove();
});

function ui(page: Page) {
  const overview = page.getByRole('region', { name: 'Executive quality overview' });
  const explorer = page.getByRole('region', { name: 'Test run explorer' });
  return {
    file: page.getByLabel('Quality summary file (quality-summary.json)'),
    status: page.getByRole('status'),
    alert: page.getByRole('alert'),
    filterState: page.locator('#filter-state'),
    overview,
    explorer,
    projects: page.getByRole('region', { name: 'Project comparison' }),
    failures: page.getByRole('region', { name: 'Failure and retry intelligence' }),
    gate: page.getByRole('region', { name: 'CI gate and artifact health' }),
    units: overview.getByRole('table', { name: 'Counting units: whole run and filtered view' }),
    instances: explorer.getByRole('table', { name: 'Instances in the filtered view' }),
    filter: (group: string, option: string) =>
      page
        .getByRole('group', { name: group, exact: true })
        .getByRole('checkbox', { name: option, exact: true }),
    clearFilters: page.getByRole('button', { name: 'Clear filters' }),
  };
}

/** Whole-run and filtered cells of one counting-unit row. */
function unitCells(page: Page, unit: string) {
  const row = ui(page)
    .units.getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: unit }) });
  return { whole: row.getByRole('cell').nth(0), filtered: row.getByRole('cell').nth(1) };
}

/** Body rows of the explorer table (the header row is excluded). */
function bodyRows(page: Page) {
  return ui(page).instances.locator('tbody').getByRole('row');
}

async function openValid(page: Page, text = summaryText()): Promise<DashboardSession> {
  const session = await openDashboard(page, bundle);
  await chooseSummary(ui(page).file, text);
  await expect(ui(page).status).toHaveText('Summary loaded and validated.');
  return session;
}

test.describe('Quality dashboard', () => {
  test('starts in the no-summary state with every local asset and no network access', async ({
    page,
  }) => {
    const session = await openDashboard(page, bundle);
    const view = ui(page);

    await expect(page).toHaveTitle('Enterprise Test Reporting Dashboard');
    await expect(view.status).toHaveText('No summary loaded.');
    await expect(view.overview).toContainText('No run metadata: no valid summary is loaded.');
    await expect(view.explorer).toContainText('No summary is loaded.');
    await expect(view.gate).toContainText('Final CI verdict: UNVERIFIED');
    // The module graph loaded: the filter form is built by app.js.
    await expect(view.filter('Project', 'chromium')).toBeVisible();

    expect([...new Set(session.served)].sort()).toEqual(
      ['/dashboard/', ...REQUIRED_SUBRESOURCES].sort(),
    );
    expect(session.missing).toEqual([]);
    expect(session.blocked).toEqual([]);
    expect(session.pageErrors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('declares and enforces the Content Security Policy', async ({ page }) => {
    const session = await openDashboard(page, bundle);
    await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
      'content',
      EXPECTED_CSP,
    );

    // An injected inline script and a same-origin fetch are both refused.
    const probe = await page.evaluate(async () => {
      const marker = window as unknown as { __inline?: number };
      const script = document.createElement('script');
      script.textContent = 'window.__inline = 1';
      document.body.append(script);
      let fetched = 'allowed';
      try {
        await fetch('/dashboard/app.js');
      } catch {
        fetched = 'refused';
      }
      return { inline: marker.__inline ?? null, fetched };
    });

    expect(probe).toEqual({ inline: null, fetched: 'refused' });
    await expect.poll(() => cspViolations(page)).toEqual(['script-src-elem', 'connect-src']);
    // The refused fetch never reached the network layer.
    expect(session.served.filter((p) => p === '/dashboard/app.js')).toHaveLength(1);
    expect(session.blocked).toEqual([]);
  });

  test('shows run identity, five distinct counting units and an unverified verdict', async ({
    page,
  }) => {
    const summary = summaryOf();
    const totals = summary.totals;
    expect(totals).not.toBeNull();
    await openValid(page);
    const view = ui(page);

    await expect(view.overview.getByRole('definition').first()).toHaveText(
      String(summary.run.runId),
    );
    await expect(view.overview).toContainText(summary.run.headSha);
    await expect(view.overview).toContainText(summary.run.generatedAt);

    const units = {
      'Definitions (distinct tests in source)': totals?.definitions,
      'Instances (test per project; default quality unit)': totals?.instances,
      'Executions (instance runs, including shard duplicates)': totals?.executions,
      'Attempts (every try, including retries)': totals?.attempts,
      'Retries (attempts with retry index above 0)': totals?.retries,
    };
    // The synthetic run is shaped so that all five units differ.
    expect(new Set(Object.values(units)).size).toBe(5);
    await expect(view.units.getByRole('columnheader')).toHaveText([
      'Unit',
      'Whole run',
      'Filtered view',
    ]);
    for (const [unit, value] of Object.entries(units)) {
      const cells = unitCells(page, unit);
      await expect(cells.whole).toHaveText(String(value));
      await expect(cells.filtered).toHaveText(String(value));
    }

    await expect(view.overview.getByText('Final CI verdict: UNVERIFIED.')).toBeVisible();
    await expect(view.gate.getByText('Final CI verdict: UNVERIFIED.')).toBeVisible();
    await expect(
      view.gate.getByRole('table', { name: /Eight observed Gate inputs/ }),
    ).toBeVisible();
    await expect(
      view.gate.getByRole('table', { name: /Eight observed Gate inputs/ }).locator('tbody tr'),
    ).toHaveCount(8);
    await expect(view.gate).toContainText('Artifact evidence');
    await expect(view.gate).toContainText('NOT AVAILABLE');
  });

  test('filters by project, browser and outcome while keeping whole-run totals', async ({
    page,
  }) => {
    const summary = summaryOf();
    const count = (predicate: (i: (typeof summary.instances)[number]) => boolean): number =>
      summary.instances.filter(predicate).length;
    const whole = String(summary.instances.length);
    await openValid(page);
    const view = ui(page);
    const instances = unitCells(page, 'Instances (test per project; default quality unit)');

    await view.filter('Project', 'firefox').check();
    await expect(view.filterState).toHaveText(/^Filters active \(Project: firefox\)/);
    await expect(bodyRows(page)).toHaveCount(count((i) => i.project === 'firefox'));
    await expect(instances.whole).toHaveText(whole);
    await expect(instances.filtered).toHaveText(String(count((i) => i.project === 'firefox')));
    await view.filter('Project', 'firefox').uncheck();

    await view.filter('Browser', 'WebKit').check();
    await expect(bodyRows(page)).toHaveCount(count((i) => i.project.startsWith('webkit')));
    // Project rows are filtered by project only (defect M8C-2B-D1): other
    // browsers' rows stay listed, with zero counts.
    await expect(
      view.projects
        .getByRole('row')
        .filter({ has: page.getByRole('rowheader', { name: 'webkit', exact: true }) })
        .getByRole('cell')
        .nth(3),
    ).toHaveText(String(count((i) => i.project.startsWith('webkit'))));
    await expect(
      view.projects
        .getByRole('row')
        .filter({ has: page.getByRole('rowheader', { name: 'chromium', exact: true }) })
        .getByRole('cell')
        .nth(3),
    ).toHaveText('0');
    await view.filter('Browser', 'WebKit').uncheck();

    await view.filter('Instance outcome', 'Failed').check();
    await expect(bodyRows(page)).toHaveCount(count((i) => i.outcome === 'failed'));
    await expect(view.explorer).toContainText(
      `Filtered view: ${String(count((i) => i.outcome === 'failed'))} instances of ${whole}`,
    );
    await expect(instances.whole).toHaveText(whole);
  });

  test('filters by classification, ambiguity and certainty, and resets', async ({ page }) => {
    const summary = summaryOf();
    await openValid(page);
    const view = ui(page);

    await view.filter('Run classification', 'Deliberate probe').check();
    await expect(view.overview).toContainText('Excluded by the run classification filter.');
    await expect(view.explorer).toContainText('Excluded by the run classification filter.');
    await view.filter('Run classification', 'Deliberate probe').uncheck();
    await view.filter('Run classification', 'Ordinary').check();
    await expect(view.units).toBeVisible();
    await view.filter('Run classification', 'Ordinary').uncheck();

    await view.filter('Evidence and run scope', 'Ambiguous identities only').check();
    await expect(bodyRows(page)).toHaveCount(
      summary.instances.filter((i) => i.identity === 'ambiguous-repeat-or-shard').length,
    );
    await expect(bodyRows(page).getByText('Ambiguous identity (repeat or shard)')).toHaveCount(2);
    await view.filter('Evidence and run scope', 'Ambiguous identities only').uncheck();

    await view.filter('Evidence and run scope', 'Provisional outcomes only').check();
    await expect(bodyRows(page)).toHaveCount(
      summary.instances.filter((i) => i.outcomeCertainty === 'provisional').length,
    );
    await view.filter('Project', 'chromium').check();
    await expect(view.filterState).toContainText('provisional outcomes only');

    await view.clearFilters.click();
    await expect(view.filterState).toHaveText(
      /^No filters: the filtered view equals the whole run/,
    );
    await expect(view.filter('Project', 'chromium')).not.toBeChecked();
    await expect(
      view.filter('Evidence and run scope', 'Provisional outcomes only'),
    ).not.toBeChecked();
    await expect(bodyRows(page)).toHaveCount(summary.instances.length);
  });

  test('excludes probe and unknown-classification runs unless included', async ({ page }) => {
    const view = ui(page);
    await openValid(page, summaryText(richReport(), { branch: 'probe/synthetic' }));
    await expect(view.overview).toContainText('Excluded: deliberate probe run.');
    await expect(view.explorer).toContainText('Excluded: deliberate probe run.');
    await expect(page.locator('body')).not.toContainText('probe/synthetic');

    await view
      .filter('Evidence and run scope', 'Include deliberate probe and unknown runs')
      .check();
    await expect(view.overview).toContainText(
      'Scope: deliberate probe run, included by filter choice.',
    );
    await expect(bodyRows(page)).toHaveCount(summaryOf().instances.length);

    await chooseSummary(view.file, summaryText(richReport(), { branch: '' }));
    await expect(view.overview).toContainText(
      'Scope: unknown-classification run, included by filter choice.',
    );
    await view
      .filter('Evidence and run scope', 'Include deliberate probe and unknown runs')
      .uncheck();
    await expect(view.overview).toContainText('Excluded: unknown run classification.');
  });

  test('explorer rows show counts, retries and identity markers', async ({ page }) => {
    const summary = summaryOf();
    await openValid(page);
    const view = ui(page);
    await expect(bodyRows(page)).toHaveCount(summary.instances.length);
    await expect(view.instances.getByRole('columnheader')).toHaveCount(10);

    const flaky = summary.instances.find((i) => i.outcome === 'flaky');
    expect(flaky).toBeDefined();
    const flakyRow = bodyRows(page).filter({
      has: page.getByRole('rowheader', { name: flaky?.instanceId, exact: true }),
    });
    await expect(flakyRow.getByRole('cell')).toHaveText(
      [
        'chromium',
        'Chromium',
        'tests/ui/login.spec.ts:15',
        'Flaky',
        '1',
        '3',
        '2',
        'None',
        'Attempt details (1 execution)',
      ],
      { useInnerText: true },
    );

    const duplicate = bodyRows(page).filter({ hasText: 'Inferred shard duplicate' });
    await expect(duplicate).toHaveCount(1);
    await expect(duplicate).toContainText('Conflicting executions');
    await expect(duplicate).toContainText('Attempt details (2 executions)');
    await expect(bodyRows(page).filter({ hasText: 'Unrecognized project' })).toHaveCount(1);
    await expect(bodyRows(page).filter({ hasText: 'Provisional outcome' })).toHaveCount(1);

    await expect(view.failures).toContainText(
      'Structured classification, not verified root cause.',
    );
    await expect(view.failures.getByRole('table', { name: /Retries per instance/ })).toContainText(
      `${flaky?.instanceId ?? ''}: chromium, tests/ui/login.spec.ts:15`,
    );
  });

  test('attempt details expand with the mouse and with the keyboard', async ({ page }) => {
    const summary = summaryOf();
    await openValid(page);
    const flaky = summary.instances.find((i) => i.outcome === 'flaky');
    const flakyRow = bodyRows(page).filter({
      has: page.getByRole('rowheader', { name: flaky?.instanceId, exact: true }),
    });
    const toggle = flakyRow.getByText('Attempt details (1 execution)');
    const lastAttempt = flakyRow.getByText('Retry index 2: passed, duration 25 ms');

    await expect(lastAttempt).toBeHidden();
    await toggle.click();
    await expect(lastAttempt).toBeVisible();
    await toggle.click();
    await expect(lastAttempt).toBeHidden();

    const duplicate = bodyRows(page).filter({ hasText: 'Inferred shard duplicate' });
    const keyboardToggle = duplicate.getByText('Attempt details (2 executions)');
    await keyboardToggle.focus();
    await expect(keyboardToggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(duplicate.getByText(/^Execution 2:/)).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(duplicate.getByText(/^Execution 2:/)).toBeHidden();
  });

  test('communicates the 500-row explorer cap', async ({ page }) => {
    // 501 rows with nested details: allow three times the default timeout.
    test.slow();
    await openValid(page, summaryText(manyInstancesReport(501)));
    const view = ui(page);
    await expect(view.explorer).toContainText(
      'Filtered view: 501 instances of 501 in the whole run.',
    );
    await expect(view.explorer).toContainText(
      'Showing the first 500 instances. Narrow the filters to see the rest.',
    );
    await expect(bodyRows(page)).toHaveCount(500);
  });

  test('rejects invalid JSON, a wrong schema major version and oversized input', async ({
    page,
  }) => {
    await openDashboard(page, bundle);
    const view = ui(page);

    await chooseSummary(view.file, '{"schemaVersion":');
    await expect(view.status).toHaveText(
      'Summary rejected: the file is not a valid quality summary.',
    );
    await expect(view.alert).toContainText('The file is not valid JSON.');
    await expect(view.overview).toContainText('No run metadata');

    await chooseSummary(
      view.file,
      editSummary(summaryText(), (root) => {
        root.schemaVersion = '2.0.0';
      }),
    );
    await expect(view.status).toHaveText('Summary rejected: unsupported schema version.');
    await expect(view.alert).toContainText('Found major version 2; this dashboard supports 1.');
    await expect(view.explorer).toContainText('Not available: unsupported schema version.');

    await chooseSummary(view.file, oversizedInput());
    await expect(view.alert).toContainText('The file is larger than the 5 MB limit.');

    // A raw Playwright JSON report is not a summary.
    await chooseSummary(view.file, JSON.stringify(richReport()), 'results.json');
    await expect(view.status).toHaveText(
      'Summary rejected: the file is not a valid quality summary.',
    );
  });

  test('handles unavailable data, inconsistent evidence, unknown projects and extra fields', async ({
    page,
  }) => {
    await openDashboard(page, bundle);
    const view = ui(page);

    await chooseSummary(view.file, summaryText(richReport(), { reportState: 'report-missing' }));
    await expect(view.status).toHaveText('Summary loaded: test data is unavailable for this run.');
    await expect(view.alert).toContainText('test data is unavailable');
    await expect(view.explorer).toContainText(
      'Not available: the test report was missing for this run.',
    );
    await expect(view.gate.locator('tbody tr')).toHaveCount(8);
    await expect(
      view.overview
        .getByRole('table', { name: 'Completeness counts (whole run)' })
        .getByRole('cell'),
    ).toHaveText(Array.from({ length: 9 }, () => 'UNKNOWN'));

    await chooseSummary(
      view.file,
      editSummary(summaryText(), (root) => {
        (root.totals as Record<string, unknown>).retries = 9;
      }),
    );
    await expect(view.overview).toContainText('Inconsistent evidence');
    await expect(view.overview).toContainText(
      'Inconsistent: recorded counts disagree with the records',
    );
    await expect(unitCells(page, 'Retries (attempts with retry index above 0)').whole).toHaveText(
      '9',
    );

    await chooseSummary(
      view.file,
      editSummary(summaryText(), (root) => {
        root.unexpectedField = `<b>${CANARY}</b>`;
        (root.run as Record<string, unknown>).branch = `feature/${CANARY}`;
      }),
    );
    await expect(view.status).toHaveText('Summary loaded and validated.');
    await expect(view.overview).toContainText('Some executions belong to an unrecognized project.');
    await expect(view.projects.getByRole('rowheader', { name: 'unrecognized' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(CANARY);
  });

  test('never renders titles, canaries, markup or a passing verdict', async ({ page }) => {
    const session = await openValid(page);

    await expect(page.locator('body')).not.toContainText(CANARY);
    await expect(page.locator('body')).not.toContainText('synthetic provisional');
    await expect(page.locator('body')).not.toContainText('onerror');
    await expect(page.locator('main img, main script, main iframe, main object')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned ?? null),
    ).toBeNull();

    await expect(page.getByText(/verdict:\s*(pass|passed|success)/i)).toHaveCount(0);
    await expect(page.getByText('Final CI verdict: UNVERIFIED.')).toHaveCount(2);
    // Gate inputs are observations: all eight are "Success" here, yet no verdict is claimed.
    await expect(ui(page).gate.locator('tbody tr').getByText('Success')).toHaveCount(8);

    expect(session.blocked).toEqual([]);
    expect(session.missing).toEqual([]);
    expect(session.pageErrors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
    expect(page.url()).toBe(DASHBOARD_URL);
  });
});
