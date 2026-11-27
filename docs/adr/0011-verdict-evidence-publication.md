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
- **Amended:** 2026-11-26 — P1 implementation alignment (PR #34), the P2
  trusted-publisher contract and the exclusive-claim generation commit;
  2026-11-26 — P2 implementation status, inode-reuse clarification and the
  accepted P3 dashboard-integration architecture; 2026-11-27 — P3
  implementation status and the P4 synthetic demonstration contract; see
  [Amendments](#amendments). The original text below is kept as written.

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

## Amendments

### 2026-11-26 — P1 implementation alignment (PR #34, merge `a619a749`)

P1 (`src/reporting/verdict-bundle.ts`, `src/reporting/publication-manifest.ts`)
implements this record with the following clarifications. Where they differ
from the text above, this amendment governs.

1. **Freshness policy approved.** The maintainer approved the policy marked
   PROPOSED POLICY above on 2026-11-26, with two additions: publication age
   and verification age are tracked separately, and a publication more than
   30 days past `builtAt` shows a stale-publication notice.
2. **Synthetic freshness is `NOT_APPLICABLE`.** The freshness dimension has
   three values: `CURRENT` (established by this build), `HISTORICAL` (real
   retained evidence, not re-verified) and `NOT_APPLICABLE` (synthetic data,
   which is evidence of no real run). Synthetic Gate and metrics claims carry
   `NOT_APPLICABLE` and `verifiedAt: null`, and are never presented as
   historical real evidence.
3. **Identity conflicts.** The reconciler copies the run-attempt response's
   `id` and `run_attempt` into `identity`. A bundle whose `identity` differs
   from `request` is structurally valid only as `CONFLICT` carrying exactly
   `identity-run-id-mismatch` and/or `identity-attempt-mismatch`, each reason
   present if and only if its field differs. Such a bundle is accepted by the
   strict parser (and shown only as `IMPORTED_UNAUTHENTICATED` when imported)
   but is **not publishable** under manifest 1.0.0, because its head SHA is not
   attributable to the requested attempt.
4. **`identity-mismatch`.** The manifest build fails closed with the fixed code
   `identity-mismatch` for identity-conflict evidence, whether build-verified,
   retained or synthetic. It is never silently omitted, promoted to
   `BUILD_VERIFIED` or counted in totals.
5. **Metrics.** Only `SUMMARY_VERIFIED_ORIGIN` metrics whose archive digest
   matched in this build are published (`BUILD_VERIFIED`, `CURRENT`).
   `SUMMARY_INFORMATIVE` metrics are omitted (`metrics: null`). Historical
   retained metrics are disabled; P1 provides no switch to enable them.

### 2026-11-26 — P2 trusted-publisher contract (design; P2B not yet implemented)

This section fixes the contract for P2B. It authorizes no implementation, no
live run and no publication.

#### Execution policy

- **Allow-list.** A private JSON file outside the repository, named by an
  absolute path. It lists `(runId, runAttempt)` pairs and, optionally, the
  expected SHA-256 of a retained bundle. It contains no paths; nothing is
  scanned.
- **Evidence acquisition.** The production publisher calls the committed
  `createTransport` and `collectEvidence` (`src/reporting/verdict-cli.ts`)
  directly, in the same process that builds the manifest. No production
  interface accepts `Collected` evidence, a verdict or an authenticity value
  from a caller. Dependency injection of HTTP, filesystem, git and clock
  adapters exists for tests only and is wired to real adapters solely by the
  entry script.
- **No authentication by types or identity.** TypeScript types, object
  identity and module-private registries do not authenticate evidence. No
  `WeakSet` or similar marker is used as a security control. The trust
  boundary is the publisher process as a whole (see "Runtime trust
  assumptions").
- **Credential.** `QUALITY_VERDICT_GITHUB_TOKEN`, the dedicated fine-grained
  read-only token, is the only API credential. It is read once by the entry
  script, never accepted as an argument, read from a file or obtained from
  `gh`, and never printed or written. No new GitHub permissions.
- **Dangerous runtime configuration is refused before any network access.**
  The publisher stops with `unsafe-runtime` if `process.execArgv` is non-empty
  or any of these environment variables is set (values are never read, only
  presence): `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`,
  `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`,
  `ALL_PROXY` (and their lower-case forms), `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`.
- **Configuration-boundary exception.** Application configuration is otherwise
  read only in `src/config/index.ts`. As with the M8B and M8E-4 entry scripts,
  `scripts/build-publication.ts` is a documented exception limited to: reading
  `QUALITY_VERDICT_GITHUB_TOKEN`, and checking the presence of the variables
  listed above. It reads no other environment value.
- **`builtAt`.** Supplied explicitly as ISO 8601 UTC and refused unless within
  ±15 minutes of the system UTC clock. This is a sanity check against
  accidental back- or forward-dating, not a trusted timestamp: the publisher
  controls both the value and the clock.
- **Source commit.** Supplied explicitly. HEAD must equal it, the working tree
  must be clean (`git status --porcelain=v1 --untracked-files=all` empty; git
  run without a shell and with a minimal environment), and the commit must be
  identical to or an ancestor of the `main` tip, checked with the same
  transport's ref and compare operations.
- **Dependencies.** The build record includes the SHA-256 of `package-lock.json`
  at the source commit. The publisher requires that dependencies were
  installed by the documented trusted procedure (`npm ci` from a clean
  checkout of that commit, run by the maintainer before the build). The
  publisher never runs `npm ci` or any install itself.
- **Fail closed.** Digest mismatch, any `SUMMARY_CONFLICT`, `PENDING`,
  permission errors, rate limits, ambiguous or malformed metadata, and
  transport failures fail the complete build; nothing is written. No
  retries.
- **No omissions; a 404 is unavailable evidence.** A GitHub API 404 on any
  required evidence for an allow-listed run (run attempt, jobs, main ref,
  compare, artifact listing or archive) proves nothing about whether the run
  exists: GitHub also answers 404 when access is missing. Any such 404 fails
  the complete build with `evidence-unavailable`. The run is never omitted,
  never replaced by a retained bundle, never given a `BUILD_VERIFIED` claim,
  and never described as deleted or absent; no HTTP body, URL, authorization
  detail or exception text is recorded. A safely omissible, authoritatively
  absent run is reserved for a separate future decision. In P2 every
  allow-listed run is therefore either published or the build fails. For P2
  this supersedes the "Run metadata no longer retrievable" row of the
  original freshness table above: a run whose evidence cannot be retrieved is
  neither omitted nor shown from a retained bundle.
- **P1 omissions are never reached.** P1 can report the omissions
  `run-not-retrievable` and `untrusted-origin-excluded`. The P2 failure policy
  runs first, so in production neither occurs; if `buildPublicationManifest`
  ever returns a non-empty omission list, the publisher fails with
  `internal-error`. The P1 vocabulary is unchanged.
- **Retained evidence.** A retained bundle never promotes itself to
  `BUILD_VERIFIED`, whatever it contains and whether or not its hash matches.
  It is a cross-check of fresh evidence only; any disagreement fails the
  build, and it never substitutes for evidence that could not be retrieved.
- **Untrusted origin.** Allow-listing a pull-request-origin or otherwise
  untrusted run fails the build (`untrusted-origin`) unless the allow-list
  explicitly sets `includeUntrustedOrigin: true` (open decision 1; default
  false), in which case it appears only in `untrustedOrigin`.

#### Retained-bundle filesystem checks

Performed in this order, all on the publisher's side:

1. The file name comes only from `bundleFileName(runId, runAttempt)` inside the
   directory given by `--evidence-dir`; no other file is opened.
2. `--evidence-dir` is absolute; its real path lies outside the repository,
   contains no `.git` or `.auth` segment, is a directory owned by the
   publisher's UID with mode exactly 0700, and every ancestor up to `/` is
   owned by root or the publisher and is not group- or world-writable.
3. The file is opened with `O_RDONLY | O_NOFOLLOW` (a symlink is refused).
   On the open handle: regular file, owned by the publisher's UID, mode
   exactly 0600, link count 1, size at most 64 KiB. Exactly that many bytes
   are read, end of file is confirmed, and a second `fstat` shows the same
   device, inode and size.
4. The bytes are passed to `parseRetainedBundle` with the allow-listed run,
   attempt and expected SHA-256 (pin, strict parser, byte-identical
   canonical form).

#### Atomic output publication

> Superseded in part on 2026-11-26: steps 3, 6, 7 and 8 and the "No-replace
> rename" limit below are replaced by the
> [exclusive-claim generation commit](#2026-11-26--exclusive-claim-generation-commit).
> The text below is kept as written.

Two designs were compared:

| Design                                                         | Assessment                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Private staging directory committed by one directory rename | **Adopted.** One `rename(2)` on one filesystem makes the complete generation appear at once; a reader never sees one file without the other |
| B. Two file renames with rollback                              | Rejected. The pair is never atomic; a crash or failed rollback between the renames leaves a half-published generation                       |

Design A, exactly:

1. `--out-parent` names an existing directory: absolute, not a symlink, real
   path outside the repository, no `.git` or `.auth` segment, owned by the
   publisher's UID with mode exactly 0700, ancestors as for `--evidence-dir`.
   It is never created or chmod-ed.
2. Everything is computed in memory first: manifest text, its SHA-256 and the
   build record. Any failure up to here writes nothing.
3. The generation name is fixed by the inputs:
   `qvp-<builtAt as YYYYMMDDTHHMMSSZ>-<first 16 hex of the manifest SHA-256>`.
   If anything already exists at that name, the build stops with
   `output-exists`; an existing generation is never overwritten.
4. A staging directory `.qvp-staging-<random>` is created exclusively in
   `--out-parent` (`mkdir` fails if it exists), then confirmed with `lstat`
   to be a directory owned by the publisher; its mode is set to exactly 0700.
5. Exactly two files are created in it, each with
   `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600, `fchmod(0o600)`,
   written in full, `fsync`ed and re-checked by `fstat`:
   `quality-verdict-publication.json` (the manifest text) and
   `publication-build-record.json` (source commit, `builtAt`, Node version,
   package-lock SHA-256, allow-list SHA-256 and manifest SHA-256; no
   omissions, paths, tokens or response data).
6. The staging directory is `fsync`ed; the parent, the staging directory and
   both files are re-validated (ownership, modes, identities); the target name
   is checked to be still absent.
7. Commit: one `rename(staging, generation)` within `--out-parent`, then
   `fsync` of `--out-parent`.
8. On any handled failure before the commit, the publisher removes the files it
   created and its own staging directory, and nothing else.

Limits, stated explicitly. The rename gives **atomic visibility**, not crash
durability: a reader sees either no generation or the complete one, but a
crash can still leave debris before the commit or lose the commit after it.

- **Not crash-atomic for staging.** A crash or kill before step 7 leaves an
  incomplete `.qvp-staging-*` directory. It is never read: the dashboard
  build selects only a named generation (below). The publisher never deletes
  staging directories it did not create in the same run; leftovers are
  removed by the maintainer.
- **Durability after commit.** A crash between the rename and the parent
  `fsync` may lose the generation on some filesystems; the SHA-256 pin below
  detects any incomplete or altered generation.
- **No-replace rename.** Node offers no `RENAME_NOREPLACE`; on POSIX a
  directory rename can replace an empty directory. The pre-commit absence
  check plus the publisher-only 0700 parent restrict that race to processes
  of the publisher's own user, which is within the trust boundary.

Dashboard selection (P3) never scans: the dashboard build receives the
generation's absolute path and the expected manifest SHA-256. It refuses
unless the directory name matches the generation pattern, the directory is
publisher-owned with mode 0700 and contains exactly the two files (0600,
regular, not symlinks), the manifest's SHA-256 equals the supplied pin and
the build record's value, and the manifest passes a strict reader.

#### CLI contract

```
QUALITY_VERDICT_GITHUB_TOKEN=… node scripts/build-publication.ts \
  --allowlist <absolute file> --out-parent <absolute directory> \
  --source-commit <40-hex> --built-at <ISO 8601 UTC> \
  [--evidence-dir <absolute directory>]
```

Each option exactly once; no positional arguments; unknown options are a
usage error. `--evidence-dir` is required if and only if an allow-list entry
pins a retained bundle. Standard output is one fixed line: the result code
and, on success, the generation name and the manifest SHA-256 (no paths).
Exit codes: `0` generation committed; `1` refused or failed, nothing
committed; `2` usage error.

Allow-list document (at most 64 KiB and 500 entries; unknown fields and
duplicate `(runId, runAttempt)` pairs refused before any network request):

```jsonc
{
  "allowListSchemaVersion": "1.0.0",
  "kind": "quality-verdict-publication-allowlist",
  "includeUntrustedOrigin": false,
  "entries": [{ "runId": 0, "runAttempt": 1, "retained": null }],
  // or "retained": { "sha256": "<64 lowercase hex>" }
}
```

#### Failure matrix

All codes are fixed, non-sensitive strings. No token, API body, URL, signed
URL, path or exception text enters the manifest, the build record or the
console line. "Build fails" means exit 1 with nothing committed.

| Situation                                                                                          | Outcome                                                                                                        | Code                                                                  |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Any 404 on required evidence (run attempt, jobs, main ref, compare, artifact listing or archive)   | Build fails; no omission, no retained substitution, no `BUILD_VERIFIED`, no inference that the run was deleted | `evidence-unavailable`                                                |
| Jobs unavailable (any other failure)                                                               | Build fails                                                                                                    | `evidence-unavailable`                                                |
| Ancestry unknown (ref or compare failure)                                                          | Build fails                                                                                                    | `evidence-unavailable`                                                |
| Permission failure anywhere (401/403, token absent or under-scoped)                                | Build fails                                                                                                    | `token-rejected` / `missing-token`                                    |
| Rate limit anywhere                                                                                | Build fails; no retry                                                                                          | `rate-limited`                                                        |
| Timeout, network, HTTP error, malformed body, incomplete pagination                                | Build fails                                                                                                    | `evidence-unavailable`                                                |
| Untrusted origin (pull request, branch, ahead of or diverged from main)                            | Build fails unless `includeUntrustedOrigin` is true; then `untrustedOrigin` only                               | `untrusted-origin`                                                    |
| Incomplete execution (`PENDING`)                                                                   | Build fails                                                                                                    | `run-not-completed`                                                   |
| Verdict `UNKNOWN` for a non-retrieval reason (no test job, Gate not decisive, unmapped conclusion) | Build fails (ambiguous)                                                                                        | `verdict-undetermined`                                                |
| Outcome `CONFLICT`, `CANCELLED`, `EXECUTION_FAILED`, `VERIFIED_FAIL`                               | Published as established, `BUILD_VERIFIED`; never counted as a pass                                            | —                                                                     |
| Summary artifact absent or expired                                                                 | Published: `SUMMARY_UNAVAILABLE`, metrics `null` (never zero)                                                  | —                                                                     |
| Summary or artifact listing not retrievable (`SUMMARY_UNKNOWN`)                                    | Build fails                                                                                                    | `evidence-unavailable`                                                |
| Archive invalid after a matching digest (unexpected entries, too large, invalid summary)           | Published: `SUMMARY_INVALID`, metrics `null`                                                                   | —                                                                     |
| Digest mismatch                                                                                    | Build fails (security)                                                                                         | `digest-mismatch`                                                     |
| Any other `SUMMARY_CONFLICT` (artifact substitution, summary mismatch)                             | Build fails (security)                                                                                         | `summary-conflict`                                                    |
| Storage redirect outside the allow-listed hosts                                                    | Build fails (security)                                                                                         | `storage-redirect-refused`                                            |
| Identity conflict (response for another run or attempt)                                            | Build fails                                                                                                    | `identity-mismatch`                                                   |
| Retained bundle disagrees with fresh evidence                                                      | Build fails                                                                                                    | `retained-disagrees`                                                  |
| Retained file: ownership, mode, type, link count, size, hash or schema                             | Build fails                                                                                                    | `retained-rejected`                                                   |
| Duplicate allow-list entry; invalid allow-list                                                     | Refused before any network request                                                                             | `invalid-allowlist`                                                   |
| Dirty tree; HEAD differs; commit not on `main`                                                     | Refused                                                                                                        | `dirty-tree` / `source-commit-mismatch` / `source-commit-not-on-main` |
| `builtAt` invalid or outside ±15 minutes                                                           | Refused                                                                                                        | `invalid-built-at`                                                    |
| Dangerous runtime configuration                                                                    | Refused before any network request                                                                             | `unsafe-runtime`                                                      |
| Unsafe `--out-parent` or `--evidence-dir`                                                          | Refused                                                                                                        | `unsafe-output-path` / `unsafe-evidence-dir`                          |
| Generation name already exists                                                                     | Refused; nothing overwritten                                                                                   | `output-exists`                                                       |
| Staging creation, file write or re-validation fails                                                | Own staging removed; build fails                                                                               | `staging-failed`                                                      |
| Directory rename (commit) fails                                                                    | Own staging removed; build fails                                                                               | `commit-failed`                                                       |
| Any unexpected exception                                                                           | Build fails                                                                                                    | `internal-error`                                                      |

An expired artifact is not a 404: it is recognized only from the artifact
listing's `expired` flag or the archive endpoint's 410 response, and is
published as `SUMMARY_UNAVAILABLE` (`artifact-expired`). An artifact that is
simply not in a successfully retrieved listing is `artifact-absent`.

#### Runtime trust assumptions

- The publisher machine, its OS user and its Node runtime are trusted; the
  machine's compromise or a dishonest publisher remains a residual risk of
  Model A.
- In-process code can forge evidence (for example by replacing `fetch` or
  loading a preload module). The runtime checks above refuse the identified
  configuration routes; they cannot detect a compromised dependency or
  runtime.
- The dependency tree is trusted as installed by `npm ci` from the lockfile at
  the source commit; the build record pins the lockfile hash, not the
  installed files.
- `builtAt`, the allow-list's completeness and the fact that the committed
  code ran unmodified remain publisher assertions.

#### P2B implementation contract

Files (new; no existing M8E-4 or P1 module changes without a later explicit
authorization):

- `src/reporting/publication-publisher.ts`: the allow-list parser; the
  pre-flight checks; `runPublication(args, deps)`, which creates the
  transport and calls `collectEvidence` itself; the failure policy above,
  applied to raw `Collected` evidence before `buildPublicationManifest`; the
  retained-file reader; the staging and commit protocol; Node adapters for
  the private reader, the git probe and directory operations.
- `src/reporting/publication-publisher.test.ts`: synthetic tests only, using
  a fake HTTP router and in-memory or `mkdtemp` filesystems.
- `scripts/build-publication.ts`: the entry script and the only place that
  reads the token, checks the runtime configuration, reads the clock and
  wires the real adapters.

Required security tests (no live GitHub calls, real tokens or real archives):
forged `Collected` is not accepted by any production interface; extra
allow-list fields claiming a verdict or authenticity are refused; every row of
the failure matrix; a 404 from each of the six operations fails with
`evidence-unavailable`, with or without a pinned retained bundle, leaving
nothing written and no omission recorded; a non-empty P1 omission list fails
with `internal-error`; pull-request origin; attempt and artifact substitution;
retained-bundle tampering, re-pinned forgeries and disagreement; symlink,
hard-link, wrong-mode, wrong-owner, writable-ancestor and in-repository path
attacks; dirty checkout, HEAD mismatch and source commit not on `main`;
dangerous runtime configuration refused with zero network requests; duplicate
entries refused with zero network requests; shuffled allow-list order giving
byte-identical output; exactly two files in a committed generation and nothing
else in `--out-parent`; no staging left after handled failures; existing
generations never replaced; token, signed-URL, path and canary strings absent
from every output and console line.

Acceptance: every matrix row has a test; `npm run verify` passes with the
existing 673 tests unchanged; the module exposes no evidence input; output is
deterministic; a generation is committed only by one directory rename; a live
run needs its own authorization.

### 2026-11-26 — Exclusive-claim generation commit

Decision (maintainer, 2026-11-26): the generation is committed by an
**exclusive destination-name claim followed by one atomic directory rename
onto that claim**. This supersedes steps 3, 6, 7 and 8 of "Atomic output
publication" above and its "No-replace rename" limit. Writing directly into
the destination directory was rejected (it would expose partial
publications); the earlier check-then-rename implementation (PR #36 head
`bf3e9cc`) was rejected because a directory created at the target between
the final absence check and the rename is an empty directory that `rename(2)`
replaces, after which the publisher still reported success.

Background, measured on macOS (Node v24.22.3) and documented for Linux
`rename(2)`: a directory rename fails with `ENOTEMPTY`/`EEXIST` onto a
non-empty directory and `ENOTDIR` onto a file or symlink, but **replaces an
empty directory**. `fs.rename` takes no flags, and Node exposes neither
`renameat2(RENAME_NOREPLACE)` nor `renamex_np(RENAME_EXCL)`. Node's ordinary
rename is therefore not an unconditional no-replace primitive, and no
portable, dependency-free design can make it one. `mkdir` is exclusive: it
fails with `EEXIST` for any existing entry.

#### Commit protocol

1. Build and validate the manifest, the build record and every check of the
   P2 contract in memory; nothing is written before this completes.
2. Derive the deterministic generation name
   `qvp-<builtAt as YYYYMMDDTHHMMSSZ>-<first 16 hex of the manifest SHA-256>`.
3. **Claim** the destination: `mkdir(<out-parent>/<generation>, 0o700)`.
4. If any entry already exists at that name (empty or non-empty directory,
   file, symlink or dangling symlink), stop with `output-exists`; the existing
   entry is not read, modified or removed.
5. Confirm the claim with `lstat` (a directory owned by the publisher), set
   its mode to exactly 0700, and record its identity (`dev:ino`).
6. Create an independent private staging directory
   `<out-parent>/.qvp-staging-<random>` exclusively, mode exactly 0700.
7. Create `quality-verdict-publication.json` and
   `publication-build-record.json` in staging with
   `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600 and `fchmod`; write in
   full, `fsync`, and confirm by `fstat`; then `fsync` the staging directory.
8. Validate the output parent (path, ownership, 0700, ancestry), the staging
   directory (identity, owner, 0700, exactly the two file names) and each
   file (regular, owner, 0600, identity).
9. Require the claim to still have its recorded identity, be empty, be owned
   by the publisher and have mode exactly 0700; otherwise stop with
   `commit-failed`.
10. `rename(staging, claim)` within the output parent, which is on one
    filesystem. A rename refused because the destination is no longer an
    empty directory (`EEXIST`, `ENOTEMPTY`, `ENOTDIR`, `EISDIR`) is
    `output-exists`; any other failure is `commit-failed`.
11. Confirm the generation now has the staging directory's identity and
    contains exactly the two files, then `fsync` the output parent. A failure
    here is `commit-failed` and the visible generation is left in place.
12. On any handled failure before step 10 succeeds, remove only resources this
    run created and that still match their recorded identity: its own files,
    its own staging directory, and the claim only if it still has the claim's
    identity and is empty. A foreign or identity-changed entry is never
    deleted or replaced; leftover debris is reported by the fixed code and
    removed by the maintainer.

Failure codes stay within the existing vocabulary: `output-exists`,
`staging-failed` (claim or staging creation, write, fsync or validation
before step 9) and `commit-failed` (steps 9–11).

#### Guarantees and limitations

- **Pre-existing entries are protected.** Exclusive `mkdir` protects any entry
  present when the claim is attempted: it is never modified, replaced or
  removed, whatever its type and whether or not it is empty.
- **Atomic visibility.** Fully written, fsynced and validated publication data
  becomes visible through one directory rename; no reader can observe a
  partially written generation's content.
- **An empty claim is not a publication.** Between steps 3 and 10 the
  generation name holds an empty directory; it is not a completed publication.
- **Residual race.** A process running as the same OS user can still
  substitute its own empty directory for the claim after the step 9
  validation and before the rename; the rename then replaces that empty
  directory. This race is narrowed, not eliminated: it can affect only an
  empty directory placed under a name this run had already claimed, never an
  entry that existed before the claim and never an entry containing data.
- **Trust assumption.** The accepted model trusts the publisher's OS user and
  every process sharing that identity; only they can write in the 0700
  output parent.
- **Crashes.** A crash or kill may leave an empty claim, a staging directory,
  or both. A later run with the same generation name stops with
  `output-exists` until the maintainer removes the debris.
- **Atomic visibility is not crash durability.** A crash between the rename
  and the parent `fsync` may lose the commit on some filesystems; the SHA-256
  pin detects an incomplete or altered generation.
- **Readers (P3).** The dashboard build must receive an explicit generation
  path and the expected manifest SHA-256, and must reject an empty claim or
  any directory that does not contain exactly the two 0600 regular files whose
  manifest hash matches both the pin and the build record. It never scans.

#### Required P2B security tests

Commit protocol:

- An empty directory, a non-empty directory, a file, a symlink and a dangling
  symlink already at the generation name: `output-exists`, the entry unchanged
  (same identity and content), and no staging directory created.
- The claim's identity changed before the step 9 validation (removed and
  recreated): `commit-failed`; the substitute is not deleted.
- The claim replaced by a foreign empty directory immediately before the
  rename: the rename replaces it; the test documents this residual limitation
  explicitly rather than asserting it away.
- Data inserted into the claim before the commit: `commit-failed`; the claim
  and the inserted data are left untouched.
- A concurrent run committing the same generation name first (a non-empty
  generation at the name before the rename): `output-exists`; the existing
  generation unchanged.
- Claim and staging modes exactly 0700, and file modes 0600, under umask 000,
  002, 022 and 077.
- Cleanup after each handled failure: only owned, identity-matching resources
  are removed; the claim only when empty and identity-matching.
- Simulated crashes after the claim and after staging: the debris remains,
  and the next same-name run returns `output-exists`.
- A pre-existing completed generation is never replaced or modified.
- A committed generation contains exactly the two files, and its manifest
  SHA-256 matches the build record and the reported value.

Additional P2B requirements recorded with this decision:

- **Duplicate JSON keys.** The allow-list parser rejects duplicate object keys
  at every nesting level, comparing fully decoded names (so an escaped
  spelling such as `"\u0072unId"` equals `"runId"`), with a bounded,
  deterministic pre-parse check rather than a `JSON.parse` reviver, which only
  sees keys after duplicates have collapsed. Malformed escapes and unescaped
  control characters are refused. Errors remain the fixed `invalid-allowlist`.
- **Omission guard.** The rule that a non-empty P1 omission list (or a
  published count differing from the allow-list) is `internal-error` gets an
  isolated regression test through a test-only seam for the manifest builder
  that is not reachable from the production CLI.

### 2026-11-26 — P2 status, inode-reuse clarification and P3 architecture

Documentation only (P3-0). This amendment changes no code, schema or
workflow, and authorizes no implementation, live run or publication.

#### P2 implementation status

The P2 contract above (headed "P2B not yet implemented" when written) and the
exclusive-claim commit are implemented in `src/reporting/publication-publisher.ts`
and `scripts/build-publication.ts` (PR #36, merge `7adb2aaf`). A first,
separately authorized live validation (P2C-2) committed one generation for
run 45888304208, attempt 1, from source commit `7adb2aaf`. That generation is
a private, local record of the publisher's statement at that build. It is
historical evidence: it is not regenerated, edited or copied into the
repository, and nothing has been published. M8F remains unauthorized.

#### Inode reuse and claim identity

This clarifies the "Guarantees and limitations" of the exclusive-claim
generation commit; the protocol itself is unchanged.

- **Inode numbers can be reused.** Linux filesystems (observed in CI on
  2026-11-26) may give a newly created directory the inode number of a
  directory that was just removed. A matching `dev:ino` pair therefore cannot
  establish that the claim existed without interruption; it only shows that
  the entry at the name now has the same identity numbers.
- **The identity checks detect accidental change, not a determined
  same-user process.** A process running as the publisher's OS user can remove
  the empty claim and create a new empty directory, even one that reports the
  same inode, before the rename. The rename then replaces that empty
  directory. This is the residual race already accepted above; inode reuse
  means it may also be invisible to the step 9 check.
- **The guarantee rests on the trust model.** The 0700, publisher-owned output
  parent restricts this to processes of the publisher's own user, which the
  accepted model trusts (see "Runtime trust assumptions"). No defence against
  that user is claimed.
- **Cleanup is non-recursive.** On a handled failure the publisher removes
  only its own files and directories that still match their recorded identity,
  and the claim only when it is also empty. It never removes a directory
  recursively. Because identity can be reused, an identity-matching empty
  directory created by another same-user process could be removed; it holds
  no data, and this stays within the same accepted risk.
- **No unconditional claim is made.** The design does not provide
  unconditional no-replace or no-delete semantics. It guarantees that entries
  present before the claim are never modified, replaced or removed, and that
  no entry containing data is replaced.
- **Atomic visibility is not crash durability.** Unchanged from above.

#### Accepted P3 dashboard-integration architecture (not implemented)

Accepted by the maintainer on 2026-11-26 after the read-only P3-1 review. None
of it is implemented: the dashboard still reads only a quality summary through
the file picker and contains no publication data. Each item needs its own
implementation authorization.

- **Commit binding.** A publication-enabled dashboard build requires its own
  source commit (clean checkout, HEAD) to equal `manifest.build.sourceCommit`,
  as the schema's description of `sourceCommit` states. Consequently the P2C-2
  generation (source commit `7adb2aaf`) cannot be embedded by a dashboard
  build from a later commit; a verified dashboard build needs a fresh,
  separately authorized publisher run at that build's commit.
- **Two readers.** P3 adds a Node-side reader for the trusted build (generation
  directory checks as specified under "Readers (P3)", SHA-256 pin, build-record
  binding, strict manifest parsing with a byte-identical canonical round-trip,
  committed trust policy) and a separate browser-safe reader that re-validates
  the embedded text in the page. The P1 module imports `node:crypto` and is not
  loaded in the browser. The browser reader authenticates nothing; it only
  refuses malformed or contradictory data.
- **Embedding.** The trusted build embeds the verified manifest text as a
  string constant in a generated, same-origin static JavaScript data module.
  The page never fetches a file, and manifest content is never executed as
  code.
- **Browser boundary.** The Content Security Policy keeps `connect-src 'none'`.
  No GitHub API access, token or network verification exists in the browser,
  and a matching hash in the page is never presented as authentication.
- **Uploaded files.** Anything opened with the file picker remains
  `IMPORTED_UNAUTHENTICATED` (or rejected), is shown apart from published
  results and is never aggregated with them.
- **Separation.** Real build-verified results, `untrustedOrigin` results and
  synthetic data stay in separate sections; only `BUILD_VERIFIED` real results
  contribute to verified totals.
- **Deferred.** History across publication generations and any public
  deployment (M8F) remain deferred. No new manifest field is introduced.

### 2026-11-27 — P3 implementation status and P4 synthetic demonstration contract

Documentation only. This amendment changes no code, schema, workflow or
test, and authorizes no implementation, publisher run, hosting or deployment
(M8F remains **not authorized**). Where it differs from earlier text, it
governs for the P4 demonstration path only; the real-publication trust
boundary is unchanged.

#### P3 implementation status

The accepted P3 architecture recorded in the 2026-11-26 amendment ("not
implemented" at that date) has since been implemented and merged:

- **P3-2** strict publication readers and pure view model (PR #39, merge
  `d1da517`): `src/reporting/publication-reader.ts` (Node side) and
  `src/reporting/publication-view.ts` (browser safe).
- **P3-3** trusted static dashboard build integration (PR #40, merge
  `6a02ea3`): `--publication` / `--publication-sha256` in
  `scripts/build-dashboard.ts`, exact source-commit binding to HEAD, and the
  generated `dashboard/publication-data.js` module.
- **P3-4** publication presentation (PR #41, merge `a20f911`).
- **P3-5** controlled real-data validation, accepted by the maintainer on
  2026-11-27 for the Chromium and Safari scope (Firefox manual keyboard check
  deferred). No public deployment was performed.
- **P4-1** standalone build-output scanner (PR #42, merge `77f7729`):
  `scripts/scan-build-output.ts` and `src/reporting/build-output-scanner.ts`.

**Module name.** The original "Implementation phases" table (2026-11-26)
proposed `src/reporting/verdict-view.ts` for P3. That row is kept as written
as a record of the plan; the implemented browser-safe module is
`src/reporting/publication-view.ts`.

#### Data-module states

The generated `dashboard/publication-data.js` keeps exactly two exports,
`PUBLICATION_STATE` and `PUBLICATION_TEXT`. Its state vocabulary is extended
from two to three values. Any other value is refused by the builder, the
browser and the scanner.

| State      | `PUBLICATION_TEXT`                                                           | Meaning                                                                                                              |
| ---------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `none`     | `''`                                                                         | Picker-only dashboard (unchanged)                                                                                    |
| `embedded` | Canonical manifest from one pinned P2 generation                             | The trusted publication path (unchanged: publisher, source-commit binding, pinned-generation Node reader)            |
| `demo`     | Canonical synthetic-only manifest from the committed demonstration generator | Synthetic demonstration; no publisher, no GitHub evidence, no authenticity claim, permanent synthetic identification |

The manifest schema stays `quality-verdict-publication` 1.0.0. No new field
is introduced, and the P1 builder and P3-2 readers keep their semantics; the
demo restrictions below are additional, demo-only checks.

#### Synthetic-only manifest

A `demo` manifest must satisfy all of:

1. `results` is exactly `[]` and `untrustedOrigin` is exactly `[]`.
2. `synthetic` is non-null, carries the exact label
   `SYNTHETIC DEMONSTRATION DATA`, and holds at least one entry.
3. Every synthetic entry has Gate authenticity `SYNTHETIC`, freshness
   `NOT_APPLICABLE`, `verifiedAt: null`, artifact digest `null` and integrity
   `not-checked`; metrics, when present, are `SYNTHETIC` / `NOT_APPLICABLE`.
4. No `BUILD_VERIFIED` or `RETAINED_UNAUTHENTICATED` claim anywhere; no real
   or retained evidence.
5. No synthetic entry has summary state `SUMMARY_VERIFIED_ORIGIN`.
6. No verified real-result totals can arise (there are no real results).
7. No credentials, private paths, private input names or build-record fields.
8. The text is canonical and accepted by the existing strict browser reader
   (`parsePublication`).

#### Demonstration metadata

The `build` fields of a demo manifest are **illustrative schema values, not
provenance**:

- `sourceCommit`: 40 zero characters
  (`0000000000000000000000000000000000000000`). It is never presented as, or
  compared with, the checkout's HEAD.
- `policy`: a clearly fictional, schema-valid identity (for example
  repository `example-owner/example-demo`, fictional repository and workflow
  identifiers, workflow path `.github/workflows/demo.yml`, trusted event
  `push`, branch `main`). It is never compared with the committed
  `TRUST_POLICY`.
- `builtAt`: one fixed, documented UTC timestamp chosen with the generator.
- Run identifiers and head SHAs in synthetic entries are fictional.

Demo mode displays no publication age, no freshness warning and no
current-verification statement.

#### Command line

```
node scripts/build-dashboard.ts --demo [--out <absolute directory>]
```

- `--demo` is mutually exclusive with `--publication` and
  `--publication-sha256`; any combination is a usage error (exit 2).
- The demo path has no authentication or authenticity option, never invokes
  the publisher, never contacts GitHub or downloads artifacts, never runs the
  trusted Node publication reader, needs no git source probe, and accepts no
  token or real-generation input.
- All existing static-build protections (fixed inputs and outputs,
  forbidden-API scan, relative-import resolution, HTML contract, data-module
  acceptance) still apply.
- The production publisher is unchanged.

#### Scenario contract

The committed demonstration generator produces six deterministic synthetic
scenarios, each built through the existing strict bundle path
(`reconcileCollected`, `buildBundle`, `parseVerdictBundle`) and the P1
manifest builder from fixed synthetic evidence, using only the committed
verdict and summary vocabularies:

1. Synthetic successful Gate.
2. Synthetic failed Gate.
3. Synthetic unknown evidence.
4. Synthetic cancelled execution.
5. Synthetic missing summary.
6. Synthetic untrusted provenance.

`VERIFIED_PASS` and `VERIFIED_FAIL` in a synthetic entry are scenario
outcomes only. They never receive publisher-verified styling and never
contribute to verified totals.

#### Defense in depth

Four independent demo-only checks must each refuse a demo that contains real
results, untrusted-origin results, a missing or empty synthetic section,
non-`SYNTHETIC` authenticity, non-`NOT_APPLICABLE` freshness,
`SUMMARY_VERIFIED_ORIGIN`, or any other real-provenance claim:

| Layer                | Behaviour on refusal                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Generator            | Produces no manifest; `demo-generation-failed`                                                               |
| Dashboard builder    | Writes nothing; `demo-not-synthetic-only` (and a usage error, exit 2, for `--demo` with publication options) |
| Browser presentation | Shows a demo-rejected state with code `demo-not-synthetic-only` and no synthetic data                        |
| P4-1 output scanner  | Rejects the output with `demo-not-synthetic-only` (an unknown state stays `data-module-state`)               |

Failure codes are fixed and never contain untrusted content. The general
publication reader (`parsePublication`) is **not** changed to enforce this
demo-only policy.

#### Presentation contract

In `demo` state the page:

- shows a permanent, non-dismissible `SYNTHETIC DEMONSTRATION DATA` banner
  as text (not colour alone), first in the main content and available to
  screen readers;
- prefixes every verdict label with "Synthetic:" and shows synthetic metrics
  in their own, clearly labelled tables;
- shows no real-results panel, no verified real-result totals, no
  publisher-origin authentication statement and no live-publication
  freshness warning;
- keeps the imported-file picker separate and labelled as not authenticated;
- keeps the Content Security Policy with `connect-src 'none'`.

If demo validation or rendering fails, the page rejects the demo rather than
display synthetic evidence without its banner.

#### Scanner contract

The P4-1 scanner may accept `PUBLICATION_STATE = 'demo'` only when the
existing eight-file, HTML and CSP, forbidden-API and leakage checks pass,
the manifest is canonical and accepted by the strict parser, and the
demo-specific synthetic-only rules above pass. A clean scan is never a
publisher-authentication certificate. Integrating the scanner into
`scripts/build-dashboard.ts` is not part of this milestone.

#### Unchanged real-publication boundary

`none` and `embedded` keep their exact current behaviour: the publisher still
writes `synthetic: null`; a publication-enabled build still requires both
publication options, a clean checkout, HEAD equal to
`manifest.build.sourceCommit`, the SHA-256 pin and the committed trust
policy; the browser still caps any imported file at
`IMPORTED_UNAUTHENTICATED`. A demo build can never read a real generation,
and a real build can never embed synthetic data.

## Related

- [ADR-0010](0010-quality-verdict-provenance.md) — trust policy, verdict and summary states, identity contract
- [ADR-0009](0009-quality-reporting-dashboard.md) — quality summary and static dashboard
- [`docs/security-testing-policy.md`](../security-testing-policy.md) — exposure surfaces, quality summary artifact (S11)
- `src/reporting/verdict.ts`, `src/reporting/verdict-cli.ts`, `scripts/verify-quality-verdict.ts`
