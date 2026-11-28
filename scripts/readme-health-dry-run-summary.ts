/**
 * Job-summary renderer for one README health dry-run report (ADR-0013 C5C).
 *
 *   node scripts/readme-health-dry-run-summary.ts <report.json>
 *
 * Reads the report through the bounded, no-follow reader, re-validates it
 * strictly (`parseDryRunReport`) and prints the Markdown summary to standard
 * output; the workflow appends that output to the job summary. The report is
 * treated as data: nothing from it is executed or interpolated into shell
 * code. Reads no environment variable. Exit codes: 0 summary printed,
 * 1 report missing or invalid, 2 usage error.
 */
import {
  MAX_REPORT_BYTES,
  nodeReadReadme,
  parseDryRunReport,
  renderDryRunSummary,
} from '../src/reporting/readme-dry-run.ts';

function main(argv: readonly string[]): number {
  const [path, ...rest] = argv;
  if (path === undefined || rest.length > 0 || path.length === 0 || path.length > 4096) {
    console.error('readme-health-dry-run-summary: usage');
    return 2;
  }
  const read = nodeReadReadme(path, MAX_REPORT_BYTES);
  const report = read.status === 'ok' ? parseDryRunReport(read.text) : undefined;
  if (report === undefined) {
    console.error('readme-health-dry-run-summary: report-invalid');
    return 1;
  }
  process.stdout.write(renderDryRunSummary(report));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch {
  console.error('readme-health-dry-run-summary: internal-error');
  process.exitCode = 1;
}
