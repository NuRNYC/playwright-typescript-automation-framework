/**
 * Unit tests for the build-output security scanner (ADR-0011 P4-1).
 *
 * Same conventions as the other unit tests (ADR-0002). Every output is
 * synthetic: one picker-only build from the committed builder into a
 * temporary directory, copied per test and then altered. Embedded
 * publications are synthetic manifests written through the committed
 * data-module generator. No real publication, private workspace, token or
 * network is used.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANARY, SYNTHETIC_SHA } from './fixtures.ts';
import { nodePublisherFs } from './publication-publisher.ts';
import { publicationDataModule } from '../../scripts/build-dashboard.ts';
import { demoPublicationText } from './demo-publication.ts';
import {
  DATA_MODULE_HEADER,
  EXPECTED_CSP,
  OUTPUT_FILES,
  SCAN_CODES,
  scanBuildOutput,
  scanMessage,
  type ScanResult,
  type ScannerDeps,
} from './build-output-scanner.ts';

const REPO_ROOT = process.cwd();
let workspace: string;
let base: string;

before(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'scanner-')));
  base = join(workspace, 'base');
  execFileSync(
    process.execPath,
    ['--no-warnings', join(REPO_ROOT, 'scripts', 'build-dashboard.ts'), '--out', base],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

let counter = 0;
/** A fresh copy of the picker-only build. */
function copy(): string {
  counter += 1;
  const dir = join(workspace, `case-${String(counter)}`);
  cpSync(base, dir, { recursive: true });
  return dir;
}

const BUILT_AT = '2026-11-26T12:00:00.000Z';
const POLICY = {
  repositoryId: 900_000_001,
  repositoryFullName: 'example-owner/example-repo',
  workflowId: 800_000_001,
  workflowPath: '.github/workflows/tests.yml',
  workflowName: 'Playwright UI Tests',
  trustedEvent: 'push',
  trustedBranch: 'main',
};

/** A canonical synthetic manifest (one build-verified pass with numeric metrics). */
function manifest(gateReasons: readonly string[] = ['gate-success']): string {
  return `${JSON.stringify(
    {
      manifestSchemaVersion: '1.0.0',
      kind: 'quality-verdict-publication',
      build: {
        sourceCommit: 'c0ffee0000000000000000000000000000c0ffee',
        builtAt: BUILT_AT,
        policy: POLICY,
      },
      results: [
        {
          runId: 1_000_001,
          runAttempt: 1,
          headSha: SYNTHETIC_SHA,
          event: 'push',
          gate: {
            state: 'VERIFIED_PASS',
            reasons: gateReasons,
            authenticity: 'BUILD_VERIFIED',
            freshness: 'CURRENT',
            verifiedAt: BUILT_AT,
          },
          summary: {
            state: 'SUMMARY_VERIFIED_ORIGIN',
            reasons: ['verified-origin'],
            label: 'verified-origin',
          },
          artifact: {
            id: 15_000_001,
            digest: `sha256:${'ab'.repeat(32)}`,
            integrity: 'verified-in-build',
          },
          metrics: {
            authenticity: 'BUILD_VERIFIED',
            freshness: 'CURRENT',
            summarySchemaVersion: '1.0.0',
            totals: {
              attempts: 99,
              byExecutionOutcome: { passed: 99 },
              byInstanceOutcome: { passed: 99 },
              definitions: 49,
              executions: 99,
              instances: 99,
              retries: 0,
              zeroAttemptExecutions: 0,
            },
            completeness: {
              ambiguousIdentities: 0,
              droppedTags: 0,
              inconsistentExecutions: 0,
              invalidDurations: 0,
              invalidRetries: 0,
              omissionDetection: 'not-supported',
              provisionalOutcomes: 0,
              shardAttribution: 'not-available',
              statsCrossCheck: 'match',
              unclassifiedAttempts: 0,
              unrecognizedProjectExecutions: 0,
              unresolvedIdentities: 0,
            },
          },
        },
      ],
      untrustedOrigin: [],
      synthetic: null,
    },
    null,
    2,
  )}\n`;
}

