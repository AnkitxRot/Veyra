import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/db.js";
import {
  createThread,
  addReply,
  resolveThread,
  replaceMentions,
  upsertReaction,
} from "../src/comments/store.js";

/**
 * M61-A: behavioural proof of the migration-v12 foreign-key cascades.
 *
 * Mirrors backend/test/m60-lifecycle.test.ts in intent (prove that deleting a
 * parent row removes exactly the descendant rows the schema promises) but stays
 * at the pure SQLite layer: openDb() runs every real migration including v12,
 * PRAGMA foreign_keys is ON, and the delete is a raw `DELETE FROM projects` /
 * `DELETE FROM users` so the assertions depend ENTIRELY on the ON DELETE
 * CASCADE / SET NULL clauses in db.ts's M61_SCHEMA_SQL. `deleteProject()` in
 * projects/service.ts does no manual comment cleanup — it relies on this
 * cascade — so this is the same behaviour a real project deletion exercises.
 *
 * Revert-sensitivity (each clause, if reverted to the SQLite default NO ACTION
 * or the wrong action, breaks a specific assertion or makes the DELETE throw
 * `FOREIGN KEY constraint failed`):
 *   comment_threads.project_id   CASCADE   -> project-delete test
 *   comments.project_id          CASCADE   -> project-delete test
 *   comments.thread_id           CASCADE   -> author-delete / root-delete tests
 *   comments.parent_comment_id   CASCADE   -> root-comment-delete test
 *   comments.author_id           CASCADE   -> author-delete test
 *   comment_threads.created_by   CASCADE   -> author-delete test
 *   comment_threads.resolved_by  SET NULL  -> resolver-delete test
 *   comment_mentions.*           CASCADE   -> project / user delete tests
 *   comment_reactions.*          CASCADE   -> project / user delete tests
 */

const anchor = {
  relStart: "QQ==",
  relEnd: "Qg==",
  slice: "needle",
  startLine: 3,
  endLine: 3,
  prefixHash: "0".repeat(16),
};

