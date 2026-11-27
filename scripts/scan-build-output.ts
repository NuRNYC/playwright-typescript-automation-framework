/**
 * Standalone build-output security scanner (ADR-0011 P4-1).
 *
 *   node scripts/scan-build-output.ts --dir <absolute dashboard output directory>
 *
 * Read-only: inspects one explicitly named `scripts/build-dashboard.ts`
 * output directory against the committed eight-file contract (filesystem,
 * HTML and CSP, JavaScript imports and APIs, publication data module,
 * leakage markers). It reads no environment variable, accepts no token or
 * authenticity option, makes no network request and never executes the
 * scanned JavaScript. A clean scan does not authenticate an embedded
 * publication.
 *
 * Prints one fixed line: `clean files=8`, or the rejection codes with
 * counts. No path, file content or matched value is printed.
 * Exit codes: 0 clean, 1 rejected, 2 usage error.
 */
import { scanBuildOutput, scanMessage } from '../src/reporting/build-output-scanner.ts';

const USAGE = 'usage: node scripts/scan-build-output.ts --dir <absolute-output-directory>';

/** Exactly `--dir <value>`; anything else is a usage error. */
function parseScanArgs(argv: readonly string[]): string | undefined {
  if (argv.length !== 2 || argv[0] !== '--dir') return undefined;
  const dir = argv[1];
  return dir === undefined || dir === '' ? undefined : dir;
}

function main(argv: readonly string[]): number {
  const dir = parseScanArgs(argv);
  if (dir === undefined) {
    console.error(USAGE);
    return 2;
  }
  const result = scanBuildOutput(dir);
  const line = scanMessage(result);
  if (result.status === 'clean') {
    console.log(line);
    return 0;
  }
  console.error(line);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
