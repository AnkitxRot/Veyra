/**
 * M101: pure model for split editor groups. The primary group ("main") shows
 * every open file not owned by an extra group; extra groups own an explicit,
 * ordered tab list. A path lives in exactly one group, so the shared Monaco
 * model has a single owner and drag/move is just a transfer of ownership.
 */
export const MAIN_GROUP = "main";
export const MAX_GROUPS = 3;
export type SplitDirection = "right" | "down";

export interface ExtraGroup {
  id: string;
  tabs: string[];
  active: string | null;
}

export interface EditorGroupsState {
  direction: SplitDirection;
  extras: ExtraGroup[];
}

export const initialGroups: EditorGroupsState = { direction: "right", extras: [] };

export type GroupsAction =
  | { type: "split"; direction: SplitDirection; id: string; path?: string }
  | { type: "move"; path: string; to: string }
  | { type: "activate"; group: string; path: string | null }
  | { type: "closeTab"; path: string }
  | { type: "closeGroup"; id: string }
  | { type: "reconcile"; open: string[] }
  | { type: "reset" };

function without(extras: ExtraGroup[], path: string): ExtraGroup[] {
  return extras.map((g) =>
    g.tabs.includes(path)
      ? {
          ...g,
          tabs: g.tabs.filter((t) => t !== path),
          active: g.active === path ? (g.tabs.filter((t) => t !== path).at(-1) ?? null) : g.active,
        }
      : g,
  );
}

/** Drops extra groups that have become empty. */
function prune(extras: ExtraGroup[]): ExtraGroup[] {
  return extras.filter((g) => g.tabs.length > 0);
}

export function groupsReducer(state: EditorGroupsState, action: GroupsAction): EditorGroupsState {
  switch (action.type) {
    case "split": {
      if (state.extras.length + 1 >= MAX_GROUPS) return state;
      const tabs = action.path ? [action.path] : [];
      const base = action.path ? without(state.extras, action.path) : state.extras;
      return {
        direction: action.direction,
        extras: [...prune(base), { id: action.id, tabs, active: action.path ?? null }],
      };
    }
    case "move": {
      if (action.to === MAIN_GROUP) {
        return { ...state, extras: prune(without(state.extras, action.path)) };
      }
      if (!state.extras.some((g) => g.id === action.to)) return state;
      const stripped = without(state.extras, action.path);
      return {
        ...state,
        extras: prune(
          stripped.map((g) =>
            g.id === action.to ? { ...g, tabs: [...g.tabs, action.path], active: action.path } : g,
          ),
        ).concat(),
      };
    }
    case "activate":
      return {
        ...state,
        extras: state.extras.map((g) => (g.id === action.group ? { ...g, active: action.path } : g)),
      };
    case "closeTab":
      return { ...state, extras: prune(without(state.extras, action.path)) };
    case "closeGroup":
      return { ...state, extras: state.extras.filter((g) => g.id !== action.id) };
    case "reconcile":
      return reconcile(state, action.open);
    case "reset":
      return initialGroups;
  }
}

/** Paths shown by the primary group, preserving openFiles order. */
export function mainPaths(openPaths: string[], state: EditorGroupsState): string[] {
  const owned = new Set(state.extras.flatMap((g) => g.tabs));
  return openPaths.filter((p) => !owned.has(p));
}

/** Drops tabs for files that are no longer open anywhere. */
export function reconcile(state: EditorGroupsState, openPaths: string[]): EditorGroupsState {
  const open = new Set(openPaths);
  let changed = false;
  let extras = state.extras.map((g) => {
    const tabs = g.tabs.filter((t) => open.has(t));
    if (tabs.length === g.tabs.length) return g;
    changed = true;
    return { ...g, tabs, active: g.active && tabs.includes(g.active) ? g.active : (tabs.at(-1) ?? null) };
  });
  const pruned = prune(extras);
  if (pruned.length !== extras.length) changed = true;
  extras = pruned;
  return changed ? { ...state, extras } : state;
}
