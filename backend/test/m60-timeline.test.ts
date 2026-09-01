import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/db.js";
import {
  queryTimeline,
  queryWhileAway,
  encodeCursor,
  decodeCursor,
} from "../src/collab/timeline.js";

function seed(db: Db) {
  db.prepare(
    "INSERT INTO users (id,username,password_hash) VALUES (7,'rahul','h'),(8,'ankit','h')",
  ).run();
  db.prepare(
    "INSERT INTO projects (id,owner_id,name) VALUES ('p',7,'P'),('q',8,'Q')",
  ).run();

  const cc = (
    id: string,
    at: string,
    kind: "edit_burst" | "callout" = "edit_burst",
    uid = 7,
    file = "src/auth/session.ts",
    proj = "p",
  ) =>
    db
      .prepare(
        `INSERT INTO collaboration_changes
         (id,project_id,author_user_id,file_path,kind,started_at,ended_at,
          update_count,lines_added,lines_removed,start_line,end_line,detail)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        proj,
        uid,
        file,
        kind,
        at,
        at,
        3,
        8,
        0,
        kind === "edit_burst" ? 40 : null,
        kind === "edit_burst" ? 48 : null,
        kind === "callout"
          ? JSON.stringify({ messagePreview: "look here", targeted: false })
          : null,
      );

  cc("c1", "2026-08-31T10:00:00.000Z");
  cc("c2", "2026-08-31T10:05:00.000Z", "callout");
  cc("cX", "2026-08-31T10:59:00.000Z", "edit_burst", 8, "z.ts", "q"); // other project

  db.prepare(
    `INSERT INTO runs (id,project_id,user_id,language,file_path,status,exit_code,duration_ms,created_at)
     VALUES ('r1','p',7,'python','main.py','success',0,120,'2026-08-31T10:02:00.000Z')`,
  ).run();

  db.prepare(
    `INSERT INTO audit_logs (user_id,project_id,event_type,details,created_at)
     VALUES (7,'p','GIT_COMMIT',?,'2026-08-31T10:03:00.000Z')`,
  ).run(JSON.stringify({ shortHash: "abc123", subjectPreview: "Fix login UI" }));

  db.prepare(
    `INSERT INTO audit_logs (user_id,project_id,event_type,details,created_at)
     VALUES (8,'p','SNAPSHOT_RESTORED',?,'2026-08-31T10:04:00.000Z')`,
  ).run(JSON.stringify({ snapshotId: "s1", snapshotName: "pre-refactor" }));
}

describe("timeline union", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    seed(db);
  });

  it("unions all five sources for one project, newest first", () => {
    const { events } = queryTimeline(db, "p", { limit: 50 });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "edit_burst",
        "callout",
        "run",
        "commit",
        "snapshot",
      ]),
    );
    const ats = events.map((e) => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  it("never returns another project's rows", () => {
    const { events } = queryTimeline(db, "p", { limit: 50 });
    expect(events.every((e) => !e.id.includes("cX"))).toBe(true);
  });

  it("stable pagination — no entry on two pages, none skipped", () => {
    const page1 = queryTimeline(db, "p", { limit: 2 });
    const page2 = queryTimeline(db, "p", {
      limit: 2,
      before: page1.nextBefore,
    });
    const ids = new Set(page1.events.map((e) => e.id));
    expect(page2.events.every((e) => !ids.has(e.id))).toBe(true);
    const all = queryTimeline(db, "p", { limit: 50 }).events.map((e) => e.id);
    expect([...page1.events, ...page2.events].map((e) => e.id)).toEqual(
      all.slice(0, 4),
    );
  });

  it("stable pagination when one source dominates the newest rows", () => {
    // 12 collab edit bursts, all newer than every other source's rows. With a
    // page size of 3 the caller must still walk every event exactly once —
    // regression for the cursor not being pushed into each source query.
    for (let i = 0; i < 12; i++) {
      const at = `2026-08-31T12:${String(i).padStart(2, "0")}:00.000Z`;
      db.prepare(
        `INSERT INTO collaboration_changes (id,project_id,author_user_id,file_path,kind,started_at,ended_at)
         VALUES (?, 'p', 7, 'big.ts', 'edit_burst', ?, ?)`,
      ).run(`big${String(i).padStart(2, "0")}`, at, at);
    }
    const all = queryTimeline(db, "p", { limit: 100 }).events.map((e) => e.id);
    const walked: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const pg = queryTimeline(db, "p", { limit: 3, before });
      walked.push(...pg.events.map((e) => e.id));
      if (!pg.nextBefore) break;
      before = pg.nextBefore;
    }
    expect(walked).toEqual(all);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it("deterministic ordering when timestamps collide", () => {
    const same = "2026-08-31T11:00:00.000Z";
    for (const id of ["z1", "a1", "m1"]) {
      db.prepare(
        `INSERT INTO collaboration_changes (id,project_id,author_user_id,file_path,kind,started_at,ended_at)
         VALUES (?, 'p', 7, 'x.ts', 'edit_burst', ?, ?)`,
      ).run(id, same, same);
    }
    const a = queryTimeline(db, "p", { limit: 50 }).events.map((e) => e.id);
    const b = queryTimeline(db, "p", { limit: 50 }).events.map((e) => e.id);
    expect(a).toEqual(b);
  });

  it("run events carry only safe fields", () => {
    const run = queryTimeline(db, "p", { limit: 50 }).events.find(
      (e) => e.kind === "run",
    )!;
    expect(run.title).toMatch(/main\.py/);
    expect(JSON.stringify(run)).not.toMatch(/stdout|stderr|signal|peak_memory/);
  });

  it("commit title uses subjectPreview and is not navigable", () => {
    const c = queryTimeline(db, "p", { limit: 50 }).events.find(
      (e) => e.kind === "commit",
    )!;
    expect(c.title).toContain("Fix login UI");
    expect(c.navigable).toBe(false);
  });

  it("snapshot title reflects the action", () => {
    const s = queryTimeline(db, "p", { limit: 50 }).events.find(
      (e) => e.kind === "snapshot",
    )!;
    expect(s.title).toContain("restored snapshot");
    expect(s.title).toContain("pre-refactor");
  });

  it("limit is clamped to [1,100]", () => {
    expect(
      queryTimeline(db, "p", { limit: 9999 }).events.length,
    ).toBeLessThanOrEqual(100);
    expect(() => queryTimeline(db, "p", { limit: 0 })).not.toThrow();
  });

  it("while-away excludes the caller's own events and honours since", () => {
    const r = queryWhileAway(db, "p", 7, "2026-08-31T10:02:30.000Z", 50);
    expect(r.events.every((e) => e.actor.userId !== 7)).toBe(true);
    expect(r.events.every((e) => e.at > "2026-08-31T10:02:30.000Z")).toBe(true);
  });

  it("cursor round-trips", () => {
    const c = encodeCursor("2026-08-31T10:00:00.000Z", "collab:c1");
    expect(decodeCursor(c)).toEqual({
      at: "2026-08-31T10:00:00.000Z",
      id: "collab:c1",
    });
    expect(decodeCursor("garbage")).toBeNull();
  });

  it("edit_burst with a range is 'changed lines A–B' and navigable", () => {
    const e = queryTimeline(db, "p", { limit: 50 }).events.find(
      (x) => x.id === "collab:c1",
    )!;
    expect(e.title).toBe("changed lines 40–48");
    expect(e.lineRange).toEqual({ startLine: 40, endLine: 48 });
    expect(e.navigable).toBe(true);
  });
});
