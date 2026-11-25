/**
 * Writes the metadata-only quality summary (ADR-0009, M8B).
 *
 *   node scripts/quality-summary.ts <report.json> <output-dir>
 *
 * The thin shell around `src/reporting/quality-summary-cli.ts`: it parses the
 * two arguments, passes the allow-listed environment variables, working
 * directory, clock, a random temporary-name source and the Node filesystem,
 * prints one fixed result line and sets the exit code. All validation, path
 * safety, normalization and writing happen in the reporting module; nothing
 * here reads or prints report content, paths, error text or environment
 * values.
 *
 * Exit codes: 0 summary written (test data available or unavailable),
 * 1 refused or failed with no summary written, 2 usage error.
 *
 * Configuration-boundary exception: the repository rule is that application
 * configuration is read from `process.env` only in `src/config/index.ts`.
 * That module cannot be loaded here: this script runs under Node's
 * type-stripping loader, which cannot resolve its extensionless relative
 * imports, and importing it would also run checkpoint A against this
 * process. So this entry point reads exactly `ENV_KEYS` (including
 * `APP_TARGET` and `BASE_URL`) and hands them to the reporting module, which
 * classifies the target with the same pure resolver (`src/config/env.ts`)
 * and refuses restricted tiers before touching the filesystem. No other code
 * reads the environment, and no target classification is duplicated.
 *
 * Not wired into CI: integrating this step is a separate, later decision
 * (ADR-0009, M8D). The summary never records a CI verdict; the Gate does.
 */
import { randomUUID } from 'node:crypto';

import {
  nodeFs,
  parseArgs,
  pickEnv,
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
    env: pickEnv(process.env),
    cwd: process.cwd(),
    now: () => new Date().toISOString(),
    randomId: () => randomUUID(),
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
