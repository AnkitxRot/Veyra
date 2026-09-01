// M60: PURE frontend helpers for the Team Activity timeline and While You Were
// Away card. No React. Hand-synced types live in ../types.ts.

import type { TimelineEvent, CollabChangeWire } from "../types";

const KIND_ICON: Record<TimelineEvent["kind"], string> = {
  edit_burst: "✏️",
  callout: "📣",
  run: "🧪",
  commit: "⑂",
  snapshot: "📦",
  comment: "💬",
};

function relTime(atIso: string, now: number): string {
  const then = Date.parse(atIso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatTimelineEvent(
  ev: TimelineEvent,
  now: number,
): { icon: string; time: string; actor: string; text: string; navigable: boolean } {
  return {
    icon: KIND_ICON[ev.kind] ?? "•",
    time: relTime(ev.at, now),
    actor: ev.actor.username,
    text: ev.title,
    navigable: ev.navigable && !!ev.filePath,
  };
}

/** One line inside a While-You-Were-Away author group. */
export function whileAwayLine(ev: TimelineEvent): string {
  switch (ev.kind) {
    case "edit_burst":
      return ev.filePath
        ? `edited ${ev.filePath}`
        : ev.title;
    case "callout":
      return ev.filePath
        ? `left a callout on ${ev.filePath}`
        : "left a callout";
    case "run":
      return ev.title.replace(/^ran /, "ran ");
    case "commit":
      return ev.title;
    case "snapshot":
      return ev.title;
    default:
      return ev.title;
  }
}

/**
 * De-dupe by id, sort by (at DESC, id DESC) — the same total order the server
 * uses — and cap at `cap` (drop oldest). Used to fold live `collab_change`
 * events into the fetched page without reordering churn.
 */
export function mergeTimeline(
  prev: TimelineEvent[],
  incoming: TimelineEvent[],
  cap = 200,
): TimelineEvent[] {
  const byId = new Map<string, TimelineEvent>();
  for (const e of prev) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  const all = [...byId.values()].sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return all.slice(0, cap);
}

export function wireToTimelineEvent(w: CollabChangeWire): TimelineEvent {
  const changed = w.linesAdded + w.linesRemoved;
  return {
    id: w.id,
    kind: w.kind,
    at: w.at,
    actor: { userId: w.actor.userId, username: w.actor.username },
    filePath: w.filePath,
    lineRange: w.lineRange ?? undefined,
    title:
      w.kind === "callout"
        ? "left a callout"
        : w.lineRange
          ? `changed lines ${w.lineRange.startLine}–${w.lineRange.endLine}`
          : changed > 0
            ? `changed ${basename(w.filePath)} (~${changed} lines)`
            : `changed ${basename(w.filePath)}`,
    subtitle: w.calloutPreview,
    navigable: true,
  };
}

function basename(p: string): string {
  return p.split("/").pop() || p;
}

/**
 * Group events by author (most-recently-active author first), newest-first
 * within each author, and collapse a run "failed" immediately followed by a
 * "passed" on the same file into one "ran X — failed → passed" line.
 */
export function groupWhileAway(events: TimelineEvent[]): Array<{
  userId: number | null;
  username: string;
  lines: string[];
  events: TimelineEvent[];
}> {
  const byAuthor = new Map<
    number,
    { username: string; events: TimelineEvent[] }
  >();
  for (const e of events) {
    const k = e.actor.userId ?? -1;
    const g = byAuthor.get(k);
    if (g) g.events.push(e);
    else byAuthor.set(k, { username: e.actor.username, events: [e] });
  }

  const groups = [...byAuthor.entries()].map(([userId, g]) => {
    const sorted = [...g.events].sort((a, b) => (a.at < b.at ? 1 : -1));
    const lines: string[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i];
      // fail → pass collapse: ev is a passing run, and the NEXT (older) event
      // is a failing run for the same file.
      const next = sorted[i + 1];
      if (
        ev.kind === "run" &&
        /exit 0|passed/.test(ev.title) &&
        next &&
        next.kind === "run" &&
        next.filePath === ev.filePath &&
        /failed|exit [1-9]/.test(next.title)
      ) {
        lines.push(`ran ${basename(ev.filePath ?? "")} — failed → passed`);
        i++; // consume the failing run too
        continue;
      }
      lines.push(whileAwayLine(ev));
    }
    return { userId: userId === -1 ? null : userId, username: g.username, lines, events: sorted };
  });

  groups.sort((a, b) => {
    const at = a.events[0]?.at ?? "";
    const bt = b.events[0]?.at ?? "";
    return at < bt ? 1 : at > bt ? -1 : 0;
  });
  return groups;
}