function embedded(text = manifest()): string {
  const dir = copy();
  writeFileSync(
    join(dir, 'dashboard', 'publication-data.js'),
    publicationDataModule('embedded', text),
  );
  return dir;
}

function codes(result: ScanResult): string[] {
  assert.equal(result.status, 'rejected', 'expected a rejection');
  if (result.status !== 'rejected') return [];
  return result.findings.map((f) => f.code);
}

function file(dir: string, path: string): string {
  return join(dir, ...path.split('/'));
}

function edit(dir: string, path: string, change: (text: string) => string): void {
  const p = file(dir, path);
  writeFileSync(p, change(readFileSync(p, 'utf8')));
}

/* ------------------------------------------------------------------ *
 * Valid outputs
 * ------------------------------------------------------------------ */

test('a picker-only build output is clean and is not modified', () => {
  const dir = copy();
  const before = OUTPUT_FILES.map((p) => [
    readFileSync(file(dir, p)),
    statSync(file(dir, p)).mtimeMs,
  ]);
  assert.deepEqual(scanBuildOutput(dir), { status: 'clean', files: 8 });
  const afterScan = OUTPUT_FILES.map((p) => [
    readFileSync(file(dir, p)),
    statSync(file(dir, p)).mtimeMs,
  ]);
  assert.deepEqual(afterScan, before);
  assert.deepEqual(readdirSync(dir).sort(), ['dashboard', 'src']);
});

test('an embedded synthetic publication with a numeric instances metric is clean', () => {
  const text = manifest();
  assert.ok(text.includes('"instances": 99'));
  assert.deepEqual(scanBuildOutput(embedded(text)), { status: 'clean', files: 8 });
});

test('the restated contract matches the committed builder and page', () => {
  assert.equal(publicationDataModule('none', '').split('\n')[0], DATA_MODULE_HEADER);
  const html = readFileSync(join(REPO_ROOT, 'dashboard', 'index.html'), 'utf8');
  assert.ok(html.includes(`content="${EXPECTED_CSP}"`));
  assert.deepEqual(
    readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => `${d.parentPath.slice(base.length + 1)}/${d.name}`)
      .sort(),
    [...OUTPUT_FILES].sort(),
  );
});

/* ------------------------------------------------------------------ *
 * Directory argument and filesystem
 * ------------------------------------------------------------------ */

test('the directory argument must be explicit, absolute and normalized', () => {
  const dir = copy();
  for (const bad of [
    undefined,
    42,
    '',
    'relative/dir',
    `${dir}/`,
    `${dir}/../${dir.split('/').pop() ?? ''}`,
    `${dir}\0`,
  ]) {
    assert.deepEqual(codes(scanBuildOutput(bad)), ['invalid-directory'], String(bad));
  }
  assert.deepEqual(codes(scanBuildOutput(join(workspace, 'absent'))), ['directory-missing']);
  assert.deepEqual(codes(scanBuildOutput(file(dir, 'dashboard/index.html'))), ['not-a-directory']);
  const link = join(workspace, `link-${String(counter)}`);
  symlinkSync(dir, link);
  assert.deepEqual(codes(scanBuildOutput(link)), ['symlink-root']);
});

test('missing files, extra files and extra directories are rejected', () => {
  const missing = copy();
  unlinkSync(file(missing, 'src/reporting/verdict.js'));
  assert.ok(codes(scanBuildOutput(missing)).includes('missing-file'));
  const extra = copy();
  writeFileSync(file(extra, 'dashboard/extra.js'), '');
  assert.deepEqual(codes(scanBuildOutput(extra)), ['unexpected-entry']);
  const extraRoot = copy();
  mkdirSync(join(extraRoot, 'reports'));
  assert.deepEqual(codes(scanBuildOutput(extraRoot)), ['unexpected-entry']);
  const nested = copy();
  mkdirSync(file(nested, 'src/reporting/raw'));
  assert.deepEqual(codes(scanBuildOutput(nested)), ['unexpected-entry']);
  const hidden = copy();
  writeFileSync(join(hidden, '.env'), 'X=1');
  assert.deepEqual(codes(scanBuildOutput(hidden)), ['unexpected-entry']);
});

