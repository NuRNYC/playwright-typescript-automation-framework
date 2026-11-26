/**
 * Builds the static quality dashboard (ADR-0009, M8C-2A).
 *
 *   node scripts/build-dashboard.ts                     # new private temp directory
 *   node scripts/build-dashboard.ts --out <absolute>    # new directory outside the repo
 *
 * Compiles the browser entry point and the two pure reporting modules it
 * imports with the installed TypeScript compiler (`transpileModule`, ES2022
 * modules, `.ts` import extensions rewritten to `.js`), copies the HTML and
 * CSS, and writes everything to an output directory that is created fresh
 * and must lie outside the repository. Nothing in the repository is written,
 * and no report or summary is read or copied: the dashboard loads a summary
 * only when a user picks one in the browser.
 *
 * Output layout mirrors the source tree so relative imports stay valid:
 *
 *   <out>/dashboard/index.html, styles.css, app.js
 *   <out>/src/reporting/dashboard-model.js, quality-summary.js
 *
 * Serve <out> from a loopback static server and open /dashboard/ (browsers
 * refuse ES modules over file://). Hosting and deployment are out of scope.
 *
 * Every refusal prints one fixed line with no paths, file content or error
 * text. Exit codes: 0 built, 1 refused or failed (nothing left behind),
 * 2 usage error.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import ts from 'typescript';

const PACKAGE_NAME = 'playwright-typescript-automation-framework';

/** Fixed inputs; nothing else is read. */
const MODULES = [
  'dashboard/app.ts',
  'src/reporting/dashboard-model.ts',
  'src/reporting/quality-summary.ts',
] as const;
const ASSETS = ['dashboard/index.html', 'dashboard/styles.css'] as const;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** APIs the compiled page must never contain (comments are stripped first). */
const FORBIDDEN = [
  /\binnerHTML\b/,
  /\bouterHTML\b/,
  /\binsertAdjacentHTML\b/,
  /\bdocument\.write/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bFunction\s*\(/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bsendBeacon\b/,
  /\bimport\s*\(/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /https?:\/\//,
];

type Refusal =
  | 'repository-not-found'
  | 'output-not-absolute'
  | 'output-parent-missing'
  | 'output-inside-repository'
  | 'output-exists'
  | 'output-create-failed'
  | 'source-unreadable'
  | 'compile-failed'
  | 'unresolved-import'
  | 'forbidden-api'
  | 'html-contract'
  | 'write-failed';

class BuildRefusal extends Error {
  readonly code: Refusal;
  constructor(code: Refusal) {
    super(code);
    this.code = code;
  }
}

function refuse(code: Refusal): never {
  throw new BuildRefusal(code);
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The repository is the parent of this script's directory, checked by name. */
function repositoryRoot(scriptPath: string | undefined): string {
  try {
    if (scriptPath === undefined) {
      return refuse('repository-not-found');
    }
    const root = resolve(dirname(realpathSync(scriptPath)), '..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown;
    if (
      typeof pkg !== 'object' ||
      pkg === null ||
      (pkg as { name?: unknown }).name !== PACKAGE_NAME
    ) {
      return refuse('repository-not-found');
    }
    return realpathSync(root);
  } catch (error) {
    if (error instanceof BuildRefusal) throw error;
    return refuse('repository-not-found');
  }
}

function readSource(root: string, path: string): string {
  try {
    const full = join(root, path);
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES || !isWithin(realpathSync(full), root)) {
      return refuse('source-unreadable');
    }
    return readFileSync(full, 'utf8');
  } catch (error) {
    if (error instanceof BuildRefusal) throw error;
    return refuse('source-unreadable');
  }
}

function compile(source: string, fileName: string): string {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      rewriteRelativeImportExtensions: true,
      isolatedModules: true,
      removeComments: true,
      sourceMap: false,
      inlineSourceMap: false,
      importHelpers: false,
    },
  });
  if ((result.diagnostics ?? []).length > 0) {
    return refuse('compile-failed');
  }
  return result.outputText;
}

