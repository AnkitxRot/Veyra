import type { Router } from "express";
import type { Request } from "express";
import { makeZipHelpers } from "./routeShared.js";
import type { Db } from "../db.js";
import { type AppConfig } from "../config.js";
import {
  requireOwnedProject,
  requireProjectAccess,
  touchProject,
  workspacePath,
} from "./service.js";
import { createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot } from "./snapshots.js";
import { exportProjectZip, importProjectZip } from "./archive.js";
import { forkProject } from "./fork.js";
import { discoverWorkflow } from "../workflow/discover.js";

export function registerSnapshotRoutes(router: Router, cfg: AppConfig, db: Db): void {
  const userOf = (req: Request) => req.user!;
  const { rawZipParser, getZipBuffer } = makeZipHelpers(cfg);

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
      const snapshot = await createSnapshot(cfg, db, userOf(req).id, project.id, name);
      res.status(201).json({ snapshot });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/snapshots/:snapshotId/restore", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const { conflictedPaths } = await restoreSnapshot(
        cfg,
        db,
        userOf(req).id,
        project.id,
        req.params.snapshotId,
      );
      touchProject(db, project.id);
      // `conflictedPaths` is additive: files whose disk was rolled back but
      // whose live collaborative buffer (with a collaborator's unsaved edits)
      // was kept and reconverges disk. Empty in the common case.
      res.json({ ok: true, conflictedPaths });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id/snapshots/:snapshotId", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      await deleteSnapshot(cfg, db, userOf(req).id, project.id, req.params.snapshotId);
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
        req.params.id as string,
      );
      const safeFilename = projectName.replace(/[^a-zA-Z0-9._-]/g, "_") || "project";
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}.zip"`);
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
        req.query.replace === "true" || req.query.replace === "1" || req.body?.replace === true;
      // M56: opt-in override when a live collab room's unsaved edits cannot
      // be flushed within the safety window.
      const force =
        req.query.force === "true" || req.query.force === "1" || req.body?.force === true;
      const result = await importProjectZip(
        cfg,
        db,
        userOf(req).id,
        req.params.id as string,
        zipBuffer,
        {
          replace,
          force,
          actorUsername: userOf(req).username,
        },
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

  router.get("/:id/workflow", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id as string,
        "viewer",
      );
      const cwd = await workspacePath(cfg, project.id);
      res.json(await discoverWorkflow(cwd));
    } catch (err) {
      next(err);
    }
  });
}
