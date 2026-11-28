# ADR-0010: Provenance and verdict contract for quality summaries

- **Status:** accepted — the trust policy and the contract below were approved
  by the maintainer on 2026-11-26. Nothing here is implemented yet; each
  implementation stage (M8E-3 onward) needs its own authorization.
- **Date:** 2026-11-26
- **Scope:** M8E-2. Amends [ADR-0009](0009-quality-reporting-dashboard.md)
  (how a summary and a CI verdict are trusted and joined). Builds on
  [ADR-0007](0007-ci-sharding-and-merged-reports.md) (the eight-input Gate)
  and [`docs/security-testing-policy.md`](../security-testing-policy.md).
  Changes no code, workflow, schema or test.
- **Amended:** 2026-11-26 — evidence precedence: established contradictions
  and confirmed untrusted origins take precedence over missing evidence; see
  the note under "Gate verdict states".
- **Extended by:** [ADR-0011](0011-verdict-evidence-publication.md)
  (2026-11-26) — publication trust contract; see the note under "Future
  implementation".
- **Cross-reference (2026-11-28):** [ADR-0012](0012-readme-test-automation-health.md)
  Phase C3 adds an advisory `health` job on push to `main`. This record's
  contract is unchanged: the verdict still comes from the job named `test`
  and its `Gate` step, and summary identity still follows the existing
  `QS_HEAD_SHA` rule. The `health` job uses job-level `continue-on-error` so
  that it cannot change the run conclusion this record cross-checks.

## Context

ADR-0009 deliberately keeps the CI verdict out of the quality summary
(`ciVerdict: "not-recorded-in-summary"`) and defers the verdict to "a GitHub
API join". M8A–M8D implemented the summary, the viewer and the advisory CI
steps. The M8E Phase 1 security audit (2026-11-26) then established, from
repository evidence and read-only API metadata:

- **A pull request's workflow is the pull request's code.** On
  `pull_request` runs, GitHub runs the workflow, normalizer, CLI and Gate from
  the PR's own commit. A same-repository PR can therefore change what the Gate
  checks, or what the summary says, and still produce a well-formed artifact
  and a green step. Only runs whose workflow definition comes from the
  protected `main` branch reflect the reviewed pipeline.
- **The summary is self-reported.** It is produced by the same code that ran.
  Its content cannot prove its own origin.
- **Identity fields are only partly shared.** The summary records run id, run
  attempt, event and a head SHA. The run, job and artifact APIs expose
  repository, workflow, attempt, job and step identity. The artifact API has
  **no attempt field**, and the tested merge commit of a pull request is not
  exposed by the run API at all.
- **`continue-on-error` hides failure in conclusions.** In the jobs API a
  failed step with `continue-on-error: true` reports its conclusion as
  `success` (observed in M8D probes P4 and P5). Step conclusions of advisory
  steps are therefore not evidence.
- **Artifact downloads need a token.** Measured without credentials: listing a
  run's artifacts and jobs returned HTTP 200; downloading an artifact archive
  returned **HTTP 401**, although the repository is public.
- **The artifact API exposes a `digest`** (`sha256:<hex>`) per artifact,
  together with `workflow_run.id`, `workflow_run.repository_id`,
  `workflow_run.head_sha`, `created_at`, `expires_at` and `expired`.

## Decision

### Trust policy

This is the project's approved trust policy. It is a local decision about
which evidence this dashboard accepts, not a claim that GitHub certifies any
execution.

1. **Only eligible, completed `push` runs on protected `main` may produce a
   VERIFIED verdict.** `main` changes only through pull requests that pass the
   required `test` check (ruleset `main-protection`), so the workflow of such
   a run is the reviewed one.
2. **Every `pull_request` run is `UNTRUSTED_PROVENANCE` for verdict
   purposes,** including same-repository pull requests and including runs
   whose checks succeeded. Their Gate conclusion may be shown as informative
   only.
3. **An uploaded summary is informative.** It never establishes, changes or
   overrides a verdict.
4. **Provenance is checked** against the expected repository, workflow, run
   id, run attempt and SHA (identity contract below).
5. **The completed `Gate` step of the `test` job is authoritative** for the
   verdict of a trusted run.
6. **Absent Gate evidence is never a verified pass.**
7. **No new GitHub Actions token permissions** are authorized. The workflow
   keeps `contents: read` (and `actions: read` in the `test` job).
8. **Browser-side authenticated artifact retrieval is prohibited.** No
   credential may appear in browser JavaScript or in any generated dashboard
   file.
9. **Public hosting is not authorized** (M8F).

