import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { recordAuditLog } from "../audit.js";
import { getProject, workspacePath } from "../projects/service.js";
import { listFiles } from "../files/service.js";
import { readConfinedBytes } from "../files/confined.js";
import { withProjectSnapshotLock, snapshotDir } from "../projects/snapshots.js";
import {
  createZipArchive,
  extractZipArchive,
  type ZipFileEntry,
} from "../projects/zip.js";
import { ensureBackupDir, secureBackupFilePermissions } from "./shared.js";

/**
 * Milestone 31 — Automated Per-Project Workspace & Snapshot-Body Backup.
 *
 * Closes the gap the M25/M27/M30 database backup pipeline never covered:
 * `<dataDir>/workspaces/<projectId>/` (project source files) and
 * `<dataDir>/snapshots/<projectId>/` (snapshot payload *bodies* — the
 * `snapshots` DB table only stores metadata, restored by `db:restore`
 * already; the gzip bodies themselves are filesystem-resident and were
 * previously restored by nothing).
 *
 * This is a disaster-recovery artifact, not a copy of the user-facing
 * export contract: it deliberately does NOT reuse `exportProjectZip`
 * wholesale (that function only covers workspace files, not snapshot
 * bodies, and its concerns — a client-facing named download — differ from
 * an internally-retained DR artifact). It DOES reuse the already-audited
 * `createZipArchive`/`extractZipArchive` primitives from `zip.ts` and the
 * per-project `withProjectSnapshotLock` from `snapshots.ts`.
 *
 * CONSISTENCY MODEL — read before changing anything here: this backup
 * provides per-project EVENTUAL consistency, not a globally atomic
 * DB+filesystem snapshot. A database backup taken at one moment and a
 * workspace backup taken at another can describe slightly different
 * project states (a project created/renamed/deleted in between). This is
 * an accepted, documented tradeoff — see deploy/README.md — not an
 * oversight; achieving true cross-domain atomicity would require either
 * whole-application write-freezing (disruptive, and inconsistent with the
 * "schedule off-peak, no live-traffic guarantee" precedent already
 * accepted for the database backup) or a new distributed-transaction-like
 * primitive neither justified by nor present anywhere else in this
 * codebase. Consistency is enforced at PROJECT granularity only, via the
 * existing `withProjectSnapshotLock`, exactly as `exportProjectZip`
 * already relies on for the same reason.
 *
 * Ordinary file-mutation routes (`POST /:id/file`, `/:id/move`,
 * `/:id/delete`, `/:id/upload`) do NOT participate in this lock — only
 * snapshot create/restore/delete, export, fork, and this backup do. A
 * file edited/moved/deleted concurrently with a workspace backup may
 * therefore be captured in its pre- or post-edit state, or omitted
 * entirely if it vanished between enumeration and read. This is the
 * accepted eventual-consistency window for this milestone: a vanished
 * file is skipped (not treated as a fatal error), never invented as a
 * global write freeze.
 */

const WORKSPACE_BACKUP_FILENAME_RE = /^[a-zA-Z0-9_-]+\.zip$/;
export const PROJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceBackupMetadata {
  filename: string;
  filePath: string;
  projectId: string;
  sizeBytes: number;
  createdAt: string;
}

export interface WorkspaceBackupCreateResult extends WorkspaceBackupMetadata {
  workspaceFileCount: number;
  snapshotCount: number;
  skippedWorkspaceFiles: number;
}

export interface WorkspaceBackupManifestV1 {
  version: 1;
  projectId: string;
  projectName: string;
  createdAt: string;
  workspaceFileCount: number;
  snapshotCount: number;
  skippedWorkspaceFiles: number;
}

export interface WorkspaceBackupSnapshotEntry {
  id: string;
  name: string;
  userId: number;
  sizeBytes: number;
  createdAt: string;
}

export interface WorkspaceBackupManifestV2 extends Omit<
  WorkspaceBackupManifestV1,
  "version"
> {
  version: 2;
  snapshots: WorkspaceBackupSnapshotEntry[];
}

export type WorkspaceBackupManifest =
  WorkspaceBackupManifestV1 | WorkspaceBackupManifestV2;

/**
 * The archive-size limits (`maxArchiveUploadBytes` etc.) exist to bound
 * untrusted user uploads (import). A workspace backup — and, by the same
 * reasoning, a restore reading one back — is a server-generated,
 * already-size-bounded-by-construction disaster-recovery artifact, so both
 * `createWorkspaceBackup`'s own verification and `workspaceRestore.ts`
 * deliberately override those limits when calling `extractZipArchive`:
 * reusing the MECHANISM (EOCD parsing, CRC32 corruption detection,
 * traversal/symlink rejection), never the user-facing upload POLICY.
 */
