# ADR-0011: Publication trust contract for verdict evidence

- **Status:** accepted — Model A (publisher-side verification followed by a
  sanitized static publication manifest) was approved by the maintainer on
  2026-11-26. Items marked **PROPOSED POLICY** below still need explicit
  approval before they are implemented.
- **Date:** 2026-11-26
- **Scope:** M8E follow-up to [ADR-0010](0010-quality-verdict-provenance.md)
  and [ADR-0009](0009-quality-reporting-dashboard.md). Defines how verdict
  evidence may later be published in the static dashboard. Builds on
  [`docs/security-testing-policy.md`](../security-testing-policy.md).
- **Implementation:** none. This record changes no code, workflow, schema,
  test or token permission. Publication and hosting (M8F) remain **not
  authorized**.
- **Deferred:** publisher signatures, GitHub artifact attestations, any CI
  permission change, and public hosting.

## Context

ADR-0010 defines a trust policy, eight Gate verdict states and six summary
states, and M8E-3/M8E-4 implement them: a pure reconciler
(`src/reporting/verdict.ts`) and a local read-only operator
(`src/reporting/verdict-cli.ts`, `scripts/verify-quality-verdict.ts`) that
writes one allow-listed bundle (`bundleSchemaVersion` 1.0.0) per run attempt
to an owner-only directory outside the repository (mode 0700, files 0600 since
H1, PR #32). M8E-5 validated the operator against real runs (Phase 1 run
45838803724; Phase 3 runs 45822924582, 45528388304, 45228309184,
45226020981).

The static dashboard (M8C) reads one quality summary through a file picker,
makes no network requests (`connect-src 'none'`) and shows the CI verdict as
UNVERIFIED, because a summary never records one.

Two facts constrain publication:

- **A bundle is unsigned local JSON.** Anyone who can edit the file can make
  it claim `VERIFIED_PASS`. Its schema validity, its self-reported
  `artifact.digest: "verified"` and its own SHA-256 prove only that it is a
  well-formed file with a fixed content — not that GitHub or a trusted
  operator produced that content.
- **A browser cannot authenticate the source.** With no network access and no
  credentials, the page can only display what it was built with.

Three trust models were compared in a read-only review (2026-11-26):

| Model                                                | Who asserts trust               | Browser can authenticate   | Verdict                          |
| ---------------------------------------------------- | ------------------------------- | -------------------------- | -------------------------------- |
| A. Publisher-side verification in a controlled build | The publisher's build           | No — a publisher statement | **Adopted**                      |
| B1. Publisher-signed manifest                        | The publisher's key             | Proves authorship only     | Deferred (key management)        |
| B2. GitHub artifact attestations issued in CI        | GitHub OIDC identity of the run | Offline, with `gh` tooling | Deferred (new CI permissions)    |
| C. Unsigned JSON imported in the browser             | Whoever produced the file       | No                         | Local, unauthenticated view only |

B2 would need `id-token: write` and `attestations: write`, which ADR-0010
trust policy rule 7 does not allow; adopting it requires its own decision.

## Decision

### Publisher-verification flow (Model A)

1. **Allow-list.** The publisher names specific `(run ID, attempt)` pairs in
   an explicit build input. No directory is scanned; nothing else is read.
2. **Retrieve.** For each pair, the committed operator transport retrieves
   authoritative GitHub evidence with the read-only
   `QUALITY_VERDICT_GITHUB_TOKEN`, during the build.
3. **Reconcile.** The unchanged ADR-0010 reconciler decides the Gate verdict
   and summary state from that freshly retrieved evidence (identity,
   ancestry, Gate outcome, artifact digest, schema).
4. **Establish what is currently verifiable.** A claim is labelled
   publisher-verified only if this build established it (see
   "Publication authenticity"). Anything older is labelled historical or
   omitted.
5. **Project.** A pure function turns the results into a deterministic,
   allow-listed publication manifest (schema below).
6. **Compile.** The manifest is embedded in the static dashboard build as
   data; the page still fetches nothing.
7. **Browser stays credential-free.** No GitHub API access, token or signed
   URL in any published asset.

Prohibited: scanning arbitrary directories, uploading local evidence bundles
publicly, and publishing raw reports, tokens, signed storage URLs, local paths
or whole input bundles.

### Trust boundary