test('symlinks and non-regular files are rejected without being followed', () => {
  const fileLink = copy();
  const outside = join(workspace, `outside-${String(counter)}.js`);
  writeFileSync(outside, readFileSync(file(fileLink, 'dashboard/app.js')));
  unlinkSync(file(fileLink, 'dashboard/app.js'));
  symlinkSync(outside, file(fileLink, 'dashboard/app.js'));
  assert.ok(codes(scanBuildOutput(fileLink)).includes('symlink-entry'));

  const dirLink = copy();
  const elsewhere = join(workspace, `elsewhere-${String(counter)}`);
  cpSync(file(dirLink, 'src'), elsewhere, { recursive: true });
  rmSync(file(dirLink, 'src'), { recursive: true });
  symlinkSync(elsewhere, file(dirLink, 'src'));
  assert.ok(codes(scanBuildOutput(dirLink)).includes('symlink-entry'));

  const fifo = copy();
  unlinkSync(file(fifo, 'dashboard/styles.css'));
  execFileSync('mkfifo', [file(fifo, 'dashboard/styles.css')]);
  assert.ok(codes(scanBuildOutput(fifo)).includes('non-regular-file'));

  const dirAsFile = copy();
  unlinkSync(file(dirAsFile, 'dashboard/styles.css'));
  mkdirSync(file(dirAsFile, 'dashboard/styles.css'));
  assert.ok(codes(scanBuildOutput(dirAsFile)).includes('non-regular-file'));
});

test('oversized, unreadable, unstable and non-UTF-8 files are rejected', () => {
  const big = copy();
  appendFileSync(file(big, 'dashboard/app.js'), `\n//${'x'.repeat(2 * 1024 * 1024)}`);
  assert.deepEqual(codes(scanBuildOutput(big)), ['file-too-large']);

  const unreadable = copy();
  chmodSync(file(unreadable, 'dashboard/styles.css'), 0o000);
  const result = scanBuildOutput(unreadable);
  chmodSync(file(unreadable, 'dashboard/styles.css'), 0o644);
  if (process.getuid?.() !== 0) assert.deepEqual(codes(result), ['file-unreadable']);

  const binary = copy();
  writeFileSync(file(binary, 'dashboard/styles.css'), Buffer.from([0xff, 0xfe, 0x00]));
  assert.deepEqual(codes(scanBuildOutput(binary)), ['invalid-encoding']);

  const changing = copy();
  const unstable: ScannerDeps = {
    fs: {
      ...nodePublisherFs,
      readHandle: (path, max) => {
        const read = nodePublisherFs.readHandle(path, max);
        return read.status === 'ok' && path.endsWith('verdict.js')
          ? { ...read, stable: false }
          : read;
      },
    },
  };
  assert.deepEqual(codes(scanBuildOutput(changing, unstable)), ['file-unstable']);
});

test('an adapter exception becomes a fixed internal-error result', () => {
  const dir = copy();
  const throwing: ScannerDeps = {
    fs: {
      ...nodePublisherFs,
      list: () => {
        throw new Error(`boom ${CANARY} ${dir}`);
      },
    },
  };
  const result = scanBuildOutput(dir, throwing);
  assert.deepEqual(result, {
    status: 'rejected',
    findings: [{ code: 'internal-error', count: 1 }],
  });
});

/* ------------------------------------------------------------------ *
 * HTML and CSP
 * ------------------------------------------------------------------ */

test('a removed or weakened CSP is rejected', () => {
  const cases: [string, (h: string) => string, string][] = [
    [
      'removed',
      (h) => h.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, ''),
      'csp-missing',
    ],
    ['connect-src opened', (h) => h.replace("connect-src 'none'", 'connect-src *'), 'csp-mismatch'],
    [
      'unsafe-inline',
      (h) => h.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      'csp-mismatch',
    ],
    [
      'duplicated',
      (h) =>
        h.replace(
          '<meta charset="utf-8" />',
          `<meta charset="utf-8" />\n<meta http-equiv="Content-Security-Policy" content="default-src *" />`,
        ),
      'csp-missing',
    ],
  ];
  for (const [name, change, code] of cases) {
    const dir = copy();
    edit(dir, 'dashboard/index.html', change);
    assert.ok(codes(scanBuildOutput(dir)).includes(code), name);
  }
});

