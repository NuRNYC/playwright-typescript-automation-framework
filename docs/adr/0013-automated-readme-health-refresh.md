# ADR-0013: Automated README health refresh pull requests

- **Status:** accepted in part. The maintainer accepted the implemented
  Phase C5A scope — sections 1 and 2 (markers and renderer, metric
  identity, strict pin reading and the refresh decision) — on 2026-11-28
  through PR #55. Sections 3, 4 and 5 (the workflow, the credential model,
  publication and the dry-run bootstrap) remain **proposed and not
  approved**; each needs its own maintainer approval.
- **Date:** 2026-11-28
- **Scope:** How the README "Test Automation Health" snapshot defined by
  [ADR-0012](0012-readme-test-automation-health.md) may later be refreshed
  through an automatically proposed, human-reviewed pull request. Reads the
  quality summary as [ADR-0009](0009-quality-reporting-dashboard.md) defines
  it and the Gate verdict as [ADR-0010](0010-quality-verdict-provenance.md)
  defines it. Changes neither contract, nor ADR-0011, nor ADR-0012's metric
  rules, nor the C1 diagnostic renderer.
- **Implementation (C5A):** pure modules and tests only:
  `src/reporting/readme-health.ts` (exact marker replacement, deterministic
  README section renderer, strict pin reader, structured metric identity),
  `src/reporting/refresh-decision.ts` (eligibility, ordering, freshness and
  no-op decision), and README section markers around the existing,
  unchanged snapshot. No workflow, credential, environment reader, network
  access, repository setting, branch or pull request is created.

## Context

ADR-0012 keeps the README snapshot by hand: a maintainer picks one completed
push-to-main run, checks its evidence, and opens a PR. Phase C3 made every
push run produce `unit-results-<attempt>`, `quality-summary-<attempt>` and
`test-health-<attempt>`; Phase C4 refreshed the README from such a run by
hand. Doing that by hand after every substantive change is repetitive, but
automating it touches several boundaries at once: privileged tokens,
untrusted artifacts, protected `main`, the strict required `test` check, and
the risk of a refresh PR triggering its own successor.

Observed repository facts (2026-11-28):

- `main` is protected by a ruleset: pull request required (0 approvals,
  threads resolved, extra approval for unattributed changes), required check
  `test` with strict up-to-date, no force push or deletion, no bypass actors.
  Other branches are unprotected.
- Workflow permissions default to read; **"Allow GitHub Actions to create and
  approve pull requests" is off**, so the built-in token cannot open a PR.
- Per GitHub's documentation, events caused by `GITHUB_TOKEN` create no new
  workflow runs, except that a PR it opens or updates gets `pull_request`
  runs in an **approval-required** state. A GitHub App installation token or
  a personal access token makes them run automatically.
- `workflow_run` workflows run from the default branch's workflow file.

## Decision

### 1. Section markers and the renderer (implemented, accepted)

The README section is delimited by exactly one pair of whole-line markers,
`<!-- test-health:start -->` and `<!-- test-health:end -->`. Replacement:

- keeps every byte outside the pair, including line endings;
- refuses a missing, duplicated, nested or out-of-order marker, any
  near-miss text beginning `<!-- test-health:`, and a marker that is not on
  its own line;
- refuses replacement content that contains marker text, a carriage return
  or no final newline.

`renderReadmeSection` renders only **complete CI evidence with a
`VERIFIED_PASS` verdict and a `SUMMARY_VERIFIED_ORIGIN` summary** of a push
run on `main` (both C1 sections
`complete`, every displayed row reported, definitions known, every unit test
passed). It reproduces the committed C4 section byte for byte (golden test),
pads tables as Prettier does, adds an outcome column for every non-zero
non-pass outcome and a retries column when retries occurred, and changes its
disclosure wording when the snapshot is maintained by reviewed automation
instead of by hand. It is separate from the CI diagnostic renderer, which
stays unchanged. The rendered section keeps all provenance — source commit,
run id, attempt, completion time and preparation date.

