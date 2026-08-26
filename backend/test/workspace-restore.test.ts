import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createProject,
  projectDir,
  deleteProject,
} from "../src/projects/service.js";
import { writeProjectFile, readProjectFile } from "../src/files/service.js";
import { createSnapshot, snapshotDir } from "../src/projects/snapshots.js";
import { createZipArchive, extractZipArchive } from "../src/projects/zip.js";
import { createWorkspaceBackup } from "../src/backup/workspaceBackup.js";
import { restoreWorkspaceBackup } from "../src/backup/workspaceRestore.js";
import { collaborationManager } from "../src/collab/manager.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import { telemetryHistorian } from "../src/execution/historian.js";
import { hashPassword } from "../src/auth/passwords.js";
import { ensureAdminUser } from "../src/db.js";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";

describe("Milestone 32 — Per-Project Workspace & Snapshot Restore", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let ownerId: number;
  let ownerToken: string;
  let adminToken: string;

  beforeEach(async () => {
    cfg = makeTestConfig({
      maxWorkspaceBackupsPerProject: 5,
      maxWorkspaceBackupBytesPerProject: 100 * 1024 * 1024,
    });
    api = await startTestApi(cfg);
    db = api.db;

    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "wr_owner", password: "password123" },
    });
    ownerId = reg.data.user.id;
    ownerToken = reg.data.token;

    const adminHash = await hashPassword("AdminPass@123");
    ensureAdminUser(db, "wr_admin", adminHash);
    const adminLogin = await api.request("POST", "/api/auth/admin-login", {
      body: { username: "wr_admin", password: "AdminPass@123" },
    });
    adminToken = adminLogin.data.token;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await api.close();
  });

  async function makeProjectWithContent(): Promise<{
    id: string;
    cwd: string;
  }> {
    const project = await createProject(cfg, db, ownerId, {
      name: "Restore Source Project",
      language: "python",
    });
    const cwd = projectDir(cfg, project.id);
    await writeProjectFile(cwd, "main.py", "print('hello')\n");
    await writeProjectFile(cwd, "src/nested/deep.py", "def f(): pass\n");
    await writeProjectFile(cwd, "empty.txt", "");
    const binaryBuf = Buffer.from([0, 1, 2, 255, 254, 253, 0, 10, 13]);
    await fs.writeFile(join(cwd, "asset.bin"), binaryBuf);
    return { id: project.id, cwd };
  }

  /** Builds a synthetic backup archive directly (bypassing createWorkspaceBackup)
   *  so tests can exercise cases the current backup creator can no longer
   *  produce on its own (an old v1-shaped archive, a tampered manifest). */
  async function writeSyntheticBackup(
    projectId: string,
    manifest: Record<string, unknown>,
    workspaceFiles: Record<string, string>,
    snapshotBodies: Record<string, Buffer> = {},
  ): Promise<string> {
    const entries = [
      ...Object.entries(workspaceFiles).map(([p, content]) => ({
        path: `workspace/${p}`,
        content: Buffer.from(content, "utf8"),
      })),
      ...Object.entries(snapshotBodies).map(([id, content]) => ({
        path: `snapshots/${id}.gz`,
        content,
      })),
      {
        path: "manifest.json",
        content: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
      },
    ];
    const zipBuffer = createZipArchive(entries);
    const dir = join(cfg.dataDir, "workspace-backups", projectId);
    mkdirSync(dir, { recursive: true });
    const filename = `workspace_backup_synthetic-${randomUUID()}.zip`;
    writeFileSync(join(dir, filename), zipBuffer);
    return filename;
  }

  it("1. v2 successful restore: workspace byte fidelity, nested directories, binary, empty files, snapshot body and DB-metadata fidelity", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    const snapshot = await createSnapshot(cfg, db, ownerId, projectId, "Base");
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    // Mutate everything after the backup so restore has real work to do.
    await writeProjectFile(cwd, "main.py", "print('mutated')\n");
    await fs.rm(join(cwd, "src"), { recursive: true, force: true });
    await writeProjectFile(cwd, "new_file.py", "# should be removed\n");
    await createSnapshot(cfg, db, ownerId, projectId, "Post-backup snapshot");

    const result = await restoreWorkspaceBackup(
      cfg,
      db,
      projectId,
      backup.filename,
      { actorUserId: ownerId },
    );

    expect(result.manifestVersion).toBe(2);
    expect(result.workspaceFileCount).toBe(4);
    expect(result.snapshotRestored.attempted).toBe(true);
    expect(result.snapshotRestored.restoredCount).toBe(1);

    expect((await readProjectFile(cwd, "main.py")).content).toBe(
      "print('hello')\n",
    );
    expect((await readProjectFile(cwd, "src/nested/deep.py")).content).toBe(
      "def f(): pass\n",
    );
    expect(existsSync(join(cwd, "empty.txt"))).toBe(true);
    expect(readFileSync(join(cwd, "empty.txt")).length).toBe(0);
    const restoredBinary = readFileSync(join(cwd, "asset.bin"));
    expect(
      Buffer.compare(
        restoredBinary,
        Buffer.from([0, 1, 2, 255, 254, 253, 0, 10, 13]),
      ),
    ).toBe(0);
    // Files created after the backup must be gone (full replace).
    expect(existsSync(join(cwd, "new_file.py"))).toBe(false);

    // Snapshot: exactly the one from the backup survives, with matching
    // DB row metadata.
    const rows = db
      .prepare("SELECT * FROM snapshots WHERE project_id = ?")
      .all(projectId) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(snapshot.id);
    expect(rows[0].name).toBe("Base");
    expect(rows[0].user_id).toBe(ownerId);
    expect(
      existsSync(join(snapshotDir(cfg, projectId), `${snapshot.id}.gz`)),
    ).toBe(true);
  });

  it("2. & 16. v1-shaped backup: workspace restores, snapshot-body restoration is skipped cleanly with an explicit reason, no orphan snapshot files, existing snapshots untouched", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    // A real, current snapshot exists BEFORE the v1 restore -- v1 restore
    // must leave it completely alone (not delete it, not touch its body).
    const preExisting = await createSnapshot(
      cfg,
      db,
      ownerId,
      projectId,
      "Untouched",
    );

    const filename = await writeSyntheticBackup(
      projectId,
      {
        version: 1,
        projectId,
        projectName: "Restore Source Project",
        createdAt: new Date().toISOString(),
        workspaceFileCount: 1,
        snapshotCount: 0,
        skippedWorkspaceFiles: 0,
      },
      { "old_only_file.txt": "from the old v1 backup\n" },
    );

    await writeProjectFile(cwd, "main.py", "print('will be removed')\n");

    const result = await restoreWorkspaceBackup(cfg, db, projectId, filename, {
      actorUserId: ownerId,
    });

    expect(result.manifestVersion).toBe(1);
    expect(result.snapshotRestored.attempted).toBe(false);
    expect(result.snapshotRestored.skippedReason).toMatch(/v1/i);
    expect(result.snapshotRestored.restoredCount).toBe(0);

    expect(existsSync(join(cwd, "old_only_file.txt"))).toBe(true);
    // Workspace full-replace still applies to files.
    expect(existsSync(join(cwd, "main.py"))).toBe(false);

    // The pre-existing snapshot (unrelated to this v1 backup) is untouched.
    const rows = db
      .prepare("SELECT * FROM snapshots WHERE project_id = ?")
      .all(projectId) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(preExisting.id);
    expect(
      existsSync(join(snapshotDir(cfg, projectId), `${preExisting.id}.gz`)),
    ).toBe(true);
  });

  it("3. a corrupted archive is rejected before any live state is touched", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    const backup = await createWorkspaceBackup(cfg, db, projectId);
    // Corrupt the backup file after creation.
    writeFileSync(backup.filePath, Buffer.from("not a zip file"));

    const before = (await readProjectFile(cwd, "main.py")).content;
    await expect(
      restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
        actorUserId: ownerId,
      }),
    ).rejects.toThrow();
    const after = (await readProjectFile(cwd, "main.py")).content;
    expect(after).toBe(before);
  });

  it("5. an oversized manifest.workspaceFileCount / malformed manifest is rejected before any live change", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();

    const filename = await writeSyntheticBackup(
      projectId,
      {
        version: 2,
        projectId,
        projectName: "x",
        createdAt: new Date().toISOString(),
        // Malformed: snapshots must be an array for v2.
        snapshotCount: 0,
        skippedWorkspaceFiles: 0,
        workspaceFileCount: 1,
        snapshots: "not-an-array",
      },
      { "a.txt": "a" },
    );

    const before = (await readProjectFile(cwd, "main.py")).content;
    await expect(
      restoreWorkspaceBackup(cfg, db, projectId, filename, {
        actorUserId: ownerId,
      }),
    ).rejects.toThrow(/manifest/i);
    expect((await readProjectFile(cwd, "main.py")).content).toBe(before);
  });

  it("4. & 21. traversal/absolute/Windows-style/null-byte filenames and cross-project backup filenames are all rejected", async () => {
    const { id: projectA } = await makeProjectWithContent();
    const { id: projectB } = await makeProjectWithContent();
    const backupB = await createWorkspaceBackup(cfg, db, projectB);

    const malicious = [
      "../foo.zip",
      "/etc/passwd.zip",
      "C:\\Windows\\System32\\config.zip",
      "evil\0.zip",
    ];
    for (const filename of malicious) {
      await expect(
        restoreWorkspaceBackup(cfg, db, projectA, filename, {
          actorUserId: ownerId,
        }),
      ).rejects.toThrow();
    }

    // IDOR: project B's real backup filename cannot be restored into
    // project A via route-id substitution -- listWorkspaceBackups scopes
    // by directory, so it's simply not found under project A.
    await expect(
      restoreWorkspaceBackup(cfg, db, projectA, backupB.filename, {
        actorUserId: ownerId,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("6. manifest.projectId mismatch is rejected", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    const otherProjectId = randomUUID();

    const filename = await writeSyntheticBackup(
      projectId,
      {
        version: 1,
        projectId: otherProjectId, // deliberately wrong
        projectName: "x",
        createdAt: new Date().toISOString(),
        workspaceFileCount: 1,
        snapshotCount: 0,
        skippedWorkspaceFiles: 0,
      },
      { "a.txt": "a" },
    );

    const before = (await readProjectFile(cwd, "main.py")).content;
    await expect(
      restoreWorkspaceBackup(cfg, db, projectId, filename, {
        actorUserId: ownerId,
      }),
    ).rejects.toThrow(/project/i);
    expect((await readProjectFile(cwd, "main.py")).content).toBe(before);
  });

  it("7. a snapshot whose original creator account no longer exists restores with a deterministic admin fallback, reported in the result", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const otherReg = await api.request("POST", "/api/auth/register", {
      body: { username: "wr_snapshot_creator", password: "password123" },
    });
    const otherUserId = otherReg.data.user.id;

    // createSnapshot() itself is owner-gated (requireOwnedProject), so a
    // snapshot can only ever be legitimately created by the project owner
    // — to simulate "this snapshot was attributed to a user who has since
    // been deleted" the fixture reassigns the row's user_id directly after
    // creation, which is the state deletion of that account would produce.
    const snapshot = await createSnapshot(
      cfg,
      db,
      ownerId,
      projectId,
      "By other user",
    );
    db.prepare("UPDATE snapshots SET user_id = ? WHERE id = ?").run(
      otherUserId,
      snapshot.id,
    );
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    // The creator's account is deleted after the backup was taken.
    db.prepare("DELETE FROM users WHERE id = ?").run(otherUserId);

    const result = await restoreWorkspaceBackup(
      cfg,
      db,
      projectId,
      backup.filename,
      { actorUserId: ownerId },
    );

    expect(result.deletedUserFallback.count).toBe(1);
    expect(result.deletedUserFallback.snapshotIds).toContain(snapshot.id);

    const row = db
      .prepare("SELECT user_id FROM snapshots WHERE id = ?")
      .get(snapshot.id) as { user_id: number };
    expect(row.user_id).toBe(ownerId); // fell back to the restoring admin
  });

  it("8. active sandbox teardown: stopProjectSandbox is invoked for the project being restored (terminal PTYs die transitively with it)", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    const stopSpy = vi
      .spyOn(sandboxManager, "stopProjectSandbox")
      .mockResolvedValue(undefined);

    await restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
      actorUserId: ownerId,
    });

    expect(stopSpy).toHaveBeenCalledWith(projectId);
  });

  it("9. active collaboration teardown: an existing room is disposed by restore", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    const room = collaborationManager.getOrCreateRoom(projectId);
    expect(collaborationManager.getRoom(projectId)).toBe(room);

    await restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
      actorUserId: ownerId,
    });

    // Disposed rooms remove themselves from the manager's map.
    expect(collaborationManager.getRoom(projectId)).toBeUndefined();
  });

  it("10. reconnect race: a room created during the swap window (after QUIESCE's dispose, before SWAP completes) is disposed by the post-swap RECONNECT step", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    const preRoom = collaborationManager.getOrCreateRoom(projectId);
    expect(collaborationManager.getRoom(projectId)).toBe(preRoom);

    let raceRoomCreated: any = null;
    await restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
      actorUserId: ownerId,
      __testHookAfterQuiesce: () => {
        // QUIESCE's pre-swap dispose already ran and removed preRoom.
        expect(collaborationManager.getRoom(projectId)).toBeUndefined();
        // Simulate a client reconnecting exactly here, mid-swap-window,
        // creating a fresh room that (if nothing mitigated it) would hold
        // a Y.Doc read from the about-to-be-replaced, pre-swap files.
        raceRoomCreated = collaborationManager.getOrCreateRoom(projectId);
        expect(collaborationManager.getRoom(projectId)).toBe(raceRoomCreated);
      },
    });

    expect(raceRoomCreated).not.toBeNull();
    // The race-created room must have been disposed by RECONNECT -- no
    // room capable of flushing stale content survives the restore call.
    expect(collaborationManager.getRoom(projectId)).toBeUndefined();
  });

  it("11. telemetry teardown: disposeProject is invoked for the project being restored", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    const disposeSpy = vi.spyOn(telemetryHistorian, "disposeProject");

    await restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
      actorUserId: ownerId,
    });

    expect(disposeSpy).toHaveBeenCalledWith(projectId);
  });

  it("12. cache invalidation: the tree cache does not serve a stale pre-restore listing afterward", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    const { tree } = await import("../src/files/service.js");
    await tree(cwd); // populate the cache with the pre-restore listing

    const backup = await createWorkspaceBackup(cfg, db, projectId);
    await writeProjectFile(cwd, "extra_after_backup.py", "# extra\n");

    await restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
      actorUserId: ownerId,
    });

    const nodes = await tree(cwd);
    const names = JSON.stringify(nodes);
    expect(names).not.toContain("extra_after_backup.py");
  });

  it("13. rollback after a SWAP-phase failure: original workspace, snapshots, and DB rows are all restored; failed content is quarantined", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    const snapshot = await createSnapshot(
      cfg,
      db,
      ownerId,
      projectId,
      "Pre-restore",
    );
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    await writeProjectFile(
      cwd,
      "main.py",
      "print('should survive rollback')\n",
    );

    await expect(
      restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
        actorUserId: ownerId,
        __testHookAfterWorkspaceSwap: () => {
          throw new Error("simulated SWAP-phase failure");
        },
      }),
    ).rejects.toThrow(/simulated SWAP-phase failure|Workspace restore failed/);

    // Original (pre-restore-attempt) content is back in place.
    expect((await readProjectFile(cwd, "main.py")).content).toBe(
      "print('should survive rollback')\n",
    );
    const rows = db
      .prepare("SELECT * FROM snapshots WHERE project_id = ?")
      .all(projectId) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(snapshot.id);
    expect(
      existsSync(join(snapshotDir(cfg, projectId), `${snapshot.id}.gz`)),
    ).toBe(true);

    // A quarantine directory with the failed attempt's content exists
    // somewhere under dataDir, not silently discarded.
    const quarantineDirs = readdirSync(cfg.dataDir).filter((f) =>
      f.startsWith("tmp_restore_quarantine_"),
    );
    expect(quarantineDirs.length).toBeGreaterThan(0);
  });

  it("14. post-swap verification failure triggers the same rollback guarantees (real tampered manifest, not hook-injected)", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    // Tamper with a genuinely-created backup's manifest to lie about the
    // file count, so VERIFY (not PREPARE) is what catches the mismatch --
    // the swap itself must complete "successfully" first.
    const scratch = join(
      tmpdir(),
      `cloudide-wr-tamper-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(scratch, { recursive: true });
    const buf = readFileSync(backup.filePath);
    await extractZipArchive(buf, scratch, {
      ...cfg,
      maxArchiveUploadBytes: Number.MAX_SAFE_INTEGER,
      maxArchiveEntries: Number.MAX_SAFE_INTEGER,
      maxArchiveUncompressedBytes: Number.MAX_SAFE_INTEGER,
      maxArchiveSingleFileBytes: Number.MAX_SAFE_INTEGER,
    });
    const manifest = JSON.parse(
      readFileSync(join(scratch, "manifest.json"), "utf8"),
    );
    manifest.workspaceFileCount = 999; // lie
    const entries: { path: string; content: Buffer }[] = [];
    for (const fp of [
      "main.py",
      "src/nested/deep.py",
      "empty.txt",
      "asset.bin",
    ]) {
      entries.push({
        path: `workspace/${fp}`,
        content: readFileSync(join(scratch, "workspace", fp)),
      });
    }
    entries.push({
      path: "manifest.json",
      content: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    });
    const tamperedZip = createZipArchive(entries);
    writeFileSync(backup.filePath, tamperedZip);

    await writeProjectFile(
      cwd,
      "main.py",
      "print('should survive rollback')\n",
    );

    await expect(
      restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
        actorUserId: ownerId,
      }),
    ).rejects.toThrow(/verification failed/i);

    expect((await readProjectFile(cwd, "main.py")).content).toBe(
      "print('should survive rollback')\n",
    );
  });

  it("15. repeated restore of the same backup is deterministic", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    for (let i = 0; i < 2; i++) {
      await writeProjectFile(cwd, "main.py", `print('mutation ${i}')\n`);
      const result = await restoreWorkspaceBackup(
        cfg,
        db,
        projectId,
        backup.filename,
        { actorUserId: ownerId },
      );
      expect(result.workspaceFileCount).toBe(4);
      expect((await readProjectFile(cwd, "main.py")).content).toBe(
        "print('hello')\n",
      );
    }
  });

  it("17. a deleted project cannot be restored (not-found, not a crash)", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    await deleteProject(cfg, db, ownerId, projectId);

    await expect(
      restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
        actorUserId: ownerId,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("18. admin auth: anonymous rejected, non-admin rejected, admin succeeds", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const createRes = await api.request(
      "POST",
      `/api/admin/workspace-backups/${projectId}`,
      { token: adminToken },
    );
    const filename = createRes.data.backup.filename;
    const restorePath = `/api/admin/workspace-backups/${projectId}/${filename}/restore`;

    const anonRes = await api.request("POST", restorePath, {});
    expect(anonRes.status).toBe(401);

    const nonAdminRes = await api.request("POST", restorePath, {
      token: ownerToken,
    });
    expect(nonAdminRes.status).toBe(403);

    const adminRes = await api.request("POST", restorePath, {
      token: adminToken,
    });
    expect(adminRes.status).toBe(200);
    expect(adminRes.data.restore.manifestVersion).toBe(2);
  });

  it("19. audit: successful restore and failed/rolled-back restore are both recorded, without secret file contents", async () => {
    const { id: projectId, cwd } = await makeProjectWithContent();
    await writeProjectFile(cwd, ".env", "SUPER_SECRET=do-not-log-me\n");
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    await restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
      actorUserId: ownerId,
    });

    const successRow = db
      .prepare(
        "SELECT details FROM audit_logs WHERE event_type = 'WORKSPACE_BACKUP_RESTORED' AND project_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(projectId) as { details: string };
    expect(successRow).toBeDefined();
    expect(successRow.details).not.toContain("do-not-log-me");

    await expect(
      restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
        actorUserId: ownerId,
        __testHookAfterWorkspaceSwap: () => {
          throw new Error("simulated failure for audit test");
        },
      }),
    ).rejects.toThrow();

    const failRows = db
      .prepare(
        "SELECT details FROM audit_logs WHERE event_type = 'WORKSPACE_BACKUP_RESTORED' AND project_id = ? ORDER BY id DESC LIMIT 1",
      )
      .all(projectId) as { details: string }[];
    expect(failRows.length).toBeGreaterThan(0);
    const failDetails = JSON.parse(failRows[0].details);
    expect(failDetails.failed).toBe(true);
    expect(JSON.stringify(failDetails)).not.toContain("do-not-log-me");
  });

  it("20. no sandbox is eagerly recreated by restore (lazy provisioning preserved)", async () => {
    const { id: projectId } = await makeProjectWithContent();
    const backup = await createWorkspaceBackup(cfg, db, projectId);

    const before = sandboxManager.getActiveSandboxCount();
    await restoreWorkspaceBackup(cfg, db, projectId, backup.filename, {
      actorUserId: ownerId,
    });
    expect(sandboxManager.getActiveSandboxCount()).toBe(before);
  });
});
