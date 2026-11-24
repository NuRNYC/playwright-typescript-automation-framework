import { defineConfig, devices } from '@playwright/test';
// Imported from '@/config' (the runtime singleton), not '@/config/env' (the
// pure core). Importing the singleton is what performs validation, and doing
// it here means a bad APP_TARGET or BASE_URL aborts before any browser starts.
import { config, describeConfig } from '@/config';
import { SETUP_PROJECT } from '@/auth/session';
import { recordingPolicy } from '@/config/security';

// Recording and reporting are decided by the deployment tier (ADR-0005).
// Public demos keep exactly the settings below; restricted targets record
// nothing and report to the console only. Checkpoint A (the `@/config`
// import above) and checkpoint B (`globalSetup`) enforce the boundary.
const recording = recordingPolicy(config.tier);

// Specs under tests/ui/authenticated/ need a saved session; every other spec
// runs logged out. Location decides the project, so a spec can be in exactly
// one group and is never discovered twice. `[\\/]` accepts both separators.
const AUTHENTICATED_DIR = /[\\/]authenticated[\\/]/;
const AUTHENTICATED_SPEC = /[\\/]authenticated[\\/].*\.spec\.ts$/;

// Accessibility scans (`*.a11y.spec.ts`) run in Chromium only (ADR-0004).
// axe's rules are engine-independent, but some verdicts depend on rendering;
// one browser keeps the gate deterministic. Other browsers ignore them.
const A11Y_SPEC = /\.a11y\.spec\.ts$/;

const browsers = [
  { name: 'chromium', device: devices['Desktop Chrome'], a11y: true },
  { name: 'firefox', device: devices['Desktop Firefox'], a11y: false },
  { name: 'webkit', device: devices['Desktop Safari'], a11y: false },
] as const;

const ignoreA11y = (a11y: boolean): RegExp[] => (a11y ? [] : [A11Y_SPEC]);

// API specs (ADR-0006) run only in the browser-free `api` project, against an
// in-process loopback stub started by a worker-scoped fixture -- not against
// the application target, and without `webServer`.
const API_DIR = /[\\/]tests[\\/]api[\\/]/;
const API_SPEC = /[\\/]tests[\\/]api[\\/].+\.spec\.ts$/;

// Print the resolved configuration exactly once per run.
//
// The guard is load-bearing and was added after observing the banner print 10
// times for a 9-test run. Worker processes re-evaluate this config file too,
// not merely the modules it imports, so "log from playwright.config.ts" is NOT
// equivalent to "log once". Playwright sets TEST_WORKER_INDEX only in worker
// processes, so its absence identifies the main process.
//
// The summary is allow-listed, and the URL is stripped of credentials, query
// string and fragment. See docs/security-testing-policy.md.
if (process.env.TEST_WORKER_INDEX === undefined) {
  console.log(`[config] ${describeConfig(config)}`);
}

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: true,
  // Parsed explicitly rather than via `!!process.env.CI`: every non-empty
  // string is truthy, so `CI=0` previously selected CI mode.
  forbidOnly: config.execution === 'ci',
  retries: config.execution === 'ci' ? 2 : 0,
  // Public demo: [['list'], ['html', { open: 'never' }]]. Restricted: [['list']].
  reporter: recording.reporter.map((entry) => [...entry] as const),
  globalSetup: './src/config/global-setup.ts',
  use: {
    baseURL: config.baseURL,
    testIdAttribute: 'data-test',
    // Public demo: retain-on-failure / only-on-failure / video unset.
    // Restricted: off / off / off.
    trace: recording.trace,
    screenshot: recording.screenshot,
    ...(recording.video === undefined ? {} : { video: recording.video }),
  },
  // Seven projects (ADR-0003):
  //   setup                   signs in once, writes a cookie-only session
  //   chromium|firefox|webkit public specs; NO dependency on setup, so the
  //                           login-form tests run even when setup fails
  //   <browser>-authenticated authenticated specs; depend on setup
  // Note: `--project=chromium` now selects public specs only. Use
  // `--project='chromium*'` for both groups in one browser.
  // Accessibility specs run only in `chromium` and `chromium-authenticated`.
  //   api                     browser-free API specs (ADR-0006); no setup
  //                           dependency, no browser launched
  projects: [
    {
      name: SETUP_PROJECT,
      testMatch: /auth\.setup\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    ...browsers.map(({ name, device, a11y }) => ({
      name,
      use: { ...device },
      testIgnore: [AUTHENTICATED_DIR, API_DIR, ...ignoreA11y(a11y)],
    })),
    ...browsers.map(({ name, device, a11y }) => ({
      name: `${name}-authenticated`,
      use: { ...device },
      testMatch: AUTHENTICATED_SPEC,
      testIgnore: ignoreA11y(a11y),
      dependencies: [SETUP_PROJECT],
    })),
    { name: 'api', testMatch: API_SPEC },
  ],
});
