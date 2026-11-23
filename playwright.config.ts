import { defineConfig, devices } from '@playwright/test';
import { config, describeConfig } from '@/config/env';

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
  console.log(`[config] ${describeConfig()}`);
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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
