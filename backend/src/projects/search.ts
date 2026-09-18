import { Worker } from "node:worker_threads";
import { ApiError } from "../errors.js";

export interface SearchOptions {
  query: string;
  isCaseSensitive?: boolean;
  isWholeWord?: boolean;
  isRegex?: boolean;
  includePattern?: string;
  excludePattern?: string;
  maxResults?: number;
}

export interface SearchMatch {
  filePath: string;
  lineNumber: number;
  column: number;
  lineContent: string;
  matchLength: number;
}

export interface SearchFileGroup {
  filePath: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  groups: SearchFileGroup[];
  totalMatches: number;
  filesSearched: number;
  durationMs: number;
  truncated: boolean;
}

export interface ReplaceOptions extends SearchOptions {
  /** Replacement text. In regex mode, `$1`/`$&`/etc. are honored as capture-group
   *  backreferences (standard `String.replace` semantics). In literal mode, `$`
   *  is treated as a literal character (escaped internally before substitution). */
  replacement: string;
}

export interface ReplaceMatch extends SearchMatch {
  /** Preview of this single line after replacement, computed line-scoped (not
   *  derived from the whole-file replacement) so it stays simple and accurate
   *  even if a replacement value itself contains newlines. */
  replacedLineContent: string;
}

export interface ReplaceFileGroup {
  filePath: string;
  matches: ReplaceMatch[];
  /**
   * Full post-replacement file content, or `null` if this file is not
   * eligible to actually be written: either its match-scan was cut short by
   * the maxResults/time budget before reaching the end of the file (so not
   * every occurrence was found — applying would silently miss matches we
   * never reported), or the file exceeds `MAX_REPLACE_FILE_CHARS`. Matches
   * are still reported for review either way; only the write step is gated.
   */
  newContent: string | null;
}

export interface ReplaceResponse {
  groups: ReplaceFileGroup[];
  totalMatches: number;
  filesSearched: number;
  durationMs: number;
  truncated: boolean;
}

const DEFAULT_MAX_RESULTS = 500;
const MAX_RESULTS_CAP = 2000;
const MAX_REPLACE_FILE_CHARS = 5_000_000;
const MAX_SEARCH_FILE_BYTES = 5_000_000;

// Matches the worker's own internal budget below plus a small margin: the
// worker should normally finish (or self-truncate) within its own budget,
// so this external timeout firing means a single synchronous regex
// evaluation is blocking the worker thread with no way to interrupt it from
// inside — the only recourse is killing the thread from outside.
const WORKER_HARD_TIMEOUT_MS = 9000;

/**
 * Self-contained worker-thread source, run via `eval: true`. This is
 * embedded as a plain string rather than a separate `.js`/`.ts` file
 * because `worker_threads.Worker`'s file-based loader resolves modules
 * through Node's own resolver, independent of whatever loaded the parent
 * module (tsx in dev, vite-node in tests, plain `node` against tsc output
 * in production) — a sibling `search-worker.js` file exists in the
 * production build but not under tsx/vitest, and a `search-worker.ts` file
 * exists under tsx/vitest's TS-aware resolution but not in the compiled
 * build. Embedding the source as a string sidesteps module resolution
 * entirely: it is just data by the time this file is loaded, in every
 * environment. `eval: true` workers run as CommonJS by default, hence
 * `require(...)` here instead of `import`.
 */
