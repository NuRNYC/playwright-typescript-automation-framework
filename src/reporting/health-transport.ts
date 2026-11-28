/**
 * Live, read-only `HealthEvidenceTransport` (ADR-0013, Phase C5B).
 *
 *   createHealthTransport(config) -> HealthEvidenceTransport
 *
 * Composes the ADR-0010 operator transport (`createTransport` in
 * `verdict-cli.ts`) WITHOUT changing it: its six operations, token handling,
 * redirect rules and bounded downloads are used as they are. Three further
 * read-only GitHub REST operations are added here, with the same request
 * rules (token only on `API_ORIGIN` URLs, redirects never followed, bounded
 * bodies, fixed failure codes, nothing retried):
 *
 *   7 GET /repos/{repo}/actions/runs/{run_id}                     newest attempt
 *   8 GET /repos/{repo}/actions/runs/{run_id}/attempts/{n}/jobs   last-job completion
 *   9 GET /repos/{repo}/compare/{base}...{head}                   changed files
 *
 * Completeness is proved or the result is unavailable:
 *
 * - Jobs: every page is read until `total_count` is reached (at most
 *   `MAX_PAGES` pages of `PER_PAGE`), the total must not change between
 *   pages, and every job must have a positive safe-integer id that appears
 *   only once across all pages, belong to the requested run (`run_id`) and
 *   attempt, and be `completed` with a real `completed_at` instant;
 *   otherwise the completion time is unavailable.
 * - Changed files: GitHub returns at most 300 files for a comparison and
 *   documents no pagination for the file list. The list is therefore
 *   treated as complete only when fewer than `COMPARE_FILE_LIMIT` files are
 *   returned, the comparison is `ahead` or `identical` with the base as the
 *   merge base (so the head descends from the base), and every entry is well
 *   formed. A response at or above the limit is marked incomplete, never
 *   complete.
 *
 * Kept free of `@/` imports so Node's type-stripping test runner can load it
 * directly (ADR-0002).
 */
import {
  API_ORIGIN,
  API_VERSION,
  MAX_JSON_BYTES,
  MAX_PAGES,
  PER_PAGE,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
  classifyStatus,
  createTransport,
  type TransportConfig,
} from './verdict-cli.ts';
import type { Retrieved, RetrievalFailure } from './verdict.ts';
import type { ChangedFile, ChangedFiles, HealthEvidenceTransport } from './health-evidence.ts';
import { isCalendarInstant } from './readme-health.ts';

/** GitHub's documented maximum number of files in one comparison response. */
export const COMPARE_FILE_LIMIT = 300;

const SHA = /^[0-9a-f]{40}$/;

type Rec = Readonly<Record<string, unknown>>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function posInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
function nonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function ok<T>(value: T): Retrieved<T> {
  return { status: 'ok', value };
}
function failed<T>(reason: RetrievalFailure): Retrieved<T> {
  return { status: 'failed', reason };
}