```
 PUBLISHER MACHINE (trusted; inside the boundary)
 ┌──────────────────────────────────────────────────────────────────────┐
 │ clean checkout at source commit S                                    │
 │ QUALITY_VERDICT_GITHUB_TOKEN (env, read-only) ──┐                    │
 │ allow-list: (run, attempt)[, retained bundle SHA-256]                │
 │                                                 ▼                    │
 │   GitHub REST (6 read-only GETs) ──► operator transport ──► reconcile│
 │   optional retained bundles (0700 dir, 0600 files, pinned by hash)   │
 │                     └──────────► strict parse ──┐                    │
 │                                                 ▼                    │
 │                         pure projection ──► publication manifest     │
 │                                                 │ (deterministic)    │
 │                         dashboard build ◄───────┘                    │
 │                         + output scan (secrets, paths, URLs)         │
 └───────────────────────────────────────┬──────────────────────────────┘
                                         │ static files only
 PUBLIC (untrusted readers; outside)      ▼
   static host (M8F, not authorized) ──► browser: no network, no token
   recruiter cross-checks run facts on public GitHub independently
```

Everything inside the box is the publisher's responsibility. Compromise of the
publisher machine or a dishonest publisher is a residual risk of Model A; only
B2 would remove it.

### Five separate dimensions

Each published result carries these independently; none may be derived from
another:

| Dimension                | Values                                                                                            | Source                     |
| ------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------- |
| Gate verdict             | the 8 ADR-0010 states, unchanged                                                                  | reconciler                 |
| Summary integrity        | the 6 ADR-0010 states, unchanged                                                                  | reconciler                 |
| Publication authenticity | `BUILD_VERIFIED`, `RETAINED_UNAUTHENTICATED`, `IMPORTED_UNAUTHENTICATED`, `SYNTHETIC`, `REJECTED` | this ADR                   |
| Evidence freshness       | `CURRENT`, `HISTORICAL`                                                                           | this ADR (PROPOSED POLICY) |
| Source                   | `real`, `synthetic`                                                                               | this ADR                   |

Authenticity and freshness are recorded **per claim**: the Gate verdict and
the metrics of one run may have different values (for example a verdict
re-verified in this build next to metrics whose artifact has expired).

### Publication authenticity

| State                      | Eligibility (all required)                                                                                                                                                                                                                                                                                                                                     | Label shown                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `BUILD_VERIFIED`           | Established **in this build** from evidence the committed transport retrieved during the build, reconciled by the committed reconciler at the build's source commit, from a clean working tree. For metrics additionally: the archive was downloaded in this build and its SHA-256 matched the API digest, and the summary state is `SUMMARY_VERIFIED_ORIGIN`. | "Verified by the publisher's build on `<builtAt>`"                                 |
| `RETAINED_UNAUTHENTICATED` | A previously written local bundle, named in the allow-list by its expected SHA-256, that passes strict parsing and every consistency rule below. Its content is the publisher's record of an earlier check; nothing re-establishes it.                                                                                                                         | "Historical retained evidence — publisher's record, not re-verified"               |
| `IMPORTED_UNAUTHENTICATED` | Any file a viewer opens with the file picker. Local view only; never published, never aggregated.                                                                                                                                                                                                                                                              | "Imported file — not authenticated. It claims `<STATE>`."                          |
| `SYNTHETIC`                | Data generated from repository fixtures for demonstration.                                                                                                                                                                                                                                                                                                     | "SYNTHETIC DEMONSTRATION DATA — not a real CI result"                              |
| `REJECTED`                 | Input that fails strict parsing, a consistency rule, a size or version limit, or its pinned hash.                                                                                                                                                                                                                                                              | "Evidence rejected: `<fixed code>`" (local view); a publication build fails closed |

Rules:

- **No self-promotion.** Nothing read from a file — retained or imported, with
  any content — can become `BUILD_VERIFIED`. Only a claim this build
  established can carry it. A file claiming `VERIFIED_PASS` is displayed as a
  claim, without verified styling.
- **A retained bundle's own SHA-256 pins which file was selected; it does not
  prove its origin.**
- **PR-origin runs stay untrusted.** A `pull_request` run can never have a
  verified Gate verdict (ADR-0010 rule 2). If such runs are published at all
  (open decision; default: excluded), they appear only in a separate
  "Untrusted origin" section and never in totals.
- **Synthetic and real never mix.** Synthetic results live in a separate
  manifest section rendered in a separate, permanently bannered view, and are
  never counted with real results.
- **Fail closed.** Any `REJECTED` allow-listed input stops the publication
  build; nothing partial is written.