test('extra, inline or external scripts and embedded or remote content are rejected', () => {
  const cases: [string, string, string][] = [
    [
      'extra module script',
      '<script type="module" src="app.js"></script>\n<script type="module" src="app.js"></script>',
      'html-script-count',
    ],
    [
      'external script',
      '<script src="https://cdn.example.invalid/x.js"></script>',
      'html-script-not-approved',
    ],
    ['inline script', '<script>window.x = 1</script>', 'html-inline-script'],
    ['iframe', '<iframe src="#main"></iframe>', 'html-embedded-content'],
    ['object', '<object data="#main"></object>', 'html-embedded-content'],
    ['inline handler', '<div onclick="x()"></div>', 'html-inline-handler'],
    [
      'remote stylesheet',
      '<link rel="stylesheet" href="//cdn.example.invalid/x.css" />',
      'html-remote-reference',
    ],
    ['javascript URL', '<a href="javascript:void(0)">x</a>', 'html-remote-reference'],
  ];
  for (const [name, markup, code] of cases) {
    const dir = copy();
    edit(dir, 'dashboard/index.html', (h) =>
      code === 'html-script-count'
        ? h.replace('<script type="module" src="app.js"></script>', markup)
        : h.replace('</body>', `${markup}\n</body>`),
    );
    assert.ok(
      codes(scanBuildOutput(dir)).includes(code),
      `${name}: ${codes(scanBuildOutput(dir)).join(',')}`,
    );
  }
});

test('ordinary words in page text and comments are not mistaken for markup', () => {
  const dir = copy();
  edit(dir, 'dashboard/index.html', (h) =>
    h.replace(
      '</body>',
      '<p>Scripts, frames and embedded objects are described here; onclick is a word.</p>\n<!-- <script src="x.js"></script> -->\n</body>',
    ),
  );
  assert.deepEqual(scanBuildOutput(dir), { status: 'clean', files: 8 });
});

/* ------------------------------------------------------------------ *
 * JavaScript
 * ------------------------------------------------------------------ */

test('forbidden JavaScript APIs are rejected', () => {
  const snippets = [
    'fetch("/x")',
    'new XMLHttpRequest()',
    'new WebSocket("x")',
    'navigator.sendBeacon("x")',
    'eval("1")',
    'new Function("1")',
    'localStorage.setItem("a", "b")',
    'sessionStorage.clear()',
    'indexedDB.open("x")',
    'document.body.innerHTML = ""',
    'document.write("x")',
    'import("./verdict.js")',
    'setTimeout("x()", 1)',
    'new Worker("x.js")',
    'document.cookie = "a=b"',
  ];
  for (const snippet of snippets) {
    const dir = copy();
    edit(dir, 'dashboard/app.js', (t) => `${t}\n${snippet};\n`);
    assert.ok(codes(scanBuildOutput(dir)).includes('js-forbidden-api'), snippet);
  }
});

test('broken and external module imports are rejected', () => {
  const cases: [string, string][] = [
    ['import "./missing.js";', 'js-unresolved-import'],
    ['import "../../../etc/x.js";', 'js-unresolved-import'],
    ['import "./styles.css";', 'js-unresolved-import'],
    ['import x from "lodash";', 'js-external-import'],
    ['import "/dashboard/app.js";', 'js-external-import'],
    ['export * from "node:fs";', 'js-external-import'],
  ];
  for (const [line, code] of cases) {
    const dir = copy();
    edit(dir, 'src/reporting/verdict.js', (t) => `${line}\n${t}`);
    assert.ok(codes(scanBuildOutput(dir)).includes(code), line);
  }
});

/* ------------------------------------------------------------------ *
 * Publication data module
 * ------------------------------------------------------------------ */

