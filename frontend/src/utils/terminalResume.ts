// M88 — resume a detached sandbox PTY after a same-tab remount (reload or
// project switch-back) within the M79 grace window.
//
// sessionStorage is never authorization. The id is the same client-generated
// opaque token `/ws/terminal` already accepted; the backend still keys the
// session by the authenticated (userId, projectId, terminalId) triple.
// Written only after the PTY streams data (proof the registry entry exists).
// Output, cwd, env, and secrets are not stored here.

export const TERMINAL_RESUME_PREFIX = "cloudeee_terminal_";

/** Same alphabet `/ws/terminal` accepts for a client-supplied terminalId. */
export const TERMINAL_RESUME_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function terminalResumeKey(userId: number, projectId: string): string {
  return `${TERMINAL_RESUME_PREFIX}${userId}_${projectId}`;
}

export function isPersistableTerminalUser(userId: unknown): userId is number {
  return typeof userId === "number" && Number.isInteger(userId) && userId > 0;
}

export function readTerminalResume(
  userId: number,
  projectId: string,
): string | null {
  if (!isPersistableTerminalUser(userId) || !projectId) return null;
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(terminalResumeKey(userId, projectId));
  } catch {
    return null;
  }
  if (typeof raw !== "string" || !TERMINAL_RESUME_ID_RE.test(raw)) return null;
  return raw;
}

export function writeTerminalResume(
  userId: number,
  projectId: string,
  terminalId: string,
): void {
  if (!isPersistableTerminalUser(userId) || !projectId) return;
  if (!TERMINAL_RESUME_ID_RE.test(terminalId)) return;
  try {
    sessionStorage.setItem(terminalResumeKey(userId, projectId), terminalId);
  } catch {
    /* quota / disabled — persistence is best-effort */
  }
}

export function clearTerminalResume(userId: number, projectId: string): void {
  if (!isPersistableTerminalUser(userId) || !projectId) return;
  try {
    sessionStorage.removeItem(terminalResumeKey(userId, projectId));
  } catch {
    /* ignore */
  }
}

/** Drop every resume hint in this tab. Call on logout so a later user never
 *  presents the previous user's terminalId (they would only get `ended`, but
 *  the first-open UX would be wrong). */
export function clearAllTerminalResumes(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(TERMINAL_RESUME_PREFIX)) keys.push(k);
    }
    for (const k of keys) sessionStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
