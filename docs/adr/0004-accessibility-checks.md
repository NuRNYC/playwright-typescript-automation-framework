# ADR-0004: Strict automated accessibility gate with axe-core

- **Status:** accepted
- **Date:** 2026-11-24
- **Scope:** M4. Builds on [ADR-0003](0003-authentication-storage-state.md)
  (projects and opt-in authentication) and
  [ADR-0002](0002-configuration-unit-tests.md) (pure modules under `node:test`).

## Context

The roadmap defined M4 as "Accessibility checks (`@axe-core/playwright`)"
with no further criteria. The framework already anticipated it: the fixture
contract names "accessibility scanners" as a consumer, and page objects carry
no assertions so they can back such a suite.

Before choosing a policy, both target pages were measured in an isolated copy
(Chromium 156, `@axe-core/playwright` 4.14.0 → `axe-core` 4.14.1), with the
WCAG 2.0–2.2 A/AA tags. Only summaries were recorded, never HTML, values or
selectors.

| Page                                     | Violations | Incomplete                          | Passes / inapplicable |
| ---------------------------------------- | ---------- | ----------------------------------- | --------------------- |
| Login (`/`), logged out                  | 0          | 0                                   | 19 / 45               |
| Inventory (`/inventory.html`), signed in | 0          | `color-contrast` (serious), 3 nodes | 28 / 36               |

The incomplete reasons reported by axe were `pseudoContent` (2 nodes) and
`elmPartiallyObscuring` (1 node): axe could not compute contrast, not that it
failed. Results were identical across repeated scans and fresh sessions. Two
of the three affected nodes had generated, non-static CSS paths.

Measured tag support in axe-core 4.14.1: `wcag2a` 62 rules, `wcag2aa` 3,
`wcag21a` 1, `wcag21aa` 3, `wcag22a` **0**, `wcag22aa` 1 — 70 rules in total.

## Decision

### A strict gate

- **Any confirmed violation fails, regardless of impact.** With a measured
  baseline of zero, there is nothing to tolerate.
- **`incomplete` results are reported, never gated.** axe could not decide;
  gating on them would make the build depend on the engine's uncertainty. They
  are attached to the report and added as a test annotation for manual review.
- **All six tags** are requested: `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`,
  `wcag22a`, `wcag22aa`. `wcag22a` has no rules in axe-core 4.14.1; requesting
  it is harmless and future-proof.
- **This is an automated regression gate, not a WCAG conformance claim.**
  Automated rules cover a subset of WCAG; keyboard flow, meaning and assistive
  technology behaviour still need human evaluation.

### Scope

- Two pages: login (logged out) and inventory (signed in).
- **Chromium only.** axe's rules are engine-independent, but some verdicts
  depend on rendering, and the baseline was measured in Chromium. Firefox and
  WebKit projects ignore `*.a11y.spec.ts`; all existing UI tests keep their
  three-browser coverage.
- The login scan is public, so it runs even if authentication setup fails. The
  inventory scan lives under `tests/ui/authenticated/` and opts in with
  `authenticatedAs: 'standard'`.

### Structure

| Module                                                                         | Responsibility                                                                                       |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `src/a11y/policy.ts`                                                           | Pure: tags, `evaluateGate` (strict gate, exceptions), `toReportSummary` (allow-list). Clock injected |
| `src/a11y/exceptions.ts`                                                       | The reviewed exception list — **empty**                                                              |
| `src/a11y/policy.test.ts`                                                      | `node:test` cases for every gate rule and the summary allow-list                                     |
| `src/fixtures/test.ts`                                                         | `makeAxeBuilder` (central configuration) and `scanAccessibility` (scan, gate, attach, annotate)      |
| `tests/ui/login.a11y.spec.ts`, `tests/ui/authenticated/inventory.a11y.spec.ts` | Navigate, wait for readiness, scan, assert `failures` is empty                                       |

Specs never construct an `AxeBuilder`; every scan uses the same configuration.
Page objects are unchanged.

### Exception governance

An exception permits one known violation on one page:

