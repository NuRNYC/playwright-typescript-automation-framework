import { defineConfig, devices } from '@playwright/test';
// Imported from '@/config' (the runtime singleton), not '@/config/env' (the
// pure core). Importing the singleton is what performs validation, and doing
// it here means a bad APP_TARGET or BASE_URL aborts before any browser starts.
import { config, describeConfig } from '@/config';
import { SETUP_PROJECT } from '@/auth/session';

// Specs under tests/ui/authenticated/ need a saved session; every other spec
// runs logged out. Location decides the project, so a spec can be in exactly
// one group and is never discovered twice. `[\\/]` accepts both separators.
const AUTHENTICATED_DIR = /[\\/]authenticated[\\/]/;
const AUTHENTICATED_SPEC = /[\\/]authenticated[\\/].*\.spec\.ts$/;

const browsers = [
  { name: 'chromium', device: devices['Desktop Chrome'] },
  { name: 'firefox', device: devices['Desktop Firefox'] },
  { name: 'webkit', device: devices['Desktop Safari'] },
] as const;

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
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: config.baseURL,
    testIdAttribute: 'data-test',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Seven projects (ADR-0003):
  //   setup                   signs in once, writes a cookie-only session
  //   chromium|firefox|webkit public specs; NO dependency on setup, so the
  //                           login-form tests run even when setup fails
  //   <browser>-authenticated authenticated specs; depend on setup
  // Note: `--project=chromium` now selects public specs only. Use
  // `--project='chromium*'` for both groups in one browser.
  projects: [
    {
      name: SETUP_PROJECT,
      testMatch: /auth\.setup\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    ...browsers.map(({ name, device }) => ({
      name,
      use: { ...device },
      testIgnore: AUTHENTICATED_DIR,
    })),
    ...browsers.map(({ name, device }) => ({
      name: `${name}-authenticated`,
      use: { ...device },
      testMatch: AUTHENTICATED_SPEC,
      dependencies: [SETUP_PROJECT],
    })),
  ],
});
