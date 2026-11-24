/**
 * Accessibility gate policy: pure, deterministic, unit-tested.
 *
 * axe-core finds problems; this module decides what they mean for the build.
 * The decision is a pure function of its inputs -- the scan's violations, the
 * reviewed exception list, and an injected clock -- so `policy.test.ts` can
 * exercise every rule with object literals and a fixed date, without a
 * browser. Same pattern as `resolveConfig` and `checkSavedSession`.
 *
 * Policy (ADR-0004):
 * - Any confirmed violation fails, whatever its impact.
 * - `incomplete` results are reported, never gated: axe could not decide.
 * - A violation is suppressed only by a valid exception for the same page and
 *   rule, with the same impact, within its node cap, before its review date.
 * - An exception that is expired, unused, severity-mismatched, exceeded or
 *   malformed is itself a failure, so exceptions cannot outlive their reason.
 *
 * This is an automated regression gate, not a WCAG conformance claim.
 *
 * Kept free of `@/` imports and runtime dependencies so Node's type-stripping
 * test runner can load it directly (ADR-0002). Input types are structural:
 * axe's own `AxeResults` satisfies them without this module importing axe.
 */

/** WCAG 2.0, 2.1 and 2.2, levels A and AA. `wcag22a` has no rules in axe-core 4.14.1. */
export const A11Y_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
] as const;

/** Pages with an accessibility scan. Exceptions are always scoped to one of these. */
export const A11Y_PAGES = ['login', 'inventory'] as const;
export type A11yPage = (typeof A11Y_PAGES)[number];

export const IMPACTS = ['minor', 'moderate', 'serious', 'critical'] as const;
export type Impact = (typeof IMPACTS)[number];

/** A reviewed, expiring permission for one known violation on one page. */
export interface A11yException {
  readonly page: A11yPage;
  /** axe rule id, e.g. `color-contrast`. */
  readonly ruleId: string;
  /** Must equal the measured impact; a reclassified rule needs a new review. */
  readonly impact: Impact;
  /** The violation may affect at most this many nodes. */
  readonly maxNodes: number;
  /** Why it cannot be fixed here, e.g. third-party markup with an upstream issue. */
  readonly reason: string;
  /** A role, never a person's name. */
  readonly owner: string;
  /** ISO date `YYYY-MM-DD`, inclusive. After this day the exception fails. */
  readonly reviewBy: string;
}

/** The subset of an axe rule result this module reads. */
export interface AxeRuleResult {
  readonly id: string;
  readonly impact?: Impact | null;
  readonly tags: readonly string[];
  readonly helpUrl: string;
  readonly nodes: readonly unknown[];
}

/** The subset of `AxeResults` this module reads. */
export interface AxeScan {
  readonly violations: readonly AxeRuleResult[];
  readonly incomplete: readonly AxeRuleResult[];
  readonly passes: readonly unknown[];
  readonly testEngine: { readonly version: string };
}

/** Every way the gate can fail, as a discriminated union. */
export type GateFailure =
  | {
      readonly kind: 'violation';
      readonly ruleId: string;
      readonly impact: Impact | null;
      readonly nodeCount: number;
    }
  | {
      readonly kind: 'impact-mismatch';
      readonly ruleId: string;
      readonly expected: Impact;
      readonly actual: Impact | null;
    }
  | {
      readonly kind: 'exceeded';
      readonly ruleId: string;
      readonly maxNodes: number;
      readonly nodeCount: number;
    }
  | { readonly kind: 'expired'; readonly ruleId: string; readonly reviewBy: string }
  | { readonly kind: 'unused'; readonly ruleId: string }
  | { readonly kind: 'invalid-exception'; readonly ruleId: string; readonly problem: string };

export interface ExceptedViolation {
  readonly ruleId: string;
  readonly nodeCount: number;
  readonly reviewBy: string;
}

