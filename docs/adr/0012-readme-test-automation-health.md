# ADR-0012: README Test Automation Health snapshot

- **Status:** proposed
- **Date:** 2026-11-28
- **Scope:** Defines the metrics, sources, counting rules and evidence handling
  for a "Test Automation Health" section in `README.md`. Builds on
  [ADR-0002](0002-configuration-unit-tests.md),
  [ADR-0007](0007-ci-sharding-and-merged-reports.md) and
  [ADR-0009](0009-quality-reporting-dashboard.md); reads the quality summary
  exactly as ADR-0009 defines it. Changes none of them, and changes neither
  [ADR-0010](0010-quality-verdict-provenance.md) nor
  [ADR-0011](0011-verdict-evidence-publication.md).
- **Implementation:** Phase A (definitions and a verified baseline) and
  Phase B (the manual README snapshot) are drafted in this change, as the
  "Test Automation Health" section of `README.md`. Code, workflows and
  publication contracts are unchanged.

## Context

The repository reports test results in several places, each with a different
unit and trust level:

- `npm run test:unit` (`node:test`) runs in the CI `checks` job. Its result is
  printed in the job log only; no structured artifact records it.
- The Playwright suite runs as two shards. The `test` job verifies and merges
  the blob reports and, as an advisory step, writes the metadata-only
  `quality-summary-<run_attempt>` artifact (ADR-0009, 7-day retention). The
  summary separates definitions, instances, executions, attempts and retries,
  and records no CI verdict.
- The trusted publication manifest (ADR-0011) carries a verified Gate verdict
  but only aggregate metrics, and no unit-test results.

A README section that simply quoted "N tests passed" would mix these units,
count the authentication setup as a test, call every browser test a
regression test, and silently go out of date. This record fixes what the
section shows and where each number comes from before any number is
published.

## Decision

### 1. One snapshot, one commit, one CI run

The section is a **manually maintained, dated snapshot** of exactly one
completed CI run of `.github/workflows/tests.yml`:

- a `push` run on `main`, attempt-specific (`run_attempt`);
- every value in the snapshot comes from that run and its `headSha`; unit and
  Playwright results are never taken from different runs, attempts or commits;
- a local run, a `--list` discovery listing or a figure quoted in another
  document is never presented as a CI result.

