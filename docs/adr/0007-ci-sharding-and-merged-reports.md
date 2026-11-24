# ADR-0007: CI sharding with verified blob reports and one merged HTML report

- **Status:** accepted
- **Date:** 2026-11-24
- **Scope:** M6. Builds on [ADR-0003](0003-authentication-storage-state.md),
  [ADR-0005](0005-recording-and-execution-boundary.md) and
  [ADR-0006](0006-api-request-layer.md); changes none of them.

## Context

The roadmap defined M6 as "CI sharding, blob reporters, merged report". It is
a **scaling capability**, not a speed optimisation. Measured on main CI run
45456778350 (one job, 72 s): browser installation took 39 s and the whole
Playwright suite 16 s. Every shard pays the installation again, so at 18 tests
sharding makes a run slower and uses more runner time. It pays off only once
test time dominates setup time.

The required status check on `main` is the context `test` (GitHub Actions).
A matrix job reports as `shard (1, 2)` and so on, so a job literally named
`test` has to remain, and it has to stay meaningful.

Measured in isolated copies with Playwright 1.64.1:

| Behaviour                                | Observed                                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--shard=i/2` with `fullyParallel: true` | splits by test; today 10 + 9 executions — the 18 logical tests once each, plus `setup` **once per shard** that holds authenticated tests                   |
| Distribution                             | shifts as tests are added: one extra test moved every authenticated test into one shard and `setup` ran once                                               |
| Blob reporter                            | `blob-report/report-<i>.zip`, `i` zero-padded to the width of the total; holds `report.jsonl` and, for failures, `resources/<sha1>.<ext>` attachments      |
| `merge-reports`, both shards             | 19 entries (`setup` twice, as separate entries, not retries); project attribution kept; `machines` records both shards                                     |
| `merge-reports`, one shard missing       | **exit 0**, fewer tests, no warning                                                                                                                        |
| `merge-reports`, one blob twice          | **exit 0**, every test counted twice                                                                                                                       |
| `merge-reports`, merged tests failed     | **exit 0** (json and html reporters)                                                                                                                       |
| `merge-reports`, a non-ZIP blob          | exit 1                                                                                                                                                     |
| `merge-reports` without `-c`             | loads **no** project configuration (`loadEmptyConfigForMergeReports`), so `playwright.config.ts`, `@/config` and both ADR-0005 checkpoints never run       |
| CI metadata (`captureGitInfo` default)   | under GitHub Actions: commit subject and body, author and committer name and email, branch, CI links; on pull requests also the PR title and full git diff |

## Decision

### Three jobs

| Job      | Runs                                                                                                       | Condition                         |
| -------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `checks` | typecheck, ESLint, Prettier, unit tests — once, before any browser download                                | every run                         |
| `shard`  | matrix `1..2`, `fail-fast: false`; `npm test -- --shard=i/2 --reporter=list,blob`; uploads `blob-report-i` | `needs: checks` (default success) |
| `test`   | the required check: inventory, download ×2, verify, merge, upload, **gate**; `actions: read` (job only)    | `if: always()`                    |

The reporter is overridden on the command line in the workflow only. The
configured reporters, `recordingPolicy` and ADR-0005 are unchanged, and local
`npm test` still writes the HTML report.

### Report generation is separate from the gate

The report steps only produce artifacts. Each has an explicit condition,
because a step's default `success()` looks only at earlier steps of the same
job:

| Step       | Runs when                                          | Purpose                                                              |
| ---------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| inventory  | not cancelled, shards ran                          | the run's artifact **names** must be exactly the expected set        |
| download-1 | not cancelled, `npm ci` succeeded                  | `blob-report-1` by exact name into `all-blob-reports/blob-report-1/` |
| download-2 | not cancelled, `npm ci` succeeded                  | `blob-report-2` by exact name into `all-blob-reports/blob-report-2/` |
| verify     | both downloads succeeded                           | completeness and structure of each archive (below)                   |
| merge      | inventory, both downloads **and** verify succeeded | one HTML report from the two verified archives only                  |
| upload     | merge succeeded                                    | `playwright-report`, 7 days, `if-no-files-found: error`              |
| gate       | `always()`                                         | the only step that decides the result                                |

The gate requires `needs.checks.result`, `needs.shard.result` and the outcome
of inventory, download-1, download-2, verify, merge and upload to be
**exactly** `success`. A `failure`, `cancelled`, `skipped` or empty value fails
it. It never tests `!= 'failure'`, and it never infers test results from
`merge-reports`, whose exit code is 0 for failed tests. Neither a successful
merge nor a successful verification is evidence that tests passed: the shard
job results are.

**Verify before merge.** `merge-reports` only ever receives the two archives
that the inventory, both exact-name downloads and the verifier accepted; it is
not invoked when any of them failed, so a rejected archive is never opened and
no partial report is produced. Failing _tests_ do not block the merge: valid
blobs from a failing shard still give a diagnostic HTML report, and the gate
fails on the shard result. (Before this, the merge ran whenever the download
succeeded; negative test N4 showed it opening a corrupt blob.)

### The artifact set is inventoried, and each blob is fetched by name

- **Exact-name downloads.** Each shard's artifact is downloaded by its exact
  name into its own folder, so the layout does not depend on how many
  artifacts exist and one shard can never stand in for another. (A `pattern`
  download that matched a single artifact extracted it straight into the
  target folder, without a per-artifact folder — observed in N3.) A missing
  name fails its own download step. `merge-multiple` is never used.
- **API inventory.** Exact-name downloads cannot see an unexpected artifact.
  The `test` job therefore has `actions: read` — scoped to that job only; the
  workflow stays `contents: read` — and lists the run's artifacts through the
  REST API with the job token (`gh api --paginate`). It reads names only and
  prints only expected names and record counts. The distinct `blob-report-*`
  names must equal `blob-report-1 .. blob-report-N`: a missing name or any other
  name (for example `blob-report-3`) fails the step. API, permission and
  parsing errors fail it, and so does a listing whose record count differs from
  the reported `total_count` (incomplete pagination). Artifacts outside the
  `blob-report-*` namespace, such as `playwright-report`, are ignored.
- **Re-runs.** The listing covers every attempt of the run. "Re-run failed
  jobs" (N7) left two records named `blob-report-2`; repeated records of an
  expected name are counted and allowed. The exact-name download selected the
  newest record of each name — the re-run shard's new blob and the earlier
  attempt's blob for the shard that was not re-run — and the gate re-evaluated
  the current attempt's job results. An unexpected name left by any earlier
  attempt still fails the inventory.
- **Zero matches.** A `pattern` download that matched nothing reported success
  ("Found 0 artifact(s)", N6). Completeness is therefore never inferred from a
  download step: the inventory and the verifier must establish it.

### Completeness is verified, because Playwright does not

`scripts/verify-blob-reports.ts` (shell) and `src/ci/blob-reports.ts` (pure,
unit-tested) require:

- exactly the directories `blob-report-1 .. blob-report-N`, nothing else;
- exactly one regular file per directory, named as Playwright names it
  (`report-<i>.zip`, padded);
- a readable archive that passes an integrity test;
- exactly one `report.jsonl` entry, otherwise only `resources/<sha1>.<ext>`
  attachment entries, none repeated, none absolute or with `..` segments.

`N` is passed on the command line from `SHARD_TOTAL`; a matrix that disagrees
fails verification. Errors name a shard index and a fixed code only — never a
file name, an archive entry or report content.

**System dependency.** Archives are read with the runner's Info-ZIP `unzip`
(`unzip -Z1` to list, `unzip -tqq` to test; listed in the GitHub-hosted Ubuntu
24.04 image as `unzip 6.0`), called through `execFile` with fixed arguments,
no shell, a 30 s timeout and a 1 MiB output cap. Nothing is extracted. A
missing tool, a timeout, an error or too much output fails closed. Node has no
ZIP reader and the repository has no ZIP dependency; a hand-written ZIP parser
and Playwright's bundled, undocumented `yauzl` were rejected. The step prints
the `unzip` version line as evidence.

### What is deliberately unchanged

- `playwright.config.ts`, `src/config/security.ts`, authentication, the API
  layer and every spec.
- **`captureGitInfo`.** In this public repository the captured identities are
  GitHub noreply addresses and the diff is the public pull request. Revisit
  (for example `{ diff: false }`) if the repository becomes private, accepts
  fork pull requests, or commits stop using noreply addresses.
- **ADR-0005.** Restricted targets cannot run in CI (I3), and `--shard` and
  `--reporter` are not on their allow-list (I5a); a unit test pins `--shard`.
  The merge job loads no configuration, so no checkpoint runs there. That is
  acceptable only because it runs no tests and contacts no target; it must
  never be given `-c`/`--config`.

## Verification

- Unit: 99/99 (87 existing + 1 security + 11 blob-report policy).
- Local, unsharded: `npm test` 18/18, HTML report unchanged.
- Local, two shards plus `merge-reports`: the 18 logical tests each exactly
  once, `setup` twice, 8 projects, complete HTML report.
- Verifier against real blobs and crafted inputs: valid sets pass; non-ZIP,
  truncated, zero-byte, empty, missing `report.jsonl`, duplicate
  `report.jsonl`, unexpected member, absolute and `..` entries, a corrupted
  checksum, a missing shard, an extra shard, an extra or symlinked file, an
  empty or missing root and a missing `unzip` all fail, with sanitized output.
- Pull-request CI: see the pull request.
- GitHub-side negative tests N1–N7 ran on a draft probe pull request targeting
  the feature branch (never merged). They found the two defects this revision
  corrects — merge after a failed verification (N4) and the single-match
  download layout (N3) — so that evidence applies to the earlier workflow
  only, and N1–N7 are re-run against this one. Each probe covers one injected
  condition; it does not prove every combination.

## Consequences and limitations

- **Slower and costlier at today's size.** More jobs, each billed and queued;
  browsers installed twice.
- **Statistics count executions, not logical tests.** The merged report shows
  `setup` once per shard that ran it (19 today). How many shards run `setup`
  depends on the distribution and changes as tests are added.
- **Sauce Demo logins** grow with the number of shards that hold authenticated
  tests.
- **Blob artifacts** carry the same exposure surfaces as the HTML report for
  failing tests (S1–S8), plus absolute runner paths in `report.jsonl`; they are
  kept 1 day. The merged report carries the CI git metadata above.
- **Cancellation (observed once, N6).** The run was cancelled manually while
  both shards were installing browsers. The shards concluded `cancelled`; the
  `test` job still started because of `always()`, and — contrary to an earlier
  assumption — its `!cancelled()` report steps **also ran**. The gate
  concluded `failure` because the shard result was `cancelled`, so the
  required check was `failure`. That is one scenario. A force-cancel, a lost
  runner, a cancel before the `test` job is queued, or cancellation at other
  points were **not** tested; they may leave the check `cancelled` or absent.
  None of those is `success`, but no guarantee beyond the tested scenario is
  claimed.
- **Upgrade revalidation.** Re-check on Playwright upgrades: blob naming and
  padding, archive layout, `merge-reports` exit codes and config loading,
  `captureGitInfo` defaults, setup-per-shard behaviour. Re-check on GitHub
  Actions changes: `upload-artifact`/`download-artifact` majors, the runner
  image's `unzip`, skipped-job, `always()` and `cancelled()` semantics, artifact
  listing across attempts, exact-name download selection, the `actions: read`
  token scope, and the required check context.
- The verifier runs Node's type-stripping on a `.ts` file and suppresses only
  the `MODULE_TYPELESS_PACKAGE_JSON` warning (the deferred ESM decision).

## Alternatives considered

| Alternative                                          | Why not                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Reporter chosen in configuration (`recordingPolicy`) | Amends the ADR-0005 security policy for CI plumbing; a local `CI=1` run would write blobs   |
| Partition by browser (`--project` per job)           | Installs one browser per job, but is not sharding and does not scale within a browser       |
| Three shards                                         | More overhead; the measured single `setup` was an accident of distribution                  |
| Do nothing                                           | Viable for speed; rejected only because M6 is a capability milestone                        |
| Require each shard in the ruleset                    | Changes protection settings outside the repository; breaks whenever the shard count changes |
| `merge-multiple: true` on download                   | Same-named files overwrite each other silently                                              |
| One `pattern` download for all shards                | Layout changes when only one artifact matches; zero matches report success (measured)       |
| Exact-name downloads without an inventory            | Cannot detect an unexpected extra artifact                                                  |
| Trusting `merge-reports` success                     | Exits 0 for missing shards, duplicated blobs and failed tests (measured)                    |

## Related

- [`docs/security-testing-policy.md`](../security-testing-policy.md) — blob
  artifacts, git metadata
- `.github/workflows/tests.yml`, `src/ci/blob-reports.ts`,
  `scripts/verify-blob-reports.ts`
