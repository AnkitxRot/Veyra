import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { recordAuditLog } from "../audit.js";
import { getProject, projectDir, touchProject } from "../projects/service.js";
import { listFiles, invalidateTreeCache } from "../files/service.js";
import { withProjectSnapshotLock, snapshotDir } from "../projects/snapshots.js";
import { extractZipArchive } from "../projects/zip.js";
import { collaborationManager } from "../collab/manager.js";
import { sandboxManager } from "../execution/sandbox.js";
import { telemetryHistorian } from "../execution/historian.js";
import {
  assertValidProjectId,
  generousArchiveConfig,
  listWorkspaceBackups,
  type WorkspaceBackupManifest,
} from "./workspaceBackup.js";

/**
 * Milestone 32 — Per-Project Workspace & Snapshot Restore.
 *
 * Admin-only. Restores an EXISTING project's workspace files and (for a
 * v2-manifest backup) its snapshot bodies + DB rows from a Milestone 31
 * backup archive, in place. Deliberately out of scope: recreating a
 * project that has since been deleted (restore requires the target
 * project to currently exist), and restoring one project's backup into a
 * *different* project (the manifest's own `projectId` must match the
 * route's `:projectId` exactly).
 *
 * TRANSACTION SHAPE — PREPARE / QUIESCE / SWAP / RECONNECT / VERIFY /
 * ROLLBACK, in that order:
 *
 *   PREPARE (outside the per-project lock): resolve and validate the
 *   requested backup via `listWorkspaceBackups` (never a raw filesystem
 *   path built from request input), extract it into an isolated staging
 *   directory with full `extractZipArchive` re-validation (traversal,
 *   symlinks, corruption — never skipped just because the artifact is
 *   server-generated), parse and validate `manifest.json`.
 *
 *   QUIESCE (inside `withProjectSnapshotLock`): dispose the live
 *   collaboration room, stop the sandbox (which transitively kills any
 *   `docker exec` terminal PTYs running inside it and aborts any in-flight
 *   execution — an accepted, documented consequence of overwriting the
 *   files that execution was running against), dispose telemetry
 *   historian in-memory state. Matches M21's `importProjectZip` teardown
 *   sequence exactly.
 *
 *   SWAP: rename (never delete-then-hope) the current workspace and
 *   snapshot directories into a rollback-staging area FIRST, then move the
 *   validated staged content into their place, then replace the
 *   `snapshots` DB rows inside one SQL transaction (delete current rows
 *   for this project, insert the manifest's rows, preserving original
 *   id/name/size/timestamp). A v1-manifest backup restores workspace files
 *   only — snapshot bodies/rows are explicitly left untouched, not deleted
 *   and not restored, since a v1 manifest carries no trustworthy row
 *   metadata to reconstruct with (see `restoreWorkspaceBackup`'s own
 *   handling below).
 *
 *   RECONNECT: dispose the collaboration room a SECOND time immediately
 *   after the swap. This is a TARGETED MITIGATION for a real race, not a
 *   claim of impossibility: `withProjectSnapshotLock` is a purely
 *   in-process lock and does not gate new-room creation on WS reconnect,
 *   so a client that reconnects during the swap window can create a fresh
 *   room reading pre-swap content. Disposing again forces that room's
 *   clients to reconnect once more, this time reading the correctly
 *   restored files. See `backend/test/workspace-restore.test.ts` for the
 *   test that deliberately creates a room mid-window and proves this.
 *
 *   VERIFY: workspace file count and (for v2) snapshot row/body counts
 *   must match the manifest. Any mismatch triggers ROLLBACK rather than
 *   reporting success.
 *
 *   ROLLBACK: on any SWAP/VERIFY failure, the (possibly bad) new content
 *   is moved to a quarantine directory (never deleted — inspectable for
 *   diagnosis), the original pre-restore content is moved back from
 *   rollback-staging, and the DB rows captured before the delete are
 *   re-inserted. Failure is always reported structurally; success is
 *   never fabricated.
 *
 * NAMED RESIDUAL RISK: there is no single transaction spanning the
 * filesystem swap and the SQL snapshot-row replace — this codebase has no
 * cross-domain primitive for that, consistent with M31's own accepted
 * per-project-eventual-consistency model. A hard process crash in the
 * narrow window between the filesystem rename and the SQL COMMIT could
 * leave an inconsistent intermediate state. This window contains no
 * I/O-bound work and is kept as short as practically possible, but
 * universal atomicity is not claimed.
 */

