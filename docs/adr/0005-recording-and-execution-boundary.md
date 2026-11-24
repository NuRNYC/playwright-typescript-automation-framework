# ADR-0005: Fail-closed execution and recording boundary for restricted targets

- **Status:** accepted
- **Date:** 2026-11-24
- **Scope:** Post-M4 security hardening. Amends
  [ADR-0001](0001-typed-environment-configuration.md) (public-demo origin
  validation). Builds on [ADR-0003](0003-authentication-storage-state.md) and
  [ADR-0004](0004-accessibility-checks.md).

## Context

Measured with Playwright 1.64.1 (synthetic values only), a value typed into a
form can reach these surfaces:

| #   | Surface                                                     | When                                                 | Published by this repository's CI?         |
| --- | ----------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| S1  | HTML report step titles (`Fill "<value>"`)                  | every run: `fill`, `pressSequentially`, `insertText` | yes (measured in a real passing artifact)  |
| S2  | Trace action parameters and logs                            | a trace is kept                                      | yes, failing traces ship inside the report |
| S3  | Trace DOM snapshots (`value` attribute)                     | a trace is kept, any entry method                    | yes, inside the report                     |
| S4  | Failure messages (`Received`, call log, `error-context.md`) | an assertion fails on or near the field              | yes: report **and the public CI log**      |
| S5  | Screenshots                                                 | any non-password field                               | yes, inside the report                     |
| S6  | Trace network log                                           | a real login sends a request                         | yes, inside the report                     |
| S7  | Accessibility attachments                                   | never (allow-listed, ADR-0004)                       | no                                         |

`fill()` has no masking option, and automatic screenshots cannot mask.
Wrapping a `fill()` in a boxed `test.step` does not hide its title.

This is acceptable only because every value in play is Sauce Demo's public
demo data (security policy rule 1). Two gaps would let a real target slip past
that rule by accident:

1. **Classification.** The tier came only from `APP_TARGET`, which defaults to
   `saucedemo`. `BASE_URL=https://real.example` alone therefore resolved as
   `public-demo` and ran under demo recording and CI rules.
2. **Execution.** Nothing stopped a restricted target from running in public
   CI, or with HTML reporting, traces or debug modes switched on.

## Decision

### Two checkpoints, both before any browser

| Checkpoint                 | Where                                                                              | Sees                                                  | Rules                        |
| -------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| **A** — configuration load | `src/config/index.ts` (import side effect), in every process that loads the config | resolved config, `process.argv`, environment snapshot | I1, I2, I3, I4, I5a, I9, I10 |
| **B** — global setup       | `src/config/global-setup.ts`                                                       | the effective `FullConfig`, after CLI overrides       | I5b                          |

Verified: global setup runs before any project, setup test, worker or browser,
and a refusal in either checkpoint starts no worker. Global setup does **not**
run at UI-mode or test-server startup, which is why checkpoint A refuses those
launch modes outright rather than relying on B.

### Rules

| Rule | Statement                                                                                                                                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1   | An unknown `APP_TARGET` never resolves (unchanged).                                                                                                                                                                                                                                                      |
| I2   | A `public-demo` run's base URL must be `https:`, carry no credentials, query or fragment, and have an origin **exactly equal** to a registered public origin. Errors never echo the URL. The URL still never assigns a tier; it can only disqualify the demo classification.                             |
| I3   | A restricted tier never runs when a CI marker is present: `CI` (parsed) or a non-empty `GITHUB_ACTIONS`. Checked before I4, so no acknowledgment overrides it.                                                                                                                                           |
| I4   | A restricted tier needs `ALLOW_RESTRICTED_TARGET` equal to the target name exactly (case-sensitive, untrimmed). **An acknowledgment, not authentication.**                                                                                                                                               |
| I5a  | A restricted target loads only in a plain `playwright test` process with allow-listed options. UI mode, `--ui-host/--ui-port`, `--debug`, `PWDEBUG`, `--reporter`, `--add-reporter`, `PW_TEST_REPORTER`, `--trace`, `--headed`, `-c/--config`, the test server and any unknown launch shape are refused. |
| I5b  | For restricted tiers, the effective reporters must be exactly `[list]`, every project's trace, screenshot and video must be `off`, headed mode and `PWDEBUG` are refused.                                                                                                                                |
| I6   | Recording is decided only by tier (`recordingPolicy`).                                                                                                                                                                                                                                                   |
| I7   | Public-demo settings are exactly the pre-ADR-0005 ones: trace `retain-on-failure`, screenshot `only-on-failure`, video unset, reporters `list` + `html`.                                                                                                                                                 |
| I8   | The authentication fixtures and `src/auth/*` are unchanged.                                                                                                                                                                                                                                              |
| I9   | The registry type requires `publicOrigins` for every `public-demo` entry and forbids a default URL for restricted entries.                                                                                                                                                                               |
| I10  | `ALLOW_RESTRICTED_TARGET` set while the target is a public demo is refused.                                                                                                                                                                                                                              |

