/**
 * Test-health generator (ADR-0012 amendment, Phase C2).
 *
 *   node scripts/test-health.ts stamp --unit <file> --run-id <n> --run-attempt <n> \
 *     --source-sha <sha> --out <file>
 *   node scripts/test-health.ts render --mode local --unit <file> --out <new-dir>
 *   node scripts/test-health.ts render --mode ci --run-id <n> --run-attempt <n> \
 *     --source-sha <sha> [--unit <file>] [--summary <file>] --out <new-dir>
 *
 * All behaviour lives in `src/reporting/test-health-cli.ts`. This entry point
 * supplies only the arguments, the working directory, the clock and the
 * filesystem adapter. It reads **no** environment variables: a CI identity is
 * passed explicitly as arguments and recorded as supplied, not verified.
 *
 * Prints one fixed line and sets the exit code: 0 written, 1 refused,
 * 2 usage. Exit 0 means the health output was produced; it never means the
 * tests passed. Never writes `README.md` or a CI job summary.
 */
import { randomUUID } from 'node:crypto';
import { rmdirSync } from 'node:fs';

import { nodeFs } from '../src/reporting/quality-summary-cli.ts';
import { healthMessage, runTestHealth } from '../src/reporting/test-health-cli.ts';

const result = runTestHealth(process.argv.slice(2), {
  cwd: process.cwd(),
  now: () => new Date().toISOString(),
  randomId: () => randomUUID(),
  fs: {
    ...nodeFs,
    removeEmptyDir: (path) => {
      rmdirSync(path);
    },
  },
});
const line = healthMessage(result);
if (result.exitCode === 0) {
  console.log(line);
} else {
  console.error(line);
}
process.exitCode = result.exitCode;
