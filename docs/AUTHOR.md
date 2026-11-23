# About the author

Maintained by [NuRNYC](https://github.com/NuRNYC). Senior SDET / QE Architect
with 15+ years across enterprise test automation, API testing, cloud/IaC and
CI/CD. Current focus: AI Quality Engineering — applying QE discipline to GenAI
and LLM-based systems.

[LinkedIn](https://www.linkedin.com/in/asmnuralam/)

## Why this repository exists

An independently authored, public demonstration of maintainable Playwright +
TypeScript architecture. It contains no employer code and does not represent
any employer's framework.

## Where to look

- [ADRs](adr/) — decisions, the alternatives rejected, and assumptions that
  measurement overturned
- [Security testing policy](security-testing-policy.md)
- [`src/config/`](../src/config/) — a pure core with permanent unit tests
- [`src/fixtures/test.ts`](../src/fixtures/test.ts) and [`src/pages/`](../src/pages/) —
  dependency injection via fixtures, page objects without assertions

## How it is built

Milestone-driven: each change starts as a scoped brief, needs explicit approval,
lands on a feature branch, and merges only after verification and a green
required check. Development is AI-assisted (Claude Code) under human review.