`parseSnapshotPin(section, repository)` reads the pinned commit, run,
attempt and completion time back from the README. It requires **exactly
one** Commit row, one CI run row and one Completed row (a duplicate is
refused even when it agrees); the run link must point at the expected
repository and repeat the cell's run id and attempt; the completion time
must be a real calendar instant (`isCalendarInstant`: `2026-02-30…`,
`…T24:00:00Z` and fractional seconds are refused). Nothing is guessed.

**Metric identity (structured).** `metricIdentity(model, verification)`
builds, field by field in a fixed order, everything that makes two
snapshots say different things:

- the README contract version (`README_CONTRACT_VERSION`, bumped whenever
  ADR-0012's counting rules or this record's presentation change) and the
  C1 model version;
- the verification state (ADR-0010 verdict and summary state);
- both evidence states with their sorted reasons;
- the unit counts, including `suites`;
- every Playwright row — each group, the authentication setup,
  Unclassified, the subtotals and totals — with `reported`, definitions,
  instances, executions, attempts, retries and every outcome column, plus
  the missing groups.

It deliberately excludes the source commit, run id, attempt, every
timestamp, the preparation date and the Node.js version: those are
provenance. `metricsEqual` compares identities structurally;
`metricsDigest` is the SHA-256 of the canonical identity. Rendered Markdown
is **never** used as the metric identity. A section rendered in
`reviewed-automation-pr` mode records its digest on one
`<!-- test-health-metrics: sha256:… -->` line, so that a later run can be
compared after the source artifacts expire; `parseMetricsDigest` accepts
exactly one such line. The manual C4 rendering carries none and is
unchanged. `compareMetrics` returns `same`, `different` or `unavailable`.

### 2. Refresh decision (implemented, accepted)

`decideRefresh` takes injected facts and returns `refresh`, `no-op`, `skip`
(not publishable, no action implied) or `blocked` (a human must decide),
always with fixed reason codes:

1. **Eligibility.** Exact repository and workflow path, `push` event, branch
   `main`, head repository equal to the repository (a fork is rejected),
   completed status and a positive identity. The attempt must **equal** the
   run's newest attempt: an older attempt is `attempt-superseded`; an
   attempt newer than the newest one is impossible and is
   `invalid-run-identity`. The completion time must be a real calendar
   instant. Every problem is reported together.
2. **Evidence.** Only `VERIFIED_PASS` with `SUMMARY_VERIFIED_ORIGIN`,
   complete unit and Playwright sections, matching identities, and a health
   bundle that matches the recomputed model. Each other state has its own
   reason; contradictions (`CONFLICT`, identity mismatch, bundle mismatch)
   are `blocked`. **A failed, partial or missing run is never replaced by an
   older successful one:** the README keeps its pinned snapshot, and the
   decision records why the new run was not published.
3. **Ordering by ancestry, then attempt.** Run ids never establish
   freshness. Against the README's pinned source the candidate must be a
   descendant; the same source is accepted only for the same run with a
   higher attempt (equal attempt is `no-op`, lower is rejected, a different
   run of the same commit is `blocked`); an ancestor or a divergent source
   is rejected; unknown ancestry is `blocked`.
4. **Two separate comparisons.**
   - **`candidate..main`** — what `main` holds that the candidate run did
     **not** test. Documentation-only: proceed. Test-affecting: the run is
     superseded (`skip`; a newer run will follow). Unknown impact or an
     unavailable list: `blocked`.
   - **`snapshot..candidate`** — what the candidate run **measured** that
     the snapshot did not. Test-affecting: refresh (re-pin) even when the
     figures are unchanged. Unknown impact or an unavailable list:
     `blocked`. Documentation-only or empty: refresh only when the metric
     identities differ (`substantive-change`) or the ADR-0012 30-day age
     limit has passed; otherwise `no-op`. When the snapshot's identity is
     unavailable (for example the manual C4 snapshot, which records no
     digest, after its evidence has expired), a no-op cannot be proved:
     the decision is `blocked` (`snapshot-metrics-unavailable`) unless a
     test-affecting change or the age limit already justifies a refresh.

   Changes of provenance alone — a new commit, run id, attempt or timestamp
   with an identical metric identity — never trigger a refresh. The refresh
   triggers are a test-affecting change since the snapshot, a different
   metric identity, and the age limit.

   Paths use the ADR-0012 section 6 minimum test-affecting list;
   documentation is a closed list (Markdown at the root or under `docs/`);
   everything else — tool, Node.js or browser versions, configuration,
   environment, unrecognised files — is unknown impact.

