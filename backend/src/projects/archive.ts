import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import {
  requireOwnedProject,
  workspacePath,
  projectDir,
  touchProject,
  createProject,
} from "./service.js";
import { listFiles, invalidateTreeCache } from "../files/service.js";
import {
  createZipArchive,
  extractZipArchive,
  type ZipFileEntry,
} from "./zip.js";
import { withProjectSnapshotLock } from "./snapshots.js";
import { collaborationManager } from "../collab/manager.js";
import { sandboxManager } from "../execution/sandbox.js";
import { telemetryHistorian } from "../execution/historian.js";
import { recordAuditLog } from "../audit.js";

export interface ExportResult {
  zipBuffer: Buffer;
  projectName: string;
}

/**
 * Packages an existing project's workspace into a standard ZIP archive.
 */
export async function exportProjectZip(
  cfg: AppConfig,
  db: Db,
  userId: number,
  projectId: string,
): Promise<ExportResult> {
  return withProjectSnapshotLock(projectId, async () => {
    const project = requireOwnedProject(db, userId, projectId);
    const cwd = await workspacePath(cfg, project.id);
    const filePaths = await listFiles(cwd);

    const entries: ZipFileEntry[] = [];
    for (const fp of filePaths) {
      const absPath = join(cwd, fp);
      const content = await fs.readFile(absPath);
      entries.push({ path: fp, content });
    }

    const zipBuffer = createZipArchive(entries);

    try {
      recordAuditLog(db, {
        userId,
        projectId: project.id,
        eventType: "PROJECT_EXPORTED",
        details: {
          projectName: project.name,
          fileCount: entries.length,
          archiveBytes: zipBuffer.length,
        },
      });
    } catch {}

    return {
      zipBuffer,
      projectName: project.name,
    };
  });
}

export interface ImportOptions {
  replace?: boolean;
  /** M56: proceed even if a live collab room's unsaved edits could not be
   *  flushed within the safety window (explicitly discarding them). */
  force?: boolean;
  /** M56: actor username, for the reconnect notice. */
  actorUsername?: string;
}

/**
 * Imports a ZIP archive into an existing project workspace with transactional staging.
 */
