# Security Testing Policy

How this framework handles credentials and the artifacts a test run produces.

This repository is **public**, and its CI workflow uploads the Playwright
report as an artifact on every run, plus one blob report per CI shard
([ADR-0007](adr/0007-ci-sharding-and-merged-reports.md)) and a metadata-only
quality summary ([ADR-0009](adr/0009-quality-reporting-dashboard.md)). Anyone
can download them. That single fact drives everything below.

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
| API requests (S8)         | Request headers and bodies in traces (action parameters, logs, network resources)                      | `retain-on-failure`     |
| HTML report               | Embeds screenshots and **bundles failing tests' traces**                                               | always produced         |
| CI artifacts              | All of the above, 7-day retention, public repository                                                   | uploaded `if: always()` |
| Shard blob reports        | Same attachments as the HTML report (S1–S8), plus absolute runner paths in `report.jsonl`              | 1-day retention         |
| CI git metadata (S9)      | Commit message, author and committer name and email, branch; on PRs the title and diff                 | every CI report         |
| CI annotations (S10)      | Allow-listed triage only: category, project, `tests/` path and line; no errors, titles or values       | every CI run, public    |
| Quality summary (S11)     | Allow-listed metadata only: run identity, branch class, statuses, counts, spec paths; no verdict       | 7-day retention, public |
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

