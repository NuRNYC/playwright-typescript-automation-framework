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

| Vector                    | What it can expose                                                                    | Current setting         |
| ------------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| Trace — action parameters | `fill()` values verbatim                                                              | `retain-on-failure`     |
| Trace — DOM snapshots     | Input `value` attributes                                                              | `retain-on-failure`     |
| Trace — network log       | Request bodies, so the login `POST` carries credentials                               | `retain-on-failure`     |
| Screenshots               | Password fields render masked, but usernames, tokens in URLs and session state do not | `only-on-failure`       |
| Video                     | Equivalent to screenshots, continuously                                               | not enabled             |
| HTML report               | Embeds screenshots and links traces                                                   | always produced         |
| CI artifacts              | All of the above, 7-day retention, public repository                                  | uploaded `if: always()` |
| Process logs              | Whatever the framework prints                                                         | allow-listed, see below |

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

## Current status

| Item                                    | State                                                 |
| --------------------------------------- | ----------------------------------------------------- |
| Credentials in use                      | Sauce Demo public demo values only                    |
| Credentials in configuration object     | none                                                  |
| Credentials in traces                   | yes, in cleartext — accepted, because they are public |
| Real secrets anywhere in the repository | none                                                  |
| Artifact visibility                     | public, 7-day retention                               |

M3a does not reduce the trace exposure, because all three specs still type
credentials into the login form. That is stated plainly rather than implied:
the control that makes it safe is rule 1, not the trace configuration.