export async function importProjectZip(
  cfg: AppConfig,
  db: Db,
  userId: number,
  projectId: string,
  zipBuffer: Buffer,
  options: ImportOptions = {},
): Promise<{ ok: boolean; fileCount: number }> {
  const project = requireOwnedProject(db, userId, projectId);
  const cwd = await workspacePath(cfg, project.id);

  // Check if target project is non-empty when replace=false
  if (!options.replace) {
    const existingFiles = await listFiles(cwd);
    if (existingFiles.length > 0) {
      throw new ApiError(
        409,
        "Project workspace is not empty. Confirmation required (pass replace=true to overwrite).",
        "replace_required",
      );
    }
  }

  // 1. Unpack into an isolated staging directory first
  const stagingDir = join(cfg.dataDir, `tmp_import_${randomUUID()}`);
  await fs.mkdir(stagingDir, { recursive: true });

  let extractedFiles;
  try {
    extractedFiles = await extractZipArchive(zipBuffer, stagingDir, cfg);
  } catch (err) {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch {}
    throw err;
  }

  // 2. Safely replace workspace under lock
  return withProjectSnapshotLock(projectId, async () => {
    try {
      // M56: FLUSH-BEFORE-DESTROY. Persist the live room's latest in-memory
      // collaborative edits before the dispose below destroys the Y.Doc.
      // Runs before any filesystem mutation, so aborting here on a failed
      // flush leaves the workspace untouched and the room alive.
      const flushResult = await collaborationManager.flushRoomBeforeDestruction(
        project.id,
      );
      if (!flushResult.flushed && !options.force) {
        throw new ApiError(
          409,
          `Import blocked: ${flushResult.remainingDirty.length} file(s) have unsaved collaborative edits that could not be persisted within the safety window. Retry, or force the import to discard them.`,
          "collab_flush_failed",
          { remainingDirty: flushResult.remainingDirty },
        );
      }

      // Teardown active project sessions before modifying files on disk
      try {
        collaborationManager.getRoom(project.id)?.dispose();
      } catch {}
      try {
        await sandboxManager.stopProjectSandbox(project.id);
      } catch {}
      try {
        telemetryHistorian.disposeProject(project.id);
      } catch {}

      // Clean workspace directory
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.mkdir(cwd, { recursive: true });

      // Move extracted files into workspace
      await copyDirectory(stagingDir, cwd);

      invalidateTreeCache(cwd);
      touchProject(db, project.id);

      try {
        recordAuditLog(db, {
          userId,
          projectId: project.id,
          eventType: "PROJECT_IMPORTED",
          details: {
            projectName: project.name,
            fileCount: extractedFiles.length,
            archiveBytes: zipBuffer.length,
          },
        });
      } catch {}

      // Second dispose, mirroring M38's identical fix to deleteProject() and
      // workspaceRestore.ts's own RECONNECT step: the project row is never
      // deleted by an import, so a client can reconnect via getOrCreateRoom()
      // at any point during this async replacement window and end up holding
      // pre-import content in a fresh Y.Doc. The dispose above already
      // force-closed every client that was connected before it ran (dispose()
      // unconditionally closes its own room's clients with code 1001 and
      // removes the room from the manager), so no legitimately-continuous
      // session can exist at this point — anything connected now either
      // raced in with stale content (must be torn down) or connected in the
      // narrow gap after replacement finished and would just need one more
      // harmless reconnect either way. Disposing again ensures the imported
      // content is what the next reconnect actually loads.
      try {
        collaborationManager.getRoom(project.id)?.dispose();
      } catch {}

      // M56: record the whole-workspace replacement for the reconnect notice.
      collaborationManager.registerDestructiveMutation(
        project.id,
        "workspace_import",
        userId,
        options.actorUsername,
      );

      return { ok: true, fileCount: extractedFiles.length };
    } finally {
      try {
        await fs.rm(stagingDir, { recursive: true, force: true });
      } catch {}
    }
  });
}

/**
 * Creates a new project from an imported ZIP archive.
 */
export async function importNewProjectZip(
  cfg: AppConfig,
  db: Db,
  userId: number,
  zipBuffer: Buffer,
  meta: { name?: string; language?: string } = {},
): Promise<{ project: any; fileCount: number }> {
  // Check user project quota
  const row = db
    .prepare("SELECT count(*) as c FROM projects WHERE owner_id = ?")
    .get(userId) as { c: number } | undefined;
  if ((row?.c ?? 0) >= cfg.projectQuota) {
    throw new ApiError(
      403,
      `project limit of ${cfg.projectQuota} reached`,
      "quota_exceeded",
    );
  }

  const projectName =
    typeof meta.name === "string" && meta.name.trim()
      ? meta.name.trim()
      : `Imported Project ${new Date().toLocaleTimeString()}`;

  // 1. Unpack into staging directory first
  const stagingDir = join(cfg.dataDir, `tmp_import_${randomUUID()}`);
  await fs.mkdir(stagingDir, { recursive: true });

  let extractedFiles;
  try {
    extractedFiles = await extractZipArchive(zipBuffer, stagingDir, cfg);
  } catch (err) {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch {}
    throw err;
  }

  // 2. Create project and copy files
  try {
    const project = await createProject(cfg, db, userId, {
      name: projectName,
      language: meta.language ?? "auto",
    });

    const cwd = projectDir(cfg, project.id);
    await copyDirectory(stagingDir, cwd);
    invalidateTreeCache(cwd);

    try {
      recordAuditLog(db, {
        userId,
        projectId: project.id,
        eventType: "PROJECT_IMPORTED",
        details: {
          projectName: project.name,
          fileCount: extractedFiles.length,
          archiveBytes: zipBuffer.length,
        },
      });
    } catch {}

    return { project, fileCount: extractedFiles.length };
  } finally {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch {}
  }
}

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