export function generousArchiveConfig(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    maxArchiveUploadBytes: Number.MAX_SAFE_INTEGER,
    maxArchiveEntries: Number.MAX_SAFE_INTEGER,
    maxArchiveUncompressedBytes: Number.MAX_SAFE_INTEGER,
    maxArchiveSingleFileBytes: Number.MAX_SAFE_INTEGER,
  };
}

export function assertValidProjectId(projectId: string): void {
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    throw new ApiError(400, "Invalid project ID", "invalid_project_id");
  }
}

export function assertValidWorkspaceBackupFilename(filename: string): void {
  if (
    typeof filename !== "string" ||
    !WORKSPACE_BACKUP_FILENAME_RE.test(filename) ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0")
  ) {
    throw new ApiError(
      400,
      "Invalid workspace backup filename",
      "invalid_filename",
    );
  }
}

function workspaceBackupDir(cfg: AppConfig, projectId: string): string {
  return join(cfg.dataDir, "workspace-backups", projectId);
}

function generateWorkspaceBackupFilename(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const nonce = randomBytes(4).toString("hex");
  return `workspace_backup_${ts}_${nonce}.zip`;
}

/**
 * Lists per-project workspace backup files, newest first. Works purely off
 * the filesystem — deliberately does NOT require the source project to
 * still exist in the `projects` table, so backups of a deleted project
 * remain listable/downloadable/deletable by an admin. The whole point of a
 * disaster-recovery backup is to survive deletion of its source; requiring
 * the source to still exist would defeat that.
 */
export async function listWorkspaceBackups(
  cfg: AppConfig,
  projectId: string,
): Promise<WorkspaceBackupMetadata[]> {
  assertValidProjectId(projectId);
  const dir = workspaceBackupDir(cfg, projectId);
  if (!existsSync(dir)) return [];

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const list: WorkspaceBackupMetadata[] = [];
  for (const name of names) {
    if (!WORKSPACE_BACKUP_FILENAME_RE.test(name)) continue;
    const filePath = join(dir, name);
    try {
      const st = await fs.stat(filePath);
      if (!st.isFile()) continue;
      const createdAt =
        st.birthtime && !isNaN(st.birthtime.getTime())
          ? st.birthtime.toISOString()
          : st.mtime.toISOString();
      list.push({
        filename: name,
        filePath,
        projectId,
        sizeBytes: st.size,
        createdAt,
      });
    } catch {
      continue;
    }
  }

  list.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return list;
}

/**
 * Prunes older workspace backups for one project to stay within count/byte
 * quotas (oldest-first eviction, always retains at least 1 if any exist).
 * Never crosses project boundaries — scoped entirely to `projectId`'s own
 * backup directory. A deletion failure here must not corrupt or discard
 * the backup that was just successfully created and verified in the same
 * call (see `createWorkspaceBackup`: this runs after the new backup is
 * already durably in place).
 */
async function pruneWorkspaceBackups(
  cfg: AppConfig,
  projectId: string,
): Promise<{ prunedCount: number; prunedBytes: number }> {
  const list = await listWorkspaceBackups(cfg, projectId);
  let retainedCount = 0;
  let retainedBytes = 0;
  let prunedCount = 0;
  let prunedBytes = 0;

  for (const backup of list) {
    const wouldExceedCount = retainedCount >= cfg.maxWorkspaceBackupsPerProject;
    const wouldExceedBytes =
      retainedBytes + backup.sizeBytes > cfg.maxWorkspaceBackupBytesPerProject;

    if ((wouldExceedCount || wouldExceedBytes) && retainedCount > 0) {
      try {
        await fs.rm(backup.filePath, { force: true });
        prunedCount++;
        prunedBytes += backup.sizeBytes;
      } catch {
        // Ignored if already removed — never let a prune failure surface
        // as a failure of the backup that was just created.
      }
    } else {
      retainedCount++;
      retainedBytes += backup.sizeBytes;
    }
  }

  return { prunedCount, prunedBytes };
}

