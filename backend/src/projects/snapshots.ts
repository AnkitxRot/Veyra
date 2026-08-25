import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { requireOwnedProject, workspacePath } from "./service.js";
import {
  listFiles,
  readProjectFile,
  writeProjectFile,
  deleteProjectPath,
  safeResolve,
} from "../files/service.js";
import { collaborationManager } from "../collab/manager.js";

export interface SnapshotRecord {
  id: string;
  project_id: string;
  user_id: number;
  name: string;
  size_bytes: number;
  created_at: string;
}

interface SnapshotPayload {
  version: 1;
  projectId: string;
  createdAt: string;
  files: { path: string; content: string }[];
}

function snapshotDir(cfg: AppConfig, projectId: string): string {
  return join(cfg.dataDir, "snapshots", projectId);
}

/**
 * In-memory serialization locks per project to prevent TOCTOU race conditions
 * between quota calculation, eviction, archive writing, and DB modification.
 */
const projectSnapshotLocks = new Map<string, Promise<any>>();

export async function withProjectSnapshotLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = projectSnapshotLocks.get(projectId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((res) => {
    release = res;
  });
  projectSnapshotLocks.set(
    projectId,
    current.then(
      () => next,
      () => next,
    ),
  );

  try {
    await current;
    return await fn();
  } finally {
    release();
    if (projectSnapshotLocks.get(projectId) === next) {
      projectSnapshotLocks.delete(projectId);
    }
  }
}

/**
 * Creates a project snapshot with automatic quota enforcement and oldest-first eviction.
 *
 * Enforces:
 *   1. Single snapshot size limit (`maxSnapshotSizeBytes`, default 5MB)
 *   2. Project snapshot count limit (`maxSnapshotsPerProject`, default 10)
 *   3. Project total storage limit (`maxSnapshotBytesPerProject`, default 20MB)
 *
 * If the new snapshot would cause the project to exceed count or total storage limits,
 * existing snapshots are evicted oldest-first to make room.
 */
