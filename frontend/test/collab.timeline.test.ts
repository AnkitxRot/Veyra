import { describe, it, expect } from "vitest";
import {
  formatTimelineEvent,
  mergeTimeline,
  groupWhileAway,
  wireToTimelineEvent,
  whileAwayLine,
} from "../src/collab/timeline";
import type { TimelineEvent, CollabChangeWire } from "../src/types";

const ev = (over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "collab:1",
  kind: "edit_burst",
  at: "2026-08-31T10:00:00.000Z",
  actor: { userId: 7, username: "rahul" },
  filePath: "src/auth/session.ts",
  title: "changed lines 40–52",
  navigable: true,
  ...over,
});

describe("frontend timeline helpers", () => {
  it("mergeTimeline de-dupes by id, sorts desc, caps", () => {
    const merged = mergeTimeline(
      [ev({ id: "a", at: "2026-08-31T10:00:00.000Z" })],
      [
        ev({ id: "a", at: "2026-08-31T10:00:00.000Z" }),
        ev({ id: "b", at: "2026-08-31T11:00:00.000Z" }),
      ],
      10,
    );
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("mergeTimeline cap drops oldest", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      ev({ id: `e${i}`, at: `2026-08-31T1${i}:00:00.000Z` }),
    );
    expect(mergeTimeline([], many, 3).map((e) => e.id)).toEqual([
      "e4",
      "e3",
      "e2",
    ]);
  });

  it("formatTimelineEvent produces relative time + safe text", () => {
    const f = formatTimelineEvent(
      ev(),
      Date.parse("2026-08-31T10:00:30.000Z"),
    );
    expect(f.actor).toBe("rahul");
    expect(f.text).toContain("changed lines 40");
    expect(f.time).toMatch(/30s|just now/);
    expect(f.navigable).toBe(true);
  });

  it("a commit event is not navigable via formatTimelineEvent", () => {
    const f = formatTimelineEvent(
      ev({ kind: "commit", filePath: undefined, navigable: false, title: 'committed "x"' }),
      Date.now(),
    );
    expect(f.navigable).toBe(false);
  });

  it("groupWhileAway groups by author, newest author first, collapses run fail→pass", () => {
    const events = [
      ev({
        id: "1",
        actor: { userId: 7, username: "rahul" },
        at: "2026-08-31T10:10:00.000Z",
      }),
      ev({
        id: "2",
        kind: "run",
        actor: { userId: 8, username: "aman" },
        at: "2026-08-31T10:05:00.000Z",
        title: "ran main.py — failed",
        filePath: "main.py",
      }),
      ev({
        id: "3",
        kind: "run",
        actor: { userId: 8, username: "aman" },
        at: "2026-08-31T10:06:00.000Z",
        title: "ran main.py — exit 0",
        filePath: "main.py",
      }),
    ];
    const g = groupWhileAway(events);
    expect(g[0].username).toBe("rahul"); // most recent event overall
    const aman = g.find((x) => x.username === "aman")!;
    expect(aman.lines.some((l) => /failed → passed/.test(l))).toBe(true);
    expect(aman.lines.length).toBe(1); // the two runs collapsed
  });

  it("whileAwayLine phrases each kind", () => {
    expect(whileAwayLine(ev({ kind: "edit_burst", filePath: "a.ts" }))).toBe(
      "edited a.ts",
    );
    expect(
      whileAwayLine(ev({ kind: "callout", filePath: "a.ts" })),
    ).toContain("callout on a.ts");
  });

  it("wireToTimelineEvent maps a wire frame", () => {
    const w: CollabChangeWire = {
      type: "collab_change",
      id: "collab:9",
      kind: "edit_burst",
      at: "2026-08-31T10:00:00.000Z",
      actor: { userId: 7, username: "rahul" },
      filePath: "a.ts",
      lineRange: null,
      updateCount: 4,
      linesAdded: 8,
      linesRemoved: 2,
    };
    const t = wireToTimelineEvent(w);
    expect(t.navigable).toBe(true);
    expect(t.title).toMatch(/changed a\.ts \(~10 lines\)/);

    const withRange = wireToTimelineEvent({
      ...w,
      lineRange: { startLine: 40, endLine: 48 },
    });
    expect(withRange.title).toBe("changed lines 40–48");
    expect(withRange.lineRange).toEqual({ startLine: 40, endLine: 48 });
  });
});
