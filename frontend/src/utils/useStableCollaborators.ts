import { useRef } from "react";
import type { CollaboratorPresence } from "../collab/presence";

/**
 * M71 — the fields of a `CollaboratorPresence` that the file-tree Sidebar
 * actually renders:
 *   - `userId` / `activeFile` drive `collaboratorsByPath` + `collaboratorsByFolder`
 *   - `activity.type`, `name`, `color`, `clientId` drive the per-row dots/badges
 *
 * NOT rendered by the Sidebar: `cursor`, `selection`, `lastActive`,
 * `workingFolder`, `intent`, `status`, `role`, `displayName`, `activeFileDirty`.
 * Those churn on every remote keystroke; the Sidebar must not re-render for them
 * (BASELINE A: ~5–90 ms of React work per otherwise-wasted tick).
 */
export function sidebarPresenceSignature(
  collaborators: CollaboratorPresence[],
  currentUserId: number,
): string {
  const parts: string[] = [];
  for (const c of collaborators) {
    if (c.userId === currentUserId) continue;
    parts.push(
      `${c.clientId}${c.userId}${c.activeFile ?? ""}${
        c.activity?.type ?? ""
      }${c.name}${c.color}`,
    );
  }
  // The awareness map has no guaranteed order; sort so a reorder alone is not
  // treated as a change.
  parts.sort();
  return parts.join("");
}

/**
 * Returns a referentially-stable `CollaboratorPresence[]` that only changes
 * identity when the Sidebar-relevant projection (see `sidebarPresenceSignature`)
 * changes. Feed the result to a memoized `<Sidebar>` so remote cursor/selection
 * churn no longer reconciles the whole file tree.
 *
 * The full, unprojected `collaborators` array is still what every other
 * consumer (Editor spatial-awareness, TeamPanel, avatar stack) receives —
 * this hook is only for the tree.
 */
export function useStableCollaborators(
  collaborators: CollaboratorPresence[],
  currentUserId: number,
): CollaboratorPresence[] {
  const sigRef = useRef<string | null>(null);
  const valueRef = useRef<CollaboratorPresence[]>(collaborators);

  const sig = sidebarPresenceSignature(collaborators, currentUserId);
  if (sig !== sigRef.current) {
    sigRef.current = sig;
    valueRef.current = collaborators;
  }
  return valueRef.current;
}
