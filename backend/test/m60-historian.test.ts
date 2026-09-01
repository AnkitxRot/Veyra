import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import { CollaborationHistorian } from "../src/collab/historian.js";

function seed(db: Db) {
  db.prepare(
    "INSERT INTO users (id,username,password_hash) VALUES (7,'rahul','h'),(8,'ankit','h')",
  ).run();
  db.prepare("INSERT INTO projects (id,owner_id,name) VALUES ('p',7,'P')").run();
}

const edit = (over: Record<string, unknown> = {}) => ({
  projectId: "p",
  authorUserId: 7,
  username: "rahul",
  filePath: "a.ts",
  at: Date.now(),
  range: { startLine: 10, endLine: 10, contiguous: true },
  linesAdded: 1,
  linesRemoved: 0,
  ...over,
});

function fresh(
  db: Db,
  cfg: Parameters<CollaborationHistorian["init"]>[1],
): CollaborationHistorian {
  const Ctor = CollaborationHistorian as unknown as { new (): CollaborationHistorian };
  const h = new Ctor();
  h.init(db, cfg);
  return h;
}

describe("CollaborationHistorian", () => {
  let db: Db;
  let h: CollaborationHistorian;
  beforeEach(() => {
    db = openDb(":memory:");
    seed(db);
    h = fresh(db, resolveConfig());
  });
  afterEach(() => h.stop());

  it("a closed burst produces exactly one row", () => {
    const t = 1_000_000;
    h.recordEdit(edit({ at: t }));
    h.recordEdit(edit({ at: t + 5000 }));
    h.recordEdit(edit({ at: t + 100000, filePath: "b.ts" }));
    h.closeProjectBursts("p", "flush");
    h.flushQueue();
    const rows = db
      .prepare("SELECT * FROM collaboration_changes WHERE project_id='p'")
      .all() as Array<{ file_path: string; update_count: number }>;
    expect(rows.filter((r) => r.file_path === "a.ts")).toHaveLength(1);
    expect(rows.find((r) => r.file_path === "a.ts")!.update_count).toBe(2);
  });

  it("different author closes the first author's open burst (contaminated => null range)", () => {
    const t = 2_000_000;
    h.recordEdit(edit({ at: t, authorUserId: 7, username: "rahul" }));
    h.recordEdit(edit({ at: t + 1000, authorUserId: 8, username: "ankit" }));
    h.closeProjectBursts("p", "flush");
    h.flushQueue();
    const rahul = db
      .prepare(
        "SELECT * FROM collaboration_changes WHERE author_user_id=7 AND file_path='a.ts'",
      )
      .get() as { start_line: number | null };
    expect(rahul.start_line).toBeNull();
  });

  it("batches: N closes -> one BEGIN transaction", () => {
    const execSpy = vi.spyOn(db, "exec");
    for (let i = 0; i < 10; i++) {
      h.recordEdit(edit({ at: 3_000_000 + i * 1000, filePath: `f${i}.ts` }));
    }
    h.closeProjectBursts("p", "flush");
    h.flushQueue();
    const begins = execSpy.mock.calls.filter((c) =>
      String(c[0]).includes("BEGIN"),
    );
    expect(begins.length).toBe(1);
  });

  it("stop() closes all open bursts and flushes (no buffered loss)", () => {
    h.recordEdit(edit({ at: 4_000_000 }));
    expect(h._openBurstCount()).toBe(1);
    h.stop();
    const row = db
      .prepare("SELECT COUNT(*) c FROM collaboration_changes")
      .get() as { c: number };
    expect(row.c).toBe(1);
    expect(h._openBurstCount()).toBe(0);
  });

  it("disposeProject closes+flushes+drops that project only", () => {
    h.recordEdit(edit({ at: 5_000_000, projectId: "p" }));
    h.disposeProject("p");
    expect(h._openBurstCount()).toBe(0);
    expect(
      (
        db.prepare("SELECT COUNT(*) c FROM collaboration_changes").get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
  });

  it("recordCallout writes a kind='callout' row with only allowlisted detail", () => {
    h.recordCallout({
      projectId: "p",
      authorUserId: 7,
      username: "rahul",
      filePath: "a.ts",
      startLine: 40,
      endLine: 52,
      messagePreview: "look here",
      targeted: false,
      at: 6_000_000,
    });
    h.flushQueue();
    const row = db
      .prepare("SELECT * FROM collaboration_changes WHERE kind='callout'")
      .get() as { file_path: string; start_line: number; detail: string };
    expect(row.file_path).toBe("a.ts");
    expect(row.start_line).toBe(40);
    const detail = JSON.parse(row.detail);
    expect(Object.keys(detail).sort()).toEqual(["messagePreview", "targeted"]);
  });

  it("retention: time purge + per-project cap", () => {
    h.stop();
    h = fresh(db, {
      ...resolveConfig(),
      collabHistoryRetentionDays: 1,
      collabHistoryMaxPerProject: 3,
    });
    const old = "2000-01-01T00:00:00.000Z";
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO collaboration_changes
         (id,project_id,author_user_id,file_path,kind,started_at,ended_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(`old${i}`, "p", 7, "a.ts", "edit_burst", old, old);
    }
    for (let i = 0; i < 5; i++) {
      h.recordEdit(edit({ at: 7_000_000 + i * 20000, filePath: `n${i}.ts` }));
    }
    h.closeProjectBursts("p", "flush");
    h.flushQueue();
    h.purgeExpired();
    const rows = db
      .prepare("SELECT id FROM collaboration_changes")
      .all() as Array<{ id: string }>;
    expect(rows.every((r) => !r.id.startsWith("old"))).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(3);
  });

  it("open-burst map is capped (oldest force-closed)", () => {
    h.stop();
    h = fresh(db, { ...resolveConfig(), collabOpenBurstsMax: 3 });
    for (let i = 0; i < 5; i++) {
      h.recordEdit(edit({ at: 8_000_000 + i, filePath: `c${i}.ts` }));
    }
    expect(h._openBurstCount()).toBeLessThanOrEqual(3);
  });

  it("reconnect (same userId) does not duplicate — extends or reopens", () => {
    const t = 9_000_000;
    h.recordEdit(edit({ at: t }));
    h.closeAuthorBursts("p", 7, "disconnect");
    h.recordEdit(edit({ at: t + 2000 }));
    h.closeProjectBursts("p", "flush");
    h.flushQueue();
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) c FROM collaboration_changes WHERE file_path='a.ts'",
          )
          .get() as { c: number }
      ).c,
    ).toBe(2);
  });

  it("broadcasts each closed burst once", () => {
    const bc = vi.fn();
    h.setBroadcaster(bc);
    h.recordEdit(edit({ at: 10_000_000 }));
    h.closeProjectBursts("p", "flush");
    expect(bc).toHaveBeenCalledTimes(1);
    expect(bc.mock.calls[0][0]).toBe("p");
    expect(
      (bc.mock.calls[0][1] as { actor: { userId: number } }).actor.userId,
    ).toBe(7);
  });

  it("contaminateFile forces null range on the matching open burst", () => {
    const t = 11_000_000;
    h.recordEdit(
      edit({
        at: t,
        filePath: "x.ts",
        range: { startLine: 3, endLine: 3, contiguous: true },
      }),
    );
    h.contaminateFile("p", "x.ts");
    h.recordEdit(
      edit({
        at: t + 500,
        filePath: "x.ts",
        range: { startLine: 4, endLine: 4, contiguous: true },
      }),
    );
    h.closeProjectBursts("p", "flush");
    h.flushQueue();
    const row = db
      .prepare("SELECT * FROM collaboration_changes WHERE file_path='x.ts'")
      .get() as { start_line: number | null };
    expect(row.start_line).toBeNull();
  });

  it("queue-size flush at 100 rows", () => {
    for (let i = 0; i < 101; i++) {
      h.recordCallout({
        projectId: "p",
        authorUserId: 7,
        username: "rahul",
        filePath: `q${i}.ts`,
        startLine: null,
        endLine: null,
        messagePreview: "x",
        targeted: false,
        at: 12_000_000 + i,
      });
    }
    // at least one auto-flush happened before we reached 101
    expect(h._queueLength()).toBeLessThan(101);
  });
});