export interface GateResult {
  readonly page: A11yPage;
  /** Empty means the gate passes. Specs assert `expect(failures).toEqual([])`. */
  readonly failures: readonly GateFailure[];
  readonly excepted: readonly ExceptedViolation[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidISODate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** Today's date in UTC as `YYYY-MM-DD`; comparable as a string. */
function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Structural problems with one exception, or `undefined` if it is well formed. */
export function exceptionProblem(exception: A11yException): string | undefined {
  if (!(A11Y_PAGES as readonly string[]).includes(exception.page)) {
    return `unknown page "${exception.page}"`;
  }
  if (exception.ruleId.trim() === '') {
    return 'ruleId is empty';
  }
  if (!(IMPACTS as readonly string[]).includes(exception.impact)) {
    return `unknown impact "${exception.impact}"`;
  }
  if (!Number.isInteger(exception.maxNodes) || exception.maxNodes < 1) {
    return 'maxNodes must be a positive integer';
  }
  if (exception.reason.trim() === '') {
    return 'reason is empty';
  }
  if (exception.owner.trim() === '') {
    return 'owner is empty';
  }
  if (!isValidISODate(exception.reviewBy)) {
    return 'reviewBy must be an ISO date (YYYY-MM-DD)';
  }
  return undefined;
}

/**
 * Apply the strict gate to one page's violations.
 *
 * @param page       The scanned page; only that page's exceptions apply.
 * @param violations The scan's confirmed violations.
 * @param exceptions The full reviewed exception list.
 * @param now        Injected clock. Never read inside this module.
 */
export function evaluateGate(
  page: A11yPage,
  violations: readonly AxeRuleResult[],
  exceptions: readonly A11yException[],
  now: Date,
): GateResult {
  const today = utcDate(now);
  const failures: GateFailure[] = [];
  const excepted: ExceptedViolation[] = [];

  // Only well-formed, unique exceptions for this page can suppress anything.
  const usable = new Map<string, A11yException>();
  for (const exception of exceptions.filter((e) => e.page === page)) {
    const problem =
      exceptionProblem(exception) ??
      (usable.has(exception.ruleId) ? 'duplicate exception for this page and rule' : undefined);
    if (problem !== undefined) {
      failures.push({ kind: 'invalid-exception', ruleId: exception.ruleId, problem });
    } else {
      usable.set(exception.ruleId, exception);
    }
  }

  const matched = new Set<string>();
  for (const violation of violations) {
    const impact = violation.impact ?? null;
    const nodeCount = violation.nodes.length;
    const exception = usable.get(violation.id);

    if (exception === undefined) {
      failures.push({ kind: 'violation', ruleId: violation.id, impact, nodeCount });
      continue;
    }
    matched.add(violation.id);

    if (today > exception.reviewBy) {
      failures.push({ kind: 'expired', ruleId: violation.id, reviewBy: exception.reviewBy });
    } else if (impact !== exception.impact) {
      failures.push({
        kind: 'impact-mismatch',
        ruleId: violation.id,
        expected: exception.impact,
        actual: impact,
      });
    } else if (nodeCount > exception.maxNodes) {
      failures.push({
        kind: 'exceeded',
        ruleId: violation.id,
        maxNodes: exception.maxNodes,
        nodeCount,
      });
    } else {
      excepted.push({ ruleId: violation.id, nodeCount, reviewBy: exception.reviewBy });
    }
  }

  // An exception with nothing left to excuse must be retired. Expiry takes
  // precedence, because an expired entry needs a decision either way.
  for (const [ruleId, exception] of usable) {
    if (matched.has(ruleId)) {
      continue;
    }
    failures.push(
      today > exception.reviewBy
        ? { kind: 'expired', ruleId, reviewBy: exception.reviewBy }
        : { kind: 'unused', ruleId },
    );
  }

  return { page, failures, excepted };
}

/** The only accessibility data written to the public report. */
export interface A11yReportSummary {
  readonly page: A11yPage;
  readonly axeCoreVersion: string;
  readonly tags: readonly string[];
  readonly counts: {
    readonly violations: number;
    readonly affectedNodes: number;
    readonly incomplete: number;
    readonly passes: number;
  };
  readonly violations: readonly {
    readonly ruleId: string;
    readonly impact: Impact | null;
    readonly wcagTags: readonly string[];
    readonly nodeCount: number;
    readonly helpUrl: string;
  }[];
  readonly incomplete: readonly { readonly ruleId: string; readonly nodeCount: number }[];
  readonly excepted: readonly ExceptedViolation[];
  readonly failures: readonly GateFailure[];
}

/**
 * Build the report summary from an explicit allow-list of fields.
 *
 * Never spreads or serialises axe objects: raw nodes carry HTML snippets,
 * CSS selectors (often generated, unstable paths) and failure text, none of
 * which may reach the public report.
 */
export function toReportSummary(
  page: A11yPage,
  scan: AxeScan,
  gate: GateResult,
): A11yReportSummary {
  return {
    page,
    axeCoreVersion: scan.testEngine.version,
    tags: [...A11Y_TAGS],
    counts: {
      violations: scan.violations.length,
      affectedNodes: scan.violations.reduce((total, v) => total + v.nodes.length, 0),
      incomplete: scan.incomplete.length,
      passes: scan.passes.length,
    },
    violations: scan.violations.map((v) => ({
      ruleId: v.id,
      impact: v.impact ?? null,
      wcagTags: v.tags.filter((tag) => tag.startsWith('wcag')),
      nodeCount: v.nodes.length,
      helpUrl: v.helpUrl,
    })),
    incomplete: scan.incomplete.map((v) => ({ ruleId: v.id, nodeCount: v.nodes.length })),
    excepted: gate.excepted.map((e) => ({
      ruleId: e.ruleId,
      nodeCount: e.nodeCount,
      reviewBy: e.reviewBy,
    })),
    failures: gate.failures,
  };
}
