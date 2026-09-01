import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { queryTimeline, queryWhileAway } from "../src/collab/timeline.js";
import {
  createThread,
  addReply,
  editComment,
  resolveThread,
  upsertReaction,
} from "../src/comments/store.js";

const anchor = {
  relStart: "QQ==",
  relEnd: "Qg==",
  slice: "x",
  startLine: 3,
  endLine: 3,
  prefixHash: "0".repeat(16),
};

function seedProject(): Db {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO users (id,username,password_hash) VALUES (1,'owner','h'),(2,'collab','h')",
  ).run();
  db.prepare("INSERT INTO projects (id,owner_id,name) VALUES ('p',1,'P')").run();
  return db;
}

describe("M61-A comment timeline source", () => {
  let db: Db;
  beforeEach(() => {
    db = seedProject();
  });

  it("emits comment lifecycle events, nothing on reaction/edit", () => {
    const { threadId, rootCommentId } = createThread(db, {
      projectId: "p",
      filePath: "src/a.ts",
      authorId: 2,
      body: "root",
      anchor,
    });
    addReply(db, { threadId, projectId: "p", authorId: 1, body: "r" });
    upsertReaction(db, rootCommentId, 1, "\u{1F44D}");
    editComment(db, { commentId: rootCommentId, authorId: 2, body: "edited" });
    resolveThread(db, { threadId, actorId: 1 });

    const t = queryTimeline(db, "p", { limit: 50 })
      .events.filter((e) => e.kind === "comment")
      .map((e) => e.title);
    expect(t.some((x) => x.startsWith("commented on"))).toBe(true);
    expect(t.some((x) => x.startsWith("replied on"))).toBe(true);
    expect(t).toContain("resolved a comment thread");
    expect(t.some((x) => /reaction|edited/.test(x))).toBe(false);
  });

  it("comment events are navigable with a file + line range", () => {
    createThread(db, {
      projectId: "p",
      filePath: "src/a.ts",
      authorId: 2,
      body: "root",
      anchor,
    });
    const ev = queryTimeline(db, "p", { limit: 50 }).events.find(
      (e) => e.kind === "comment",
    )!;
    expect(ev.navigable).toBe(true);
    expect(ev.filePath).toBe("src/a.ts");
    expect(ev.lineRange).toEqual({ startLine: 3, endLine: 3 });
  });

  it("queryWhileAway includes comment events, excludes the caller's own", () => {
    const past = "2000-01-01T00:00:00.000Z";
    createThread(db, {
      projectId: "p",
      filePath: "src/a.ts",
      authorId: 2,
      body: "from collab",
      anchor,
    });
    createThread(db, {
      projectId: "p",
      filePath: "src/b.ts",
      authorId: 1,
      body: "from owner",
      anchor,
    });
    const away = queryWhileAway(db, "p", 1, past, 50);
    const comments = away.events.filter((e) => e.kind === "comment");
    expect(comments.length).toBe(1);
    expect(comments[0].actor.userId).toBe(2);
  });
});
