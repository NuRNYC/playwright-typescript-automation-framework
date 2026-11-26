# ADR-0009: Metadata-only quality summary and static reporting dashboard

- **Status:** proposed
- **Date:** 2026-11-25
- **Scope:** Proposed M8 (reporting). Builds on
  [ADR-0005](0005-recording-and-execution-boundary.md),
  [ADR-0007](0007-ci-sharding-and-merged-reports.md) and
  [ADR-0008](0008-failure-triage-annotations.md); changes none of them.
- **Implementation:** none. This record documents a design. No normalizer,
  CLI, viewer or CI step exists, and the workflow is unchanged.
- **Amended by:** [ADR-0010](0010-quality-verdict-provenance.md) (2026-11-26) —
  provenance and verdict contract; see the notes below.

> **Amended by [ADR-0010](0010-quality-verdict-provenance.md) on 2026-11-26.**
> The record above is kept as written on 2026-11-25. Since then:
>
> - **Implemented and merged:** M8A normalizer (PR #21), M8B CLI (PR #22),
>   M8C-1 model (PR #23), M8C-2A static viewer (PR #24), M8C-2B browser and
>   accessibility tests (PR #25) and M8D advisory CI steps (PR #26). The
>   "Implementation: none" line describes the state at the date above.
> - **Status.** The Status line still reads "proposed". This record's own
>   Verification section says it is accepted when reviewed and merged, which
>   happened in PR #20, but the line was not updated at the time. It is left
>   unchanged here; recording acceptance is the maintainer's decision.
> - **M8D as built.** The summary steps run only on `push` and on
>   same-repository pull requests (fork pull requests are skipped), record the
>   pull request's head SHA (`github.event.pull_request.head.sha`, else
>   `github.sha`) and upload exactly `quality-summary/quality-summary.json` as
>   `quality-summary-<run_attempt>` for 7 days. The Gate is unchanged.
> - **Verdict.** ADR-0010 replaces the single "GitHub API join" below with a
>   trust policy (only `push` runs on protected `main` can be verified; every
>   pull-request run is `UNTRUSTED_PROVENANCE`), eight verdict states, separate
>   summary states and an identity contract. The join runs in a local operator
>   tool, not in the browser.

## Context

Reporting today (Playwright 1.64.1):

- Each CI shard runs with `--reporter=list,blob` and uploads
  `blob-report-<i>` (1-day retention). The `test` job inventories, downloads
  by exact name and verifies both blobs, then runs
  `merge-reports --reporter html,json`, uploads `playwright-report` (7-day
  retention) and runs the advisory triage step (ADR-0007, ADR-0008).
- The merged JSON is written to `$RUNNER_TEMP/triage/results.json`, outside
  every uploaded path. It is discarded with the runner, so **no durable,
  machine-readable per-test history exists**. The HTML and blob artifacts
  expire after 7 days and 1 day and contain sensitive material (S1–S9 in the
  [security policy](../security-testing-policy.md)); this public repository
  exposes them to anyone.
- Run, job and step conclusions and artifact metadata are available through
  the GitHub REST API. Steps are identified there by name only; several
  gate-input steps are unnamed.
- Observed during the read-only audit on 2026-11-25: 66 workflow runs, of
  which 20 failed, and 19 of those ran on deliberate failure-path probe
  branches (`probe/m6-ci-failure-paths`, `probe/m7-triage-paths`). Treating
  probes as ordinary runs would distort any quality metric.

Read from the installed Playwright 1.64.1 source:

- The JSON reporter groups tests that share a title and location into one
  spec and lists each project's test inside it. A result carries `retry`,
  `status`, `duration` and `startTime`, but **no shard index and no
  `repeatEachIndex`** (the type definition declares `shardIndex` optional; the
  serializer does not write it). `config.projects[].repeatEach` is present.
- `merge-reports` merges with `mergeTestCases: false`, so the `setup` test
  run on both shards appears as two test entries with the same project,
  title and location (ADR-0008 observed suffixed spec ids).
- Test-level status is computed so that an `interrupted` attempt counts as
  neither expected nor unexpected: a test whose only attempt was interrupted
  is reported as `skipped`. This is source-derived, not yet reproduced.

## Decision

Produce a **metadata-only, versioned quality summary in CI** and render it in
a **static viewer**:

1. A pure TypeScript normalizer,
   `normalize(report: unknown, context: ValidatedRunContext): QualitySummary`,
   free of `@/` imports so `node --test` can load it (ADR-0002).
2. A thin CLI wrapper that reads the merged JSON and the run context and
   writes `quality-summary.json`.
3. A versioned schema (`schemaVersion`, semantic versioning: a major version
   for any removed or changed field or enum value).
4. An artifact `quality-summary-<run_attempt>` with **7-day** retention.
5. A static viewer that reads summaries; no database and no hosted backend.
6. A GitHub API join for the authoritative CI verdict.

No new dependencies are approved for the normalizer.

### CI authority

The Gate keeps its eight inputs unchanged:

| Input      | Expression                 |
| ---------- | -------------------------- |
| CHECKS     | `needs.checks.result`      |
| SHARDS     | `needs.shard.result`       |
| INVENTORY  | `steps.inventory.outcome`  |
| DOWNLOAD_1 | `steps.download-1.outcome` |
| DOWNLOAD_2 | `steps.download-2.outcome` |
| VERIFY     | `steps.verify.outcome`     |
| MERGE      | `steps.merge.outcome`      |
| UPLOAD     | `steps.upload.outcome`     |

- The summary is generated **before** the Gate. It may record these eight
  values as `observedGateInputs` (each `success`, `failure`, `cancelled`,
  `skipped`, `unavailable` for an empty value, or `unknown`) and states
  `ciVerdict: "not-recorded-in-summary"`. It never contains a final verdict.
- The verdict is the conclusion of the completed `Gate` step of the `test`
  job, joined by run id and run attempt. A missing, unmatched or unfinished
  API record is shown as UNKNOWN (or PENDING), never as success. Test results
  alone never produce a passing verdict.
- Summary generation and upload are advisory (`continue-on-error`) and are
  not Gate inputs. Making them gate inputs requires separate approval.

> **Amended by [ADR-0010](0010-quality-verdict-provenance.md) on 2026-11-26.**
> "Joined by run id and run attempt" is refined: the verdict is taken only from
> the attempt-specific run and jobs APIs, must match repository, workflow, run
> id, attempt and head SHA, and is VERIFIED only for trusted `push` runs on
> `main`. A missing Gate is `EXECUTION_FAILED` or `UNKNOWN`, a cancelled run is
> `CANCELLED`, and a pull-request run is `UNTRUSTED_PROVENANCE` — never
> success. Artifact downloads require a token, so the viewer itself makes no
> API calls.

### Security

Allow-list by construction: every output object is built field by field from
validated values; input objects are never spread, cloned or passed through.

| Allowed                                                            | Validation                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Project name                                                       | One of the configured projects, else `unrecognized`                |
| Repository-relative spec file, line, column                        | Spec-file pattern, no `..`, length and range limits                |
| Tags                                                               | Allow-list (`smoke`, `a11y`, `api`); others dropped, counted       |
| Attempt status, retry index, duration                              | Enums and bounded integers                                         |
| Run id, run attempt, event, commit SHA                             | Integers, enum, 40-character hex                                   |
| Branch class (`main`, `pull-request`, `probe`, `other`, `unknown`) | Classified from the branch reference; the raw name is never output |

Prohibited in the summary: raw test titles and title paths; error messages,
stacks and error locations; stdout and stderr; steps; attachments, including
screenshots and traces; cookies and saved session state; absolute paths;
raw branch names; git diffs and commit metadata; author information; PR
titles; environment values; arbitrary annotations and report metadata.

Required before any summary is treated as public-safe:

- Input limits (report size, suite depth, execution and attempt counts,
  string lengths, output size); exceeding a limit yields an unavailable
  summary, never a truncated one.
- Secret-canary tests that place a unique string in every prohibited field
  at every input level and in the raw branch context, and assert it is
  absent from the serialized output.
- Fixed, value-free error reasons; no raw error text in logs.
- Restricted targets never produce a summary (they are refused in CI by
  ADR-0005); a local CLI run against a restricted tier must refuse.

A public artifact is not considered safe until these checks pass.

### Test identity and aggregation

- The normalizer may use the full title **internally** to distinguish tests;
  the output never contains it.
- Output identifiers are per-run ordinals (`instanceId`, `definitionId`)
  assigned after a deterministic sort. They are stable only for identical
  input.
- File, line and column alone are insufficient: loop-generated tests share a
  location. A `locationGroupSize` makes shared locations visible.
- Entries with an identical internal key in a project whose `repeatEach` is
  1 are grouped as one instance with several executions and marked
  `inferred-duplicate`. This is an inference from the CI design (setup runs
  on each shard), **not proven shard attribution**. With `repeatEach` greater
  than 1 the entries stay separate and are marked ambiguous.
- Entries without a valid location or title are `unresolved` and never merged.
- Definitions, instances, executions, attempts and retries are separate
  metrics. Retries are counted from `retry > 0`; an execution may have zero
  attempts (`did-not-run`).
- Grouped instances retain every execution's outcome and a `conflict` flag
  when they disagree.
- Stable identity across runs and commits is deferred until explicit,
  reviewed test identifiers exist.

### Interrupted outcomes

Because an interrupted-only test is reported as `skipped` at test level, the
normalizer derives execution outcomes from attempt statuses and cross-checks
them against the reported status; a mismatch is flagged, not silently
resolved.

**Pending implementation validation:** a failed attempt followed by an
interrupted attempt must keep the evidence of the earlier failure (the
attempt records and a flag), even if the execution's terminal outcome is
classified as interrupted. The precedence between these outcomes is not
decided here; it must be fixed by tests in M8A before any viewer relies on it.

### Completeness

A valid merged JSON report is not an independent inventory of discovered
tests. The summary distinguishes available, unavailable (with a fixed
reason), unverified, inconsistent, unresolved identity, ambiguous grouping
and missing report evidence. Tests absent from the report are never
invented, and execution counts are never presented as requirement coverage.

### Determinism

`normalize` reads no clock, filesystem, network or environment and no
process-global mutable state. Timestamps and run metadata arrive through
`ValidatedRunContext`; the generator and schema versions are constants.
Objects are built in a fixed key order, arrays are sorted with total,
locale-independent comparators, durations are integer milliseconds, and the
same report and context produce byte-identical output.

## Consequences

- Minimal operational complexity: no database, server or new dependency.
- One additional advisory step and one additional public CI artifact.
- History is limited to retained summaries (7 days) and begins with the
  first summary; expired artifacts cannot be backfilled.
- The viewer depends on GitHub API access for verdicts.
- Identity is per run; cross-run trends per test are not possible yet.
- Reporting fidelity is bounded by the source report; gaps are shown as
  UNKNOWN or NOT AVAILABLE, never as zero.
- Publishing a viewer or a public summary requires a completed security review.

## Alternatives considered

| Alternative                                        | Why rejected or deferred                                        |
| -------------------------------------------------- | --------------------------------------------------------------- |
| Parsing local or CI HTML reports                   | Sensitive attachments; not a stable machine format              |
| Hosted ingestion with a database                   | Operational cost, credentials and write tokens disproportionate |
| Storing raw Playwright JSON publicly               | Contains errors, paths, git metadata and diffs                  |
| Hashing titles for privacy                         | Low-entropy titles are guessable; no confidentiality gained     |
| Embedding the Gate verdict in the pre-Gate summary | The verdict does not exist yet; would be fabricated or circular |
| Public dashboard before security review            | Deferred until the M8E checks pass                              |
| Cross-run identity before explicit test ids        | Line and title changes would silently merge or split history    |

## Future implementation (not implemented)

Each stage requires its own authorization:

- **M8A** — pure normalizer and synthetic unit tests (counting invariants,
  identity, interrupted handling, canaries, determinism).
- **M8B** — thin CLI and run-context adapter.
- **M8C** — static viewer using synthetic data only.
- **M8D** — advisory CI integration (summary step and artifact; the Gate
  unchanged).
- **M8E** — security and production-readiness review.
- **M8F** — optional publication decision.

> **Amended by [ADR-0010](0010-quality-verdict-provenance.md) on 2026-11-26.**
> M8A–M8D are implemented (see the note at the top). M8E is split: M8E-1
> security audit (done), M8E-2 contract (ADR-0010), M8E-3 pure verdict
> reconciliation, M8E-4 read-only API transport and local operator tool,
> M8E-5 integration verification. M8F remains unauthorized.

## Verification

This record is documentation only. It is accepted when this decision is
reviewed and merged; each implementation stage carries its own verification.

## Related

- [ADR-0007](0007-ci-sharding-and-merged-reports.md) — blob reports, merge and the eight-input Gate
- [ADR-0008](0008-failure-triage-annotations.md) — advisory triage of the merged JSON
- [`docs/security-testing-policy.md`](../security-testing-policy.md) — exposure surfaces S1–S10
- `.github/workflows/tests.yml`
