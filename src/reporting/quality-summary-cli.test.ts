/**
 * Unit tests for the quality-summary CLI logic (ADR-0009, M8B).
 *
 * Same conventions as the other unit tests (ADR-0002). Filesystem tests run
 * in isolated temporary directories created and removed by each test; every
 * report is synthetic (`fixtures.ts`). No real report, authentication state
 * or CI artifact is read.
 *
 * Tests named "[regression] ..." reproduce a specific hardening issue (a
 * filesystem race, an unintended directory creation, a temporary-name
 * collision) and would fail against the original M8B implementation; the
 * others exercise expected behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ENV_KEYS,
  MAX_REPORT_BYTES,
  MAX_TEMP_ATTEMPTS,
  OUTPUT_FILE,
  isStrictlyWithin,
  nodeFs,
  parseArgs,
  pickEnv,
  resultMessage,
  runQualitySummary,
  type CliDeps,
  type CliResult,
  type FsAdapter,
} from './quality-summary-cli.ts';
import { GATE_INPUT_NAMES, normalize, serialize, validateRunContext } from './quality-summary.ts';
import {
  CANARY,
  SYNTHETIC_SHA,
  SYNTHETIC_TIME,
  canaryReport,
  twelveEighteenNineteen,
} from './fixtures.ts';

/* ------------------------------------------------------------------ *
 * Sandbox helpers
 * ------------------------------------------------------------------ */

interface Sandbox {
  readonly root: string;
  readonly runnerTemp: string;
  readonly outside: string;
}

function withSandbox(fn: (box: Sandbox) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'qs-cli-')));
  const box: Sandbox = {
    root: join(base, 'workspace'),
    runnerTemp: join(base, 'runner-temp'),
    outside: join(base, 'outside'),
  };
  for (const dir of [box.root, box.runnerTemp, box.outside]) {
    mkdirSync(dir);
  }
  try {
    fn(box);
  } finally {
    for (const dir of [box.root, box.runnerTemp, box.outside]) {
      try {
        chmodSync(dir, 0o755);
      } catch {
        // Already removed or never restricted.
      }
    }
    rmSync(base, { recursive: true, force: true });
  }
}

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const OUT = 'quality-summary';

function envFor(
  box: Sandbox,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_RUN_ID: '1000001',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'push',
    QS_HEAD_SHA: SYNTHETIC_SHA,
    QS_BRANCH: 'main',
    RUNNER_TEMP: box.runnerTemp,
    ...Object.fromEntries(GATE_INPUT_NAMES.map((name) => [name, 'success'])),
    ...overrides,
  };
}

let idCounter = 0;
function freshId(): string {
  idCounter += 1;
  return `synthetic-id-${String(idCounter).padStart(8, '0')}`;
}

function depsFor(
  box: Sandbox,
  overrides: Record<string, string | undefined> = {},
  fs: FsAdapter = nodeFs,
  randomId: () => string = freshId,
): CliDeps {
  return { env: envFor(box, overrides), cwd: box.root, now: () => SYNTHETIC_TIME, randomId, fs };
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function outputOf(box: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(join(box.root, OUT, OUTPUT_FILE), 'utf8')) as Record<
    string,
    unknown
  >;
}

function hasOutput(box: Sandbox): boolean {
  return existsSync(join(box.root, OUT, OUTPUT_FILE));
}

function hasOutputDir(box: Sandbox): boolean {
  return existsSync(join(box.root, OUT));
}

function leftovers(box: Sandbox): string[] {
  const path = join(box.root, OUT);
  return existsSync(path) ? readdirSync(path).filter((name) => name !== OUTPUT_FILE) : [];
}

/** A filesystem wrapper that records reads and can inject behaviour. */
function spyFs(overrides: Partial<FsAdapter> = {}): {
  fs: FsAdapter;
  touched: string[];
  reads: string[];
} {
  const touched: string[] = [];
  const reads: string[] = [];
  const fs: FsAdapter = {
    lstat: (p) => {
      touched.push(p);
      return nodeFs.lstat(p);
    },
    realpath: (p) => {
      touched.push(p);
      return nodeFs.realpath(p);
    },
    identity: (p) => nodeFs.identity(p),
    readNoFollow: (p, max) => {
      reads.push(p);
      return nodeFs.readNoFollow(p, max);
    },
    mkdir: (p) => {
      nodeFs.mkdir(p);
    },
    writeNew: (p, d) => nodeFs.writeNew(p, d),
    rename: (a, b) => {
      nodeFs.rename(a, b);
    },
    remove: (p) => {
      nodeFs.remove(p);
    },
    ...overrides,
  };
  return { fs, touched, reads };
}

