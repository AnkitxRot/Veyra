import { promises as fs, constants } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
} from "node:path";
import { ApiError } from "../errors.js";

const MAX_FILE_SIZE = 1024 * 1024;
const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  ".git",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  ".eggs",
]);
const BUILD_PREFIX = ".cloudide-build-";

export const DEFAULT_TREE_LIMITS = { maxEntries: 8000, maxDepth: 24 };
let treeLimits = { ...DEFAULT_TREE_LIMITS };

/** Test-only: bound the tree walk so truncation is deterministic. */
export function setTreeLimitsForTests(
  limits?: Partial<typeof DEFAULT_TREE_LIMITS> | null,
): void {
  treeLimits = limits
    ? { ...DEFAULT_TREE_LIMITS, ...limits }
    : { ...DEFAULT_TREE_LIMITS };
}

export function isSkippedTreeName(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(BUILD_PREFIX);
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: TreeNode[];
}

function escapeError(): ApiError {
  return new ApiError(400, "path escapes the workspace", "invalid_path");
}

export function safeResolve(root: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new ApiError(400, "path is required", "invalid_path");
  }
  if (relPath.includes("\0")) throw escapeError();
  if (relPath.startsWith("/")) throw escapeError();
  // Reject Windows-style absolute paths (C:\, \\server\share, etc.)
  if (/^[a-zA-Z]:/.test(relPath) || relPath.startsWith("\\\\"))
    throw escapeError();
  const resolved = resolve(root, relPath);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel === ".." || isAbsolute(rel))
    throw escapeError();
  return resolved;
}

/**
 * M51: `.git` is a managed repository, never an ordinary workspace file.
 * The tree/search/quick-open surfaces already exclude it via SKIP_DIRS; this
 * guards the by-path file APIs (read/write/move/delete) so a crafted path
 * can't reach repository internals.
 */
export function assertNotGitInternal(relPath: string): void {
  // M86: normalize first — `./.git/config`, `a/../.git/config`, `.GIT/config`
  // and `.git./config` all resolve into the repository directory.
  const normalized = posix.normalize(
    relPath.replace(/\\/g, "/").replace(/^\/+/, ""),
  );
  if (isGitInternalRel(normalized)) throw gitInternalError();
}

/**
 * M86: does a normalized workspace-relative path start in `.git`? Host
 * filesystems may be case-insensitive, and Win32 ignores trailing dots and
 * spaces and `:stream` suffixes on a path segment (`GIT~1` is its 8.3 name).
 */
function isGitInternalRel(rel: string): boolean {
  const first = rel.replace(/\\/g, "/").split("/")[0] ?? "";
  const segment = first
    .replace(/:.*$/, "")
    .replace(/[. ]+$/, "")
    .toLowerCase();
  return segment === ".git" || /^git~\d+$/.test(segment);
}

function gitInternalError(): ApiError {
  return new ApiError(
    400,
    "cannot access .git repository internals",
    "invalid_path",
  );
}

export async function assertInsideWorkspace(
  root: string,
  abs: string,
): Promise<void> {
  const realRoot = await fs.realpath(root);
  let cur = abs;
  const tail: string[] = [];

  while (true) {
    try {
      await fs.access(cur, constants.F_OK);
      break; // exists
    } catch {
      tail.unshift(basename(cur));
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  try {
    await fs.access(cur, constants.F_OK);
  } catch {
    throw escapeError();
  }

  let realAbs = await fs.realpath(cur);
  for (const part of tail) realAbs = join(realAbs, part);
  const rel = relative(realRoot, realAbs);
  if (rel.startsWith("..") || rel === ".." || isAbsolute(rel))
    throw escapeError();
  // M86: `.git` holds configuration host-side Git honors (filter drivers run
  // commands). Checked on the real path so a symlink/junction such as
  // `link -> .git` cannot reach it either. No caller needs `.git` access.
  if (isGitInternalRel(rel)) throw gitInternalError();
}

export async function listFiles(
  root: string,
  rel = "",
  out: string[] = [],
): Promise<string[]> {
  try {
    const entries = await fs.readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(BUILD_PREFIX))
          continue;
        await listFiles(root, relPath, out);
      } else if (entry.isFile()) {
        if (entry.name.startsWith(BUILD_PREFIX)) continue;
        out.push(relPath);
      }
    }
  } catch {
    // ignore dir read errors
  }
  return out;
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workerCount = Math.min(items.length, Math.max(1, limit));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

