// M57: single home for the server-authoritative awareness field allowlist.
//
// This module decides WHICH ephemeral awareness fields survive an inbound
// MESSAGE_AWARENESS frame and how each is bounded. The security-critical frame
// decode + clientID ownership/claim logic stays in manager.ts
// (`sanitizeIncomingAwarenessUpdate`) — this module is only reached with an
// already-decoded, already-ownership-checked entry object.
//
// M55 invariant preserved verbatim: identity is ALWAYS the authenticated
// session; `out` is rebuilt from scratch and never spreads `incoming`, so an
// unknown top-level key can never smuggle content through.
//
// Keep the two enum Sets below in sync with frontend/src/collab/presence.ts
// (the repo keeps frontend/src/types.ts hand-synced with backend types the
// same way — there is no shared cross-package module).

/** Availability — how reachable the collaborator is. Independent of activity. */
export const AWARENESS_STATUS_VALUES = new Set([
  "online",
  "idle",
  "away", // M57: window blurred (distinct from `idle` = no interaction while focused)
  "dnd",
]);

/** Activity — what the collaborator is doing. Independent of availability. */
export const AWARENESS_ACTIVITY_VALUES = new Set([
  "viewing",
  "editing",
  "navigating", // M57: file-tree / tab navigation without an edit
  "running",
  "terminal",
  "searching",
  "reviewing", // reserved wire value (no emitter today)
]);

export const AWARENESS_MAX_PATH_LEN = 512;
export const AWARENESS_MAX_DETAIL_LEN = 200;
export const AWARENESS_MAX_INTENT_LEN = 120;
// Generous ceiling for a Monaco line/column — far beyond any real file, but
// bounded so a peer can't be fed absurd/NaN/Infinity coordinates.
export const AWARENESS_MAX_COORD = 5_000_000;

/** The subset of the room's per-connection client state this module needs.
 *  Always the authenticated WS session — never anything the client asserted. */
export interface AwarenessClientIdentity {
  userId: number;
  username: string;
  role: "owner" | "editor" | "viewer";
}

function isControlChar(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

export function isAwarenessCoord(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isFinite(n) &&
    n >= 0 &&
    n <= AWARENESS_MAX_COORD
  );
}

/**
 * `activeFile` / `workingFolder` are broadcast to every collaborator, so they
 * must look like a bounded workspace-relative path — never absolute, never
 * traversal, never a control-char / NUL carrier. Metadata only: NO filesystem
 * access happens here (that stays in ensureFileLoaded, with its own realpath
 * guard). Returns a string to keep, `null` for an explicit clear, or
 * `undefined` to drop the field.
 */
export function sanitizeAwarenessFilePath(
  value: unknown,
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > AWARENESS_MAX_PATH_LEN) {
    return undefined;
  }
  // Reject C0 control characters (incl. NUL) and DEL.
  for (let i = 0; i < value.length; i++) {
    if (isControlChar(value.charCodeAt(i))) return undefined;
  }
  const norm = value.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return undefined;
  if (norm.split("/").some((seg) => seg === "..")) return undefined;
  return value;
}

/**
 * M57: user-declared intent is a single human-authored line. Every C0 control
 * char (incl. NUL/TAB/CR/LF) and DEL becomes a space, whitespace runs collapse
 * to one space, trim, cap at 120 chars. Returns `""` when nothing survives (the
 * caller then drops the field).
 */
export function sanitizeIntentText(value: unknown): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (let i = 0; i < value.length; i++) {
    out += isControlChar(value.charCodeAt(i)) ? " " : value[i];
  }
  const s = out.replace(/\s+/g, " ").trim();
  return s.length > AWARENESS_MAX_INTENT_LEN
    ? s.slice(0, AWARENESS_MAX_INTENT_LEN)
    : s;
}

/**
 * Builds the trusted awareness state for one entry: server-authoritative
 * identity + an allowlist of bounded ephemeral fields. `incoming` is the
 * untrusted client-decoded object.
 */