function run(
  box: Sandbox,
  reportArg: string,
  overrides: Record<string, string | undefined> = {},
  fs: FsAdapter = nodeFs,
  outDir = OUT,
  randomId: () => string = freshId,
): CliResult {
  return runQualitySummary(
    { reportPath: reportArg, outputDir: outDir },
    depsFor(box, overrides, fs, randomId),
  );
}

/* ------------------------------------------------------------------ *
 * Successful runs and M8A compatibility
 * ------------------------------------------------------------------ */

test('a valid report produces an available summary identical to the M8A normalizer output', () => {
  withSandbox((box) => {
    const report = twelveEighteenNineteen();
    writeJson(box.runnerTemp, 'results.json', report);
    const result = run(box, join(box.runnerTemp, 'results.json'));
    assert.deepEqual(result, { exitCode: 0, code: 'written-available', reason: null });
    const context = validateRunContext({
      runId: 1_000_001,
      runAttempt: 1,
      event: 'push',
      headSha: SYNTHETIC_SHA,
      branch: 'main',
      generatedAt: SYNTHETIC_TIME,
      reportState: 'provided',
      gateInputs: Object.fromEntries(GATE_INPUT_NAMES.map((n) => [n, 'success'])),
    });
    assert.ok(context.ok);
    const expected = serialize(normalize(report, context.context));
    assert.equal(readFileSync(join(box.root, OUT, OUTPUT_FILE), 'utf8'), expected);
    assert.equal(outputOf(box).ciVerdict, 'not-recorded-in-summary');
    assert.deepEqual(leftovers(box), []);
  });
});

test('a report inside the working directory is also accepted', () => {
  withSandbox((box) => {
    writeJson(box.root, 'results.json', twelveEighteenNineteen());
    assert.equal(run(box, 'results.json').code, 'written-available');
  });
});

test('the same input and fixed context write byte-identical summaries', () => {
  withSandbox((box) => {
    writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    const reportPath = join(box.runnerTemp, 'results.json');
    run(box, reportPath);
    const first = readFileSync(join(box.root, OUT, OUTPUT_FILE), 'utf8');
    run(box, reportPath);
    const second = readFileSync(join(box.root, OUT, OUTPUT_FILE), 'utf8');
    assert.equal(first, second);
    assert.deepEqual(leftovers(box), []);
  });
});

test('all eight Gate input values are preserved, unavailable and unknown kept apart', () => {
  withSandbox((box) => {
    writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    run(box, join(box.runnerTemp, 'results.json'), {
      CHECKS: 'success',
      SHARDS: 'failure',
      INVENTORY: 'cancelled',
      DOWNLOAD_1: 'skipped',
      DOWNLOAD_2: '',
      UPLOAD: 'weird',
    });
    assert.deepEqual(outputOf(box).observedGateInputs, {
      CHECKS: 'success',
      SHARDS: 'failure',
      INVENTORY: 'cancelled',
      DOWNLOAD_1: 'skipped',
      DOWNLOAD_2: 'unavailable',
      VERIFY: 'success',
      MERGE: 'success',
      UPLOAD: 'unknown',
    });
    run(box, join(box.runnerTemp, 'results.json'), { UPLOAD: undefined });
    assert.equal(
      (outputOf(box).observedGateInputs as Record<string, string>).UPLOAD,
      'unavailable',
    );
  });
});

test('an existing summary is replaced atomically', () => {
  withSandbox((box) => {
    mkdirSync(join(box.root, OUT));
    writeFileSync(join(box.root, OUT, OUTPUT_FILE), 'old');
    writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    assert.equal(run(box, join(box.runnerTemp, 'results.json')).code, 'written-available');
    assert.notEqual(readFileSync(join(box.root, OUT, OUTPUT_FILE), 'utf8'), 'old');
    assert.deepEqual(leftovers(box), []);
  });
});

/* ------------------------------------------------------------------ *
 * Unavailable summaries
 * ------------------------------------------------------------------ */