function count(db: Db, sql: string, ...params: string[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

describe("M61-A comment lifecycle — migration v12 FK cascades", () => {
  let db: Db;
  let threadId: string;
  let rootCommentId: string;
  let replyId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    // 1 owner of p1, 2 thread creator + root-comment author, 3 a member who
    // only resolves + is mentioned + reacts (authors nothing), 9 owner of an
    // UNRELATED second project used to prove the cascade is project-scoped.
    db.prepare(
      `INSERT INTO users (id,username,password_hash) VALUES
         (1,'owner','h'),(2,'author','h'),(3,'resolver','h'),(9,'other','h')`,
    ).run();
    db.prepare(
      "INSERT INTO projects (id,owner_id,name) VALUES ('p1',1,'P1'),('p2',9,'P2')",
    ).run();

    const t = createThread(db, {
      projectId: "p1",
      filePath: "src/a.ts",
      authorId: 2,
      body: "root comment",
      anchor,
    });
    threadId = t.threadId;
    rootCommentId = t.rootCommentId;
    replyId = addReply(db, {
      threadId,
      projectId: "p1",
      authorId: 1,
      body: "a reply",
    }).commentId;

    // mentions: {root -> 3}, {reply -> 2}, {reply -> 3}
    replaceMentions(db, rootCommentId, [3]);
    replaceMentions(db, replyId, [2, 3]);
    // reactions: {root,1,👍} {root,3,🎉} {reply,2,👍}
    upsertReaction(db, rootCommentId, 1, "👍");
    upsertReaction(db, rootCommentId, 3, "🎉");
    upsertReaction(db, replyId, 2, "👍");

    // an unrelated thread in p2 — must be untouched by any p1 / user mutation
    createThread(db, {
      projectId: "p2",
      filePath: "src/b.ts",
      authorId: 9,
      body: "other project root",
      anchor,
    });
  });

  it("fixture seeds every M61 table", () => {
    expect(count(db, "SELECT COUNT(*) c FROM comment_threads")).toBe(2);
    expect(count(db, "SELECT COUNT(*) c FROM comments")).toBe(3);
    expect(count(db, "SELECT COUNT(*) c FROM comment_mentions")).toBe(3);
    expect(count(db, "SELECT COUNT(*) c FROM comment_reactions")).toBe(3);
  });

  it("deleting the owning project cascade-deletes every descendant comment row — and only that project's", () => {
    db.prepare("DELETE FROM projects WHERE id = ?").run("p1");

    // p1-scoped rows gone
    expect(
      count(db, "SELECT COUNT(*) c FROM comment_threads WHERE project_id='p1'"),
    ).toBe(0);
    expect(
      count(db, "SELECT COUNT(*) c FROM comments WHERE project_id='p1'"),
    ).toBe(0);
    // comment_mentions / comment_reactions have no project_id column: they must
    // have gone via comment_id CASCADE
    expect(count(db, "SELECT COUNT(*) c FROM comment_mentions")).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM comment_reactions")).toBe(0);

    // no orphans anywhere in the chain
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM comment_threads t
           LEFT JOIN projects p ON p.id = t.project_id WHERE p.id IS NULL`,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM comments c
           LEFT JOIN comment_threads t ON t.id = c.thread_id WHERE t.id IS NULL`,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM comment_mentions m
           LEFT JOIN comments c ON c.id = m.comment_id WHERE c.id IS NULL`,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM comment_reactions r
           LEFT JOIN comments c ON c.id = r.comment_id WHERE c.id IS NULL`,
      ),
    ).toBe(0);

    // the unrelated project's thread + comment are untouched
    expect(
      count(db, "SELECT COUNT(*) c FROM comment_threads WHERE project_id='p2'"),
    ).toBe(1);
    expect(
      count(db, "SELECT COUNT(*) c FROM comments WHERE project_id='p2'"),
    ).toBe(1);
  });

  it("deleting a member who only RESOLVED a thread nulls resolved_by (SET NULL) and keeps the thread, its comments, and other members' rows", () => {
    resolveThread(db, { threadId, actorId: 3 });
    expect(
      (
        db
          .prepare("SELECT resolved_by FROM comment_threads WHERE id=?")
          .get(threadId) as { resolved_by: number | null }
      ).resolved_by,
    ).toBe(3);

    // user 3 authored no comment and created no thread — only resolved,
    // was mentioned twice, reacted once
    db.prepare("DELETE FROM users WHERE id = ?").run(3);

    const row = db
      .prepare(
        "SELECT resolved_at, resolved_by FROM comment_threads WHERE id=?",
      )
      .get(threadId) as { resolved_at: string | null; resolved_by: number | null };
    expect(row.resolved_by).toBeNull(); // ON DELETE SET NULL
    expect(row.resolved_at).not.toBeNull(); // still resolved, just author-less

    // thread + both comments survive
    expect(
      count(db, "SELECT COUNT(*) c FROM comment_threads WHERE id=?", threadId),
    ).toBe(1);
    expect(
      count(db, "SELECT COUNT(*) c FROM comments WHERE thread_id=?", threadId),
    ).toBe(2);

    // user 3's mention + reaction rows cascade away; user 1's / user 2's remain
    expect(
      count(
        db,
        "SELECT COUNT(*) c FROM comment_mentions WHERE mentioned_user_id=3",
      ),
    ).toBe(0);
    expect(
      count(db, "SELECT COUNT(*) c FROM comment_reactions WHERE user_id=3"),
    ).toBe(0);
    expect(
      count(
        db,
        "SELECT COUNT(*) c FROM comment_mentions WHERE mentioned_user_id=2",
      ),
    ).toBe(1);
    expect(
      count(db, "SELECT COUNT(*) c FROM comment_reactions WHERE user_id=1"),
    ).toBe(1);

    // no dangling mention/reaction rows
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM comment_mentions m
           LEFT JOIN users u ON u.id = m.mentioned_user_id WHERE u.id IS NULL`,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM comment_reactions r
           LEFT JOIN users u ON u.id = r.user_id WHERE u.id IS NULL`,
      ),
    ).toBe(0);
  });

  it("deleting the thread creator + root-comment author (CASCADE) removes the whole thread and its comment sub-tree", () => {
    // user 2 = comment_threads.created_by AND comments.author_id (root)
    db.prepare("DELETE FROM users WHERE id = ?").run(2);

    // comment_threads.created_by -> users ON DELETE CASCADE
    expect(
      count(db, "SELECT COUNT(*) c FROM comment_threads WHERE id=?", threadId),
    ).toBe(0);
    // comments cascade (via thread_id and/or author_id) — reply included even
    // though user 1 authored it
    expect(
      count(db, "SELECT COUNT(*) c FROM comments WHERE thread_id=?", threadId),
    ).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM comment_mentions")).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM comment_reactions")).toBe(0);

    // no orphans
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM comments c
           LEFT JOIN comment_threads t ON t.id = c.thread_id WHERE t.id IS NULL`,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM comment_mentions m
           LEFT JOIN comments c ON c.id = m.comment_id WHERE c.id IS NULL`,
      ),
    ).toBe(0);

    // the p2 thread (created by user 9) is untouched
    expect(
      count(db, "SELECT COUNT(*) c FROM comment_threads WHERE project_id='p2'"),
    ).toBe(1);
    expect(
      count(db, "SELECT COUNT(*) c FROM comments WHERE project_id='p2'"),
    ).toBe(1);
  });

  it("deleting a root comment cascade-deletes its replies (comments.parent_comment_id CASCADE) and their mention/reaction rows", () => {
    expect(
      count(db, "SELECT COUNT(*) c FROM comments WHERE thread_id=?", threadId),
    ).toBe(2);

    db.prepare("DELETE FROM comments WHERE id = ?").run(rootCommentId);

    // the reply's parent_comment_id pointed at rootCommentId -> CASCADE
    expect(
      count(db, "SELECT COUNT(*) c FROM comments WHERE id=?", replyId),
    ).toBe(0);
    // reply's mention/reaction rows go with it
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM comment_mentions m
           LEFT JOIN comments c ON c.id = m.comment_id WHERE c.id IS NULL`,
      ),
    ).toBe(0);
    expect(
      count(
        db,
        `SELECT COUNT(*) c FROM comment_reactions r
           LEFT JOIN comments c ON c.id = r.comment_id WHERE c.id IS NULL`,
      ),
    ).toBe(0);
    // p2's independent root comment is untouched
    expect(
      count(db, "SELECT COUNT(*) c FROM comments WHERE project_id='p2'"),
    ).toBe(1);
  });
});