5. **Loop prevention.** A merged refresh PR changes only `README.md`, so its
   own push run sees a documentation-only `snapshot..candidate` range and,
   with an identical metric identity, returns `no-op` even though its
   commit, run, attempt and timestamps all differ (covered by an end-to-end
   pure test). A difference in metrics, outcomes (including setup and
   Unclassified), evidence state, verification state or contract version is
   substantive and is never hidden. Refresh PRs' own `pull_request` runs
   are never candidates (rule 1).

### 3. Proposed workflow (proposed, not approved, not implemented)

A new workflow, separate from `tests.yml`, triggered by `workflow_run`
(`Playwright UI Tests`, `completed`, branch `main`), with
`concurrency: readme-health-refresh` and `cancel-in-progress: false` so that
competing runs are serialized.

**Job 1, `evidence` — read-only** (`actions: read`, `contents: read`):

1. Reject before any download unless the payload says `push`, `main` and a
   head repository equal to this repository; then re-read the run attempt
   from the API (the payload is not trusted) and apply rule 1.
2. Check out trusted code: the default branch at the **exact SHA** recorded
   at job start, with `persist-credentials: false`. Code from the source run
   or from any artifact is never checked out, imported or executed.
3. Download exactly `unit-results-<attempt>`, `quality-summary-<attempt>`
   and `test-health-<attempt>` of that run id, through the ADR-0010
   operator's bounded, digest-checked transport. Archives are read in memory
   by bounded readers into fixed paths under `runner.temp`; nothing is
   extracted into the workspace.
4. Validate with the C2 parsers, recompute the C1 model with the bundle's
   recorded `generatedAt`, compare it with the bundle, obtain the verdict
   from the ADR-0010 reconciler, compute ancestry and both path lists from a
   trusted Git checkout, and call `decideRefresh`.
5. Upload one small, allow-listed decision artifact: action, reasons, run
   identity, and — for `refresh` only — the rendered section. No tokens,
   logs, signed URLs, private verdict bundles or per-test records.

**Job 2, `publish` — narrowly privileged** (`contents: write`,
`pull-requests: write`), only when job 1 decided `refresh`:

1. Check out the same trusted default-branch SHA. Treat the decision
   artifact as data: validate its schema, re-render the section from the
   recorded facts with the committed renderer rather than pasting it.
2. **Revalidate immediately before publication:** re-read the `main` tip,
   the candidate run attempt and the open refresh PR. If `main` moved, the
   attempt changed, or the decision would differ, stop without writing.
3. Replace only the marked section and commit to the fixed branch
   `automation/readme-test-health`, opening the single refresh PR or
   updating the open one. Never merge, never enable auto-merge, never push
   to `main`, never delete a branch.

**Automation-branch updates (initially append-only).** Updates add a commit
on top of the existing automation branch; there is no force push. Before
writing, the job lists the branch's commits since its merge base with
`main`: if any commit was not made by the automation identity, or any
commit touches anything outside the marked README section, the job stops
and reports `human-edit-detected` without writing. A branch that has fallen
behind `main` is updated by a merge from `main` only when that merge is
conflict-free; otherwise the job stops. A PR closed by a person is never
reopened; the next eligible run opens a new one. No retries within a run; a
re-run is a separate, attempt-specific evidence set.

