import { Router } from "express";
import type { Request } from "express";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { requireProjectAccess, workspacePath } from "../projects/service.js";
import { withProjectSnapshotLock } from "../projects/snapshots.js";
import { recordAuditLog } from "../audit.js";
import { collaborationManager } from "../collab/manager.js";
import { invalidateTreeCache } from "../files/service.js";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import * as git from "./service.js";

/**
 * M51 — local Git version control API.
 *
 * Reads require `viewer`; writes require `editor` (both resolved through the
 * existing IDOR-safe `requireProjectAccess`). Every write is serialized on
 * the existing per-project snapshot lock — no second application lock — so
 * concurrent editor collaborators can never corrupt the index/refs.
 */
export function gitRoutes(cfg: AppConfig, db: Db): Router {
  const router = Router({ mergeParams: true });
  const userOf = (req: Request) => req.user!;

  const requireRead = (req: Request) =>
    requireProjectAccess(db, userOf(req).id, req.params.id, "viewer");
  const requireWrite = (req: Request) =>
    requireProjectAccess(db, userOf(req).id, req.params.id, "editor");

  const locked = <T>(projectId: string, fn: () => Promise<T>) =>
    withProjectSnapshotLock(projectId, fn);

  // ---- reads -------------------------------------------------------------

  router.get("/:id/git/status", async (req, res, next) => {
    try {
      requireRead(req);
      res.json(await git.getStatus(cfg, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/git/diff", async (req, res, next) => {
    try {
      requireRead(req);
      res.json({ files: await git.getDiffStat(cfg, req.params.id, false) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/git/diff/staged", async (req, res, next) => {
    try {
      requireRead(req);
      res.json({ files: await git.getDiffStat(cfg, req.params.id, true) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/git/diff/file", async (req, res, next) => {
    try {
      requireRead(req);
      const path = req.query.path;
      if (typeof path !== "string" || !path) {
        throw new ApiError(400, "path query is required", "invalid_path");
      }
      const staged = req.query.staged === "true" || req.query.staged === "1";
      res.json(await git.getFileDiff(cfg, req.params.id, path, staged));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/git/log", async (req, res, next) => {
    try {
      requireRead(req);
      const limit = req.query.limit
        ? parseInt(String(req.query.limit), 10)
        : undefined;
      res.json({ commits: await git.getLog(cfg, req.params.id, limit) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/git/commit/:hash", async (req, res, next) => {
    try {
      requireRead(req);
      res.json({
        files: await git.getCommitFiles(cfg, req.params.id, req.params.hash),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/git/branches", async (req, res, next) => {
    try {
      requireRead(req);
      res.json(await git.listBranches(cfg, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // ---- writes (serialized) ---------------------------------------------

  router.post("/:id/git/init", async (req, res, next) => {
    try {
      requireWrite(req);
      const user = userOf(req);
      const result = await locked(req.params.id, () =>
        git.initRepository(cfg, req.params.id, { username: user.username }),
      );
      if (result.initialized) {
        recordAuditLog(db, {
          userId: user.id,
          projectId: req.params.id,
          eventType: "GIT_INIT",
          details: { branch: result.branch },
          ipAddress: req.ip,
        });
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/git/stage", async (req, res, next) => {
    try {
      requireWrite(req);
      const { paths, all } = req.body ?? {};
      await locked(req.params.id, () =>
        git.stage(cfg, req.params.id, { paths, all: all === true }),
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/git/unstage", async (req, res, next) => {
    try {
      requireWrite(req);
      const { paths, all } = req.body ?? {};
      await locked(req.params.id, () =>
        git.unstage(cfg, req.params.id, { paths, all: all === true }),
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/git/commit", async (req, res, next) => {
    try {
      requireWrite(req);
      const user = userOf(req);
      const result = await locked(req.params.id, () =>
        git.commit(cfg, req.params.id, req.body?.message, {
          username: user.username,
        }),
      );
      recordAuditLog(db, {
        userId: user.id,
        projectId: req.params.id,
        eventType: "GIT_COMMIT",
        // A preview of the subject only — never the full message body, which
        // could contain content the user considers sensitive.
        details: {
          shortHash: result.shortHash,
          subjectPreview: result.subject.slice(0, 120),
        },
        ipAddress: req.ip,
      });
      res.json({ hash: result.hash, shortHash: result.shortHash });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/git/branches", async (req, res, next) => {
    try {
      requireWrite(req);
      const user = userOf(req);
      const result = await locked(req.params.id, () =>
        git.createBranch(cfg, req.params.id, req.body?.name),
      );
      recordAuditLog(db, {
        userId: user.id,
        projectId: req.params.id,
        eventType: "GIT_BRANCH_CREATED",
        details: { name: result.name },
        ipAddress: req.ip,
      });
      res.json({ ok: true, name: result.name });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/git/checkout", async (req, res, next) => {
    try {
      requireWrite(req);
      const user = userOf(req);
      const result = await locked(req.params.id, () =>
        git.checkoutBranch(
          cfg,
          req.params.id,
          req.body?.name,
          req.body?.dirtyOpenPaths,
        ),
      );
      if (result.ok === false) {
        res.status(409).json({
          error: {
            code: "checkout_conflict",
            message:
              "Checkout would overwrite uncommitted changes. Commit or discard them first.",
          },
          blockingPaths: result.blockingPaths,
        });
        return;
      }

      // A checkout rewrote workspace files under the editor. Flow the new
      // on-disk content through the SAME external-file-mutation path every
      // other bulk workspace change already uses (Replace All, AI apply,
      // snapshot restore), so an active collaboration room converges instead
      // of silently desyncing. The frontend additionally reconciles clean
      // solo buffers and protects dirty ones from `changedPaths`.
      if (result.changedPaths.length > 0) {
        try {
          const cwd = await workspacePath(cfg, req.params.id);
          for (const rel of result.changedPaths) {
            let content = "";
            try {
              content = await fsp.readFile(join(cwd, rel), "utf8");
            } catch {
              // file does not exist on the target branch — treat as removed
            }
            await collaborationManager.notifyExternalFileMutation(
              req.params.id,
              rel,
              content,
            );
          }
          invalidateTreeCache(cwd);
        } catch {
          // Best-effort convergence; the checkout itself already succeeded.
        }
      }

      recordAuditLog(db, {
        userId: user.id,
        projectId: req.params.id,
        eventType: "GIT_CHECKOUT",
        details: { branch: result.branch },
        ipAddress: req.ip,
      });
      res.json({
        branch: result.branch,
        changedPaths: result.changedPaths,
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id/git/branches/:name", async (req, res, next) => {
    try {
      requireWrite(req);
      const user = userOf(req);
      const force = req.body?.force === true || req.query.force === "true";
      const result = await locked(req.params.id, () =>
        git.deleteBranch(cfg, req.params.id, req.params.name, force),
      );
      recordAuditLog(db, {
        userId: user.id,
        projectId: req.params.id,
        eventType: "GIT_BRANCH_DELETED",
        details: { name: result.name, forced: result.forced },
        ipAddress: req.ip,
      });
      res.json({ ok: true, name: result.name });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