export interface TreeListing {
  tree: TreeNode[];
  truncated: boolean;
  scanned: number;
}

interface TreeCacheEntry extends TreeListing {
  timestamp: number;
}
const treeCache = new Map<string, TreeCacheEntry>();
const inFlightTrees = new Map<string, Promise<TreeListing>>();
const TREE_CACHE_TTL_MS = 500;

// M42: per-root generation counter, bumped on every invalidation. A tree()
// fetch that is still in flight when an import/delete/restore invalidates
// its root must not resurrect its (now-stale) result into the cache once it
// finally completes — see tree()'s own comment for the exact race this
// closes. undefined (never-invalidated / just-cleared) compares unequal to
// any real captured generation number, so this is correct for both a
// single-root invalidation and a full-cache clear without needing to
// enumerate every root on clear.
const treeGeneration = new Map<string, number>();

export function invalidateTreeCache(root?: string): void {
  if (root) {
    treeCache.delete(root);
    inFlightTrees.delete(root);
    treeGeneration.set(root, (treeGeneration.get(root) ?? 0) + 1);
  } else {
    treeCache.clear();
    inFlightTrees.clear();
    treeGeneration.clear();
  }
}

/**
 * Drop every cache entry for a workspace that no longer exists (project
 * delete). Unlike {@link invalidateTreeCache}, this does not retain a
 * generation counter for the path — deleted projects must not accumulate
 * unbounded keys.
 */
export function forgetTreeCache(root: string): void {
  treeCache.delete(root);
  inFlightTrees.delete(root);
  treeGeneration.delete(root);
}

interface TreeWalkState {
  scanned: number;
  truncated: boolean;
}

async function doTree(
  absRoot: string,
  prefix: string,
  depth: number,
  state: TreeWalkState,
): Promise<TreeNode[]> {
  if (state.truncated) return [];
  if (depth > treeLimits.maxDepth) {
    state.truncated = true;
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(absRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory()
      ? a.name.localeCompare(b.name)
      : a.isDirectory()
        ? -1
        : 1,
  );

  const filtered = entries.filter((e) => !e.name.startsWith(BUILD_PREFIX));

  const mapped = await mapConcurrent(
    filtered,
    8,
    async (e): Promise<TreeNode | null> => {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) return null;
      // Reserve the slot before any await so concurrent workers cannot all
      // pass the cap check, then each increment past maxEntries.
      if (state.truncated || state.scanned >= treeLimits.maxEntries) {
        state.truncated = true;
        return null;
      }
      state.scanned += 1;
      const relPath = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = join(absRoot, e.name);
      if (e.isDirectory()) {
        const children = await doTree(abs, relPath, depth + 1, state);
        return { name: e.name, path: relPath, type: "dir", children };
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(abs);
          return { name: e.name, path: relPath, type: "file", size: st.size };
        } catch {
          // file might have disappeared
          return null;
        }
      }
      return null;
    },
  );

  return mapped.filter((n): n is TreeNode => n !== null);
}

