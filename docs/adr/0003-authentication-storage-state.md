# ADR-0003: Opt-in authentication with a cookie-only saved session

- **Status:** accepted
- **Date:** 2026-11-24
- **Scope:** M3b. Builds on [ADR-0001](0001-typed-environment-configuration.md)
  and [ADR-0002](0002-configuration-unit-tests.md).

## Context

Every spec that needed a signed-in user typed credentials into the login form.
That repeated the login in each test and put the password into every such
test's trace (see [the security policy](../security-testing-policy.md)).

Playwright's `storageState` can restore a signed-in browser context without
the form. Whether that works depends on how the application authenticates, so
Sauce Demo's behaviour was measured in temporary, in-memory browser sessions
before anything was designed. Values were never printed; only names,
attributes and lengths.

| Question                         | Observed (Chromium, Firefox, WebKit)                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| What establishes the session?    | One cookie, `session-username`, on `www.saucedemo.com`, path `/`. Its value is the username. Not `httpOnly`, not `secure`                   |
| Is a server involved?            | No. Login and cart send no non-GET request to `saucedemo.com`. The only writes go to `events.backtrace.io`, a third-party error reporter    |
| Other storage                    | No `sessionStorage`, no IndexedDB. `localStorage` holds `backtrace-guid`, `backtrace-last-active`, and `cart-contents` after an add-to-cart |
| Is the cookie alone enough?      | Yes. Restoring only the cookie reaches `/inventory.html`                                                                                    |
| Can saved state carry test data? | Yes. State captured after add-to-cart restores the cart badge                                                                               |
| Lifetime                         | About 600 s from login, fixed: the remaining time does not grow with activity. An expired cookie redirects to the login page                |
| Cross-browser                    | State captured in Chromium restores in Firefox and WebKit                                                                                   |
| Parallel contexts                | Two contexts restored from the same state are independent                                                                                   |
| Logout                           | Deletes the cookie, leaves `cart-contents`                                                                                                  |

## Decision

### Logged out by default; authenticated specs opt in

A spec requests a session explicitly:

```ts
test.use({ authenticatedAs: 'standard' });
```

`authenticatedAs` is an option fixture in `src/fixtures/test.ts`. It
overrides Playwright's built-in `storageState`. Specs that do not set it get
the configured value (none), so a new spec starts logged out. The login-form
tests never set it.

### Seven projects, selected by location

| Project                                                                   | Matches                                                 | Depends on |
| ------------------------------------------------------------------------- | ------------------------------------------------------- | ---------- |
| `setup`                                                                   | `tests/auth.setup.ts`                                   | —          |
| `chromium`, `firefox`, `webkit`                                           | default `*.spec.ts`, ignoring `tests/ui/authenticated/` | —          |
| `chromium-authenticated`, `firefox-authenticated`, `webkit-authenticated` | `tests/ui/authenticated/**/*.spec.ts`                   | `setup`    |

- Playwright's default `testMatch` does not match `*.setup.ts`, so the setup
  file is discovered once, by `setup` only.
- A dependency runs once per run, however many projects depend on it.
- The public projects do not depend on `setup`, so the login-form tests run
  when setup fails.
- One setup serves all three browsers, because Chromium-captured state
  restores in Firefox and WebKit.

### The saved state is one cookie and nothing else

`tests/auth.setup.ts` signs in through the real form, asserts the inventory
page, then reads `context.storageState()` **in memory** and keeps only the
`session-username` cookie for `www.saucedemo.com`. It writes
`{ cookies: [that cookie], origins: [] }` to `playwright/.auth/standard.json`
(Git-ignored, mode `0600`).

Because `origins` is always empty, cart contents and the Backtrace telemetry
identifiers cannot enter the file, whatever order actions happen in. They are
not needed to authenticate, and `backtrace-guid` is a device identifier for a
third-party service.

The writer refuses to replace anything at the path that is not a regular file,
and writes through a temporary file and rename.

### Every precondition is checked before a context exists

`checkSavedSession(state, nowSeconds)` in `src/auth/session.ts` is pure, with
the clock injected, and is unit-tested in `src/auth/session.test.ts`. It
requires: the storage-state structure; an empty `origins` array; exactly one
cookie, named `session-username`, on `www.saucedemo.com` path `/`; and an
expiry more than 60 s away.

The fixture also fails, with a `SessionStateError` naming the rule, when:

- the project does not depend on `setup`: a spec placed outside
  `tests/ui/authenticated/` would otherwise run in a public project, possibly
  before setup has written the file;
- the state file is missing or unreadable;
- the target is not the verified one (below).

No message includes a cookie value.

### Fail closed outside the verified target

Setup and the fixture both call `assertSupportedTarget`. It accepts only
`APP_TARGET=saucedemo` **and** a base URL whose hostname is
`www.saucedemo.com`. A `BASE_URL` override to another host, or any other
target, fails setup. The login tests still run there; the authenticated tests
do not run.

## Consequences

- `npm test` runs 10 executions: 1 setup, 6 login-form (2 × 3 browsers),
  3 authenticated cart (1 × 3 browsers).
- Only setup and the login-form tests type the password. Measured with tracing
  forced on: 0 occurrences of the password in the authenticated traces, 9 in
  the setup trace.
- **Traces of authenticated tests record the restored `storageState`**,
  including the cookie value. Here that value is the public demo username. For
  a real target it would be a live session token; see the security policy.
- If setup fails: 1 failed, 6 login tests pass, 3 authenticated tests do not
  run. Verified by forcing setup to sign in with the invalid account in an
  isolated copy.
- `--project=chromium` now selects only the public specs. Use
  `--project='chromium*'` for both groups in one browser.
- `--no-deps` skips setup and reuses the file on disk. A missing, expired (or
  expiring within 60 s) or tampered file fails with an explicit message
  instead of a redirect to the login page.
- A target that keeps its session in `localStorage` or `sessionStorage`, or
  uses a different cookie, needs its own policy entry; the current one rejects
  it by design.

## Alternatives considered

- **All browser projects depend on setup.** Smallest config, but a failed
  setup leaves all 9 browser tests unrun, including the login-form tests that
  would explain the failure. Measured: 1 failed, 9 did not run. Rejected.
- **Logged in by default, login specs opt out.** Playwright's documented
  pattern. Forgetting the opt-out would test the login form while already
  signed in, and could pass for the wrong reason. Rejected.
- **Select projects by tag** (`grep` / `grepInvert`). A tag can drift away
  from the `authenticatedAs` opt-in; a directory is checked by configuration.
  Rejected.
- **Per-worker login held in memory.** No file at all, but one login per worker
  per browser, outside any test's trace, and more custom code. Deferred: the
  natural shape for per-worker accounts.
- **Injecting the cookie directly.** Fastest, but couples tests to an
  implementation detail no real application would allow. Rejected.
- **Keep signing in through the form.** Repeats login and keeps the password in
  every authenticated trace. Rejected.

## Deferred

- Per-worker accounts, needed only when a target stores data on the server.
- Automatic re-authentication of a stale session.
- Real-credential handling: security policy rule 6.

## Related

- [`docs/security-testing-policy.md`](../security-testing-policy.md)
- `src/auth/session.ts`, `src/fixtures/test.ts`, `tests/auth.setup.ts`
