/**
 * Local, read-only README health refresh dry run (ADR-0013, Phase C5B).
 *
 *   QUALITY_VERDICT_GITHUB_TOKEN=… node scripts/readme-health-dry-run.ts \
 *     --run-id <id> --run-attempt <n> --readme <path> --prepared-on <YYYY-MM-DD>
 *
 * The thin shell around `src/reporting/readme-dry-run.ts`: it parses the
 * explicit arguments, reads the token, builds the live read-only transport
 * (`createHealthTransport`, which composes the unchanged ADR-0010 operator
 * transport), and prints one JSON report labelled
 * `"kind": "readme-health-dry-run", "dryRun": true` to standard output.
 *
 * It never writes the README, any file, a branch, a pull request or a
 * repository setting, and never stores downloaded evidence: archives are
 * read in memory. Exit codes: 0 report printed (whatever the decision),
 * 1 refused (no token) or internal error, 2 usage error.
 *
 * Credential boundary (CLAUDE.md, ADR-0013 section 6): this file is the only
 * reader of `QUALITY_VERDICT_GITHUB_TOKEN` in the dry-run flow, a narrowly
 * scoped exception alongside the ADR-0010 operator. The token is never
 * accepted as an argument or from a file, never printed and never
 * persisted. Use a fine-grained token restricted to this repository with
 * read-only Actions, Contents and Metadata access.
 */
import { TRUST_POLICY, nodeHttp } from '../src/reporting/verdict-cli.ts';
import { createHealthTransport } from '../src/reporting/health-transport.ts';
import {
  nodeReadReadme,
  parseDryRunArgs,
  runReadmeDryRun,
  serializeDryRunReport,
} from '../src/reporting/readme-dry-run.ts';

async function main(argv: readonly string[]): Promise<number> {
  const args = parseDryRunArgs(argv);
  if (args === undefined) {
    console.error('readme-health-dry-run: usage');
    return 2;
  }
  const token = process.env.QUALITY_VERDICT_GITHUB_TOKEN;
  if (token === undefined || token.length === 0) {
    console.error('readme-health-dry-run: token-missing');
    return 1;
  }
  const transport = createHealthTransport({
    token,
    repository: TRUST_POLICY.repositoryFullName,
    branch: TRUST_POLICY.trustedBranch,
    http: nodeHttp,
  });
  const report = await runReadmeDryRun(args, { transport, readReadme: nodeReadReadme });
  process.stdout.write(serializeDryRunReport(report));
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    // Fixed output only: no error text, which could carry remote data.
    console.error('readme-health-dry-run: internal-error');
    process.exitCode = 1;
  });