export async function treeListing(root: string): Promise<TreeListing> {
  const cached = treeCache.get(root);
  const now = Date.now();
  if (cached && now - cached.timestamp < TREE_CACHE_TTL_MS) {
    return {
      tree: cached.tree,
      truncated: cached.truncated,
      scanned: cached.scanned,
    };
  }

  const inFlight = inFlightTrees.get(root);
  if (inFlight) {
    return inFlight;
  }

  // M42: captured before doTree() starts its (possibly slow, recursive)
  // real filesystem walk. If invalidateTreeCache(root) runs while this
  // fetch is in flight — e.g. an import/delete/restore replacing the
  // directory contents underneath it — the generation bumps, and the write
  // below must be skipped: otherwise this fetch's now-stale result would
  // land in the cache with a *fresh* timestamp right after invalidation,
  // serving stale listings to every caller for a full new TTL window
  // instead of the (correctly invalidated) empty cache prompting a re-read.
  const startGeneration = treeGeneration.get(root) ?? 0;
  const fetchPromise = (async (): Promise<TreeListing> => {
    try {
      const state: TreeWalkState = { scanned: 0, truncated: false };
      const result = await doTree(root, "", 0, state);
      const listing: TreeListing = {
        tree: result,
        truncated: state.truncated,
        scanned: state.scanned,
      };
      if ((treeGeneration.get(root) ?? 0) === startGeneration) {
        treeCache.set(root, { ...listing, timestamp: Date.now() });
      }
      return listing;
    } finally {
      inFlightTrees.delete(root);
    }
  })();

  inFlightTrees.set(root, fetchPromise);
  return fetchPromise;
}

export async function tree(root: string): Promise<TreeNode[]> {
  return (await treeListing(root)).tree;
}

export async function readProjectFile(
  root: string,
  relPath: string,
): Promise<{ content: string; size: number }> {
  assertNotGitInternal(relPath);
  const abs = safeResolve(root, relPath);
  await assertInsideWorkspace(root, abs);
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw new ApiError(404, "file not found", "not_found");
  }
  if (!st.isFile()) throw new ApiError(400, "not a file", "not_a_file");
  if (st.size > MAX_FILE_SIZE) {
    throw new ApiError(413, "file is too large to open", "file_too_large");
  }
  const content = await fs.readFile(abs, "utf8");
  return { content, size: st.size };
}

export async function writeProjectFile(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  if (typeof content !== "string")
    throw new ApiError(400, "content must be a string", "invalid_content");
  assertNotGitInternal(relPath);
  const abs = safeResolve(root, relPath);
  await assertInsideWorkspace(root, abs);
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_SIZE) {
    throw new ApiError(413, "file is too large to save", "file_too_large");
  }
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  invalidateTreeCache(root);
}

export async function moveProjectPath(
  root: string,
  from: string,
  to: string,
): Promise<{ path: string }> {
  assertNotGitInternal(from);
  assertNotGitInternal(to);
  const srcAbs = safeResolve(root, from);
  const dstAbs = safeResolve(root, to);
  await assertInsideWorkspace(root, srcAbs);
  await assertInsideWorkspace(root, dstAbs);
  try {
    await fs.access(srcAbs, constants.F_OK);
  } catch {
    throw new ApiError(404, "path not found", "not_found");
  }
  try {
    await fs.access(dstAbs, constants.F_OK);
    throw new ApiError(409, "destination already exists", "already_exists");
  } catch (err: any) {
    if (err.status === 409) throw err;
  }
  await fs.mkdir(dirname(dstAbs), { recursive: true });
  await fs.rename(srcAbs, dstAbs);
  invalidateTreeCache(root);
  return { path: to };
}

export async function deleteProjectPath(
  root: string,
  relPath: string,
): Promise<void> {
  if (relPath === "" || relPath === ".")
    throw new ApiError(400, "cannot delete the workspace root", "invalid_path");
  assertNotGitInternal(relPath);
  const abs = safeResolve(root, relPath);
  await assertInsideWorkspace(root, abs);
  if (abs === resolve(root))
    throw new ApiError(400, "cannot delete the workspace root", "invalid_path");
  try {
    await fs.access(abs, constants.F_OK);
  } catch {
    throw new ApiError(404, "path not found", "not_found");
  }
  await fs.rm(abs, { recursive: true, force: true });
  invalidateTreeCache(root);
}

export { SKIP_DIRS };