### Two independent evidence dimensions

A result has two parts that are evaluated separately:

1. **Gate verdict** — from the run-attempt and jobs APIs only. It does not need
   a summary artifact.
2. **Summary availability and integrity** — whether quality metrics may be
   shown, and with which label.

An absent or expired summary may coexist with a verified verdict; metrics are
then unavailable, never zero. A summary never alters the verdict.

### Gate verdict states

Evaluated for one run attempt. **The first matching rule wins.**

> **Amended on 2026-11-26 (precedence).** As first written, this table placed
> `UNKNOWN` (evidence not retrieved) at order 1, before `CONFLICT` (order 2)
> and `UNTRUSTED_PROVENANCE` (order 3), so an unrelated failed request could
> hide a contradiction or an untrusted origin that the retrieved evidence had
> already established. The maintainer approved a corrected order, applied in
> the table below:
>
> 1. `CONFLICT` — an established identity contradiction in whatever evidence
>    was retrieved.
> 2. `UNTRUSTED_PROVENANCE` — a confirmed untrusted origin in whatever
>    evidence was retrieved.
> 3. `UNKNOWN` — required evidence unavailable, with neither of the above
>    established.
> 4. The remaining rules (orders 4–10) unchanged.
>
> Consequences of the correction:
>
> - Rule 1 uses only evidence that was actually retrieved; a contradiction is
>   never inferred from a missing response.
> - Rule 2 needs **confirmed** evidence. A diverged or ahead comparison
>   confirms an untrusted origin; an unavailable or malformed comparison is
>   missing evidence (rule 3), never proof of trust.
> - Outcome contradictions stay at order 6, after `PENDING` and `CANCELLED`,
>   because they are defined on completed evidence; a Gate that executed
>   during cancellation stays `CANCELLED`.
> - Missing evidence still never yields `VERIFIED_PASS` or `VERIFIED_FAIL`.
>
> Examples:
>
> | Evidence                                                                                                                            | Result                 |
> | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
> | Run attempt reports attempt 2 for a request for attempt 1; jobs request failed                                                      | `CONFLICT`             |
> | Run attempt retrieved, event `pull_request`; jobs request failed                                                                    | `UNTRUSTED_PROVENANCE` |
> | Run attempt retrieved, consistent and trusted; jobs request failed (no contradiction known)                                         | `UNKNOWN`              |
> | Trusted `push` on `main`, identity consistent, ancestry confirmed, one `test` job and one `Gate` step both completed with `success` | `VERIFIED_PASS`        |
>
> The summary states below follow the same principle (an established
> `SUMMARY_CONFLICT` precedes `SUMMARY_UNKNOWN`).

| Order | State                  | Condition                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `CONFLICT`             | An **established identity contradiction** in the evidence that was retrieved, whatever else is missing: run id or attempt differs between retrieved sources; a job's `run_attempt` or `head_sha` differs from the attempt's; more than one job named `test`, or more than one step named `Gate` in it.                                                                                                                 |
| 2     | `UNTRUSTED_PROVENANCE` | A **confirmed untrusted origin** in the retrieved run-attempt or comparison evidence, whatever else is missing: event other than `push`, branch other than `main`, a repository or head repository other than the expected one, a workflow id or path other than the expected one, or a comparison showing the head commit diverged from, or ahead of, the selected `main` tip. **All `pull_request` runs land here.** |
| 3     | `UNKNOWN`              | Required evidence was **not retrieved**, and neither rule 1 nor rule 2 applies: run-attempt, jobs or ancestry-comparison response missing, HTTP error, permission refusal, rate limit, timeout, malformed body, or incomplete pagination. A retrieval failure is never negative evidence.                                                                                                                              |
| 4     | `PENDING`              | The run attempt's `status` is not `completed`.                                                                                                                                                                                                                                                                                                                                                                         |
| 5     | `CANCELLED`            | The run attempt or the `test` job concluded `cancelled`. A Gate that still executed during cancellation does not turn this into a verified result.                                                                                                                                                                                                                                                                     |
| 6     | `CONFLICT`             | Completed evidence **contradicts itself**: the run is completed but the `test` job is not; the Gate concluded `success` but the job did not; the Gate concluded `failure` but the job concluded `success`; the run concluded `success` but the job did not.                                                                                                                                                            |
| 7     | `VERIFIED_PASS`        | Exactly one `test` job, completed with `success`; its single `Gate` step completed with `success`; the run attempt completed with `success`; trusted origin; identity consistent.                                                                                                                                                                                                                                      |
| 8     | `VERIFIED_FAIL`        | The single `Gate` step completed with `failure` (the job then concludes `failure`); trusted origin; identity consistent. This is the only path to a verified failure.                                                                                                                                                                                                                                                  |
| 9     | `EXECUTION_FAILED`     | The run attempt is completed, trusted and consistent, and the `test` job concluded `failure` or `timed_out` — or the run concluded `failure`, `timed_out` or `startup_failure` without a `test` job — **and no `Gate` step completed** (missing, `skipped` or not completed). The pipeline failed to reach its verdict; this is not a failed Gate.                                                                     |
| 10    | `UNKNOWN`              | Anything else, for example a Gate step `skipped` with a successful job, or conclusions such as `neutral`, `action_required`, `skipped` or `stale`.                                                                                                                                                                                                                                                                     |