The snapshot is updated only through a pull request. Automated generation is a
later, separately approved phase (see [Implementation status and future work](#implementation-status-and-future-work)).

### 2. Groups

Every Playwright result is assigned to exactly one group by its
summary `file` path (relative to the repository, as the normalizer writes
it). Unit tests are a separate group with a separate source.

| Group                   | Membership (exact)                                                                                        | Projects observed                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Unit tests              | All `node:test` tests run by `npm run test:unit` (`src/**/*.test.ts`)                                     | none (no browser)                                  |
| Dashboard functional    | `tests/ui/dashboard.spec.ts`, `tests/ui/dashboard-publication.spec.ts`, `tests/ui/dashboard-demo.spec.ts` | `chromium`, `firefox`, `webkit`                    |
| Dashboard accessibility | `tests/ui/dashboard.a11y.spec.ts`                                                                         | `chromium`                                         |
| Application UI          | `tests/ui/login.spec.ts`, `tests/ui/login.a11y.spec.ts`, every `tests/ui/authenticated/*.spec.ts`         | `chromium`, `firefox`, `webkit`, `*-authenticated` |
| Synthetic-stub API      | every `tests/api/*.spec.ts`                                                                               | `api`                                              |
| Authentication setup    | `tests/auth.setup.ts`                                                                                     | `setup`                                            |

Rules:

- Membership is by **exact path**, not by tag, title or project. Tags
  (`@smoke`, `@a11y`, `@api`) are not group definitions.
- **Application UI** exercises the public Sauce Demo application (smoke and
  accessibility checks). No group is labelled "regression"; the repository has
  no regression tag or suite definition, and execution counts are not
  requirement coverage (ADR-0009).
- **Synthetic-stub API** tests exercise the framework's typed API client
  against a local stub (ADR-0006), not a production API, and are labelled so.
- **Unmatched files.** A result whose file matches no row, or whose file is
  `null` (unresolved identity), is counted in an explicit **Unclassified** row
  and never folded into another group. A non-zero Unclassified row means this
  table is out of date and must be updated in the same PR that adds the file.
- A definition never spans two groups, because groups are defined by file.

### 3. Counting units

Playwright metrics use the existing normalizer's semantics
(`src/reporting/quality-summary.ts`, ADR-0009) without re-deriving them:

| Unit        | Meaning (normalizer semantics)                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Definitions | Distinct `definitionId`: one per file, line, column and title, across all projects                                                                                                                                       |
| Instances   | One per definition **per configured project** that reported it (`instances[]`)                                                                                                                                           |
| Executions  | Reported runs of an instance (`instances[].executions[]`); more than one only when the same instance appears twice in a project whose `repeatEach` is 1 (`multiplicity` `inferred-duplicate`, e.g. setup on both shards) |
| Attempts    | Every attempt of every execution, including retries (`executions[].attempts[]`)                                                                                                                                          |
| Retries     | Attempts with `retry > 0`; never counted as additional tests                                                                                                                                                             |

Results are counted **as the runner reports them**: a loop-generated or
parameterized test is as many definitions as the runner reports (the summary's
`locationGroupSize` exposes shared locations); source-code `test()` calls are
never counted.

Unit tests use the `node:test` reporter's own summary for the run (`tests`,
`suites`, `pass`, `fail`, `cancelled`, `skipped`, `todo`). Its `tests` figure
counts every test the runner reported: a parent test **and** each of its
subtests, and each generated (parameterized) test; `describe` suites are
counted separately in `suites`. Unit tests have no instances, executions or
retries.

### 4. Totals, subtotals and the authentication setup

The `setup` project's single test prepares the saved session; it is not a test
of the product. Two totals are defined, and neither includes it:

- **Playwright tests total (excluding authentication setup)**: dashboard
  functional + dashboard accessibility + application UI + synthetic-stub API.
- **Browser tests subtotal**: dashboard functional + dashboard accessibility +
  application UI only. Synthetic-stub API tests run in the browser-free `api`
  project and are **never** called browser tests.

Setup is always disclosed separately, either as its own row or in an explicit
reconciliation note; the detailed baseline below keeps its setup row. Either
way, the figures reconcile explicitly:

```
raw summary totals = Playwright tests total (excluding authentication setup)
                     + authentication setup (+ Unclassified)
Playwright tests total (excluding authentication setup)
                   = browser tests subtotal + synthetic-stub API
```

If the reconciliation does not hold for every unit (definitions, instances,
executions, attempts, retries and each outcome), the snapshot shows the
affected values as **Unavailable — totals do not reconcile**.

### 5. Outcomes

Outcome columns are **execution** outcomes (`byExecutionOutcome` semantics),
shown per group:

| Column      | Normalizer outcomes                                                           |
| ----------- | ----------------------------------------------------------------------------- |
| Passed      | `passed`                                                                      |
| Flaky       | `flaky` (passed after at least one retry; one execution, never counted twice) |
| Failed      | `failed`                                                                      |
| Timed out   | `timed-out`                                                                   |
| Skipped     | `skipped`                                                                     |
| Did not run | `did-not-run` (an execution with zero attempts)                               |
| Other       | `interrupted`, `unexpected-pass`, `expected-failure`, `unclassified`          |

The columns **reconcile exactly** to the Executions column: every normalizer
outcome maps to exactly one column. An "Other" value is never hidden; it is
listed with its outcome names.

Instance **counts** are shown, because they are the configured project
instances that reported a result. README outcome columns are reserved for
**execution** outcomes; instance-level outcomes (the worst execution outcome
per instance) are not shown as outcome columns. Unit-test outcomes are a
separate, separately labelled table and are never added to Playwright
outcome columns.

Unit-test columns are the reporter's own figures (`tests`, `suites`, `pass`,
`fail`, `cancelled`, `skipped`, `todo`), shown as reported. The expected
reconciliation is `tests = pass + fail + cancelled + skipped + todo`. A local
throwaway check on Node v24.22.3 was consistent with this for passing,
failing, skipped and todo tests, subtests (counted with their parent), a
`describe` suite (counted in `suites`) and loop-generated tests. It did not
exercise cancellation, so **the treatment of cancelled tests is unverified**,
and that check is an observation, not a specification of `node:test`. If a
snapshot's figures do not reconcile, or any `cancelled` value is non-zero,
the unit table is **Partial evidence** until the behaviour is confirmed. The
observation must be repeated when Node.js is upgraded.

