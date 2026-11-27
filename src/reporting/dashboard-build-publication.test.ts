/**
 * Tests for the publication-enabled dashboard build (ADR-0011 P3-3,
 * `scripts/build-dashboard.ts`).
 *
 * Located under `src/` because `npm run test:unit` (and CI) runs
 * `src/**\/*.test.ts` only. Same conventions as the other unit tests
 * (ADR-0002). Every publication generation is synthetic and written into a
 * fresh `mkdtemp` sandbox; integration tests run the real build script from
 * a temporary git copy of the build inputs, so the real checkout is never
 * modified. Nothing reads a real generation, token, bundle or GitHub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import ts from 'typescript';

import { CANARY, SYNTHETIC_SHA } from './fixtures.ts';
import { TRUST_POLICY } from './verdict-cli.ts';
import { publicPolicy, type PublicPolicy } from './verdict-bundle.ts';
import {
  BUILD_RECORD_FILE,
  BUILD_RECORD_KIND,
  BUILD_RECORD_SCHEMA_VERSION,
  MANIFEST_FILE,
  generationName,
  serializeBuildRecord,
  type BuildRecord,
  type GitProbe,
} from './publication-publisher.ts';
import { outputScan } from './publication-manifest.ts';
import { parsePublication } from './publication-view.ts';
import { DEMO_SOURCE_COMMIT, demoPublicationText } from './demo-publication.ts';
import {
  APPROVED_SCRIPT,
  EXPECTED_CSP,
  FORBIDDEN_JS,
  Findings,
  OUTPUT_FILES,
  dataModuleFindings,
  javascriptFindings,
  leakFindings,
  rawReportFindings,
  scanBuildOutput,
  type ScanResult,
} from './build-output-scanner.ts';
import {
  BUILD_OUTPUT_FILES,
  DATA_FORBIDDEN,
  FORBIDDEN,
  HTML_REQUIRED,
  PUBLICATION_DATA_FILE,
  parseBuildArgs,
  prewriteScan,
  runBuild,
  publicationDataAcceptable,
  publicationDataModule,
  safeStringLiteral,
  verifiedPublicationText,
} from '../../scripts/build-dashboard.ts';

/* ------------------------------------------------------------------ *
 * Synthetic generations
 * ------------------------------------------------------------------ */

const REPO_ROOT = process.cwd();
const SOURCE_COMMIT = 'c0ffee0000000000000000000000000000c0ffee';
const OTHER_COMMIT = 'deadbeef00000000000000000000000000000000';
const BUILT_AT = '2026-11-26T12:00:00.000Z';
const COMMITTED_POLICY = publicPolicy(TRUST_POLICY) as PublicPolicy;
const RECORD_SECRETS = { allowListSha256: 'e'.repeat(64), packageLockSha256: 'f'.repeat(64) };

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function manifestText(sourceCommit = SOURCE_COMMIT, policy: object = COMMITTED_POLICY): string {
  return `${JSON.stringify(
    {
      manifestSchemaVersion: '1.0.0',
      kind: 'quality-verdict-publication',
      build: { sourceCommit, builtAt: BUILT_AT, policy },
      results: [
        {
          runId: 1_000_001,
          runAttempt: 1,
          headSha: SYNTHETIC_SHA,
          event: 'push',
          gate: {
            state: 'VERIFIED_PASS',
            reasons: ['gate-success'],
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
          metrics: null,
        },
      ],
      untrustedOrigin: [],
      synthetic: null,
    },
    null,
    2,
  )}\n`;
}

function record(manifest: string, overrides: Partial<BuildRecord> = {}): string {
  return serializeBuildRecord({
    buildRecordSchemaVersion: BUILD_RECORD_SCHEMA_VERSION,
    kind: BUILD_RECORD_KIND,
    sourceCommit: (JSON.parse(manifest) as { build: { sourceCommit: string } }).build.sourceCommit,
    builtAt: BUILT_AT,
    nodeVersion: 'v24.22.3',
    ...RECORD_SECRETS,
    manifestSha256: sha256(manifest),
    ...overrides,
  });
}

interface Generation {
  readonly dir: string;
  readonly sha: string;
  readonly text: string;
}

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qvp-dashboard-')));
  chmodSync(dir, 0o700);
  return dir;
}

function generation(
  parent: string,
  options: { manifest?: string; record?: string; name?: string } = {},
): Generation {
  const text = options.manifest ?? manifestText();
  const sha = sha256(text);
  const dir = join(parent, options.name ?? generationName(BUILT_AT, sha));
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const [file, content] of [
    [MANIFEST_FILE, text],
    [BUILD_RECORD_FILE, options.record ?? record(text)],
  ] as const) {
    writeFileSync(join(dir, file), content, { mode: 0o600 });
    chmodSync(join(dir, file), 0o600);
  }
  return { dir, sha, text };
}

function cleanGit(
  head: string | undefined = SOURCE_COMMIT,
  status: string | undefined = '',
): GitProbe {
  return { head: () => head, status: () => status };
}

/** Runs a check expected to refuse and returns the fixed refusal code. */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail('expected a refusal');
}