Every `UNKNOWN` and `CONFLICT` carries a fixed reason code (for example
`retrieval-rate-limited`, `retrieval-incomplete-pagination`,
`identity-attempt-mismatch`, `outcome-gate-job-mismatch`). Reason codes name a
rule, never a value from the response.

`EXECUTION_FAILED` and `CANCELLED` are distinct from `VERIFIED_FAIL` so that a
broken or interrupted pipeline is never reported as a failing test suite, and
distinct from `UNKNOWN` because the evidence was retrieved and is negative.

### Summary states

Evaluated only after the verdict dimension. The first matching rule wins.

| Order | State                     | Condition                                                                                                                                                                                                                                                                                                     |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `SUMMARY_CONFLICT`        | Established from retrieved evidence, whatever else is missing: more than one candidate artifact; artifact bound to another run, repository or head SHA; `created_at` outside the attempt's window; **digest mismatch**; summary `runId`, `runAttempt`, `event` or `headSha` disagreeing with the run attempt. |
| 2     | `SUMMARY_UNKNOWN`         | The artifact list or the archive download was not retrieved (HTTP error, permission, rate limit, timeout, incomplete pagination), and rule 1 does not apply.                                                                                                                                                  |
| 3     | `SUMMARY_UNAVAILABLE`     | No artifact named `quality-summary-<attempt>` exists for this attempt (not generated, skipped for forks, upload failed), or it is `expired` (HTTP 410 on download). Reason recorded.                                                                                                                          |
| 4     | `SUMMARY_INVALID`         | The archive is not exactly one `quality-summary.json`, exceeds the size limit, or fails `parseSummary` (invalid or schema mismatch).                                                                                                                                                                          |
| 5     | `SUMMARY_INFORMATIVE`     | Valid and bound, but the verdict dimension is not trusted (`UNTRUSTED_PROVENANCE`) or not decided (`PENDING`, `UNKNOWN`, `CONFLICT`). Metrics may be shown only with an "unverified origin" label.                                                                                                            |
| 6     | `SUMMARY_VERIFIED_ORIGIN` | Valid and bound, and the verdict dimension is `VERIFIED_PASS`, `VERIFIED_FAIL`, `EXECUTION_FAILED` or `CANCELLED` (all from a trusted, consistent run attempt).                                                                                                                                               |

A valid summary whose `testData` is `unavailable` keeps its state; it simply
has no metrics. On a trusted attempt, a summary whose eight observed Gate
inputs are all `success` while the Gate concluded `failure` (or the reverse)
is `SUMMARY_CONFLICT`. A `SUMMARY_CONFLICT` on a trusted run is reported as
possible tampering; it still does not change the verdict.

### Identity contract

Only fields observed in the API responses during the M8E audit are used. All
fields that are present and authoritative must agree.

