/**
 * Builds the static quality dashboard (ADR-0009, M8C-2A; ADR-0011 P3-3).
 *
 *   node scripts/build-dashboard.ts                     # new private temp directory
 *   node scripts/build-dashboard.ts --out <absolute>    # new directory outside the repo
 *   node scripts/build-dashboard.ts [--out <absolute>] \
 *     --publication <absolute generation directory> \
 *     --publication-sha256 <64 lowercase hex>           # embed one verified publication
 *   node scripts/build-dashboard.ts --demo [--out <absolute>]  # synthetic demonstration
 *
 * Compiles the browser entry point and the four pure reporting modules it
 * imports with the installed TypeScript compiler (`transpileModule`, ES2022
 * modules, `.ts` import extensions rewritten to `.js`), copies the HTML and
 * CSS, and writes everything to an output directory that is created fresh
 * and must lie outside the repository. Nothing in the repository is written,
 * and no report or summary is read or copied: the dashboard loads a summary
 * only when a user picks one in the browser.
 *
 * Output layout mirrors the source tree so relative imports stay valid:
 *
 *   <out>/dashboard/index.html, styles.css, app.js, publication-data.js
 *   <out>/src/reporting/dashboard-model.js, quality-summary.js,
 *                       publication-view.js, verdict.js
 *
 * Serve <out> from a loopback static server and open /dashboard/ (browsers
 * refuse ES modules over file://). Hosting and deployment are out of scope.
 *
 * Publication data (ADR-0011 P3-3). Every build writes
 * `dashboard/publication-data.js`, a generated ES module with exactly two
 * exports: `PUBLICATION_STATE` (`'none'`, `'embedded'` or `'demo'`) and
 * `PUBLICATION_TEXT` (the canonical manifest text, or `''`); `app.js`
 * imports it and renders it with the P3-2 browser reader (P3-4). With `--publication`, the build first requires:
 *
 * - both publication options, each exactly once; nothing is discovered;
 * - this checkout's HEAD, read by the P2 git probe (no shell, fixed minimal
 *   environment, global and system configuration ignored), and a clean tree
 *   including untracked files;
 * - the merged P3-2 Node reader to accept the generation with the supplied
 *   SHA-256 pin and HEAD as the expected source commit. The manifest's (and
 *   the build record's) `sourceCommit` must equal HEAD exactly: the manifest
 *   is never its own authority and an ancestor commit is not accepted;
 * - HEAD and the clean tree to be unchanged after reading.
 *
 * Only the manifest text is embedded: never the build record, allow-list or
 * lockfile hashes, paths, tokens, raw reports or signed URLs. The generated
 * module is checked for its exact shape, an ASCII-only string literal that
 * decodes back to the verified text, the P1 output scan, the code
 * prohibitions below and additional leakage markers. Presence of a
 * publication never changes the page, its CSP or the picker.
 *
 * Demonstration (ADR-0011 P4). `--demo` is mutually exclusive with both
 * publication options. It embeds the deterministic synthetic-only manifest
 * from `src/reporting/demo-publication.ts` as `PUBLICATION_STATE = 'demo'`.
 * Its build metadata is illustrative, not provenance (a 40-zero source
 * commit that is never HEAD). The demo path never runs the publisher, the
 * git probe or the publication reader, needs no token and reads no real
 * generation; the same compilation and output checks apply.
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

import { outputScan } from '../src/reporting/publication-manifest.ts';
import { nodeGit, nodePublisherFs, type GitProbe } from '../src/reporting/publication-publisher.ts';
import { readPublicationGeneration, type ReaderCode } from '../src/reporting/publication-reader.ts';
import { parsePublication } from '../src/reporting/publication-view.ts';
import { demoPublicationText, isSyntheticOnlyDemo } from '../src/reporting/demo-publication.ts';

const PACKAGE_NAME = 'playwright-typescript-automation-framework';

/** Fixed inputs; nothing else is read. */
const MODULES = [
  'dashboard/app.ts',
  'src/reporting/dashboard-model.ts',
  'src/reporting/quality-summary.ts',
  'src/reporting/publication-view.ts',
  'src/reporting/verdict.ts',
] as const;
const ASSETS = ['dashboard/index.html', 'dashboard/styles.css'] as const;
/** The generated publication data module (never compiled from a source file). */
export const PUBLICATION_DATA_FILE = 'dashboard/publication-data.js';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

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
  | 'source-commit-unknown'
  | 'dirty-tree'
  | 'source-changed'
  | `publication-${ReaderCode}`
  | 'publication-data-rejected'
  | 'demo-generation-failed'
  | 'demo-not-synthetic-only'
  | 'output-inside-publication'
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
function buildFiles(root: string, publicationModule: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of MODULES) {
    files.set(path.replace(/\.ts$/, '.js'), compile(readSource(root, path), path));
  }
  // The generated data module is part of the import graph (app.js imports it).
  files.set(PUBLICATION_DATA_FILE, publicationModule);
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

