# Security Testing Policy

How this framework handles credentials and the artifacts a test run produces.

This repository is **public**, and its CI workflow uploads the Playwright
report as an artifact on every run (`if: always()`). Anyone can download it.
That single fact drives everything below.

## The finding that motivated this policy

Playwright traces record the arguments of every action, including the text
passed to `fill()`. This was verified rather than assumed, by running the
suite with tracing forced on and searching the resulting archive:

```bash
npx playwright test --trace on --project=chromium tests/ui/login.spec.ts
unzip -o -q test-results/<dir>/trace.zip -d /tmp/tr
grep -rho 'secret_sauce' /tmp/tr | wc -l      # -> 9
```

The password appeared **nine times in cleartext**, in `1-trace.trace` and
`test.trace`.

This is harmless today, and only today: those are Sauce Demo's own published
demo credentials, documented as such in `src/data/users.ts`. It would not be
harmless for a real secret.

## Exposure surface

| Vector                    | What it can expose                                                                                     | Current setting         |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------- |
| Report step titles (S1)   | `fill()`, `pressSequentially()` and `keyboard.insertText()` values, **on every run**                   | always (HTML report)    |
| Failure messages (S4)     | `Received` values and the element snapshot (`value="…"`) in the console, report and `error-context.md` | on failure              |
| Trace — action parameters | `fill()` values verbatim                                                                               | `retain-on-failure`     |
| Trace — DOM snapshots     | Input `value` attributes                                                                               | `retain-on-failure`     |
| Trace — network log       | Request bodies; a real login `POST` carries credentials (Sauce Demo's login sends none)                | `retain-on-failure`     |
| Trace — context options   | A restored `storageState`, including session cookie values                                             | `retain-on-failure`     |
| Saved session file        | The session cookie, usable by whoever holds the file                                                   | Git-ignored, `0600`     |
| Screenshots               | Password fields render masked, but usernames, tokens in URLs and session state do not                  | `only-on-failure`       |
| Video                     | Equivalent to screenshots, continuously                                                                | not enabled             |
| Accessibility summaries   | Rule ids, impacts, counts per scanned page — allow-listed, no HTML or selectors                        | attached to every scan  |
| HTML report               | Embeds screenshots and **bundles failing tests' traces**                                               | always produced         |
| CI artifacts              | All of the above, 7-day retention, public repository                                                   | uploaded `if: always()` |
| Process logs              | Whatever the framework prints                                                                          | allow-listed, see below |

**Disabling tracing for an authentication setup step is not sufficient.** The
login request appears in the network log of _any_ traced test that
authenticates, and DOM snapshots carry field values independently of the
action log. Trace configuration is one control among several, not the control.

## Rules

1. **No real credentials in this repository or its CI, ever.** Only Sauce
   Demo's published demo values. A non-public target must be exercised from a
   private pipeline with its own secret store. This is the primary control;
   every rule below is defence in depth behind it.

2. **The configuration object holds no credentials.** `TestConfig` in
   `src/config/env.ts` carries `target`, `tier`, `baseURL`, `baseURLSource`
   and `execution` — nothing else. It cannot leak what it does not hold.

3. **Logging is allow-listed, never serialised.** The startup banner is built
   from an explicit list of fields, so a field added later cannot begin
   appearing in logs by accident. `process.env` is never printed wholesale.

4. **URLs are reduced before display.** `redactBaseURL()` returns
   `origin + pathname`. Because `URL.origin` is protocol, host and port only,
   any embedded `user:password@` is dropped by construction rather than by a
   regular expression. The query string and fragment are dropped too, as both
   routinely carry tokens and session identifiers.

5. **Current artifact retention is acceptable only while rule 1 holds.**
   `trace: 'retain-on-failure'` and `screenshot: 'only-on-failure'` stay as
   they are, because the credentials in play are public. If that stops being
   true, this setting must change in the same commit.

6. **When a real credential is first introduced**, all of the following apply:
   - tracing off wherever credentials are entered;
   - `mask` configured for screenshots over sensitive regions;
   - secrets supplied from a secret store, never a file in the repository;
   - a private runner considered, since artifacts inherit repository visibility;
   - the verification below re-run to confirm absence.

7. **Verification is a repeatable check, not a one-off.** Before trusting that
   an artifact is clean, extract it and search for the secret:

   ```bash
   unzip -o -q path/to/trace.zip -d /tmp/trace-check
   grep -rn '<the-secret>' /tmp/trace-check && echo "LEAK" || echo "clean"
   rm -rf /tmp/trace-check
   ```

   Absence of a finding is only meaningful if the search was actually run.

## Saved authentication state

M3b ([ADR-0003](adr/0003-authentication-storage-state.md)) signs in once per
run in the `setup` project and saves the session for specs that opt in with
`authenticatedAs`. That file is a credential: whoever holds it is signed in.

1. **Location.** Only `playwright/.auth/`, which is Git-ignored. The file is
   regenerated on every run, written with mode `0600`, and never cached
   between CI jobs.
2. **Contents.** Exactly one allow-listed cookie and an empty `origins` array.
   Browser storage is never saved, so cart data and third-party telemetry
   identifiers cannot be carried into another test. `checkSavedSession`
   enforces this, and its unit tests prove it.
3. **Scope.** Saving and restoring fail closed unless `APP_TARGET=saucedemo`
   and the base URL's hostname is `www.saucedemo.com`.
4. **Never published.** The file is outside `playwright-report/`, the only CI
   artifact path, and is never attached to a report. Error messages name the
   rule that failed, never a cookie value.
5. **Traces still see the session.** A traced authenticated test records the
   restored `storageState` in its context options and the cookie in its
   network log. Measured: the session cookie name appears in every
   authenticated trace. With Sauce Demo the value is the public demo username.
   With a real target it would be a live session token, so rule 6 applies to
   the authenticated projects as well as to the setup project.

Measured with tracing forced on for the whole suite: the password appears 0
times in authenticated traces, 9 times in the setup trace and in each
valid-login trace, and once in each invalid-login trace (Sauce Demo prints the
demo password on its login page, so any snapshot of that page contains it).
No request or response body, including the Backtrace telemetry requests,
contained it.

## Accessibility scan results

M4 ([ADR-0004](adr/0004-accessibility-checks.md)) runs axe-core against the
login and inventory pages and attaches a summary of each scan to the report.

1. **Allow-listed, never serialised.** `toReportSummary` copies named fields
   only: page, axe-core version, tags, counts, rule ids, impacts, WCAG tags,
   node counts, help URLs, incomplete rule ids, excepted entries and gate
   failures. Raw `AxeResults`, nodes, HTML snippets, CSS selectors and
   `failureSummary` never leave memory. A unit test fails if any of those keys
   appears in a summary.
2. **No selectors.** Measured selectors included generated paths, which can
   encode page structure; the summary carries none, and exceptions are keyed
   by page and rule instead.
3. **Scan before typing.** Scans run after the page is ready and before any
   `fill()`, so no form value is in the DOM axe reads.
4. **Traces are not covered by the allow-list.** A failing accessibility test
   keeps its trace and screenshot like any other test, and traces contain full
   DOM snapshots. That is acceptable only while rule 1 holds.

Verified locally: both attachments contained only allow-listed keys and no
HTML, selectors, credentials or cookie names. A real failing CI run's artifact
has not yet been inspected for accessibility tests.

## Execution and recording boundary

[ADR-0005](adr/0005-recording-and-execution-boundary.md) adds a fail-closed
boundary so that a real target cannot run under public-demo rules by accident.

### Measured exposure surfaces (Playwright 1.64.1, synthetic values)

| #   | Surface                                   | Contains a typed value when                                |
| --- | ----------------------------------------- | ---------------------------------------------------------- |
| S1  | HTML report step titles                   | every run, for `fill` / `pressSequentially` / `insertText` |
| S2  | Trace action parameters and logs          | a trace is kept                                            |
| S3  | Trace DOM snapshots                       | a trace with snapshots is kept, any entry method           |
| S4  | Console, report error, `error-context.md` | an assertion fails on or near the field                    |
| S5  | Screenshots                               | any non-password field is visible                          |
| S6  | Trace network log                         | a real login sends a request                               |
| S7  | Accessibility attachments                 | never (allow-listed)                                       |

Playwright has **no masking** for `fill()` values or automatic screenshots,
and a boxed `test.step` does not hide the inner step title. Failing tests'
traces travel inside the uploaded HTML report.

### Rules enforced in code

- **Public demo origin.** `APP_TARGET=saucedemo` accepts only
  `https://www.saucedemo.com` — exact origin, no credentials, query or
  fragment. Any other host fails, without echoing the URL.
- **No restricted target in CI.** `staging` and `production` are refused when
  `CI` or `GITHUB_ACTIONS` is set, whatever else is configured.
- **Explicit local acknowledgment.** Locally they require
  `ALLOW_RESTRICTED_TARGET` equal to the target name. Setting it on a demo run
  fails.
- **Plain CLI only.** Restricted runs refuse UI mode, `--ui-host/--ui-port`,
  `--debug`/`PWDEBUG`, `--reporter`, `--add-reporter`, `PW_TEST_REPORTER`,
  `--trace`, `--headed`, `-c`, the test server (IDE path) and unknown launch
  shapes — checked when the configuration loads, before any browser.
- **Recording off.** Restricted runs use trace, screenshot and video `off` and
  the `list` reporter only; global setup re-checks the effective configuration.

### Prevention versus access control

These are **preventive** controls: they stop recording and stop restricted runs
reaching public CI. They are not access control. Who can read an artifact or a
CI log is decided by repository visibility and runner choice; for a real
target, both must be private — a decision this repository has not taken.

### Known limitations

- **Console and `error-context.md`.** A failing assertion on a field prints its
  value to the console and writes it to `error-context.md`, even with recording
  off (verified). Never assert on a secret field's value; delete `test-results/`
  after a local restricted run.
- **CI markers are heuristics.** Environment variables cannot prove a runner is
  private. They only add refusals; an unrecognised CI is still refused because
  no acknowledgment is set there.
- **The acknowledgment is not authentication.** It records a deliberate
  operator choice; anyone who can set environment variables can set it.
- **Redirects and navigation.** Origin validation applies to the configured
  base URL only. A redirect to another origin during a test is not checked.
- **IDE and test server.** Refused when the configuration loads (verified with
  a synthetic client). The detection relies on process shapes measured in
  Playwright 1.64.1 and must be re-verified on upgrade.
- **Third-party scripts** on a real target, such as error reporters, can
  capture typed values; Playwright settings do not reach them.

### Real-credential restrictions

Rule 1 still applies: no real credentials in this repository or its CI. These
controls **do not certify any target as safe for production testing**. Before a
real credential is used, all of the following are required: a private runner
and private artifacts; API or token authentication instead of typing into the
form where possible; no assertions on secret fields; and the verification in
rule 7 re-run against the actual outputs.

## Current status

| Item                                    | State                                              |
| --------------------------------------- | -------------------------------------------------- |
| Credentials in use                      | Sauce Demo public demo values only                 |
| Credentials in configuration object     | none                                               |
| Credentials in traces                   | setup and login-form traces only; public values    |
| Session state in traces                 | authenticated traces; public demo username         |
| Saved session file                      | `playwright/.auth/`, Git-ignored, never uploaded   |
| Accessibility attachments               | allow-listed summaries only; no HTML or selectors  |
| Restricted targets                      | refused in CI; local plain CLI only, recording off |
| Real secrets anywhere in the repository | none                                               |
| Artifact visibility                     | public, 7-day retention                            |

M3a did not reduce the trace exposure, because all three specs still typed
credentials into the login form. M3b reduces it: only the setup project and
the login-form tests type them, and the authenticated tests restore a saved
session instead. That is a reduction, not a removal, and the authenticated
traces now carry session state. The control that makes this safe is still
rule 1, not the trace configuration.