function assertUnavailable(box: Sandbox, result: CliResult, reason: string): void {
  assert.deepEqual(result, { exitCode: 0, code: 'written-unavailable', reason });
  const summary = outputOf(box);
  assert.deepEqual(summary.testData, { state: 'unavailable', reason });
  assert.equal(summary.ciVerdict, 'not-recorded-in-summary');
  assert.deepEqual(summary.instances, []);
}

test('a missing report yields an unavailable summary', () => {
  withSandbox((box) => {
    assertUnavailable(box, run(box, join(box.runnerTemp, 'results.json')), 'report-missing');
    assertUnavailable(
      box,
      run(box, join(box.runnerTemp, 'absent-dir', 'results.json')),
      'report-missing',
    );
  });
});

test('an unreadable report yields an unavailable summary', () => {
  withSandbox((box) => {
    mkdirSync(join(box.runnerTemp, 'results.json'));
    assertUnavailable(box, run(box, join(box.runnerTemp, 'results.json')), 'report-unreadable');
    const failing = spyFs({ readNoFollow: () => ({ status: 'unreadable' }) });
    writeJson(box.runnerTemp, 'other.json', twelveEighteenNineteen());
    assertUnavailable(
      box,
      run(box, join(box.runnerTemp, 'other.json'), {}, failing.fs),
      'report-unreadable',
    );
    if (!IS_ROOT) {
      const locked = writeJson(box.runnerTemp, 'locked.json', twelveEighteenNineteen());
      chmodSync(locked, 0o000);
      assertUnavailable(box, run(box, locked), 'report-unreadable');
    }
  });
});

test('invalid JSON yields an unavailable summary', () => {
  withSandbox((box) => {
    writeFileSync(join(box.runnerTemp, 'results.json'), `{"suites": [ ${CANARY}`);
    assertUnavailable(box, run(box, join(box.runnerTemp, 'results.json')), 'report-invalid-json');
    assert.ok(!readFileSync(join(box.root, OUT, OUTPUT_FILE), 'utf8').includes(CANARY));
  });
});

test('a report over 50 MB is not read past the limit', () => {
  withSandbox((box) => {
    const path = join(box.runnerTemp, 'results.json');
    writeFileSync(path, '');
    truncateSync(path, MAX_REPORT_BYTES + 1);
    assertUnavailable(box, run(box, path), 'report-too-large');
    assert.equal(nodeFs.readNoFollow(path, MAX_REPORT_BYTES).status, 'too-large');
  });
});

test('unsuccessful VERIFY or MERGE never touches the report', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    for (const [overrides, reason] of [
      [{ VERIFY: 'failure' }, 'verification-not-successful'],
      [{ VERIFY: '' }, 'verification-not-successful'],
      [{ MERGE: 'failure' }, 'merge-not-successful'],
      [{ MERGE: 'cancelled' }, 'merge-not-successful'],
    ] as const) {
      const spy = spyFs();
      assertUnavailable(box, run(box, path, overrides, spy.fs), reason);
      assert.deepEqual(spy.reads, []);
      assert.ok(!spy.touched.includes(path));
    }
    assertUnavailable(
      box,
      run(box, '/etc/hosts.json', { MERGE: 'failure' }),
      'merge-not-successful',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Refusals: context and target
 * ------------------------------------------------------------------ */

function assertRefused(box: Sandbox, result: CliResult, code: string): void {
  assert.deepEqual(result, { exitCode: 1, code, reason: null });
  assert.equal(hasOutput(box), false, 'no summary may be written on refusal');
}

test('an invalid run context is refused without creating anything', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    for (const overrides of [
      { GITHUB_RUN_ID: undefined },
      { GITHUB_RUN_ID: '12abc' },
      { GITHUB_RUN_ID: '0' },
      { GITHUB_RUN_ATTEMPT: '0' },
      { GITHUB_RUN_ATTEMPT: '-1' },
      { QS_HEAD_SHA: 'not-a-sha' },
      { QS_HEAD_SHA: undefined },
    ]) {
      assertRefused(box, run(box, path, overrides), 'invalid-run-context');
      assert.equal(hasOutputDir(box), false);
    }
    const badClock: CliDeps = { ...depsFor(box), now: () => 'yesterday' };
    assertRefused(
      box,
      runQualitySummary({ reportPath: path, outputDir: OUT }, badClock),
      'invalid-run-context',
    );
    assert.equal(hasOutputDir(box), false);
  });
});

