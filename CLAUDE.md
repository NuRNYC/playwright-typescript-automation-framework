# CLAUDE.md

Instructions for AI assistants working in this repository. Human contributors
can read it as a summary of the project's conventions.

## Commands

`npm run verify` (typecheck, lint, format, unit; 87 unit tests) · `npm test` (18
executions: 11 browser-spec executions — including 2 Chromium-only accessibility
scans — plus 1 authentication setup execution and 6 browser-free API executions)

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