/* ------------------------------------------------------------------ *
 * Publication data module (ADR-0011 P3-3)
 * ------------------------------------------------------------------ */

export type PublicationState = 'none' | 'embedded' | 'demo';

/**
 * A JavaScript string literal that is pure ASCII: JSON string syntax with
 * every character outside printable ASCII, and `<`, `>`, `&`, `'` and the
 * backtick, written as a `\uXXXX` escape. U+2028 and U+2029 (line
 * terminators inside older JavaScript string literals) therefore never
 * appear raw, and the literal cannot close a surrounding HTML or template
 * context.
 */
export function safeStringLiteral(text: string): string {
  return JSON.stringify(text).replace(
    /[^\x20-\x7e]|[<>&'`]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** The exact generated module. Nothing else is ever written to it. */
export function publicationDataModule(state: PublicationState, text: string): string {
  return [
    '// Generated by scripts/build-dashboard.ts (ADR-0011 P3-3). Data only; do not edit.',
    `export const PUBLICATION_STATE = '${state}';`,
    `export const PUBLICATION_TEXT = ${safeStringLiteral(text)};`,
    '',
  ].join('\n');
}

const MODULE_SHAPE =
  /^\/\/ Generated by scripts\/build-dashboard\.ts \(ADR-0011 P3-3\)\. Data only; do not edit\.\nexport const PUBLICATION_STATE = '(none|embedded|demo)';\nexport const PUBLICATION_TEXT = ("(?:[^"\\\n]|\\["\\/bfnrt]|\\u[0-9a-f]{4})*");\n$/;

/** Markers that must never appear in published data, beyond the P1 output scan. */
const DATA_FORBIDDEN = [
  /authorization/i,
  /\bbearer\b/i,
  /x-amz-|x-ms-|sv=|sp=|sig=|se=|skoid=/i,
  /blob\.core\.windows\.net|amazonaws\.com|storage\.googleapis\.com|productionresultssa/i,
  /ghp_|gho_|ghs_|ghu_|ghr_|github_pat_/i,
  /\/users\/|\/home\/|\/private\/|\/var\/|\/tmp\/|[a-z]:\\\\/i,
  /qualitypublication|qualityverdictevidence|allowlist|allowListSha256|packageLockSha256/i,
  /"(?:stdout|stderr|attachments|errors|suites|specs|steps|title|titlePath)"/,
  /canary/i,
  /<\/?script|javascript:|data:text|\bon[a-z]+=/i,
];

/**
 * Checks a generated module before anything is written. Returns false unless
 * it has the exact shape, its literal decodes to `text`, and neither the
 * module nor the decoded text contains a code-execution or leakage marker.
 * For `embedded`, the text must also pass the browser-safe strict reader.
 */
export function publicationDataAcceptable(
  module: string,
  state: PublicationState,
  text: string,
): boolean {
  const match = MODULE_SHAPE.exec(module);
  if (match === null || match[1] !== state || match[2] === undefined) return false;
  let decoded: unknown;
  try {
    decoded = JSON.parse(match[2]) as unknown;
  } catch {
    return false;
  }
  if (decoded !== text) return false;
  if (state === 'none') {
    if (text !== '') return false;
  } else {
    const parsed = parsePublication(text);
    if (parsed.state !== 'valid') return false;
    // demo: the ADR-0011 P4 synthetic-only policy as well.
    if (state === 'demo' && !isSyntheticOnlyDemo(parsed.manifest)) return false;
  }
  const scanned = [module, text];
  return scanned.every(
    (t) =>
      outputScan(t.replace(MODULE_HEADER, '')) &&
      !FORBIDDEN.some((pattern) => pattern.test(t)) &&
      !DATA_FORBIDDEN.some((pattern) => pattern.test(t)),
  );
}

/** The fixed header names the generator script; excluded from the path-marker scan. */
const MODULE_HEADER =
  '// Generated by scripts/build-dashboard.ts (ADR-0011 P3-3). Data only; do not edit.';

export interface PublicationRequest {
  readonly generationDir: string;
  readonly sha256: string;
}

/**
 * Establishes this checkout's identity, reads the generation with the merged
 * P3-2 reader bound to that identity, and returns the manifest text only.
 */
export function verifiedPublicationText(
  root: string,
  request: PublicationRequest,
  git: GitProbe,
): string {
  const head = git.head();
  if (head === undefined || !SHA.test(head)) return refuse('source-commit-unknown');
  if (git.status() !== '') return refuse('dirty-tree');
  const result = readPublicationGeneration(
    {
      generationDir: request.generationDir,
      expectedManifestSha256: request.sha256,
      expectedSourceCommit: head,
    },
    { fs: nodePublisherFs, repoRoot: root },
  );
  if (result.status !== 'ok') return refuse(`publication-${result.code}`);
  // The checkout must still be the one the publication was bound to.
  if (git.head() !== head || git.status() !== '') return refuse('source-changed');
  return result.manifestText;
}

/* ------------------------------------------------------------------ *
 * Command line
 * ------------------------------------------------------------------ */

const OPTIONS = ['--out', '--publication', '--publication-sha256'] as const;
/** A flag without a value: the synthetic demonstration build (ADR-0011 P4). */
const DEMO_FLAG = '--demo';
type Option = (typeof OPTIONS)[number];

export type BuildArgs =
  | {
      readonly ok: true;
      readonly out: string | undefined;
      readonly publication: PublicationRequest | undefined;
      readonly demo: boolean;
    }
  | { readonly ok: false };

/**
 * Each option at most once, each with a non-empty value; no positional
 * arguments. `--publication` and `--publication-sha256` are required
 * together; the pin must be 64 lowercase hex and the directory absolute.
 */
export function parseBuildArgs(argv: readonly string[]): BuildArgs {
  const values = new Map<Option, string>();
  let demo = false;
  for (let i = 0; i < argv.length;) {
    const name = argv[i];
    if (name === DEMO_FLAG) {
      if (demo) return { ok: false };
      demo = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (!(OPTIONS as readonly (string | undefined)[]).includes(name)) return { ok: false };
    const option = name as Option;
    if (values.has(option) || value === undefined || value === '' || value.includes('\0')) {
      return { ok: false };
    }
    values.set(option, value);
    i += 2;
  }
  const dir = values.get('--publication');
  const sha = values.get('--publication-sha256');
  // --demo is mutually exclusive with every publication option.
  if (demo && (dir !== undefined || sha !== undefined)) return { ok: false };
  if ((dir === undefined) !== (sha === undefined)) return { ok: false };
  if (dir !== undefined && sha !== undefined) {
    if (!isAbsolute(dir) || !SHA256_HEX.test(sha)) return { ok: false };
    return {
      ok: true,
      out: values.get('--out'),
      publication: { generationDir: dir, sha256: sha },
      demo: false,
    };
  }
  return { ok: true, out: values.get('--out'), publication: undefined, demo };
}

const USAGE =
  'usage: node scripts/build-dashboard.ts [--out <absolute-new-directory>] ' +
  '[--publication <absolute-generation-directory> --publication-sha256 <64-hex> | --demo]';

function main(): number {
  const args = parseBuildArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(USAGE);
    return 2;
  }
  try {
    const root = repositoryRoot(process.argv[1]);
    let state: PublicationState = 'none';
    let text = '';
    if (args.publication !== undefined) {
      text = verifiedPublicationText(root, args.publication, nodeGit(root));
      state = 'embedded';
    } else if (args.demo) {
      // Synthetic demonstration (ADR-0011 P4): in-repository fixtures only. No
      // publisher, GitHub, token, git probe or publication reader.
      const demo = demoPublicationText();
      if (demo.status !== 'ok') refuse('demo-generation-failed');
      else {
        if (!isSyntheticOnlyDemo(demo.manifest)) refuse('demo-not-synthetic-only');
        text = demo.text;
        state = 'demo';
      }
    }
    const module = publicationDataModule(state, text);
    if (!publicationDataAcceptable(module, state, text)) refuse('publication-data-rejected');
    const files = buildFiles(root, module);
    if (args.publication !== undefined && args.out !== undefined) {
      // Never write the dashboard into the generation it embeds.
      const generation = realpathSync(args.publication.generationDir);
      if (isWithin(resolve(args.out), generation)) refuse('output-inside-publication');
    }
    const out = createOutput(root, args.out);
    if (args.publication !== undefined) {
      const generation = realpathSync(args.publication.generationDir);
      if (isWithin(out, generation) || isWithin(realpathSync(out), generation)) {
        rmSync(out, { recursive: true, force: true });
        refuse('output-inside-publication');
      }
    }
    writeFiles(out, files);
    console.log(`dashboard built: ${out}`);
    console.log(
      state === 'embedded'
        ? `publication: embedded manifest-sha256=${args.publication?.sha256 ?? ''}`
        : state === 'demo'
          ? 'publication: demo (SYNTHETIC DEMONSTRATION DATA, not real CI results)'
          : 'publication: none',
    );
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

// Run only as the entry script; unit tests import the pure helpers above.
if (basename(process.argv[1] ?? '') === 'build-dashboard.ts') {
  process.exitCode = main();
}