function withSandbox(fn: (dir: string) => void): void {
  const dir = sandbox();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * Command line
 * ------------------------------------------------------------------ */

test('the CLI accepts no options, --out, and both publication options together', () => {
  const pin = 'a'.repeat(64);
  assert.deepEqual(parseBuildArgs([]), {
    ok: true,
    out: undefined,
    publication: undefined,
    demo: false,
  });
  assert.deepEqual(parseBuildArgs(['--out', '/x/out']), {
    ok: true,
    out: '/x/out',
    publication: undefined,
    demo: false,
  });
  assert.deepEqual(
    parseBuildArgs(['--publication-sha256', pin, '--publication', '/g/qvp-x', '--out', '/o']),
    { ok: true, out: '/o', publication: { generationDir: '/g/qvp-x', sha256: pin }, demo: false },
  );
});

test('the CLI refuses a lone publication option, bad values and anything unknown', () => {
  const pin = 'a'.repeat(64);
  const bad: string[][] = [
    ['--publication', '/g/qvp-x'],
    ['--publication-sha256', pin],
    ['--out', '/o', '--publication', '/g/qvp-x'],
    ['--publication', 'relative/qvp-x', '--publication-sha256', pin],
    ['--publication', '/g/qvp-x', '--publication-sha256', pin.toUpperCase()],
    ['--publication', '/g/qvp-x', '--publication-sha256', pin.slice(1)],
    ['--publication', '/g/qvp-x', '--publication-sha256', pin, '--publication', '/g/qvp-y'],
    ['--publication', '/g/qvp-x', '--publication-sha256'],
    ['--publication', '', '--publication-sha256', pin],
    ['--out'],
    ['--out', '/o', '--out', '/p'],
    ['--authenticity', 'BUILD_VERIFIED'],
    ['--source-commit', SOURCE_COMMIT],
    ['/g/qvp-x'],
  ];
  for (const argv of bad) assert.deepEqual(parseBuildArgs(argv), { ok: false }, argv.join(' '));
});

/* ------------------------------------------------------------------ *
 * Source binding and generation validation (fake git, real filesystem)
 * ------------------------------------------------------------------ */

test('a valid generation bound to HEAD yields exactly its manifest text', () => {
  withSandbox((parent) => {
    const g = generation(parent);
    const text = verifiedPublicationText(
      REPO_ROOT,
      { generationDir: g.dir, sha256: g.sha },
      cleanGit(),
    );
    assert.equal(text, g.text);
  });
});

test('an unknown HEAD, a dirty tree or a checkout that changes while reading is refused', () => {
  withSandbox((parent) => {
    const g = generation(parent);
    const request = { generationDir: g.dir, sha256: g.sha };
    assert.equal(
      refusal(() =>
        verifiedPublicationText(REPO_ROOT, request, { head: () => undefined, status: () => '' }),
      ),
      'source-commit-unknown',
    );
    assert.equal(
      refusal(() => verifiedPublicationText(REPO_ROOT, request, cleanGit('abc'))),
      'source-commit-unknown',
    );
    assert.equal(
      refusal(() =>
        verifiedPublicationText(REPO_ROOT, request, cleanGit(SOURCE_COMMIT, '?? new.txt\n')),
      ),
      'dirty-tree',
    );
    assert.equal(
      refusal(() =>
        verifiedPublicationText(REPO_ROOT, request, {
          head: () => SOURCE_COMMIT,
          status: () => undefined,
        }),
      ),
      'dirty-tree',
    );
    let heads = 0;
    const moving: GitProbe = {
      head: () => (heads++ === 0 ? SOURCE_COMMIT : OTHER_COMMIT),
      status: () => '',
    };
    assert.equal(
      refusal(() => verifiedPublicationText(REPO_ROOT, request, moving)),
      'source-changed',
    );
    let statuses = 0;
    const dirtied: GitProbe = {
      head: () => SOURCE_COMMIT,
      status: () => (statuses++ === 0 ? '' : ' M x\n'),
    };
    assert.equal(
      refusal(() => verifiedPublicationText(REPO_ROOT, request, dirtied)),
      'source-changed',
    );
  });
});

test('the manifest source commit must equal HEAD exactly', () => {
  withSandbox((parent) => {
    const g = generation(parent, { manifest: manifestText(OTHER_COMMIT) });
    const request = { generationDir: g.dir, sha256: g.sha };
    assert.equal(
      refusal(() => verifiedPublicationText(REPO_ROOT, request, cleanGit())),
      'publication-source-commit-mismatch',
    );
    assert.equal(verifiedPublicationText(REPO_ROOT, request, cleanGit(OTHER_COMMIT)), g.text);
  });
});

test('generation attacks are refused through the P3-2 reader with fixed codes', () => {
  const cases: [string, (parent: string) => { dir: string; sha: string }, string][] = [
    [
      'wrong pin',
      (p) => ({ ...generation(p), sha: 'b'.repeat(64) }),
      'publication-manifest-sha256-mismatch',
    ],
    [
      'wrong directory mode',
      (p) => {
        const g = generation(p);
        chmodSync(g.dir, 0o755);
        return g;
      },
      'publication-unsafe-permissions',
    ],
    [
      'wrong file mode',
      (p) => {
        const g = generation(p);
        chmodSync(join(g.dir, MANIFEST_FILE), 0o644);
        return g;
      },
      'publication-file-unsafe',
    ],
    [
      'symlinked manifest',
      (p) => {
        const g = generation(p);
        const outside = join(p, 'outside.json');
        writeFileSync(outside, g.text, { mode: 0o600 });
        chmodSync(outside, 0o600);
        unlinkSync(join(g.dir, MANIFEST_FILE));
        symlinkSync(outside, join(g.dir, MANIFEST_FILE));
        return g;
      },
      'publication-file-unsafe',
    ],
    [
      'hard-linked manifest',
      (p) => {
        const g = generation(p);
        linkSync(join(g.dir, MANIFEST_FILE), join(p, 'second-link.json'));
        return g;
      },
      'publication-file-unsafe',
    ],
    [
      'symlinked generation',
      (p) => {
        const g = generation(p, { name: 'real-generation' });
        const link = join(p, generationName(BUILT_AT, g.sha));
        symlinkSync(g.dir, link);
        return { dir: link, sha: g.sha };
      },
      'publication-symlink-refused',
    ],
    [
      'missing build record',
      (p) => {
        const g = generation(p);
        unlinkSync(join(g.dir, BUILD_RECORD_FILE));
        return g;
      },
      'publication-incomplete-generation',
    ],
    [
      'empty claim',
      (p) => {
        const sha = sha256(manifestText());
        const dir = join(p, generationName(BUILT_AT, sha));
        mkdirSync(dir, { mode: 0o700 });
        chmodSync(dir, 0o700);
        return { dir, sha };
      },
      'publication-incomplete-generation',
    ],
    [
      'staging directory',
      (p) => generation(p, { name: '.qvp-staging-0123456789abcdef' }),
      'publication-invalid-generation-name',
    ],
    [
      'extra file',
      (p) => {
        const g = generation(p);
        writeFileSync(join(g.dir, 'extra.json'), '{}', { mode: 0o600 });
        return g;
      },
      'publication-unexpected-entries',
    ],
    [
      'non-canonical manifest',
      (p) => generation(p, { manifest: `${JSON.stringify(JSON.parse(manifestText()))}\n` }),
      'publication-manifest-invalid',
    ],
    [
      'build-record mismatch',
      (p) => generation(p, { record: record(manifestText(), { manifestSha256: 'c'.repeat(64) }) }),
      'publication-build-record-mismatch',
    ],
    [
      'build-record source commit',
      (p) => generation(p, { record: record(manifestText(), { sourceCommit: OTHER_COMMIT }) }),
      'publication-build-record-mismatch',
    ],
    [
      'foreign publisher policy',
      (p) =>
        generation(p, {
          manifest: manifestText(SOURCE_COMMIT, { ...COMMITTED_POLICY, workflowId: 1 }),
        }),
      'publication-policy-mismatch',
    ],
    [
      'wrong generation name',
      (p) => generation(p, { name: 'qvp-20261126T120000Z-0000000000000000' }),
      'publication-generation-name-mismatch',
    ],
  ];
  for (const [name, make, code] of cases) {
    withSandbox((parent) => {
      const g = make(parent);
      const message = refusal(() =>
        verifiedPublicationText(REPO_ROOT, { generationDir: g.dir, sha256: g.sha }, cleanGit()),
      );
      assert.equal(message, code, name);
      assert.equal(message.includes(parent), false);
    });
  }
});

/* ------------------------------------------------------------------ *
 * Generated data module
 * ------------------------------------------------------------------ */

test('the generated module has exactly the two exports in a fixed form', () => {
  const text = manifestText();
  assert.equal(
    publicationDataModule('none', ''),
    '// Generated by scripts/build-dashboard.ts (ADR-0011 P3-3). Data only; do not edit.\nexport const PUBLICATION_STATE = \'none\';\nexport const PUBLICATION_TEXT = "";\n',
  );
  const module = publicationDataModule('embedded', text);
  const lines = module.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], "export const PUBLICATION_STATE = 'embedded';");
  assert.ok(lines[2]?.startsWith('export const PUBLICATION_TEXT = "'));
  assert.equal(lines[3], '');
  assert.equal(publicationDataAcceptable(module, 'embedded', text), true);
  assert.equal(publicationDataAcceptable(publicationDataModule('none', ''), 'none', ''), true);
});

test('the string literal is ASCII-only, escapes ambiguous characters and round-trips', () => {
  const tricky = `a"b\\c\n\r\t\u2028\u2029</script><!--&'\`\${x}é😀\u0000\u001f`;
  const literal = safeStringLiteral(tricky);
  assert.match(literal, /^"[\x20-\x7e]*"$/);
  for (const raw of ['\u2028', '\u2029', '<', '>', '&', "'", '`', '\n', '\r', 'é']) {
    assert.equal(literal.slice(1, -1).includes(raw), false, JSON.stringify(raw));
  }
  assert.ok(
    literal.includes('\\u2028') && literal.includes('\\u2029') && literal.includes('\\u003c'),
  );
  assert.equal(JSON.parse(literal), tricky);
  // Evaluated as JavaScript source it is the same string.
  const module = `export const PUBLICATION_TEXT = ${literal};\n`;
  const evaluated = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${module}process.stdout.write(JSON.stringify(PUBLICATION_TEXT));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(JSON.parse(evaluated), tricky);
});