export async function createSnapshot(
  cfg: AppConfig,
  db: Db,
  userId: number,
  projectId: string,
  name: string,
): Promise<SnapshotRecord> {
  return withProjectSnapshotLock(projectId, async () => {
    const project = requireOwnedProject(db, userId, projectId);
    const cwd = await workspacePath(cfg, project.id);
    const filePaths = await listFiles(cwd);

    const files: { path: string; content: string }[] = [];
    for (const fp of filePaths) {
      const { content } = await readProjectFile(cwd, fp);
      files.push({ path: fp, content });
    }

    const payload: SnapshotPayload = {
      version: 1,
      projectId: project.id,
      createdAt: new Date().toISOString(),
      files,
    };

    const jsonStr = JSON.stringify(payload);
    const compressed = gzipSync(Buffer.from(jsonStr, "utf8"));
    const newSizeBytes = compressed.byteLength;

    const maxSnapshotSize = cfg.maxSnapshotSizeBytes ?? 5 * 1024 * 1024;
    if (newSizeBytes > maxSnapshotSize) {
      throw new ApiError(
        413,
        `Snapshot size (${newSizeBytes} bytes) exceeds limit of ${maxSnapshotSize} bytes`,
        "snapshot_too_large",
      );
    }

    const maxCount = cfg.maxSnapshotsPerProject ?? 10;
    const maxTotalBytes = cfg.maxSnapshotBytesPerProject ?? 20 * 1024 * 1024;

    if (newSizeBytes > maxTotalBytes) {
      throw new ApiError(
        413,
        `Snapshot size (${newSizeBytes} bytes) exceeds project storage quota of ${maxTotalBytes} bytes`,
        "snapshot_quota_exceeded",
      );
    }

    // Query existing snapshots for this project ordered by created_at ASC (oldest first)
    const existingSnapshots = db
      .prepare(
        "SELECT id, size_bytes FROM snapshots WHERE project_id = ? ORDER BY created_at ASC",
      )
      .all(project.id) as unknown as Array<{ id: string; size_bytes: number }>;

    let currentCount = existingSnapshots.length;
    let currentTotalBytes = existingSnapshots.reduce(
      (sum, s) => sum + (s.size_bytes || 0),
      0,
    );

    const toEvict: string[] = [];

    for (const s of existingSnapshots) {
      // If adding 1 new snapshot exceeds maxCount OR adding newSizeBytes exceeds maxTotalBytes,
      // evict this oldest snapshot.
      if (
        currentCount + 1 > maxCount ||
        currentTotalBytes + newSizeBytes > maxTotalBytes
      ) {
        toEvict.push(s.id);
        currentCount--;
        currentTotalBytes -= s.size_bytes || 0;
      } else {
        break;
      }
    }

    // Execute eviction of identified oldest snapshots
    const dir = snapshotDir(cfg, project.id);
    for (const evictId of toEvict) {
      const evictArchive = safeResolve(dir, `${evictId}.gz`);
      try {
        await fs.rm(evictArchive, { force: true });
      } catch {}
      db.prepare("DELETE FROM snapshots WHERE id = ?").run(evictId);
    }

    // Write new snapshot archive
    await fs.mkdir(dir, { recursive: true });
    const snapshotId = randomUUID();
    const archivePath = join(dir, `${snapshotId}.gz`);

    try {
      await fs.writeFile(archivePath, compressed);
    } catch (err: any) {
      throw new ApiError(
        500,
        `Failed to write snapshot archive: ${err.message}`,
        "snapshot_write_failed",
      );
    }

    const snapshotName =
      typeof name === "string" && name.trim()
        ? name.trim().slice(0, 64)
        : `Snapshot ${new Date().toLocaleTimeString()}`;

    try {
      db.prepare(
        `INSERT INTO snapshots (id, project_id, user_id, name, size_bytes)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(snapshotId, project.id, userId, snapshotName, newSizeBytes);
    } catch (err: any) {
      // Rollback archive on disk if DB insertion fails
      try {
        await fs.rm(archivePath, { force: true });
      } catch {}
      throw err;
    }

    return {
      id: snapshotId,
      project_id: project.id,
      user_id: userId,
      name: snapshotName,
      size_bytes: newSizeBytes,
      created_at: new Date().toISOString(),
    };
  });
}

export function listSnapshots(
  db: Db,
  userId: number,
  projectId: string,
): SnapshotRecord[] {
  return db
    .prepare(
      "SELECT * FROM snapshots WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC",
    )
    .all(projectId, userId) as unknown as SnapshotRecord[];
}

export async function restoreSnapshot(
  cfg: AppConfig,
  db: Db,
  userId: number,
  projectId: string,
  snapshotId: string,
): Promise<void> {
  return withProjectSnapshotLock(projectId, async () => {
    const project = requireOwnedProject(db, userId, projectId);
    const row = db
      .prepare(
        "SELECT * FROM snapshots WHERE id = ? AND project_id = ? AND user_id = ?",
      )
      .get(snapshotId, project.id, userId) as SnapshotRecord | undefined;

    if (!row) throw new ApiError(404, "snapshot not found", "not_found");

    const archivePath = join(snapshotDir(cfg, project.id), `${snapshotId}.gz`);
    let compressed: Buffer;
    try {
      compressed = await fs.readFile(archivePath);
    } catch {
      throw new ApiError(
        404,
        "snapshot archive file missing on disk",
        "not_found",
      );
    }

    const decompressed = gunzipSync(compressed);
    const payload: SnapshotPayload = JSON.parse(decompressed.toString("utf8"));

    const cwd = await workspacePath(cfg, project.id);

    // Restore snapshot files FIRST, delete leftovers second. If a write
    // fails partway through (disk full, permission error, etc.), any file
    // not yet reached is still whatever it was before this call — either an
    // old file waiting to be superseded, or untouched.
    const snapshotPaths = new Set(payload.files.map((f) => f.path));
    for (const f of payload.files) {
      await writeProjectFile(cwd, f.path, f.content);
      await collaborationManager.notifyExternalFileMutation(
        project.id,
        f.path,
        f.content,
      );
    }

    // Remove any current file that doesn't belong in the restored snapshot.
    const currentFiles = await listFiles(cwd);
    for (const f of currentFiles) {
      if (snapshotPaths.has(f)) continue;
      try {
        await deleteProjectPath(cwd, f);
        await collaborationManager.notifyExternalFileMutation(
          project.id,
          f,
          "",
        );
      } catch {}
    }
  });
}

export async function deleteSnapshot(
  cfg: AppConfig,
  db: Db,
  userId: number,
  projectId: string,
  snapshotId: string,
): Promise<void> {
  return withProjectSnapshotLock(projectId, async () => {
    const project = requireOwnedProject(db, userId, projectId);
    const row = db
      .prepare(
        "SELECT * FROM snapshots WHERE id = ? AND project_id = ? AND user_id = ?",
      )
      .get(snapshotId, project.id, userId) as SnapshotRecord | undefined;

    if (!row) throw new ApiError(404, "snapshot not found", "not_found");

    const archivePath = safeResolve(
      snapshotDir(cfg, project.id),
      `${snapshotId}.gz`,
    );
    try {
      await fs.rm(archivePath, { force: true });
    } catch {}
    db.prepare(
      "DELETE FROM snapshots WHERE id = ? AND project_id = ? AND user_id = ?",
    ).run(snapshotId, project.id, userId);
  });
}