export interface WorkspaceRestoreResult {
  backupFilename: string;
  manifestVersion: 1 | 2;
  projectId: string;
  workspaceFileCount: number;
  snapshotRestored: {
    attempted: boolean;
    restoredCount: number;
    skippedReason?: string;
  };
  deletedUserFallback: {
    count: number;
    snapshotIds: string[];
  };
  durationMs: number;
}

const SNAPSHOT_ID_RE = /^[0-9a-f-]{36}$/i;
const V1_SKIP_REASON =
  "manifest predates per-snapshot metadata (v1); snapshot bodies were not restored";

function assertValidManifest(
  manifest: any,
  expectedProjectId: string,
): asserts manifest is WorkspaceBackupManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new ApiError(
      400,
      "Missing or invalid backup manifest",
      "invalid_manifest",
    );
  }
  if (manifest.version !== 1 && manifest.version !== 2) {
    throw new ApiError(
      400,
      `Unsupported backup manifest version: ${manifest.version}`,
      "unsupported_manifest_version",
    );
  }
  if (manifest.projectId !== expectedProjectId) {
    throw new ApiError(
      400,
      "Backup manifest project ID does not match the target project",
      "project_mismatch",
    );
  }
  if (typeof manifest.workspaceFileCount !== "number") {
    throw new ApiError(400, "Malformed backup manifest", "invalid_manifest");
  }
  if (manifest.version === 2) {
    if (!Array.isArray(manifest.snapshots)) {
      throw new ApiError(
        400,
        "Malformed v2 manifest: snapshots field missing or invalid",
        "invalid_manifest",
      );
    }
    for (const s of manifest.snapshots) {
      if (
        !s ||
        typeof s.id !== "string" ||
        !SNAPSHOT_ID_RE.test(s.id) ||
        typeof s.name !== "string" ||
        typeof s.userId !== "number" ||
        typeof s.sizeBytes !== "number" ||
        typeof s.createdAt !== "string"
      ) {
        throw new ApiError(
          400,
          "Malformed v2 manifest: invalid snapshot metadata entry",
          "invalid_manifest",
        );
      }
    }
  }
}

interface StagedRestore {
  stagingDir: string;
  manifest: WorkspaceBackupManifest;
}

/**
 * PREPARE — resolves and fully validates the requested backup, staged
 * outside the per-project lock (mirroring M21/M31's own "stage first,
 * lock only for the swap" precedent) so the potentially-slow extraction
 * I/O never holds up other operations on this project.
 */
async function prepareRestoreStaging(
  cfg: AppConfig,
  projectId: string,
  filename: string,
): Promise<StagedRestore> {
  assertValidProjectId(projectId);

  const backups = await listWorkspaceBackups(cfg, projectId);
  const match = backups.find((b) => b.filename === filename);
  if (!match) {
    throw new ApiError(404, "Workspace backup not found", "not_found");
  }

  const stagingDir = join(cfg.dataDir, `tmp_workspace_restore_${randomUUID()}`);
  await fs.mkdir(stagingDir, { recursive: true });

  try {
    const zipBuffer = await fs.readFile(match.filePath);
    // Full re-validation (traversal, symlinks, corruption) even though
    // this archive is server-generated — never trust provenance over
    // actual re-verification, matching M30's own DB-restore philosophy.
    await extractZipArchive(zipBuffer, stagingDir, generousArchiveConfig(cfg));

    let manifest: any;
    try {
      const raw = await fs.readFile(join(stagingDir, "manifest.json"), "utf8");
      manifest = JSON.parse(raw);
    } catch (err: any) {
      throw new ApiError(
        400,
        `Invalid or missing manifest in backup archive: ${err.message}`,
        "invalid_manifest",
      );
    }
    assertValidManifest(manifest, projectId);

    return { stagingDir, manifest };
  } catch (err) {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch {}
    throw err;
  }
}

