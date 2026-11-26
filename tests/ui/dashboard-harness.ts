/**
 * Browser test harness for the static quality dashboard (ADR-0009, M8C-2B).
 *
 * Shared by `dashboard.spec.ts` and `dashboard.a11y.spec.ts`; contains no
 * tests. It:
 *
 * - builds the dashboard with the approved `scripts/build-dashboard.ts` into
 *   a fresh temporary directory outside the repository (one per `beforeAll`,
 *   so workers never share a directory) and removes it afterwards;
 * - serves exactly the five built files through Playwright route fulfilment
 *   on a reserved origin (`.test` is reserved by RFC 6761), so no listening
 *   socket is opened;
 * - aborts every other request and records it, so a spec can assert that no
 *   network access was attempted;
 * - records CSP violations and uncaught page errors;
 * - produces sanitized summaries only from the synthetic M8A fixtures.
 *
 * No real report, trace, screenshot, authentication file or CI artifact is
 * read. Assertions stay in the specs.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';

import {
  CANARY,
  DEFAULT_PROJECTS,
  attempt,
  context,
  passing,
  report,
  spec,
  testEntry,
} from '@/reporting/fixtures';
import { LIMITS, normalize, serialize, type QualitySummary } from '@/reporting/quality-summary';

export { CANARY };

export const DASHBOARD_ORIGIN = 'http://dashboard.test';
export const DASHBOARD_URL = `${DASHBOARD_ORIGIN}/dashboard/`;

/** The Content Security Policy the page must declare, verbatim. */
export const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Served path -> built file and content type. Nothing else is served. */
const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  '/dashboard/': { file: 'dashboard/index.html', type: 'text/html; charset=utf-8' },
  '/dashboard/index.html': { file: 'dashboard/index.html', type: 'text/html; charset=utf-8' },
  '/dashboard/styles.css': { file: 'dashboard/styles.css', type: 'text/css; charset=utf-8' },
  '/dashboard/app.js': { file: 'dashboard/app.js', type: 'text/javascript; charset=utf-8' },
  '/src/reporting/dashboard-model.js': {
    file: 'src/reporting/dashboard-model.js',
    type: 'text/javascript; charset=utf-8',
  },
  '/src/reporting/quality-summary.js': {
    file: 'src/reporting/quality-summary.js',
    type: 'text/javascript; charset=utf-8',
  },
};

/** The four files the page must request (index.html is the navigation). */
export const REQUIRED_SUBRESOURCES = [
  '/dashboard/app.js',
  '/dashboard/styles.css',
  '/src/reporting/dashboard-model.js',
  '/src/reporting/quality-summary.js',
] as const;

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

export interface DashboardBundle {
  readonly dir: string;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly remove: () => void;
}

/** Runs the approved build into a new temporary directory and loads its files. */
export function buildDashboard(): DashboardBundle {
  const repoRoot = resolve(__dirname, '..', '..');
  const parent = mkdtempSync(join(tmpdir(), 'pw-dashboard-'));
  const dir = join(parent, 'bundle');
  const remove = (): void => rmSync(parent, { recursive: true, force: true });
  try {
    execFileSync(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        'scripts/build-dashboard.ts',
        '--out',
        dir,
      ],
      { cwd: repoRoot, stdio: 'pipe' },
    );
    const files = new Map<string, Buffer>();
    for (const asset of Object.values(ASSETS)) {
      files.set(asset.file, readFileSync(join(dir, asset.file)));
    }
    return { dir, files, remove };
  } catch (error) {
    remove();
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Serving and observation
 * ------------------------------------------------------------------ */

export interface DashboardSession {
  /** Served paths, in request order. */
  readonly served: string[];
  /** Same-origin paths that are not part of the bundle (answered 404). */
  readonly missing: string[];
  /** Origins of aborted requests to anything but the dashboard origin. */
  readonly blocked: string[];
  /** Uncaught page errors (names only). */
  readonly pageErrors: string[];
}

/** Routes the bundle, blocks everything else, then opens the dashboard. */
export async function openDashboard(
  page: Page,
  bundle: DashboardBundle,
): Promise<DashboardSession> {
  const session: DashboardSession = { served: [], missing: [], blocked: [], pageErrors: [] };
  page.on('pageerror', (error) => session.pageErrors.push(error.name));
  // Runs before page scripts; it is not subject to the page CSP.
  await page.addInitScript(() => {
    const store: string[] = [];
    Object.defineProperty(window, '__cspViolations', { value: store });
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push(event.effectiveDirective);
    });
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== DASHBOARD_ORIGIN) {
      session.blocked.push(url.origin);
      await route.abort('blockedbyclient');
      return;
    }
    const asset = ASSETS[url.pathname];
    const body = asset === undefined ? undefined : bundle.files.get(asset.file);
    if (asset === undefined || body === undefined || url.search !== '') {
      session.missing.push(url.pathname);
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      return;
    }
    session.served.push(url.pathname);
    await route.fulfill({ status: 200, contentType: asset.type, body });
  });
  await page.goto(DASHBOARD_URL);
  return session;
}

