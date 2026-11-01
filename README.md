# Playwright + TypeScript Automation Framework
[![Playwright UI Tests](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/workflows/tests.yml)
A **public, independently authored demonstration framework** showcasing maintainable UI test automation and practical SDET patterns. It uses the public [Sauce Demo](https://www.saucedemo.com/) sample site; it does **not** contain employer code.

## What it demonstrates

- Page Object Model (`pages/`), typed test data (`fixtures/`), functional and negative test coverage
- Chromium, Firefox and WebKit cross-browser execution
- Retries in CI, screenshots/traces on failure and HTML reporting
- GitHub Actions test pipeline with an uploaded report

## Run locally

Requires Node.js 22+ and internet connectivity to install dependencies and access Sauce Demo.

```bash
npm install
npx playwright install
npm run typecheck
npm test
npm run test:report
```

Run one browser: `npx playwright test --project=chromium`.

## Repository structure

```text
pages/             Page objects and reusable actions
fixtures/          Typed test inputs
tests/             Functional / negative tests
.github/workflows/ CI configuration
```

## Engineering choices

Tests focus on user-visible outcomes. Locators prefer accessible semantics or stable `data-test` attributes. No secrets or production credentials are stored. External sample websites can change, so a test failure may reflect demo-site changes as well as product failures.

## Next improvements

Add accessibility checks with `@axe-core/playwright`, API-backed test data fixtures, sharding, and failure triage annotations. These are **planned**, not implemented in this starter.

## Portfolio context

Public sample by [NuRNYC](https://github.com/NuRNYC), demonstrating relevant QE architecture patterns; not a representation of a specific employer's proprietary framework.
