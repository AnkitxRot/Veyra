import { Router } from "express";
import type { Request } from "express";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { requireProjectAccess } from "../projects/service.js";
import { sanitizeAwarenessFilePath } from "../collab/presence.js";
import { RateLimiter } from "../collab/attention.js";
import { collaborationManager } from "../collab/manager.js";
import { recordAuditLog } from "../audit.js";
import {
  COMMENT_MAX_LEN,
  isEmoji,
  isAnchorPayload,
  parseMentionIds,
  sanitizeCommentBody,
} from "./validate.js";
import * as store from "./store.js";
import type {
  CommentRow,
  ReactionRow,
  ThreadWithComments,
} from "./store.js";

/**
 * M61-A comment REST. Every handler opens with `requireProjectAccess`. Actor
 * identity is ALWAYS `userOf(req)` — no body field is ever read for identity
 * or project scope. All timestamps are server-set. Bodies render text-only
 * on the client; the server stores them verbatim after control-char
 * stripping.
 */

interface CommentDTO {
  id: string;
  threadId: string;
  parentId: string | null;
  authorId: number;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  reactions: { emoji: string; userIds: number[] }[];
}

interface CommentThreadDTO {
  id: string;
  projectId: string;
  filePath: string;
  anchor: {
    relStart: string | null;
    relEnd: string | null;
    slice: string;
    startLine: number;
    endLine: number;
    prefixHash: string;
  };
  anchorStatus: string;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: number | null;
  root: CommentDTO;
  replies: CommentDTO[];
  mentions: { userId: number; username: string }[];
}

function reactionsFor(
  commentId: string,
  reactions: ReactionRow[],
): { emoji: string; userIds: number[] }[] {
  const byEmoji = new Map<string, number[]>();
  for (const r of reactions) {
    if (r.comment_id !== commentId) continue;
    const arr = byEmoji.get(r.emoji) ?? [];
    arr.push(r.user_id);
    byEmoji.set(r.emoji, arr);
  }
  return [...byEmoji.entries()].map(([emoji, userIds]) => ({ emoji, userIds }));
}

function commentDTO(c: CommentRow, reactions: ReactionRow[]): CommentDTO {
  return {
    id: c.id,
    threadId: c.thread_id,
    parentId: c.parent_comment_id,
    authorId: c.author_id,
    body: c.body,
    createdAt: c.created_at,
    editedAt: c.edited_at,
    deletedAt: c.deleted_at,
    reactions: reactionsFor(c.id, reactions),
  };
}

function threadDTO(t: ThreadWithComments): CommentThreadDTO {
  return {
    id: t.thread.id,
    projectId: t.thread.project_id,
    filePath: t.thread.file_path,
    anchor: {
      relStart: t.thread.anchor_rel_start,
      relEnd: t.thread.anchor_rel_end,
      slice: t.thread.anchor_prefix,
      startLine: t.thread.anchor_start_line,
      endLine: t.thread.anchor_end_line,
      prefixHash: t.thread.anchor_prefix_hash,
    },
    anchorStatus: t.thread.anchor_status,
    createdBy: t.thread.created_by,
    createdAt: t.thread.created_at,
    updatedAt: t.thread.updated_at,
    resolvedAt: t.thread.resolved_at,
    resolvedBy: t.thread.resolved_by,
    root: commentDTO(t.root, t.reactions),
    replies: t.replies.map((r) => commentDTO(r, t.reactions)),
    mentions: t.mentions,
  };
}

