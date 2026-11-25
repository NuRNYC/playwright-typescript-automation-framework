/**
 * Publishes the advisory failure triage for the merged report (ADR-0008).
 *
 *   node scripts/triage-report.ts <merge-outcome> <report.json> <summary.md>
 *
 * The impure shell around `src/ci/triage.ts`. It reads the merged JSON report
 * only when the merge step succeeded -- that is, only after the M6 inventory,
 * exact-name downloads and blob verification all passed -- and prints only
 * what the pure policy produced: fixed-format annotations (workflow commands)
 * and a Markdown summary appended to the summary file.
 *
 * It never prints the report, a file path, an OS error or a stack trace.
 * Inputs come from the command line; no environment variable is read.
 *
 * Exit codes: 0 when triage was produced; 1 when it was unavailable or the
 * arguments were wrong. The workflow step is `continue-on-error`, so neither
 * changes the verdict of the required `test` gate.
 */
import { appendFile, readFile, stat } from 'node:fs/promises';

import {
  MAX_ANNOTATIONS_PER_LEVEL,
  annotations,
  summary,
  triage,
  type TriageResult,
  type UnavailableReason,
} from '../src/ci/triage.ts';

/** Larger than any report this suite produces; a guard against runaway input. */
const MAX_REPORT_BYTES = 50 * 1024 * 1024;

function unavailable(reason: UnavailableReason): TriageResult {
  return { kind: 'unavailable', reason };
}

async function load(mergeOutcome: string, reportPath: string): Promise<TriageResult> {
  // M7 probe T7 only (probe branch, never merged): an unexpected runtime error
  // whose message carries synthetic sensitive-looking content.
  if (mergeOutcome === 'success') {
    throw new Error(
      `M7SENTINEL-CRASH ${['ghp', 'M7SENTINEL'.repeat(3) + 'ABCDEF'].join('_')} ${reportPath}`,
    );
  }
  if (mergeOutcome !== 'success') {
    return unavailable('merge-not-successful');
  }
  let text: string;
  try {
    const info = await stat(reportPath);
    if (!info.isFile()) {
      return unavailable('report-missing');
    }
    if (info.size > MAX_REPORT_BYTES) {
      return unavailable('report-too-large');
    }
    text = await readFile(reportPath, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return unavailable(code === 'ENOENT' ? 'report-missing' : 'report-unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unavailable('report-invalid-json');
  }
  return triage(parsed);
}

async function main(argv: readonly string[]): Promise<number> {
  const [mergeOutcome, reportPath, summaryPath, ...rest] = argv;
  if (
    mergeOutcome === undefined ||
    reportPath === undefined ||
    summaryPath === undefined ||
    rest.length > 0
  ) {
    console.error(
      'usage: node scripts/triage-report.ts <merge-outcome> <report.json> <summary.md>',
    );
    return 2;
  }

  const result = await load(mergeOutcome, reportPath);
  for (const line of annotations(result, {
    errors: MAX_ANNOTATIONS_PER_LEVEL,
    warnings: MAX_ANNOTATIONS_PER_LEVEL,
  })) {
    console.log(line);
  }
  try {
    await appendFile(summaryPath, `${summary(result)}\n`, 'utf8');
  } catch {
    console.log('::warning title=Test triage::Test triage summary could not be written.');
  }
  if (result.kind === 'unavailable') {
    console.log(`test triage: unavailable (${result.reason})`);
    return 1;
  }
  console.log(
    `test triage: ${result.logicalTests} logical tests, ${result.executions} executions classified`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.log('::warning title=Test triage::Test triage failed unexpectedly.');
    process.exitCode = 1;
  },
);
