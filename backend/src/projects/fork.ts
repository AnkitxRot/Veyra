import { promises as fs } from "node:fs";
import { readConfinedBytes } from "../files/confined.js";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { recordAuditLog } from "../audit.js";
import {
  createProject,
  projectDir,
  requireOwnedProject,
  workspacePath,
  type ProjectRow,
} from "./service.js";
import { listFiles, invalidateTreeCache } from "../files/service.js";
import { withProjectSnapshotLock } from "./snapshots.js";

export interface ForkResult {
  project: ProjectRow;
  fileCount: number;
  totalBytes: number;
}

/**
 * Recursively copies files/directories from src to dest. Uses
 * `withFileTypes` Dirent checks (lstat-based, do not follow symlinks), so a
 * symlink entry in the source tree is silently skipped rather than
 * followed — the same convention already used by archive.ts/upload.ts.
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Forks a project: creates a brand-new, independently-owned project whose
 * workspace is a point-in-time copy of the source project's workspace.
 *
 * Deliberately does NOT copy: live collaboration/Yjs room state, terminal
 * state, sandbox/container metadata, or any snapshot lock — only files on
 * disk. Matches the same limitation `exportProjectZip` already has: content
 * still buffered in a live collaboration session but not yet flushed to
 * disk is not reflected in the fork.
 */
export async function forkProject(
  cfg: AppConfig,
  db: Db,
  userId: number,
  sourceProjectId: string,
  opts: { name?: string } = {},
): Promise<ForkResult> {
  // Fork produces a full, independently-owned copy of the entire workspace
  // — the same whole-workspace/bulk-copy shape as export, import, upload,
  // and snapshots, all of which are owner-only (requireOwnedProject) rather
  // than collaborator-accessible. A collaborator-level gate here would let
  // a viewer/editor bypass export's owner-only boundary: fork the source at
  // collaborator level, become owner of the fork, then export the
  // now-owned fork. IDOR-safe: a non-owner (collaborator or stranger) gets
  // an identical 404, never learning whether the project exists.
  const sourceProject = requireOwnedProject(db, userId, sourceProjectId);

  // Serialize against a concurrent snapshot restore on the SOURCE project so
  // the fork never reads a half-restored workspace mid-write. This is the
  // same in-process lock exportProjectZip already uses for the same reason.
  const { filePaths, totalBytes, stagingDir } = await withProjectSnapshotLock(
    sourceProjectId,
    async () => {
      const sourceCwd = await workspacePath(cfg, sourceProject.id);
      const filePaths = await listFiles(sourceCwd);

      if (filePaths.length > cfg.maxUploadFileCount) {
        throw new ApiError(
          413,
          `Source workspace file count (${filePaths.length}) exceeds fork limit of ${cfg.maxUploadFileCount}`,
          "fork_limit_exceeded",
        );
      }

      let totalBytes = 0;
      for (const fp of filePaths) {
        const st = await fs.stat(join(sourceCwd, fp));
        totalBytes += st.size;
        if (totalBytes > cfg.maxAggregateUploadBytes) {
          throw new ApiError(
            413,
            `Source workspace size exceeds fork limit of ${cfg.maxAggregateUploadBytes} bytes`,
            "fork_limit_exceeded",
          );
        }
        if (st.size > cfg.maxSingleUploadFileBytes) {
          throw new ApiError(
            413,
            `Source file "${fp}" (${st.size} bytes) exceeds single-file fork limit of ${cfg.maxSingleUploadFileBytes} bytes`,
            "fork_limit_exceeded",
          );
        }
      }

      // Stage the copy into an isolated temp directory first: this proves
      // the entire source tree can actually be read and rewritten to disk
      // before any new project row exists, so a mid-copy I/O failure here
      // (permissions, disk full) never touches project state at all.
      const stagingDir = join(cfg.dataDir, `tmp_fork_${randomUUID()}`);
      await fs.mkdir(stagingDir, { recursive: true });
      try {
        for (const fp of filePaths) {
          const destPath = join(stagingDir, fp);
          await fs.mkdir(dirname(destPath), { recursive: true });
          // M87: read through the confined helper (the source workspace is
          // sandbox-writable); the staging copy is server-owned.
          await fs.writeFile(
            destPath,
            await readConfinedBytes(sourceCwd, join(sourceCwd, fp)),
          );
        }
      } catch (err) {
        try {
          await fs.rm(stagingDir, { recursive: true, force: true });
        } catch {}
        throw err;
      }

      return { filePaths, totalBytes, stagingDir };
    },
  );

  const fallbackName = `${sourceProject.name} (Fork)`.slice(0, 64);
  const name =
    typeof opts.name === "string" && opts.name.trim()
      ? opts.name.trim().slice(0, 64)
      : fallbackName;

  try {
    // createProject enforces the actor's own project quota and always sets
    // owner_id = userId (the actor forking, never the source's owner) — the
    // fork is never eagerly sandboxed (createProject never touches
    // SandboxManager) and starts with no collaboration room, matching the
    // same lazy-provisioning convention every other new project uses.
    const project = await createProject(cfg, db, userId, {
      name,
      language: sourceProject.language,
    });

    try {
      const destCwd = projectDir(cfg, project.id);
      await copyDirectory(stagingDir, destCwd);
      invalidateTreeCache(destCwd);

      recordAuditLog(db, {
        userId,
        projectId: project.id,
        eventType: "PROJECT_FORKED",
        details: {
          sourceProjectId: sourceProject.id,
          sourceProjectName: sourceProject.name,
          forkedProjectName: project.name,
          fileCount: filePaths.length,
          totalBytes,
        },
      });

      return { project, fileCount: filePaths.length, totalBytes };
    } catch (err) {
      // Roll back the orphaned project row + directory rather than leave a
      // partially-forked project visible to the user.
      try {
        await fs.rm(projectDir(cfg, project.id), {
          recursive: true,
          force: true,
        });
      } catch {}
      try {
        db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
      } catch {}
      throw err;
    }
  } finally {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch {}
  }
}