export async function restoreWorkspaceBackup(
  cfg: AppConfig,
  db: Db,
  projectId: string,
  filename: string,
  options?: {
    actorUserId?: number;
    actorUsername?: string;
    ipAddress?: string;
    /**
     * M56: proceed even if the live collaboration room's latest in-memory
     * edits could NOT be flushed to disk within the safety window
     * (explicitly discarding them). Without this, an un-flushable dirty room
     * aborts the restore with a 409 `collab_flush_failed` before anything is
     * touched.
     */
    force?: boolean;
    /**
     * Test-only: invoked once, immediately after QUIESCE's pre-swap room
     * dispose and before SWAP begins. Lets `workspace-restore.test.ts`
     * deterministically simulate a client reconnecting and creating a
     * fresh Yjs room exactly inside the race window this module's RECONNECT
     * step exists to close, without relying on real timing luck. Never
     * passed by production code (the CLI/admin route never provide it).
     */
    __testHookAfterQuiesce?: () => void | Promise<void>;
    /**
     * Test-only: invoked immediately after the workspace files have been
     * moved into place during SWAP, before snapshot/DB replacement. If it
     * throws, SWAP fails at a realistic point with live state already
     * partially touched — deterministically exercising ROLLBACK. Never
     * passed by production code.
     */
    __testHookAfterWorkspaceSwap?: () => void | Promise<void>;
  },
): Promise<WorkspaceRestoreResult> {
  const startTime = Date.now();
  assertValidProjectId(projectId);

  const project = getProject(db, projectId);
  if (!project) {
    throw new ApiError(404, "project not found", "not_found");
  }

  const { stagingDir, manifest } = await prepareRestoreStaging(
    cfg,
    projectId,
    filename,
  );

  try {
    return await withProjectSnapshotLock(projectId, async () => {
      // M56: FLUSH-BEFORE-DESTROY. A live room may hold collaborative edits
      // that exist only in memory inside the debounce window; disposing it
      // (below) destroys the Y.Doc and loses them. Persist them FIRST, while
      // the room is still alive. This runs before any filesystem mutation,
      // so if the flush cannot complete within the bound we abort here with
      // the workspace still completely untouched and the room still alive —
      // no rollback needed. `force` explicitly accepts the loss.
      const flushResult =
        await collaborationManager.flushRoomBeforeDestruction(projectId);
      if (!flushResult.flushed && !options?.force) {
        throw new ApiError(
          409,
          `Restore blocked: ${flushResult.remainingDirty.length} file(s) have unsaved collaborative edits that could not be persisted within the safety window. Retry, or force the restore to discard them.`,
          "collab_flush_failed",
          { remainingDirty: flushResult.remainingDirty },
        );
      }

      // QUIESCE — matches importProjectZip's (M21) teardown sequence.
      collaborationManager.getRoom(projectId)?.dispose();
      if (options?.__testHookAfterQuiesce) {
        await options.__testHookAfterQuiesce();
      }
      try {
        await sandboxManager.stopProjectSandbox(projectId);
      } catch {
        // Best-effort — a stray container is far less harmful than an
        // aborted restore.
      }
      telemetryHistorian.disposeProject(projectId);

      const cwd = projectDir(cfg, projectId);
      const liveSnapDir = snapshotDir(cfg, projectId);
      const rollbackDir = join(
        cfg.dataDir,
        `tmp_restore_rollback_${randomUUID()}`,
      );
      await fs.mkdir(rollbackDir, { recursive: true });
      const rollbackWorkspacePath = join(rollbackDir, "workspace");
      const rollbackSnapshotPath = join(rollbackDir, "snapshots");

      // Captured before any destructive action — used both for rollback
      // and (for v2) as the "previous state" to restore if VERIFY fails
      // after the DB replace already committed.
      const previousSnapshotRows = db
        .prepare(
          "SELECT id, name, user_id, size_bytes, created_at FROM snapshots WHERE project_id = ?",
        )
        .all(projectId) as Array<{
        id: string;
        name: string;
        user_id: number;
        size_bytes: number;
        created_at: string;
      }>;

      // Tracked separately (not one coarse "swapped" flag) because ROLLBACK
      // must know exactly which live paths were actually touched, even if
      // the failure happens partway through — e.g. a failure right after
      // the workspace lands but before any snapshot work must still
      // quarantine the (now-live) new workspace and restore the old one,
      // without touching snapshots at all if they were never moved.
      let workspaceSwapped = false;
      let snapshotDirMoved = false;
      let dbReplaced = false;
      const quarantineDir = join(
        cfg.dataDir,
        `tmp_restore_quarantine_${randomUUID()}`,
      );

      try {
        // SWAP — rename current state into rollback staging FIRST; never
        // delete before the replacement is confirmed ready. The live
        // snapshot directory is only ever touched for a v2 manifest (v1
        // restores workspace files only — snapshots are explicitly left
        // completely alone, per this module's v1 compatibility policy).
        await fs.rename(cwd, rollbackWorkspacePath);
        if (manifest.version === 2 && existsSync(liveSnapDir)) {
          await fs.rename(liveSnapDir, rollbackSnapshotPath);
          snapshotDirMoved = true;
        }

        const stagedWorkspace = join(stagingDir, "workspace");
        if (existsSync(stagedWorkspace)) {
          await fs.rename(stagedWorkspace, cwd);
        } else {
          // A legitimately empty workspace produces no `workspace/*`
          // archive entries at all.
          await fs.mkdir(cwd, { recursive: true });
        }
        workspaceSwapped = true;

        // Test-only: lets workspace-restore.test.ts deterministically force
        // a SWAP-phase failure (to prove ROLLBACK genuinely restores prior
        // state) without needing to fabricate a real disk-level fault.
        // Never invoked by production code.
        if (options?.__testHookAfterWorkspaceSwap) {
          await options.__testHookAfterWorkspaceSwap();
        }

        let restoredSnapshotCount = 0;
        const deletedUserFallbackIds: string[] = [];

        if (manifest.version === 2) {
          const stagedSnapshots = join(stagingDir, "snapshots");
          if (manifest.snapshots.length > 0 && existsSync(stagedSnapshots)) {
            await fs.mkdir(liveSnapDir, { recursive: true });
            snapshotDirMoved = true;
            for (const entry of manifest.snapshots) {
              const src = join(stagedSnapshots, `${entry.id}.gz`);
              const dest = join(liveSnapDir, `${entry.id}.gz`);
              await fs.rename(src, dest);
              restoredSnapshotCount++;
            }
          }

          db.exec("BEGIN TRANSACTION;");
          try {
            db.prepare("DELETE FROM snapshots WHERE project_id = ?").run(
              projectId,
            );
            const insertStmt = db.prepare(
              "INSERT INTO snapshots (id, project_id, user_id, name, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            );
            const userExistsStmt = db.prepare(
              "SELECT id FROM users WHERE id = ?",
            );
            for (const entry of manifest.snapshots) {
              let userId = entry.userId;
              if (userExistsStmt.get(userId) === undefined) {
                // Original creator's account no longer exists — snapshots.
                // user_id is NOT NULL, so ownership must fall back to a
                // still-valid user. Prefer the restoring admin; fall back
                // to the project's own current owner (guaranteed to exist
                // as long as the project itself does). Never fabricate a
                // new user.
                userId = options?.actorUserId ?? project.owner_id;
                deletedUserFallbackIds.push(entry.id);
              }
              insertStmt.run(
                entry.id,
                projectId,
                userId,
                entry.name,
                entry.sizeBytes,
                entry.createdAt,
              );
            }
            db.exec("COMMIT;");
            dbReplaced = true;
          } catch (err) {
            try {
              db.exec("ROLLBACK;");
            } catch {}
            throw err;
          }
        }

        // VERIFY
        const restoredFiles = await listFiles(cwd);
        if (restoredFiles.length !== manifest.workspaceFileCount) {
          throw new ApiError(
            500,
            `Post-restore verification failed: expected ${manifest.workspaceFileCount} workspace files, found ${restoredFiles.length}`,
            "restore_verification_failed",
          );
        }
        if (manifest.version === 2) {
          const dbCount = (
            db
              .prepare(
                "SELECT COUNT(*) as c FROM snapshots WHERE project_id = ?",
              )
              .get(projectId) as { c: number }
          ).c;
          if (dbCount !== manifest.snapshots.length) {
            throw new ApiError(
              500,
              `Post-restore verification failed: expected ${manifest.snapshots.length} snapshot rows, found ${dbCount}`,
              "restore_verification_failed",
            );
          }
          for (const entry of manifest.snapshots) {
            if (!existsSync(join(liveSnapDir, `${entry.id}.gz`))) {
              throw new ApiError(
                500,
                `Post-restore verification failed: snapshot body ${entry.id} missing after restore`,
                "restore_verification_failed",
              );
            }
          }
        }

        // RECONNECT — see this module's doc comment for why a second
        // dispose is required, not merely defensive.
        collaborationManager.getRoom(projectId)?.dispose();
        invalidateTreeCache(cwd);
        touchProject(db, projectId);

        // M56: record the whole-workspace replacement so any collaborator
        // who was force-disconnected by the dispose above learns why (and
        // that their content changed) when they reconnect within the TTL.
        collaborationManager.registerDestructiveMutation(
          projectId,
          "workspace_restore",
          options?.actorUserId,
          options?.actorUsername,
        );

        try {
          await fs.rm(rollbackDir, { recursive: true, force: true });
        } catch {}

        const skippedReason =
          manifest.version === 1 ? V1_SKIP_REASON : undefined;

        recordAuditLog(db, {
          userId: options?.actorUserId,
          projectId,
          eventType: "WORKSPACE_BACKUP_RESTORED",
          details: {
            filename,
            manifestVersion: manifest.version,
            workspaceFileCount: manifest.workspaceFileCount,
            snapshotRestoredCount: restoredSnapshotCount,
            snapshotSkippedReason: skippedReason,
            deletedUserFallbackCount: deletedUserFallbackIds.length,
            deletedUserFallbackSnapshotIds: deletedUserFallbackIds,
          },
          ipAddress: options?.ipAddress,
        });

        return {
          backupFilename: filename,
          manifestVersion: manifest.version,
          projectId,
          workspaceFileCount: manifest.workspaceFileCount,
          snapshotRestored: {
            attempted: manifest.version === 2,
            restoredCount: restoredSnapshotCount,
            skippedReason,
          },
          deletedUserFallback: {
            count: deletedUserFallbackIds.length,
            snapshotIds: deletedUserFallbackIds,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (err: any) {
        // ROLLBACK
        await fs.mkdir(quarantineDir, { recursive: true }).catch(() => {});
        try {
          if (workspaceSwapped && existsSync(cwd)) {
            await fs.rename(cwd, join(quarantineDir, "workspace"));
          }
        } catch {}
        try {
          // Only quarantine the live snapshot directory if THIS restore
          // attempt actually moved it — a v1 restore (or a v2 restore that
          // never reached the snapshot step) must never touch a live
          // snapshot directory it never modified in the first place.
          if (snapshotDirMoved && existsSync(liveSnapDir)) {
            await fs.rename(liveSnapDir, join(quarantineDir, "snapshots"));
          }
        } catch {}
        try {
          if (existsSync(rollbackWorkspacePath)) {
            await fs.rename(rollbackWorkspacePath, cwd);
          }
        } catch {}
        try {
          if (existsSync(rollbackSnapshotPath)) {
            await fs.rename(rollbackSnapshotPath, liveSnapDir);
          }
        } catch {}

        if (dbReplaced) {
          try {
            db.exec("BEGIN TRANSACTION;");
            db.prepare("DELETE FROM snapshots WHERE project_id = ?").run(
              projectId,
            );
            const insertStmt = db.prepare(
              "INSERT INTO snapshots (id, project_id, user_id, name, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            );
            for (const row of previousSnapshotRows) {
              insertStmt.run(
                row.id,
                projectId,
                row.user_id,
                row.name,
                row.size_bytes,
                row.created_at,
              );
            }
            db.exec("COMMIT;");
          } catch {
            try {
              db.exec("ROLLBACK;");
            } catch {}
          }
        }

        collaborationManager.getRoom(projectId)?.dispose();
        invalidateTreeCache(cwd);

        recordAuditLog(db, {
          userId: options?.actorUserId,
          projectId,
          eventType: "WORKSPACE_BACKUP_RESTORED",
          details: {
            filename,
            failed: true,
            reason: err?.message || String(err),
            quarantinePath: quarantineDir,
          },
          ipAddress: options?.ipAddress,
        });

        throw err instanceof ApiError
          ? err
          : new ApiError(
              500,
              `Workspace restore failed: ${err?.message}`,
              "restore_failed",
            );
      }
    });
  } finally {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch {}
  }
}
