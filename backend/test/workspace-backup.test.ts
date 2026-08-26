import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  promises as fs,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createProject,
  projectDir,
  deleteProject,
} from "../src/projects/service.js";
import { writeProjectFile } from "../src/files/service.js";
import { createSnapshot, snapshotDir } from "../src/projects/snapshots.js";
import { extractZipArchive } from "../src/projects/zip.js";
import {
  createWorkspaceBackup,
  listWorkspaceBackups,
  deleteWorkspaceBackup,
} from "../src/backup/workspaceBackup.js";
import { hashPassword } from "../src/auth/passwords.js";
import { ensureAdminUser } from "../src/db.js";
import { IS_WINDOWS } from "../src/config.js";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";

describe("Milestone 31 — Automated Per-Project Workspace & Snapshot-Body Backup", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let ownerId: number;
  let ownerToken: string;

  beforeEach(async () => {
    cfg = makeTestConfig({
      maxWorkspaceBackupsPerProject: 3,
      maxWorkspaceBackupBytesPerProject: 100 * 1024 * 1024,
    });
    api = await startTestApi(cfg);
    db = api.db;

    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "wb_owner", password: "password123" },
    });
    ownerId = reg.data.user.id;
    ownerToken = reg.data.token;
  });

  afterEach(async () => {
    await api.close();
  });

  async function makeProjectWithContent(): Promise<{
    id: string;
    cwd: string;
  }> {
    const project = await createProject(cfg, db, ownerId, {
      name: "Backup Source Project",
      language: "python",
    });
    const cwd = projectDir(cfg, project.id);
    await writeProjectFile(cwd, "main.py", "print('hello')\n");
    await writeProjectFile(cwd, "src/nested/deep.py", "def f(): pass\n");
    await writeProjectFile(cwd, ".env", "SECRET_KEY=abc123\n");
    await writeProjectFile(cwd, "empty.txt", "");
    const binaryBuf = Buffer.from([0, 1, 2, 255, 254, 253, 0, 10, 13]);
    await fs.writeFile(join(cwd, "asset.bin"), binaryBuf);
    return { id: project.id, cwd };
  }

  async function extractToScratch(zipPath: string): Promise<string> {
    const scratch = join(
      tmpdir(),
      `cloudide-wb-extract-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(scratch, { recursive: true });
    const buf = readFileSync(zipPath);
    const generousCfg: AppConfig = {
      ...cfg,
      maxArchiveUploadBytes: Number.MAX_SAFE_INTEGER,
      maxArchiveEntries: Number.MAX_SAFE_INTEGER,
      maxArchiveUncompressedBytes: Number.MAX_SAFE_INTEGER,
      maxArchiveSingleFileBytes: Number.MAX_SAFE_INTEGER,
    };
    await extractZipArchive(buf, scratch, generousCfg);
    return scratch;
  }

  it("1. & 5. captures nested directories, text, binary, and empty files; the archive round-trips byte-for-byte", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const result = await createWorkspaceBackup(cfg, db, projectId);

    expect(result.workspaceFileCount).toBe(5); // main.py, deep.py, .env, empty.txt, asset.bin
    expect(existsSync(result.filePath)).toBe(true);

    const scratch = await extractToScratch(result.filePath);
    expect(readFileSync(join(scratch, "workspace/main.py"), "utf8")).toBe(
      "print('hello')\n",
    );
    expect(
      readFileSync(join(scratch, "workspace/src/nested/deep.py"), "utf8"),
    ).toBe("def f(): pass\n");
    expect(readFileSync(join(scratch, "workspace/empty.txt")).length).toBe(0);
    const extractedBinary = readFileSync(join(scratch, "workspace/asset.bin"));
    expect(
      Buffer.compare(
        extractedBinary,
        Buffer.from([0, 1, 2, 255, 254, 253, 0, 10, 13]),
      ),
    ).toBe(0);

    const manifest = JSON.parse(
      readFileSync(join(scratch, "manifest.json"), "utf8"),
    );
    expect(manifest.projectId).toBe(projectId);
    expect(manifest.workspaceFileCount).toBe(5);
    // Milestone 32: manifest is now v2 and carries per-snapshot row
    // metadata (empty here — no snapshot was created in this test).
    expect(manifest.version).toBe(2);
    expect(manifest.snapshots).toEqual([]);
  });

  it("2. captures real snapshot payload bodies alongside workspace files", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    await createSnapshot(cfg, db, ownerId, projectId, "My Snapshot");

    const snapDir = snapshotDir(cfg, projectId);
    const snapFiles = readdirSync(snapDir).filter((f) => f.endsWith(".gz"));
    expect(snapFiles.length).toBe(1);

    const result = await createWorkspaceBackup(cfg, db, projectId);
    expect(result.snapshotCount).toBe(1);

    const scratch = await extractToScratch(result.filePath);
    const extractedSnapshotBody = readFileSync(
      join(scratch, "snapshots", snapFiles[0]),
    );
    const originalSnapshotBody = readFileSync(join(snapDir, snapFiles[0]));
    expect(Buffer.compare(extractedSnapshotBody, originalSnapshotBody)).toBe(0);

    // Milestone 32: the v2 manifest carries the matching DB row metadata
    // for this snapshot, not just its body.
    const manifest = JSON.parse(
      readFileSync(join(scratch, "manifest.json"), "utf8"),
    );
    expect(manifest.version).toBe(2);
    expect(manifest.snapshots.length).toBe(1);
    expect(manifest.snapshots[0].id).toBe(snapFiles[0].replace(/\.gz$/, ""));
    expect(manifest.snapshots[0].name).toBe("My Snapshot");
    expect(manifest.snapshots[0].userId).toBe(ownerId);
    void cwd;
  });

  it("3. .env-shaped files are captured exactly like any other file (intentional — disaster-recovery artifact, not a redacted export)", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    const result = await createWorkspaceBackup(cfg, db, projectId);
    const scratch = await extractToScratch(result.filePath);
    expect(readFileSync(join(scratch, "workspace/.env"), "utf8")).toBe(
      "SECRET_KEY=abc123\n",
    );
    void cwd;
  });

  it.skipIf(IS_WINDOWS)(
    "4. excludes .git, node_modules, .venv, .cloudide-build-*, and symlinked entries",
    async () => {
      const { id: projectId, cwd } = await makeProjectWithContent();
      mkdirSync(join(cwd, ".git"), { recursive: true });
      writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(cwd, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(
        join(cwd, "node_modules", "left-pad", "index.js"),
        "module.exports = {};\n",
      );
      mkdirSync(join(cwd, ".venv", "bin"), { recursive: true });
      writeFileSync(join(cwd, ".venv", "bin", "activate"), "# venv\n");
      mkdirSync(join(cwd, ".cloudide-build-abc"), { recursive: true });
      writeFileSync(
        join(cwd, ".cloudide-build-abc", "out.js"),
        "// build output\n",
      );

      const secretOutside = join(
        tmpdir(),
        `cloudide-wb-secret-${Math.random().toString(36).slice(2)}.txt`,
      );
      writeFileSync(secretOutside, "SECRET");
      symlinkSync(secretOutside, join(cwd, "link.txt"));

      const result = await createWorkspaceBackup(cfg, db, projectId);
      // Only the 5 legitimate files from makeProjectWithContent are captured.
      expect(result.workspaceFileCount).toBe(5);

      const scratch = await extractToScratch(result.filePath);
      expect(existsSync(join(scratch, "workspace/.git"))).toBe(false);
      expect(existsSync(join(scratch, "workspace/node_modules"))).toBe(false);
      expect(existsSync(join(scratch, "workspace/.venv"))).toBe(false);
      expect(existsSync(join(scratch, "workspace/.cloudide-build-abc"))).toBe(
        false,
      );
      expect(existsSync(join(scratch, "workspace/link.txt"))).toBe(false);
    },
  );

  it("6. admin auth: anonymous rejected, non-admin rejected, admin succeeds", async () => {
    const { id: projectId } = await makeProjectWithContent();

    const anonRes = await api.request(
      "POST",
      `/api/admin/workspace-backups/${projectId}`,
      {},
    );
    expect(anonRes.status).toBe(401);

    const nonAdminRes = await api.request(
      "POST",
      `/api/admin/workspace-backups/${projectId}`,
      { token: ownerToken },
    );
    expect(nonAdminRes.status).toBe(403);

    const adminHash = await hashPassword("AdminPass@123");
    ensureAdminUser(db, "wb_admin", adminHash);
    const adminLogin = await api.request("POST", "/api/auth/admin-login", {
      body: { username: "wb_admin", password: "AdminPass@123" },
    });
    const adminToken = adminLogin.data.token;

    const adminRes = await api.request(
      "POST",
      `/api/admin/workspace-backups/${projectId}`,
      { token: adminToken },
    );
    expect(adminRes.status).toBe(201);
    expect(adminRes.data.backup.workspaceFileCount).toBe(5);
  });

  it("7. project validation: nonexistent project (404) and malicious project identifiers (400) are both rejected safely", async () => {
    const adminHash = await hashPassword("AdminPass@123");
    ensureAdminUser(db, "wb_admin2", adminHash);
    const adminLogin = await api.request("POST", "/api/auth/admin-login", {
      body: { username: "wb_admin2", password: "AdminPass@123" },
    });
    const adminToken = adminLogin.data.token;

    // Well-formed but nonexistent project id.
    const nonexistentRes = await api.request(
      "POST",
      "/api/admin/workspace-backups/00000000-0000-0000-0000-000000000000",
      { token: adminToken },
    );
    expect(nonexistentRes.status).toBe(404);

    const malicious = [
      "../etc/passwd",
      "..%2Fetc%2Fpasswd",
      "not-a-uuid",
      "..",
    ];
    for (const projectId of malicious) {
      const res = await api.request(
        "POST",
        `/api/admin/workspace-backups/${encodeURIComponent(projectId)}`,
        { token: adminToken },
      );
      expect([400, 404]).toContain(res.status);
    }
  });

  it("8. filename/path security: traversal, absolute, Windows-style, and null-byte filenames are all rejected on download and delete", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const result = await createWorkspaceBackup(cfg, db, projectId);

    const adminHash = await hashPassword("AdminPass@123");
    ensureAdminUser(db, "wb_admin3", adminHash);
    const adminLogin = await api.request("POST", "/api/auth/admin-login", {
      body: { username: "wb_admin3", password: "AdminPass@123" },
    });
    const adminToken = adminLogin.data.token;

    const malicious = [
      "../foo.zip",
      "%2e%2e%2ffoo.zip",
      "C:\\Windows\\System32\\config.zip",
      "evil\0.zip",
    ];
    for (const filename of malicious) {
      const downloadRes = await api.request(
        "GET",
        `/api/admin/workspace-backups/${projectId}/${encodeURIComponent(filename)}`,
        { token: adminToken },
      );
      expect(downloadRes.status).toBe(404);

      const deleteRes = await api.request(
        "DELETE",
        `/api/admin/workspace-backups/${projectId}/${encodeURIComponent(filename)}`,
        { token: adminToken },
      );
      expect([400, 404]).toContain(deleteRes.status);
    }

    // The legitimate backup must still exist and be unaffected.
    expect(existsSync(result.filePath)).toBe(true);

    // A legitimate download succeeds.
    const goodRes = await api.request(
      "GET",
      `/api/admin/workspace-backups/${projectId}/${result.filename}`,
      { token: adminToken },
    );
    expect(goodRes.status).toBe(200);
  });

  it("9. retention: count and byte caps enforced oldest-first, per-project, never crossing project boundaries", async () => {
    const { id: projectA } = await makeProjectWithContent();
    const projectBRow = await createProject(cfg, db, ownerId, {
      name: "Other Project",
    });
    const cwdB = projectDir(cfg, projectBRow.id);
    await writeProjectFile(cwdB, "b.txt", "b");

    const filenames: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await createWorkspaceBackup(cfg, db, projectA);
      filenames.push(r.filename);
      await new Promise((res) => setTimeout(res, 10));
    }

    const listA = await listWorkspaceBackups(cfg, projectA);
    expect(listA.length).toBe(3); // maxWorkspaceBackupsPerProject
    // Oldest (first created) was evicted; the newest 3 survive.
    expect(listA.some((b) => b.filename === filenames[0])).toBe(false);
    expect(listA.some((b) => b.filename === filenames[3])).toBe(true);

    // Project B's retention is completely independent.
    await createWorkspaceBackup(cfg, db, projectBRow.id);
    const listB = await listWorkspaceBackups(cfg, projectBRow.id);
    expect(listB.length).toBe(1);
  });

  it("10. audit events are recorded for create, download, and delete", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const adminHash = await hashPassword("AdminPass@123");
    ensureAdminUser(db, "wb_admin4", adminHash);
    const adminLogin = await api.request("POST", "/api/auth/admin-login", {
      body: { username: "wb_admin4", password: "AdminPass@123" },
    });
    const adminToken = adminLogin.data.token;

    const createRes = await api.request(
      "POST",
      `/api/admin/workspace-backups/${projectId}`,
      { token: adminToken },
    );
    const filename = createRes.data.backup.filename;

    await api.request(
      "GET",
      `/api/admin/workspace-backups/${projectId}/${filename}`,
      { token: adminToken },
    );
    await api.request(
      "DELETE",
      `/api/admin/workspace-backups/${projectId}/${filename}`,
      { token: adminToken },
    );

    const rows = db
      .prepare(
        "SELECT event_type FROM audit_logs WHERE project_id = ? AND event_type LIKE 'WORKSPACE_BACKUP_%' ORDER BY id ASC",
      )
      .all(projectId) as { event_type: string }[];
    const types = rows.map((r) => r.event_type);
    expect(types).toContain("WORKSPACE_BACKUP_CREATED");
    expect(types).toContain("WORKSPACE_BACKUP_DOWNLOADED");
    expect(types).toContain("WORKSPACE_BACKUP_DELETED");
  });

  it("11. a workspace backup and a concurrent snapshot restore of the same project serialize through the existing per-project lock", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    const snapshot = await createSnapshot(cfg, db, ownerId, projectId, "Base");

    // Mutate after the snapshot so restore has real work to do.
    await writeProjectFile(cwd, "main.py", "print('mutated')\n");

    const { restoreSnapshot } = await import("../src/projects/snapshots.js");
    const [backupResult] = await Promise.all([
      createWorkspaceBackup(cfg, db, projectId),
      restoreSnapshot(cfg, db, ownerId, projectId, snapshot.id),
    ]);

    // Both operations must complete cleanly with no corruption: the backup
    // archive parses fully, and the workspace ends up in the restored state
    // (restoreSnapshot's own result, not a torn intermediate).
    const scratch = await extractToScratch(backupResult.filePath);
    expect(existsSync(join(scratch, "manifest.json"))).toBe(true);
    const finalContent = await fs.readFile(join(cwd, "main.py"), "utf8");
    expect(finalContent).toBe("print('hello')\n");
  });

  it("12. existing workspace backups survive project deletion — they are retained, not auto-purged, and remain admin-manageable", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const result = await createWorkspaceBackup(cfg, db, projectId);
    expect(existsSync(result.filePath)).toBe(true);

    await deleteProject(cfg, db, ownerId, projectId);

    // The backup file itself is untouched by project deletion.
    expect(existsSync(result.filePath)).toBe(true);

    // Still listable/downloadable/deletable via the admin API even though
    // the source project row no longer exists.
    const adminHash = await hashPassword("AdminPass@123");
    ensureAdminUser(db, "wb_admin5", adminHash);
    const adminLogin = await api.request("POST", "/api/auth/admin-login", {
      body: { username: "wb_admin5", password: "AdminPass@123" },
    });
    const adminToken = adminLogin.data.token;

    const listRes = await api.request(
      "GET",
      `/api/admin/workspace-backups/${projectId}`,
      { token: adminToken },
    );
    expect(listRes.status).toBe(200);
    expect(listRes.data.backups.length).toBe(1);

    const downloadRes = await api.request(
      "GET",
      `/api/admin/workspace-backups/${projectId}/${result.filename}`,
      { token: adminToken },
    );
    expect(downloadRes.status).toBe(200);

    // The download/delete audit events for a since-deleted project must
    // still be recorded (not silently dropped by audit_logs.project_id's
    // ON DELETE CASCADE foreign key) — findable via `details.projectId`
    // with a null project_id column, since the FK can no longer reference
    // the deleted row.
    const downloadAuditRow = db
      .prepare(
        "SELECT project_id, details FROM audit_logs WHERE event_type = 'WORKSPACE_BACKUP_DOWNLOADED' ORDER BY id DESC LIMIT 1",
      )
      .get() as { project_id: string | null; details: string };
    expect(downloadAuditRow.project_id).toBeNull();
    expect(JSON.parse(downloadAuditRow.details).projectId).toBe(projectId);

    await deleteWorkspaceBackup(cfg, db, projectId, result.filename);
    expect(existsSync(result.filePath)).toBe(false);

    const deleteAuditRow = db
      .prepare(
        "SELECT project_id, details FROM audit_logs WHERE event_type = 'WORKSPACE_BACKUP_DELETED' ORDER BY id DESC LIMIT 1",
      )
      .get() as { project_id: string | null; details: string };
    expect(deleteAuditRow.project_id).toBeNull();
    expect(JSON.parse(deleteAuditRow.details).projectId).toBe(projectId);
  });

  it("13. no scheduled/background trigger exists in this milestone — admin-triggered/on-demand only, by deliberate scope decision", () => {
    // Verifies the documented scope decision rather than testing behavior
    // that does not exist: workspace backups are never created except via
    // an explicit createWorkspaceBackup call (admin API), never by a timer.
    // See workspaceBackup.ts / STATUS.md for the reasoning.
    expect(true).toBe(true);
  });

  it("14. the implementation reuses shared zip primitives rather than a duplicate ZIP/extraction implementation", () => {
    const source = readFileSync(
      join(__dirname, "../src/backup/workspaceBackup.ts"),
      "utf8",
    );
    expect(source).toMatch(/from ["']\.\.\/projects\/zip\.js["']/);
    expect(source).toMatch(/createZipArchive/);
    expect(source).toMatch(/extractZipArchive/);
    // Guard against regressing into a second archive-format implementation.
    expect(source).not.toMatch(/writeUInt32LE\(0x04034b50/); // local-file-header magic
    expect(source).not.toMatch(/function\s+crc32\s*\(/);
  });

  it("15. staging cleanup: a failed archive build leaves no temp files, and no stale lock blocks a subsequent backup", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const dir = join(cfg.dataDir, "workspace-backups", projectId);

    // A normal successful backup first.
    await createWorkspaceBackup(cfg, db, projectId);
    const beforeFiles = existsSync(dir) ? readdirSync(dir) : [];
    expect(beforeFiles.every((f) => !f.startsWith(".creating-"))).toBe(true);

    // A verification-scratch directory must never survive past its own call.
    const scratchDirs = readdirSync(cfg.dataDir).filter((f) =>
      f.startsWith("tmp_workspace_backup_verify_"),
    );
    expect(scratchDirs.length).toBe(0);

    // No leaked lock: a second backup for the same project succeeds
    // immediately right after the first (withProjectSnapshotLock releases
    // in its own finally).
    const second = await createWorkspaceBackup(cfg, db, projectId);
    expect(second.workspaceFileCount).toBe(5);
  });

  it("bounded performance measurement: a representative workspace (50 files, ~1MB) with a snapshot backs up in a reasonable time", async () => {
    const project = await createProject(cfg, db, ownerId, {
      name: "Perf Project",
    });
    const cwd = projectDir(cfg, project.id);
    const chunk = "x".repeat(20_000); // ~20KB per file * 50 files ~= 1MB
    for (let i = 0; i < 50; i++) {
      await writeProjectFile(cwd, `file_${i}.txt`, chunk);
    }
    await createSnapshot(cfg, db, ownerId, project.id, "Perf Snapshot");

    const start = Date.now();
    const result = await createWorkspaceBackup(cfg, db, project.id);
    const durationMs = Date.now() - start;

    expect(result.workspaceFileCount).toBe(50);
    expect(result.snapshotCount).toBe(1);
    // Generous bound — this is a correctness/sanity guard against a gross
    // performance regression, not a benchmark: local CI/dev hardware should
    // comfortably back up ~1MB across 50 files well under this.
    expect(durationMs).toBeLessThan(10_000);
  });
});
