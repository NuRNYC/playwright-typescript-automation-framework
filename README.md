# Playwright + TypeScript Automation Framework

[![Playwright UI Tests](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/workflows/tests.yml)

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

## Environment configuration

A fresh clone needs **no configuration** — it targets the public Sauce Demo site.

| Variable     | Required                          | Values                                          | Default                  |
| ------------ | --------------------------------- | ----------------------------------------------- | ------------------------ |
| `APP_TARGET` | no                                | `saucedemo` \| `staging` \| `production`        | `saucedemo`              |
| `BASE_URL`   | only for `staging` / `production` | absolute http(s) URL                            | from the target registry |
| `CI`         | no (set by the CI provider)       | `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off` | `local`                  |

```bash
npm test                                                   # Sauce Demo, zero config
APP_TARGET=staging BASE_URL=https://staging.example.com npm test
```

> **`.env` is not loaded.** `.env.example` documents the contract, but there is no
> `dotenv` dependency — copying it to `.env` has **no effect**. Pass variables via your
> shell or CI provider. A loader will be added if the variable count grows.

Invalid configuration fails **before any browser starts**: an unknown `APP_TARGET`, a
malformed `BASE_URL`, or a `staging`/`production` target with no `BASE_URL` all exit
non-zero with a message naming the problem. `staging` and `production` have no default
URL by design, so they can never silently fall back to the demo site.

Every run prints an allow-listed banner stating what it actually tested:

```text
[config] target=saucedemo tier=public-demo baseURL=https://www.saucedemo.com/ baseURLSource=registry execution=local
```

The displayed URL is reduced to origin plus path, so credentials, query strings and
fragments can never appear in logs.

`baseURLSource=override` indicates `BASE_URL` was supplied. An override records operator
intent — it is not evidence about what is deployed there, so `tier` always comes from
`APP_TARGET` and is never inferred from the URL.

Credentials are deliberately **not** part of this contract; the configuration object holds
none. See [`docs/security-testing-policy.md`](docs/security-testing-policy.md) and
[ADR-0001](docs/adr/0001-typed-environment-configuration.md).

## Repository structure

```text
src/
  pages/           Page objects (state and actions; no assertions)
  fixtures/        Playwright test.extend fixtures — the DI seam
  data/            Typed static test data
  config/          Validated, typed environment configuration
tests/
  ui/              Functional / negative UI tests
docs/
  adr/             Architecture decision records
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

Planned, **not** implemented: a setup project with `storageState` to avoid signing in
through the UI in every test, permanent configuration unit tests, pre-commit hooks
(husky + lint-staged), accessibility checks with `@axe-core/playwright`, an API-request
layer, CI sharding with merged blob reports, and failure triage annotations.

## Portfolio context

Public sample by [NuRNYC](https://github.com/NuRNYC), demonstrating relevant QE architecture patterns; not a representation of a specific employer's proprietary framework.
