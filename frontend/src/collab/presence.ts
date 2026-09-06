// M57: canonical frontend presence model.
//
// One home for: the CollaboratorPresence shape, the parse from a raw Yjs
// awareness state, working-folder derivation, relative-time formatting, and the
// "who's working here?" selectors. Every collaborator surface (avatar stack,
// TeamPanel, Sidebar, Editor) reads through this module — there is no second
// collaborator store.
//
// Keep ACTIVITY_TYPES / AVAILABILITY_STATUSES in sync with
// backend/src/collab/presence.ts (AWARENESS_ACTIVITY_VALUES /
// AWARENESS_STATUS_VALUES). The repo hand-syncs frontend/src/types.ts with
// backend types the same way.

export type AvailabilityStatus = "online" | "idle" | "away" | "dnd";

export type ActivityType =
  | "viewing"
  | "editing"
  | "navigating"
  | "running"
  | "terminal"
  | "searching"
  | "reviewing";

export interface ActivityState {
  type: ActivityType;
  detail?: string | null;
  timestamp: number;
}

export interface SelectionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface CollaboratorIntent {
  text: string;
  updatedAt: number;
}

export interface CollaboratorPresence {
  clientId: number;
  userId: number;
  /** The immutable technical username. Identity key, mention token, the
   *  always-available @handle. NEVER replaced by displayName. */
  name: string;
  /**
   * M62: the collaborator's effective display name, as resolved server-side
   * (sanitized profile displayName, else the username). `undefined` when the
   * awareness packet carried none — an older/mixed-version peer — in which
   * case surfaces fall back to `name`. Presentation only.
   */
  displayName?: string;
  /**
   * M72: server-authored avatar cache-buster. `0` / absent → the initials
   * fallback. A client-sent value is discarded server-side. Presentation
   * only — never a key.
   */
  avatarVersion?: number;
  /**
   * M73: the collaborator's sanitized pronouns, as resolved server-side from
   * their profile. `undefined` when unset (or an older/mixed-version peer).
   * Presentation only — never a key.
   */
  pronouns?: string;
  role: "owner" | "editor" | "viewer";
  color: string;
  /** Availability — how reachable the collaborator is. Independent of `activity`. */
  status: AvailabilityStatus;
  /** Activity — what the collaborator is doing. Independent of `status`. */
  activity: ActivityState;
  activeFile?: string | null;
  /** M57: the folder the collaborator is working in — dirname(activeFile).
   *  Derived from editor focus only, never from Explorer browsing. */
  workingFolder?: string | null;
  cursor?: { line: number; column: number } | null;
  selection?: SelectionRange | null;
  /** M57: human-authored, ephemeral one-liner. `undefined` = not set. */
  intent?: CollaboratorIntent;
  lastActive: number;
  /**
   * M56: whether this collaborator's client has UNSAVED local buffer edits in
   * its active file. `undefined` means the client did not report a bit — NOT
   * the same as "clean" and must never be shown as "unsaved".
   */
  activeFileDirty?: boolean;
}

const USER_COLORS = [
  "#89b4fa", // Blue
  "#a6e3a1", // Green
  "#fab387", // Peach
  "#f38ba8", // Red
  "#cba6f7", // Mauve
  "#f9e2af", // Yellow
  "#94e2d5", // Teal
  "#f5c2e7", // Pink
];

export function getUserColor(userId: number): string {
  return USER_COLORS[Math.abs(userId) % USER_COLORS.length];
}

/**
 * M62: the single frontend definition of a collaborator's display label —
 * effective displayName, or the username when none is set. Presentation
 * ONLY. Never a key, never a lookup, never used for colour (that stays
 * `getUserColor(userId)`). Every collaboration surface reads through this.
 */
export function displayLabel(c: {
  name: string;
  displayName?: string | null;
}): string {
  const d = c.displayName;
  return typeof d === "string" && d.trim().length > 0 ? d : c.name;
}

/**
 * M62: the `@username` disambiguation suffix — returned only when the
 * display label actually differs from the username (so an unchanged
 * identity is not shown twice). `null` = show nothing extra.
 */
export function secondaryHandle(c: {
  name: string;
  displayName?: string | null;
}): string | null {
  return displayLabel(c) !== c.name ? `@${c.name}` : null;
}

/** dirname(activeFile), workspace-relative. Root-level files → null. */
export function deriveWorkingFolder(
  activeFile: string | null | undefined,
): string | null {
  if (!activeFile) return null;
  const norm = activeFile.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i <= 0) return null;
  return norm.slice(0, i);
}

/** "Active now" / "20s ago" / "4m ago" / "2h ago". Presentation only. */
export function formatRelativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 10) return "Active now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/**
 * Parse one raw Yjs awareness state into a CollaboratorPresence, or null when
 * it carries no identity. Every field is defensively type-guarded — a peer's
 * state has already passed the server-authoritative M55 rebuild, but the
 * client still never trusts a shape blindly.
 */
