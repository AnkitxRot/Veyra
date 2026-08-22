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

const DEFAULT_MAX_RESULTS = 500;

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
const { readdirSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const MAX_LINE_LENGTH_FOR_MATCH = 4000;
const MAX_SEARCH_DURATION_MS = 8000;

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.venv', '__pycache__', '.cache',
]);

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

function run(workspaceDir, options, regex) {
  const startTime = performance.now();
  const {
    query,
    isCaseSensitive = false,
    isWholeWord = false,
    isRegex = false,
    includePattern,
    excludePattern,
    maxResults = 500,
  } = options;

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

      if (IGNORE_DIRS.has(name)) continue;

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

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          if (totalMatches >= maxResults || budgetExceeded()) {
            truncated = true;
            break;
          }

          const lineContent = lines[lineIdx];
          if (lineContent.length > MAX_LINE_LENGTH_FOR_MATCH) continue;
          regex.lastIndex = 0;

          let match;
          while ((match = regex.exec(lineContent)) !== null) {
            const column = match.index + 1;
            const matchLength = match[0].length || 1;

            const matchItem = {
              filePath: relPath,
              lineNumber: lineIdx + 1,
              column,
              lineContent: lineContent.replace(/\\r$/, ''),
              matchLength,
            };

            const existing = groupsMap.get(relPath) || [];
            existing.push(matchItem);
            groupsMap.set(relPath, existing);

            totalMatches++;

            if (totalMatches >= maxResults) {
              truncated = true;
              break;
            }

            if (match.index === regex.lastIndex) {
              regex.lastIndex++;
            }
          }
        }
      }
    }
  }

  traverseDir(workspaceDir);

  const groups = Array.from(groupsMap.entries()).map(([filePath, matches]) => ({ filePath, matches }));
  const durationMs = Math.round((performance.now() - startTime) * 100) / 100;

  return { groups, totalMatches, filesSearched, durationMs, truncated };
}

const { workspaceDir, options, patternSource, patternFlags } = workerData;
const regex = new RegExp(patternSource, patternFlags);
const result = run(workspaceDir, options, regex);
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
export async function searchProjectContent(
  workspaceDir: string,
  options: SearchOptions,
): Promise<SearchResponse> {
  const startTime = performance.now();
  const {
    query,
    isRegex = false,
    isWholeWord = false,
    isCaseSensitive = false,
  } = options;

  if (!query || query.trim().length === 0) {
    return {
      groups: [],
      totalMatches: 0,
      filesSearched: 0,
      durationMs: 0,
      truncated: false,
    };
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

  return new Promise<SearchResponse>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        workspaceDir,
        options: {
          ...options,
          maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
        },
        patternSource,
        patternFlags,
      },
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      resolve({
        groups: [],
        totalMatches: 0,
        filesSearched: 0,
        durationMs: Math.round((performance.now() - startTime) * 100) / 100,
        truncated: true,
      });
    }, WORKER_HARD_TIMEOUT_MS);

    worker.once("message", (msg: SearchResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate().catch(() => {});
      resolve(msg);
    });

    worker.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate().catch(() => {});
      reject(err);
    });
  });
}