### 6. Missing, partial and stale evidence

- **Missing**: a value whose source evidence (artifact, log or run metadata)
  is expired, absent or unreadable **when the baseline is collected** is
  **Unavailable — <reason>**, never zero, never a pass. Evidence that expires
  **after** a snapshot was verified does not erase that pinned historical
  snapshot: its recorded values stay, and the snapshot discloses that
  independent rechecking is no longer available (see
  [Evidence handling](#9-evidence-handling)).
- **Partial**: a summary with `testData.state` `unavailable`, any non-zero
  completeness problem counter (`unrecognizedProjectExecutions`,
  `unresolvedIdentities`, `ambiguousIdentities`, `inconsistentExecutions`,
  `provisionalOutcomes`, `unclassifiedAttempts`), `statsCrossCheck` other than
  `match`, any observed Gate input other than `success`, or a unit summary
  missing any field. The values are still shown, with a **Partial evidence**
  note naming the reason; they are never presented as a clean result.
- A missing report is never read as success, and a missing group is never
  inferred from configuration.
- **Freshness** is a **manual policy assessment**, made by the author and
  reviewer of each README PR and not automated in this phase. The snapshot
  always describes its pinned source run, never `HEAD`. It is marked
  **Stale** when either holds:
  - a test-affecting change has landed on `main` since the source commit. The
    minimum paths to check are `tests/`, `src/`, `dashboard/`, `scripts/`,
    `playwright.config.ts`, `package.json`, `package-lock.json` and
    `.github/workflows/`; the list is a minimum, not exhaustive. A change
    whose effect on test results is unknown (for example tool, Node.js or
    browser versions, configuration or environment) is flagged for review
    and treated as stale until a reviewer decides otherwise; or
  - more than 30 days have passed since the source run **completed** (the
    completion time of its last job).

### 7. Provenance

Each snapshot records, from the run itself:

| Field                   | Source                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Source commit           | Run `headSha` (40 hex), equal to summary `run.headSha`                                                            |
| Run ID and attempt      | Run `databaseId` and `attempt`, equal to summary `run.runId` / `run.runAttempt`                                   |
| Run URL                 | `https://github.com/<owner>/<repo>/actions/runs/<runId>/attempts/<attempt>`                                       |
| Event and branch        | Run `event` (`push`) and branch `main`, equal to summary `run.event` / `run.branchClass`                          |
| CI execution time       | Run start and completion; the `checks` and `shard` job start and completion times                                 |
| Summary generation time | Summary `run.generatedAt` — when the summary was written, after the shards finished; it is not the execution time |
| Snapshot date           | The date the README PR was prepared                                                                               |

The Gate verdict is **not** taken from the summary (`ciVerdict` is always
`not-recorded-in-summary`). The snapshot may state the run's conclusion as
reported by GitHub with a link to the run; it does not label it a verified
verdict unless it came from the ADR-0010 operator or an ADR-0011 publication.

### 8. A snapshot is tied to its source commit, not to the README's commit

Merging the README PR creates a new `main` commit that is not the snapshot's
source commit. The snapshot therefore never says "current", "latest" or "this
commit"; it says "as of commit `<sha>`, run `<id>` attempt `<n>`" and keeps
describing that run regardless of later commits. A documentation-only merge
is not a test-affecting change, so on its own it does not make the snapshot
stale under the manual assessment above; any later test-affecting or
unknown-impact change does, until a new snapshot is taken from a run at or
after that change.

### 9. Evidence handling

- The quality-summary artifact is downloaded only to a private directory
  outside the repository and the knowledge vault, inspected read-only and not
  committed. Only aggregate counts, identifiers, timestamps and the file's
  SHA-256 are recorded; no per-instance records are reproduced.
- The checks-job log is read only for the `node:test` summary lines.
- The quality-summary artifact has 7-day retention, and the checks-job log is
  kept for the repository's log-retention period. Opening, updating or
  merging a pull request does **not** extend either. Each snapshot records
  the artifact id, its exact expiration time, the archive digest reported by
  GitHub and the full SHA-256 of the extracted summary file.
- The recorded aggregates are **historical evidence** of what the source run
  reported. They remain valid as a record after the source evidence expires,
  but independent rechecking depends on the source evidence (artifact, log or
  run metadata) still being available; once it is gone, the figures can no
  longer be re-derived, and a snapshot must say so if it is refreshed or
  questioned after that point.

## Verified baseline (Phase A)

Source: run [46038081078](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/runs/46038081078/attempts/1),
attempt 1, `push` to `main`, source commit
`e7ccb456cac437c42402bfe01f5a1f57b398c13a`, conclusion `success`.

| Evidence                        | Value                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run                             | started 2026-11-27T16:58:49Z; completed 2026-11-27T17:02:14Z (last job, `test`); run record last updated 2026-11-27T17:02:15Z                                                                                                                                                                                                                    |
| `checks` job                    | 2026-11-27T16:58:53Z – 16:59:58Z (unit tests)                                                                                                                                                                                                                                                                                                    |
| `shard (1, 2)` / `shard (2, 2)` | 2026-11-27T17:00:00Z – 17:01:34Z / 17:00:00Z – 17:01:55Z; `test` job 17:01:57Z – 17:02:14Z                                                                                                                                                                                                                                                       |
| Summary generated               | `run.generatedAt` 2026-11-27T17:02:10.073Z (report generation, not execution)                                                                                                                                                                                                                                                                    |
| Artifact                        | `quality-summary-1`, id 15217893370, created 2026-11-27T17:02:11Z, **expires 2026-12-04T17:02:10Z** (not extended by any PR); archive digest `sha256:28dc309523871905be1ed686ccb266dc7075149cbdfe7f423fd5721e4f5369a0` (3816 bytes); extracted `quality-summary.json` SHA-256 `191b26b82d4c210848c6077cb823f7028d6be3f8bc97dc15233a85998f498bf4` |
| Summary validity                | Schema 1.0.0; accepted by the committed strict parser (`parseSummary`); `testData` available; every completeness counter 0; `statsCrossCheck` `match`; all eight observed Gate inputs `success`                                                                                                                                                  |

Unit tests (checks-job log, same run and commit):

| tests | suites | pass | fail | cancelled | skipped | todo |
| ----- | ------ | ---- | ---- | --------- | ------- | ---- |
| 866   | 0      | 866  | 0    | 0         | 0       | 0    |

Playwright (quality summary, same run and commit):

| Group                                                       | Definitions | Instances | Executions | Attempts | Retries | Passed  | Flaky | Failed | Timed out | Skipped | Did not run | Other |
| ----------------------------------------------------------- | ----------- | --------- | ---------- | -------- | ------- | ------- | ----- | ------ | --------- | ------- | ----------- | ----- |
| Dashboard functional                                        | 28          | 84        | 84         | 84       | 0       | 84      | 0     | 0      | 0         | 0       | 0           | 0     |
| Dashboard accessibility                                     | 17          | 17        | 17         | 17       | 0       | 17      | 0     | 0      | 0         | 0       | 0           | 0     |
| Application UI                                              | 5           | 11        | 11         | 11       | 0       | 11      | 0     | 0      | 0         | 0       | 0           | 0     |
| **Browser tests subtotal**                                  | **50**      | **112**   | **112**    | **112**  | **0**   | **112** | 0     | 0      | 0         | 0       | 0           | 0     |
| Synthetic-stub API                                          | 6           | 6         | 6          | 6        | 0       | 6       | 0     | 0      | 0         | 0       | 0           | 0     |
| **Playwright tests total (excluding authentication setup)** | **56**      | **118**   | **118**    | **118**  | **0**   | **118** | 0     | 0      | 0         | 0       | 0           | 0     |
| Authentication setup (excluded)                             | 1           | 1         | 1          | 1        | 0       | 1       | 0     | 0      | 0         | 0       | 0           | 0     |
| Unclassified                                                | 0           | 0         | 0          | 0        | 0       | 0       | 0     | 0      | 0         | 0       | 0           | 0     |
| **Raw summary totals**                                      | **57**      | **119**   | **119**    | **119**  | **0**   | **119** | 0     | 0      | 0         | 0       | 0           | 0     |

Reconciliation: browser tests subtotal 28 + 17 + 5 = 50 definitions and
84 + 17 + 11 = 112 instances, executions and attempts; adding synthetic-stub
API gives 50 + 6 = 56 definitions and 112 + 6 = 118 instances, executions and
attempts for the Playwright tests total (excluding authentication setup);
adding setup and Unclassified gives 56 + 1 + 0 = 57 definitions and
118 + 1 + 0 = 119 instances, executions and attempts, the raw summary totals;
0 retries; 118 + 1 = 119 passed. Unit-test results are separate and are not
part of any of these totals. Every instance has
`multiplicity` `single` in this run (setup ran in one shard only), no
definition spans two groups, and no shared test locations were reported. The
figures describe this run only; a different shard distribution can give the
setup instance two executions.

## Consequences

- The README can show precise, reconciled figures with their units and source,
  instead of a single ambiguous test count.
- Every update is a reviewed PR with recorded evidence; nothing changes the
  README automatically.
- The snapshot ages: after any test-affecting change it is visibly stale until
  refreshed.
- Source evidence expires (artifact after 7 days, logs after the repository's
  retention period); after that a snapshot is a historical record that can no
  longer be independently rechecked.
- Unit-test results depend on a human reading the job log until a structured
  unit-test output exists.

## Alternatives considered

- **Counting `test()` calls or using `--list`.** Rejected: discovery is not a
  result, and source counts miss parameterized tests.
- **Grouping by tag or project.** Rejected: tags overlap (`@a11y` spans two
  groups) and projects mix dashboard and application tests.
- **Folding setup into the totals.** Rejected: it is not a product test; it is
  shown separately and reconciled instead.
- **A CI job that commits README updates.** Rejected for now: it needs write
  permission on a protected branch.
- **Badges from a hosted endpoint.** Rejected: hosting is not authorized.
- **Extending the ADR-0011 manifest.** Rejected for this purpose: it would
  change a frozen publication contract.

## Implementation status and future work

- Phase B: **drafted** in this change (the manual README snapshot); later
  refreshes follow this record through pull requests.
- Phase C (automated generation): a pure grouping function over the quality
  summary, a structured unit-test result, and job-summary output; each needs
  its own approval, and any workflow change its own review.

## Open questions

- How `node:test` counts cancelled tests in `tests` and `pass` is
  **unverified**; the local throwaway check did not exercise cancellation and
  is not proof of the reporter's semantics.
- How long this repository retains Actions job logs; the unit figures above
  were read from the log on 2026-11-28 and are recorded here in case it
  expires.
- Whether a later phase should show instance-level outcomes anywhere outside
  the README outcome columns.

## Verification

Phase A evidence was read from run 46038081078 on 2026-11-28: run and job
metadata through the GitHub API, the `node:test` summary lines from the
`checks` job log, and the `quality-summary-1` artifact, validated with the
committed `parseSummary` and grouped by the rules above. The artifact was kept
outside the repository and the vault.

## Related

- [ADR-0006](0006-api-request-layer.md) — API request layer and synthetic stub
- [ADR-0007](0007-ci-sharding-and-merged-reports.md) — sharding, merged reports, Gate
- [ADR-0009](0009-quality-reporting-dashboard.md) — quality summary and counting units
- [ADR-0010](0010-quality-verdict-provenance.md) — verdict provenance
- [ADR-0011](0011-verdict-evidence-publication.md) — verdict publication