test('the data-module check refuses tampering, wrong state and leakage markers', () => {
  const text = manifestText();
  const good = publicationDataModule('embedded', text);
  assert.equal(publicationDataAcceptable(good, 'none', text), false);
  assert.equal(publicationDataAcceptable(good, 'embedded', `${text} `), false);
  assert.equal(publicationDataAcceptable(publicationDataModule('none', text), 'none', text), false);
  assert.equal(
    publicationDataAcceptable(publicationDataModule('embedded', ''), 'embedded', ''),
    false,
  );
  assert.equal(
    publicationDataAcceptable(`${good}export const extra = 1;\n`, 'embedded', text),
    false,
  );
  assert.equal(
    publicationDataAcceptable(good.replace('export const', 'export let'), 'embedded', text),
    false,
  );
  assert.equal(
    publicationDataAcceptable(`${good.slice(0, -2)}\u2028";\n`, 'embedded', text),
    false,
  );
  // A manifest-shaped text with leakage is refused even if a caller built the module.
  const leaks = [
    CANARY,
    'Bearer abc',
    'Authorization: token',
    ['ghp', 'x'.repeat(36)].join('_'),
    'https://example.invalid/a?sig=1&se=2',
    'productionresultssa1.blob.core.windows.net',
    '/Users/example/QualityPublication/inputs/allowlist.json',
    '/home/runner/work',
    `"allowListSha256": "${RECORD_SECRETS.allowListSha256}"`,
    '"stdout": []',
    '<script>alert(1)</script>',
    'javascript:void(0)',
    'eval(1)',
    'fetch(1)',
  ];
  for (const leak of leaks) {
    const leaky = text.replace('"Playwright UI Tests"', JSON.stringify(leak));
    assert.equal(
      publicationDataAcceptable(publicationDataModule('embedded', leaky), 'embedded', leaky),
      false,
      leak,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Integration: the real build script in a temporary git checkout
 * ------------------------------------------------------------------ */

const GIT = [
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'user.name=Synthetic',
  '-c',
  'user.email=synthetic@example.invalid',
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

interface Checkout {
  readonly root: string;
  readonly head: string;
}

/** A committed, clean copy of the build inputs; `node_modules` is a symlink and ignored. */
function checkout(parent: string): Checkout {
  const root = join(parent, 'checkout');
  mkdirSync(root);
  for (const path of ['package.json', 'scripts', 'dashboard', 'src']) {
    cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
  }
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'));
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'synthetic checkout');
  return { root, head: git(root, 'rev-parse', 'HEAD') };
}

function build(c: Checkout, args: string[]) {
  const result = spawnSync(
    process.execPath,
    // Suppress Node's module-type warning, which names the script path.
    ['--no-warnings', join(c.root, 'scripts', 'build-dashboard.ts'), ...args],
    {
      cwd: c.root,
      encoding: 'utf8',
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)))
    .sort();
}

const EXPECTED_FILES = [
  'dashboard/app.js',
  'dashboard/index.html',
  'dashboard/publication-data.js',
  'dashboard/styles.css',
  'src/reporting/dashboard-model.js',
  'src/reporting/publication-view.js',
  'src/reporting/quality-summary.js',
  'src/reporting/verdict.js',
];

test('integration: picker-only and publication builds, binding, CSP and leakage', () => {
  withSandbox((parent) => {
    const c = checkout(parent);
    const generations = join(parent, 'generations');
    mkdirSync(generations, { mode: 0o700 });
    chmodSync(generations, 0o700);

    // 1. Picker-only build: unchanged page, `none` data module.
    const none = build(c, ['--out', join(parent, 'out-none')]);
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /^publication: none$/m);
    assert.deepEqual(filesUnder(join(parent, 'out-none')), EXPECTED_FILES);
    assert.equal(
      readFileSync(join(parent, 'out-none', PUBLICATION_DATA_FILE), 'utf8'),
      publicationDataModule('none', ''),
    );

    // 2. Publication build bound to HEAD.
    const g = generation(generations, { manifest: manifestText(c.head) });
    const out = join(parent, 'out-embedded');
    const embedded = build(c, [
      '--out',
      out,
      '--publication',
      g.dir,
      '--publication-sha256',
      g.sha,
    ]);
    assert.equal(embedded.status, 0, embedded.stderr);
    assert.match(
      embedded.stdout,
      new RegExp(`^publication: embedded manifest-sha256=${g.sha}$`, 'm'),
    );
    assert.equal(embedded.stdout.includes(g.dir), false);
    assert.deepEqual(filesUnder(out), EXPECTED_FILES);
    const data = readFileSync(join(out, PUBLICATION_DATA_FILE), 'utf8');
    assert.equal(data, publicationDataModule('embedded', g.text));
    assert.equal(
      parsePublication(JSON.parse(data.split('\n')[2]?.slice(31, -1) ?? '""') as string).state,
      'valid',
    );
    const evaluated = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(`file://${join(out, PUBLICATION_DATA_FILE)}`)}).then((m) => process.stdout.write(JSON.stringify([m.PUBLICATION_STATE, m.PUBLICATION_TEXT, Object.keys(m).sort()])));`,
      ],
      { encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(evaluated), [
      'embedded',
      g.text,
      ['PUBLICATION_STATE', 'PUBLICATION_TEXT'],
    ]);

    // CSP and page unchanged; app.js (not the HTML) imports the data module (P3-4).
    const html = readFileSync(join(out, 'dashboard', 'index.html'), 'utf8');
    assert.equal(html, readFileSync(join(REPO_ROOT, 'dashboard', 'index.html'), 'utf8'));
    assert.ok(html.includes("connect-src 'none'"));
    // The data module is not loaded by its own script tag; only app.js imports it.
    assert.equal(/<script[^>]*publication-data/.test(html), false);
    assert.equal((html.match(/<script/g) ?? []).length, 1);
    const app = readFileSync(join(out, 'dashboard', 'app.js'), 'utf8');
    assert.ok(app.includes("from './publication-data.js'"));
    const imports = ts
      .preProcessFile(app, true, false)
      .importedFiles.map((f) => f.fileName)
      .sort();
    assert.deepEqual(imports, [
      '../src/reporting/dashboard-model.js',
      '../src/reporting/publication-view.js',
      '../src/reporting/quality-summary.js',
      './publication-data.js',
    ]);
    for (const file of EXPECTED_FILES.filter((f) => f !== PUBLICATION_DATA_FILE)) {
      assert.equal(
        readFileSync(join(out, file), 'utf8'),
        readFileSync(join(parent, 'out-none', file), 'utf8'),
        file,
      );
    }
    // No network API, build record value, path or canary anywhere in the output.
    for (const file of EXPECTED_FILES) {
      const content = readFileSync(join(out, file), 'utf8');
      for (const marker of [
        RECORD_SECRETS.allowListSha256,
        RECORD_SECRETS.packageLockSha256,
        parent,
        g.dir,
        CANARY,
        'nodeVersion',
        'v24.22.3',
      ]) {
        assert.equal(content.includes(marker), false, `${file}: ${marker}`);
      }
      if (file.endsWith('.js'))
        assert.equal(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/.test(content), false, file);
    }

    // 3. An ancestor commit is not accepted: a new commit moves HEAD.
    writeFileSync(join(c.root, 'dashboard', 'note.txt'), 'x');
    git(c.root, 'add', '-A');
    git(c.root, 'commit', '-q', '-m', 'later commit');
    const ancestor = build(c, [
      '--out',
      join(parent, 'out-ancestor'),
      '--publication',
      g.dir,
      '--publication-sha256',
      g.sha,
    ]);
    assert.equal(ancestor.status, 1);
    assert.equal(
      ancestor.stderr.trim(),
      'dashboard build refused: publication-source-commit-mismatch',
    );

    // 4. A dirty checkout is refused before the generation is read.
    writeFileSync(join(c.root, 'untracked.txt'), 'x');
    const dirty = build(c, [
      '--out',
      join(parent, 'out-dirty'),
      '--publication',
      g.dir,
      '--publication-sha256',
      g.sha,
    ]);
    assert.equal(dirty.status, 1);
    assert.equal(dirty.stderr.trim(), 'dashboard build refused: dirty-tree');
    unlinkSync(join(c.root, 'untracked.txt'));

    // 5. Usage errors and reader refusals leave nothing behind and print no path.
    const lone = build(c, ['--out', join(parent, 'out-lone'), '--publication', g.dir]);
    assert.equal(lone.status, 2);
    const badPin = build(c, [
      '--out',
      join(parent, 'out-pin'),
      '--publication',
      g.dir,
      '--publication-sha256',
      g.sha.toUpperCase(),
    ]);
    assert.equal(badPin.status, 2);
    const g2 = generation(generations, {
      manifest: manifestText(git(c.root, 'rev-parse', 'HEAD')),
    });
    const wrongPin = build(c, [
      '--out',
      join(parent, 'out-wrong'),
      '--publication',
      g2.dir,
      '--publication-sha256',
      g.sha,
    ]);
    assert.equal(wrongPin.status, 1);
    assert.equal(
      wrongPin.stderr.trim(),
      'dashboard build refused: publication-manifest-sha256-mismatch',
    );
    for (const r of [ancestor, dirty, lone, badPin, wrongPin]) {
      assert.equal(`${r.stdout}${r.stderr}`.includes(parent), false);
    }
    const inside = build(c, [
      '--out',
      join(g2.dir, 'site'),
      '--publication',
      g2.dir,
      '--publication-sha256',
      g2.sha,
    ]);
    assert.equal(inside.stderr.trim(), 'dashboard build refused: output-inside-publication');
    for (const name of ['out-ancestor', 'out-dirty', 'out-lone', 'out-pin', 'out-wrong']) {
      assert.equal(readdirSync(parent).includes(name), false, name);
    }
    assert.deepEqual(readdirSync(g2.dir).sort(), [BUILD_RECORD_FILE, MANIFEST_FILE].sort());

    // 6. The current HEAD with a matching generation builds again.
    const again = build(c, [
      '--out',
      join(parent, 'out-again'),
      '--publication',
      g2.dir,
      '--publication-sha256',
      g2.sha,
    ]);
    assert.equal(again.status, 0, again.stderr);
  });
});

test('the strengthened data scan catches markers that pass the reader and the P1 scan', () => {
  // Each value fits the policy workflowName pattern, so the strict reader and
  // the P1 output scan accept it; only the build's data scan refuses it.
  const markers = [
    'Authorization header',
    'x-amz-date',
    's3.amazonaws.com mirror',
    'allowlist file',
    'QualityPublication run',
    'storage.googleapis.com',
  ];
  for (const marker of markers) {
    const text = manifestText(SOURCE_COMMIT, { ...COMMITTED_POLICY, workflowName: marker });
    assert.equal(parsePublication(text).state, 'valid', marker);
    assert.equal(outputScan(text), true, marker);
    assert.equal(
      publicationDataAcceptable(publicationDataModule('embedded', text), 'embedded', text),
      false,
      marker,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Synthetic demonstration build (ADR-0011 P4)
 * ------------------------------------------------------------------ */

function demoText(): string {
  const out = demoPublicationText();
  assert.equal(out.status, 'ok');
  return out.status === 'ok' ? out.text : '';
}

test('the CLI accepts --demo alone or with --out, and rejects every mixed combination', () => {
  const pin = 'a'.repeat(64);
  assert.deepEqual(parseBuildArgs(['--demo']), {
    ok: true,
    out: undefined,
    publication: undefined,
    demo: true,
  });
  assert.deepEqual(parseBuildArgs(['--out', '/o', '--demo']), {
    ok: true,
    out: '/o',
    publication: undefined,
    demo: true,
  });
  assert.deepEqual(parseBuildArgs(['--demo', '--out', '/o']), {
    ok: true,
    out: '/o',
    publication: undefined,
    demo: true,
  });
  const bad: string[][] = [
    ['--demo', '--demo'],
    ['--demo', '--publication', '/g/qvp-x'],
    ['--demo', '--publication-sha256', pin],
    ['--demo', '--publication', '/g/qvp-x', '--publication-sha256', pin],
    ['--publication', '/g/qvp-x', '--publication-sha256', pin, '--demo'],
    ['--demo', 'true'],
    ['--demo=1'],
    ['--demo', '--authenticity', 'BUILD_VERIFIED'],
  ];
  for (const argv of bad) assert.deepEqual(parseBuildArgs(argv), { ok: false }, argv.join(' '));
});

test('the demo data module has the fixed form and accepts only synthetic-only text', () => {
  const text = demoText();
  const module = publicationDataModule('demo', text);
  assert.equal(module.split('\n')[1], "export const PUBLICATION_STATE = 'demo';");
  assert.equal(publicationDataAcceptable(module, 'demo', text), true);
  // A real-looking (non-synthetic) manifest can never be a demo.
  const real = manifestText(SOURCE_COMMIT, COMMITTED_POLICY);
  assert.equal(publicationDataAcceptable(publicationDataModule('demo', real), 'demo', real), false);
  // A mixed manifest (synthetic plus a real result) is refused.
  const mixed = JSON.parse(text) as Record<string, unknown>;
  mixed.results = (JSON.parse(real) as Record<string, unknown>).results;
  const mixedText = `${JSON.stringify(mixed, null, 2)}\n`;
  assert.equal(
    publicationDataAcceptable(publicationDataModule('demo', mixedText), 'demo', mixedText),
    false,
  );
  assert.equal(publicationDataAcceptable(publicationDataModule('demo', ''), 'demo', ''), false);
  // The none and embedded forms are unchanged.
  assert.equal(
    publicationDataModule('none', ''),
    '// Generated by scripts/build-dashboard.ts (ADR-0011 P3-3). Data only; do not edit.\nexport const PUBLICATION_STATE = \'none\';\nexport const PUBLICATION_TEXT = "";\n',
  );
  assert.equal(
    publicationDataModule('embedded', real).split('\n')[1],
    "export const PUBLICATION_STATE = 'embedded';",
  );
});

test('integration: a demo build needs no git, token, reader or generation and scans clean', () => {
  withSandbox((parent) => {
    // A copy with no .git: any git probe would refuse with source-commit-unknown.
    const root = join(parent, 'no-git-copy');
    mkdirSync(root);
    for (const path of ['package.json', 'scripts', 'dashboard', 'src']) {
      cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
    }
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'));
    const out = join(parent, 'demo-out');
    const run = spawnSync(
      process.execPath,
      ['--no-warnings', join(root, 'scripts', 'build-dashboard.ts'), '--demo', '--out', out],
      {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      /^publication: demo \(SYNTHETIC DEMONSTRATION DATA, not real CI results\)$/m,
    );
    assert.deepEqual(filesUnder(out), EXPECTED_FILES);
    const data = readFileSync(join(out, PUBLICATION_DATA_FILE), 'utf8');
    assert.equal(data, publicationDataModule('demo', demoText()));
    assert.ok(data.includes(DEMO_SOURCE_COMMIT));
    assert.equal(
      readFileSync(join(out, 'dashboard', 'index.html'), 'utf8'),
      readFileSync(join(REPO_ROOT, 'dashboard', 'index.html'), 'utf8'),
    );
    assert.deepEqual(scanBuildOutput(out), { status: 'clean', files: 8 });
    // Mixed options never build anything.
    const mixed = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        join(root, 'scripts', 'build-dashboard.ts'),
        '--demo',
        '--out',
        join(parent, 'mixed'),
        '--publication',
        parent,
        '--publication-sha256',
        'a'.repeat(64),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(mixed.status, 2);
    assert.equal(readdirSync(parent).includes('mixed'), false);
  });
});

/* ------------------------------------------------------------------ *
 * Mandatory scanner integration (ADR-0011 P4-3, P4-3C-1)
 * ------------------------------------------------------------------ */

const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build-dashboard.ts');
const REFUSAL_LINE = /^dashboard build refused: output-scan-rejected(?: [a-z-]+=[1-9]\d*)+$/;

/** Runs the real build in-process, capturing its fixed lines. */
function inProcess(args: string[], scanOutput?: (dir: string) => ScanResult) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = runBuild(
    args,
    BUILD_SCRIPT,
    { out: (line) => stdout.push(line), err: (line) => stderr.push(line) },
    scanOutput === undefined ? undefined : { scanOutput },
  );
  return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

/** The exact text of every file in an output directory. */
function outputMap(dir: string): Map<string, string> {
  return new Map(OUTPUT_FILES.map((path) => [path, readFileSync(join(dir, path), 'utf8')]));
}

/** Content and inode of every output file: a rewrite would change one of them. */
function fingerprint(dir: string): string[] {
  return OUTPUT_FILES.map((path) => {
    const info = statSync(join(dir, path));
    return `${path}:${String(info.ino)}:${sha256(readFileSync(join(dir, path)))}`;
  });
}

function scanCodes(result: ScanResult): string[] {
  return result.status === 'clean' ? [] : result.findings.map((f) => f.code);
}

function findingsOf(fn: (out: Findings) => void): string[] {
  const out = new Findings();
  fn(out);
  return out.list().map((f) => f.code);
}

/** A no-git copy of the build inputs; the build itself needs no git for none or demo. */
function inputCopy(parent: string): string {
  const root = join(parent, 'copy');
  mkdirSync(root);
  for (const path of ['package.json', 'scripts', 'dashboard', 'src']) {
    cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
  }
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'));
  return root;
}

function copyBuild(root: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', join(root, 'scripts', 'build-dashboard.ts'), ...args],
    { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/* Policy drift ------------------------------------------------------ */

test('drift: every builder forbidden-API rule is also a scanner rule', () => {
  const scanner = new Set(FORBIDDEN_JS.map((r) => `${r.source}/${r.flags}`));
  for (const rule of FORBIDDEN) {
    assert.ok(scanner.has(`${rule.source}/${rule.flags}`), rule.source);
  }
  assert.ok(FORBIDDEN_JS.length > FORBIDDEN.length, 'the scanner stays stricter');
  const samples = [
    'el.innerHTML = x;',
    'el.outerHTML = x;',
    'el.insertAdjacentHTML("a", x);',
    'document.write(x);',
    'eval (x);',
    'new Function("x");',
    'Function("x");',
    'fetch(x);',
    'new XMLHttpRequest();',
    'new WebSocket(x);',
    'new EventSource(x);',
    'navigator.sendBeacon(x);',
    'import(x);',
    'localStorage.x;',
    'sessionStorage.x;',
    'indexedDB.open(x);',
    'const u = "https://example.invalid";',
  ];
  assert.equal(samples.length, FORBIDDEN.length);
  for (const [i, sample] of samples.entries()) {
    assert.ok(FORBIDDEN[i]?.test(sample), sample);
    assert.ok(
      findingsOf((out) => {
        javascriptFindings('dashboard/app.js', sample, out);
      }).includes('js-forbidden-api'),
      sample,
    );
  }
});

test('drift: the builder writes exactly the scanner file inventory', () => {
  assert.deepEqual([...BUILD_OUTPUT_FILES], [...OUTPUT_FILES].sort());
  assert.deepEqual([...BUILD_OUTPUT_FILES], EXPECTED_FILES);
  assert.equal(BUILD_OUTPUT_FILES.length, 8);
});

test('drift: data modules of all three modes satisfy both validators', () => {
  const modes: [Parameters<typeof publicationDataModule>[0], string][] = [
    ['none', ''],
    ['embedded', manifestText()],
    ['demo', demoText()],
  ];
  for (const [state, text] of modes) {
    const module = publicationDataModule(state, text);
    assert.equal(publicationDataAcceptable(module, state, text), true, state);
    assert.deepEqual(
      findingsOf((out) => {
        dataModuleFindings(module, out);
      }),
      [],
      state,
    );
  }
});

test('drift: malformed data modules are rejected by both validators', () => {
  const header =
    '// Generated by scripts/build-dashboard.ts (ADR-0011 P3-3). Data only; do not edit.';
  const embedded = publicationDataModule('embedded', manifestText());
  const cases: [string, string, Parameters<typeof publicationDataModule>[0], string][] = [
    ['no header', embedded.split('\n').slice(1).join('\n'), 'embedded', manifestText()],
    [
      'unknown state',
      `${header}\nexport const PUBLICATION_STATE = 'verified';\nexport const PUBLICATION_TEXT = "";\n`,
      'none',
      '',
    ],
    ['none with text', publicationDataModule('none', manifestText()), 'none', manifestText()],
    ['embedded without text', publicationDataModule('embedded', ''), 'embedded', ''],
    ['embedded not a manifest', publicationDataModule('embedded', '{}\n'), 'embedded', '{}\n'],
    ['extra export', `${embedded}export const X = 1;\n`, 'embedded', manifestText()],
    [
      'raw non-ASCII',
      `${header}\nexport const PUBLICATION_STATE = 'none';\nexport const PUBLICATION_TEXT = "\u00e9";\n`,
      'none',
      '\u00e9',
    ],
  ];
  for (const [name, module, state, text] of cases) {
    assert.equal(publicationDataAcceptable(module, state, text), false, name);
    assert.notDeepEqual(
      findingsOf((out) => {
        dataModuleFindings(module, out);
      }),
      [],
      name,
    );
  }
});

test('drift: the builder data leak markers are caught by scanner rules', () => {
  // [builder rule index, sample, scanner code]
  const covered: [number, string, string][] = [
    [0, 'Authorization: Basic abcdefgh', 'leak-auth-header'],
    [1, 'Bearer abcdefghijkl', 'leak-auth-header'],
    [2, 'https-less ?sv=2024&sig=abc', 'leak-signed-url'],
    [2, 'x?X-Amz-Signature=abc', 'leak-signed-url'],
    [3, 'acct.blob.core.windows.net', 'leak-storage-host'],
    [3, 'bucket.s3.amazonaws.com', 'leak-storage-host'],
    [3, 'storage.googleapis.com', 'leak-storage-host'],
    [3, 'productionresultssa', 'leak-storage-host'],
    [4, `ghp_${'A'.repeat(20)}`, 'leak-credential'],
    [4, `github_pat_${'A'.repeat(20)}`, 'leak-credential'],
    [5, '/Users/someone/work', 'leak-private-path'],
    [5, '/home/runner/work', 'leak-private-path'],
    [5, '/private/var/x', 'leak-private-path'],
    [5, '/var/folders/x', 'leak-private-path'],
    [5, '/tmp/abc', 'leak-private-path'],
    [5, 'C:\\\\Users\\\\someone', 'leak-private-path'],
    [6, 'QualityPublication', 'leak-private-input'],
    [6, 'QualityVerdictEvidence', 'leak-private-input'],
    [6, 'quality-verdict-publication-allowlist', 'leak-private-input'],
    [6, 'allowListSha256', 'leak-build-record'],
    [6, 'packageLockSha256', 'leak-build-record'],
    [7, '"stdout": "x"', 'leak-raw-report'],
    [7, '"stderr": "x"', 'leak-raw-report'],
    [7, '"attachments": []', 'leak-raw-report'],
    [7, '"suites": []', 'leak-raw-report'],
    [7, '"specs": []', 'leak-raw-report'],
    [7, '"steps": []', 'leak-raw-report'],
    [7, '"titlePath": []', 'leak-raw-report'],
    [8, CANARY, 'leak-canary'],
  ];
  const rulesCovered = new Set<number>();
  for (const [rule, sample, code] of covered) {
    assert.ok(DATA_FORBIDDEN[rule]?.test(sample), `builder rule ${String(rule)}: ${sample}`);
    const found = findingsOf((out) => {
      leakFindings(sample, out);
      rawReportFindings(sample, out);
    });
    assert.ok(found.includes(code), `${sample} -> ${code}`);
    rulesCovered.add(rule);
  }
  // Rule 9 (markup inside data) is intentionally builder-only for the data
  // module: the scanner checks markup in the HTML, and the builder's
  // ASCII-escaped literal can never contain a raw '<'.
  assert.deepEqual(
    [...rulesCovered].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(DATA_FORBIDDEN.length, 10);
});

test('drift: the scanner CSP is the committed page policy and keeps the builder directives', () => {
  const html = readFileSync(join(REPO_ROOT, 'dashboard', 'index.html'), 'utf8');
  const content = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1];
  assert.equal(content, EXPECTED_CSP);
  for (const fragment of HTML_REQUIRED) assert.ok(html.includes(fragment), fragment);
  assert.ok(HTML_REQUIRED.includes(APPROVED_SCRIPT));
  for (const directive of ["script-src 'self'", "connect-src 'none'"]) {
    assert.ok(HTML_REQUIRED.includes(directive));
    assert.ok(EXPECTED_CSP.split('; ').includes(directive), directive);
  }
});

test('drift: demo-only rules are applied identically by builder and scanner', () => {
  const base = JSON.parse(demoText()) as Record<string, unknown>;
  const variant = (change: (m: Record<string, unknown>) => void): string => {
    const m = structuredClone(base);
    change(m);
    return `${JSON.stringify(m, null, 2)}\n`;
  };
  const first = (m: Record<string, unknown>) =>
    ((m.synthetic as Record<string, unknown>).results as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
  const cases: [string, string][] = [
    ['valid', demoText()],
    ['mixed', variant((m) => (m.results = [first(m)]))],
    ['no synthetic section', variant((m) => (m.synthetic = null))],
    [
      'real source commit',
      variant((m) => ((m.build as Record<string, unknown>).sourceCommit = SOURCE_COMMIT)),
    ],
    [
      'build-verified',
      variant((m) => ((first(m).gate as Record<string, unknown>).authenticity = 'BUILD_VERIFIED')),
    ],
    ['real-only', manifestText()],
  ];
  for (const [name, text] of cases) {
    const module = publicationDataModule('demo', text);
    const builder = publicationDataAcceptable(module, 'demo', text);
    const scanner =
      findingsOf((out) => {
        dataModuleFindings(module, out);
      }).length === 0;
    assert.equal(builder, scanner, name);
    assert.equal(builder, name === 'valid', name);
  }
});

test('drift: seeded invalid imports are rejected by both layers', () => {
  withSandbox((parent) => {
    const root = inputCopy(parent);
    const app = join(root, 'dashboard', 'app.ts');
    const original = readFileSync(app, 'utf8');
    for (const [seed, scannerCode] of [
      ["import './missing.ts';\n", 'js-unresolved-import'],
      ["import 'node:fs';\n", 'js-external-import'],
    ] as const) {
      writeFileSync(app, `${seed}${original}`);
      const out = join(parent, `out-${scannerCode}`);
      const r = copyBuild(root, ['--out', out]);
      assert.equal(r.status, 1);
      assert.equal(r.stderr.trim(), 'dashboard build refused: unresolved-import');
      assert.equal(readdirSync(parent).includes(`out-${scannerCode}`), false);
      const compiled = seed.replace('.ts', '.js');
      assert.ok(
        findingsOf((o) => {
          javascriptFindings('dashboard/app.js', compiled, o);
        }).includes(scannerCode),
      );
    }
    writeFileSync(app, original);
  });
});

/* Pre-write rejection ------------------------------------------------ */

test('pre-write: the builder scan rejects seeded content over the real output map', () => {
  withSandbox((parent) => {
    const out = join(parent, 'reference');
    const reference = inProcess(['--out', out]);
    assert.equal(reference.status, 0, reference.stderr);
    const clean = outputMap(out);
    prewriteScan(clean);
    const app = clean.get('dashboard/app.js') ?? '';
    const html = clean.get('dashboard/index.html') ?? '';
    const demoValid = JSON.parse(demoText()) as Record<string, unknown>;
    const demoVariant = (change: (m: Record<string, unknown>) => void): string => {
      const m = structuredClone(demoValid);
      change(m);
      return publicationDataModule('demo', `${JSON.stringify(m, null, 2)}\n`);
    };
    const entry = (m: Record<string, unknown>) =>
      ((m.synthetic as Record<string, unknown>).results as Record<string, unknown>[])[0] as Record<
        string,
        unknown
      >;
    const cases: [string, string, string, string][] = [
      ['forbidden JavaScript', 'dashboard/app.js', `${app}\nfetch('/x');\n`, 'js-forbidden-api'],
      [
        'credential marker',
        'dashboard/app.js',
        `${app}\nconst t = 'QUALITY_VERDICT_GITHUB_TOKEN';\n`,
        'leak-credential',
      ],
      [
        'CSP regression',
        'dashboard/index.html',
        html.replace("object-src 'none'; ", ''),
        'csp-mismatch',
      ],
      [
        'invalid relative import',
        'dashboard/app.js',
        `import './missing.js';\n${app}`,
        'js-unresolved-import',
      ],
      ['external import', 'dashboard/app.js', `import 'node:fs';\n${app}`, 'js-external-import'],
      [
        'malformed publication module',
        PUBLICATION_DATA_FILE,
        'export const PUBLICATION_STATE = "none";\n',
        'data-module-shape',
      ],
      [
        'mixed demo content',
        PUBLICATION_DATA_FILE,
        demoVariant((m) => (m.results = [entry(m)])),
        'publication-rejected|demo-not-synthetic-only',
      ],
      [
        'parse-valid mixed real and synthetic content',
        PUBLICATION_DATA_FILE,
        demoVariant((m) => {
          m.results = (JSON.parse(manifestText()) as { results: unknown[] }).results;
          (m.build as Record<string, unknown>).builtAt = BUILT_AT;
        }),
        'demo-not-synthetic-only',
      ],
      [
        'invalid demo authenticity',
        PUBLICATION_DATA_FILE,
        demoVariant(
          (m) => ((entry(m).gate as Record<string, unknown>).authenticity = 'BUILD_VERIFIED'),
        ),
        'publication-rejected|demo-not-synthetic-only',
      ],
    ];
    for (const [name, path, text, code] of cases) {
      const files = new Map(clean);
      files.set(path, text);
      let message = '';
      let findings: readonly { code: string }[] = [];
      try {
        prewriteScan(files);
      } catch (error) {
        message = (error as Error).message;
        findings = (error as { findings: readonly { code: string }[] }).findings;
      }
      assert.equal(message, 'output-scan-rejected', name);
      assert.ok(
        findings.some((f) => new RegExp(`^(?:${code})$`).test(f.code)),
        `${name}: ${JSON.stringify(findings)}`,
      );
    }
  });
});

test('pre-write: seeded sources that pass the builder checks are refused before any output exists', () => {
  withSandbox((parent) => {
    const root = inputCopy(parent);
    const app = join(root, 'dashboard', 'app.ts');
    const html = join(root, 'dashboard', 'index.html');
    const originalApp = readFileSync(app, 'utf8');
    const originalHtml = readFileSync(html, 'utf8');
    const cases: [string, () => void, string][] = [
      [
        'scanner-only forbidden API',
        () => writeFileSync(app, `${originalApp}\nexport const seeded = document.cookie;\n`),
        'js-forbidden-api',
      ],
      [
        'credential marker',
        () =>
          writeFileSync(
            app,
            `${originalApp}\nexport const seeded = 'QUALITY_VERDICT_GITHUB_TOKEN';\n`,
          ),
        'leak-credential',
      ],
      [
        'invalid relative require',
        () =>
          writeFileSync(app, `${originalApp}\nexport const seeded = require('./missing.js');\n`),
        'js-unresolved-import',
      ],
      [
        'external require',
        () => writeFileSync(app, `${originalApp}\nexport const seeded = require('node:fs');\n`),
        'js-external-import',
      ],
      [
        'CSP regression',
        () => writeFileSync(html, originalHtml.replace("object-src 'none'; ", '')),
        'csp-mismatch',
      ],
    ];
    for (const [index, [name, seed, code]] of cases.entries()) {
      seed();
      for (const mode of [[], ['--demo']]) {
        const name2 = `out-${String(index)}-${String(mode.length)}`;
        const r = copyBuild(root, [...mode, '--out', join(parent, name2)]);
        assert.equal(r.status, 1, name);
        assert.match(r.stderr.trim(), REFUSAL_LINE, name);
        assert.ok(r.stderr.includes(` ${code}=`), `${name}: ${r.stderr}`);
        assert.equal(r.stdout, '', name);
        assert.equal(readdirSync(parent).includes(name2), false, name);
        for (const secret of [
          parent,
          'QUALITY_VERDICT_GITHUB_TOKEN',
          'document.cookie',
          'node:fs',
        ]) {
          assert.equal(`${r.stdout}${r.stderr}`.includes(secret), false, `${name}: ${secret}`);
        }
      }
      writeFileSync(app, originalApp);
      writeFileSync(html, originalHtml);
    }
    // Earlier builder layers still refuse first, also before any output exists.
    writeFileSync(app, `${originalApp}\nexport const seeded = () => fetch('/x');\n`);
    const forbidden = copyBuild(root, ['--out', join(parent, 'out-builder')]);
    assert.equal(forbidden.stderr.trim(), 'dashboard build refused: forbidden-api');
    assert.equal(readdirSync(parent).includes('out-builder'), false);
    writeFileSync(app, originalApp);
    // The unmodified copy builds and both scans pass.
    const ok = copyBuild(root, ['--out', join(parent, 'out-ok')]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(scanBuildOutput(join(parent, 'out-ok')), { status: 'clean', files: 8 });
  });
});

/* Post-write rejection ----------------------------------------------- */

test('post-write: a scanner rejection fails without a success line and leaves the output untouched', () => {
  withSandbox((parent) => {
    const out = join(parent, 'out');
    let before: string[] = [];
    const r = inProcess(['--out', out], (dir) => {
      assert.equal(dir, out);
      before = fingerprint(dir);
      return { status: 'rejected', findings: [{ code: 'file-unstable', count: 1 }] };
    });
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'dashboard build refused: output-scan-rejected file-unstable=1');
    assert.equal(r.stdout, '');
    assert.deepEqual(filesUnder(out), EXPECTED_FILES);
    assert.deepEqual(fingerprint(out), before);
    for (const mode of [['--demo'], []]) {
      const o = join(parent, `out-${String(mode.length)}`);
      const again = inProcess([...mode, '--out', o], () => ({
        status: 'rejected',
        findings: [{ code: 'internal-error', count: 1 }],
      }));
      assert.equal(again.status, 1);
      assert.equal(again.stdout, '');
      assert.deepEqual(filesUnder(o), EXPECTED_FILES);
    }
  });
});

test('post-write: the real scanner rejection deletes no added, linked, sibling or substituted content', () => {
  withSandbox((parent) => {
    const outside = join(parent, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'outside data\n');
    const cases: [string, (dir: string) => void, (dir: string) => void][] = [
      [
        'added sentinel file',
        (dir) => writeFileSync(join(dir, 'dashboard', 'sentinel.txt'), 'sentinel\n'),
        (dir) =>
          assert.equal(readFileSync(join(dir, 'dashboard', 'sentinel.txt'), 'utf8'), 'sentinel\n'),
      ],
      [
        'sibling directory',
        (dir) => {
          mkdirSync(`${dir}-sibling`);
          writeFileSync(join(`${dir}-sibling`, 'keep.txt'), 'sibling\n');
          writeFileSync(join(dir, 'extra.txt'), 'x\n');
        },
        (dir) =>
          assert.equal(readFileSync(join(`${dir}-sibling`, 'keep.txt'), 'utf8'), 'sibling\n'),
      ],
      [
        'symbolic link',
        (dir) => symlinkSync(outside, join(dir, 'link')),
        (dir) => {
          assert.equal(readlinkSync(join(dir, 'link')), outside);
          assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside data\n');
        },
      ],
      [
        'hard link',
        (dir) => linkSync(join(outside, 'keep.txt'), join(dir, 'hard.txt')),
        (dir) => {
          assert.equal(statSync(join(outside, 'keep.txt')).nlink, 2);
          assert.equal(readFileSync(join(dir, 'hard.txt'), 'utf8'), 'outside data\n');
        },
      ],
      [
        'path substitution',
        (dir) => {
          renameSync(dir, `${dir}-moved`);
          mkdirSync(dir);
          writeFileSync(join(dir, 'unrelated.txt'), 'unrelated\n');
        },
        (dir) => {
          assert.deepEqual(readdirSync(dir), ['unrelated.txt']);
          assert.equal(readFileSync(join(dir, 'unrelated.txt'), 'utf8'), 'unrelated\n');
          assert.deepEqual(filesUnder(`${dir}-moved`), EXPECTED_FILES);
        },
      ],
    ];
    for (const [index, [name, interfere, verify]] of cases.entries()) {
      const out = join(parent, `out-${String(index)}`);
      let written: string[] = [];
      let scanned: ScanResult | undefined;
      const r = inProcess(['--out', out], (dir) => {
        written = fingerprint(dir);
        interfere(dir);
        scanned = scanBuildOutput(dir);
        return scanned;
      });
      assert.equal(scanned?.status, 'rejected', name);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, REFUSAL_LINE, name);
      assert.equal(r.stdout, '', name);
      assert.equal(r.stderr.includes(parent), false, name);
      verify(out);
      const kept = name === 'path substitution' ? `${out}-moved` : out;
      assert.deepEqual(fingerprint(kept), written, name);
      assert.ok(scanCodes(scanned).length > 0, name);
    }
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside data\n');
  });
});

test('post-write: the default read-only scanner rejects an unreadable written output in place', () => {
  withSandbox((parent) => {
    const out = join(parent, 'out-unreadable');
    // umask 0400: every file and directory the build creates lacks owner read
    // permission, so the writes succeed but the real post-write scan cannot read them.
    const r = spawnSync(
      '/bin/sh',
      [
        '-c',
        'umask 0400 && exec "$0" --no-warnings "$1" --out "$2"',
        process.execPath,
        BUILD_SCRIPT,
        out,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
    );
    try {
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr.trim(), REFUSAL_LINE);
      assert.ok(r.stderr.includes(' file-unreadable='), r.stderr);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr.includes(parent), false);
      assert.equal(lstatSync(out).isDirectory(), true);
    } finally {
      for (const dir of [
        out,
        join(out, 'dashboard'),
        join(out, 'src'),
        join(out, 'src', 'reporting'),
      ]) {
        chmodSync(dir, 0o755);
      }
    }
    assert.deepEqual(filesUnder(out), EXPECTED_FILES);
    for (const path of EXPECTED_FILES) {
      assert.equal(statSync(join(out, path)).mode & 0o777, 0o244, path);
    }
  });
});

/* Output collisions -------------------------------------------------- */

test('collisions: existing targets, missing parents and relative paths are refused unchanged', () => {
  withSandbox((parent) => {
    const file = join(parent, 'existing-file');
    writeFileSync(file, 'keep\n');
    const dir = join(parent, 'existing-dir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'keep\n');
    const link = join(parent, 'existing-link');
    symlinkSync(dir, link);
    const dangling = join(parent, 'dangling-link');
    symlinkSync(join(parent, 'nowhere'), dangling);
    const cases: [string, string][] = [
      [file, 'output-exists'],
      [dir, 'output-exists'],
      [link, 'output-exists'],
      [dangling, 'output-exists'],
      [join(parent, 'missing', 'out'), 'output-parent-missing'],
      ['relative/out', 'output-not-absolute'],
    ];
    for (const [target, code] of cases) {
      const r = inProcess(['--out', target]);
      assert.equal(r.status, 1, target);
      assert.equal(r.stderr, `dashboard build refused: ${code}`, target);
      assert.equal(r.stdout, '', target);
    }
    assert.equal(readFileSync(file, 'utf8'), 'keep\n');
    assert.deepEqual(readdirSync(dir), ['keep.txt']);
    assert.equal(readlinkSync(link), dir);
    assert.equal(readlinkSync(dangling), join(parent, 'nowhere'));
    assert.equal(lstatSync(join(parent, 'nowhere'), { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(join(parent, 'missing'), { throwIfNoEntry: false }), undefined);
  });
});

test('collisions: concurrent builds claim one output directory exactly once', async () => {
  const parent = sandbox();
  try {
    for (let round = 0; round < 3; round += 1) {
      const out = join(parent, `shared-${String(round)}`);
      const runs = await Promise.all(
        [0, 1].map(
          () =>
            new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
              const child = spawn(process.execPath, ['--no-warnings', BUILD_SCRIPT, '--out', out], {
                cwd: REPO_ROOT,
              });
              let stdout = '';
              let stderr = '';
              child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
              child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
              child.on('close', (status) => done({ status, stdout, stderr }));
            }),
        ),
      );
      const winners = runs.filter((r) => r.status === 0);
      const losers = runs.filter((r) => r.status !== 0);
      assert.equal(winners.length, 1, JSON.stringify(runs));
      assert.equal(losers.length, 1);
      assert.match(
        losers[0]?.stderr.trim() ?? '',
        /^dashboard build refused: output-(?:exists|create-failed)$/,
      );
      assert.equal(losers[0]?.stdout, '');
      assert.deepEqual(filesUnder(out), EXPECTED_FILES);
      assert.deepEqual(scanBuildOutput(out), { status: 'clean', files: 8 });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

/* Three build modes -------------------------------------------------- */

test('modes: none, demo and embedded builds pass both scans with exactly eight files', () => {
  withSandbox((parent) => {
    // none and demo: a copy with no .git and a minimal environment (no git, token or publisher).
    const nogit = join(parent, 'nogit');
    mkdirSync(nogit);
    const root = inputCopy(nogit);
    for (const [mode, line] of [
      [[], 'publication: none'],
      [['--demo'], 'publication: demo (SYNTHETIC DEMONSTRATION DATA, not real CI results)'],
    ] as const) {
      const out = join(parent, `out-${String(mode.length)}`);
      const r = copyBuild(root, [...mode, '--out', out]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.split('\n')[1], line);
      assert.deepEqual(filesUnder(out), EXPECTED_FILES);
      assert.deepEqual(scanBuildOutput(out), { status: 'clean', files: 8 });
    }
    // embedded: synthetic generations bound to a temporary git checkout.
    const c = checkout(parent);
    const generations = join(parent, 'generations');
    mkdirSync(generations, { mode: 0o700 });
    chmodSync(generations, 0o700);
    const g = generation(generations, { manifest: manifestText(c.head) });
    const out = join(parent, 'out-embedded');
    const r = build(c, ['--out', out, '--publication', g.dir, '--publication-sha256', g.sha]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(filesUnder(out), EXPECTED_FILES);
    assert.deepEqual(scanBuildOutput(out), { status: 'clean', files: 8 });
    assert.equal(
      readFileSync(join(out, PUBLICATION_DATA_FILE), 'utf8'),
      publicationDataModule('embedded', g.text),
    );
  });
});

test('trust boundary: embedded still requires the pin, the committed policy and HEAD', () => {
  withSandbox((parent) => {
    const c = checkout(parent);
    const generations = join(parent, 'generations');
    mkdirSync(generations, { mode: 0o700 });
    chmodSync(generations, 0o700);
    const attempt = (name: string, text: string, pin?: string) => {
      const builtAt = (JSON.parse(text) as { build: { builtAt: string } }).build.builtAt;
      const g = generation(generations, {
        manifest: text,
        name: generationName(builtAt, sha256(text)),
        record: record(text, { builtAt }),
      });
      const out = join(parent, `out-${name}`);
      const r = build(c, [
        '--out',
        out,
        '--publication',
        g.dir,
        '--publication-sha256',
        pin ?? g.sha,
      ]);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr.trim(), /^dashboard build refused: publication-[a-z0-9-]+$/, name);
      assert.equal(readdirSync(parent).includes(`out-${name}`), false, name);
      return r.stderr.trim();
    };
    // The synthetic demonstration manifest is never accepted as an embedded publication.
    const demo = attempt('demo', demoText());
    // A manifest for another commit, the fictional demo policy, or a wrong pin.
    const ancestor = attempt('ancestor', manifestText(OTHER_COMMIT));
    const policy = attempt(
      'policy',
      manifestText(c.head, (JSON.parse(demoText()) as { build: { policy: object } }).build.policy),
    );
    const pin = attempt('pin', manifestText(c.head), 'b'.repeat(64));
    assert.deepEqual(
      [demo, ancestor, policy, pin],
      [
        'dashboard build refused: publication-policy-mismatch',
        'dashboard build refused: publication-source-commit-mismatch',
        'dashboard build refused: publication-policy-mismatch',
        'dashboard build refused: publication-manifest-sha256-mismatch',
      ],
    );
    for (const line of [demo, ancestor, policy, pin]) {
      assert.equal(line.includes('output-scan-rejected'), false);
    }
  });
});
