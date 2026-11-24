# Playwright + TypeScript Automation Framework

[![Playwright UI Tests](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/workflows/tests.yml)

A **public, independently authored demonstration framework** showcasing maintainable UI test automation and practical SDET patterns. It uses the public [Sauce Demo](https://www.saucedemo.com/) sample site; it does **not** contain employer code.

## What it demonstrates

- Page Object Model with dependency injection via Playwright [custom fixtures](src/fixtures/test.ts)
- Page objects with **no runtime dependency on the test runner** — specs own assertions, so the same classes can back API or accessibility suites later
- Test data typed by derivation (`as const satisfies`), so types cannot drift from values
- Chromium, Firefox and WebKit cross-browser execution
- Type-aware ESLint (including `no-floating-promises`) plus Prettier, enforced in CI
- Dependency-free configuration unit tests via Node's built-in `node:test`, kept separate
  from the browser suite
- Retries in CI, screenshots/traces on failure and HTML reporting
- GitHub Actions pipeline with reproducible installs, a scoped token and an uploaded report

## Run locally

Requires Node.js 24+ (see `.nvmrc`) and internet connectivity to install dependencies and access Sauce Demo.

```bash
npm ci
npx playwright install
npm run verify      # typecheck + lint + format check + unit tests
npm test
npm run test:report
```

| Command                           | Purpose                                          |
| --------------------------------- | ------------------------------------------------ |
| `npm run verify`                  | typecheck, lint, format check **and** unit tests |
| `npm run test:unit`               | config, session, a11y and API-layer unit tests   |
| `npm run lint` / `lint:fix`       | ESLint (warnings are failures)                   |
| `npm run format` / `format:check` | Prettier write / verify                          |
| `npm test`                        | full three-browser suite, plus the auth setup    |
| `npm run test:smoke`              | `@smoke`-tagged tests only                       |
| `npm run test:ui` / `test:debug`  | interactive UI mode / step debugger              |

### Two test suites

|          | Unit tests                     | Browser tests                    |
| -------- | ------------------------------ | -------------------------------- |
| Command  | `npm run test:unit`            | `npm test`                       |
| Runner   | Node's built-in `node:test`    | Playwright                       |
| Location | `src/**/*.test.ts` (colocated) | `tests/**`                       |
| Needs    | nothing                        | browsers + network               |
| Speed    | ~0.3s                          | ~10s                             |
| Answers  | "is our logic correct?"        | "does the app behave correctly?" |

The two counts are kept separate. Unit tests live under `src/`, which is outside
Playwright's `testDir`, so they are never discovered by it — `npm test` reports the browser
tests plus one authentication setup execution, and nothing else. See
[ADR-0002](docs/adr/0002-configuration-unit-tests.md), which also records why Node's runner
cannot currently unit-test page objects.

### Authentication and projects

Tests start **logged out**. A spec that needs a signed-in user lives under
`tests/ui/authenticated/` and opts in with `test.use({ authenticatedAs: 'standard' })`.
A `setup` project signs in once per run through the real login form and saves a
cookie-only session to `playwright/.auth/` (Git-ignored). See
[ADR-0003](docs/adr/0003-authentication-storage-state.md).

| Project                                                                   | Runs                          | Depends on `setup` |
| ------------------------------------------------------------------------- | ----------------------------- | ------------------ |
| `setup`                                                                   | `tests/auth.setup.ts`, once   | —                  |
| `chromium`, `firefox`, `webkit`                                           | public specs, e.g. login form | no                 |
| `chromium-authenticated`, `firefox-authenticated`, `webkit-authenticated` | `tests/ui/authenticated/**`   | yes                |

`npm test` runs 12 executions: 1 setup, 6 login-form, 3 cart, and 2 accessibility scans
(Chromium only). If setup fails, the login-form tests and the login scan still run, and
the authenticated tests are reported as "did not run".

### API request layer

A typed API client ([ADR-0006](docs/adr/0006-api-request-layer.md)) runs in a
browser-free `api` project against an **in-process synthetic stub** that a worker fixture
starts on `127.0.0.1` with an OS-assigned port — Sauce Demo has no server-side API.
Specs use the `apiClient` fixture and assert on a discriminated `ApiResult`; they never
build URLs. Paths are allow-listed, redirects are refused, and responses are validated
by hand-written guards. This proves the layer, not a real production API.

### Accessibility checks

An automated accessibility regression gate scans the login and inventory pages with
[`@axe-core/playwright`](https://github.com/dequelabs/axe-core-npm) against the WCAG
2.0–2.2 A/AA rule tags, in Chromium only. Any confirmed violation fails; `incomplete`
findings are reported for manual review but never fail. Exceptions are typed,
page-specific and expiring, and the list starts empty. Each scan attaches an allow-listed
summary — no HTML or selectors. This is a regression check, not a WCAG conformance claim.
See [ADR-0004](docs/adr/0004-accessibility-checks.md).

Run one browser's public specs: `npx playwright test --project=chromium`. Both groups in
one browser: `npx playwright test --project='chromium*'`. `--no-deps` skips setup; an
authenticated test then fails with an explicit message if the saved session is missing
or about to expire. Saved authentication is verified for Sauce Demo only and fails
closed for any other target or host.

## Environment configuration

A fresh clone needs **no configuration** — it targets the public Sauce Demo site.

| Variable                  | Required                                   | Values                                          | Default                  |
| ------------------------- | ------------------------------------------ | ----------------------------------------------- | ------------------------ |
| `APP_TARGET`              | no                                         | `saucedemo` \| `staging` \| `production`        | `saucedemo`              |
| `BASE_URL`                | only for `staging` / `production`          | absolute http(s) URL                            | from the target registry |
| `CI`                      | no (set by the CI provider)                | `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off` | `local`                  |
| `ALLOW_RESTRICTED_TARGET` | only for `staging` / `production`, locally | exactly the target name                         | unset                    |

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
`APP_TARGET` and is never inferred from the URL. For the public demo, an override must
still be the exact registered origin (`https://www.saucedemo.com`, no credentials, query
or fragment); any other host fails, so a real deployment can never run under demo rules.

### Restricted targets (`staging`, `production`)

A fail-closed boundary checks every run before any browser starts
([ADR-0005](docs/adr/0005-recording-and-execution-boundary.md)):

- Refused whenever a CI marker (`CI`, `GITHUB_ACTIONS`) is present.
- Locally, requires `ALLOW_RESTRICTED_TARGET` equal to the target name — an
  acknowledgment, not authentication.
- Only a plain `npx playwright test` is allowed: UI mode, debug mode, the test server
  (IDE), `--reporter`, `--add-reporter`, `--trace`, `--headed` and `-c` are refused.
- Recording is off (trace, screenshot, video) and only the `list` reporter runs.

These controls reduce what is recorded; they do not make a target safe to test with real
credentials. Console failure output and local `error-context.md` can still contain
asserted values.

Credentials are deliberately **not** part of this contract; the configuration object holds
none. See [`docs/security-testing-policy.md`](docs/security-testing-policy.md) and
[ADR-0001](docs/adr/0001-typed-environment-configuration.md).

## Repository structure

```text
src/
  pages/           Page objects (state and actions; no assertions)
  fixtures/        Playwright test.extend fixtures — the DI seam
  data/            Typed static test data
  config/          Validated typed config (env.ts pure core + index.ts singleton)
  auth/            Saved-session policy and validation (pure, unit-tested)
  a11y/            Accessibility gate policy and exceptions (pure, unit-tested)
  api/             API contract, request confinement, client and synthetic stub
tests/
  auth.setup.ts    Signs in once per run; writes the cookie-only session
  ui/              Logged-out UI tests (login form, login accessibility scan)
    authenticated/ Specs that opt in to the saved session
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

Planned, **not** implemented: pre-commit hooks (husky + lint-staged), CI sharding with merged blob reports,
and failure triage annotations.

## Portfolio context

Public sample by [NuRNYC](https://github.com/NuRNYC), demonstrating relevant QE architecture patterns; not a representation of a specific employer's proprietary framework.