export function commentRoutes(cfg: AppConfig, db: Db): Router {
  const router = Router();
  const userOf = (req: Request) => req.user!;

  // Per-(user, project) sliding-window limiter for create/reply/edit.
  const limiters = new Map<string, RateLimiter>();
  function rateLimit(userId: number, projectId: string): void {
    const key = `${userId}:${projectId}`;
    let rl = limiters.get(key);
    if (!rl) {
      rl = new RateLimiter(cfg.commentWriteWindowMs, cfg.commentWriteMax);
      limiters.set(key, rl);
    }
    if (!rl.tryConsume(Date.now())) {
      throw new ApiError(429, "comment rate limit exceeded", "rate_limited");
    }
  }

  function validMentions(projectId: string, raw: unknown): number[] {
    return parseMentionIds(raw).filter((id) => {
      try {
        requireProjectAccess(db, id, projectId, "viewer");
        return true;
      } catch {
        return false;
      }
    });
  }

  function findThread(projectId: string, threadId: string) {
    const row = db
      .prepare(
        "SELECT * FROM comment_threads WHERE id = ? AND project_id = ?",
      )
      .get(threadId, projectId) as
      | { id: string; file_path: string; anchor_start_line: number }
      | undefined;
    if (!row) throw new ApiError(404, "thread not found", "not_found");
    return row;
  }

  function threadResponse(projectId: string, threadId: string) {
    const row = db
      .prepare("SELECT file_path FROM comment_threads WHERE id = ?")
      .get(threadId) as { file_path: string } | undefined;
    if (!row) throw new ApiError(404, "thread not found", "not_found");
    const one = store
      .listThreadsForFile(db, projectId, row.file_path, "all")
      .find((t) => t.thread.id === threadId);
    if (!one) throw new ApiError(404, "thread not found", "not_found");
    return threadDTO(one);
  }

  function emit(projectId: string, threadId: string, filePath: string, kind: string) {
    collaborationManager.broadcastCommentEvent(projectId, {
      threadId,
      filePath,
      kind,
      at: Date.now(),
    });
  }

  function deliverMentions(
    projectId: string,
    filePath: string,
    threadId: string,
    commentId: string,
    line: number,
    author: { userId: number; username: string },
    body: string,
    mentionIds: number[],
  ) {
    const preview = body.replace(/\s+/g, " ").trim().slice(0, 120);
    for (const id of mentionIds) {
      if (id === author.userId) continue;
      collaborationManager.sendCommentMentionTo(projectId, id, {
        threadId,
        commentId,
        filePath,
        line,
        author,
        preview,
        at: Date.now(),
      });
    }
  }

  // -------------------------------------------------------------------------
  // GET — list threads for a file, or the project-wide unresolved roll-up
  // -------------------------------------------------------------------------
  router.get("/:id/comments", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "viewer");
      const projectId = req.params.id;
      const fileParam = req.query.file;
      const statusParam =
        typeof req.query.status === "string" ? req.query.status : "active";
      const status: store.ThreadStatusFilter =
        statusParam === "resolved" || statusParam === "all"
          ? statusParam
          : "active";
      const limit = Math.max(
        1,
        Math.min(100, Number(req.query.limit) || 50),
      );
      const before =
        typeof req.query.before === "string" ? req.query.before : null;

      if (typeof fileParam === "string" && fileParam.length > 0) {
        const file = sanitizeAwarenessFilePath(fileParam);
        if (!file) throw new ApiError(400, "invalid file path", "invalid_path");
        const threads = store
          .listThreadsForFile(db, projectId, file, status)
          .map(threadDTO);
        return res.json({ threads, nextBefore: null });
      }
      const page = store.listUnresolved(db, projectId, limit, before);
      return res.json({
        threads: page.threads.map(threadDTO),
        nextBefore: page.nextBefore,
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST — create a thread + root comment
  // -------------------------------------------------------------------------
  router.post("/:id/comments", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "editor");
      const projectId = req.params.id;
      const actor = userOf(req);
      const b = req.body ?? {};
      const file = sanitizeAwarenessFilePath(b.filePath);
      if (!file) throw new ApiError(400, "invalid file path", "invalid_path");
      if (!isAnchorPayload(b.anchor)) {
        throw new ApiError(400, "invalid anchor", "invalid_anchor");
      }
      const body = sanitizeCommentBody(b.body);
      if (body == null) {
        throw new ApiError(
          400,
          `comment body must be 1-${COMMENT_MAX_LEN} chars`,
          "invalid_body",
        );
      }
      const mentions = validMentions(projectId, b.mentions);
      rateLimit(actor.id, projectId);

      const { threadId, rootCommentId } = store.createThread(db, {
        projectId,
        filePath: file,
        authorId: actor.id,
        body,
        anchor: b.anchor,
      });
      if (mentions.length > 0) store.replaceMentions(db, rootCommentId, mentions);

      emit(projectId, threadId, file, "created");
      deliverMentions(
        projectId,
        file,
        threadId,
        rootCommentId,
        b.anchor.startLine,
        { userId: actor.id, username: actor.username },
        body,
        mentions,
      );
      recordAuditLog(db, {
        userId: actor.id,
        projectId,
        eventType: "COMMENT_ADDED",
        details: { threadId, filePath: file },
      });
      res.json({ thread: threadResponse(projectId, threadId) });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST — reply (one level; parent forced to root)
  // -------------------------------------------------------------------------
  router.post("/:id/comments/:threadId/replies", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "editor");
      const projectId = req.params.id;
      const actor = userOf(req);
      const thread = findThread(projectId, req.params.threadId);
      const body = sanitizeCommentBody((req.body ?? {}).body);
      if (body == null) {
        throw new ApiError(400, "invalid comment body", "invalid_body");
      }
      const mentions = validMentions(projectId, (req.body ?? {}).mentions);
      rateLimit(actor.id, projectId);

      const { commentId } = store.addReply(db, {
        threadId: thread.id,
        projectId,
        authorId: actor.id,
        body,
      });
      if (mentions.length > 0) store.replaceMentions(db, commentId, mentions);

      emit(projectId, thread.id, thread.file_path, "replied");
      deliverMentions(
        projectId,
        thread.file_path,
        thread.id,
        commentId,
        thread.anchor_start_line,
        { userId: actor.id, username: actor.username },
        body,
        mentions,
      );
      res.json({ thread: threadResponse(projectId, thread.id) });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PATCH — edit (author only)
  // -------------------------------------------------------------------------
  router.patch("/:id/comments/:commentId", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "editor");
      const projectId = req.params.id;
      const actor = userOf(req);
      const row = db
        .prepare(
          "SELECT thread_id, project_id FROM comments WHERE id = ?",
        )
        .get(req.params.commentId) as
        | { thread_id: string; project_id: string }
        | undefined;
      if (!row || row.project_id !== projectId) {
        throw new ApiError(404, "comment not found", "not_found");
      }
      const body = sanitizeCommentBody((req.body ?? {}).body);
      if (body == null) {
        throw new ApiError(400, "invalid comment body", "invalid_body");
      }
      rateLimit(actor.id, projectId);
      const ok = store.editComment(db, {
        commentId: req.params.commentId,
        authorId: actor.id,
        body,
      });
      if (!ok) {
        throw new ApiError(403, "only the author can edit", "forbidden");
      }
      if ((req.body ?? {}).mentions !== undefined) {
        store.replaceMentions(
          db,
          req.params.commentId,
          validMentions(projectId, req.body.mentions),
        );
      }
      const thread = db
        .prepare("SELECT file_path FROM comment_threads WHERE id = ?")
        .get(row.thread_id) as { file_path: string };
      emit(projectId, row.thread_id, thread.file_path, "edited");
      res.json({ thread: threadResponse(projectId, row.thread_id) });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE — tombstone (author OR project owner)
  // -------------------------------------------------------------------------
  router.delete("/:id/comments/:commentId", (req, res, next) => {
    try {
      const access = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "editor",
      );
      const projectId = req.params.id;
      const actor = userOf(req);
      const row = db
        .prepare("SELECT thread_id, project_id FROM comments WHERE id = ?")
        .get(req.params.commentId) as
        | { thread_id: string; project_id: string }
        | undefined;
      if (!row || row.project_id !== projectId) {
        throw new ApiError(404, "comment not found", "not_found");
      }
      const ok = store.tombstoneComment(db, {
        commentId: req.params.commentId,
        actorId: actor.id,
        projectOwnerId: access.project.owner_id,
      });
      if (!ok) {
        throw new ApiError(
          403,
          "only the author or project owner can delete",
          "forbidden",
        );
      }
      const thread = db
        .prepare("SELECT file_path FROM comment_threads WHERE id = ?")
        .get(row.thread_id) as { file_path: string };
      emit(projectId, row.thread_id, thread.file_path, "deleted");
      res.json({ thread: threadResponse(projectId, row.thread_id) });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST resolve / reopen (editor; idempotent)
  // -------------------------------------------------------------------------
  router.post("/:id/comments/:threadId/resolve", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "editor");
      const projectId = req.params.id;
      const actor = userOf(req);
      const thread = findThread(projectId, req.params.threadId);
      store.resolveThread(db, { threadId: thread.id, actorId: actor.id });
      emit(projectId, thread.id, thread.file_path, "resolved");
      recordAuditLog(db, {
        userId: actor.id,
        projectId,
        eventType: "COMMENT_RESOLVED",
        details: { threadId: thread.id },
      });
      res.json({ thread: threadResponse(projectId, thread.id) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/comments/:threadId/reopen", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "editor");
      const projectId = req.params.id;
      const thread = findThread(projectId, req.params.threadId);
      store.reopenThread(db, { threadId: thread.id });
      emit(projectId, thread.id, thread.file_path, "reopened");
      res.json({ thread: threadResponse(projectId, thread.id) });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Reactions (editor; fixed set; PK dedupe)
  // -------------------------------------------------------------------------
  router.put("/:id/comments/:commentId/reactions/:emoji", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "editor");
      const projectId = req.params.id;
      const actor = userOf(req);
      const emoji = decodeURIComponent(req.params.emoji);
      if (!isEmoji(emoji)) {
        throw new ApiError(400, "unsupported reaction", "invalid_emoji");
      }
      const row = db
        .prepare("SELECT thread_id, project_id FROM comments WHERE id = ?")
        .get(req.params.commentId) as
        | { thread_id: string; project_id: string }
        | undefined;
      if (!row || row.project_id !== projectId) {
        throw new ApiError(404, "comment not found", "not_found");
      }
      store.upsertReaction(db, req.params.commentId, actor.id, emoji);
      const thread = db
        .prepare("SELECT file_path FROM comment_threads WHERE id = ?")
        .get(row.thread_id) as { file_path: string };
      emit(projectId, row.thread_id, thread.file_path, "reacted");
      res.json({ thread: threadResponse(projectId, row.thread_id) });
    } catch (err) {
      next(err);
    }
  });

  router.delete(
    "/:id/comments/:commentId/reactions/:emoji",
    (req, res, next) => {
      try {
        requireProjectAccess(db, userOf(req).id, req.params.id, "editor");
        const projectId = req.params.id;
        const actor = userOf(req);
        const emoji = decodeURIComponent(req.params.emoji);
        if (!isEmoji(emoji)) {
          throw new ApiError(400, "unsupported reaction", "invalid_emoji");
        }
        const row = db
          .prepare("SELECT thread_id, project_id FROM comments WHERE id = ?")
          .get(req.params.commentId) as
          | { thread_id: string; project_id: string }
          | undefined;
        if (!row || row.project_id !== projectId) {
          throw new ApiError(404, "comment not found", "not_found");
        }
        store.removeReaction(db, req.params.commentId, actor.id, emoji);
        const thread = db
          .prepare("SELECT file_path FROM comment_threads WHERE id = ?")
          .get(row.thread_id) as { file_path: string };
        emit(projectId, row.thread_id, thread.file_path, "reacted");
        res.json({ thread: threadResponse(projectId, row.thread_id) });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Anchor status (editor; advisory)
  // -------------------------------------------------------------------------
  router.post("/:id/comments/:threadId/anchor-status", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "editor");
      const projectId = req.params.id;
      const thread = findThread(projectId, req.params.threadId);
      const status = (req.body ?? {}).status;
      if (status !== "ok" && status !== "stale") {
        throw new ApiError(400, "invalid anchor status", "invalid_status");
      }
      store.setThreadAnchorStatus(db, thread.id, status);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
