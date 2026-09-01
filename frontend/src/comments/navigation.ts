import type { CommentThreadDTO } from "../types";

/**
 * M61-A: canonical navigable filter — active, non-stale, non-deleted.
 * Mirrors the CommentGutter filter and the explorer/tab badge filter.
 */
export function navigableThreads(threads: CommentThreadDTO[]): CommentThreadDTO[] {
  return threads
    .filter((t) => t.resolvedAt == null && t.anchorStatus !== "stale" && t.root.deletedAt == null)
    .sort((a, b) => a.anchor.startLine - b.anchor.startLine || a.id.localeCompare(b.id));
}

export function nextInFile(
  threadsForFile: CommentThreadDTO[],
  currentId: string | null,
): CommentThreadDTO | null {
  const nav = navigableThreads(threadsForFile);
  if (nav.length === 0) return null;
  const idx = currentId ? nav.findIndex((t) => t.id === currentId) : -1;
  if (idx === -1) return nav[0];
  return nav[(idx + 1) % nav.length];
}

export function previousInFile(
  threadsForFile: CommentThreadDTO[],
  currentId: string | null,
): CommentThreadDTO | null {
  const nav = navigableThreads(threadsForFile);
  if (nav.length === 0) return null;
  const idx = currentId ? nav.findIndex((t) => t.id === currentId) : -1;
  if (idx === -1) return nav[nav.length - 1];
  return nav[(idx - 1 + nav.length) % nav.length];
}

export function nextUnresolved(
  unresolved: CommentThreadDTO[],
  currentId: string | null,
): CommentThreadDTO | null {
  const nav = unresolved.filter((t) => t.anchorStatus !== "stale" && t.root.deletedAt == null);
  if (nav.length === 0) return null;
  const idx = currentId ? nav.findIndex((t) => t.id === currentId) : -1;
  if (idx === -1) return nav[0];
  return nav[(idx + 1) % nav.length];
}

/**
 * Derive per-file unresolved counts from the canonical CommentStore unresolved list.
 * Active only, stale and deleted filtered, subtle footprint.
 */
export function countsByFile(unresolved: CommentThreadDTO[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of unresolved) {
    if (t.anchorStatus === "stale") continue;
    if (t.root.deletedAt != null) continue;
    // unresolved is already filtered to active, but we keep the guard
    if (t.resolvedAt != null) continue;
    map.set(t.filePath, (map.get(t.filePath) ?? 0) + 1);
  }
  return map;
}