**Multi-entry archives.** `test-health-<attempt>` holds two files. The
existing single-entry ZIP reader (`zip-entry.ts`) and its contract stay
unchanged. A separate bounded reader for a fixed, allow-listed set of entry
names (exact names, no directories, per-entry and total size limits,
compression-ratio limit, CRC and length checks) is proposed for that
artifact.

### 4. Credential model (proposed, decision required, not approved)

|             | `GITHUB_TOKEN`                                                                                                                                                              | GitHub App installation token                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup       | Enable "Allow GitHub Actions to create and approve pull requests" (also lets the token approve PRs; approvals grant no merge power here: 0 required, the check still gates) | Create an App with Contents and Pull requests write on this repository only; store its private key as a secret, ideally in an environment restricted to `main` |
| Secrets     | None stored; token scoped per job, expires with the job                                                                                                                     | A long-lived private key to protect and rotate                                                                                                                 |
| PR CI       | `pull_request` runs start in an approval-required state: the maintainer must approve them before the required `test` check can report                                       | Runs start automatically                                                                                                                                       |
| Attribution | `github-actions[bot]`                                                                                                                                                       | The App's bot identity                                                                                                                                         |

Recommendation: start with `GITHUB_TOKEN`, since a reviewed PR needs a human
anyway and no credential is stored. **Not yet verified, and needed before
the publish job is enabled:** that an approved approval-required run
satisfies the strict required check, and how
`require_extra_approval_for_unattributed_changes` treats automation commits.

ADR-0010 currently says the operator is "local use only". Running its
reconciler in CI with `GITHUB_TOKEN` (`actions: read`) needs an ADR-0010
amendment and an update to the CLAUDE.md environment-exception list.

### 5. Dry-run bootstrap (proposed, not approved)

`workflow_run` and `workflow_dispatch` only work once the workflow file is on
the default branch, so no remote probe can run from a feature branch. The
sequence is therefore:

1. **C5B:** merge the workflow with only `workflow_dispatch` (inputs: run id
   and attempt) and the `evidence` job, hard-wired to dry run: no write
   permission is declared anywhere in the file.
2. Dispatch dry runs from `main` against recorded runs: the current eligible
   run, the C3 probe runs (failed unit tests, missing artifact, provenance
   mismatch), a pull request run (must be rejected before any download), and
   a documentation-only range (must be `no-op`).
3. **C5C:** add the `workflow_run` trigger to the still read-only job and
   observe decisions on real pushes.
4. **C5D:** add the `publish` job after the credential decision, then one
   controlled live refresh and its follow-up `no-op`.

Fork rejection can be tested only as logic unless a fork PR is made.

## Consequences

- A README refresh can be proposed without anyone downloading evidence by
  hand, while every change still lands through a reviewed PR on protected
  `main`.
- Only complete, verified evidence is ever proposed; everything else leaves
  the pinned snapshot in place with a recorded reason.
- Documentation-only merges, including the refresh PR's own, do not cause
  new refresh PRs.
- Unknown-impact changes stop automation until a person decides.
- The snapshot wording changes when automation maintains it.

## Alternatives considered

- **Commit directly to `main`.** Rejected: requires bypassing protection.
- **`pull_request_target` or processing artifacts in the source workflow.**
  Rejected: mixes untrusted run output with write permission.
- **Order candidates by run id or creation time.** Rejected: a later run can
  test an older commit.
- **Ignore every documentation-only change unconditionally.** Rejected: it
  would hide a substantive change in a re-run's evidence and the age limit.
- **Compare rendered Markdown.** Rejected: every new run changes the
  commit, run and timestamps, so every docs merge would look substantive
  and the refresh would loop.
- **Widen `zip-entry.ts` to several entries.** Rejected: it would weaken a
  reviewed single-entry contract used by the verdict operator.
- **Personal access token.** Rejected: user-bound, broad, long-lived.

## Related

- [ADR-0009](0009-quality-reporting-dashboard.md) — quality summary
- [ADR-0010](0010-quality-verdict-provenance.md) — verdict provenance
- [ADR-0012](0012-readme-test-automation-health.md) — README snapshot rules
