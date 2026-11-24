# ADR-0006: Typed API request layer against an in-process synthetic stub

- **Status:** accepted
- **Date:** 2026-11-24
- **Scope:** M5. Builds on [ADR-0001](0001-typed-environment-configuration.md),
  [ADR-0002](0002-configuration-unit-tests.md) and
  [ADR-0005](0005-recording-and-execution-boundary.md); changes none of them.

## Context

The roadmap defined M5 as "API request layer" and nothing more. The framework
had anticipated it: the fixture contract names "API clients" as a consumer,
and page objects carry no assertions so the same separation can back API
suites.

The application target cannot be used for this. Sauce Demo has no server-side
API: login and cart send no non-GET request to `saucedemo.com` (ADR-0003). M5
therefore needed its own service to call.

Measured in isolated copies with Playwright 1.64.1 and synthetic data:

| Behaviour                          | Observed                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APIRequestContext` without a page | works; no browser is launched                                                                                                                                                                            |
| Built-in `request` fixture         | fresh per test (a cookie set in one test is absent in the next)                                                                                                                                          |
| Project-level `baseURL`            | scoped to its project; UI projects keep Sauce Demo                                                                                                                                                       |
| Absolute URL with a `baseURL` set  | **sent to the named host** — `baseURL` does not confine                                                                                                                                                  |
| Redirect to another origin         | **followed by default**; not followed with `maxRedirects: 0`                                                                                                                                             |
| `webServer`                        | starts after config load and **before** global setup; not for `--list`; **for every run, even browser-only**; with `reuseExistingServer: true`, an unrelated process on the port was **silently reused** |
| Request headers and bodies         | recorded in traces (action parameters, logs, network resources); traces are bundled into the HTML report; step titles show only the method                                                               |

## Decision

### The stub is a test dependency, not a deployment tier

`APP_TARGET` selects one tier for the whole invocation, and that tier drives
the UI projects' base URL and recording. A `local-stub` tier would either
repoint every UI project or leave the API project without a tier. The stub is
not a deployment under test; it is a fixture the API tests own. So
`APP_TARGET`, `DeploymentTier`, the registry and both ADR-0005 checkpoints are
**unchanged**, and the API project's recording simply follows the invocation's
tier like every other project.

### A worker-scoped in-process server, not `webServer`

|                       | `webServer`                                          | Worker-scoped fixture (chosen)                 |
| --------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| Starts                | every run, including browser-only                    | only when an API fixture is requested          |
| Port                  | fixed; conflicts possible                            | `0` — the OS assigns a free one                |
| Wrong-server reuse    | possible with `reuseExistingServer: true` (measured) | impossible: the server is created in-process   |
| Order vs checkpoint B | starts before global setup                           | starts inside a worker, after both checkpoints |

### Responsibilities

| Module                       | Owns                                                                                               | Never does                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| `src/api/contract.ts`        | Types and pure guards: `unknown` → `Product` / `Product[]`; JSON syntax as its own outcome         | network                       |
| `src/api/request-policy.ts`  | Pure confinement: endpoint allow-list, path checks, loopback-address verification, redirect status | network                       |
| `src/api/client.ts`          | Endpoints, requests, mapping responses to a discriminated `ApiResult`                              | assertions, logging, browsers |
| `src/api/stub.ts`            | Synthetic server on 127.0.0.1:0, fixed frozen data, scenario ids; the redirect trap                | anything outside loopback     |
| `src/fixtures/test.ts`       | `apiStub` (worker), `apiClient` and `redirectTrap` (test)                                          | —                             |
| `tests/api/products.spec.ts` | Scenarios and assertions                                                                           | building URLs or requests     |

`ApiResult` variants: success with validated data; `http-error` (non-2xx);
`redirect-refused` (3xx); `malformed-json`; `contract-violation` with a field
path. Extra response fields are tolerated but dropped from parsed values.

### Lifecycles

- **Stub:** worker-scoped; created on first use in a worker, closed in the
  fixture's `finally` (verified to close even when a test in that worker
  failed), with keep-alive sockets dropped so close cannot hang.
- **Request context:** test-scoped; `playwright.request.newContext` with the
  stub's verified origin and `maxRedirects: 0`, disposed in `finally`. Specs
  use `apiClient`, never the built-in `request` fixture (whose `baseURL` is the
  application target).
- **Redirect trap:** test-scoped, requested only by the redirect test; it
  points the stub's redirect scenario at a second loopback server and resets
  it on teardown. Safe because tests within one worker run sequentially.

### Request confinement and redirect refusal

`baseURL` does not confine (measured), so confinement is explicit:

1. The client builds every path itself; specs pass ids, never URLs.
2. Each path is re-checked: relative, no scheme, not protocol-relative, no
   backslash, dot segment, query, fragment or whitespace, and on the
   allow-list (`/api/products`, `/api/products/<positive id>`).
3. The only origin is the one returned by verifying `server.address()`:
   IPv4 `127.0.0.1` with a real port.
4. `maxRedirects: 0` on the context and on each request; any 3xx becomes
   `redirect-refused`. A control run with redirects followed reached the trap;
   the real client never does.

### No new dependency

The contract is two shapes owned by this repository. Hand-written guards
follow the existing `unknown` → typed pattern (`checkSavedSession`,
accessibility policy) and stay strip-only compatible for `node:test`. A schema
library would add a dependency for no measurable gain at this scope.

## Verification

- Unit: 87/87 (69 existing + 10 contract + 8 request-policy).
- Playwright: 18 passed — the 12 existing executions unchanged and identical in
  discovery to `main`, plus 6 API tests in the browser-free `api` project.
- No browser launched by the API project; only `127.0.0.1` in API traces;
  stub unreachable through the machine's LAN address; every test got its own
  request context; no listeners left after runs, including a failing one.

## Consequences and limitations

- **This does not validate a real production API.** It proves the layer —
  client, guards, confinement, fixtures — against a contract this repository
  owns.
- Synthetic data only; no authentication, tokens or Authorization headers.
  Any future authenticated API needs its own ADR: request headers and bodies are
  recorded in traces and bundled into reports (security policy S8).
- A spec that used the built-in `request` fixture would bypass the client and
  talk to the application target; review and convention guard this.
- Failure diffs print received values; data here is synthetic.
- Behaviour above was observed in Playwright 1.64.1; re-verify on upgrade.
- CI runs the API project inside the existing job; no workflow change.

## Alternatives considered

| Alternative                          | Why not                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| A `local-stub` deployment tier       | Tier is invocation-global; would change the UI projects or leave API untiered |
| `webServer` with a fixed port        | Starts for every run; port conflicts; wrong-server reuse possible             |
| A public third-party API             | Outages, rate limits, drift, a new external dependency                        |
| Schema-validation dependency         | Unneeded for two owned shapes                                                 |
| Relying on `baseURL` for confinement | Absolute URLs and redirects escape it (measured)                              |

## Related

- [`docs/security-testing-policy.md`](../security-testing-policy.md) — S8
- `src/api/*`, `src/fixtures/test.ts`, `tests/api/products.spec.ts`
