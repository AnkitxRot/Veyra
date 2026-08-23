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

export async function createSnapshot(
  cfg: AppConfig,
  db: Db,
  userId: number,
  projectId: string,
  name: string,
): Promise<SnapshotRecord> {
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

  const snapshotId = randomUUID();
  const dir = snapshotDir(cfg, project.id);
  await fs.mkdir(dir, { recursive: true });
  const archivePath = join(dir, `${snapshotId}.gz`);
  await fs.writeFile(archivePath, compressed);

  const snapshotName =
    typeof name === "string" && name.trim()
      ? name.trim().slice(0, 64)
      : `Snapshot ${new Date().toLocaleTimeString()}`;

  db.prepare(
    `
    INSERT INTO snapshots (id, project_id, user_id, name, size_bytes)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(snapshotId, project.id, userId, snapshotName, compressed.byteLength);

  return {
    id: snapshotId,
    project_id: project.id,
    user_id: userId,
    name: snapshotName,
    size_bytes: compressed.byteLength,
    created_at: new Date().toISOString(),
  };
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
  // old file waiting to be superseded, or untouched. The previous
  // delete-everything-then-write ordering meant a write failure after the
  // delete pass had already run left the workspace with content gone and
  // no way to recover it; this ordering's worst case is a stray old file
  // left behind, not lost content.
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
      // Keep any active collaboration room's Y.Text in sync, otherwise its
      // next debounced flush would silently rewrite this file back to disk.
      await collaborationManager.notifyExternalFileMutation(project.id, f, "");
    } catch {}
  }
}

export async function deleteSnapshot(
  cfg: AppConfig,
  db: Db,
  userId: number,
  projectId: string,
  snapshotId: string,
): Promise<void> {
  const project = requireOwnedProject(db, userId, projectId);
  // Gate on the DB row BEFORE touching the filesystem, exactly as
  // restoreSnapshot() does. snapshotId comes straight off the URL path and is
  // fully attacker-controlled; ids are server-generated randomUUID() values,
  // so requiring a real row means only a UUID (no separators, no `..`) can
  // ever reach the join() below.
  const row = db
    .prepare(
      "SELECT * FROM snapshots WHERE id = ? AND project_id = ? AND user_id = ?",
    )
    .get(snapshotId, project.id, userId) as SnapshotRecord | undefined;

  if (!row) throw new ApiError(404, "snapshot not found", "not_found");

  // Belt-and-braces: lexical containment check on top of the DB gate.
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
}