/** Compiles and checks everything in memory before any directory exists. */
function buildFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of MODULES) {
    files.set(path.replace(/\.ts$/, '.js'), compile(readSource(root, path), path));
  }
  for (const [path, text] of files) {
    if (FORBIDDEN.some((pattern) => pattern.test(text))) {
      return refuse('forbidden-api');
    }
    for (const imported of ts.preProcessFile(text, true, false).importedFiles) {
      const specifier = imported.fileName;
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        return refuse('unresolved-import');
      }
      if (target.startsWith('..') || !files.has(target)) {
        return refuse('unresolved-import');
      }
    }
  }
  for (const path of ASSETS) {
    files.set(path, readSource(root, path));
  }
  const html = files.get('dashboard/index.html') ?? '';
  const required = [
    'http-equiv="Content-Security-Policy"',
    "script-src 'self'",
    "connect-src 'none'",
    '<script type="module" src="app.js"></script>',
    '<link rel="stylesheet" href="styles.css" />',
  ];
  if (!required.every((fragment) => html.includes(fragment)) || /\son[a-z]+\s*=/i.test(html)) {
    return refuse('html-contract');
  }
  return files;
}

/** Creates a new, empty output directory outside the repository. */
function createOutput(root: string, requested: string | undefined): string {
  if (requested === undefined) {
    const base = realpathSync(tmpdir());
    if (isWithin(base, root)) {
      return refuse('output-inside-repository');
    }
    try {
      return mkdtempSync(join(base, 'quality-dashboard-'));
    } catch {
      return refuse('output-create-failed');
    }
  }
  if (!isAbsolute(requested) || requested.includes('\0')) {
    return refuse('output-not-absolute');
  }
  const resolved = resolve(requested);
  const name = basename(resolved);
  if (name === '' || name === '.' || name === '..') {
    return refuse('output-not-absolute');
  }
  let parent: string;
  try {
    parent = realpathSync(dirname(resolved));
    if (!lstatSync(parent).isDirectory()) {
      return refuse('output-parent-missing');
    }
  } catch (error) {
    if (error instanceof BuildRefusal) throw error;
    return refuse('output-parent-missing');
  }
  const target = join(parent, name);
  if (isWithin(target, root) || isWithin(root, target)) {
    return refuse('output-inside-repository');
  }
  try {
    lstatSync(target);
    return refuse('output-exists');
  } catch (error) {
    if (error instanceof BuildRefusal) throw error;
  }
  try {
    mkdirSync(target, { mode: 0o755 });
  } catch {
    return refuse('output-create-failed');
  }
  return target;
}

function writeFiles(out: string, files: ReadonlyMap<string, string>): void {
  try {
    for (const dir of ['dashboard', 'src', 'src/reporting']) {
      mkdirSync(join(out, dir), { mode: 0o755 });
    }
    for (const [path, text] of files) {
      writeFileSync(join(out, path), text, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    }
  } catch {
    // The directory was created by this run and holds only this run's files.
    rmSync(out, { recursive: true, force: true });
    refuse('write-failed');
  }
}

function parseArgs(argv: readonly string[]): { ok: true; out: string | undefined } | { ok: false } {
  if (argv.length === 0) {
    return { ok: true, out: undefined };
  }
  if (argv.length === 2 && argv[0] === '--out' && argv[1] !== undefined && argv[1] !== '') {
    return { ok: true, out: argv[1] };
  }
  return { ok: false };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error('usage: node scripts/build-dashboard.ts [--out <absolute-new-directory>]');
    return 2;
  }
  try {
    const root = repositoryRoot(process.argv[1]);
    const files = buildFiles(root);
    const out = createOutput(root, args.out);
    writeFiles(out, files);
    console.log(`dashboard built: ${out}`);
    console.log(
      `serve it over loopback, for example: python3 -m http.server 8080 --bind 127.0.0.1 --directory "${out}"`,
    );
    console.log('then open http://127.0.0.1:8080/dashboard/');
    return 0;
  } catch (error) {
    const code = error instanceof BuildRefusal ? error.code : 'internal-error';
    console.error(`dashboard build refused: ${code}`);
    return 1;
  }
}

process.exitCode = main();