export function readPresenceState(
  clientId: number,
  raw: unknown,
): CollaboratorPresence | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Record<string, any>;
  if (!state.user || typeof state.user !== "object") return null;

  const rawActivity = state.activity;
  const activity: ActivityState =
    rawActivity && typeof rawActivity.type === "string"
      ? {
          type: rawActivity.type as ActivityType,
          detail:
            typeof rawActivity.detail === "string" ? rawActivity.detail : null,
          timestamp:
            typeof rawActivity.timestamp === "number"
              ? rawActivity.timestamp
              : Date.now(),
        }
      : {
          type: "viewing",
          detail: typeof state.activeFile === "string" ? state.activeFile : null,
          timestamp: Date.now(),
        };

  const rawSelection = state.selection;
  const selection: SelectionRange | null =
    rawSelection &&
    typeof rawSelection.startLine === "number" &&
    typeof rawSelection.startColumn === "number" &&
    typeof rawSelection.endLine === "number" &&
    typeof rawSelection.endColumn === "number"
      ? {
          startLine: rawSelection.startLine,
          startColumn: rawSelection.startColumn,
          endLine: rawSelection.endLine,
          endColumn: rawSelection.endColumn,
        }
      : null;

  const rawIntent = state.intent;
  const intent: CollaboratorIntent | undefined =
    rawIntent &&
    typeof rawIntent === "object" &&
    typeof rawIntent.text === "string" &&
    typeof rawIntent.updatedAt === "number"
      ? { text: rawIntent.text, updatedAt: rawIntent.updatedAt }
      : undefined;

  const availability: AvailabilityStatus =
    state.status === "idle" ||
    state.status === "away" ||
    state.status === "dnd"
      ? state.status
      : "online";

  return {
    clientId,
    userId: Number(state.user.id) || 0,
    name: typeof state.user.name === "string" ? state.user.name : "Anonymous",
    // M62: server-authored effective display name. Absent on older peers —
    // stays `undefined`, and every surface falls back to `name`.
    displayName:
      typeof state.user.displayName === "string"
        ? state.user.displayName
        : undefined,
    // M72: server-authored avatar cache-buster. Only a finite positive
    // integer counts; anything else (absent, forged, NaN) → 0 = initials.
    avatarVersion:
      typeof state.user.avatarVersion === "number" &&
      Number.isFinite(state.user.avatarVersion) &&
      state.user.avatarVersion > 0
        ? Math.floor(state.user.avatarVersion)
        : 0,
    // M73: server-authored sanitized pronouns. Only a non-empty string
    // counts; anything else (absent, blank, non-string) → undefined.
    pronouns:
      typeof state.user.pronouns === "string" &&
      state.user.pronouns.trim().length > 0
        ? state.user.pronouns.slice(0, 24)
        : undefined,
    role:
      state.user.role === "owner" || state.user.role === "viewer"
        ? state.user.role
        : "editor",
    color:
      typeof state.user.color === "string"
        ? state.user.color
        : getUserColor(Number(state.user.id) || 0),
    status: availability,
    activity,
    activeFile: typeof state.activeFile === "string" ? state.activeFile : null,
    workingFolder:
      typeof state.workingFolder === "string" ? state.workingFolder : null,
    activeFileDirty:
      typeof state.activeFileDirty === "boolean"
        ? state.activeFileDirty
        : undefined,
    cursor:
      state.cursor &&
      typeof state.cursor.line === "number" &&
      typeof state.cursor.column === "number"
        ? { line: state.cursor.line, column: state.cursor.column }
        : null,
    selection,
    intent,
    lastActive:
      typeof state.lastActive === "number" ? state.lastActive : Date.now(),
  };
}

// --- "Who's working here?" selectors (pure, over the canonical array) -------

export function collaboratorsInFile(
  list: CollaboratorPresence[],
  path: string,
  excludeUserId?: number,
): CollaboratorPresence[] {
  return list.filter(
    (c) => c.userId !== excludeUserId && c.activeFile === path,
  );
}

export function collaboratorsInFolder(
  list: CollaboratorPresence[],
  folder: string,
  excludeUserId?: number,
): CollaboratorPresence[] {
  const prefix = folder.endsWith("/") ? folder : folder + "/";
  return list.filter(
    (c) =>
      c.userId !== excludeUserId &&
      ((typeof c.activeFile === "string" && c.activeFile.startsWith(prefix)) ||
        c.workingFolder === folder),
  );
}

/** Map of folder → collaborators working there, de-duped by userId. */
export function groupCollaboratorsByFolder(
  list: CollaboratorPresence[],
  excludeUserId?: number,
): Map<string, CollaboratorPresence[]> {
  const out = new Map<string, CollaboratorPresence[]>();
  for (const c of list) {
    if (c.userId === excludeUserId) continue;
    const folder = c.workingFolder ?? deriveWorkingFolder(c.activeFile ?? null);
    if (!folder) continue;
    const arr = out.get(folder) ?? [];
    if (!arr.some((x) => x.userId === c.userId)) arr.push(c);
    out.set(folder, arr);
  }
  return out;
}
