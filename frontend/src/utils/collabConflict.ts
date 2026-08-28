// Follow-up to the "prevent collab external mutation data loss" fix: shared
// helpers for presenting an external mutation that did NOT win because a live
// collaborator held unsaved edits.
//
// The safety invariant is unchanged and enforced server-side — an external
// mutation never silently replaces Y.Text content containing unpersisted
// collaborator edits. These helpers only make that outcome truthful to the
// user instead of a generic "Save failed" / "restored successfully".

/** Error code returned by POST /api/projects/:id/file on a live collab conflict. */
export const COLLAB_SAVE_CONFLICT_CODE = "collab_external_conflict";

/**
 * True when a thrown API error is a direct-save collaboration conflict (the
 * `api()` wrapper copies `error.code` from the response body onto the Error).
 * This is NOT a genuine server failure — the save was safely refused.
 */
export function isCollabSaveConflict(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === COLLAB_SAVE_CONFLICT_CODE
  );
}

function baseName(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Truthful message for a direct file-save conflict. Does not claim the
 * versions were merged — they were not; the collaborator's live version was
 * kept and this save was not applied over it.
 */
export function collabSaveConflictMessage(path: string): string {
  return (
    `Not saved — a collaborator has unsaved changes in ${baseName(path)} ` +
    `in the live session. Their version was kept; your save was not applied ` +
    `over it.`
  );
}

/**
 * Route a thrown save error to the right presentation. A collab conflict is
 * NOT a failure — it goes to `onCollabConflict` with a truthful message; every
 * other error goes to `onFailure`. Keeping this decision in one tested place
 * stops a generic `catch` from mislabelling a safely-refused save.
 */
export function handleSaveError(
  err: unknown,
  path: string,
  handlers: {
    onCollabConflict: (message: string) => void;
    onFailure: (message: string) => void;
  },
): void {
  if (isCollabSaveConflict(err)) {
    handlers.onCollabConflict(collabSaveConflictMessage(path));
    return;
  }
  handlers.onFailure(
    err instanceof Error ? err.message : String(err ?? "unknown error"),
  );
}

/**
 * Truthful trailing sentence for a bulk operation (snapshot restore, Git
 * checkout) that partially applied because one or more files were held at a
 * collaborator's unsaved version. Returns `null` when nothing conflicted.
 */
export function bulkConflictSummary(
  conflictedPaths: string[] | undefined,
  operation: string,
): string | null {
  if (!conflictedPaths || conflictedPaths.length === 0) return null;
  const names = conflictedPaths.map(baseName);
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return (
    `${operation} completed, but ${names.length} ` +
    `file${names.length === 1 ? "" : "s"} (${shown}${more}) ` +
    `${names.length === 1 ? "was" : "were"} kept at a collaborator's unsaved ` +
    `version and not changed.`
  );
}
