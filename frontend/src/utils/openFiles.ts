export interface OpenFileEntry {
  path: string;
  content: string;
  dirty?: boolean;
}

/**
 * Append a just-opened file to the open-files list, unless a tab for that
 * path is already present.
 *
 * The dedupe MUST happen here, against the authoritative `prev` handed to the
 * `setOpenFiles` functional update — not against the caller's own view of the
 * list. `IDE.handleOpenFile` became a `useCallback` keyed on `[project]` in
 * M61, which froze its `openFiles` closure: its early `existing` check then
 * reads a stale snapshot and a second open of an already-open file (click a
 * background tab's file in the tree, reopen a closed file, comment/session
 * navigation racing an explicit open) slipped past it and appended a
 * duplicate — producing two `editor-tab` nodes with the same React key.
 *
 * Returns `prev` unchanged (same reference) when the path is already open, so
 * it never causes a needless render.
 */
export function appendOpenFile<T extends OpenFileEntry>(prev: T[], next: T): T[] {
  if (prev.some((f) => f.path === next.path)) return prev;
  return [...prev, next];
}
