/**
 * Saved authentication state: policy, validation and the one file write.
 *
 * Sauce Demo authenticates with a single client-side cookie. M3b discovery
 * verified that cookie alone restores a session in Chromium, Firefox and
 * WebKit, and that everything else in browser storage (the cart, third-party
 * telemetry identifiers) is either unnecessary or harmful to carry between
 * tests. See docs/adr/0003-authentication-storage-state.md.
 *
 * The validation below is deliberately pure: `checkSavedSession` takes the
 * parsed state and the current time as parameters, so `session.test.ts` can
 * exercise every rule with object literals and a fixed clock. Only
 * `writeSessionState` touches the file system.
 *
 * Kept free of `@/` imports so Node's type-stripping test runner can load it
 * directly (`import ... from './session.ts'`), as ADR-0002 describes.
 */
import { lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Name of the Playwright project that creates saved state. */
export const SETUP_PROJECT = 'setup';

/**
 * Roles that can be authenticated, and where each role's state is written.
 * Paths are relative to the directory containing `playwright.config.ts`.
 * The directory is Git-ignored, and the state is regenerated on every run.
 */
export const SESSION_STATE_FILES = {
  standard: 'playwright/.auth/standard.json',
} as const satisfies Record<string, string>;

export type SessionRole = keyof typeof SESSION_STATE_FILES;

/**
 * The only session this framework will save or restore: verified against
 * Sauce Demo's actual behaviour, not assumed. Anything else fails closed.
 */
export const SAUCEDEMO_SESSION = {
  target: 'saucedemo',
  hostname: 'www.saucedemo.com',
  cookieName: 'session-username',
  cookiePath: '/',
} as const;

/** A session that expires within this many seconds is treated as expired. */
export const EXPIRY_MARGIN_SECONDS = 60;

/** The cookie fields this module relies on; Playwright's own type is wider. */
export interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: number;
}

/** The exact shape written to disk: one cookie, no origins. */
export interface SavedSession {
  readonly cookies: readonly SessionCookie[];
  readonly origins: readonly [];
}

/**
 * Thrown for any unusable session. Messages name the rule that failed and
 * never include a cookie value, so they are safe in logs and reports.
 */
export class SessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStateError';
  }
}

function fail(message: string): never {
  throw new SessionStateError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fail closed unless the run targets the verified Sauce Demo hostname.
 * Checks the hostname as well as the target name, because `BASE_URL` may
 * override the registry URL while `APP_TARGET` stays `saucedemo`.
 */
export function assertSupportedTarget(target: string, baseURL: string): void {
  if (target !== SAUCEDEMO_SESSION.target) {
    fail(
      `Saved authentication is verified only for APP_TARGET=${SAUCEDEMO_SESSION.target}; ` +
        `refusing to authenticate against "${target}".`,
    );
  }
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname;
  } catch {
    fail('Saved authentication requires a valid base URL.');
  }
  if (hostname !== SAUCEDEMO_SESSION.hostname) {
    fail(
      `Saved authentication is verified only for ${SAUCEDEMO_SESSION.hostname}; ` +
        `the base URL points elsewhere.`,
    );
  }
}

/** Keep only the session cookie; everything else in the browser is dropped. */
export function selectSessionCookies(cookies: readonly SessionCookie[]): SessionCookie[] {
  return cookies.filter(
    (cookie) =>
      cookie.name === SAUCEDEMO_SESSION.cookieName && cookie.domain === SAUCEDEMO_SESSION.hostname,
  );
}

function parseCookie(value: unknown): SessionCookie {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.value !== 'string' ||
    typeof value.domain !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.expires !== 'number'
  ) {
    fail('Saved session has a malformed cookie entry.');
  }
  return {
    name: value.name,
    value: value.value,
    domain: value.domain,
    path: value.path,
    expires: value.expires,
  };
}

/**
 * Validate a parsed state file against the Sauce Demo session policy.
 *
 * @param state      Parsed JSON; `unknown` because it comes from disk.
 * @param nowSeconds Current time in Unix seconds. Injected, never read here.
 * @returns The state, narrowed to `SavedSession`.
 */
export function checkSavedSession(state: unknown, nowSeconds: number): SavedSession {
  if (!isRecord(state) || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    fail('Saved session is not a valid storage state (expected cookies and origins arrays).');
  }
  if (state.origins.length > 0) {
    fail('Saved session must not contain origin storage (localStorage is never saved).');
  }

  const cookies = state.cookies.map(parseCookie);
  if (cookies.length !== 1) {
    fail(`Saved session must contain exactly one cookie; found ${cookies.length}.`);
  }
  const [cookie] = cookies;
  if (cookie === undefined || cookie.name !== SAUCEDEMO_SESSION.cookieName) {
    fail(`Saved session must contain only the "${SAUCEDEMO_SESSION.cookieName}" cookie.`);
  }
  if (
    cookie.domain !== SAUCEDEMO_SESSION.hostname ||
    cookie.path !== SAUCEDEMO_SESSION.cookiePath
  ) {
    fail(
      `Saved session cookie must be scoped to ${SAUCEDEMO_SESSION.hostname}` +
        `${SAUCEDEMO_SESSION.cookiePath}.`,
    );
  }
  // -1 marks a browser-session cookie with no expiry time. Sauce Demo always
  // sets an expiry, so its absence means the state did not come from setup.
  if (cookie.expires <= 0) {
    fail('Saved session cookie has no expiry time; regenerate it with the setup project.');
  }
  if (cookie.expires - nowSeconds <= EXPIRY_MARGIN_SECONDS) {
    fail(
      'Saved session has expired or expires within ' +
        `${EXPIRY_MARGIN_SECONDS}s. Run the setup project again ` +
        '(do not pass --no-deps).',
    );
  }

  return { cookies: [cookie], origins: [] };
}

/**
 * Absolute path of a role's state file, resolved against the directory of
 * the Playwright config (`testInfo.config.configFile`), so the result does
 * not depend on the directory the runner was started from.
 */
export function sessionStatePath(role: SessionRole, configFile: string | undefined): string {
  const rootDir = configFile === undefined ? process.cwd() : dirname(configFile);
  return resolve(rootDir, SESSION_STATE_FILES[role]);
}

/**
 * Write a validated session. Refuses to replace anything that is not a
 * regular file (a symlink or directory at the path is never followed or
 * overwritten), and writes via a temporary file plus rename so a reader never
 * sees a half-written state.
 */
export function writeSessionState(filePath: string, session: SavedSession): void {
  try {
    const existing = lstatSync(filePath);
    if (!existing.isFile()) {
      fail('Refusing to overwrite a non-regular file at the saved-session path.');
    }
  } catch (error) {
    // ENOENT means nothing is there yet: the normal first-run case. Anything
    // else (including the refusal above) propagates.
    if (!(isRecord(error) && error.code === 'ENOENT')) {
      throw error;
    }
  }
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(session), { mode: 0o600 });
  renameSync(temporary, filePath);
}