test('restricted targets and invalid target configuration are refused without creating anything', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    for (const [overrides, code] of [
      [{ APP_TARGET: 'staging', BASE_URL: 'https://staging.example.com' }, 'restricted-target'],
      [{ APP_TARGET: 'production', BASE_URL: 'https://prod.example.com' }, 'restricted-target'],
      [{ APP_TARGET: 'nonsense' }, 'invalid-configuration'],
      [{ APP_TARGET: 'staging' }, 'invalid-configuration'],
      [{ BASE_URL: 'https://other.example.com' }, 'invalid-configuration'],
    ] as const) {
      assertRefused(box, run(box, path, overrides), code);
      assert.equal(hasOutputDir(box), false);
    }
    assert.equal(run(box, path, { APP_TARGET: 'saucedemo' }).code, 'written-available');
  });
});

/* ------------------------------------------------------------------ *
 * Refusals: unsafe paths and symlinks
 * ------------------------------------------------------------------ */

test('[regression] unsafe input paths are refused without creating the output directory', () => {
  withSandbox((box) => {
    writeJson(box.outside, 'results.json', twelveEighteenNineteen());
    mkdirSync(join(box.root, 'playwright', '.auth'), { recursive: true });
    writeJson(join(box.root, 'playwright', '.auth'), 'standard.json', { cookies: [] });
    writeFileSync(join(box.runnerTemp, 'results.txt'), '{}');
    for (const reportArg of [
      '../outside/results.json',
      join(box.outside, 'results.json'),
      'playwright/.auth/standard.json',
      join(box.runnerTemp, 'results.txt'),
      box.root,
    ]) {
      assertRefused(box, run(box, reportArg), 'unsafe-input-path');
      // The original implementation created the output directory before
      // validating the input path.
      assert.equal(hasOutputDir(box), false, reportArg);
    }
  });
});

test('symlinked reports and symlinked report directories are refused', () => {
  withSandbox((box) => {
    const secret = writeJson(box.outside, 'results.json', canaryReport());
    symlinkSync(secret, join(box.runnerTemp, 'link.json'));
    assertRefused(box, run(box, join(box.runnerTemp, 'link.json')), 'unsafe-input-path');
    symlinkSync(box.outside, join(box.runnerTemp, 'escape'));
    assertRefused(
      box,
      run(box, join(box.runnerTemp, 'escape', 'results.json')),
      'unsafe-input-path',
    );
    assert.equal(nodeFs.readNoFollow(join(box.runnerTemp, 'link.json'), 1000).status, 'symlink');
  });
});

test('unsafe output paths are refused without creating anything', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    for (const outDir of ['..', '.', box.outside, '../outside', 'playwright/.auth', 'a/b/c']) {
      const result = run(box, path, {}, nodeFs, outDir);
      assert.deepEqual(result, { exitCode: 1, code: 'unsafe-output-path', reason: null }, outDir);
    }
    assert.deepEqual(readdirSync(box.outside), []);
    assert.deepEqual(readdirSync(box.root), []);
  });
});

test('symlinked output directories and output files are refused without touching the target', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    symlinkSync(box.outside, join(box.root, 'linked'));
    assert.equal(run(box, path, {}, nodeFs, 'linked').code, 'unsafe-output-path');
    assert.deepEqual(readdirSync(box.outside), []);
    mkdirSync(join(box.root, OUT));
    const victim = join(box.outside, 'victim.txt');
    writeFileSync(victim, 'unchanged');
    symlinkSync(victim, join(box.root, OUT, OUTPUT_FILE));
    assert.equal(run(box, path).code, 'unsafe-output-path');
    assert.equal(readFileSync(victim, 'utf8'), 'unchanged');
  });
});

/* ------------------------------------------------------------------ *
 * Filesystem races (TOCTOU)
 * ------------------------------------------------------------------ */

test('[regression] a report swapped for a symlink after validation is not followed', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    const secret = writeJson(box.outside, 'secret.json', canaryReport());
    // Swap immediately before the open: the original implementation checked
    // with lstat and then read by path, following the new symlink.
    const racing = spyFs({
      readNoFollow: (p, max) => {
        unlinkSync(path);
        symlinkSync(secret, path);
        return nodeFs.readNoFollow(p, max);
      },
    });
    assertRefused(box, run(box, path, {}, racing.fs), 'unsafe-input-path');
    assert.equal(hasOutputDir(box), false);
  });
});