### Retained-bundle safeguards

A retained bundle may only ever yield `RETAINED_UNAUTHENTICATED`, and only
when all of these hold:

1. It is named explicitly in the allow-list by run ID, attempt and expected
   SHA-256; the computed hash matches.
2. It is a regular file (no symlink), owned by the publisher, mode 0600, in a
   0700 owner-owned directory, at most 64 KiB.
3. It passes a strict parser: `kind` `quality-verdict-bundle`, supported
   major version, no unknown fields at any level, fixed vocabularies for every
   state and reason code, integer and SHA formats.
4. It is internally consistent: `request` equals `identity`; `VERIFIED_*` and
   `SUMMARY_VERIFIED_ORIGIN` require event `push`; label `verified-origin`
   requires one of the four trusted verdicts and digest `verified`; metrics
   require label `verified-origin` or `unverified-origin`; `artifact.id`
   equals `identity.artifactId`.
5. If this build also re-derived the Gate verdict for the same attempt, the
   two must agree; any disagreement is `REJECTED` (build fails), never
   reconciled silently.
6. Its metrics are never added to `BUILD_VERIFIED` totals.

### Evidence freshness and expiry (PROPOSED POLICY)

Conservative defaults, requiring approval:

| Situation                                              | Publication behaviour                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed Gate re-verified in this build               | Gate verdict `BUILD_VERIFIED`, `CURRENT`, `verifiedAt` = `builtAt`                                                                                                                          |
| Summary artifact absent                                | Summary `SUMMARY_UNAVAILABLE` (`artifact-absent`); metrics omitted — never zero                                                                                                             |
| Summary artifact expired (7-day retention)             | Summary `SUMMARY_UNAVAILABLE` (`artifact-expired`); metrics omitted by default. Showing retained metrics as `RETAINED_UNAUTHENTICATED` + `HISTORICAL` is **off** unless separately approved |
| Run metadata no longer retrievable                     | No `BUILD_VERIFIED` claim; the run is omitted or shown only as `RETAINED_UNAUTHENTICATED` + `HISTORICAL`                                                                                    |
| Historical bundle without a recorded verification time | `verifiedAt: null`, shown as "verification date not recorded". Never inferred from artifact `created_at`, file times or the build time                                                      |
| Earlier verification vs this build                     | Every build re-verifies every allow-listed run; no `BUILD_VERIFIED` status is carried over from a previous build                                                                            |
| Viewing an old publication                             | The page shows `builtAt` prominently; when the viewer's clock is more than **30 days** past `builtAt`, a "stale publication" banner is shown (threshold is proposed)                        |

Bundle schema 1.0.0 records no verification time, main tip or ancestry
relation. These are not invented for existing bundles; a later bundle schema
version or the build itself may record them for future verifications.

### Publication manifest (proposed schema)

A new, separate document — not the quality summary (schema 1.0.0) and not the
local bundle (schema 1.0.0):

```jsonc
{
  "manifestSchemaVersion": "1.0.0",
  "kind": "quality-verdict-publication",
  "build": {
    "sourceCommit": "<40-hex commit the dashboard and operator were built from>",
    "builtAt": "<ISO 8601 UTC, supplied explicitly as a build input>",
    "policy": {
      "repositoryId": 0,
      "repositoryFullName": "owner/repo",
      "workflowId": 0,
      "workflowPath": ".github/workflows/tests.yml",
      "workflowName": "…",
      "trustedEvent": "push",
      "trustedBranch": "main",
    },
  },
  "results": [
    {
      "runId": 0,
      "runAttempt": 1,
      "headSha": "<40-hex>",
      "event": "push",
      "gate": {
        "state": "<one of the 8 ADR-0010 verdict states>",
        "reasons": ["<fixed reason codes, sorted>"],
        "authenticity": "BUILD_VERIFIED | RETAINED_UNAUTHENTICATED",
        "freshness": "CURRENT | HISTORICAL",
        "verifiedAt": "<ISO 8601 UTC> | null",
      },
      "summary": {
        "state": "<one of the 6 ADR-0010 summary states>",
        "reasons": ["<fixed reason codes, sorted>"],
        "label": "verified-origin | unverified-origin | null",
      },
      "artifact": {
        "id": 0,
        "digest": "sha256:<64-hex> | null",
        "integrity": "verified-in-build | retained-not-reverified | mismatch | not-checked",
      },
      "metrics": null,
    },
  ],
  "untrustedOrigin": [],
  "synthetic": null,
}
```

