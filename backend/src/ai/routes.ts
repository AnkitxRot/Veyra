import { Router } from "express";
import type { Request } from "express";
import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { requireProjectAccess, workspacePath } from "../projects/service.js";
import { writeProjectFile, readProjectFile } from "../files/service.js";
import { createSnapshot } from "../projects/snapshots.js";
import { collaborationManager } from "../collab/manager.js";
import { aiProviderRegistry, type AIAction } from "./provider.js";
import { buildAIContext } from "./context.js";
import { runAIVerification } from "./verify.js";

// Stateless "revision token" for a file's content, used to detect whether
// the authoritative content has changed between when an AI patch was
// generated and when the user accepts it (stale-patch conflict detection).
function computeRevision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Resolves the content that should be treated as "current" for a given
// project + path: if a collaboration room is active, its (possibly
// unflushed) Yjs document content takes precedence over disk, since that
// is the live source of truth collaborators are editing. Otherwise, fall
// back to the on-disk content, treating a missing file as "".
async function getAuthoritativeFileContent(
  cfg: AppConfig,
  projectId: string,
  filePath: string,
): Promise<string> {
  const room = collaborationManager.getRoom(projectId);
  if (room) {
    const yText = await room.ensureFileLoaded(filePath);
    return yText.toString();
  }
  const cwd = await workspacePath(cfg, projectId);
  try {
    const { content } = await readProjectFile(cwd, filePath);
    return content;
  } catch {
    return "";
  }
}

export function aiRoutes(cfg: AppConfig, db: Db): Router {
  const router = Router({ mergeParams: true });
  const userOf = (req: Request) => req.user!;

  // 1. Execute AI Contextual Action
  router.post("/:id/ai/action", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "editor",
      );
      const {
        action,
        activeFilePath,
        selectedCode,
        selectionRange,
        diagnostics,
        searchQuery,
        providerId,
      } = req.body ?? {};

      if (!action || typeof action !== "string") {
        throw new ApiError(400, "action is required", "invalid_action");
      }
      if (!activeFilePath || typeof activeFilePath !== "string") {
        throw new ApiError(400, "activeFilePath is required", "invalid_path");
      }

      // Assemble bounded context
      const context = await buildAIContext(
        cfg,
        db,
        project.id,
        userOf(req).id,
        {
          activeFilePath,
          selectedCode,
          selectionRange,
          diagnostics,
          searchQuery,
        },
      );

      const provider = aiProviderRegistry.getProvider(providerId);
      const response = await provider.executeAction(
        action as AIAction,
        context,
      );

      const baseRevision = response.patch
        ? computeRevision(context.fileContent)
        : undefined;

      res.json({
        response: {
          ...response,
          patch: response.patch
            ? { ...response.patch, baseRevision }
            : response.patch,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // 2. Apply Reviewed Patch with Snapshot Safety & Multiplayer Sync
  router.post("/:id/ai/apply-patch", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "editor",
      );
      const {
        filePath,
        content,
        createSafetySnapshot,
        explanation,
        baseRevision,
      } = req.body ?? {};

      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new ApiError(400, "filePath is required", "invalid_path");
      }
      if (typeof content !== "string") {
        throw new ApiError(400, "content is required", "invalid_content");
      }
      if (typeof baseRevision !== "string" || !baseRevision) {
        throw new ApiError(
          400,
          "baseRevision is required",
          "invalid_base_revision",
        );
      }

      // Security: Path containment validation
      if (
        filePath.includes("..") ||
        filePath.startsWith("/") ||
        filePath.startsWith("\\")
      ) {
        throw new ApiError(
          400,
          "Invalid file path traversal attempt",
          "invalid_path",
        );
      }

      // Stale-patch conflict detection: the file's authoritative content
      // (live collaboration room content if one is active, else on-disk
      // content) must still match what the AI patch was computed against.
      // This must run before any mutation (snapshot, write, or collab
      // notify) so a stale patch can never clobber intervening changes.
      const currentContent = await getAuthoritativeFileContent(
        cfg,
        project.id,
        filePath,
      );
      const currentRevision = computeRevision(currentContent);
      if (currentRevision !== baseRevision) {
        throw new ApiError(
          409,
          "This file has changed since the AI patch was generated. Re-run the AI action to get an updated patch.",
          "stale_patch",
        );
      }

      let snapshotId: string | undefined = undefined;
      if (createSafetySnapshot) {
        // The caller explicitly opted into a rollback point before this
        // AI-applied change. Silently swallowing a failure here and
        // proceeding anyway would apply the patch while leaving the
        // caller with no way to tell "no snapshot was requested" apart
        // from "the safety snapshot they asked for silently failed" —
        // both previously returned `{ ok: true, snapshotId: undefined }`.
        // Fail the whole request instead, so the frontend's existing
        // apply-patch error handling surfaces it honestly.
        try {
          const snap = await createSnapshot(
            cfg,
            db,
            userOf(req).id,
            project.id,
            `Pre-AI Patch: ${explanation || filePath}`,
          );
          snapshotId = snap.id;
        } catch (err: any) {
          console.error("[AI] Failed to create safety snapshot:", err);
          throw new ApiError(
            500,
            `Could not create the requested safety snapshot before applying this patch: ${err.message || "unknown error"}`,
            "snapshot_failed",
          );
        }
      }

      // Materialize to workspace disk
      const cwd = await workspacePath(cfg, project.id);
      await writeProjectFile(cwd, filePath, content);

      // Notify Yjs CollaborationManager so all active collaborators converge.
      // The revision pre-check above narrows the race but is not atomic with
      // this call — a collaborator can type in between. If the live room now
      // holds unpersisted edits this patch would clobber, the mutation is
      // refused there; surface it as the same stale-patch conflict.
      const mutation = await collaborationManager.notifyExternalFileMutation(
        project.id,
        filePath,
        content,
      );
      if (mutation.conflict) {
        throw new ApiError(
          409,
          "This file changed in the live collaboration session while the patch was being applied. Re-run the AI action to get an updated patch.",
          "stale_patch",
        );
      }

      res.json({ ok: true, snapshotId });
    } catch (err) {
      next(err);
    }
  });

  // 3. Sandbox Verification Pipeline
  router.post("/:id/ai/verify", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "editor",
      );
      const {
        action,
        providerType,
        modelName,
        filePath,
        explanation,
        diffSummary,
        snapshotId,
        skipVerification,
      } = req.body ?? {};

      const result = await runAIVerification(cfg, db, {
        projectId: project.id,
        userId: userOf(req).id,
        action: action || "patch_verification",
        providerType: providerType || "deterministic",
        modelName: modelName || "CloudeeeIDE-Deterministic-V1",
        filePath: filePath || "main.py",
        explanation: explanation || "Applied reviewed code patch",
        diffSummary,
        snapshotId,
        skipVerification: Boolean(skipVerification),
      });

      res.json({ verification: result });
    } catch (err) {
      next(err);
    }
  });

  // 4. Project AI Verification History Journal
  router.get("/:id/ai/verifications", (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id,
        "viewer",
      );
      const verifications = db
        .prepare(
          `SELECT * FROM ai_verifications
           WHERE project_id = ?
           ORDER BY created_at DESC
           LIMIT 50`,
        )
        .all(project.id);

      res.json({ verifications });
    } catch (err) {
      next(err);
    }
  });

  // 5. List Available AI Providers
  router.get("/ai/providers", (_req, res) => {
    res.json({ providers: aiProviderRegistry.listProviders() });
  });

  return router;
}
