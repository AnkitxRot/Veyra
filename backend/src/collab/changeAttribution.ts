// M60: PURE burst state machine. No db, no WebSocket, no filesystem, no timers,
// no Y.* runtime imports. Every rule below is proven by
// backend/test/m60-change-attribution.test.ts and argued from
// docs/superpowers/specs/2026-08-31-m60-change-attribution-history-design.md §4/§5.

export interface EditInput {
  projectId: string;
  authorUserId: number;
  username: string;
  filePath: string;
  /** epoch ms of the transaction */
  at: number;
  /**
   * Best-effort span from the Y.Text observer. `null` when the observer did not
   * fire (bare AbstractType) or the delta was unusable — treated the same as an
   * ambiguous range for §5 (the burst then persists file-level).
   */
  range: { startLine: number; endLine: number; contiguous: boolean } | null;
  linesAdded: number;
  linesRemoved: number;
}

export interface OpenBurst {
  key: string;
  projectId: string;
  authorUserId: number;
  username: string;
  filePath: string;
  kind: "edit_burst";
  startedAt: number;
  endedAt: number;
  lastEditAt: number;
  updateCount: number;
  linesAdded: number;
  linesRemoved: number;
  /** merged, sorted set of touched line intervals; >1 ⇒ non-contiguous ⇒ null range */
  intervals: Array<[number, number]>;
  /** another author (or an external/disk mutation) touched this file mid-burst */
  rangeContaminated: boolean;
  /** any folded edit had `range === null` or `contiguous === false` */
  observerMissed: boolean;
}

export type CloseReason =
  | "idle"
  | "max_age"
  | "author_switch"
  | "flush"
  | "disconnect"
  | "dispose"
  | "shutdown"
  | "external_mutation"
  | "cap";

export interface ClosedBurst {
  key: string;
  projectId: string;
  authorUserId: number;
  username: string;
  filePath: string;
  kind: "edit_burst";
  startedAt: number;
  endedAt: number;
  updateCount: number;
  linesAdded: number;
  linesRemoved: number;
  rangeContaminated: boolean;
  observerMissed: boolean;
  startLine: number | null;
  endLine: number | null;
  closeReason: CloseReason;
}

export function burstKey(
  projectId: string,
  authorUserId: number,
  filePath: string,
): string {
  return `${projectId}:${authorUserId}:${filePath}`;
}

/** Insert `next` and merge overlapping/adjacent intervals (adjacent = gap ≤ 1 line). */
function foldInterval(
  intervals: Array<[number, number]>,
  next: [number, number],
): void {
  const lo = Math.min(next[0], next[1]);
  const hi = Math.max(next[0], next[1]);
  intervals.push([lo, hi]);
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + 1) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  intervals.length = 0;
  intervals.push(...merged);
}

function applyRange(b: OpenBurst, input: EditInput): void {
  if (!input.range || !input.range.contiguous) {
    b.observerMissed = true;
    return;
  }
  foldInterval(b.intervals, [input.range.startLine, input.range.endLine]);
}

export function openBurst(input: EditInput): OpenBurst {
  const b: OpenBurst = {
    key: burstKey(input.projectId, input.authorUserId, input.filePath),
    projectId: input.projectId,
    authorUserId: input.authorUserId,
    username: input.username,
    filePath: input.filePath,
    kind: "edit_burst",
    startedAt: input.at,
    endedAt: input.at,
    lastEditAt: input.at,
    updateCount: 1,
    linesAdded: input.linesAdded,
    linesRemoved: input.linesRemoved,
    intervals: [],
    rangeContaminated: false,
    observerMissed: false,
  };
  applyRange(b, input);
  return b;
}

/** Mutates `b` in place. */
export function extendBurst(b: OpenBurst, input: EditInput): void {
  b.updateCount += 1;
  b.endedAt = input.at;
  b.lastEditAt = input.at;
  b.linesAdded += input.linesAdded;
  b.linesRemoved += input.linesRemoved;
  applyRange(b, input);
}

/** The next edit for this key arrives at `now`: must the open burst close first? */
export function shouldCloseForNextEdit(
  b: OpenBurst,
  now: number,
  idleMs: number,
  maxMs: number,
): boolean {
  return now - b.lastEditAt > idleMs || now - b.startedAt > maxMs;
}

/** The sweep timer runs at `now`: is this burst stale enough to close with no follow-up edit? */
export function isStale(
  b: OpenBurst,
  now: number,
  idleMs: number,
  maxMs: number,
): boolean {
  return now - b.lastEditAt > idleMs || now - b.startedAt > maxMs;
}

export function markContaminated(b: OpenBurst): void {
  b.rangeContaminated = true;
}

/** Compact convenience used by the historian's live-broadcast shaping. */
export function summarizeBurst(b: OpenBurst): {
  updateCount: number;
  linesAdded: number;
  linesRemoved: number;
} {
  return {
    updateCount: b.updateCount,
    linesAdded: b.linesAdded,
    linesRemoved: b.linesRemoved,
  };
}

export function closeBurst(b: OpenBurst, reason: CloseReason): ClosedBurst {
  // §5: an exact range survives ONLY when nothing contaminated it, every folded
  // edit contributed a usable contiguous span, and the union is one interval.
  const rangeOk =
    !b.rangeContaminated && !b.observerMissed && b.intervals.length === 1;
  return {
    key: b.key,
    projectId: b.projectId,
    authorUserId: b.authorUserId,
    username: b.username,
    filePath: b.filePath,
    kind: b.kind,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    updateCount: b.updateCount,
    linesAdded: b.linesAdded,
    linesRemoved: b.linesRemoved,
    rangeContaminated: b.rangeContaminated,
    observerMissed: b.observerMissed,
    startLine: rangeOk ? b.intervals[0][0] : null,
    endLine: rangeOk ? b.intervals[0][1] : null,
    closeReason: reason,
  };
}
