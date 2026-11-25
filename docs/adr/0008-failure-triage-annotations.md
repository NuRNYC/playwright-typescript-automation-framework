# ADR-0008: Failure triage summaries and CI annotations

- **Status:** accepted
- **Date:** 2026-11-24
- **Scope:** M7. Builds on [ADR-0005](0005-recording-and-execution-boundary.md)
  and [ADR-0007](0007-ci-sharding-and-merged-reports.md); changes neither.

## Context

The roadmap defined M7 as "flake triage annotations"; the README listed
"failure triage annotations". After M6, a failing or flaky test was visible
only inside the merged HTML report. Reviewers had no summary in the pull
request.

Measured with Playwright 1.64.1 in an isolated copy, synthetic values only:

| Behaviour                            | Observed                                                                                                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in `github` reporter           | emits `::error` annotations containing the full error message, Expected/Received values, a source snippet and the absolute runner path; a token-like string in an error appeared 6 times; a flaky test's first attempt is reported as an error |
| JSON reporter, per test              | `status` (`expected`, `unexpected`, `flaky`, `skipped`), `expectedStatus`, `projectName`, `results[].status` (`passed`, `failed`, `timedOut`, `skipped`, `interrupted`)                                                                        |
| JSON reporter, per spec              | `file` relative to `testDir` and `line` of the test declaration; error locations use **absolute** paths                                                                                                                                        |
| JSON reporter, report level          | `config.rootDir` (absolute), `config.argv`, and in CI the git metadata (S9)                                                                                                                                                                    |
| Assertion versus thrown error        | both `failed`; the difference exists only in free text                                                                                                                                                                                         |
| Dependency did not run               | `skipped` with zero results (for example after a `setup` failure)                                                                                                                                                                              |
| Merged JSON                          | same statuses, files and lines as a direct run; a repeated spec id is **suffixed** (`…a738`, `…a7381`) for the second shard's `setup`                                                                                                          |
| JSON reporter without an output file | prints the whole report to stdout                                                                                                                                                                                                              |

## Decision

### Post-process the verified, merged JSON

The trusted merge step (ADR-0007) runs
`merge-reports --reporter html,json`, with `PLAYWRIGHT_JSON_OUTPUT_FILE` set to
`$RUNNER_TEMP/triage/results.json`. The step refuses to run if that variable
is empty, because the JSON reporter would otherwise print the report to the
log. The file is outside every uploaded path and is never printed.

A new **Triage** step then runs
`scripts/triage-report.ts <merge-outcome> <report.json> <summary.md>`:

- It reads the report **only if the merge step succeeded**, which in turn
  required the inventory, both exact-name downloads and the blob verifier.
- The pure policy `src/ci/triage.ts` validates the parsed JSON as `unknown`,
  classifies each test, de-duplicates executions, and produces annotations and
  a job summary.
- It prints workflow commands and appends to `$GITHUB_STEP_SUMMARY`.

### Classification from structured statuses only

| Category           | From                                                            | Annotation |
| ------------------ | --------------------------------------------------------------- | ---------- |
| `failed`           | `unexpected`, last attempt `failed`                             | error      |
| `timed-out`        | `unexpected`, last attempt `timedOut`                           | error      |
| `interrupted`      | `unexpected`, last attempt `interrupted`                        | error      |
| `unexpected-pass`  | `unexpected`, last attempt `passed` (a `test.fail` that passed) | error      |
| `unclassified`     | any unknown or inconsistent status                              | error      |
| `flaky`            | `flaky` (failed, then passed on retry)                          | warning    |
| `did-not-run`      | `skipped` with no results                                       | count only |
| `expected-failure` | `expected` with `expectedStatus: failed`                        | count only |
| `skipped`          | `skipped` with results                                          | count only |
| `passed`           | `expected`                                                      | count only |

No root cause is inferred: assertion, network, browser-launch and
infrastructure failures are all `failed`, because only free text separates
them. Configuration failures produce no report at all and appear as the M6
gate failing with triage unavailable.

### Logical tests versus executions

Executions of the same test in the same project are one logical test, keyed
by project, validated location, column and title. The title is a map key
only and is never published. Spec ids are not used, because merging changes
them. The most severe execution wins. The summary reports both counts: today
18 logical tests and 19 executions, with `setup` counted once.

### What is published (allow-list)

