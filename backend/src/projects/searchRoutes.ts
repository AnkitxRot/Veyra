import type { Router } from "express";
import type { Request, Response } from "express";
import type { Db } from "../db.js";
import { type AppConfig } from "../config.js";
import { ApiError, errorInfo } from "../errors.js";
import { requireProjectAccess, touchProject, workspacePath } from "./service.js";
import { writeProjectFile } from "../files/service.js";
import { searchGate } from "../execution/runGate.js";
import { createSnapshot } from "./snapshots.js";
import { searchProjectContent, replaceProjectContent } from "./search.js";
import { collaborationManager } from "../collab/manager.js";
import { recordAuditLog } from "../audit.js";

/**
 * Abort an in-flight search worker when the client disconnects. `res.close`
 * also fires after a normal response; `writableEnded` distinguishes the two
 * so a completed search is not terminated after the fact.
 */
function abortOnDisconnect(res: Response): AbortSignal {
  const ac = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ac.abort();
  };
  res.on("close", onClose);
  return ac.signal;
}

export function registerSearchRoutes(router: Router, cfg: AppConfig, db: Db): void {
  const userOf = (req: Request) => req.user!;

  // Full Workspace Text Search
  router.post("/:id/search", async (req, res, next) => {
    try {
      const { project } = requireProjectAccess(
        db,
        userOf(req).id,
        req.params.id as string,
        "viewer",
      );
      // Every search spawns a worker thread that can live for the full
      // worker hard timeout, so cap how many a single user can have in
      // flight at once (own budget, separate from run/install).
      const userId = userOf(req).id;
      if (!searchGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(429, "too many concurrent searches", "too_many_searches");
      }
      try {
        const cwd = await workspacePath(cfg, project.id);
        const result = await searchProjectContent(cwd, req.body ?? {}, abortOnDisconnect(res));
        if (!res.writableEnded) res.json(result);
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
        req.params.id as string,
        "viewer",
      );
      const userId = userOf(req).id;
      if (!searchGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(429, "too many concurrent searches", "too_many_searches");
      }
      try {
        const cwd = await workspacePath(cfg, project.id);
        const query = (req.query.q as string) || "";
        const isCaseSensitive = req.query.caseSensitive === "true";
        const isWholeWord = req.query.wholeWord === "true";
        const isRegex = req.query.regex === "true";
        const includePattern = req.query.include as string | undefined;
        const excludePattern = req.query.exclude as string | undefined;
        const result = await searchProjectContent(
          cwd,
          {
            query,
            isCaseSensitive,
            isWholeWord,
            isRegex,
            includePattern,
            excludePattern,
          },
          abortOnDisconnect(res),
        );
        if (!res.writableEnded) res.json(result);
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
        req.params.id as string,
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
        throw new ApiError(400, "files must be an array of strings", "invalid_files");
      }

      const userId = userOf(req).id;
      if (!searchGate.acquire(userId, cfg.maxConcurrentRuns)) {
        throw new ApiError(429, "too many concurrent searches", "too_many_searches");
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
          ? result.groups.filter((g) => (files as string[]).includes(g.filePath))
          : result.groups;

        // M56: which other connected collaborators have any of the affected
        // files open / are editing / report unsaved edits. Metadata only —
        // never file content. Used to warn the initiator in the review UI
        // and (on apply) to gate a replace over a known-dirty buffer.
        const collaboratorImpacts = collaborationManager.getCollaboratorFileState(
          project.id,
          scoped.map((g) => g.filePath),
          userOf(req).id,
        );

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
            collaboratorImpacts,
          });
          return;
        }

        // M56: refuse to overwrite another collaborator's KNOWN-dirty buffer
        // without an explicit confirmation (`force`). "editing" alone (dirty
        // state unknown) is informational and does NOT block here.
        if (collaboratorImpacts.some((i) => i.dirty === true) && req.body?.force !== true) {
          throw new ApiError(
            409,
            "Another collaborator has unsaved changes in one or more of the selected files. Confirm to replace anyway.",
            "collaborator_dirty_conflict",
            { collaboratorImpacts },
          );
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
                errorInfo(err).message || "unknown error"
              }`,
              "snapshot_failed",
            );
          }
        }

        const results: Array<{
          filePath: string;
          // "conflict" (M-followup): a live collaborator has unsaved edits in
          // this file, so the replace was NOT applied over them — distinct
          // from "skipped" (file too large / results truncated).
          status: "replaced" | "skipped" | "error" | "conflict";
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
            const mutation = await collaborationManager.notifyExternalFileMutation(
              project.id,
              group.filePath,
              group.newContent,
            );
            if (mutation.conflict) {
              // A collaborator has unsaved edits in this file in the live
              // session. Their content was preserved and reconverges disk;
              // report this file as a distinct "conflict", never a false
              // "replaced" and never a misleading "skipped (too large)".
              results.push({
                filePath: group.filePath,
                status: "conflict",
                matchCount: group.matches.length,
                reason:
                  "a collaborator has unsaved changes in this file in the live session — their version was kept",
              });
              continue;
            }
            filesChanged++;
            matchesReplaced += group.matches.length;
            results.push({
              filePath: group.filePath,
              status: "replaced",
              matchCount: group.matches.length,
            });
          } catch (err) {
            results.push({
              filePath: group.filePath,
              status: "error",
              matchCount: group.matches.length,
              reason: errorInfo(err).message || "write failed",
            });
          }
        }

        if (filesChanged > 0) {
          touchProject(db, project.id);
          if (db) {
            try {
              recordAuditLog(db, {
                userId,
                projectId: project.id,
                eventType: "SEARCH_REPLACE_APPLIED",
                // Counts only: the query/replacement text may contain secrets.
                details: { filesChanged, matchesReplaced, snapshotId: safetySnapshotId },
                ipAddress: req.ip,
              });
            } catch {}
          }
        }

        // M56: one aggregated external-mutation notice per affected
        // non-initiating collaborator (routed by their active file). The
        // Y.Doc convergence above already synced content; this is
        // informational metadata only.
        const replacedResults = results.filter((r) => r.status === "replaced");
        if (replacedResults.length > 0) {
          collaborationManager.emitExternalMutationNotice(project.id, {
            paths: replacedResults.map((r) => r.filePath),
            mutationType: "replace",
            actorUserId: userOf(req).id,
            actorUsername: userOf(req).username,
            matchCounts: Object.fromEntries(replacedResults.map((r) => [r.filePath, r.matchCount])),
          });
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
}
