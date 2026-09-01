// M54 collaborative run-awareness helpers. Extracted from
// CollaboratorAvatarStack.tsx (M57) so TeamPanel can reuse the exact same
// "which run, and how do we phrase it" logic — one source of truth.

import type { RunStatusEntry } from "../../types";

/** A collaborator's most relevant run: an active run wins over a lingering
 *  terminal one; among terminal ones, the most recent. */
export function pickRunForUser(
  entries: RunStatusEntry[],
  userId: number,
): RunStatusEntry | null {
  const mine = entries.filter((e) => e.userId === userId);
  if (mine.length === 0) return null;
  const running = mine.find((e) => e.state === "running");
  if (running) return running;
  return mine.reduce((a, b) =>
    (b.endedAt ?? b.startedAt) > (a.endedAt ?? a.startedAt) ? b : a,
  );
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatRunText(entry: RunStatusEntry, now: number): string {
  const base = entry.file ? entry.file.split("/").pop() : null;
  if (entry.state === "running") {
    return `Running ${base ?? "code"}${
      entry.language ? ` · ${entry.language}` : ""
    } · ${formatElapsed(now - entry.startedAt)}`;
  }
  const label = base ?? "run";
  if (entry.state === "success") return `${label} exited ${entry.exitCode ?? 0}`;
  if (entry.state === "failed") return `${label} failed`;
  return `${label} stopped`;
}