- `metrics`, when eligible: `{ "authenticity", "freshness",
"summarySchemaVersion", "totals", "completeness" }` — the same allow-listed
  counters the local bundle carries; never test titles, paths, errors or
  attachments. `null` otherwise, never zero-filled.
- `untrustedOrigin`: the same entry shape for pull-request runs, if published
  at all; never counted.
- `synthetic`: `null`, or `{ "label": "SYNTHETIC DEMONSTRATION DATA",
"results": [...] }` with `authenticity: "SYNTHETIC"` throughout; it may
  instead be a separate file of kind `quality-verdict-demo`.
- **No** local paths, file names of inputs, tokens, signed URLs, URLs of any
  kind, raw API payloads, stack traces or whole input bundles.
- **Deterministic serialization.** Fixed key order as above; `results` sorted
  by `runId`, then `runAttempt`; reasons sorted; integers only; UTF-8, LF line
  endings, two-space indentation, one trailing newline; no clock or randomness
  (`builtAt` is an input). Identical inputs give byte-identical output, and
  the build records the manifest's SHA-256.
- **Limits:** manifest at most 1 MiB and 500 results; unknown fields rejected
  by the reading side as well.

What a reader can and cannot check:

| Independently checkable on public GitHub (no token)                 | Publisher assertion                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| The run exists; its event, branch, attempt, conclusion and head SHA | That the operator actually ran, and ran unmodified, in the build                      |
| The `test` job's and its `Gate` step's conclusions for that attempt | That the published list is complete (no selective omission)                           |
| The head commit is on `main`                                        | `builtAt` and `verifiedAt`                                                            |
| The artifact's ID and API digest in the artifact metadata           | Metrics — checkable only by downloading the artifact (GitHub login, within retention) |

### Static dashboard contract

- Offline and credential-free as today: CSP `connect-src 'none'`, no
  `fetch`, no token. The manifest is compiled into the build.
- Every state is shown with text and an icon, never colour alone:

| Gate verdict           | Label                                                   |
| ---------------------- | ------------------------------------------------------- |
| `VERIFIED_PASS`        | ✓ Verified pass                                         |
| `VERIFIED_FAIL`        | ✗ Verified Gate failure                                 |
| `EXECUTION_FAILED`     | ⚠ Pipeline failed before a verdict (not a test failure) |
| `CANCELLED`            | ⊘ Cancelled                                             |
| `PENDING`              | … In progress                                           |
| `UNTRUSTED_PROVENANCE` | ? Unverified origin (pull request)                      |
| `CONFLICT`             | ⚠ Evidence conflict — `<reason>`                        |
| `UNKNOWN`              | ? Could not verify — `<reason>`                         |

| Summary state             | Label                                              |
| ------------------------- | -------------------------------------------------- |
| `SUMMARY_VERIFIED_ORIGIN` | Metrics from a verified origin                     |
| `SUMMARY_INFORMATIVE`     | Metrics shown with an "unverified origin" banner   |
| `SUMMARY_UNAVAILABLE`     | Metrics unavailable — `<reason>` (never zeros)     |
| `SUMMARY_INVALID`         | Summary invalid — `<reason>`                       |
| `SUMMARY_CONFLICT`        | Summary conflict — possible tampering — `<reason>` |
| `SUMMARY_UNKNOWN`         | Summary could not be checked — `<reason>`          |

- The authenticity and freshness labels above are shown next to every claim.
- The file picker remains a local-only view: anything opened there is
  `IMPORTED_UNAUTHENTICATED` or `REJECTED`, kept apart from published results,
  and never aggregated.
- Minimum future changes: a strict manifest parser and a verdict view model
  next to the existing summary model; a verdict panel and per-run list in the
  page; a separate synthetic view; build-time embedding of the manifest.

### Security gates required before any publication

1. Strict parsing of bundles and manifests: unknown-field rejection, size,
   depth and schema-version limits, fixed vocabularies.
2. Tests proving no trust promotion (forged `VERIFIED_PASS` files, PR events,
   label/verdict combinations, retained-vs-rebuilt disagreement).
3. Build-output scan: no token names or prefixes, `Bearer`, signed-URL
   markers, storage hosts, absolute or home paths, canaries; only allow-listed
   output files.
