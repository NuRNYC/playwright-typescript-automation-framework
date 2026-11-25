/**
 * Publishes the advisory failure triage for the merged report (ADR-0008).
 *
 *   node scripts/triage-report.ts <merge-outcome> <report.json> <summary.md>
 *
 * The impure shell around `src/ci/triage.ts`. It reads the merged JSON report
 * only when the merge step succeeded -- that is, only after the M6 inventory,
 * exact-name downloads and blob verification all passed -- and prints only
 * what the policy produced: fixed-format annotations (workflow commands) and
 * a Markdown summary appended to the summary file.
 *
 * It never prints the report, a file path, an OS error, an exception message
 * or a stack trace. Any unexpected failure becomes the fixed
 * "unavailable (internal-error)" warning and summary. Inputs come from the
 * command line; no environment variable is read.
 *
 * Exit codes: 0 when triage was produced and its summary written; 1 when it
 * was unavailable, failed internally, or the summary could not be written;
 * 2 for wrong arguments. The workflow step is `continue-on-error`, so none of
 * these changes the verdict of the required `test` gate. A process that is
 * killed outright (or a lost runner) produces none of this output.
 */
import { appendFile, readFile, stat } from 'node:fs/promises';

import { runTriage, type LoadedReport } from '../src/ci/triage.ts';

/** Larger than any report this suite produces; a guard against runaway input. */
const MAX_REPORT_BYTES = 50 * 1024 * 1024;

async function loadReport(mergeOutcome: string, reportPath: string): Promise<LoadedReport> {
  if (mergeOutcome !== 'success') {
    return { kind: 'unavailable', reason: 'merge-not-successful' };
  }
  let text: string;
  try {
    const info = await stat(reportPath);
    if (!info.isFile()) {
      return { kind: 'unavailable', reason: 'report-missing' };
    }
    if (info.size > MAX_REPORT_BYTES) {
      return { kind: 'unavailable', reason: 'report-too-large' };
    }
    text = await readFile(reportPath, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      kind: 'unavailable',
      reason: code === 'ENOENT' ? 'report-missing' : 'report-unreadable',
    };
  }
  try {
    return { kind: 'parsed', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'unavailable', reason: 'report-invalid-json' };
  }
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
  return runTriage({
    loadReport: () => loadReport(mergeOutcome, reportPath),
    print: (line) => {
      console.log(line);
    },
    appendSummary: (markdown) => appendFile(summaryPath, markdown, 'utf8'),
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // Unreachable in practice (runTriage never rethrows); still fixed output.
    console.log(
      '::warning title=Test triage unavailable::Test triage unavailable (internal-error). This is not a test result; see the gate.',
    );
    process.exitCode = 1;
  },
);