### Process classification by argv, not `TEST_WORKER_INDEX`

Checkpoint A runs in the CLI process, every worker, and UI loader processes.
Workers are recognised by Playwright's worker entry file
(`…/playwright/lib/worker/workerProcessEntry.js`), which an environment
variable cannot fake. `TEST_WORKER_INDEX` was **verified spoofable**: set in
the parent environment, the CLI process sees it too. Workers skip only the
launch-shape check, because they are spawned only after the CLI process passed
A and B; all other rules still run in them.

### Recording policy

| Setting    | Public demo (unchanged)          | Restricted |
| ---------- | -------------------------------- | ---------- |
| trace      | `retain-on-failure`              | `off`      |
| screenshot | `only-on-failure`                | `off`      |
| video      | unset (Playwright default)       | `off`      |
| reporter   | `list`, `html` (`open: 'never'`) | `list`     |

These settings reduce what is recorded. **They do not prevent exposure**: the
`list` reporter prints failure messages (S4), and a failing test still writes
`error-context.md` locally (verified with a synthetic value).

## Verification (isolated copy, synthetic targets and values)

- Public demo: effective trace, screenshot, video and reporters identical to
  `main`; `--list` identical; `npm test` 12 passed.
- Refused at A before any test: unregistered demo origin, leftover
  acknowledgment, unknown target; restricted target with `CI=true` or
  `GITHUB_ACTIONS=true` (even with a matching acknowledgment), missing or
  mismatched acknowledgment, `--ui`, `--ui-host/--ui-port`, `--debug`,
  `PWDEBUG`, `--reporter=html`, `--add-reporter=html`, `--trace=on`,
  `--headed`, `-c`, `PW_TEST_REPORTER`, and a spoofed `TEST_WORKER_INDEX`.
- Test server (the IDE path), driven by a synthetic client: refused when the
  config loads; a public-demo control run passes through the same client.
- Checkpoint B on its own (A removed in a test-only copy) refuses
  `--reporter=html`, `--add-reporter=html`, `--trace=on` and `--headed`.
- Permitted restricted run (plain CLI, acknowledgment, no-op spec using
  `setContent`): passes with trace, screenshot and video `off`, reporter
  `list`, and no HTML report, trace or screenshot.

## Consequences

- No behaviour change for Sauce Demo; 12 Playwright executions.
- Restricted targets are **local-only** and non-interactive: no UI mode, no
  debug mode, no HTML report. Enabling CI for them needs a private runner and a
  new ADR.
- Three ADR-0001 unit tests changed their expected behaviour (see the
  amendment note there).

## Limitations

1. A safety rail, not a sandbox or authentication: anyone who can edit the
   code, the workflow or the environment can get past it.
2. CI markers are heuristics that only add refusals; an unrecognised CI relies
   on the absent acknowledgment.
3. The UI-loader and worker classifications rely on argv shapes measured in
   Playwright 1.64.1; re-verify on upgrade.
4. Checkpoint B cannot stop an unsafe reporter that is already configured from
   writing its own error report (observed with A removed); A prevents that
   configuration from being reached.
5. Redirects to unregistered origins happen at navigation time and are not
   checked.
6. Console failure text and local `error-context.md` still contain asserted
   values.
7. The target application's own telemetry is outside Playwright's control.

## Alternatives considered

| Alternative                                      | Why not                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Documentation only                               | Leaves both gaps open                                                                        |
| Infer tier from the URL                          | Violates ADR-0001: the URL is operator intent, not evidence                                  |
| Check only in `playwright.config.ts`             | Cannot see CLI overrides (measured)                                                          |
| Check only in global setup                       | Does not run in UI mode or at test-server startup (measured)                                 |
| Deny-list of flags                               | Allows unknown launch modes; the loader and test-server processes carry no identifying flags |
| Trust `TEST_WORKER_INDEX`                        | Spoofable (measured)                                                                         |
| Redact reports before upload                     | Fragile across encodings; cannot clean images                                                |
| Allow restricted targets in CI behind a variable | Environment variables do not prove a runner is private                                       |

## Deferred

API or token authentication for real targets; a private-runner design; an
artifact canary scan; a lint rule against asserting on secret fields; a
navigation-time origin guard.

## Related

- [`docs/security-testing-policy.md`](../security-testing-policy.md)
- `src/config/security.ts`, `src/config/global-setup.ts`, `src/config/env.ts`
