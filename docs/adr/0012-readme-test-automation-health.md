# ADR-0012: README Test Automation Health snapshot

- **Status:** accepted — the metric definitions, evidence rules and the manual
  README snapshot (Phases A and B) were approved by the maintainer on
  2026-11-28. Automated generation (Phase C) needs its own authorization.
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
  Phase B (the manual README snapshot) are delivered in this change, as the
  "Test Automation Health" section of `README.md`. Code, workflows and
  publication contracts are unchanged.
- **Amended:** 2026-11-28 — Phase C4 README refresh from production CI evidence; 2026-11-28 — Phase C3 CI integration; 2026-11-28 — Phase C1 and C2 implementation contracts; see
  [Amendments](#amendments). The decisions above are kept as written.

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

- Phase B: **delivered** in this change (the manual README snapshot); later
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

## Amendments

### 2026-11-28 — Phase C1 and C2: test-health model, structured unit results and local CLI

Authorized by the maintainer on 2026-11-28 as Phase C, increments C1 and C2.
The accepted decisions above are unchanged; this amendment records how the
automated pieces implement them. **C3 (CI job summary and health artifact)
remains future work** and needs its own authorization. The README snapshot is
not generated or changed by any of this.

**C1 (merged, PR #51).** `src/reporting/test-health.ts` is a pure model and
Markdown renderer over the committed strict quality-summary parser
(`parseSummary`) and a typed unit-result value. It applies sections 2–7 of this
record, evaluates the unit and Playwright sections independently, never
combines inputs whose run identity differs, labels CI output a diagnostic
(never a README snapshot) and local output local, and claims no Gate verdict,
workflow conclusion, completion time or freshness.

**C2 contracts.**

1. **Structured unit reporter.** `scripts/unit-test-reporter.ts` is a custom
   reporter for the supported `node:test` reporter interface. It writes one
   JSON document only after the stream ends, built from allow-listed aggregate
   fields: the counts of the single final run summary (`test:summary` without
   a `file`), tallies of the per-test pass/fail events, the run's `success`
   flag, the Node.js version and the reporter's own start and end times. It
   writes no test names, file paths, error messages, logs or other runtime
   properties. `npm run test:unit:structured` runs the unit suite with the
   `spec` reporter on standard output (unchanged human-readable output) and
   this reporter to `unit-results/unit-results.json`; the command's exit
   status is the test runner's own. `npm run test:unit` is unchanged.
2. **Observed reporter semantics (Node.js v24.22.3 only).** Executable probes
   in the test suite establish, for the pinned version only: a parent test and
   each subtest are counted in `tests`; `describe` suites only in `suites`;
   generated tests individually; skipped tests in `skipped`; todo tests in
   `todo` even when they fail; failing tests in `failed`; tests that time out
   (`testTimeoutFailure`) or are cancelled by their parent (`cancelledByParent`)
   in `cancelled`; `passed + failed + cancelled + skipped + todo = tests`;
   `success` is false exactly when `failed + cancelled > 0`. An interrupted run
   leaves the destination empty (Node.js truncates it at start), so stale
   content cannot survive. These probes say nothing about other Node.js
   versions.
3. **Unit-result contract** (`unit-test-results` 1.0.0, at most 16 KiB). A
   strict parser accepts exactly the documented keys, safe non-negative
   integer counts, event tallies that equal the summary counts, a `success`
   flag consistent with the counts, a Node.js version string and an ordered
   execution interval; extra properties are rejected, not dropped. An empty
   file is **incomplete** evidence; malformed JSON or a schema violation is **invalid**; counts that do not reconcile (`tests = passed + failed + cancelled + skipped + todo`, with a safe-integer sum), event tallies that differ from the counts, or a `success` flag that contradicts them are **inconsistent**, even when the tallies repeat the same unreconciled counts. A completed run with failing or cancelled tests is valid,
   complete evidence of those failures.
4. **Cancellation semantics.** C1 marked any non-zero `cancelled` count as
   partial evidence because the semantics were unverified. They are now
   verified for Node.js v24.22.3, so unit results produced by that version are
   complete evidence with cancelled tests shown as cancelled (a non-pass
   outcome); results from any other version keep the partial marking until
   that version is probed.
5. **Identity stamping.** The CLI's `stamp` command adds a CI run identity
   (run ID, run attempt and source commit) to an unstamped unit result from
   explicit arguments; it reads no environment variables. The identity is what
   the caller supplied, not independently verified provenance. A result that
   is already stamped is refused, never relabelled. The source commit must be
   the commit of the checkout that was actually tested (for a pull request run
   on GitHub's merge checkout, the merge commit, not the pull request head).
6. **Rendering.** The CLI's `render` command builds the C1 model from a unit
   result and, in CI mode, a quality summary, and writes `test-health.json` and `test-health.md` into a new output directory. Both files are written into a private staging directory created by the invocation next to the requested path, and the directory is published with a single rename only after both writes succeed. A failed render publishes **no** final bundle under the requested path. Cleanup is best-effort: the invocation then removes only the files and the staging directory it created (never recursively), and if that removal fails an unpublished staging remnant may remain, never under the final name; anything that already existed is left unchanged. The output path is re-checked immediately before the rename, but that check is not an atomic no-replace guarantee against a concurrent writer: an empty directory created at the final path between the check and the rename can be replaced (a file or non-empty directory makes the rename fail). In CI mode both inputs
   must carry exactly the run identity given on the command line; any
   mismatch refuses the whole render and writes nothing. A missing or unusable
   input makes only its own section unavailable. Local mode accepts only
   unstamped (local) unit results and is labelled local. The CLI never writes
   `README.md` and never appends to a CI job summary.
7. **Safety and exit status.** Run IDs and attempts must be positive safe integers; anything else is a usage error before any file is read. Inputs and outputs must lie strictly inside the working directory, outside any `.auth` directory; inputs are read through a
   no-follow handle with a size limit; outputs are created exclusively, so an existing file or directory is never overwritten. A `stamp` write failure can leave an unusable partial file at its output path; consumers must strictly validate any unit-results file (the parser rejects a partial document as invalid, never as a pass). Exit status: `0` output
   written, `1` refused (unsafe or missing path, unusable stamp input, already
   stamped, provenance mismatch, existing output, write failure, internal
   error), `2` usage error. The generator's exit status says whether the
   health output was produced; it never says the tests passed. A health
   document showing failed tests is written with exit status 0, while the
   test command itself still exits non-zero.

### 2026-11-28 — Phase C3: CI integration (push to main only)

Authorized by the maintainer on 2026-11-28 as Phase C, increment C3. The
accepted decisions and the C1/C2 contracts above are unchanged. The README
snapshot is still maintained by hand (sections 1 and 8); CI never writes it.

1. **Mandatory unit step.** The `checks` job's `Unit tests` step now runs
   `npm run test:unit:structured` instead of `npm run test:unit`: the same
   suite, the same human-readable output and the test runner's own exit
   status, so a unit failure still fails `checks` and therefore the Gate. It
   also writes `unit-results/unit-results.json`.
2. **Event scope.** Every new reporting step runs only when
   `github.event_name == 'push'` **and** `github.ref == 'refs/heads/main'`.
   Pull request runs test GitHub's merge commit while the ADR-0009 summary
   records the pull request head (`QS_HEAD_SHA`), so their identities cannot
   match under the C2 rule; PR health is deferred until a separate
   ADR-0009/ADR-0010 decision records the tested commit. No existing summary,
   verdict or publication contract is changed, and no existing evidence is
   relabelled. On push, `github.sha` is the commit every job checks out and
   tests.
3. **Unit evidence.** After the unit step completed (passing or failing), an
   advisory step stamps the result with `github.run_id`,
   `github.run_attempt` and `github.sha`, passed as explicit arguments, and an
   advisory step uploads exactly the stamped file as
   `unit-results-<run_attempt>` (7 days). If an earlier `checks` step failed,
   the unit tests never ran and nothing is stamped.
4. **Health job.** A separate `health` job (`needs: [checks, test]`, skipped
   when the run is cancelled) checks out `github.sha` and confirms the
   checkout equals it, downloads exactly `unit-results-<run_attempt>` and
   `quality-summary-<run_attempt>`, renders with the C2 CLI in CI mode into a
   fresh `test-health/` directory, appends the Markdown to the job summary
   (or one fixed line when nothing was rendered), and uploads exactly
   `test-health/test-health.json` and `test-health/test-health.md` as
   `test-health-<run_attempt>` (7 days) after a successful render only.
5. **Advisory by construction.** The `health` job is not the required check
   and not a Gate input; it has job-level and step-level
   `continue-on-error` so that its failure does not change the run
   conclusion (the ADR-0010 reconciler would otherwise see a contradiction),
   and workflow permissions are unchanged (`contents: read`). The `test`
   job, its steps, the Gate and its eight inputs are unchanged.
6. **Failure behaviour.** A unit failure produces a health report showing the
   failed counts with the Playwright section unavailable (the shards and the
   summary did not run). A missing unit or summary artifact makes only its
   own section unavailable. A provenance mismatch refuses the render; the
   job summary then carries the fixed "not generated" line and nothing is
   uploaded.
7. **Re-runs.** Every artifact name carries the run attempt, and the health
   job downloads only the current attempt's names, so evidence from
   different attempts is never combined. Under "re-run failed jobs", a job
   that is not re-executed produces no artifact for the new attempt: for
   example, if `checks` passed in attempt 1 and only `test` is re-run, attempt
   2 has no `unit-results-2` and its unit section is reported as missing,
   never filled from attempt 1.
8. **Behavioral validation (2026-11-28).** Seven isolated probes ran as push
   runs on `probe/c3-*` branches, each one commit made from feature commit
   `850b9f9`. Each probe changed only the trigger and the three event/ref
   conditions to its probe ref, plus its own injection; none of these
   changes is in the production workflow, and no probe was merged.

   | Probe                                                                                                                | Injection                                                     | Observed                                                                                                                                                                                                                         |
   | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Clean ([46160847429](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/runs/46160847429)) | none                                                          | Run success; Gate inputs all `success`; `unit-results-1`, `quality-summary-1` and `test-health-1` (exactly `test-health.json` and `test-health.md`); unit complete; Playwright complete, raw totals equal to the quality summary |
   | P1 ([46161230101](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/runs/46161230101))    | failing synthetic unit test                                   | Unit step failed (1 failure); `checks` failed, shards skipped, Gate failed on `CHECKS`; unit results still stamped and uploaded; health: unit complete with the failure, Playwright `summary-missing`                            |
   | P2 ([46161232361](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/runs/46161232361))    | stamp output path refused                                     | No unit artifact; health: unit `unit-results-missing`, Playwright complete; Gate and run success                                                                                                                                 |
   | P3 ([46161233739](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/runs/46161233739))    | quality-summary usage error                                   | No summary artifact; health: unit complete, Playwright `summary-missing`; Gate and run success                                                                                                                                   |
   | P4 ([46161235195](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/runs/46161235195))    | stamp with attempt 99                                         | Render refused (`provenance-mismatch`), no health artifact; Gate and run success                                                                                                                                                 |
   | P5a ([46161237468](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/runs/46161237468))   | render forced to fail, step-level `continue-on-error` kept    | No health artifact; `health` job success; Gate and run success                                                                                                                                                                   |
   | P5b ([46161239992](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/runs/46161239992))   | render forced to fail, step-level `continue-on-error` removed | `health` job failure; `test` job and Gate success; **run conclusion success** (job-level `continue-on-error` holds)                                                                                                              |

   In every probe the health checkout equalled the run's commit and the
   render used that run's ID and attempt. **Not verified:** the job-summary
   display. Its contents are not exposed by the GitHub CLI or API and were
   not inspected directly; on the success path the appended text is the
   uploaded `test-health.md`, and the fallback line for P4, P5a and P5b is
   written only to the job summary, not to the log.

### 2026-11-28 — Phase C4: README refresh from production CI evidence

Authorized by the maintainer on 2026-11-28 as Phase C, increment C4. The
README section is refreshed **by hand** from one completed production run,
following sections 1–9 of this record; there is still no automatic README
refresh, bot commit, write token or workflow change. The earlier Phase A
baseline above is kept as a historical record.

**Design choice.** No new code. The C1 model already produces every README
figure, so a separate README renderer would only duplicate it. The values
were taken from the run's `test-health-1` bundle after the checks below; the
CI diagnostic renderer is unchanged.

**Evidence review procedure** (operator-reviewed; none of these checks is
performed or asserted by the health bundle itself):

1. The run belongs to `NuRNYC/playwright-typescript-automation-framework`,
   workflow `.github/workflows/tests.yml`, event `push`, branch `main`,
   status `completed`, and its `head_sha` is the source commit.
2. The quality summary passes the committed strict parser (`parseSummary`)
   and is consistent; the stamped unit result passes the strict unit parser.
3. Run ID, run attempt and source commit agree across the run, the stamped
   unit result, the quality summary and the health bundle.
4. The Gate verdict is obtained from the ADR-0010 local operator for that
   run attempt, never inferred from the quality summary.
5. The C1 model is rebuilt with `healthModel` from the strictly parsed
   quality summary and unit result, in `ci` mode, using the bundle's own
   recorded `generatedAt` (2026-11-28T16:00:25.379Z) together with the run
   ID, run attempt and source commit, so both sides have identical inputs.
   The recomputed model serialized with `JSON.stringify` equals the parsed
   CI `test-health.json` serialized the same way (key order and every
   value). This is a structural comparison of the parsed document, not a
   comparison of the raw file bytes.
6. No test-affecting change has landed on `main` since the source commit
   (section 6), so no newer run is needed.

**Evidence record** (aggregates and provenance only):

| Item                | Value                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run                 | [46162493309, attempt 1](https://github.com/NuRNYC/playwright-typescript-automation-framework/actions/runs/46162493309/attempts/1); `push` to `main`; source commit `305665bd54df997d7040078e7e57becf83f86b0c` (merge of PR #53)                                                                                                                                                     |
| Execution           | run started 2026-11-28T15:56:36Z; `test` job completed 16:00:17Z; last job (`health`) completed 16:00:29Z — the snapshot's completion time                                                                                                                                                                                                                                           |
| Unit execution      | reporter clock 2026-11-28T15:57:02.143Z to 15:57:38.222Z, Node.js v24.22.3                                                                                                                                                                                                                                                                                                           |
| Report generation   | quality summary `run.generatedAt` 2026-11-28T16:00:12.243Z; health bundle `generatedAt` 2026-11-28T16:00:25.379Z (generation, not execution)                                                                                                                                                                                                                                         |
| Gate verdict        | ADR-0010 operator: `VERIFIED_PASS` (`gate-success`); summary `SUMMARY_VERIFIED_ORIGIN` (`verified-origin`), archive digest verified; the bundle is kept privately outside the repository                                                                                                                                                                                             |
| `unit-results-1`    | id 15270263244, archive digest `sha256:cabfe1dae6cb3357b3532a17830f3849fa1f9c64a30fac97020aa3441d03b71c`, expires 2026-12-05T15:57:38Z; `unit-results.stamped.json` SHA-256 `c9c4d897bccf792facbf7d99be334949bc0601a238a4104fa5e6af44e3b50ceb`                                                                                                                                       |
| `quality-summary-1` | id 15270646178, archive digest `sha256:2aaac247a079fbfa45c8fd19abfc25114441270b1f24f5a697b50830225ca594`, expires 2026-12-05T16:00:12Z; `quality-summary.json` SHA-256 `bddeb19cc8b895cb6c79928bbab09d7b5876fbd4fba870f980658df6e9ff3f61`                                                                                                                                            |
| `test-health-1`     | id 15270323417, archive digest `sha256:bbf2d3cf5d4293e971c82df68d63bbe1890ebe9691e77a839f7f7d6b698d6ec1`, expires 2026-12-05T16:00:25Z; exactly `test-health.json` (SHA-256 `f04b090c838bf27c17bfbb9887fa9a1a0b6496a72b4fbafbacfdf1e64c3c69de`) and `test-health.md`                                                                                                                 |
| Unit results        | 924 tests: 924 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo, 0 suites; event tallies equal the counts                                                                                                                                                                                                                                                                            |
| Playwright          | dashboard functional 28/84/84, dashboard accessibility 17/17/17, application UI 15/41/41, browser subtotal 60/142/142, synthetic-stub API 6/6/6, Playwright total excluding setup 66/148/148 (definitions/instances/executions); setup 1/1/1; Unclassified none; raw totals 67/149/149 equal to the quality summary; 149 passed, every other outcome 0, 0 retries; evidence complete |

**Limitations.** The figures are historical evidence of this run; once the
artifacts expire they can no longer be re-derived (section 9). Freshness is
still a manual assessment. **The Actions job-summary display was not
visually inspected** and remains unverified.

## Related

- [ADR-0006](0006-api-request-layer.md) — API request layer and synthetic stub
- [ADR-0007](0007-ci-sharding-and-merged-reports.md) — sharding, merged reports, Gate
- [ADR-0009](0009-quality-reporting-dashboard.md) — quality summary and counting units
- [ADR-0010](0010-quality-verdict-provenance.md) — verdict provenance
- [ADR-0011](0011-verdict-evidence-publication.md) — verdict publication
