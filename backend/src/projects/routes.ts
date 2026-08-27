import { Router } from "express";
import type { Request } from "express";
import type { Db } from "../db.js";
import { type AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import {
  createProject,
  deleteProject,
  listProjects,
  requireOwnedProject,
  requireProjectAccess,
  listProjectCollaborators,
  addProjectCollaborator,
  removeProjectCollaborator,
  touchProject,
  workspacePath,
  projectDir,
} from "./service.js";
import { resolveInstallSpec } from "./install.js";
import {
  deleteProjectPath,
  listFiles,
  moveProjectPath,
  readProjectFile,
  tree,
  writeProjectFile,
} from "../files/service.js";
import { runProject } from "../execution/pipeline.js";
import { resolveProxyEntry } from "./proxyTargets.js";
import { sandboxManager, sandboxRun } from "../execution/sandbox.js";
import { runGate, searchGate } from "../execution/runGate.js";
import { STARTER_TEMPLATES, applyTemplate } from "./templates.js";
import {
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  deleteSnapshot,
} from "./snapshots.js";
import {
  exportProjectZip,
  importProjectZip,
  importNewProjectZip,
} from "./archive.js";
import { forkProject } from "./fork.js";
import {
  resolveSecretsForInjection,
  toGenericSecretError,
} from "../projectsecrets/store.js";
import { searchProjectContent, replaceProjectContent } from "./search.js";
import { formatProjectFile } from "./format.js";
import { telemetryHistorian } from "../execution/historian.js";
import { collaborationManager } from "../collab/manager.js";
import {
  uploadProjectFiles,
  parseMultipartFormData,
  type UploadFileItem,
} from "../files/upload.js";
import { raw, json } from "express";

export function projectRoutes(cfg: AppConfig, db: Db): Router {
  const router = Router();
  const userOf = (req: Request) => req.user!;

  router.get("/", (req, res) => {
    res.json({ projects: listProjects(db, userOf(req).id) });
  });

  router.post("/", async (req, res, next) => {
    try {
      const { name, language } = req.body ?? {};
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new ApiError(400, "name is required", "invalid_name");
      }
      const project = await createProject(cfg, db, userOf(req).id, {
        name,
        language,
      });
      res.status(201).json({ project });
    } catch (err) {
      next(err);
    }
  });

  // Starter Templates
  router.get("/templates/catalog", (_req, res) => {
    res.json({ templates: STARTER_TEMPLATES });
  });

  router.post("/from-template", async (req, res, next) => {
    try {
      const { templateId, name } = req.body ?? {};
      const tpl = STARTER_TEMPLATES.find((t) => t.id === templateId);
      if (!tpl)
        throw new ApiError(400, "Invalid template ID", "invalid_template");

      const projectName =
        typeof name === "string" && name.trim() ? name.trim() : tpl.name;
      const project = await createProject(cfg, db, userOf(req).id, {
        name: projectName,
        language: tpl.language,
      });

      const cwd = projectDir(cfg, project.id);
      await applyTemplate(cwd, tpl.id);

      res.status(201).json({ project });
    } catch (err) {
      next(err);
    }
  });

  const rawZipParser = raw({
    type: [
      "application/zip",
      "application/x-zip-compressed",
      "application/octet-stream",
      "application/x-zip",
      "application/binary",
    ],
    limit: cfg.maxArchiveUploadBytes ?? 25 * 1024 * 1024,
  });

  function getZipBuffer(req: Request): Buffer {
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      return req.body;
    }
    if (
      req.body &&
      typeof req.body.archiveBase64 === "string" &&
      req.body.archiveBase64.length > 0
    ) {
      return Buffer.from(req.body.archiveBase64, "base64");
    }
    throw new ApiError(
      400,
      "ZIP archive is required (send binary zip body or JSON archiveBase64)",
      "invalid_archive_payload",
    );
  }

  // Import new project from ZIP
  router.post("/import", rawZipParser, async (req, res, next) => {
    try {
      const zipBuffer = getZipBuffer(req);
      const name = (req.query.name as string) || req.body?.name;
      const language = (req.query.language as string) || req.body?.language;
      const result = await importNewProjectZip(
        cfg,
        db,
        userOf(req).id,
        zipBuffer,
        { name, language },
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", (req, res, next) => {
    try {
      const access = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "viewer",
      );
      res.json({ project: access.project, role: access.role });
    } catch (err) {
      next(err);
    }
  });

  // Collaborators Management
  router.get("/:id/collaborators", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "viewer");
      const collaborators = listProjectCollaborators(db, req.params.id);
      res.json({ collaborators });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/collaborators", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "owner");
      const { username, role } = req.body ?? {};
      if (typeof username !== "string" || !username.trim()) {
        throw new ApiError(400, "username is required", "invalid_username");
      }

      const targetUser = db
        .prepare("SELECT id, username FROM users WHERE username = ?")
        .get(username.trim()) as { id: number; username: string } | undefined;

      if (!targetUser) {
        throw new ApiError(
          404,
          `User "${username}" not found`,
          "user_not_found",
        );
      }

      const collabRole = role === "viewer" ? "viewer" : "editor";
      addProjectCollaborator(db, req.params.id, targetUser.id, collabRole);

      res.status(201).json({
        ok: true,
        collaborator: {
          userId: targetUser.id,
          username: targetUser.username,
          role: collabRole,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id/collaborators/:userId", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "owner");
      const targetUserId = parseInt(req.params.userId, 10);
      if (isNaN(targetUserId))
        throw new ApiError(400, "invalid user ID", "invalid_id");

      removeProjectCollaborator(db, req.params.id, targetUserId);
      collaborationManager.revokeUser(req.params.id, targetUserId);

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id/collaborators/:userId", (req, res, next) => {
    try {
      requireProjectAccess(db, userOf(req).id, req.params.id, "owner");
      const targetUserId = parseInt(req.params.userId, 10);
      const { role } = req.body ?? {};
      if (role !== "editor" && role !== "viewer") {
        throw new ApiError(
          400,
          "role must be editor or viewer",
          "invalid_role",
        );
      }

      addProjectCollaborator(db, req.params.id, targetUserId, role);
      collaborationManager.updateUserRole(req.params.id, targetUserId, role);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      await deleteProject(cfg, db, userOf(req).id, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Live Container Resource Telemetry
  router.get("/:id/stats", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "viewer",
      );
      const stats = await sandboxManager.getContainerStats(project.id);
      res.json({ stats });
    } catch (err) {
      next(err);
    }
  });

  // Historical Resource Telemetry
  router.get("/:id/telemetry", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const range = (req.query.range as any) || "5m";
      const startTime = req.query.start as string | undefined;
      const endTime = req.query.end as string | undefined;
      const maxPoints = Math.min(
        Math.max(parseInt(req.query.maxPoints as string, 10) || 60, 10),
        300,
      );

      const result = telemetryHistorian.queryProjectTelemetry(project.id, {
        range,
        startTime,
        endTime,
        maxPoints,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Per-Execution Resource Telemetry
  router.get("/:id/runs/:executionId/telemetry", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const result = telemetryHistorian.queryExecutionTelemetry(
        project.id,
        req.params.executionId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Project Health Center & Resource Health
  router.get("/:id/health", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const health = telemetryHistorian.getProjectHealth(project.id);
      res.json({ health });
    } catch (err) {
      next(err);
    }
  });

  // Active & Recent Resource Anomalies
  router.get("/:id/anomalies", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const anomalies = db
        .prepare(
          `SELECT * FROM resource_anomalies WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`,
        )
        .all(project.id);
      res.json({ anomalies });
    } catch (err) {
      next(err);
    }
  });

  // Execution / Job History
  router.get("/:id/runs", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const limit = Math.min(
        Math.max(parseInt(req.query.limit as string, 10) || 20, 1),
        100,
      );
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

      const runs = db
        .prepare(
          `
          SELECT id, project_id, user_id, language, file_path, status, exit_code, signal, duration_ms, peak_memory_bytes, created_at
          FROM runs
          WHERE project_id = ? AND user_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
        )
        .all(project.id, userOf(req).id, limit, offset);

      const totalRow = db
        .prepare(
          "SELECT COUNT(*) as total FROM runs WHERE project_id = ? AND user_id = ?",
        )
        .get(project.id, userOf(req).id) as { total: number };

      res.json({ runs, total: totalRow.total, limit, offset });
    } catch (err) {
      next(err);
    }
  });

  // Workspace Snapshot Management
  router.get("/:id/snapshots", (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const snapshots = listSnapshots(db, userOf(req).id, project.id);
      res.json({ snapshots });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/snapshots", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const { name } = req.body ?? {};
      const snapshot = await createSnapshot(
        cfg,
        db,
        userOf(req).id,
        project.id,
        name,
      );
      res.status(201).json({ snapshot });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/snapshots/:snapshotId/restore", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      await restoreSnapshot(
        cfg,
        db,
        userOf(req).id,
        project.id,
        req.params.snapshotId,
      );
      touchProject(db, project.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id/snapshots/:snapshotId", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      await deleteSnapshot(
        cfg,
        db,
        userOf(req).id,
        project.id,
        req.params.snapshotId,
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Export workspace as ZIP archive
  router.get("/:id/export", async (req, res, next) => {
    try {
      const { zipBuffer, projectName } = await exportProjectZip(
        cfg,
        db,
        userOf(req).id,
        req.params.id,
      );
      const safeFilename =
        projectName.replace(/[^a-zA-Z0-9._-]/g, "_") || "project";
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFilename}.zip"`,
      );
      res.setHeader("Content-Length", zipBuffer.length);
      res.send(zipBuffer);
    } catch (err) {
      next(err);
    }
  });

  // Import / replace workspace from ZIP archive
  router.post("/:id/import", rawZipParser, async (req, res, next) => {
    try {
      const zipBuffer = getZipBuffer(req);
      const replace =
        req.query.replace === "true" ||
        req.query.replace === "1" ||
        req.body?.replace === true;
      const result = await importProjectZip(
        cfg,
        db,
        userOf(req).id,
        req.params.id,
        zipBuffer,
        { replace },
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Fork: create a new, independently-owned project from a copy of this
  // project's workspace. Owner-only, same as export/import/upload/snapshots
  // — collaborator access would let a viewer/editor bypass export's
  // owner-only boundary via fork-then-export of the new project they own.
  router.post("/:id/fork", async (req, res, next) => {
    try {
      const { name } = req.body ?? {};
      const result = await forkProject(cfg, db, userOf(req).id, req.params.id, {
        name: typeof name === "string" ? name : undefined,
      });
      res.status(201).json({
        project: result.project,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/tree", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "viewer",
      );
      const cwd = await workspacePath(cfg, project.id);
      res.json({ tree: await tree(cwd) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/file", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "viewer",
      );
      const path = req.query.path;
      if (typeof path !== "string")
        throw new ApiError(
          400,
          "path query parameter is required",
          "invalid_path",
        );
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
        req.params.id,
        "editor",
      );
      const { path, content } = req.body ?? {};
      if (typeof path !== "string")
        throw new ApiError(400, "path is required", "invalid_path");
      if (typeof content !== "string")
        throw new ApiError(400, "content is required", "invalid_content");
      const cwd = await workspacePath(cfg, project.id);
      await writeProjectFile(cwd, path, content);
      await collaborationManager.notifyExternalFileMutation(
        project.id,
        path,
        content,
      );
      touchProject(db, project.id);
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

  const uploadParser = (req: Request, res: any, next: any) => {
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
      let overwrite =
        req.query.overwrite === "true" || req.query.overwrite === "1";

      if (contentType.includes("multipart/form-data")) {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          throw new ApiError(
            400,
            "No multipart upload body received",
            "empty_upload",
          );
        }
        const parsed = parseMultipartFormData(req.body, contentType);
        files = parsed.files;
        if (!targetDir && parsed.fields.targetDir) {
          targetDir = parsed.fields.targetDir;
        }
        if (
          !overwrite &&
          (parsed.fields.overwrite === "true" ||
            parsed.fields.overwrite === "1")
        ) {
          overwrite = true;
        }
      } else if (
        req.body &&
        (Array.isArray(req.body.files) || typeof req.body === "object")
      ) {
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

      const result = await uploadProjectFiles(
        cfg,
        db,
        userOf(req).id,
        req.params.id,
        {
          targetDir,
          overwrite,
          files,
        },
      );

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
        req.params.id,
        "editor",
      );
      const { from, to } = req.body ?? {};
      if (typeof from !== "string" || typeof to !== "string") {
        throw new ApiError(400, "from and to are required", "invalid_path");
      }
      const cwd = await workspacePath(cfg, project.id);
      // Moving a file (or a whole directory) can relocate multiple paths an
      // active collaboration room is tracking. Snapshot the affected old
      // paths before moving, then sync the room afterward: the old paths no
      // longer exist, and the new paths' content is unchanged by a rename —
      // otherwise the room's next debounced flush would resurrect a file at
      // its old path and leave the new path stuck on stale/empty content.
      const allFiles = await listFiles(cwd);
      const affected = allFiles.filter(
        (f) => f === from || f.startsWith(`${from}/`),
      );
      const result = await moveProjectPath(cwd, from, to);
      for (const oldPath of affected) {
        const newPath =
          oldPath === from ? to : `${to}${oldPath.slice(from.length)}`;
        await collaborationManager.notifyExternalFileMutation(
          project.id,
          oldPath,
          "",
        );
        try {
          const { content } = await readProjectFile(cwd, newPath);
          await collaborationManager.notifyExternalFileMutation(
            project.id,
            newPath,
            content,
          );
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
        req.params.id,
        "editor",
      );
      const { path } = req.body ?? {};
      if (typeof path !== "string")
        throw new ApiError(400, "path is required", "invalid_path");
      const cwd = await workspacePath(cfg, project.id);
      // Deleting a file (or a whole directory) can remove multiple paths an
      // active collaboration room is tracking. Snapshot which tracked files
      // fall under the deleted path before removing them from disk,
      // otherwise the room's next debounced flush would silently rewrite
      // deleted files back to disk from stale in-memory Y.Doc content.
      const allFiles = await listFiles(cwd);
      const affected = allFiles.filter(
        (f) => f === path || f.startsWith(`${path}/`),
      );
      await deleteProjectPath(cwd, path);
      for (const f of affected) {
        await collaborationManager.notifyExternalFileMutation(
          project.id,
          f,
          "",
        );
      }
      touchProject(db, project.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Full Workspace Text Search
  router.post("/:id/search", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "viewer",
      );
      // Every search spawns a worker thread that can live for the full
      // worker hard timeout, so cap how many a single user can have in
      // flight at once (own budget, separate from run/install).
      const userId = userOf(req).id;
      if (!searchGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(
          429,
          "too many concurrent searches",
          "too_many_searches",
        );
      }
      try {
        const cwd = await workspacePath(cfg, project.id);
        const result = await searchProjectContent(cwd, req.body ?? {});
        res.json(result);
      } finally {
        searchGate.release(userId);
      }
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/search", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "viewer",
      );
      const userId = userOf(req).id;
      if (!searchGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(
          429,
          "too many concurrent searches",
          "too_many_searches",
        );
      }
      try {
        const cwd = await workspacePath(cfg, project.id);
        const query = (req.query.q as string) || "";
        const isCaseSensitive = req.query.caseSensitive === "true";
        const isWholeWord = req.query.wholeWord === "true";
        const isRegex = req.query.regex === "true";
        const includePattern = req.query.include as string | undefined;
        const excludePattern = req.query.exclude as string | undefined;
        const result = await searchProjectContent(cwd, {
          query,
          isCaseSensitive,
          isWholeWord,
          isRegex,
          includePattern,
          excludePattern,
        });
        res.json(result);
      } finally {
        searchGate.release(userId);
      }
    } catch (err) {
      next(err);
    }
  });

  // Workspace-wide Search & Replace — same matching engine/worker-thread
  // protection as search above, plus the actual write step. `dryRun`
  // defaults to true (preview-only) so a client must explicitly opt into
  // `dryRun: false` to touch any file — an accidental/malformed request
  // never mutates the workspace by default.
  router.post("/:id/search/replace", async (req, res, next) => {
    try {
      const { project, role } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "editor",
      );

      const body = req.body ?? {};
      const {
        query,
        replacement,
        isCaseSensitive,
        isWholeWord,
        isRegex,
        includePattern,
        excludePattern,
        files,
        dryRun = true,
        // M50: opt-in pre-apply project snapshot so a workspace-wide replace
        // can be rolled back from the existing Snapshots tab. Owner-only
        // (snapshots are an owner capability); ignored during a dry run.
        createSafetySnapshot = false,
      } = body;

      if (typeof query !== "string" || query.trim().length === 0) {
        throw new ApiError(400, "query is required", "invalid_query");
      }
      if (typeof replacement !== "string") {
        throw new ApiError(
          400,
          "replacement is required (use an empty string to delete matches)",
          "invalid_replacement",
        );
      }
      if (
        files !== undefined &&
        (!Array.isArray(files) || files.some((f) => typeof f !== "string"))
      ) {
        throw new ApiError(
          400,
          "files must be an array of strings",
          "invalid_files",
        );
      }

      const userId = userOf(req).id;
      if (!searchGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(
          429,
          "too many concurrent searches",
          "too_many_searches",
        );
      }
      try {
        const cwd = await workspacePath(cfg, project.id);
        const result = await replaceProjectContent(cwd, {
          query,
          replacement,
          isCaseSensitive,
          isWholeWord,
          isRegex,
          includePattern,
          excludePattern,
        });

        // M50: client file selection is a convenience filter over the
        // server-computed match set, never an authority. Every selected path
        // must correspond to a file that actually matched in THIS request;
        // an unknown/unmatched/traversal path is rejected rather than
        // silently ignored, and selection can only ever narrow the set.
        if (files) {
          const matchedPaths = new Set(result.groups.map((g) => g.filePath));
          for (const f of files as string[]) {
            if (
              f.includes("..") ||
              f.startsWith("/") ||
              f.startsWith("\\") ||
              !matchedPaths.has(f)
            ) {
              throw new ApiError(
                400,
                `selected file '${f}' is not in the current match set — re-run the search and try again`,
                "invalid_file_selection",
              );
            }
          }
        }

        const scoped = files
          ? result.groups.filter((g) =>
              (files as string[]).includes(g.filePath),
            )
          : result.groups;

        if (dryRun !== false) {
          // Preview only — never touches disk. newContent is internal
          // (used only by the apply path below), not sent to the client.
          res.json({
            groups: scoped.map(({ filePath, matches }) => ({
              filePath,
              matches,
            })),
            totalMatches: scoped.reduce((n, g) => n + g.matches.length, 0),
            filesSearched: result.filesSearched,
            durationMs: result.durationMs,
            truncated: result.truncated,
            applied: false,
          });
          return;
        }

        // M50: take one project snapshot BEFORE the first workspace write so
        // the whole batch has a single rollback point (restorable from the
        // existing Snapshots tab). Fail the request here — before any file is
        // touched — if the snapshot cannot be made, exactly like the AI
        // apply-patch flow does. One snapshot per apply, never per file.
        let safetySnapshotId: string | null = null;
        if (createSafetySnapshot === true) {
          if (!(role === "owner" && project.owner_id === userOf(req).id)) {
            throw new ApiError(
              403,
              "a safety snapshot can only be created by the project owner",
              "snapshot_requires_owner",
            );
          }
          try {
            const snap = await createSnapshot(
              cfg,
              db,
              userOf(req).id,
              project.id,
              `Before Replace All: ${String(query)}`.slice(0, 64),
            );
            safetySnapshotId = snap.id;
          } catch (err) {
            if (err instanceof ApiError) throw err;
            throw new ApiError(
              500,
              `Could not create the safety snapshot before replacing: ${
                (err as any)?.message || "unknown error"
              }`,
              "snapshot_failed",
            );
          }
        }

        const results: Array<{
          filePath: string;
          status: "replaced" | "skipped" | "error";
          matchCount: number;
          reason?: string;
        }> = [];
        let filesChanged = 0;
        let matchesReplaced = 0;

        // Best-effort per-file: this is a workspace-wide batch, not a single
        // transaction, so one file's write failure (disk full, permission
        // error, etc.) must not silently abort files already written earlier
        // in the loop, and must not discard the summary of what *did*
        // succeed — it is reported as a distinct 'error' entry and the loop
        // continues.
        for (const group of scoped) {
          if (group.newContent === null) {
            results.push({
              filePath: group.filePath,
              status: "skipped",
              matchCount: group.matches.length,
              reason:
                "not all occurrences in this file were scanned (result was truncated) or the file was too large to replace safely",
            });
            continue;
          }
          try {
            await writeProjectFile(cwd, group.filePath, group.newContent);
            await collaborationManager.notifyExternalFileMutation(
              project.id,
              group.filePath,
              group.newContent,
            );
            filesChanged++;
            matchesReplaced += group.matches.length;
            results.push({
              filePath: group.filePath,
              status: "replaced",
              matchCount: group.matches.length,
            });
          } catch (err: any) {
            results.push({
              filePath: group.filePath,
              status: "error",
              matchCount: group.matches.length,
              reason: err?.message || "write failed",
            });
          }
        }

        if (filesChanged > 0) {
          touchProject(db, project.id);
        }

        res.json({
          applied: true,
          filesChanged,
          matchesReplaced,
          truncated: result.truncated,
          snapshotId: safetySnapshotId,
          results,
        });
      } finally {
        searchGate.release(userId);
      }
    } catch (err) {
      next(err);
    }
  });

  // Safe Code Auto-Formatting
  router.post("/:id/format", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "editor",
      );
      const { path, content } = req.body ?? {};
      if (typeof path !== "string")
        throw new ApiError(400, "path is required", "invalid_path");
      if (typeof content !== "string")
        throw new ApiError(400, "content is required", "invalid_content");
      const cwd = await workspacePath(cfg, project.id);
      const result = await formatProjectFile(cwd, path, content);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/run", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "editor",
      );
      const { language, stdin } = req.body ?? {};
      if (language !== undefined && typeof language !== "string") {
        throw new ApiError(
          400,
          "language must be a string",
          "invalid_language",
        );
      }
      if (stdin !== undefined && typeof stdin !== "string") {
        throw new ApiError(400, "stdin must be a string", "invalid_stdin");
      }
      const userId = userOf(req).id;
      if (!runGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(
          429,
          "concurrent execution limit reached",
          "too_many_runs",
        );
      }
      try {
        const cwd = await workspacePath(cfg, project.id);
        let secretEnv: Record<string, string> | undefined;
        try {
          const resolved = resolveSecretsForInjection(db, cfg, project.id, {
            userId,
            context: "run",
            ipAddress: req.ip,
          });
          if (Object.keys(resolved).length > 0) secretEnv = resolved;
        } catch (err) {
          throw toGenericSecretError(err);
        }
        const result = await runProject(cfg, project.id, cwd, {
          language,
          stdin,
          userId,
          secretEnv,
        });
        res.json(result);
      } finally {
        runGate.release(userId);
      }
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/install", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const userId = userOf(req).id;
      if (!runGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(
          429,
          "concurrent execution limit reached",
          "too_many_runs",
        );
      }
      try {
        const workspaceDir = await workspacePath(cfg, project.id);
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");

        const { language } = project;
        const installResult = await resolveInstallSpec({
          workspaceDir,
          language,
        });

        if (!installResult.cmd) {
          res.write(installResult.message + "\n");
          res.end();
          return;
        }

        res.write(
          `Running ${installResult.cmd} ${installResult.args.join(" ")}...\n\n`,
        );

        const result = await sandboxRun(project.id, workspaceDir, {
          command: installResult.cmd,
          args: installResult.args,
          cwd: workspaceDir,
          timeoutMs: 60000,
          kind: "build",
          config: cfg,
          userId,
          onStdout: (data) => res.write(data),
          onStderr: (data) => res.write(data),
        });

        res.write(`\nProcess exited with code ${result.exitCode}\n`);
        res.end();
      } finally {
        runGate.release(userId);
      }
    } catch (err) {
      if (!res.headersSent) {
        next(err);
      } else {
        res.write(
          `\nError: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        res.end();
      }
    }
  });

  router.use("/:id/proxy/:port", async (req, res, next) => {
    try {
      const { entry } = await resolveProxyEntry(
        db,
        userOf(req).id,
        req.params.id,
        req.params.port,
        cfg,
      );
      entry.proxy(req as any, res as any, next);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