const WORKER_SOURCE = `
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const MAX_LINE_LENGTH_FOR_MATCH = 4000;
const MAX_SEARCH_DURATION_MS = 8000;
const MAX_REPLACE_FILE_CHARS = ${MAX_REPLACE_FILE_CHARS};
const MAX_SEARCH_FILE_BYTES = ${MAX_SEARCH_FILE_BYTES};

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.venv', '__pycache__', '.cache',
  '.mypy_cache', '.pytest_cache', '.tox', '.eggs',
]);

function shouldSkipName(name) {
  if (IGNORE_DIRS.has(name)) return true;
  if (name.startsWith('.cloudide-build-')) return true;
  return false;
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'webp', 'pdf', 'zip', 'tar', 'gz', '7z',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'pyc', 'class', 'db', 'sqlite', 'ttf', 'woff', 'woff2',
]);

function isBinaryString(str) {
  const len = Math.min(str.length, 512);
  for (let i = 0; i < len; i++) {
    if (str.charCodeAt(i) === 0) return true;
  }
  return false;
}

function run(workspaceDir, options, regex, mode) {
  const startTime = performance.now();
  const {
    query,
    isCaseSensitive = false,
    isWholeWord = false,
    isRegex = false,
    includePattern,
    excludePattern,
    maxResults = 500,
    replacement,
  } = options;

  // In regex mode, $1/$&/etc. in the replacement are honored as capture-group
  // backreferences (standard String.replace semantics) since the user wrote
  // an actual regex. In literal mode the user typed a plain search string and
  // does not expect $-substitution, so a literal '$' must be escaped to '$$'
  // before use, or e.g. replacing with "$1" would silently vanish (no capture
  // group exists) instead of inserting the literal text "$1".
  const safeReplacement =
    mode === 'replace'
      ? isRegex
        ? String(replacement || '')
        : String(replacement || '').split('$').join('$$')
      : null;

  let includeRegex = null;
  if (includePattern && includePattern.trim()) {
    const raw = includePattern.trim().split(',').map((p) =>
      p.trim().replace(/[.+^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*')
    ).join('|');
    includeRegex = new RegExp('^(' + raw + ')$', 'i');
  }

  let excludeRegex = null;
  if (excludePattern && excludePattern.trim()) {
    const raw = excludePattern.trim().split(',').map((p) =>
      p.trim().replace(/[.+^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*')
    ).join('|');
    excludeRegex = new RegExp('^(' + raw + ')$', 'i');
  }

  const groupsMap = new Map();
  const newContentMap = new Map();
  let totalMatches = 0;
  let filesSearched = 0;
  let truncated = false;

  function budgetExceeded() {
    return performance.now() - startTime > MAX_SEARCH_DURATION_MS;
  }

  function traverseDir(currentDir) {
    if (totalMatches >= maxResults || budgetExceeded()) {
      truncated = true;
      return;
    }

    let dirents;
    try {
      dirents = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (let i = 0; i < dirents.length; i++) {
      if (totalMatches >= maxResults || budgetExceeded()) {
        truncated = true;
        return;
      }

      const dirent = dirents[i];
      const name = dirent.name;

      if (shouldSkipName(name)) continue;

      if (dirent.isDirectory()) {
        traverseDir(join(currentDir, name));
      } else if (dirent.isFile()) {
        const ext = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : '';
        if (BINARY_EXTENSIONS.has(ext)) continue;

        const fullPath = join(currentDir, name);
        const relPath = relative(workspaceDir, fullPath).replace(/\\\\/g, '/');

        if (includeRegex && !includeRegex.test(relPath) && !includeRegex.test(name)) continue;
        if (excludeRegex && (excludeRegex.test(relPath) || excludeRegex.test(name))) continue;

        filesSearched++;

        try {
          const st = statSync(fullPath);
          if (st.size > MAX_SEARCH_FILE_BYTES) continue;
        } catch {
          continue;
        }

        let content;
        try {
          content = readFileSync(fullPath, 'utf8');
        } catch {
          continue;
        }

        if (isBinaryString(content)) continue;

        if (!isRegex && !isWholeWord) {
          const quickQuery = isCaseSensitive ? query : query.toLowerCase();
          const quickContent = isCaseSensitive ? content : content.toLowerCase();
          if (!quickContent.includes(quickQuery)) continue;
        }

        const lines = content.split('\\n');
        let fileCutShort = false;

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          if (totalMatches >= maxResults || budgetExceeded()) {
            truncated = true;
            fileCutShort = true;
            break;
          }

          const lineContent = lines[lineIdx];
          if (lineContent.length > MAX_LINE_LENGTH_FOR_MATCH) continue;
          regex.lastIndex = 0;

          let match;
          while ((match = regex.exec(lineContent)) !== null) {
            const column = match.index + 1;
            const matchLength = match[0].length || 1;
            const cleanLineContent = lineContent.replace(/\\r$/, '');

            const matchItem = {
              filePath: relPath,
              lineNumber: lineIdx + 1,
              column,
              lineContent: cleanLineContent,
              matchLength,
            };

            if (mode === 'replace') {
              matchItem.replacedLineContent = cleanLineContent.replace(
                new RegExp(regex.source, regex.flags),
                safeReplacement,
              );
            }

            const existing = groupsMap.get(relPath) || [];
            existing.push(matchItem);
            groupsMap.set(relPath, existing);

            totalMatches++;

            if (totalMatches >= maxResults) {
              truncated = true;
              fileCutShort = true;
              break;
            }

            if (match.index === regex.lastIndex) {
              regex.lastIndex++;
            }
          }
        }

        if (mode === 'replace' && groupsMap.has(relPath)) {
          // Only offer this file for actual writing if we found every one of
          // its occurrences (not cut short by the maxResults/time budget) and
          // it is small enough to substitute in one bounded pass — otherwise
          // matches are still shown for review, but newContent stays null so
          // the caller knows not to write it.
          const eligible = !fileCutShort && content.length <= MAX_REPLACE_FILE_CHARS;
          newContentMap.set(
            relPath,
            eligible ? content.replace(new RegExp(regex.source, regex.flags), safeReplacement) : null,
          );
        }
      }
    }
  }

  traverseDir(workspaceDir);

  const groups = Array.from(groupsMap.entries()).map(([filePath, matches]) => ({
    filePath,
    matches,
    ...(mode === 'replace' ? { newContent: newContentMap.has(filePath) ? newContentMap.get(filePath) : null } : {}),
  }));
  const durationMs = Math.round((performance.now() - startTime) * 100) / 100;

  return { groups, totalMatches, filesSearched, durationMs, truncated };
}

const { workspaceDir, options, patternSource, patternFlags, mode } = workerData;
const regex = new RegExp(patternSource, patternFlags);
const result = run(workspaceDir, options, regex, mode);
parentPort.postMessage(result);
`;