/**
 * Verifies a just-built archive by extracting it into a scratch directory,
 * reusing `extractZipArchive`'s existing EOCD-parsing and per-entry CRC32
 * corruption detection — the same mechanism the M21 import path already
 * relies on. The user-facing archive-size limits (`maxArchiveUploadBytes`
 * etc.) are deliberately overridden here: those exist to bound untrusted
 * user uploads, not a server-generated, already-size-bounded-by-
 * construction disaster-recovery artifact — reusing the MECHANISM, not the
 * user-facing POLICY, is the point.
 */
async function verifyArchiveExtractable(
  zipBuffer: Buffer,
  cfg: AppConfig,
): Promise<number> {
  const scratchDir = join(
    cfg.dataDir,
    `tmp_workspace_backup_verify_${randomUUID()}`,
  );
  await fs.mkdir(scratchDir, { recursive: true });
  try {
    const extracted = await extractZipArchive(
      zipBuffer,
      scratchDir,
      generousArchiveConfig(cfg),
    );
    return extracted.filter((e) => !e.isDir).length;
  } finally {
    try {
      await fs.rm(scratchDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Creates a disaster-recovery backup archive for one project, bundling its
 * workspace files (`workspace/<relative-path>`) and snapshot payload
 * bodies (`snapshots/<snapshotId>.gz`) into a single ZIP, plus a
 * `manifest.json` describing what was captured. Sequence: identify project
 * -> acquire the per-project lock -> walk workspace + collect snapshot
 * bodies -> build archive in memory -> verify it extracts cleanly ->
 * write to a same-directory temp file and rename into place (never a
 * partially-written backup file) -> apply retention (still under the same
 * lock, mirroring `createDatabaseBackup`'s own reasoning: the new backup
 * is only prune-eligible once fully written and verified, and pruning
 * inside the lock we already hold avoids self-deadlocking on it).
 *
 * `.env` and other dotfiles are captured exactly like any other workspace
 * file — intentionally: this is a disaster-recovery artifact, and a
 * project's `.env` is part of its durable state. This does concentrate
 * secrets into the backup artifact; access is restricted to platform
 * admins via the same gate as every other admin route, and the artifact
 * is 0o600/dir 0o700 on POSIX (best-effort, see `secureBackupFilePermissions`).
 * Encryption-at-rest is a deliberately deferred decision, not implemented
 * here — see deploy/README.md.
 */
export async function createWorkspaceBackup(
  cfg: AppConfig,
  db: Db,
  projectId: string,
  options?: { actorUserId?: number; ipAddress?: string },
): Promise<WorkspaceBackupCreateResult> {
  assertValidProjectId(projectId);
  const project = getProject(db, projectId);
  if (!project) {
    throw new ApiError(404, "project not found", "not_found");
  }

  return withProjectSnapshotLock(projectId, async () => {
    const cwd = await workspacePath(cfg, projectId);
    const filePaths = await listFiles(cwd);

    const entries: ZipFileEntry[] = [];
    let includedWorkspaceFiles = 0;
    let skippedWorkspaceFiles = 0;
    for (const fp of filePaths) {
      try {
        // M87: confined — a swapped-in symlink is skipped, never followed.
        const content = await readConfinedBytes(cwd, join(cwd, fp));
        entries.push({ path: `workspace/${fp}`, content });
        includedWorkspaceFiles++;
      } catch {
        // Vanished between enumeration and read (concurrent edit/delete —
        // see the eventual-consistency note in this module's doc comment).
        skippedWorkspaceFiles++;
      }
    }

    // Milestone 32 addition: walk the DB rows (source of truth for what a
    // restorable snapshot actually is), not the raw directory listing — a
    // `.gz` file with no matching row would otherwise end up in the
    // archive with no way to reconstruct its `snapshots` table row on
    // restore, which is exactly the "unzip files while leaving
    // inconsistent database metadata" outcome this format must avoid. A
    // row whose body is missing on disk is skipped (and counted), never
    // fabricated.
    const snapDir = snapshotDir(cfg, projectId);
    const snapshotRows = db
      .prepare(
        "SELECT id, name, user_id, size_bytes, created_at FROM snapshots WHERE project_id = ? ORDER BY created_at ASC",
      )
      .all(projectId) as Array<{
      id: string;
      name: string;
      user_id: number;
      size_bytes: number;
      created_at: string;
    }>;

    const manifestSnapshots: WorkspaceBackupSnapshotEntry[] = [];
    let includedSnapshots = 0;
    let skippedSnapshotBodies = 0;
    for (const row of snapshotRows) {
      try {
        const content = await fs.readFile(join(snapDir, `${row.id}.gz`));
        entries.push({ path: `snapshots/${row.id}.gz`, content });
        manifestSnapshots.push({
          id: row.id,
          name: row.name,
          userId: row.user_id,
          sizeBytes: row.size_bytes,
          createdAt: row.created_at,
        });
        includedSnapshots++;
      } catch {
        // DB row exists but the body is missing on disk — skip rather
        // than fabricate a body-less restorable entry.
        skippedSnapshotBodies++;
      }
    }

    const manifest: WorkspaceBackupManifestV2 = {
      version: 2,
      projectId,
      projectName: project.name,
      createdAt: new Date().toISOString(),
      workspaceFileCount: includedWorkspaceFiles,
      snapshotCount: includedSnapshots,
      skippedWorkspaceFiles,
      snapshots: manifestSnapshots,
    };
    entries.push({
      path: "manifest.json",
      content: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    });

    const zipBuffer = createZipArchive(entries);

    const extractedCount = await verifyArchiveExtractable(zipBuffer, cfg);
    if (extractedCount !== entries.length) {
      throw new ApiError(
        500,
        `Workspace backup verification mismatch: built ${entries.length} entries, extracted ${extractedCount}`,
        "workspace_backup_verification_failed",
      );
    }

    const dir = workspaceBackupDir(cfg, projectId);
    ensureBackupDir(dir);

    const filename = generateWorkspaceBackupFilename();
    const finalPath = join(dir, filename);
    const tempPath = join(
      dir,
      `.creating-${process.pid}-${randomBytes(3).toString("hex")}.zip`,
    );
    try {
      await fs.writeFile(tempPath, zipBuffer);
      await fs.rename(tempPath, finalPath);
    } catch (err: any) {
      try {
        await fs.rm(tempPath, { force: true });
      } catch {}
      throw new ApiError(
        500,
        `Failed to write workspace backup: ${err.message}`,
        "workspace_backup_write_failed",
      );
    }

    secureBackupFilePermissions(finalPath);

    const stat = await fs.stat(finalPath);
    const createdAt = new Date().toISOString();

    await pruneWorkspaceBackups(cfg, projectId);

    recordAuditLog(db, {
      userId: options?.actorUserId,
      projectId,
      eventType: "WORKSPACE_BACKUP_CREATED",
      details: {
        filename,
        sizeBytes: stat.size,
        workspaceFileCount: includedWorkspaceFiles,
        snapshotCount: includedSnapshots,
        skippedWorkspaceFiles,
        skippedSnapshotBodies,
      },
      ipAddress: options?.ipAddress,
    });

    return {
      filename,
      filePath: finalPath,
      projectId,
      sizeBytes: stat.size,
      createdAt,
      workspaceFileCount: includedWorkspaceFiles,
      snapshotCount: includedSnapshots,
      skippedWorkspaceFiles,
    };
  });
}

/**
 * Deletes a specific workspace backup file. Like `listWorkspaceBackups`,
 * deliberately does NOT require the source project to still exist —
 * backups intentionally outlive project deletion (see this module's doc
 * comment); an admin can still prune orphaned backups for a project that
 * no longer exists.
 */
export async function deleteWorkspaceBackup(
  cfg: AppConfig,
  db: Db,
  projectId: string,
  filename: string,
  options?: { actorUserId?: number; ipAddress?: string },
): Promise<boolean> {
  assertValidProjectId(projectId);
  assertValidWorkspaceBackupFilename(filename);

  return withProjectSnapshotLock(projectId, async () => {
    const filePath = join(workspaceBackupDir(cfg, projectId), filename);
    if (!existsSync(filePath)) {
      throw new ApiError(404, "Workspace backup not found", "not_found");
    }

    try {
      await fs.rm(filePath, { force: true });
    } catch (err: any) {
      throw new ApiError(
        500,
        `Failed to delete workspace backup: ${err.message}`,
        "delete_failed",
      );
    }

    // audit_logs.project_id is a foreign key with ON DELETE CASCADE — a
    // backup deliberately outlives its source project's deletion (see this
    // module's doc comment), so an audit call for a since-deleted project
    // must not reference a project_id that no longer exists (the insert
    // would silently fail its FK constraint). Fall back to a null
    // project_id, keeping the real id discoverable in `details`.
    const stillExists = getProject(db, projectId) !== null;
    recordAuditLog(db, {
      userId: options?.actorUserId,
      projectId: stillExists ? projectId : null,
      eventType: "WORKSPACE_BACKUP_DELETED",
      details: { filename, projectId },
      ipAddress: options?.ipAddress,
    });

    return true;
  });
}