| Field      | Rule                                                                  |
| ---------- | --------------------------------------------------------------------- |
| `page`     | One of the scanned pages; never global                                |
| `ruleId`   | The axe rule id                                                       |
| `impact`   | Must equal the measured impact                                        |
| `maxNodes` | Positive integer; more affected nodes fail                            |
| `reason`   | Why it cannot be fixed here (e.g. third-party markup, upstream issue) |
| `owner`    | A role, never a person's name                                         |
| `reviewBy` | ISO date, inclusive                                                   |

Exceptions are keyed by page and rule, **not by CSS selector**: the measured
selectors were generated paths that change with harmless markup edits.

The gate fails — the exception itself becomes a failure — when an exception
is **expired**, **unused** (its violation is gone), **severity-mismatched**,
**exceeded**, **malformed**, or **duplicated**.

**Approval.** An exception is added only in a pull request that (1) adds the
entry to `src/a11y/exceptions.ts`, (2) records it in the log below with the
measured rule, page, impact and node count, and (3) passes the required `test`
check.

**Retirement.** Automatic: once the violation disappears the entry fails as
unused and must be removed; once `reviewBy` passes it fails as expired and must
be renewed with a new justification or removed.

#### Exception log

None. The list is empty at M4.

### Safe reporting

Each scan attaches `a11y-summary-<page>.json`, built from an explicit
allow-list: page, axe-core version, tags, counts, and per-rule id, impact, WCAG
tags, node count and help URL; incomplete rule ids with node counts; excepted
entries; gate failures. Raw `AxeResults`, nodes, HTML, CSS selectors and
`failureSummary` are never serialised. Scans run before any `fill()`, so no
typed value is in the scanned DOM.

## Dependency and licence

- `@axe-core/playwright` **4.14.0**, pinned exactly, as a development
  dependency. It depends on `axe-core ~4.14.0`; the lockfile resolves
  **4.14.1**. A version change can add rules, so upgrades are deliberate PRs.
- Both packages are licensed **MPL-2.0**, a file-level copyleft licence: its
  conditions attach to the licensed files themselves. Here they are installed
  unmodified as development tooling and are not vendored or redistributed by
  this repository. Modified copies of those files would have to stay under
  MPL-2.0. This records the engineering consideration; it is not legal advice,
  and any redistribution or vendoring should be reviewed first.

## Consequences

- `npm test` runs 12 executions: 1 setup, 6 login-form, 3 cart, 1 login scan,
  1 inventory scan. Unit tests: 47.
- A Sauce Demo markup change that introduces a violation fails the build. That
  is intended: the failure names the rule and page, and an exception requires
  an explicit, expiring decision.
- A failing accessibility test still produces the usual failure trace and
  screenshot (`retain-on-failure`). **Traces contain full DOM snapshots**, so
  the summary allow-list protects the attachment, not the trace. This is
  acceptable while the targets are public demo pages (security policy rule 1).
- Verified in an isolated copy: injected `html-has-lang` and `image-alt`
  violations fail; a matching exception passes; unused, expired,
  severity-mismatched, exceeded and other-page exceptions fail; a failed setup
  still lets the login scan run.

## Alternatives considered

| Option                                     | Why not chosen                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Baseline gate on serious/critical only     | Designed for existing violations; the measured baseline is empty                     |
| Report-only                                | Enforces nothing                                                                     |
| `toMatchAriaSnapshot` only (no dependency) | Structural regression check, not WCAG rule checking; not the roadmap's tool          |
| Scan in all three browsers (16 executions) | Triples cost and flake surface for engine-independent rules; deferred                |
| Exceptions keyed by CSS selector           | Measured selectors were generated paths; keys would break on harmless markup changes |
| Fail on `incomplete`                       | Gates on axe's uncertainty rather than on findings                                   |

## Deferred

- Manual review of the three incomplete `color-contrast` nodes on the
  inventory page.
- Additional pages (cart, checkout), keyboard-flow tests, ARIA snapshots.
- Multi-browser scanning.
- Inspection of a real failing CI run's artifact for accessibility tests.

## Related

- [`docs/security-testing-policy.md`](../security-testing-policy.md)
- `src/a11y/policy.ts`, `src/a11y/exceptions.ts`, `src/fixtures/test.ts`
