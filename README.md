# Playwright + TypeScript Automation Framework

[![Playwright UI Tests](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/workflows/tests.yml)

A **public, independently authored demonstration framework** showcasing maintainable UI test automation and practical SDET patterns. It uses the public [Sauce Demo](https://www.saucedemo.com/) sample site; it does **not** contain employer code.

## What it demonstrates

- Page Object Model with dependency injection via Playwright [custom fixtures](src/fixtures/test.ts)
- Page objects with **no runtime dependency on the test runner** — specs own assertions, so the same classes can back API or accessibility suites later
- Test data typed by derivation (`as const satisfies`), so types cannot drift from values
- Chromium, Firefox and WebKit cross-browser execution
- Type-aware ESLint (including `no-floating-promises`) plus Prettier, enforced in CI
- Dependency-free unit tests via Node's built-in `node:test` for configuration, session,
  accessibility, API, CI and reporting logic, kept separate from the browser suite
- Retries in CI, screenshots/traces on failure and HTML reporting
- GitHub Actions pipeline with reproducible installs, a scoped token and an uploaded report
- GitHub Actions sharding: two Playwright shards, verified blob reports merged into one HTML
  report, and a required `test` job whose eight-input Gate fails on any failed, skipped or
  incomplete step
- Evidence-based Gate verdict reconciliation: a local, read-only operator reconciles a run's
  Gate verdict from attempt-specific GitHub evidence under an explicit trust policy
  ([ADR-0010](docs/adr/0010-quality-verdict-provenance.md))
- Summary and reporting validation: an allow-listed, metadata-only quality summary and a static,
  offline dashboard that validates it strictly ([ADR-0009](docs/adr/0009-quality-reporting-dashboard.md))
- Trusted publication manifest generation: a controlled local publisher re-verifies allow-listed
  runs and writes a deterministic, sanitized manifest
  ([ADR-0011](docs/adr/0011-verdict-evidence-publication.md)). The dashboard build can embed one
  such generation, pinned by its SHA-256 and bound to the exact checkout commit; it is **not
  deployed** — see [Quality dashboard](#quality-dashboard)
- Synthetic demonstration mode and mandatory build-output security scanning for the static
  dashboard ([ADR-0011](docs/adr/0011-verdict-evidence-publication.md))
- Synthetic security and regression testing: fake HTTP evidence, temporary filesystems, secret
  canaries and forged-input cases; no real tokens or CI artifacts in tests

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
| `npm run test:unit`               | all `node:test` unit tests under `src/`          |
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

Observed baseline on 2026-11-26 (commit `7adb2aaf`), not a fixed invariant:
`npm run test:unit` ran 733 unit tests, and `npx playwright test --list` listed 64
executions — 1 setup, 6 login-form, 3 cart, 2 page accessibility scans (Chromium only),
36 dashboard (three browsers), 10 dashboard accessibility (Chromium only) and 6 browser-free
API executions. If setup fails, the login-form tests and the login scan still run, and the
authenticated tests are reported as "did not run".

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

## Quality dashboard

A static, offline dashboard ([ADR-0009](docs/adr/0009-quality-reporting-dashboard.md),
[ADR-0011](docs/adr/0011-verdict-evidence-publication.md)) built to a new directory outside the
repository. Each build is in exactly one mode:

| Mode     | Command                                                                           | Shows                                                                                                     |
| -------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| picker   | `node scripts/build-dashboard.ts [--out <absolute-new-directory>]`                | Only a summary file the user picks in the browser (labelled not authenticated)                            |
| embedded | `... --publication <absolute-generation-directory> --publication-sha256 <64-hex>` | One trusted publisher generation, accepted only with its SHA-256 pin, the committed trust policy and HEAD |
| demo     | `node scripts/build-dashboard.ts --demo --out <absolute-new-output-directory>`    | Six fixed, fictional scenarios under a permanent "SYNTHETIC DEMONSTRATION DATA" banner                    |

- The file picker is available in every mode and imported files are never authenticated.
- Embedded mode also requires a clean checkout; the publication's source commit must equal HEAD
  exactly.
- `--demo` contains fictional evidence only. It needs no GitHub Actions evidence, token, git
  history or publisher, and it can never be combined with the publication options (usage
  error).
- Every build runs the build-output scanner twice: over the complete in-memory output before
  the directory is created, and over the written directory before success is reported. A
  rejection exits non-zero with `output-scan-rejected`; a rejection after writing leaves the
  directory in place, and it must not be used.
- The standalone scanner checks an existing build read-only:

  ```bash
  node scripts/scan-build-output.ts --dir <absolute-built-output-directory>
  ```

- A clean scan means the output has the committed shape and no known leakage markers. It is
  **not** proof that a publication came from the trusted publisher; that comes only from the
  embedded build's pinned-generation, policy and source-commit checks.
- Serve a build only from a loopback static server for local review. Public hosting is not
  authorized.

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
  ci/              Blob-report completeness and failure-triage policies (pure, unit-tested)
  reporting/       Quality summary, dashboard model, verdict reconciliation, bundles,
                   publication manifest and publisher (unit-tested with synthetic data)
dashboard/         Static offline dashboard source (built outside the repository)
scripts/
  verify-blob-reports.ts    Checks downloaded shard blob reports before merging
  triage-report.ts          Publishes allow-listed failure triage to the CI summary
  quality-summary.ts        Writes the allow-listed quality summary (advisory CI step)
  verify-quality-verdict.ts Local read-only verdict operator (M8E-4)
  build-dashboard.ts        Builds the static dashboard to a new directory outside the repo
  scan-build-output.ts      Read-only security scan of one built dashboard directory
  build-publication.ts      Local trusted publisher; writes a private manifest generation
tests/
  auth.setup.ts    Signs in once per run; writes the cookie-only session
  ui/              Logged-out UI tests (login form and scan; dashboard functional and a11y)
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

## Continuous integration

Three jobs ([ADR-0007](docs/adr/0007-ci-sharding-and-merged-reports.md)):

| Job      | Does                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| `checks` | typecheck, lint, format check and unit tests, once, before any browser download                   |
| `shard`  | two matrix shards, `npm test -- --shard=i/2 --reporter=list,blob`; one blob artifact each (1 day) |
| `test`   | the required check: verifies and merges the blobs, uploads `playwright-report` (7 days), gates    |

The gate passes only when the static checks, both shards and every report step succeeded;
a skipped or incomplete step fails it, and a successful merge is never taken as a test
result. Sharding is a **scaling capability**: at the current suite size it makes CI slower,
because each shard installs the browsers again. Shard totals count executions, not logical
tests — the authentication setup runs once in every shard that needs it.

After merging, an advisory triage step ([ADR-0008](docs/adr/0008-failure-triage-annotations.md))
adds annotations for failed, timed-out and flaky tests and a job summary of counts. It uses
structured test statuses only — no error text, test titles or paths outside `tests/` — and is
not part of the gate.

## Next improvements

Planned, **not** implemented: pre-commit hooks (husky + lint-staged).

## Portfolio context

Public sample by [NuRNYC](https://github.com/NuRNYC), demonstrating relevant QE architecture patterns; not a representation of a specific employer's proprietary framework.