/**
 * Executes a text search across all files in a workspace.
 *
 * `isRegex` searches compile a fully user-controlled pattern and execute it
 * against arbitrary file content. A catastrophic-backtracking pattern (e.g.
 * `(a+)+$`, or more subtly `((a+))+$` / `(a|a)*$`) can block a single JS
 * thread indefinitely — and since a thread cannot interrupt its own
 * synchronous execution, no amount of pattern inspection or in-loop
 * wall-clock checking on that same thread can bound it (a previous version
 * of this function tried a pattern-shape heuristic; it was bypassable by
 * trivial pattern restructuring, e.g. adding a redundant paren pair, and
 * has been removed). The traversal and matching therefore run in a
 * dedicated worker thread, which the caller forcibly terminates from
 * outside if it doesn't finish in time — the only mechanism that is
 * correct regardless of *why* a given pattern is slow.
 */
/**
 * Shared plumbing for both search and replace: validates the pattern on the
 * main thread (cheap, can't hang), then runs the actual traversal/matching
 * (and, in replace mode, per-file substitution) in a worker thread with the
 * same hard-timeout kill switch, so replace inherits the exact same
 * catastrophic-backtracking protection as search rather than a second,
 * independently-risky implementation.
 */
async function runContentWorker<
  T extends {
    groups: unknown[];
    totalMatches: number;
    filesSearched: number;
    durationMs: number;
    truncated: boolean;
  },
>(
  workspaceDir: string,
  options: SearchOptions & { replacement?: string },
  mode: "search" | "replace",
  signal?: AbortSignal,
): Promise<T> {
  const startTime = performance.now();
  const {
    query,
    isRegex = false,
    isWholeWord = false,
    isCaseSensitive = false,
  } = options;

  const emptyResult = {
    groups: [],
    totalMatches: 0,
    filesSearched: 0,
    durationMs: 0,
    truncated: false,
  } as unknown as T;

  if (!query || query.trim().length === 0) {
    return emptyResult;
  }

  // Validate regex syntax on the main thread: *constructing* a RegExp does
  // not execute it against any content, so this cannot itself hang —
  // catching a syntax typo here is fast and avoids a worker round-trip.
  let patternSource: string;
  const patternFlags = isCaseSensitive ? "g" : "gi";
  try {
    let pattern = isRegex
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (isWholeWord) {
      pattern = `\\b${pattern}\\b`;
    }
    void new RegExp(pattern, patternFlags);
    patternSource = pattern;
  } catch (err: any) {
    throw new ApiError(
      400,
      `Invalid search pattern: ${err.message}`,
      "invalid_regex",
    );
  }

  return new Promise<T>((resolve, reject) => {
    const truncatedEmpty = (): T =>
      ({
        ...emptyResult,
        durationMs: Math.round((performance.now() - startTime) * 100) / 100,
        truncated: true,
      }) as T;

    if (signal?.aborted) {
      resolve(truncatedEmpty());
      return;
    }

    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        workspaceDir,
        options: {
          ...options,
          maxResults: Math.min(
            Math.max(1, Number(options.maxResults) || DEFAULT_MAX_RESULTS),
            MAX_RESULTS_CAP,
          ),
        },
        patternSource,
        patternFlags,
        mode,
      },
    });

    let settled = false;
    function finish(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate().catch(() => {});
      fn();
    }
    const onAbort = () => finish(() => resolve(truncatedEmpty()));
    const timeout = setTimeout(() => {
      finish(() => resolve(truncatedEmpty()));
    }, WORKER_HARD_TIMEOUT_MS);

    signal?.addEventListener("abort", onAbort, { once: true });

    worker.once("message", (msg: T) => {
      finish(() => resolve(msg));
    });

    worker.once("error", (err) => {
      finish(() => reject(err));
    });
  });
}

export async function searchProjectContent(
  workspaceDir: string,
  options: SearchOptions,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  return runContentWorker<SearchResponse>(
    workspaceDir,
    options,
    "search",
    signal,
  );
}

/**
 * Finds every occurrence of `options.query` across the workspace (identical
 * matching semantics to {@link searchProjectContent}) and computes what each
 * matched file would look like after substituting `options.replacement`.
 * Does NOT write anything to disk — this only computes results; the caller
 * decides whether/how to apply `newContent` per file (see
 * `POST /:id/search/replace` in projects/routes.ts), so the same scan can
 * serve both a dry-run preview and an actual apply without duplicating the
 * matching logic or reimplementing backtracking protection.
 */
export async function replaceProjectContent(
  workspaceDir: string,
  options: ReplaceOptions,
  signal?: AbortSignal,
): Promise<ReplaceResponse> {
  return runContentWorker<ReplaceResponse>(
    workspaceDir,
    options,
    "replace",
    signal,
  );
}
