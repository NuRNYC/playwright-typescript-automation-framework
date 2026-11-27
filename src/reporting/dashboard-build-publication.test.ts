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
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
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
import { scanBuildOutput } from './build-output-scanner.ts';
import {
  PUBLICATION_DATA_FILE,
  parseBuildArgs,
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
