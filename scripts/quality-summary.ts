/**
 * Writes the metadata-only quality summary (ADR-0009, M8B).
 *
 *   node scripts/quality-summary.ts <report.json> <output-dir>
 *
 * The thin shell around `src/reporting/quality-summary-cli.ts`: it parses the
 * two arguments, hands over the process environment, working directory,
 * clock and the Node filesystem, prints one fixed result line and sets the
 * exit code. All validation, path safety, normalization and writing happen in
 * the reporting module; nothing here reads or prints report content, paths,
 * error text or environment values.
 *
 * Exit codes: 0 summary written (test data available or unavailable),
 * 1 refused or failed with no summary written, 2 usage error.
 *
 * Not wired into CI: integrating this step is a separate, later decision
 * (ADR-0009, M8D). The summary never records a CI verdict; the Gate does.
 */
import {
  nodeFs,
  parseArgs,
  resultMessage,
  runQualitySummary,
  type CliResult,
} from '../src/reporting/quality-summary-cli.ts';

function main(argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return { exitCode: 2, code: 'usage', reason: null };
  }
  return runQualitySummary(parsed.args, {
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date().toISOString(),
    pid: process.pid,
    fs: nodeFs,
  });
}

let result: CliResult;
try {
  result = main(process.argv.slice(2));
} catch {
  // Unreachable in practice (runQualitySummary never rethrows); still fixed output.
  result = { exitCode: 1, code: 'internal-error', reason: null };
}
console.log(resultMessage(result));
process.exitCode = result.exitCode;