test('[regression] a report directory swapped for a symlink after validation is detected', () => {
  withSandbox((box) => {
    const dir = join(box.runnerTemp, 'reports');
    mkdirSync(dir);
    const path = writeJson(dir, 'results.json', twelveEighteenNineteen());
    writeJson(box.outside, 'results.json', canaryReport());
    // Replace the already-validated parent directory with a symlink to an
    // outside directory holding a same-named file, just before the open.
    const racing = spyFs({
      readNoFollow: (p, max) => {
        renameSync(dir, join(box.runnerTemp, 'moved'));
        symlinkSync(box.outside, dir);
        return nodeFs.readNoFollow(p, max);
      },
    });
    assertRefused(box, run(box, path, {}, racing.fs), 'unsafe-input-path');
    assert.equal(hasOutputDir(box), false);
  });
});

test('[regression] an output directory swapped for a symlink before the write is detected', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    mkdirSync(join(box.root, OUT));
    const realDir = join(box.root, OUT);
    let swapped = false;
    const racing = spyFs({
      writeNew: (p, d) => {
        if (!swapped) {
          swapped = true;
          renameSync(realDir, join(box.root, 'moved-out'));
          symlinkSync(box.outside, realDir);
        }
        return nodeFs.writeNew(p, d);
      },
    });
    assertRefused(box, run(box, path, {}, racing.fs), 'write-failed');
    assert.deepEqual(
      readdirSync(box.outside),
      [],
      'no temporary or summary file may remain outside',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Temporary files and write failures
 * ------------------------------------------------------------------ */

test('[regression] a stale temporary file from an earlier run does not block the write', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    mkdirSync(join(box.root, OUT));
    // The original naming used only the process id, so a crash left a file
    // that made every later run with the same pid fail.
    const stale = join(box.root, OUT, `.${OUTPUT_FILE}.4242.tmp`);
    writeFileSync(stale, 'stale');
    assert.equal(run(box, path).code, 'written-available');
    assert.equal(readFileSync(stale, 'utf8'), 'stale', 'unrelated files are never touched');
  });
});

test('[regression] a temporary-name collision retries with a new name and leaves the other file alone', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    mkdirSync(join(box.root, OUT));
    const colliding = 'collision-0000000000000000';
    const existing = join(box.root, OUT, `.${OUTPUT_FILE}.${colliding}.tmp`);
    writeFileSync(existing, 'someone else');
    const ids = [colliding, 'fresh-1111111111111111'];
    const result = run(
      box,
      path,
      {},
      nodeFs,
      OUT,
      () => ids.shift() ?? 'fallback-2222222222222222',
    );
    assert.equal(result.code, 'written-available');
    assert.equal(readFileSync(existing, 'utf8'), 'someone else');
    assert.ok(hasOutput(box));
  });
});

test('persistent collisions fail after the retry limit without writing', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    mkdirSync(join(box.root, OUT));
    const id = 'always-the-same-0000000000';
    writeFileSync(join(box.root, OUT, `.${OUTPUT_FILE}.${id}.tmp`), 'occupied');
    let calls = 0;
    const result = run(box, path, {}, nodeFs, OUT, () => {
      calls += 1;
      return id;
    });
    assertRefused(box, result, 'write-failed');
    assert.equal(calls, MAX_TEMP_ATTEMPTS);
    assert.equal(
      readFileSync(join(box.root, OUT, `.${OUTPUT_FILE}.${id}.tmp`), 'utf8'),
      'occupied',
    );
  });
});

test('temporary names must be safe random tokens', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    for (const bad of ['../../escape-000000000000', 'short', `x/${'y'.repeat(20)}`, '']) {
      assertRefused(
        box,
        run(box, path, {}, nodeFs, OUT, () => bad),
        'write-failed',
      );
    }
    assert.deepEqual(leftovers(box), []);
  });
});

test('a failed write leaves no partial or temporary file', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    const failingWrite = spyFs({
      writeNew: (p) => {
        writeFileSync(p, '{"partial":');
        return { status: 'failed' };
      },
    });
    assertRefused(box, run(box, path, {}, failingWrite.fs), 'write-failed');
    assert.deepEqual(leftovers(box), []);
  });
});

