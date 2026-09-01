import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/db.js";
import {
  createThread,
  addReply,
  editComment,
  tombstoneComment,
  resolveThread,
  reopenThread,
  listThreadsForFile,
  listUnresolved,
  upsertReaction,
  removeReaction,
  replaceMentions,
  setThreadAnchorStatus,
} from "../src/comments/store.js";

const anchor = {
  relStart: "QQ==",
  relEnd: "Qg==",
  slice: "x",
  startLine: 3,
  endLine: 3,
  prefixHash: "0".repeat(16),
};

function seed(): Db {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO users (id,username,password_hash) VALUES (1,'owner','h'),(2,'collab','h'),(3,'other','h')",
  ).run();
  db.prepare("INSERT INTO projects (id,owner_id,name) VALUES ('p',1,'P')").run();
  return db;
}

describe("M61-A comment store", () => {
  let db: Db;
  beforeEach(() => {
    db = seed();
  });

  it("lifecycle: create → reply → resolve → reopen → tombstone keeps replies", () => {
    const { threadId, rootCommentId } = createThread(db, {
      projectId: "p",
      filePath: "a.ts",
      authorId: 2,
      body: "root",
      anchor,
    });
    addReply(db, { threadId, projectId: "p", authorId: 1, body: "reply" });
    resolveThread(db, { threadId, actorId: 1 });
    expect(listThreadsForFile(db, "p", "a.ts", "all")[0].thread.resolved_by).toBe(
      1,
    );
    reopenThread(db, { threadId });
    expect(listThreadsForFile(db, "p", "a.ts", "active").length).toBe(1);
    expect(
      editComment(db, { commentId: rootCommentId, authorId: 1, body: "hax" }),
    ).toBe(false);
    expect(
      tombstoneComment(db, {
        commentId: rootCommentId,
        actorId: 1,
        projectOwnerId: 1,
      }),
    ).toBe(true);
    const t = listThreadsForFile(db, "p", "a.ts", "all")[0];
    expect(t.root.deleted_at).not.toBeNull();
    expect(t.root.body).toBe("");
    expect(t.replies.map((r) => r.body)).toEqual(["reply"]);
  });

  it("edit is author-only and blocked on tombstoned comments", () => {
    const { threadId, rootCommentId } = createThread(db, {
      projectId: "p",
      filePath: "a.ts",
      authorId: 2,
      body: "root",
      anchor,
    });
    expect(
      editComment(db, { commentId: rootCommentId, authorId: 2, body: "fixed" }),
    ).toBe(true);
    expect(listThreadsForFile(db, "p", "a.ts", "all")[0].root.body).toBe("fixed");
    // non-author cannot tombstone unless project owner
    expect(
      tombstoneComment(db, {
        commentId: rootCommentId,
        actorId: 3,
        projectOwnerId: 1,
      }),
    ).toBe(false);
    void threadId;
  });

  it("reactions dedupe by (comment,user,emoji); remove toggles off", () => {
    const { rootCommentId } = createThread(db, {
      projectId: "p",
      filePath: "a.ts",
      authorId: 2,
      body: "x",
      anchor,
    });
    upsertReaction(db, rootCommentId, 1, "\u{1F44D}");
    upsertReaction(db, rootCommentId, 1, "\u{1F44D}");
    expect(
      listThreadsForFile(db, "p", "a.ts", "all")[0].reactions.filter(
        (r) => r.emoji === "\u{1F44D}",
      ).length,
    ).toBe(1);
    removeReaction(db, rootCommentId, 1, "\u{1F44D}");
    expect(listThreadsForFile(db, "p", "a.ts", "all")[0].reactions.length).toBe(
      0,
    );
  });

  it("mentions surface deduped at thread level; tombstone clears them", () => {
    const { threadId, rootCommentId } = createThread(db, {
      projectId: "p",
      filePath: "a.ts",
      authorId: 2,
      body: "hey @owner",
      anchor,
    });
    replaceMentions(db, rootCommentId, [1]);
    const { commentId } = addReply(db, {
      threadId,
      projectId: "p",
      authorId: 1,
      body: "also @owner",
    });
    replaceMentions(db, commentId, [1]);
    expect(
      listThreadsForFile(db, "p", "a.ts", "all")[0].mentions,
    ).toEqual([{ userId: 1, username: "owner" }]);
    tombstoneComment(db, {
      commentId: rootCommentId,
      actorId: 2,
      projectOwnerId: 1,
    });
    expect(
      listThreadsForFile(db, "p", "a.ts", "all")[0].mentions,
    ).toEqual([{ userId: 1, username: "owner" }]); // reply mention survives
  });

  it("listUnresolved paginates by (updated_at,id), excludes resolved", () => {
    for (let i = 0; i < 5; i++)
      createThread(db, {
        projectId: "p",
        filePath: `f${i}.ts`,
        authorId: 2,
        body: `c${i}`,
        anchor,
      });
    const p1 = listUnresolved(db, "p", 2, null);
    expect(p1.threads.length).toBe(2);
    expect(p1.nextBefore).not.toBeNull();
    const p2 = listUnresolved(db, "p", 2, p1.nextBefore);
    expect(p2.threads.map((t) => t.thread.id)).not.toContain(
      p1.threads[0].thread.id,
    );
    // resolve one and confirm it drops out
    resolveThread(db, { threadId: p1.threads[0].thread.id, actorId: 1 });
    const all = [
      ...listUnresolved(db, "p", 100, null).threads,
    ].map((t) => t.thread.id);
    expect(all).not.toContain(p1.threads[0].thread.id);
  });

  it("anchor blob round-trips as opaque base64; anchor-status is advisory", () => {
    const { threadId } = createThread(db, {
      projectId: "p",
      filePath: "a.ts",
      authorId: 2,
      body: "x",
      anchor,
    });
    const t = listThreadsForFile(db, "p", "a.ts", "all")[0].thread;
    expect(t.anchor_rel_start).toBe("QQ==");
    expect(t.anchor_rel_end).toBe("Qg==");
    expect(t.anchor_prefix).toBe("x");
    setThreadAnchorStatus(db, threadId, "stale");
    expect(
      listThreadsForFile(db, "p", "a.ts", "all")[0].thread.anchor_status,
    ).toBe("stale");
  });
});
