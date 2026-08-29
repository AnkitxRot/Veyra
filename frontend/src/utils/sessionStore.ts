// Session restore: per-project working-set persistence + project deep-links.
//
// FRONTEND-ONLY. localStorage is never authorization — a stored project id is
// only a hint for which project to *ask the backend for*; the backend's
// existing access checks are unchanged. Nothing here persists editor text,
// unsaved buffers, tokens, cookies, secrets, or any project data beyond
// workspace-relative file paths and which UI panel was selected.

export const BOTTOM_PANEL_TABS = [
  "output",
  "problems",
  "resources",
  "terminal",
  "preview",
  "git",
] as const;
export type BottomPanelTab = (typeof BOTTOM_PANEL_TABS)[number];

export interface ProjectSession {
  /** workspace-relative paths of open editor tabs, in tab order */
  openTabs: string[];
  /** path of the active tab (must be one of openTabs), or null */
  active: string | null;
  /** which bottom panel was selected, or null for "use the default" */
  bottomTab: BottomPanelTab | null;
}

const MAX_TABS = 50;
const LAST_PROJECT_KEY = "cloudeee_last_project";
const sessionKey = (projectId: string) => `cloudeee_session_${projectId}`;

const isBottomTab = (v: unknown): v is BottomPanelTab =>
  typeof v === "string" &&
  (BOTTOM_PANEL_TABS as readonly string[]).includes(v);

function sanitizeTabs(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of input) {
    if (typeof t !== "string" || t.length === 0) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TABS) break;
  }
  return out;
}

/** Read a project's persisted session. Never throws; returns null on any
 *  missing / malformed / corrupt state. */
export function readProjectSession(projectId: string): ProjectSession | null {
  if (!projectId) return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(sessionKey(projectId));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const o = parsed as Record<string, unknown>;
  const openTabs = sanitizeTabs(o.openTabs);
  const active =
    typeof o.active === "string" && openTabs.includes(o.active)
      ? o.active
      : null;
  const bottomTab = isBottomTab(o.bottomTab) ? o.bottomTab : null;

  return { openTabs, active, bottomTab };
}

/** Persist a project's session. Sanitizes before storing and swallows storage
 *  errors (quota exceeded, storage disabled) — persistence is best-effort. */
export function writeProjectSession(
  projectId: string,
  session: ProjectSession,
): void {
  if (!projectId) return;
  const openTabs = sanitizeTabs(session.openTabs);
  const active =
    session.active && openTabs.includes(session.active) ? session.active : null;
  const bottomTab = isBottomTab(session.bottomTab) ? session.bottomTab : null;
  try {
    localStorage.setItem(
      sessionKey(projectId),
      JSON.stringify({ openTabs, active, bottomTab }),
    );
  } catch {
    /* non-fatal */
  }
}

export function clearProjectSession(projectId: string): void {
  if (!projectId) return;
  try {
    localStorage.removeItem(sessionKey(projectId));
  } catch {
    /* non-fatal */
  }
}

export function getLastProjectId(): string | null {
  try {
    const v = localStorage.getItem(LAST_PROJECT_KEY);
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function setLastProjectId(projectId: string): void {
  if (!projectId) return;
  try {
    localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    /* non-fatal */
  }
}

// --------------------------------------------------------------------------
// Pure project-resolution + route helpers
// --------------------------------------------------------------------------

export interface ProjectResolution {
  /** the project id to open, or null (empty state / show the picker) */
  projectId: string | null;
  /** an explicit /p/:id was supplied but is not in the accessible list —
   *  the caller MUST NOT open a different project and MUST NOT show a
   *  "project opened" state */
  invalidRoute: boolean;
}

/**
 * Priority: explicit /p/:id  →  persisted last project  →  first project  →  none.
 * An explicit route that cannot be resolved is a hard stop (`invalidRoute`),
 * never a silent substitution.
 */
export function resolveProjectSelection(input: {
  routeProjectId: string | null;
  lastProjectId: string | null;
  projectIds: string[];
}): ProjectResolution {
  const known = new Set(input.projectIds);

  if (input.routeProjectId) {
    return known.has(input.routeProjectId)
      ? { projectId: input.routeProjectId, invalidRoute: false }
      : { projectId: null, invalidRoute: true };
  }
  if (input.lastProjectId && known.has(input.lastProjectId)) {
    return { projectId: input.lastProjectId, invalidRoute: false };
  }
  return { projectId: input.projectIds[0] ?? null, invalidRoute: false };
}

/** `/p/<id>` → `<id>` (decoded); anything else → null. */
export function parseProjectRoute(pathname: string): string | null {
  const m = /^\/p\/([^/?#]+)\/?$/.exec(pathname || "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]) || null;
  } catch {
    return m[1] || null;
  }
}

/**
 * Whether the IDE should auto-open a freshly created starter's entry file.
 * Returns the path to open, or null to stand down. Mirrors the guards of the
 * one-shot session-restore effect: never over a real restored session, never
 * once the user has opened a tab, and only for the project the hint targets
 * once its tree has finished loading.
 */
export function resolvePendingEntryOpen(input: {
  projectId: string | undefined;
  pending: { projectId: string; path: string } | null;
  treeLoadedFor: string | null;
  openFileCount: number;
  hasSession: boolean;
}): string | null {
  const { projectId, pending } = input;
  if (!projectId || !pending) return null;
  if (pending.projectId !== projectId) return null;
  if (input.treeLoadedFor !== projectId) return null;
  if (input.openFileCount > 0) return null;
  if (input.hasSession) return null;
  return pending.path;
}

export function projectPath(projectId: string): string {
  return `/p/${encodeURIComponent(projectId)}`;
}