export function buildAuthoritativeAwarenessState(
  incoming: Record<string, unknown>,
  clientState: AwarenessClientIdentity,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Identity — ALWAYS the authenticated session, never the client's claim.
  const user: Record<string, unknown> = {
    id: clientState.userId,
    name: clientState.username,
    role: clientState.role,
  };
  const incomingUser = incoming.user;
  if (incomingUser && typeof incomingUser === "object") {
    const color = (incomingUser as Record<string, unknown>).color;
    if (typeof color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(color)) {
      user.color = color;
    }
  }
  out.user = user;

  if (
    typeof incoming.status === "string" &&
    AWARENESS_STATUS_VALUES.has(incoming.status)
  ) {
    out.status = incoming.status;
  }

  const activity = incoming.activity;
  if (
    activity &&
    typeof activity === "object" &&
    typeof (activity as Record<string, unknown>).type === "string" &&
    AWARENESS_ACTIVITY_VALUES.has(
      (activity as Record<string, unknown>).type as string,
    )
  ) {
    const a = activity as Record<string, unknown>;
    const cleaned: Record<string, unknown> = { type: a.type };
    if (a.detail === null) {
      cleaned.detail = null;
    } else if (
      typeof a.detail === "string" &&
      a.detail.length <= AWARENESS_MAX_DETAIL_LEN
    ) {
      cleaned.detail = a.detail;
    }
    if (typeof a.timestamp === "number" && Number.isFinite(a.timestamp)) {
      cleaned.timestamp = a.timestamp;
    }
    out.activity = cleaned;
  }

  const activeFile = sanitizeAwarenessFilePath(incoming.activeFile);
  if (activeFile !== undefined) out.activeFile = activeFile;

  // M57: working folder — where the collaborator is actually working. The
  // client derives it as dirname(activeFile); it clears the same path bar.
  const workingFolder = sanitizeAwarenessFilePath(incoming.workingFolder);
  if (workingFolder !== undefined) out.workingFolder = workingFolder;

  const cursor = incoming.cursor;
  if (cursor === null) {
    out.cursor = null;
  } else if (cursor && typeof cursor === "object") {
    const c = cursor as Record<string, unknown>;
    if (isAwarenessCoord(c.line) && isAwarenessCoord(c.column)) {
      out.cursor = { line: c.line, column: c.column };
    }
  }

  const selection = incoming.selection;
  if (selection === null) {
    out.selection = null;
  } else if (selection && typeof selection === "object") {
    const s = selection as Record<string, unknown>;
    if (
      isAwarenessCoord(s.startLine) &&
      isAwarenessCoord(s.startColumn) &&
      isAwarenessCoord(s.endLine) &&
      isAwarenessCoord(s.endColumn)
    ) {
      out.selection = {
        startLine: s.startLine,
        startColumn: s.startColumn,
        endLine: s.endLine,
        endColumn: s.endColumn,
      };
    }
  }

  // M57: user-declared intent — human-authored, ephemeral, bounded. A client
  // may only set its OWN intent (identity is forced above; this rides the same
  // rebuilt entry). `null` is an explicit clear.
  const intent = incoming.intent;
  if (intent === null) {
    out.intent = null;
  } else if (intent && typeof intent === "object") {
    const rec = intent as Record<string, unknown>;
    const text = sanitizeIntentText(rec.text);
    if (
      text.length > 0 &&
      typeof rec.updatedAt === "number" &&
      Number.isFinite(rec.updatedAt)
    ) {
      out.intent = { text, updatedAt: rec.updatedAt };
    }
  }

  if (
    typeof incoming.lastActive === "number" &&
    Number.isFinite(incoming.lastActive)
  ) {
    out.lastActive = incoming.lastActive;
  }

  // M56: the single bounded "my active file has unsaved local edits" bit.
  // A client may only report its OWN dirty state for its OWN active file.
  // Any `dirtyPaths`-style list or other extra key is structurally dropped
  // here because `out` is rebuilt from scratch and never spreads `incoming`.
  if (typeof incoming.activeFileDirty === "boolean") {
    out.activeFileDirty = incoming.activeFileDirty;
  }

  return out;
}