Only: the category, a project from the fixed list of eight (otherwise
`unrecognized-project`), the spec path as `tests/<path>.spec.ts` or
`.setup.ts` (letters, digits, `_`, `-`, `.`, `/`; no `..`, no absolute or
backslash paths), and the declaration line as a positive integer. A location
that does not validate is withheld. Every property and message is escaped for
workflow commands (`%`, CR, LF, and `:` and `,` in properties).

Never published: error messages, stacks, Expected/Received values, test
titles, stdout and stderr, attachments, request or response data, git
metadata, `config`, or absolute error locations. Titles are excluded even
when they look harmless.

**Limits.** At most 10 error and 10 warning annotations; the summary always
carries complete counts per category and lists up to 50 items.

### Advisory, not a gate input

The Triage step is `continue-on-error`. It is not one of the eight gate
inputs, so it can neither fail a passing run nor make a failing run pass.
The gate is unchanged. When the report cannot be used — merge not successful,
missing, unreadable, invalid JSON, invalid shape, empty or too large — the
step emits one fixed "Test triage unavailable (`reason`)" warning and summary
and exits 1. It never reports "nothing failed".

**Internal failures.** Any exception while loading, classifying or rendering
becomes the reason `internal-error`, with the same fixed warning and summary
built from constants — never from the exception, which is not printed. If the
summary itself cannot be written, one fixed "summary could not be written"
warning is added and the step exits 1, also when triage otherwise succeeded.
Exit codes: 0 triage produced and summary written; 1 unavailable, internal
error or summary not written; 2 wrong arguments. A non-zero exit also makes
GitHub add its generic "Process completed with exit code 1" annotation; the
step stays `continue-on-error`, so the job verdict is unchanged. A process
killed outright, or a lost runner, produces none of this output.

### Unchanged

`playwright.config.ts` (including retries and `failOnFlakyTests`), the shard
reporters, ADR-0005 checkpoints and restricted-target refusals, the M6
inventory, downloads, verification, verify-before-merge, retention and the
eight-input gate. Playwright's built-in `github` reporter stays disabled.

## Verification

- Unit: 118/118 (99 existing + 19 triage policy and fallback), including hostile titles,
  token-like strings in errors, `%`, newlines and `::` sequences, absolute and
  traversal paths, unknown projects and statuses, invalid lines, malformed and
  oversized input, duplicated executions, extra fields and the annotation cap.
- Local: `npm test` 18/18; two shards 10 + 9; blob verification; `html,json`
  merge wrote the JSON only to the temporary file (nothing to stdout, nothing
  under `playwright-report/`); triage reported 18 logical tests and 19
  executions in about 0.2 s.
- Synthetic probes in an isolated copy: failed, timed-out, flaky,
  expected-failure, skipped, a hostile title and a setup failure with two
  dependents classified as expected; no message text, title, token or path in
  the output; every unavailable path produced its fixed reason.
- Real GitHub Actions negative probes are a separate, later step.

## Consequences and limitations

- Annotations and the job summary are a new public surface (S10). They are
  public on a public repository.
- No root-cause classification: a `failed` item says what failed, not why.
- The project list is a second copy of the configuration; a new project is
  reported as `unrecognized-project` until the list is updated.
- The `tests/` prefix assumes `testDir` stays `./tests`.
- Line numbers are the test declaration, not the failing line.
- Relies on the JSON report format and the `PLAYWRIGHT_JSON_OUTPUT_FILE`
  variable of Playwright 1.64.1, and on GitHub's workflow-command syntax and
  annotation limits; re-validate on upgrades. Unknown shapes fail closed as
  unavailable.
- The adapter suppresses only Node's `MODULE_TYPELESS_PACKAGE_JSON` warning
  (the deferred ESM decision).

## Alternatives considered

| Alternative                             | Why not                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Playwright's built-in `github` reporter | Publishes raw errors, values, snippets and absolute paths (measured)                           |
| A custom reporter inside each shard     | Runs during execution, before verification; per-shard duplicates; changes shard reporter flags |
| Redacting error messages                | Redaction misses unknown secrets; an allow-list publishes only known-safe fields               |
| Publishing test titles                  | Titles are free text and can carry values                                                      |
| Inferring root causes from messages     | Unreliable; requires reading uncontrolled text                                                 |
| Triage as a ninth gate input            | A diagnostics bug would block merges; the gate already decides                                 |

## Related

- [`docs/security-testing-policy.md`](../security-testing-policy.md) — S10
- `src/ci/triage.ts`, `scripts/triage-report.ts`, `.github/workflows/tests.yml`
