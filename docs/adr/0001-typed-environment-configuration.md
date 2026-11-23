# ADR-0001: Typed environment configuration with a validated target registry

- **Status:** accepted
- **Date:** 2026-11-23
- **Scope:** M3a. Supersedes nothing.
- **Amended by:** [ADR-0002](0002-configuration-unit-tests.md) (M3c) — module split only; the decision below is unchanged.

## Context

`baseURL` was hardcoded in `playwright.config.ts`, and `process.env` was read
in exactly two places, both for `CI`. Pointing the suite at a different
deployment therefore meant editing tracked configuration — which invites a
commit per environment and makes "which deployment did this run actually
test?" unanswerable from the report.

The framework needed environment indirection. The design question was not
_whether_ but _how little_.

## Decision

A single module, `src/config/env.ts`, is the only place that reads
`process.env`. It parses once, validates eagerly, and exports a frozen object.

> **Amended by [ADR-0002](0002-configuration-unit-tests.md).** In M3c the module
> was split in two without changing any behaviour described here:
>
> - `src/config/env.ts` is the **pure resolver and validation module**: types,
>   the target registry, the parsers, `resolveConfig(env)`, `redactBaseURL` and
>   `describeConfig`. It has no side effects and does not read `process.env`.
> - `src/config/index.ts` is the **runtime singleton**. It is the module
>   responsible for reading application target configuration (`APP_TARGET`,
>   `BASE_URL`, `CI`) from `process.env`: it calls `resolveConfig(process.env)`,
>   freezes the result, and is imported as `@/config`.
> - `playwright.config.ts` separately reads `TEST_WORKER_INDEX`, a variable
>   Playwright sets in worker processes, to print the startup banner once (see
>   below).
>
> Validation remains fail-fast: importing `@/config` from `playwright.config.ts`
> resolves the configuration before any browser starts.

### Three concepts kept separate

Conflating these was the error in the first draft of this design, which used a
single `EnvName = 'local' | 'staging' | 'production'` union.

| Concept            | Type               | Meaning                                                  |
| ------------------ | ------------------ | -------------------------------------------------------- |
| Application target | `AppTarget`        | Which deployed application the browser points at         |
| Deployment tier    | `DeploymentTier`   | What kind of deployment it is; drives policy, never URLs |
| Execution context  | `ExecutionContext` | Where the tests run; a property of the runner            |

Sauce Demo's tier is `public-demo`, **not** `local`. Nothing is deployed
locally; it is a third-party hosted public sample, and calling it "local"
would imply a safety it does not have.

Keeping execution context separate makes previously inexpressible
combinations expressible: the public demo target from CI, or a staging target
from a developer machine.

### A registry, with the type derived from it

```ts
const TARGETS = {
  saucedemo: { tier: 'public-demo', defaultBaseURL: 'https://www.saucedemo.com' },
  staging: { tier: 'internal-staging', defaultBaseURL: undefined },
  production: { tier: 'production', defaultBaseURL: undefined },
} as const satisfies Record<string, TargetDefinition>;

export type AppTarget = keyof typeof TARGETS;
```

`AppTarget` is derived from the data, so the type and the registry cannot
drift. Adding a target extends the union automatically — the same discipline
already used for `User` and `ProductSlug` in `src/data/`.

### Resolution rules

1. `APP_TARGET` unset defaults to `saucedemo`, so a fresh clone runs with zero
   configuration.
2. `APP_TARGET` not in the registry fails immediately, listing valid targets.
3. `staging` and `production` have **no** default URL. Selecting them without
   `BASE_URL` is an error, not a fall back.
4. Any supplied `BASE_URL` must parse as an absolute URL and use http or https.
5. The configuration object contains no credentials.

### The distinction that matters most

The first draft defaulted the **URL**:
`process.env.BASE_URL ?? 'https://www.saucedemo.com'`. That is a silent
fallback — a misspelled variable name would quietly test the demo site while
appearing configured.

This version defaults the **target name** and resolves the URL from a
validated registry. Zero-configuration still works, but because the default is
an explicitly known and validated target, not because a URL was guessed.

### Overrides are configuration, not evidence

When `BASE_URL` overrides a registry default, `tier` is still taken from
`APP_TARGET` and is **never** re-derived from the URL. An override records
operator intent; it proves nothing about what is actually deployed at that
address. `baseURLSource` is tracked and surfaced in the startup banner so an
override is always visible in the run output.