| Identity         | Authoritative source                                                                               | Rule                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Repository       | run attempt `repository.full_name` and `repository.id`; artifact `workflow_run.repository_id`      | Equal to the configured expected repository                                                                                         |
| Head repository  | run attempt `head_repository.full_name`; artifact `workflow_run.head_repository_id`                | Equal to the repository (trusted runs)                                                                                              |
| Workflow         | run attempt `workflow_id`, `path` (`.github/workflows/tests.yml`), `name`                          | Equal to the configured expected values                                                                                             |
| Event and branch | run attempt `event`, `head_branch`; summary `run.event` (informative)                              | Trusted only for `push` and `main`; summary event must match                                                                        |
| Run id           | run attempt `id`; artifact `workflow_run.id`; summary `run.runId`                                  | All equal                                                                                                                           |
| Run attempt      | the requested attempt number; run attempt `run_attempt`; each job `run_attempt`; artifact name     | All equal; summary `run.runAttempt` must match                                                                                      |
| Head SHA         | run attempt `head_sha`; each job `head_sha`; artifact `workflow_run.head_sha`; summary `headSha`   | All equal                                                                                                                           |
| Tested commit    | not exposed by these APIs                                                                          | For `push` it equals the head SHA. For pull requests the temporary merge commit differs from the PR head and is not verifiable here |
| Main membership  | commit comparison of the head SHA against `main`                                                   | The head commit must be on `main`'s history (guards against a non-branch ref named `main`)                                          |
| Job              | attempt jobs list: `id`, `name`, `status`, `conclusion`                                            | Exactly one job named `test`                                                                                                        |
| Gate step        | that job's `steps[]`: `number`, `name`, `status`, `conclusion`                                     | Exactly one step named `Gate`                                                                                                       |
| Artifact         | run artifacts list: `id`, `name`, `size_in_bytes`, `digest`, `created_at`, `expires_at`, `expired` | Exactly one named `quality-summary-<attempt>`; `created_at` within the attempt's `run_started_at` … `updated_at`; not expired       |

**No attempt borrows another attempt's evidence.** Only the attempt-specific
endpoints are used, never the run's "latest" view. The artifacts list returns
all attempts of a run; the name suffix and the creation window select the
attempt, and the summary's own attempt must agree.

**Digest.** The artifact API exposes `digest` as `sha256:<hex>`. The working
assumption — not yet verified here — is that it covers the archive bytes the
download endpoint serves. The implementation must compute SHA-256 over the
**exact bytes returned by the archive download** — after following the
redirect, before unzipping, without re-encoding — and compare it with
`digest`. M8E-4 must confirm this byte contract against a retained artifact
before any metric is labelled verified-origin; until then the comparison
fails closed. A mismatch is `SUMMARY_CONFLICT`, never
`SUMMARY_UNKNOWN`.

### GitHub API evidence (read-only)

| Purpose                  | Endpoint                                                       | Notes                                                                                  |
| ------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Get workflow run attempt | `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{n}` | Status, conclusion, identity, `run_started_at`, `updated_at`                           |
| List jobs for an attempt | `GET …/actions/runs/{run_id}/attempts/{n}/jobs`                | Paginated (`per_page` ≤ 100); follow pages until `total_count` is reached              |
| List run artifacts       | `GET …/actions/runs/{run_id}/artifacts`                        | Paginated; all attempts' artifacts                                                     |
| Download one artifact    | `GET …/actions/artifacts/{artifact_id}/zip`                    | **Requires a token** (HTTP 401 without one); answers with a redirect; 410 when expired |
| Main membership          | `GET …/compare/{head_sha}...main`                              | Read-only; an addition to the four calls above, required by the trust policy           |

Handling, all fail closed. Each case below yields `UNKNOWN` or
`SUMMARY_UNKNOWN` only when no established contradiction or confirmed
untrusted origin already applies (precedence amendment, 2026-11-26):

- **HTTP failures** (4xx other than the cases below, 5xx, network errors,
  timeouts): `UNKNOWN` or `SUMMARY_UNKNOWN` with a fixed reason; no automatic
  retry beyond a small bounded count.
- **Permissions** (401/403 without rate-limit headers): `UNKNOWN`
  (`retrieval-permission`).
- **Rate limits** (403/429 with exhausted rate-limit headers): `UNKNOWN`
  (`retrieval-rate-limited`); stop, never loop. Tokenless access is limited
  to 60 requests per hour and cannot download artifacts.
- **Incomplete responses**: fewer items than `total_count`, malformed JSON or
  missing required fields are `UNKNOWN`, never an empty "nothing found".
- **Expiry**: an expired artifact is `SUMMARY_UNAVAILABLE` (`expired`); run
  and job metadata outlive artifacts, so the verdict may still be decided.
- **Size**: the archive download is capped slightly above the 5 MB summary
  limit; larger is `SUMMARY_INVALID`.
- **Redirects**: followed only to `https` locations, without forwarding the
  token to the storage host.

**Token.** A read-only token with Actions read access is supplied by the local
operator at a CLI boundary (the same documented configuration exception that
M8B uses). It is never logged, written to output, embedded in a dashboard
build or sent to the browser. The CI workflow's token permissions do not
change.

### Existing workflow behaviour

Verified by the M8D probes P1–P6 (2026-11-26, runs 45737466819, 45737824141,
45738226300, 45738597191, 45738896419, 45740039634):

- The eight-input Gate fails closed when tests fail (P1) and when evidence is
  missing, corrupt or unmerged (P2–P4); it was unchanged throughout.