test('invalid data modules, states and publication text are rejected', () => {
  const valid = publicationDataModule('embedded', manifest());
  const cases: [string, string, string][] = [
    ['extra export', `${valid}export const VERIFIED = true;\n`, 'data-module-shape'],
    ['missing header', valid.split('\n').slice(1).join('\n'), 'data-module-shape'],
    [
      'let instead of const',
      valid.replace('export const PUBLICATION_STATE', 'export let PUBLICATION_STATE'),
      'data-module-shape',
    ],
    [
      'unknown state',
      publicationDataModule('none', '').replace("'none'", "'trusted'"),
      'data-module-state',
    ],
    [
      'none with text',
      publicationDataModule('none', '').replace('= "";', '= "x";'),
      'data-module-text',
    ],
    ['embedded without text', publicationDataModule('embedded', ''), 'data-module-text'],
    ['raw non-ASCII', `${valid.slice(0, -3)}é";\n`, 'data-module-shape'],
    [
      'non-canonical manifest',
      publicationDataModule('embedded', `${JSON.stringify(JSON.parse(manifest()))}\n`),
      'publication-rejected',
    ],
    [
      'contradictory verdict reason',
      publicationDataModule('embedded', manifest(['gate-failure'])),
      'publication-rejected',
    ],
    ['not a manifest', publicationDataModule('embedded', '{"a":1}\n'), 'publication-rejected'],
  ];
  for (const [name, module, code] of cases) {
    const dir = copy();
    writeFileSync(file(dir, 'dashboard/publication-data.js'), module);
    assert.ok(
      codes(scanBuildOutput(dir)).includes(code),
      `${name}: ${codes(scanBuildOutput(dir)).join(',')}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Leakage
 * ------------------------------------------------------------------ */

test('credential, header, URL, storage, path, input, record, trace and canary leaks are detected', () => {
  const cases: [string, string][] = [
    [['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_'), 'leak-credential'],
    [['github_pat', '11ABCDEFG0123456789_abcdefghij'].join('_'), 'leak-credential'],
    ['QUALITY_VERDICT_GITHUB_TOKEN', 'leak-credential'],
    ['Authorization: Basic abc', 'leak-auth-header'],
    ['Bearer abcdefghijklmnop', 'leak-auth-header'],
    ['x.invalid/a?sv=2024&sig=abc', 'leak-signed-url'],
    ['productionresultssa12.blob.core.windows.net', 'leak-storage-host'],
    ['/Users/someone/project/file', 'leak-private-path'],
    ['/home/runner/work/x', 'leak-private-path'],
    ['/var/folders/ab/cd/T/x', 'leak-private-path'],
    ['QualityPublication/inputs', 'leak-private-input'],
    ['quality-verdict-publication-allowlist', 'leak-private-input'],
    ['allowListSha256', 'leak-build-record'],
    ['packageLockSha256', 'leak-build-record'],
    ['TypeError: boom\n    at run (file.js:1:2)\n', 'leak-stack-trace'],
    [CANARY, 'leak-canary'],
    ['wss://example.invalid/socket', 'leak-outbound-url'],
  ];
  for (const [leak, code] of cases) {
    for (const target of ['dashboard/styles.css', 'dashboard/index.html'] as const) {
      const dir = copy();
      edit(dir, target, (t) =>
        target === 'dashboard/styles.css'
          ? `${t}\n/* ${leak} */\n`
          : t.replace('</body>', `<p>${leak}</p>\n</body>`),
      );
      assert.ok(codes(scanBuildOutput(dir)).includes(code), `${target}: ${code}`);
    }
  }
  const js = copy();
  edit(
    js,
    'dashboard/app.js',
    (t) => `${t}\nconst leaked = "/Users/someone/QualityVerdictEvidence/x";\n`,
  );
  assert.deepEqual(codes(scanBuildOutput(js)), ['leak-private-path', 'leak-private-input']);
});

test('raw report structures are rejected but the numeric instances metric is not', () => {
  const rawArray = copy();
  edit(rawArray, 'dashboard/index.html', (h) =>
    h.replace('</body>', '<pre>{"instances": [{"id": 1}]}</pre>\n</body>'),
  );
  assert.deepEqual(codes(scanBuildOutput(rawArray)), ['leak-raw-report']);
  const rawKeys = copy();
  edit(rawKeys, 'dashboard/index.html', (h) =>
    h.replace('</body>', '<pre>{"suites": [], "stdout": []}</pre>\n</body>'),
  );
  assert.deepEqual(codes(scanBuildOutput(rawKeys)), ['leak-raw-report']);
  // The numeric metric, in page text and in an embedded publication, is clean.
  const numeric = embedded();
  edit(numeric, 'dashboard/index.html', (h) =>
    h.replace('</body>', '<p>"instances": 99</p>\n</body>'),
  );
  assert.deepEqual(scanBuildOutput(numeric), { status: 'clean', files: 8 });
  // Public repository identifiers and SHA-256 digests are not private-path leaks.
  assert.ok(manifest().includes('example-owner/example-repo') && manifest().includes('sha256:'));
});

/* ------------------------------------------------------------------ *
 * Diagnostics and CLI
 * ------------------------------------------------------------------ */

test('results carry fixed codes and counts only, never paths or matched values', () => {
  const dir = copy();
  const secret = ['ghp', 'SECRETVALUE0123456789abcdefABCDEF'].join('_');
  edit(dir, 'dashboard/styles.css', (t) => `${t}\n/* ${secret} /Users/someone/x ${CANARY} */\n`);
  const result = scanBuildOutput(dir);
  const text = `${JSON.stringify(result)} ${scanMessage(result)}`;
  for (const value of [secret, '/Users/someone', CANARY, dir, workspace]) {
    assert.equal(text.includes(value), false, value);
  }
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    for (const f of result.findings) {
      assert.ok((SCAN_CODES as readonly string[]).includes(f.code));
      assert.ok(Number.isSafeInteger(f.count) && f.count > 0);
    }
  }
  assert.match(scanMessage(result), /^build-output-scan: rejected( [a-z-]+=\d+)+$/);
  assert.equal(scanMessage({ status: 'clean', files: 8 }), 'build-output-scan: clean files=8');
});

function cli(args: readonly string[]) {
  const r = spawnSync(
    process.execPath,
    ['--no-warnings', join(REPO_ROOT, 'scripts', 'scan-build-output.ts'), ...args],
    {
      encoding: 'utf8',
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('the CLI scans one explicit directory and exits 0, 1 or 2', () => {
  const clean = copy();
  assert.deepEqual(cli(['--dir', clean]), { status: 0, out: 'build-output-scan: clean files=8\n' });
  const leaky = copy();
  edit(leaky, 'dashboard/styles.css', (t) => `${t}\n/* ${CANARY} */\n`);
  const rejectedRun = cli(['--dir', leaky]);
  assert.equal(rejectedRun.status, 1);
  assert.equal(rejectedRun.out, 'build-output-scan: rejected leak-canary=1\n');
  assert.equal(rejectedRun.out.includes(leaky), false);
  for (const args of [
    [],
    ['--dir'],
    ['--dir', clean, '--dir', clean],
    ['--out', clean],
    [clean],
    ['--dir', clean, '--authenticity', 'BUILD_VERIFIED'],
  ]) {
    const usage = cli(args);
    assert.equal(usage.status, 2, args.join(' '));
    assert.equal(usage.out.includes(clean), false);
  }
  assert.equal(cli(['--dir', 'relative/out']).status, 1);
});

test('a symlinked file is refused by lstat even if the read layer would follow it', () => {
  const dir = copy();
  const outside = join(workspace, `outside-follow-${String(counter)}.css`);
  writeFileSync(outside, readFileSync(file(dir, 'dashboard/styles.css')));
  unlinkSync(file(dir, 'dashboard/styles.css'));
  symlinkSync(outside, file(dir, 'dashboard/styles.css'));
  // A read adapter without O_NOFOLLOW protection: it reads the link target.
  const following: ScannerDeps = {
    fs: {
      ...nodePublisherFs,
      readHandle: (path, max) => {
        const bytes = readFileSync(path);
        return bytes.byteLength > max
          ? { status: 'too-large' }
          : { status: 'ok', bytes, isFile: true, uid: 0, mode: 0o644, nlink: 1, stable: true };
      },
    },
  };
  assert.deepEqual(codes(scanBuildOutput(dir, following)), ['symlink-entry']);
});

/* ------------------------------------------------------------------ *
 * Synthetic demonstration state (ADR-0011 P4)
 * ------------------------------------------------------------------ */

function demoText(): string {
  const out = demoPublicationText();
  assert.equal(out.status, 'ok');
  return out.status === 'ok' ? out.text : '';
}

function withDemo(text: string): string {
  const dir = copy();
  writeFileSync(file(dir, 'dashboard/publication-data.js'), publicationDataModule('demo', text));
  return dir;
}

function editDemo(change: (m: Record<string, unknown>) => void): string {
  const m = JSON.parse(demoText()) as Record<string, unknown>;
  change(m);
  return `${JSON.stringify(m, null, 2)}\n`;
}

test('a synthetic-only demo output is clean, and clean is never a verification', () => {
  const result = scanBuildOutput(withDemo(demoText()));
  assert.deepEqual(result, { status: 'clean', files: 8 });
  assert.equal(JSON.stringify(result).includes('VERIFIED'), false);
  assert.ok(SCAN_CODES.includes('demo-not-synthetic-only'));
});

test('a demo state that is not synthetic-only is rejected', () => {
  const realResult = (JSON.parse(manifest()) as { results: unknown[] }).results[0];
  const syntheticEntry = (m: Record<string, unknown>) =>
    ((m.synthetic as Record<string, unknown>).results as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
  const cases: [string, string][] = [
    ['real manifest labelled demo', manifest()],
    ['real results in demo', editDemo((m) => (m.results = [realResult]))],
    [
      'untrusted-origin entry in demo',
      editDemo((m) => {
        const pr = (
          (m.synthetic as Record<string, unknown>).results as Record<string, unknown>[]
        )[5] as Record<string, unknown>;
        m.untrustedOrigin = [
          {
            ...pr,
            gate: {
              ...(pr.gate as object),
              authenticity: 'BUILD_VERIFIED',
              freshness: 'CURRENT',
              verifiedAt: (m.build as Record<string, unknown>).builtAt,
            },
          },
        ];
      }),
    ],
    ['missing synthetic section', editDemo((m) => (m.synthetic = null))],
    [
      'verified-origin synthetic summary',
      editDemo((m) => {
        const e = syntheticEntry(m);
        e.summary = {
          state: 'SUMMARY_VERIFIED_ORIGIN',
          reasons: ['verified-origin'],
          label: 'verified-origin',
        };
        e.artifact = { id: 15_000_001, digest: null, integrity: 'not-checked' };
      }),
    ],
  ];
  for (const [name, text] of cases) {
    const found = codes(scanBuildOutput(withDemo(text)));
    assert.ok(
      found.includes('demo-not-synthetic-only') || found.includes('publication-rejected'),
      `${name}: ${found.join(',')}`,
    );
  }
  // Parse-valid mixed or mislabelled manifests are refused by the demo policy itself.
  assert.deepEqual(codes(scanBuildOutput(withDemo(manifest()))), ['demo-not-synthetic-only']);
  assert.deepEqual(codes(scanBuildOutput(withDemo(cases[3]?.[1] ?? ''))), [
    'demo-not-synthetic-only',
  ]);
  assert.deepEqual(codes(scanBuildOutput(withDemo(cases[4]?.[1] ?? ''))), [
    'demo-not-synthetic-only',
  ]);
  // Empty demo text and unknown states stay fixed shape/state findings.
  assert.deepEqual(codes(scanBuildOutput(withDemo(''))), ['data-module-text']);
});

test('none and embedded scanner behaviour is unchanged by the demo state', () => {
  assert.deepEqual(scanBuildOutput(copy()), { status: 'clean', files: 8 });
  assert.deepEqual(scanBuildOutput(embedded()), { status: 'clean', files: 8 });
  // Demo text under the embedded state keeps the existing embedded rules (strict reader only).
  const dir = copy();
  writeFileSync(
    file(dir, 'dashboard/publication-data.js'),
    publicationDataModule('embedded', demoText()),
  );
  assert.deepEqual(scanBuildOutput(dir), { status: 'clean', files: 8 });
});
