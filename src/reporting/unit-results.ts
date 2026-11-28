/**
 * Structured `node:test` unit results (ADR-0012 amendment, Phase C2). Pure.
 *
 * - `UnitTally` accumulates the reporter events `scripts/unit-test-reporter.ts`
 *   receives and finalizes them into one `unit-test-results` document built
 *   from allow-listed aggregate fields only.
 * - `parseUnitResults` strictly validates such a document and turns it into
 *   the C1 `UnitEvidence` input of `test-health.ts`.
 * - `stampUnitResults` adds a caller-supplied CI identity to an unstamped
 *   document; it never relabels a stamped one.
 *
 * Semantics were observed with executable probes on the pinned Node.js
 * version (see `unit-results.test.ts`); nothing here claims them for any
 * other version. No filesystem, environment, network or clock access.
 *
 * Free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import { isIsoInstant, type UnitEvidence, type UnitResults } from './test-health.ts';

export const UNIT_RESULTS_KIND = 'unit-test-results';
export const UNIT_RESULTS_SCHEMA_VERSION = '1.0.0';
/** A complete document is a few hundred bytes; anything larger is refused. */
export const MAX_UNIT_RESULTS_BYTES = 16 * 1024;

const COUNT_KEYS = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites'] as const;
type CountKey = (typeof COUNT_KEYS)[number];
export type UnitCounts = Readonly<Record<CountKey, number>>;

/** `failureType` values `node:test` counts as `cancelled` (observed on the pinned version). */
const CANCELLED_FAILURE_TYPES = new Set(['testTimeoutFailure', 'cancelledByParent']);

export interface CiStamp {
  readonly mode: 'ci';
  readonly runId: number;
  readonly runAttempt: number;
  readonly sourceSha: string;
}

/** The serialized document. Key order is fixed by `serializeUnitResults`. */
export interface UnitResultsDocument {
  readonly kind: typeof UNIT_RESULTS_KIND;
  readonly schemaVersion: typeof UNIT_RESULTS_SCHEMA_VERSION;
  readonly nodeVersion: string;
  readonly success: boolean;
  readonly counts: UnitCounts;
  /** Tallies of per-test and per-suite events, cross-checked against `counts`. */
  readonly events: UnitCounts;
  readonly execution: { readonly startedAt: string; readonly finishedAt: string };
  readonly provenance: CiStamp | null;
}

/* ------------------------------------------------------------------ *
 * Reporter tally
 * ------------------------------------------------------------------ */

