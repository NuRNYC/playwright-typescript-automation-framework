/**
 * Custom `node:test` reporter for structured unit results (ADR-0012
 * amendment, Phase C2).
 *
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=./scripts/unit-test-reporter.ts \
 *     --test-reporter-destination=unit-results/unit-results.json "src/**\/*.test.ts"
 *
 * (`npm run test:unit:structured` runs exactly this.) It writes one
 * `unit-test-results` document after the event stream ends, built only from
 * allow-listed aggregate fields (`UnitTally` in `src/reporting/unit-results.ts`):
 * the counts of the single run summary, per-test event tallies, the run's
 * `success` flag, the Node.js version and this reporter's own start and end
 * times. No test names, paths, errors or logs are written.
 *
 * If the stream ends without exactly one run summary it writes nothing; an
 * interrupted run also leaves the destination empty (Node.js truncates it at
 * start). The parser reads an empty file as incomplete evidence, never as a
 * successful zero-test run. The test command's exit status is the runner's
 * own; this reporter never changes it.
 *
 * Reads no environment variables, files or network.
 */
import { UnitTally, serializeUnitResults } from '../src/reporting/unit-results.ts';

export default async function* unitTestReporter(
  source: AsyncIterable<unknown>,
): AsyncGenerator<string> {
  const startedAt = new Date().toISOString();
  const tally = new UnitTally();
  for await (const event of source) {
    tally.add(event);
  }
  const document = tally.finish({
    nodeVersion: process.version,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  if (document !== undefined) {
    yield serializeUnitResults(document);
  }
}
