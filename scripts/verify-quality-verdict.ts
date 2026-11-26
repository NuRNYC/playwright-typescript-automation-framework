/**
 * Local, read-only quality-verdict operator (ADR-0010, M8E-4).
 *
 *   QUALITY_VERDICT_GITHUB_TOKEN=… \
 *     node scripts/verify-quality-verdict.ts <run-id> <attempt> <absolute-output-dir>
 *
 * The thin shell around `src/reporting/verdict-cli.ts`: it parses the three
 * arguments, reads the token, supplies the Node HTTP and filesystem adapters,
 * the repository root and a random temporary-name source, prints one fixed
 * result line and sets the exit code. All retrieval, digest verification,
 * archive reading, reconciliation and writing happen in the reporting
 * modules; nothing here prints responses, URLs, paths, error text or
 * environment values.
 *
 * Exit codes: 0 bundle written (whatever the verdict), 1 refused or failed
 * with no bundle written, 2 usage error.
 *
 * Credential boundary: this file is the only reader of
 * `QUALITY_VERDICT_GITHUB_TOKEN`, a dedicated read-only token supplied by the
 * local operator (the documented configuration exception M8B also uses).
 * The token is never accepted as an argument, never read from a file or
 * from `gh`, and never printed. Use a fine-grained token restricted to this
 * repository with read-only Actions, Contents and Metadata access.
 *
 * Local use only: not wired into CI and not part of the dashboard build.
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import { nodeFs } from '../src/reporting/quality-summary-cli.ts';
import {
  TRUST_POLICY,
  nodeHttp,
  parseVerdictArgs,
  resultMessage,
  runVerdict,
  type VerdictCliResult,
} from '../src/reporting/verdict-cli.ts';

async function main(argv: readonly string[]): Promise<VerdictCliResult> {
  const parsed = parseVerdictArgs(argv);
  if (!parsed.ok) {
    return { exitCode: 2, code: 'usage', verdict: null, summary: null };
  }
  const script = process.argv[1];
  if (script === undefined) {
    return { exitCode: 1, code: 'internal-error', verdict: null, summary: null };
  }
  return runVerdict(parsed.args, {
    token: process.env.QUALITY_VERDICT_GITHUB_TOKEN,
    http: nodeHttp,
    fs: nodeFs,
    repoRoot: resolve(dirname(script), '..'),
    randomId: () => randomUUID(),
    policy: TRUST_POLICY,
  });
}

main(process.argv.slice(2))
  .catch((): VerdictCliResult => ({
    // Unreachable in practice (runVerdict never rejects); still fixed output.
    exitCode: 1,
    code: 'internal-error',
    verdict: null,
    summary: null,
  }))
  .then((result) => {
    console.log(resultMessage(result));
    process.exitCode = result.exitCode;
  })
  .catch(() => {
    process.exitCode = 1;
  });
