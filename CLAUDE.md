# CLAUDE.md

Instructions for AI assistants working in this repository. Human contributors
can read it as a summary of the project's conventions.

## Commands

`npm run verify` (typecheck, lint, format, unit tests) · `npm test` (browser,
accessibility, dashboard and browser-free API specs plus one authentication setup
execution). Observed on 2026-11-26 at `7adb2aaf`: 733 unit tests and 64 listed
Playwright executions. Counts change with the code; report the numbers you
actually observe rather than these.
CI runs the suite as two shards and merges their blob reports; the required
`test` job is the gate (docs/adr/0007-ci-sharding-and-merged-reports.md);
its advisory triage step publishes allow-listed annotations only
(docs/adr/0008-failure-triage-annotations.md).
`npm run test:unit:structured` runs the same unit tests with the same output and
exit status and also writes aggregate counts to `unit-results/unit-results.json`;
CI uses it, and on push to `main` an advisory `health` job renders a test-health
job summary and artifact (docs/adr/0012-readme-test-automation-health.md).

## Architecture rules

- **TypeScript:** `strict` plus `noUncheckedIndexedAccess`. Derive types from
  data (`as const satisfies`) rather than writing a second list. Import via the
  `@/` alias, except in unit tests (below).
- **Playwright:** specs import `test` and `expect` from `@/fixtures/test`, never
  directly from `@playwright/test`. Use web-first `expect(locator)` assertions,
  or `expect.poll` for derived values. Do not weaken `no-floating-promises`.
- **Fixtures:** new page objects or clients are exposed by extending the `Pages`
  interface in `src/fixtures/test.ts`, not constructed inside specs.
- **Page objects:** assertions live in specs. Page objects import Playwright
  types only (`import type`) and expose `Locator` fields and semantic getters.
- **Configuration:** `process.env` app config is read only in
  `src/config/index.ts`; `env.ts` stays pure. Unit tests import `./env.ts` with
  an extension; no `@/` alias there.
- **Environment access outside `src/config/index.ts`** is limited to these
  committed, documented entry-point exceptions. Each reads only what is listed
  and hands values to a pure module; library modules under `src/` never read
  `process.env` themselves, and this is not a general exception:
  - `playwright.config.ts` checks only whether `TEST_WORKER_INDEX` is set (main
    process detection for the configuration banner).
  - `scripts/quality-summary.ts` (M8B) reads exactly `ENV_KEYS` from
    `src/reporting/quality-summary-cli.ts`, because it cannot load
    `src/config/index.ts` under Node's type-stripping loader.
  - `scripts/verify-quality-verdict.ts` (M8E-4) reads only
    `QUALITY_VERDICT_GITHUB_TOKEN`.
  - `scripts/build-publication.ts` (ADR-0011 P2) reads only
    `QUALITY_VERDICT_GITHUB_TOKEN` and checks the **presence** (never the value)
    of the `UNSAFE_ENVIRONMENT` names in `src/reporting/publication-publisher.ts`,
    refusing to run if any is set. Its git probe runs with a fixed minimal
    environment, not the caller's.

  A new exception needs an ADR or an amendment. Never print, log or store the
  token, and never accept it as an argument or from a file.

## Security and privacy

- No credentials in config, logs or the repo (docs/security-testing-policy.md).
- Never commit or quote execution artifacts (`test-results/`, traces, reports,
  `.env`); traces record `fill()` values in cleartext.
- No personal information, machine-specific paths or private notes in tracked
  files.

## Workflow

DISCOVER → TEACH → PROPOSE → APPROVE → IMPLEMENT → VALIDATE → EXPLAIN.
Do not implement before explicit approval, and do not treat one approval as
covering the next step.

## Verification

Run `npm run verify` and, where behaviour could change, `npm test` on Node 24.
Report actual results (commands, counts, exit codes), not expectations.

## Branches and pull requests

`main` is protected: changes land through a pull request with the required
`test` check green on an up-to-date branch. Never push to `main`, force-push,
or bypass protection. Do not merge a PR without the maintainer's explicit
approval.

## Documentation

Documented decisions go in docs/adr/ as numbered ADRs. Amend an accepted ADR
with a dated note referencing the newer ADR rather than rewriting its history.

## Personal context

If a `CLAUDE.local.md` exists, it may point to a profile file. Treat any
profile as background context only; this file and the user's explicit
instructions take precedence.