4. Browser CSP and no-network checks extended to the manifest view.
5. Cross-browser functional tests and accessibility scans for every state.
6. Hosting security headers verified on the deployed origin.
7. A separate, explicit publication authorization (M8F).

### Implementation phases (each separately authorized)

| Phase | Scope                                                 | Proposed files                                                                                                                                 | Acceptance                                                                                                                                                          |
| ----- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | Pure bundle parser and manifest contract              | `src/reporting/verdict-bundle.ts` (+ test), `src/reporting/publication-manifest.ts` (+ test)                                                   | Strict parsing; every consistency rule; no promotion; byte-identical serialization; limits; synthetic canaries never serialized                                     |
| P2    | Controlled publisher-side verification and generation | `scripts/build-publication.ts`, a pure orchestration module under `src/reporting/` (+ test)                                                    | Allow-list only; clean tree and recorded source commit; fresh verification per build; retained-bundle safeguards; fails closed on any rejection; no paths in output |
| P3    | Dashboard verdict presentation and evidence-state UI  | `src/reporting/verdict-view.ts` (+ test), `dashboard/app.ts`, `dashboard/index.html`, `dashboard/styles.css`, `scripts/build-dashboard.ts`     | Every state and label in the tables above; picker capped at `IMPORTED_UNAUTHENTICATED`; CSP unchanged                                                               |
| P4    | Synthetic demonstration mode and security scans       | synthetic manifest generator under `src/reporting/` (+ test), `scripts/scan-build-output.ts` (+ test)                                          | Separate, permanently bannered view; never in real totals; scan refuses secrets, paths and URLs                                                                     |
| P5    | Browser, accessibility and security validation        | `tests/ui/dashboard-harness.ts`, `tests/ui/dashboard.spec.ts`, `tests/ui/dashboard.a11y.spec.ts`, new `tests/ui/dashboard-publication.spec.ts` | All states in three browsers; axe scans; no network; expired case shows no zeros; PR results separated                                                              |
| P6    | Publication-readiness review                          | documentation only                                                                                                                             | Security review per ADR-0009; header contract for the chosen host; M8F decision record                                                                              |

M8F (hosting and deployment) follows only after explicit approval.

### Open decisions

1. Whether pull-request runs are published at all (default: excluded).
2. The freshness policy above: the 30-day stale threshold and whether
   historical retained metrics may ever be shown.
3. Whether the build may link to GitHub run pages; the current build refuses
   any `http(s)://` text, so links would need a narrow, reviewed exception.
4. A later bundle schema version that records verification time, main tip and
   ancestry relation.
5. Where the publication build runs (publisher machine only, or a dedicated
   CI job holding the token as a secret — a new credential surface).
6. Hosting provider and its support for response headers (needed for
   `frame-ancestors`, HSTS and the other headers a meta tag cannot set).
7. Adopting B2 attestations later (requires a CI permission change and an
   ADR-0010 amendment).
8. Whether the file picker stays in the published build.

## Consequences

- A published "verified" result is honestly labelled as the publisher's
  build statement, with the facts a reader can check on GitHub identified.
- Metrics disappear from publication when their artifact expires, unless a
  later approval allows clearly labelled historical retained metrics.
- Every publication build needs the operator token and network access on the
  publisher's side; the published page needs neither.
- The quality summary, the local bundle and the ADR-0010 state vocabularies
  are unchanged.

## Alternatives considered

| Alternative                                    | Why rejected or deferred                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Publish retained bundles as verified           | Their content is self-asserted; their hash proves no origin              |
| Let the browser verify against GitHub          | Needs network access and, for artifacts, a token; breaks the offline CSP |
| Publisher-signed manifest (B1)                 | Proves authorship, not CI truth; adds key management                     |
| GitHub artifact attestations (B2)              | Strongest independent proof; needs new CI permissions — deferred         |
| Accept imported JSON as published evidence (C) | Anyone can write any claim                                               |

## Verification

Documentation only. Each implementation phase above carries its own tests and
authorization; nothing is published until M8F is approved.

## Related

- [ADR-0010](0010-quality-verdict-provenance.md) — trust policy, verdict and summary states, identity contract
- [ADR-0009](0009-quality-reporting-dashboard.md) — quality summary and static dashboard
- [`docs/security-testing-policy.md`](../security-testing-policy.md) — exposure surfaces, quality summary artifact (S11)
- `src/reporting/verdict.ts`, `src/reporting/verdict-cli.ts`, `scripts/verify-quality-verdict.ts`