- The summary and upload steps are advisory: an invalid run context (P5) and a
  failed upload (P6) left a passing required check passing.
- `continue-on-error` reports a failed step's conclusion as `success` (P4,
  P5); the step's outcome, not its conclusion, drives later conditions.
- Unavailable summaries carry the correct reason
  (`merge-not-successful`, `verification-not-successful`); available ones are
  schema-valid, consistent and free of the synthetic canary.
- The summary never records a Gate verdict.
- A transient GitHub artifact-download failure (first P6 run, 45739234398)
  failed the Gate: fail closed, but a source of false negatives.

Assumptions, not yet observed:

- Fork pull requests skip both summary steps (P7 deferred).
- Behaviour on cancellation, including whether the Gate executes (P8
  deferred).
- Artifact naming and inventory across re-run attempts
  (`quality-summary-2`) (deferred).
- The digest byte contract (M8E-4).

Same-repository pull requests may execute modified workflow and reporting
code; that is why rule 2 of the trust policy exists.

## Consequences

- A verdict and its metrics can be shown with an honest provenance label, and
  a broken pipeline is never reported as a failing test suite.
- Pull-request runs never show a verified verdict in the dashboard; the
  required `test` check on the pull request remains the merge authority.
- Verification needs a token and network access at the operator's machine;
  the static viewer stays offline (`connect-src 'none'`).
- Metrics from summaries older than 7 days are unavailable; verdicts can still
  be verified while run metadata exists.
- The schema (1.0.0), data model and summary fields are unchanged; the tested
  merge commit of a pull request stays unrecorded.

## Alternatives considered

| Alternative                                           | Why rejected or deferred                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Trust same-repository PR runs when checks pass        | The PR defines its own workflow and Gate                                              |
| Trust PR runs whose workflow file matches `main`'s    | The executed merge commit is not exposed; comparison is incomplete                    |
| Derive the verdict from the eight observed inputs     | Self-reported, recorded before the Gate; ADR-0009 already rejects it                  |
| One combined state for verdict and metrics            | Expired artifacts would hide verified verdicts, or verdicts would depend on artifacts |
| Treat cancellation or missing Gate as `VERIFIED_FAIL` | Conflates a failed pipeline with a failed suite                                       |
| Browser fetches artifacts with a token                | Puts a credential in the browser; relaxes the CSP                                     |
| Record the tested commit in schema 1.1.0              | Changes M8A/M8B; not needed for trusted `push` runs; deferred                         |

## Future implementation (not implemented)

Each stage requires its own authorization:

- **M8E-3** — pure verdict reconciliation (`reconcile(summary, evidence,
policy)`), with no I/O, under `src/reporting/`, and synthetic unit tests for
  every row of both state tables, every identity conflict and the
  `continue-on-error` false success.
- **M8E-4** — read-only GitHub API transport and a local operator tool that
  fetches the evidence above, verifies the digest and writes a verified bundle
  outside the repository; dashboard support for the bundle is a separate
  change. Separately authorized.
- **M8E-5** — integration verification on real runs: attempts and re-runs,
  cancellation (P8) and, if approved, fork exclusion (P7). Separately
  authorized.
- **M8F** — hosting and public publication decision. **Not authorized.**

> **Implementation note (2026-11-26).** The Status line and the list above
> are kept as written. Since then: M8E-3 is implemented (PR #30, `7fe0892`);
> M8E-4 is implemented (PR #31, `0d341c8`), including the digest byte
> contract, which was confirmed against a retained artifact (run 45822924582,
> artifact 15117949633) before the operator enabled it per archive; bundle
> file permissions were hardened in PR #32 (`fe66d92`). M8E-5 is in progress.
> How verdict evidence may be published is defined in
> [ADR-0011](0011-verdict-evidence-publication.md). M8F remains not
> authorized.

## Verification

Documentation only. The trust policy was approved on 2026-11-26; the state
tables and identity contract become executable checks in M8E-3, and the API
and digest assumptions are verified in M8E-4 and M8E-5.

## Related

- [ADR-0009](0009-quality-reporting-dashboard.md) — the summary, viewer and advisory CI integration this record amends
- [ADR-0011](0011-verdict-evidence-publication.md) — publication trust contract for verdict evidence
- [ADR-0007](0007-ci-sharding-and-merged-reports.md) — the eight-input Gate
- [`docs/security-testing-policy.md`](../security-testing-policy.md) — the quality-summary artifact
- `.github/workflows/tests.yml`
