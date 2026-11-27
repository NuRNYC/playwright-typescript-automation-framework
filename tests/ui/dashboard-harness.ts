/**
 * Browser test harness for the static quality dashboard (ADR-0009, M8C-2B).
 *
 * Shared by `dashboard.spec.ts` and `dashboard.a11y.spec.ts`; contains no
 * tests. It:
 *
 * - builds the dashboard with the approved `scripts/build-dashboard.ts` into
 *   a fresh temporary directory outside the repository (one per `beforeAll`,
 *   so workers never share a directory) and removes it afterwards;
 * - serves exactly the built files listed in ASSETS through Playwright route fulfilment
 *   on a reserved origin (`.test` is reserved by RFC 6761), so no listening
 *   socket is opened;
 * - aborts every other request and records it, so a spec can assert that no
 *   network access was attempted;
 * - records CSP violations and uncaught page errors;
 * - produces sanitized summaries only from the synthetic M8A fixtures;
 * - for publication tests (ADR-0011 P3-4), substitutes the generated
 *   `publication-data.js` with a module produced by the committed
 *   generator (`publicationDataModule`) from a synthetic manifest that the
 *   committed browser reader accepts. No real generation is read and no
 *   publication-enabled build (which needs a publisher run) is performed.
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
import { parsePublication } from '@/reporting/publication-view';
import { publicationDataModule } from '../../scripts/build-dashboard';
import { demoPublicationText } from '@/reporting/demo-publication';

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
  '/dashboard/publication-data.js': {
    file: 'dashboard/publication-data.js',
    type: 'text/javascript; charset=utf-8',
  },
  '/src/reporting/publication-view.js': {
    file: 'src/reporting/publication-view.js',
    type: 'text/javascript; charset=utf-8',
  },
  '/src/reporting/verdict.js': {
    file: 'src/reporting/verdict.js',
    type: 'text/javascript; charset=utf-8',
  },
};

/** The files the page must request (index.html is the navigation). */
export const REQUIRED_SUBRESOURCES = [
  '/dashboard/app.js',
  '/dashboard/publication-data.js',
  '/dashboard/styles.css',
  '/src/reporting/dashboard-model.js',
  '/src/reporting/publication-view.js',
  '/src/reporting/quality-summary.js',
  '/src/reporting/verdict.js',
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

/* ------------------------------------------------------------------ *
 * Synthetic publications (ADR-0011 P3-4)
 * ------------------------------------------------------------------ */

export const PUBLICATION_BUILT_AT = '2026-11-26T12:00:00.000Z';
export const PUBLICATION_SOURCE_COMMIT = 'c0ffee0000000000000000000000000000c0ffee';
const SYNTHETIC_DIGEST = `sha256:${'ab'.repeat(32)}`;

export const PUBLICATION_POLICY = {
  repositoryId: 900_000_001,
  repositoryFullName: 'example-owner/example-repo',
  workflowId: 800_000_001,
  workflowPath: '.github/workflows/tests.yml',
  workflowName: 'Playwright UI Tests',
  trustedEvent: 'push',
  trustedBranch: 'main',
} as const;

type Json = Record<string, unknown>;

/** Metrics as P1 publishes them for one verified-origin summary. */
export function publicationMetrics(): Json {
  return {
    authenticity: 'BUILD_VERIFIED',
    freshness: 'CURRENT',
    summarySchemaVersion: '1.0.0',
    totals: {
      attempts: 20,
      byExecutionOutcome: { failed: 1, flaky: 1, passed: 17 },
      byInstanceOutcome: { failed: 1, flaky: 1, passed: 16 },
      definitions: 12,
      executions: 19,
      instances: 18,
      retries: 1,
      zeroAttemptExecutions: 0,
    },
    completeness: {
      ambiguousIdentities: 0,
      droppedTags: 0,
      inconsistentExecutions: 0,
      invalidDurations: 0,
      invalidRetries: 0,
      omissionDetection: 'not-supported',
      provisionalOutcomes: 2,
      shardAttribution: 'not-available',
      statsCrossCheck: 'match',
      unclassifiedAttempts: 0,
      unrecognizedProjectExecutions: 0,
      unresolvedIdentities: 0,
    },
  };
}

export interface EntryOptions {
  readonly runId: number;
  readonly state?: string;
  readonly reasons?: readonly string[];
  readonly event?: string;
  readonly authenticity?: 'BUILD_VERIFIED' | 'RETAINED_UNAUTHENTICATED' | 'SYNTHETIC';
  readonly summary?: { state: string; reasons: readonly string[]; label: string | null };
  readonly artifact?: { id: number | null; digest: string | null; integrity: string };
  readonly metrics?: Json | null;
}

/** One manifest entry in canonical key order. Defaults: a build-verified pass with metrics. */
export function publicationEntry(o: EntryOptions): Json {
  const authenticity = o.authenticity ?? 'BUILD_VERIFIED';
  const verified = authenticity === 'BUILD_VERIFIED';
  return {
    runId: o.runId,
    runAttempt: 1,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    event: o.event ?? 'push',
    gate: {
      state: o.state ?? 'VERIFIED_PASS',
      reasons: o.reasons ?? ['gate-success'],
      authenticity,
      freshness: verified
        ? 'CURRENT'
        : authenticity === 'SYNTHETIC'
          ? 'NOT_APPLICABLE'
          : 'HISTORICAL',
      verifiedAt: verified ? PUBLICATION_BUILT_AT : null,
    },
    summary: o.summary ?? {
      state: 'SUMMARY_VERIFIED_ORIGIN',
      reasons: ['verified-origin'],
      label: 'verified-origin',
    },
    artifact: o.artifact ?? {
      id: 15_000_001,
      digest: SYNTHETIC_DIGEST,
      integrity: 'verified-in-build',
    },
    metrics: o.metrics === undefined ? publicationMetrics() : o.metrics,
  };
}

/** Summary and artifact of a run whose summary artifact had expired. */
export const UNAVAILABLE = {
  summary: { state: 'SUMMARY_UNAVAILABLE', reasons: ['artifact-expired'], label: null },
  artifact: { id: null, digest: null, integrity: 'not-checked' },
  metrics: null,
} as const;

/**
 * A canonical manifest text. Throws unless the committed browser reader
 * accepts it (or `allowInvalid` is set for rejection tests).
 */
export function publicationText(
  sections: { results?: Json[]; untrustedOrigin?: Json[]; synthetic?: Json[] | null },
  options: { allowInvalid?: boolean } = {},
): string {
  const text = `${JSON.stringify(
    {
      manifestSchemaVersion: '1.0.0',
      kind: 'quality-verdict-publication',
      build: {
        sourceCommit: PUBLICATION_SOURCE_COMMIT,
        builtAt: PUBLICATION_BUILT_AT,
        policy: PUBLICATION_POLICY,
      },
      results: sections.results ?? [],
      untrustedOrigin: sections.untrustedOrigin ?? [],
      synthetic:
        sections.synthetic === undefined || sections.synthetic === null
          ? null
          : { label: 'SYNTHETIC DEMONSTRATION DATA', results: sections.synthetic },
    },
    null,
    2,
  )}\n`;
  const parsed = parsePublication(text);
  if (options.allowInvalid !== true && parsed.state !== 'valid') {
    throw new Error(`synthetic publication rejected: ${parsed.code}`);
  }
  return text;
}

/** The bundle with its generated data module replaced by the committed generator's output. */
export function withPublicationModule(bundle: DashboardBundle, module: string): DashboardBundle {
  const files = new Map(bundle.files);
  files.set('dashboard/publication-data.js', Buffer.from(module, 'utf8'));
  return { dir: bundle.dir, files, remove: () => undefined };
}

/** The bundle as a publication-enabled build would produce it for `text`. */
export function withEmbeddedPublication(bundle: DashboardBundle, text: string): DashboardBundle {
  return withPublicationModule(bundle, publicationDataModule('embedded', text));
}

/* ------------------------------------------------------------------ *
 * Synthetic demonstration (ADR-0011 P4)
 * ------------------------------------------------------------------ */

/** The committed generator's deterministic synthetic-only manifest. */
export function demoManifestText(): string {
  const out = demoPublicationText();
  if (out.status !== 'ok') throw new Error(`demo generation failed: ${out.code}`);
  return out.text;
}

/** The bundle as `build-dashboard.ts --demo` would produce it (or with substituted demo text). */
export function withDemoPublication(
  bundle: DashboardBundle,
  text = demoManifestText(),
): DashboardBundle {
  return withPublicationModule(bundle, publicationDataModule('demo', text));
}