test('a failed rename keeps the previous summary intact and removes the temporary file', () => {
  withSandbox((box) => {
    mkdirSync(join(box.root, OUT));
    writeFileSync(join(box.root, OUT, OUTPUT_FILE), 'previous');
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    const failingRename = spyFs({
      rename: () => {
        throw new Error('EXDEV');
      },
    });
    const result = run(box, path, {}, failingRename.fs);
    assert.deepEqual(result, { exitCode: 1, code: 'write-failed', reason: null });
    assert.equal(readFileSync(join(box.root, OUT, OUTPUT_FILE), 'utf8'), 'previous');
    assert.deepEqual(leftovers(box), []);
  });
});

test('a read-only output directory fails without writing', { skip: IS_ROOT }, () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', twelveEighteenNineteen());
    mkdirSync(join(box.root, OUT));
    chmodSync(join(box.root, OUT), 0o555);
    assertRefused(box, run(box, path), 'write-failed');
    chmodSync(join(box.root, OUT), 0o755);
    assert.deepEqual(leftovers(box), []);
  });
});

test('an unexpected exception becomes the fixed internal-error result', () => {
  withSandbox((box) => {
    const exploding = spyFs({
      realpath: () => {
        throw new Error(`boom ${CANARY}`);
      },
    });
    const result = run(box, 'results.json', {}, exploding.fs);
    assert.deepEqual(result, { exitCode: 1, code: 'internal-error', reason: null });
    assert.ok(!resultMessage(result).includes(CANARY));
    assert.equal(hasOutputDir(box), false);
  });
});

/* ------------------------------------------------------------------ *
 * Security, messages, arguments and environment
 * ------------------------------------------------------------------ */

test('no secret canary from the report or the branch reaches the summary', () => {
  withSandbox((box) => {
    const path = writeJson(box.runnerTemp, 'results.json', canaryReport());
    const result = run(box, path, { QS_BRANCH: `feature/${CANARY}` });
    assert.equal(result.code, 'written-available');
    const text = readFileSync(join(box.root, OUT, OUTPUT_FILE), 'utf8');
    assert.ok(!text.includes(CANARY));
    assert.ok(!text.includes(box.root));
    assert.ok(!text.includes(box.runnerTemp));
    assert.ok(!resultMessage(result).includes(CANARY));
  });
});

test('result messages are fixed and contain no paths, values or error text', () => {
  const codes: CliResult[] = [
    { exitCode: 0, code: 'written-available', reason: null },
    { exitCode: 0, code: 'written-unavailable', reason: 'report-invalid-json' },
    { exitCode: 1, code: 'unsafe-input-path', reason: null },
    { exitCode: 1, code: 'write-failed', reason: null },
  ];
  for (const result of codes) {
    assert.match(resultMessage(result), /^quality-summary: [a-z-]+( \[[a-z-]+\])? — [^/\\]+$/);
  }
});

test('only allow-listed environment variables are passed on', () => {
  const picked = pickEnv({
    GITHUB_RUN_ID: '7',
    SECRET_TOKEN: CANARY,
    HOME: '/home/x',
    MERGE: 'success',
  });
  assert.deepEqual(Object.keys(picked), [...ENV_KEYS]);
  assert.equal(picked.GITHUB_RUN_ID, '7');
  assert.equal(picked.MERGE, 'success');
  assert.ok(!JSON.stringify(picked).includes(CANARY));
});

test('the argument contract is exactly two non-empty positional arguments', () => {
  assert.deepEqual(parseArgs(['report.json', 'out']), {
    ok: true,
    args: { reportPath: 'report.json', outputDir: 'out' },
  });
  for (const argv of [
    [],
    ['report.json'],
    ['report.json', 'out', 'extra'],
    ['', 'out'],
    ['a.json', 'x\0y'],
    ['a'.repeat(5000), 'out'],
  ]) {
    assert.deepEqual(parseArgs(argv), { ok: false });
  }
});

test('containment checks reject equal, parent and sibling paths', () => {
  assert.equal(isStrictlyWithin('/a/b/c', '/a/b'), true);
  assert.equal(isStrictlyWithin('/a/b', '/a/b'), false);
  assert.equal(isStrictlyWithin('/a', '/a/b'), false);
  assert.equal(isStrictlyWithin('/a/bc', '/a/b'), false);
});