### `CI` is parsed, not coerced

`!!process.env.CI` was replaced with explicit parsing against accepted value
sets. Every non-empty string is truthy in JavaScript, so `CI=0` and `CI=false`
previously selected CI mode — enabling retries and `forbidOnly` for someone
who had explicitly asked for neither.

In practice this changes nothing on GitHub Actions, which sets `CI=true`.

### The banner needs an explicit main-process guard

The first implementation logged unconditionally from `playwright.config.ts`, on
the assumption that the config file is evaluated once in the main process while
only imported modules are re-loaded by workers.

**That assumption was wrong, and measurement caught it:** the banner printed
**10 times** for a 9-test run. Playwright worker processes re-evaluate the
config file itself, not merely the modules it imports. So "log from
`playwright.config.ts`" is not equivalent to "log once".

The fix is an explicit guard. Playwright sets `TEST_WORKER_INDEX` only in
worker processes, so its absence identifies the main process:

```ts
if (process.env.TEST_WORKER_INDEX === undefined) {
  console.log(`[config] ${describeConfig(config)}`);
}
```

`describeConfig` takes the configuration as a required argument. At M3a it
defaulted to the module-level singleton; ADR-0002 removed that default so the
pure resolver carries no ambient dependency.

Verified: exactly one banner per run.

The same process boundary is why no mutable state may live in the config
module. A counter, a cache or a list of created records would be re-initialised
per process and would never cross the boundary — which is also why
`storageState` is a _file_ rather than a shared variable.

## Alternatives considered

| Alternative                             | Why not                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zod or a similar schema library         | A new dependency for three variables. Hand-rolling teaches assertion functions and type predicates, and keeps the supply chain of a public portfolio repository small. Revisit above roughly eight variables. |
| `dotenv` with a loaded `.env`           | A dependency, and unnecessary while variables come from a shell or CI. `.env.example` documents the contract instead.                                                                                         |
| Default the URL rather than the target  | The silent fallback described above.                                                                                                                                                                          |
| Credentials in the configuration object | Creates a leak path through logs and serialised reports for no benefit; test accounts already live in `src/data/users.ts`.                                                                                    |
| Re-derive tier from an overridden URL   | Pattern-matching a hostname to infer "this is staging" is guesswork presented as a safety guarantee.                                                                                                          |
| Pin `workers`                           | No evidence of an execution problem. Current parallel behaviour is preserved untouched.                                                                                                                       |

## Consequences

**Good.** One place reads the environment. Invalid configuration fails before
any browser starts — verified, see below. Zero-configuration clone still
works. The resolved target appears in every run's output. Credentials cannot
leak through configuration.

**Costs and known gaps.**

- `.env.example` exists but **nothing loads `.env`**. A developer who copies
  it and fills it in will see no effect. Documented prominently in the file
  itself and in the README, but it remains a usability trap until a loader is
  added.
- Defaulting `APP_TARGET` means a misspelled _variable name_
  (`AP_TARGET=staging`) still silently runs against the demo site. Mitigated
  by the startup banner, which always states the resolved target, tier and
  source — not eliminated.
- An unrecognised `CI` value is now a hard error rather than being coerced.
  Accepted deliberately in exchange for explicitness; the accepted set is
  broad.
- Observed but not acted on: local runs use 8 workers (16 cores) while CI
  reports 2. `workers` stays unset per the scope of this change.

## Verification

That a configuration error aborts **before** browser execution was proven, not
assumed. With a throwing config, both `--list` and a real run emitted the
error and exited 1, with no "Running N tests" line:

```
Error: Invalid APP_TARGET "nonsense". Valid targets: saucedemo, staging, production.
exit=1
```

Probes P1–P12 are recorded in the pull request for this change. These manual
probes were subsequently replaced in M3c by 27 permanent configuration unit
tests in `src/config/env.test.ts`, which run on every push; see
[ADR-0002](0002-configuration-unit-tests.md).

## Related

- [ADR-0002](0002-configuration-unit-tests.md) — splits this module into a pure
  resolver and a runtime singleton, and pins these rules with unit tests.
- `docs/security-testing-policy.md` — credential and artifact handling,
  including the verified finding that traces record `fill()` values in
  cleartext. Rules 2, 3 and 4 there are implemented by this module.