| #   | Surface                                   | Contains a typed value when                                    |
| --- | ----------------------------------------- | -------------------------------------------------------------- |
| S1  | HTML report step titles                   | every run, for `fill` / `pressSequentially` / `insertText`     |
| S2  | Trace action parameters and logs          | a trace is kept                                                |
| S3  | Trace DOM snapshots                       | a trace with snapshots is kept, any entry method               |
| S4  | Console, report error, `error-context.md` | an assertion fails on or near the field                        |
| S5  | Screenshots                               | any non-password field is visible                              |
| S6  | Trace network log                         | a real login sends a request                                   |
| S7  | Accessibility attachments                 | never (allow-listed)                                           |
| S8  | API request headers and bodies in traces  | an API test keeps a trace (failing, or `--trace=on`)           |
| S9  | CI git metadata in report metadata        | every CI run (Playwright's `captureGitInfo` default)           |
| S10 | CI annotations and job summary            | never by design (allow-listed fields only, ADR-0008)           |
| S11 | Quality summary artifact                  | never by design (allow-listed fields only, ADR-0009, ADR-0010) |

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

### API request layer (S8)

Measured with a synthetic header and body ([ADR-0006](adr/0006-api-request-layer.md)):
`APIRequestContext` calls record request headers and bodies in traces — as
action parameters, in the action log and as recorded network resources — and
those traces are bundled into the HTML report. Report step titles show only the
HTTP method. A failing assertion that compares a response prints the received
value.

The API layer therefore sends **no credentials, tokens or Authorization
headers**: it talks only to an in-process synthetic stub on `127.0.0.1`, with
allow-listed paths and redirects refused. Any future authenticated API needs
its own ADR and must assume S8 applies.

### Sharded CI reports (S9)

Measured for [ADR-0007](adr/0007-ci-sharding-and-merged-reports.md):

- **Blob reports** hold `report.jsonl` (test events, step titles — S1 — and
  absolute runner paths) and, for failing tests, the same attachments the HTML
  report bundles: traces, `error-context.md`, screenshots (S2–S6, S8). Each
  shard uploads one, kept **1 day**; the merged `playwright-report` keeps the
  existing 7 days.
- **Git metadata (S9).** Under GitHub Actions, Playwright records commit
  subject and body, author and committer name and email, branch and CI links in
  every report; on pull requests also the PR title and the full diff.
  Inspected on the M5 artifacts: identities were GitHub noreply addresses only,
  the diff was the public pull request, and there were no home paths, runner
  paths, tokens or saved session state. `captureGitInfo` is unchanged. Revisit
  it if the repository becomes private, accepts fork pull requests, or commits
  stop using noreply addresses.
- **The merge job loads no configuration.** `merge-reports` without
  `-c`/`--config` never evaluates `playwright.config.ts`, so neither ADR-0005
  checkpoint runs there. This is acceptable only because merging runs no tests
  and contacts no target; it must never be given a configuration file.
- **The blob verifier never prints artifact content**: problems name a shard
  index and a fixed code only, and archives are listed and tested, never
  extracted.

### CI annotations and job summary (S10)

[ADR-0008](adr/0008-failure-triage-annotations.md) publishes failure triage as
GitHub annotations and a job summary. These are public on a public repository
and appear in the pull request, so they are **allow-listed, not redacted**:

- **Published:** a fixed category (`failed`, `timed-out`, `interrupted`,
  `unexpected-pass`, `unclassified`, `flaky`), a project from the fixed list
  of eight or `unrecognized-project`, the spec path validated as
  `tests/<path>.spec.ts` or `.setup.ts`, the declaration line, and counts.
- **Never published:** error messages, stack traces, Expected/Received values,
  test titles, stdout and stderr, attachments, request or response data, git
  metadata, report configuration or absolute paths. A location that does not
  validate is withheld.
- **Escaped:** every field is escaped for workflow commands, so `%`, newlines
  and `::` cannot inject commands.
- **Built-in `github` reporter:** stays disabled. Measured, it publishes raw
  error messages, values, code snippets and absolute paths.
- **The JSON report** that feeds triage is written to the runner's temporary
  directory, never printed and never uploaded. The merge step refuses to run
  without an output file, because the JSON reporter otherwise prints to
  stdout.

### Quality summary artifact (S11)

[ADR-0009](adr/0009-quality-reporting-dashboard.md) (M8D) publishes the output
of the quality-summary CLI; [ADR-0010](adr/0010-quality-verdict-provenance.md)
defines how it may be trusted. Publishing verdict evidence in the dashboard is
governed by [ADR-0011](adr/0011-verdict-evidence-publication.md) (2026-11-26):
only results a controlled publisher build re-verifies may be labelled
verified, local bundles and imported files are never authenticated, and no
token, signed URL, local path or raw bundle may appear in published assets.
Nothing is published; M8F is not authorized.

- **Name and retention.** `quality-summary-<run_attempt>`, one file
  (`quality-summary.json`), uploaded by exact path, **7 days**, public like
  every artifact of this repository.
- **Contents: sanitized, structured metadata only.** Schema 1.0.0, built field
  by field from validated values: run id and attempt, event, head SHA, branch
  _class_ (never the raw branch name), the eight observed Gate inputs, project
  names, validated `tests/` spec paths and lines, allow-listed tags, statuses,
  retry indices, durations and counts.
- **Never contained:** the raw Playwright report, test titles, error messages,
  stack traces, stdout or stderr, steps, attachments, traces, screenshots,
  cookies or saved authentication state, absolute paths, git metadata,
  environment values, and **no final CI verdict**
  (`ciVerdict: "not-recorded-in-summary"`). Canary unit tests (M8A, M8B) and the
  M8D probe scans (2026-11-26) found none of these in generated summaries.
- **Fork pull requests are excluded.** Both summary steps are skipped for pull
  requests from forks. This follows from the workflow condition; it has not
  been observed on a real fork (deferred probe P7).
- **Provenance is limited.** The summary is produced by the code that ran. On
  pull requests, including same-repository ones, that code and the workflow
  are the pull request's own, so a summary or a green Gate there proves
  nothing about the reviewed pipeline. Only `push` runs on protected `main`
  are eligible for a verified verdict (ADR-0010). The recorded SHA of a pull
  request run is the PR head, not the temporary merge commit that was tested.
- **Download needs authentication.** Listing artifacts works without a token;
  downloading one returned HTTP 401 without credentials (measured 2026-11-26).
  Retrieval is an operator action with the operator's own read-only token. No
  token is placed in browser code or in a dashboard build, and the dashboard
  makes no network requests (`connect-src 'none'`).
- **Fail closed.** A summary that is missing, expired, unbound to its run
  attempt, digest-mismatched or invalid is never shown as verified data, and
  its absence is never a passing result. The summary steps are advisory and
  cannot change the Gate.
- **Probe canaries are public elsewhere.** A synthetic canary placed in a
  deliberate probe test (M8D P1) appears in that run's public test log and in
  its `playwright-report`, because test titles, stdout and errors go there;
  the sanitized summary excludes it. Use only synthetic, unmistakably fake
  values in probes.

### Trusted publisher (ADR-0011 P2)

[ADR-0011](adr/0011-verdict-evidence-publication.md) (Model A, with its
2026-11-26 amendments) defines a local publisher,
`scripts/build-publication.ts` with `src/reporting/publication-publisher.ts`,
that re-verifies allow-listed runs and writes a sanitized publication
manifest. It is implemented (PR #36) but **not deployed, not wired into CI and
not integrated with the dashboard**. It is consistent with the ADR-0010 trust
policy: only `push` runs on `main` can carry a verified verdict.

- **Trusted publisher process.** The publisher machine, its OS user, the Node
  runtime and the dependency tree installed by `npm ci` from the lockfile are
  inside the trust boundary. In-process code could forge evidence; that and a
  dishonest publisher are accepted residual risks of Model A. Types, object
  identity or module-private markers are never used to authenticate evidence.
- **Dedicated read-only token.** `QUALITY_VERDICT_GITHUB_TOKEN`, a
  fine-grained token limited to this repository with read-only Actions,
  Contents and Metadata access, is the only credential. Only the entry script
  reads it; it is never an argument, never read from a file or `gh`, never
  printed or written, and never forwarded to artifact storage hosts.
- **Runtime and Git checks.** Before any network request the publisher refuses
  (`unsafe-runtime`) if `process.execArgv` is non-empty or any listed Node,
  TLS, proxy or Git override variable is present (presence only; values are
  never read). Git runs without a shell and with a fixed minimal environment
  that ignores global and system configuration.
- **Exact source-commit binding.** The supplied source commit must equal HEAD,
  the working tree must be clean including untracked files, and the commit must
  be on `main`. The build record pins the `package-lock.json` SHA-256.
  Accepted P3 architecture (not yet implemented): a future publication-enabled
  dashboard build must be built from exactly `manifest.build.sourceCommit`.
- **Strict private allow-list.** An explicit file of `(runId, runAttempt)`
  pairs, at most 64 KiB and 500 entries: a publisher-owned 0600 regular file
  with one link, outside the repository (a 0700 parent directory is the
  documented procedure; the code does not check it), with no unknown fields
  and no duplicate pairs. Nothing is scanned.
  **Duplicate JSON object keys are refused** at every level, comparing decoded
  names, by a bounded pre-parse check; malformed escapes, invalid Unicode and
  unescaped control characters are refused with the fixed `invalid-allowlist`.
- **Fresh evidence.** Every allow-listed run is re-verified in the same build
  through the committed read-only transport; no verified status is carried
  over from an earlier build and no caller can supply evidence or a verdict.
- **Required-evidence failures fail closed.** Any 404 or other failure on
  required evidence is `evidence-unavailable`; permission errors, rate limits,
  pending runs and undetermined verdicts also fail the whole build. Nothing is
  retried and nothing partial is written. A 404 is never read as "the run was
  deleted".
- **Digest verification.** Metrics are published only when the archive
  downloaded in this build matches the API digest and the summary state is
  `SUMMARY_VERIFIED_ORIGIN`. A digest mismatch, summary conflict or storage
  redirect outside the allow-listed hosts fails the build.
- **Retained bundles.** Optional, pinned by SHA-256, read with `O_NOFOLLOW` from
  an owner-only directory (0600 file, link count 1, at most 64 KiB) and strictly
  parsed. A retained bundle never becomes `BUILD_VERIFIED`, only cross-checks
  fresh evidence (any disagreement fails the build) and never substitutes for
  missing evidence.
- **No silent omissions.** Every allow-listed run is either published or the
  build fails; untrusted-origin runs fail the build unless explicitly included,
  and then appear only in a separate section. A non-empty omission list or a
  published count different from the allow-list is `internal-error`.
- **Owner-only filesystem output.** The output parent must be an existing,
  publisher-owned 0700 directory outside the repository with safe ancestors.
  A generation is a 0700 directory holding exactly two 0600 files: the
  manifest and a build record (source commit, `builtAt`, Node version,
  allow-list, lockfile and manifest SHA-256 values; no paths or tokens).
- **Exclusive claim and atomic visibility.** The generation name is claimed
  with exclusive `mkdir`, so no pre-existing entry is ever replaced; the fully
  written, fsynced staging directory then becomes visible through one rename.
  This is atomic visibility, not crash durability.
- **Accepted limitations.** A process running as the publisher's own user can
  replace the empty claim before the rename, and inode numbers may be reused
  (observed on Linux), so an identity check cannot prove the claim was never
  replaced. Cleanup is non-recursive and limited to identity-matching, empty
  resources. No unconditional no-replace or no-delete guarantee is claimed.
- **Leakage scans.** The manifest text is scanned before it is written for URL,
  token-prefix, `Bearer`, signed-URL, storage-host, home and temporary path,
  evidence-directory and canary markers, and for the token value itself; any
  hit is `internal-error`. Console output is one fixed line with no paths.
- **Synthetic test coverage.** Unit tests use a fake GitHub router, synthetic
  ZIP archives and `mkdtemp` filesystems only, covering every failure-matrix
  row, forged inputs, path and permission attacks, the claim protocol under
  several umasks and secret canaries. Targeted mutation checks were run during
  the P2B review; no mutation-testing tool is committed.
- **Live validation is separately authorized.** Running the publisher against
  GitHub is an explicit, one-off maintainer authorization, never part of CI or
  of `npm run verify`. The first validation (P2C-2, run 45888304208 attempt 1)
  produced a private local generation that stays outside the repository and is
  historical evidence, not something P3 regenerates or edits.

Accepted P3 dashboard architecture, recorded in ADR-0011 and **not
implemented**: separate Node-side and browser-safe manifest readers; the
verified manifest embedded as a static same-origin JavaScript data module; the
page keeps `connect-src 'none'` and makes no GitHub request; files opened in
the picker stay `IMPORTED_UNAUTHENTICATED`; real, untrusted-origin and
synthetic data stay separate; cross-generation history and public deployment
remain deferred.

### Real-credential restrictions

Rule 1 still applies: no real credentials in this repository or its CI. These
controls **do not certify any target as safe for production testing**. Before a
real credential is used, all of the following are required: a private runner
and private artifacts; API or token authentication instead of typing into the
form where possible; no assertions on secret fields; and the verification in
rule 7 re-run against the actual outputs.

## Current status

| Item                                    | State                                                             |
| --------------------------------------- | ----------------------------------------------------------------- |
| Credentials in use                      | Sauce Demo public demo values only                                |
| Credentials in configuration object     | none                                                              |
| Credentials in traces                   | setup and login-form traces only; public values                   |
| Session state in traces                 | authenticated traces; public demo username                        |
| Saved session file                      | `playwright/.auth/`, Git-ignored, never uploaded                  |
| Accessibility attachments               | allow-listed summaries only; no HTML or selectors                 |
| Restricted targets                      | refused in CI; local plain CLI only, recording off                |
| Real secrets anywhere in the repository | none                                                              |
| Artifact visibility                     | public; HTML report and quality summary 7 days, shard blobs 1 day |
| CI git metadata in reports              | noreply identities, public diff (S9)                              |
| CI annotations and job summary          | allow-listed triage fields only (S10)                             |
| Quality summary artifact                | allow-listed metadata, no verdict, forks skipped (S11)            |
| Trusted publisher                       | local only; private owner-only output; not deployed or integrated |

M3a did not reduce the trace exposure, because all three specs still typed
credentials into the login form. M3b reduces it: only the setup project and
the login-form tests type them, and the authenticated tests restore a saved
session instead. That is a reduction, not a removal, and the authenticated
traces now carry session state. The control that makes this safe is still
rule 1, not the trace configuration.
