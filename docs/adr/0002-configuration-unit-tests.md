# ADR-0002: Configuration unit tests with Node's built-in runner

- **Status:** accepted
- **Date:** 2026-11-23
- **Scope:** M3c. Builds on [ADR-0001](0001-typed-environment-configuration.md).

## Context

M3a shipped a validated configuration module whose behaviour was proven by
ad-hoc shell probes: unknown targets rejected, missing `BASE_URL` rejected,
malformed URLs rejected, `CI` parsed explicitly, URLs redacted. Those probes
ran once, interactively, on one machine. Nothing in the repository enforced any
of it, so every behaviour was one careless edit away from silent regression.

Two obstacles stood in the way of permanent tests.

**The logic was unreachable.** `resolveConfig` was not exported. Only
`redactBaseURL`, `describeConfig`, `APP_TARGETS` and `ConfigError` were — so
target validation, URL validation, `CI` parsing and provenance could not be
called from a test at all.

**The module had a side effect.** `export const config = Object.freeze(resolveConfig(process.env))`
executed at import time, so importing the module for _any_ purpose parsed the
ambient environment. Testing different scenarios would have meant mutating
`process.env` and busting the module cache — the recipe for order-dependent,
intermittently failing tests.

## Decision

### Separate the pure resolver from the runtime singleton

| Module                | Responsibility                                                                                      | Side effects                  |
| --------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| `src/config/env.ts`   | types, target registry, validating parsers, `resolveConfig(env)`, `redactBaseURL`, `describeConfig` | **none**                      |
| `src/config/index.ts` | injects the real `process.env`, freezes, re-exports                                                 | reads `process.env` at import |

`resolveConfig(env)` was _already_ pure — the environment arrives as a
parameter. It was simply private. Exporting it and moving the singleton one
file away turns a module that resisted testing into one where a test is just a
function call with an object literal.

Application code keeps importing `config` from `@/config`. Validation still
happens at import time, so `playwright.config.ts` still aborts a misconfigured
run before any browser launches — behaviour is unchanged.

`describeConfig` now takes a **required** parameter. Defaulting it to the
singleton would have reintroduced the ambient dependency the split exists to
remove.

### Node's built-in test runner

Chosen over Vitest and a Playwright non-browser project.

| Criterion           | `node:test`                               | Vitest            | Playwright project |
| ------------------- | ----------------------------------------- | ----------------- | ------------------ |
| New dependencies    | **0**                                     | ~15–20 transitive | 0                  |
| TypeScript          | runs `.ts` directly                       | esbuild           | native             |
| 27 tests            | **~0.26s**                                | slower startup    | much slower        |
| Count separation    | separate command, invisible to Playwright | separate          | shares `--list`    |
| Watch / coverage DX | basic                                     | excellent         | good               |

For a public portfolio repository, adding zero supply-chain surface to test a
250-line module is the right trade. Vitest becomes justified when watch mode,
coverage thresholds or module mocking are actually needed — none are here.

Node 24 runs TypeScript directly with no flag and no experimental warning, via
**type stripping**: types are erased, nothing is transpiled.

### Two verified limits of strip-only mode

**1. Import extensions are mandatory.** An extensionless specifier fails:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../env'
```

So tests import `'./env.ts'`, which `tsc` rejects by default:

```
error TS5097: An import path can only end with a '.ts' extension
when 'allowImportingTsExtensions' is enabled.
```

Hence `allowImportingTsExtensions: true`, legal because `noEmit` is already
set. It only _permits_ the extension; no existing import changed. The `@/`
alias is unavailable in unit tests, because `paths` is a compile-time tsconfig
mapping that plain Node knows nothing about — the same compile-time versus
runtime distinction already met with path aliases in M1.

**2. Type-directed syntax is unsupported.** Verified:

```
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
  TypeScript parameter property is not supported in strip-only mode
  TypeScript enum is not supported in strip-only mode
```

Every page object uses a constructor parameter property
(`constructor(protected readonly page: Page)`). **So this runner cannot unit
test page objects.** It is sufficient for configuration, which uses no such
syntax, and that ceiling is recorded here so it is not rediscovered later: unit
testing page objects would require Vitest or `tsx`, or rewriting those
constructors to explicit field assignment.

### `no-floating-promises` and node:test

`test()` returns a promise, so all 27 calls are floating and ESLint reported
every one. The rule was **not** disabled — that would also hide genuine missing
awaits. Instead `allowForKnownSafeCalls` declares only node:test's lifecycle
functions safe, pinned to the `node:test` package so a same-named helper from
elsewhere is still reported. Verified: a deliberately added floating promise in
a unit-test file is still caught.

This required editing `eslint.config.mjs`, a file outside the originally
approved nine. The alternative was prefixing 27 calls with `void`, which is
noise that teaches nothing.

### Placement and count separation

Unit tests live at `src/config/env.test.ts`, colocated with the module.
Playwright's `testDir` is `./tests`, so files under `src/**` are **never
discovered** by it — the browser count stays at exactly 9 with no `testIgnore`
rules. A `tests/unit/` directory would have sat inside `testDir` and required
exclusions.

CI runs `npm run test:unit` as its own step, placed before the browser install
so a logic regression fails in seconds. `npm run verify` also includes it for
local convenience; CI calls the script directly rather than `verify`, so the
suite executes **once** per job.

## Consequences

**Good.** Every M3a probe is now an enforced invariant, running on every push
behind the required `test` check. 27 tests in ~0.26s with no browser, no
network and no new dependency. `env.ts` is pure, so tests are deterministic
regardless of the developer's ambient environment. Security properties are
pinned: the prototype-pollution guard, the allow-listed banner, and URL
redaction all have regression tests.

**Costs.**

- One more indirection: consumers import `@/config`, not `@/config/env`.
- `allowImportingTsExtensions` is a project-wide tsconfig flag, enabled for the
  benefit of two files. It permits rather than requires, so the blast radius is
  nil, but it is a shared setting.
- Unit tests cannot use the `@/` alias, so two import conventions coexist.
- The runner cannot be extended to page objects without a transform.
- `@types/node` is 22.x against a 24.x runtime. `node:test` types are present
  and correct; recorded as a maintenance follow-up.

## Alternatives considered

| Alternative                                                    | Why not                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vitest                                                         | 15–20 transitive dependencies for capability not currently needed.                                                                                                             |
| Playwright non-browser project                                 | Would mix configuration tests into `--list` output and the browser count, which the brief explicitly required to stay at 9.                                                    |
| Mutate `process.env` and re-import                             | Order-dependent, needs cache busting, breaks under parallelism. The injectable resolver removes the need entirely.                                                             |
| Keep the singleton in `env.ts` and export only `resolveConfig` | Smaller diff, but importing the module for a test would still parse the ambient environment — a developer with `APP_TARGET` exported would see unrelated tests fail to import. |
| Disable `no-floating-promises` in test files                   | Would hide real missing awaits in exactly the files most likely to have them.                                                                                                  |
| `void test(...)` on every call                                 | 27 lines of noise expressing nothing.                                                                                                                                          |

## Related

- [ADR-0001](0001-typed-environment-configuration.md) — the configuration design these tests pin.
- [`docs/security-testing-policy.md`](../security-testing-policy.md) — the redaction and allow-list rules now covered by regression tests.