/** Builds the transport; the token stays in this closure and the operator's. */
export function createHealthTransport(config: TransportConfig): HealthEvidenceTransport {
  // Validates the repository and branch and captures the token (throws on
  // an invalid configuration, before any request).
  const base = createTransport(config);
  const repoPath = `/repos/${config.repository}`;
  const headers: Readonly<Record<string, string>> = Object.freeze({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  });

  async function getJson(path: string): Promise<Retrieved<unknown>> {
    const r = await config.http.get({
      url: `${API_ORIGIN}${repoPath}${path}`,
      headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_JSON_BYTES,
    });
    if (r.kind === 'error') {
      return failed(
        r.error === 'timeout' ? 'timeout' : r.error === 'too-large' ? 'malformed' : 'http-error',
      );
    }
    // Redirects are never followed for API calls.
    if (r.status !== 200) return failed(classifyStatus(r.status, r.headers));
    try {
      return ok(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.body)) as unknown);
    } catch {
      return failed('malformed');
    }
  }

  return Object.freeze({
    ...base,

    getLatestAttempt: async (runId: number): Promise<Retrieved<number>> => {
      if (!posInt(runId)) return failed('malformed');
      const r = await getJson(`/actions/runs/${String(runId)}`);
      if (r.status !== 'ok') return failed(r.reason);
      const v = r.value;
      if (!isRec(v) || v.id !== runId || !posInt(v.run_attempt)) return failed('malformed');
      return ok(v.run_attempt);
    },

    getAttemptCompletion: async (runId: number, attempt: number): Promise<Retrieved<string>> => {
      if (!posInt(runId) || !posInt(attempt)) return failed('malformed');
      const path = `/actions/runs/${String(runId)}/attempts/${String(attempt)}/jobs`;
      let total: number | undefined;
      let seen = 0;
      const ids = new Set<number>();
      let latest: string | undefined;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await getJson(`${path}?per_page=${String(PER_PAGE)}&page=${String(page)}`);
        if (r.status !== 'ok') return failed(r.reason);
        const v = r.value;
        if (!isRec(v) || !nonNegInt(v.total_count) || !Array.isArray(v.jobs)) {
          return failed('malformed');
        }
        if (total === undefined) total = v.total_count;
        else if (v.total_count !== total) return failed('incomplete-pagination');
        const jobs = v.jobs as unknown[];
        if (jobs.length > PER_PAGE) return failed('malformed');
        for (const job of jobs) {
          if (
            !isRec(job) ||
            !posInt(job.id) ||
            job.run_id !== runId ||
            job.run_attempt !== attempt ||
            job.status !== 'completed'
          ) {
            return failed('malformed');
          }
          // A job seen twice (within or across pages) means the listing is not
          // a faithful enumeration; never count it as complete.
          if (ids.has(job.id)) return failed('malformed');
          ids.add(job.id);
          const completedAt = job.completed_at;
          if (typeof completedAt !== 'string' || !isCalendarInstant(completedAt)) {
            return failed('malformed');
          }
          if (latest === undefined || completedAt > latest) latest = completedAt;
          seen += 1;
        }
        if (seen > total) return failed('malformed');
        if (seen === total) {
          return latest === undefined ? failed('malformed') : ok(latest);
        }
        if (jobs.length === 0) return failed('incomplete-pagination');
      }
      return failed('incomplete-pagination');
    },

    listChangedFiles: async (
      baseSha: string,
      headSha: string,
    ): Promise<Retrieved<ChangedFiles>> => {
      if (!SHA.test(baseSha) || !SHA.test(headSha)) return failed('malformed');
      const r = await getJson(`/compare/${baseSha}...${headSha}`);
      if (r.status !== 'ok') return failed(r.reason);
      const v = r.value;
      if (!isRec(v) || !isRec(v.base_commit) || !isRec(v.merge_base_commit)) {
        return failed('malformed');
      }
      // Only a head that descends from the base is a usable path list.
      const descends =
        (v.status === 'ahead' || v.status === 'identical') &&
        v.base_commit.sha === baseSha &&
        v.merge_base_commit.sha === baseSha;
      if (!descends) return failed('malformed');
      if (!Array.isArray(v.files)) {
        // `identical` comparisons may omit files; anything else is malformed.
        return v.status === 'identical' && v.files === undefined
          ? ok({ files: [], complete: true })
          : failed('malformed');
      }
      const raw = v.files as unknown[];
      const files: ChangedFile[] = [];
      for (const entry of raw) {
        if (
          !isRec(entry) ||
          typeof entry.filename !== 'string' ||
          typeof entry.status !== 'string'
        ) {
          return failed('malformed');
        }
        const previous = entry.previous_filename;
        files.push({
          filename: entry.filename,
          status: entry.status,
          previousFilename: typeof previous === 'string' ? previous : null,
        });
      }
      // At or above GitHub's cap the list may be truncated: never complete.
      return ok({ files, complete: raw.length < COMPARE_FILE_LIMIT });
    },
  });
}