function zeroCounts(): Record<CountKey, number> {
  return { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Accumulates reporter events. Reads only event types, the `details.type`,
 * `skip`, `todo` and `details.error.failureType` fields and the numeric
 * counts of the final summary; every other property is ignored.
 */
export class UnitTally {
  private readonly events = zeroCounts();
  private finalCounts: Record<CountKey, number> | undefined;
  private finalSuccess: boolean | undefined;
  private finalSummaries = 0;

  add(event: unknown): void {
    const ev = record(event);
    const data = record(ev?.data);
    if (ev === undefined || data === undefined) return;
    if (ev.type === 'test:summary') {
      // Per-file summaries carry a `file`; the single run summary does not.
      if (data.file !== undefined) return;
      this.finalSummaries += 1;
      const counts = record(data.counts);
      const picked = zeroCounts();
      for (const key of COUNT_KEYS) {
        const value = counts?.[key];
        picked[key] = typeof value === 'number' ? value : Number.NaN;
      }
      this.finalCounts = picked;
      this.finalSuccess = typeof data.success === 'boolean' ? data.success : undefined;
      return;
    }
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') return;
    const details = record(data.details);
    if (details?.type === 'suite') {
      this.events.suites += 1;
      return;
    }
    if (details?.type !== 'test') return;
    this.events.tests += 1;
    if (data.skip !== undefined && data.skip !== false) this.events.skipped += 1;
    else if (data.todo !== undefined && data.todo !== false) this.events.todo += 1;
    else if (ev.type === 'test:pass') this.events.passed += 1;
    else {
      const failureType = record(details.error)?.failureType;
      if (typeof failureType === 'string' && CANCELLED_FAILURE_TYPES.has(failureType)) {
        this.events.cancelled += 1;
      } else {
        this.events.failed += 1;
      }
    }
  }

  /**
   * The finished document, or `undefined` when the stream ended without
   * exactly one run summary (the reporter then writes nothing, which the
   * parser reads as incomplete evidence).
   */
  finish(meta: {
    readonly nodeVersion: string;
    readonly startedAt: string;
    readonly finishedAt: string;
  }): UnitResultsDocument | undefined {
    if (
      this.finalSummaries !== 1 ||
      this.finalCounts === undefined ||
      this.finalSuccess === undefined
    ) {
      return undefined;
    }
    return {
      kind: UNIT_RESULTS_KIND,
      schemaVersion: UNIT_RESULTS_SCHEMA_VERSION,
      nodeVersion: meta.nodeVersion,
      success: this.finalSuccess,
      counts: { ...this.finalCounts },
      events: { ...this.events },
      execution: { startedAt: meta.startedAt, finishedAt: meta.finishedAt },
      provenance: null,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

function countsInOrder(counts: UnitCounts): Record<CountKey, number> {
  const out = zeroCounts();
  for (const key of COUNT_KEYS) out[key] = counts[key];
  return out;
}

/** Deterministic JSON with a fixed key order and only documented fields. */
export function serializeUnitResults(doc: UnitResultsDocument): string {
  const ordered = {
    kind: doc.kind,
    schemaVersion: doc.schemaVersion,
    nodeVersion: doc.nodeVersion,
    success: doc.success,
    counts: countsInOrder(doc.counts),
    events: countsInOrder(doc.events),
    execution: { startedAt: doc.execution.startedAt, finishedAt: doc.execution.finishedAt },
    provenance:
      doc.provenance === null
        ? null
        : {
            mode: 'ci',
            runId: doc.provenance.runId,
            runAttempt: doc.provenance.runAttempt,
            sourceSha: doc.provenance.sourceSha,
          },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * Strict parser
 * ------------------------------------------------------------------ */

const NODE_VERSION = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const SHA = /^[0-9a-f]{40}$/;
const TOP_KEYS = [
  'kind',
  'schemaVersion',
  'nodeVersion',
  'success',
  'counts',
  'events',
  'execution',
  'provenance',
];

export type ParseFailure =
  'unit-results-incomplete' | 'unit-results-invalid' | 'unit-results-inconsistent';

export type ParsedUnitResults =
  | { readonly ok: true; readonly document: UnitResultsDocument }
  | { readonly ok: false; readonly reason: ParseFailure };

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function countsOf(value: unknown): Record<CountKey, number> | undefined {
  const obj = record(value);
  if (obj === undefined || Array.isArray(value) || !exactKeys(obj, COUNT_KEYS)) return undefined;
  const out = zeroCounts();
  for (const key of COUNT_KEYS) {
    const v = obj[key];
    if (!isCount(v)) return undefined;
    out[key] = v;
  }
  return out;
}

function stampOf(value: unknown): CiStamp | null | undefined {
  if (value === null) return null;
  const obj = record(value);
  if (obj === undefined || !exactKeys(obj, ['mode', 'runId', 'runAttempt', 'sourceSha'])) {
    return undefined;
  }
  const { mode, runId, runAttempt, sourceSha } = obj;
  if (
    mode !== 'ci' ||
    !isCount(runId) ||
    runId < 1 ||
    !isCount(runAttempt) ||
    runAttempt < 1 ||
    typeof sourceSha !== 'string' ||
    !SHA.test(sourceSha)
  ) {
    return undefined;
  }
  return { mode: 'ci', runId, runAttempt, sourceSha };
}

/** Strictly validates one document; never throws. */
export function parseUnitResultsDocument(text: string): ParsedUnitResults {
  if (text.trim() === '') return { ok: false, reason: 'unit-results-incomplete' };
  if (Buffer.byteLength(text, 'utf8') > MAX_UNIT_RESULTS_BYTES) {
    return { ok: false, reason: 'unit-results-invalid' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: 'unit-results-invalid' };
  }
  const doc = record(value);
  if (doc === undefined || Array.isArray(value) || !exactKeys(doc, TOP_KEYS)) {
    return { ok: false, reason: 'unit-results-invalid' };
  }
  const counts = countsOf(doc.counts);
  const events = countsOf(doc.events);
  const execution = record(doc.execution);
  const provenance = stampOf(doc.provenance);
  if (
    doc.kind !== UNIT_RESULTS_KIND ||
    doc.schemaVersion !== UNIT_RESULTS_SCHEMA_VERSION ||
    typeof doc.nodeVersion !== 'string' ||
    !NODE_VERSION.test(doc.nodeVersion) ||
    typeof doc.success !== 'boolean' ||
    counts === undefined ||
    events === undefined ||
    execution === undefined ||
    !exactKeys(execution, ['startedAt', 'finishedAt']) ||
    !isIsoInstant(execution.startedAt) ||
    !isIsoInstant(execution.finishedAt) ||
    Date.parse(execution.finishedAt) < Date.parse(execution.startedAt) ||
    provenance === undefined
  ) {
    return { ok: false, reason: 'unit-results-invalid' };
  }
  // The counts must reconcile, and the event tallies and the success flag must
  // agree with the run summary. Matching tallies never excuse unreconciled counts.
  const outcomeSum =
    counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo;
  if (
    !Number.isSafeInteger(outcomeSum) ||
    outcomeSum !== counts.tests ||
    COUNT_KEYS.some((key) => events[key] !== counts[key]) ||
    doc.success !== (counts.failed + counts.cancelled === 0)
  ) {
    return { ok: false, reason: 'unit-results-inconsistent' };
  }
  return {
    ok: true,
    document: {
      kind: UNIT_RESULTS_KIND,
      schemaVersion: UNIT_RESULTS_SCHEMA_VERSION,
      nodeVersion: doc.nodeVersion,
      success: doc.success,
      counts,
      events,
      execution: { startedAt: execution.startedAt, finishedAt: execution.finishedAt },
      provenance,
    },
  };
}

/** The C1 unit input for a document's text. Unstamped documents are local evidence. */
export function parseUnitResults(text: string): UnitEvidence {
  const parsed = parseUnitResultsDocument(text);
  if (!parsed.ok) return { kind: 'unavailable', reason: parsed.reason };
  const d = parsed.document;
  const results: UnitResults = {
    kind: 'unit-results',
    provenance:
      d.provenance === null
        ? { mode: 'local' }
        : {
            mode: 'ci',
            runId: d.provenance.runId,
            runAttempt: d.provenance.runAttempt,
            sourceSha: d.provenance.sourceSha,
          },
    nodeVersion: d.nodeVersion,
    counts: countsInOrder(d.counts),
    execution: { startedAt: d.execution.startedAt, finishedAt: d.execution.finishedAt },
  };
  return results;
}

/* ------------------------------------------------------------------ *
 * Stamping
 * ------------------------------------------------------------------ */

export type StampResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: ParseFailure | 'already-stamped' | 'invalid-identity' };

/**
 * Adds a caller-supplied CI identity to an unstamped, valid document. The
 * identity is recorded as supplied; it is not independently verified. A
 * stamped document is refused, never relabelled.
 */
export function stampUnitResults(
  text: string,
  identity: { readonly runId: number; readonly runAttempt: number; readonly sourceSha: string },
): StampResult {
  const stamp = stampOf({ mode: 'ci', ...identity });
  if (stamp === undefined || stamp === null) return { ok: false, reason: 'invalid-identity' };
  const parsed = parseUnitResultsDocument(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.document.provenance !== null) return { ok: false, reason: 'already-stamped' };
  return { ok: true, text: serializeUnitResults({ ...parsed.document, provenance: stamp }) };
}
