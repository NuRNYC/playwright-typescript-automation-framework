# Playwright + TypeScript Automation Framework

A **public, independently authored demonstration framework** showcasing maintainable UI test automation and practical SDET patterns. It uses the public [Sauce Demo](https://www.saucedemo.com/) sample site; it does **not** contain employer code.

## What it demonstrates

- Page Object Model with dependency injection via Playwright [custom fixtures](src/fixtures/test.ts)
- Page objects with **no runtime dependency on the test runner** — specs own assertions, so the same classes can back API or accessibility suites later
- Test data typed by derivation (`as const satisfies`), so types cannot drift from values
- Chromium, Firefox and WebKit cross-browser execution
- Type-aware ESLint (including `no-floating-promises`) plus Prettier, enforced in CI
- Retries in CI, screenshots/traces on failure and HTML reporting
- GitHub Actions pipeline with reproducible installs, a scoped token and an uploaded report

## Run locally

Requires Node.js 24+ (see `.nvmrc`) and internet connectivity to install dependencies and access Sauce Demo.

```bash
npm ci
npx playwright install
npm run verify      # typecheck + lint + format check
npm test
npm run test:report
```

| Command                           | Purpose                                    |
| --------------------------------- | ------------------------------------------ |
| `npm run verify`                  | all static checks: typecheck, lint, format |
| `npm run lint` / `lint:fix`       | ESLint (warnings are failures)             |
| `npm run format` / `format:check` | Prettier write / verify                    |
| `npm test`                        | full three-browser suite                   |
| `npm run test:smoke`              | `@smoke`-tagged tests only                 |
| `npm run test:ui` / `test:debug`  | interactive UI mode / step debugger        |

Run one browser: `npx playwright test --project=chromium`.

## Repository structure

```text
src/
  pages/           Page objects (state and actions; no assertions)
  fixtures/        Playwright test.extend fixtures — the DI seam
  data/            Typed static test data
tests/
  ui/              Functional / negative UI tests
.github/workflows/ CI configuration
```

Imports use the `@/` path alias mapped to `src/`, so moving a file does not
cascade through every import.

## Engineering choices

Tests focus on user-visible outcomes. Locators use `getByTestId` against the site's
`data-test` attributes (configured via `testIdAttribute`) or accessible semantics.

**Assertions live in specs, not page objects.** Page objects expose `Locator` fields and
semantic getters; specs assert with Playwright's auto-retrying `expect(locator)` matchers,
and with `expect.poll` for derived values such as `cartCount()`. This keeps auto-waiting
intact while leaving the page objects free of `expect`.

No secrets or production credentials are stored — the Sauce Demo accounts used are that
site's own published demo values. External sample websites can change, so a test failure
may reflect demo-site changes as well as product failures.

## Next improvements

Planned, **not** implemented: pre-commit hooks (husky + lint-staged), environment-driven
`baseURL`, a setup project with `storageState` to avoid signing in through the UI in every
test, accessibility checks with `@axe-core/playwright`, an API-request layer, CI sharding
with merged blob reports, and failure triage annotations.

## Portfolio context

Public sample by [NuRNYC](https://github.com/NuRNYC), demonstrating relevant QE architecture patterns; not a representation of a specific employer's proprietary framework.
