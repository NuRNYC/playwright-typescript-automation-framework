/**
 * Trusted publication publisher (ADR-0011 P2).
 *
 *   QUALITY_VERDICT_GITHUB_TOKEN=… node scripts/build-publication.ts \
 *     --allowlist <absolute file> --out-parent <absolute directory> \
 *     --source-commit <40-hex> --built-at <ISO 8601 UTC> \
 *     [--evidence-dir <absolute directory>]
 *
 * The thin shell around `src/reporting/publication-publisher.ts` and the
 * single production caller of `runPublication`. It parses the options and
 * wires the real adapters; every check, the evidence collection, the
 * failure policy, the manifest and the generation commit happen in the
 * module. It prints one fixed line (a result code and, on success, the
 * generation name and the manifest SHA-256; never a path) and sets the exit
 * code: 0 generation committed, 1 refused or failed with nothing committed,
 * 2 usage error.
 *
 * Configuration-boundary exception (ADR-0011, amended 2026-11-26): this file
 * reads `QUALITY_VERDICT_GITHUB_TOKEN`, and checks only whether each name in
 * `UNSAFE_ENVIRONMENT` is set (their values are never read). It reads no
 * other environment value. The token is never accepted as an argument, read
 * from a file or obtained from `gh`, and never printed. It also reads the
 * system clock, solely for the ±15-minute `builtAt` sanity check.
 *
 * The CLI accepts no evidence, verdict, summary state or authenticity value,
 * and no option selects an adapter. Dependencies must have been installed
 * by `npm ci` from a clean checkout of the source commit beforehand; this
 * script never installs anything.
 *
 * Local use only: not wired into CI and not part of the dashboard build.
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import {
  nodeGit,
  nodePublisherFs,
  parsePublicationArgs,
  resultMessage,
  runPublication,
  type PublicationResult,
} from '../src/reporting/publication-publisher.ts';
import { nodeHttp } from '../src/reporting/verdict-cli.ts';

const FAILED: PublicationResult = {
  exitCode: 1,
  code: 'internal-error',
  generation: null,
  manifestSha256: null,
};

async function main(argv: readonly string[]): Promise<PublicationResult> {
  const parsed = parsePublicationArgs(argv);
  if (!parsed.ok) {
    return { exitCode: 2, code: 'usage', generation: null, manifestSha256: null };
  }
  const script = process.argv[1];
  if (script === undefined) return FAILED;
  const repoRoot = resolve(dirname(script), '..');
  return runPublication(parsed.args, {
    runtime: {
      execArgv: [...process.execArgv],
      isSet: (name) => Object.hasOwn(process.env, name),
    },
    token: process.env.QUALITY_VERDICT_GITHUB_TOKEN,
    now: () => new Date().toISOString(),
    nodeVersion: process.version,
    repoRoot,
    http: nodeHttp,
    git: nodeGit(repoRoot),
    fs: nodePublisherFs,
    randomId: () => randomUUID(),
  });
}

main(process.argv.slice(2))
  .catch((): PublicationResult => FAILED)
  .then((result) => {
    console.log(resultMessage(result));
    process.exitCode = result.exitCode;
  })
  .catch(() => {
    process.exitCode = 1;
  });