/** Directives reported by `securitypolicyviolation` events so far. */
export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...((window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []),
  ]);
}

/** Chooses a synthetic file in the dashboard's file input. */
export async function chooseSummary(
  input: Locator,
  text: string | Buffer,
  name = 'quality-summary.json',
): Promise<void> {
  await input.setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: typeof text === 'string' ? Buffer.from(text, 'utf8') : text,
  });
}

/* ------------------------------------------------------------------ *
 * Synthetic summaries (all from the M8A normalizer and fixtures)
 * ------------------------------------------------------------------ */

/** A title carrying markup and the canary; M8A never emits titles. */
export const MALICIOUS_TITLE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script> ${CANARY}`;

/**
 * One run that exercises every marker: retries (flaky), a failure, a
 * provisional outcome, two ambiguous repeats, an inferred shard duplicate
 * with conflicting outcomes, an unrecognized project and an API test.
 */
export function richReport(): Record<string, unknown> {
  const projects = DEFAULT_PROJECTS.map((p) =>
    p.name === 'webkit' ? { name: p.name, repeatEach: 2 } : p,
  );
  return report(
    [
      spec(
        'ui/login.spec.ts',
        15,
        MALICIOUS_TITLE,
        [
          testEntry('chromium', 'flaky', [
            attempt('failed', 0),
            attempt('failed', 1),
            attempt('passed', 2),
          ]),
          passing('firefox'),
          testEntry('webkit', 'unexpected', [attempt('failed', 0)]),
        ],
        { tags: ['smoke'] },
      ),
      spec('ui/login.spec.ts', 33, 'synthetic provisional', [
        testEntry('chromium', 'unexpected', [attempt('failed', 0), attempt('interrupted', 1)]),
      ]),
      spec('ui/login.spec.ts', 40, 'synthetic repeat', [passing('webkit')]),
      spec('ui/login.spec.ts', 40, 'synthetic repeat', [passing('webkit')]),
      spec('auth.setup.ts', 24, 'synthetic setup', [passing('setup')], { column: 1 }),
      spec(
        'auth.setup.ts',
        24,
        'synthetic setup',
        [testEntry('setup', 'unexpected', [attempt('failed', 0)])],
        { column: 1 },
      ),
      spec('ui/other.spec.ts', 5, 'synthetic unknown project', [passing('mystery-project')]),
      spec('api/products.spec.ts', 13, 'synthetic api', [passing('api')], { tags: ['api'] }),
    ],
    { projects },
  );
}

export function summaryOf(
  reportValue: Record<string, unknown> = richReport(),
  overrides: Record<string, unknown> = {},
): QualitySummary {
  return normalize(reportValue, context(overrides));
}

export function summaryText(
  reportValue: Record<string, unknown> = richReport(),
  overrides: Record<string, unknown> = {},
): string {
  return serialize(summaryOf(reportValue, overrides));
}

/** A run with `count` passing Chromium instances, for the explorer row cap. */
export function manyInstancesReport(count: number): Record<string, unknown> {
  return report(
    Array.from({ length: count }, (_, i) =>
      spec('ui/login.spec.ts', i + 1, `synthetic ${String(i)}`, [passing('chromium')]),
    ),
  );
}

/** Parses, edits and re-serializes a summary text. */
export function editSummary(text: string, edit: (root: Record<string, unknown>) => void): string {
  const root = JSON.parse(text) as Record<string, unknown>;
  edit(root);
  return JSON.stringify(root);
}

/** One byte over the dashboard's input limit (the M8A output limit). */
export function oversizedInput(): Buffer {
  return Buffer.alloc(LIMITS.maxOutputBytes + 1, 0x20);
}
