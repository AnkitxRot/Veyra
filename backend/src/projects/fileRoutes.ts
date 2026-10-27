import type { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db.js";
import { type AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { z } from "zod";
import { checkedString, parseInput } from "../validate.js";
import { requireProjectAccess, touchProject, workspacePath } from "./service.js";
import {
  deleteProjectPath,
  listFiles,
  moveProjectPath,
  readProjectFile,
  treeListing,
  writeProjectFile,
} from "../files/service.js";
import { recordAuditLog } from "../audit.js";
import { collaborationManager } from "../collab/manager.js";
import {
  uploadProjectFiles,
  parseMultipartFormData,
  type UploadFileItem,
} from "../files/upload.js";
import { raw, json } from "express";

export function registerFileRoutes(router: Router, cfg: AppConfig, db: Db): void {
  const userOf = (req: Request) => req.user!;

  router.get("/:id/tree", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id as string,
        "viewer",
      );
      const cwd = await workspacePath(cfg, project.id);
      const listing = await treeListing(cwd);
      res.json({
        tree: listing.tree,
        truncated: listing.truncated,
        scanned: listing.scanned,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/file", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id as string,
        "viewer",
      );
      const path = req.query.path;
      if (typeof path !== "string")
        throw new ApiError(400, "path query parameter is required", "invalid_path");
      const cwd = await workspacePath(cfg, project.id);
      res.json(await readProjectFile(cwd, path));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/file", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id as string,
        "editor",
      );
      const { path, content } = parseInput(
        z.object({
          path: checkedString("path is required", "invalid_path"),
          content: checkedString("content is required", "invalid_content"),
        }),
        req.body ?? {},
      );
      const cwd = await workspacePath(cfg, project.id);
      await writeProjectFile(cwd, path, content);
      if (db) {
        try {
          recordAuditLog(db, {
            userId: userOf(req).id,
            projectId: project.id,
            eventType: "FILE_UPLOADED",
            details: { path, size: Buffer.byteLength(content, "utf8") },
            ipAddress: req.ip,
          });
        } catch {}
      }
      const mutation = await collaborationManager.notifyExternalFileMutation(
        project.id,
        path,
        content,
      );
      touchProject(db, project.id);
      if (mutation.conflict) {
        // A collaborator has unsaved edits in this file in the live session.
        // Their content was preserved and will be re-persisted over this
        // write; report the conflict rather than a misleading success.
        throw new ApiError(
          409,
          "This file has unsaved changes from another collaborator in the live session. Your save was not applied over their edits.",
          "collab_external_conflict",
        );
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  const uploadRawParser = raw({
    type: ["multipart/form-data", "application/octet-stream"],
    limit: cfg.maxAggregateUploadBytes ?? 25 * 1024 * 1024,
  });

  const uploadJsonParser = json({
    limit: cfg.maxAggregateUploadBytes ?? 25 * 1024 * 1024,
  });

  const uploadParser = (req: Request, res: Response, next: NextFunction) => {
    const contentType = req.headers["content-type"] || "";
    if (
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/octet-stream")
    ) {
      return uploadRawParser(req, res, next);
    }
    return uploadJsonParser(req, res, next);
  };

  // Direct Workspace File & Folder Upload
  router.post("/:id/upload", uploadParser, async (req, res, next) => {
    try {
      const contentType = req.headers["content-type"] || "";
      let files: UploadFileItem[] = [];
      let targetDir = (req.query.targetDir as string) || "";
      let overwrite = req.query.overwrite === "true" || req.query.overwrite === "1";

      if (contentType.includes("multipart/form-data")) {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          throw new ApiError(400, "No multipart upload body received", "empty_upload");
        }
        const parsed = parseMultipartFormData(req.body, contentType);
        files = parsed.files;
        if (!targetDir && parsed.fields.targetDir) {
          targetDir = parsed.fields.targetDir;
        }
        if (!overwrite && (parsed.fields.overwrite === "true" || parsed.fields.overwrite === "1")) {
          overwrite = true;
        }
      } else if (req.body && (Array.isArray(req.body.files) || typeof req.body === "object")) {
        const body = req.body;
        if (!targetDir && typeof body.targetDir === "string") {
          targetDir = body.targetDir;
        }
        if (!overwrite && body.overwrite === true) {
          overwrite = true;
        }
        const rawFiles = Array.isArray(body.files) ? body.files : [];
        files = rawFiles.map((f: any) => ({
          path: String(f.path || ""),
          buffer: Buffer.isBuffer(f.content)
            ? f.content
            : f.encoding === "base64"
              ? Buffer.from(String(f.content || ""), "base64")
              : Buffer.from(String(f.content ?? ""), "utf8"),
        }));
      } else {
        throw new ApiError(
          400,
          "Upload requires multipart/form-data or JSON payload",
          "invalid_payload",
        );
      }

      const result = await uploadProjectFiles(cfg, db, userOf(req).id, req.params.id as string, {
        targetDir,
        overwrite,
        files,
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/move", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id as string,
        "editor",
      );
      const { from, to } = parseInput(
        z.object({
          from: checkedString("from and to are required", "invalid_path"),
          to: checkedString("from and to are required", "invalid_path"),
        }),
        req.body ?? {},
      );
      const cwd = await workspacePath(cfg, project.id);
      // Moving a file (or a whole directory) can relocate multiple paths an
      // active collaboration room is tracking. Snapshot the affected old
      // paths before moving, then sync the room afterward: the old paths no
      // longer exist, and the new paths' content is unchanged by a rename —
      // otherwise the room's next debounced flush would resurrect a file at
      // its old path and leave the new path stuck on stale/empty content.
      const allFiles = await listFiles(cwd);
      const affected = allFiles.filter((f) => f === from || f.startsWith(`${from}/`));
      const result = await moveProjectPath(cwd, from, to);
      for (const oldPath of affected) {
        const newPath = oldPath === from ? to : `${to}${oldPath.slice(from.length)}`;
        await collaborationManager.notifyExternalFileMutation(project.id, oldPath, "");
        try {
          const { content } = await readProjectFile(cwd, newPath);
          await collaborationManager.notifyExternalFileMutation(project.id, newPath, content);
        } catch {}
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/delete", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id as string,
        "editor",
      );
      const { path } = parseInput(
        z.object({ path: checkedString("path is required", "invalid_path") }),
        req.body ?? {},
      );
      const cwd = await workspacePath(cfg, project.id);
      // Deleting a file (or a whole directory) can remove multiple paths an
      // active collaboration room is tracking. Snapshot which tracked files
      // fall under the deleted path before removing them from disk,
      // otherwise the room's next debounced flush would silently rewrite
      // deleted files back to disk from stale in-memory Y.Doc content.
      const allFiles = await listFiles(cwd);
      const affected = allFiles.filter((f) => f === path || f.startsWith(`${path}/`));
      await deleteProjectPath(cwd, path);
      for (const f of affected) {
        await collaborationManager.notifyExternalFileMutation(project.id, f, "");
      }
      touchProject(db, project.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}
