import type { A11yException } from './policy';

/**
 * Reviewed accessibility exceptions. Intentionally empty.
 *
 * At M4 both scanned pages reported zero confirmed violations, so nothing is
 * excused. An entry may be added only through a pull request that also
 * records it in ADR-0004's exception log, and only for a violation that
 * cannot be fixed in this repository (for example, third-party markup).
 *
 * Every entry is scoped to one page and one rule, must match the measured
 * impact, caps the affected-node count, names an owner role, and expires on
 * its `reviewBy` date. The gate fails on any entry that is expired, unused,
 * severity-mismatched, exceeded or malformed -- see `evaluateGate`.
 *
 * Example shape (not active):
 *
 *   {
 *     page: 'inventory',
 *     ruleId: 'color-contrast',
 *     impact: 'serious',
 *     maxNodes: 2,
 *     reason: 'Third-party theme; upstream issue filed',
 *     owner: 'QE maintainer',
 *     reviewBy: '2027-01-31',
 *   }
 */
export const A11Y_EXCEPTIONS = [] as const satisfies readonly A11yException[];
