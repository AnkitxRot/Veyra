import { Router } from "express";
import type { Request } from "express";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import {
  getProject,
  requireOwnedProject,
  requireProjectAccess,
  workspacePath,
} from "../projects/service.js";
import { withProjectSnapshotLock } from "../projects/snapshots.js";
import { recordAuditLog } from "../audit.js";
import {
  collaborationManager,
  requireLiveEditsPersisted,
} from "../collab/manager.js";
import type { MutationType } from "../collab/manager.js";
import {
  assertNotGitInternal,
  invalidateTreeCache,
  safeResolve,
} from "../files/service.js";
import { readConfinedFile } from "../files/confined.js";
import { toGenericSecretError } from "../projectsecrets/store.js";
import * as git from "./service.js";
import * as remotes from "./remotes.js";
import {
  deleteGitHttpsCredentials,
  hasGitHttpsCredentials,
  resolveGitHttpsCredentials,
  syncGitCredentialHost,
  upsertGitHttpsCredentials,
} from "./credentials.js";
import { httpsRemoteHost, validateHttpsGitRemoteUrl } from "./remoteUrl.js";
import { registerGitSandboxOwnerResolver } from "./sandboxGit.js";

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

  // M87: Git runs in the project sandbox, charged to the project owner.
  registerGitSandboxOwnerResolver(cfg, (projectId) => {
    const owner = getProject(db, projectId)?.owner_id;
    return typeof owner === "number" ? owner : undefined;
  });

  const requireRead = (req: Request) =>
    requireProjectAccess(db, userOf(req).id, req.params.id, "viewer");
  const requireWrite = (req: Request) =>
    requireProjectAccess(db, userOf(req).id, req.params.id, "editor");

  const locked = <T>(projectId: string, fn: () => Promise<T>) =>
    withProjectSnapshotLock(projectId, fn);

  // M87: origin and its pinned credentials are resolved together, inside the
  // project lock, from the validated HTTPS URL the transport will use.
  const remoteTarget = (projectId: string) =>
    remotes.resolveRemoteTarget(cfg, projectId, (url) =>
      resolveGitHttpsCredentials(db, cfg, projectId, url),
    );

  // ---- reads -------------------------------------------------------------

  router.get("/:id/git/status", async (req, res, next) => {
    try {
      requireRead(req);
      const status = await git.getStatus(cfg, req.params.id);
      res.json({
        ...status,
        credentialsConfigured: hasGitHttpsCredentials(db, req.params.id),
      });
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
      await locked(req.params.id, async () => {
        // M86: `git add` reads the working tree, which lags the collaboration
        // room by the persistence debounce. Stage what the editor shows.
        await requireLiveEditsPersisted(req.params.id, "Nothing was staged.");
        return git.stage(cfg, req.params.id, { paths, all: all === true });
      });
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
      const force = req.body?.force === true;
      const result = await locked(req.params.id, async () => {
        // M56: preview the change set + run the initiator dirty check
        // WITHOUT switching branches, so live collaboration state can be
        // consulted before the checkout is committed. Both steps run inside
        // the same project lock as the real checkout below.
        const preview = await git.checkoutBranch(
          cfg,
          req.params.id,
          req.body?.name,
          req.body?.dirtyOpenPaths,
          { preview: true },
        );
        if (preview.ok === false) return preview;

        // Another collaborator with a KNOWN-dirty buffer in a file this
        // checkout would overwrite blocks the switch unless `force` is set.
        // "editing" alone (dirty unknown) is surfaced to the client as
        // information but does not block here.
        const collaboratorImpacts =
          collaborationManager.getCollaboratorFileState(
            req.params.id,
            preview.changedPaths,
            user.id,
          );
        if (collaboratorImpacts.some((i) => i.dirty === true) && !force) {
          throw new ApiError(
            409,
            "Another collaborator has unsaved changes in a file this checkout would overwrite. Confirm to check out anyway.",
            "collaborator_dirty_conflict",
            { collaboratorImpacts },
          );
        }

        const done = await git.checkoutBranch(
          cfg,
          req.params.id,
          req.body?.name,
          req.body?.dirtyOpenPaths,
        );
        return { ...done, collaboratorImpacts } as typeof done & {
          collaboratorImpacts: typeof collaboratorImpacts;
        };
      });
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
      //
      // `conflictedPaths` collects any file the room kept at a collaborator's
      // unsaved version (and reconverges disk to). Additive response info —
      // the branch switch itself still stands.
      const conflictedPaths = await reconcileGitWorkspaceMutation(
        cfg,
        req.params.id,
        result.changedPaths,
        "git_checkout",
        user,
      );

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
        conflictedPaths,
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- M80 remotes -------------------------------------------------------

  router.get("/:id/git/remote", async (req, res, next) => {
    try {
      requireRead(req);
      const url = await remotes.getOriginUrl(cfg, req.params.id);
      res.json({
        remote: url ? { name: remotes.ORIGIN, url } : null,
        credentialsConfigured: hasGitHttpsCredentials(db, req.params.id),
      });
    } catch (err) {
      next(err);
    }
  });

  router.put("/:id/git/remote", async (req, res, next) => {
    try {
      requireWrite(req);
      const user = userOf(req);
      const existingUrl = await remotes.getOriginUrl(cfg, req.params.id);
      const result = await locked(req.params.id, () =>
        remotes.addOriginRemote(cfg, req.params.id, req.body?.url, {
          replace: req.body?.replace === true,
        }),
      );
      syncGitCredentialHost(
        db,
        cfg,
        req.params.id,
        result.url,
        user.id,
      );
      recordAuditLog(db, {
        userId: user.id,
        projectId: req.params.id,
        eventType: "GIT_REMOTE_SET",
        details: {
          host: httpsRemoteHost(result.url),
          replaced: result.replaced,
          previousHost: existingUrl ? httpsRemoteHost(existingUrl) : null,
        },
        ipAddress: req.ip,
      });
      res.json({
        remote: { name: result.name, url: result.url },
        credentialsConfigured: hasGitHttpsCredentials(db, req.params.id),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id/git/credentials", async (req, res, next) => {
    try {
      requireRead(req);
      res.json({ configured: hasGitHttpsCredentials(db, req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/:id/git/credentials", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      if (userOf(req).username.startsWith("evaluator_")) {
        throw new ApiError(
          403,
          "demo accounts cannot store secrets",
          "demo_forbidden",
        );
      }
      let originHost: string | undefined;
      try {
        const originUrl = await remotes.getOriginUrl(cfg, project.id);
        if (originUrl) {
          originHost = httpsRemoteHost(validateHttpsGitRemoteUrl(originUrl));
        }
      } catch {
        // Not a repository yet, origin unset, or origin isn't HTTPS —
        // leave the PAT unpinned until origin is configured.
      }
      upsertGitHttpsCredentials(db, cfg, project.id, {
        username: req.body?.username,
        token: req.body?.token,
        host: originHost,
        createdBy: userOf(req).id,
      });
      recordAuditLog(db, {
        userId: userOf(req).id,
        projectId: project.id,
        eventType: "GIT_CREDENTIAL_UPDATED",
        details: { configured: true },
        ipAddress: req.ip,
      });
      res.json({ configured: true });
    } catch (err) {
      next(toGenericSecretError(err));
    }
  });

  router.delete("/:id/git/credentials", async (req, res, next) => {
    try {
      const project = requireOwnedProject(db, userOf(req).id, req.params.id);
      const removed = deleteGitHttpsCredentials(db, project.id);
      if (!removed) {
        throw new ApiError(404, "git credentials are not configured", "not_found");
      }
      recordAuditLog(db, {
        userId: userOf(req).id,
        projectId: project.id,
        eventType: "GIT_CREDENTIAL_DELETED",
        details: { configured: false },
        ipAddress: req.ip,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/git/fetch", async (req, res, next) => {
    try {
      requireWrite(req);
      const user = userOf(req);
      let credentialsUsed = false;
      const result = await locked(req.params.id, async () => {
        const target = await remoteTarget(req.params.id);
        credentialsUsed = Boolean(target.creds);
        return remotes.fetchOrigin(cfg, req.params.id, target);
      });
      recordAuditLog(db, {
        userId: user.id,
        projectId: req.params.id,
        eventType: "GIT_FETCH",
        details: {
          host: httpsRemoteHost(result.remote),
          credentialsUsed,
        },
        ipAddress: req.ip,
      });
      res.json({
        ok: true,
        status: await git.getStatus(cfg, req.params.id),
      });
    } catch (err) {
      next(toGenericSecretError(err));
    }
  });

  router.post("/:id/git/pull", async (req, res, next) => {
    try {
      requireWrite(req);
      const user = userOf(req);
      const force = req.body?.force === true;
      let credentialsUsed = false;
      const result = await locked(req.params.id, async () => {
        const target = await remoteTarget(req.params.id);
        credentialsUsed = Boolean(target.creds);
        const preview = await remotes.previewPull(
          cfg,
          req.params.id,
          req.body?.dirtyOpenPaths,
          target,
        );
        if (preview.ok === false) return preview;

        const collaboratorImpacts =
          collaborationManager.getCollaboratorFileState(
            req.params.id,
            preview.changedPaths,
            user.id,
          );
        if (collaboratorImpacts.some((i) => i.dirty === true) && !force) {
          throw new ApiError(
            409,
            "Another collaborator has unsaved changes in a file this pull would overwrite. Confirm to pull anyway.",
            "collaborator_dirty_conflict",
            { collaboratorImpacts },
          );
        }

        if (!preview.alreadyUpToDate) {
          await remotes.commitFastForwardPull(cfg, req.params.id, preview.branch);
        }
        return { ...preview, collaboratorImpacts };
      });

      if (result.ok === false) {
        res.status(409).json({
          error: {
            code: "dirty_worktree",
            message:
              "Pull would overwrite uncommitted changes. Commit or discard them first.",
          },
          blockingPaths: result.blockingPaths,
        });
        return;
      }

      const conflictedPaths = await reconcileGitWorkspaceMutation(
        cfg,
        req.params.id,
        result.changedPaths,
        "git_pull",
        user,
      );

      recordAuditLog(db, {
        userId: user.id,
        projectId: req.params.id,
        eventType: "GIT_PULL",
        details: {
          host: httpsRemoteHost(result.remote),
          branch: result.branch,
          alreadyUpToDate: result.alreadyUpToDate,
          credentialsUsed,
        },
        ipAddress: req.ip,
      });
      res.json({
        ok: true,
        branch: result.branch,
        alreadyUpToDate: result.alreadyUpToDate,
        changedPaths: result.changedPaths,
        conflictedPaths,
      });
    } catch (err) {
      next(toGenericSecretError(err));
    }
  });

  router.post("/:id/git/push", async (req, res, next) => {
    try {
      requireWrite(req);
      const user = userOf(req);
      let credentialsUsed = false;
      const result = await locked(req.params.id, async () => {
        const target = await remoteTarget(req.params.id);
        credentialsUsed = Boolean(target.creds);
        return remotes.pushCurrentBranch(cfg, req.params.id, target);
      });
      recordAuditLog(db, {
        userId: user.id,
        projectId: req.params.id,
        eventType: "GIT_PUSH",
        details: {
          host: httpsRemoteHost(result.remote),
          branch: result.branch,
          credentialsUsed,
        },
        ipAddress: req.ip,
      });
      res.json({ ok: true, branch: result.branch });
    } catch (err) {
      next(toGenericSecretError(err));
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

async function reconcileGitWorkspaceMutation(
  cfg: AppConfig,
  projectId: string,
  changedPaths: string[],
  mutationType: MutationType,
  user: { id: number; username: string },
): Promise<string[]> {
  const conflictedPaths: string[] = [];
  if (changedPaths.length === 0) return conflictedPaths;
  try {
    const cwd = await workspacePath(cfg, projectId);
    for (const rel of changedPaths) {
      // M87: `changedPaths` is sandbox Git output. Only workspace-relative,
      // non-.git paths are reconciled, and the host read is confined: a
      // checked-out symlink (or a swapped directory) that resolves outside
      // the workspace is read as "removed", never followed.
      let abs: string;
      try {
        assertNotGitInternal(rel);
        abs = safeResolve(cwd, rel);
      } catch {
        continue;
      }
      let content = "";
      try {
        content = (await readConfinedFile(cwd, abs)).content;
      } catch {
        // missing on the incoming revision, not a regular file, or outside
        // the workspace — treat as removed
      }
      const mutation = await collaborationManager.notifyExternalFileMutation(
        projectId,
        rel,
        content,
      );
      if (mutation.conflict) conflictedPaths.push(rel);
    }
    invalidateTreeCache(cwd);
  } catch {
    // Best-effort convergence; the Git mutation itself already succeeded.
  }
  collaborationManager.emitExternalMutationNotice(projectId, {
    paths: changedPaths,
    mutationType,
    actorUserId: user.id,
    actorUsername: user.username,
  });
  return conflictedPaths;
}
