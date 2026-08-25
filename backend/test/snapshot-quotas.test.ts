import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import {
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  deleteSnapshot,
} from "../src/projects/snapshots.js";
import {
  createProject,
  deleteProject,
  projectDir,
} from "../src/projects/service.js";
import { writeProjectFile, readProjectFile } from "../src/files/service.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";

describe("Milestone 20 — Project Snapshot Quotas & Retention Management", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let userId: number;
  let userToken: string;

  beforeEach(async () => {
    cfg = makeTestConfig({
      maxSnapshotsPerProject: 3,
      maxSnapshotBytesPerProject: 50 * 1024, // 50KB for test
      maxSnapshotSizeBytes: 20 * 1024, // 20KB for test
    });
    api = await startTestApi(cfg);
    db = api.db;

    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "snap_user_1", password: "password123" },
    });
    userId = reg.data.user.id;
    userToken = reg.data.token;
  });

  afterEach(async () => {
    await api.close();
  });

  it("A. allows snapshot creation under quota", async () => {
    const project = await createProject(cfg, db, userId, {
      name: "SnapTestA",
      language: "python",
    });
    const wsDir = projectDir(cfg, project.id);
    await writeProjectFile(wsDir, "main.py", "print('hello v1')\n");

    const snap = await createSnapshot(cfg, db, userId, project.id, "v1");
    expect(snap.id).toBeDefined();
    expect(snap.name).toBe("v1");
    expect(snap.size_bytes).toBeGreaterThan(0);

    const list = listSnapshots(db, userId, project.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(snap.id);

    const archivePath = join(cfg.dataDir, "snapshots", project.id, `${snap.id}.gz`);
    expect(existsSync(archivePath)).toBe(true);
  });

  it("B. enforces count quota with oldest-first eviction", async () => {
    // maxSnapshotsPerProject is 3
    const project = await createProject(cfg, db, userId, {
      name: "SnapTestB",
      language: "python",
    });
    const wsDir = projectDir(cfg, project.id);

    // Create 3 snapshots
    await writeProjectFile(wsDir, "main.py", "print('v1')\n");
    const snap1 = await createSnapshot(cfg, db, userId, project.id, "Snapshot 1");

    await writeProjectFile(wsDir, "main.py", "print('v2')\n");
    const snap2 = await createSnapshot(cfg, db, userId, project.id, "Snapshot 2");

    await writeProjectFile(wsDir, "main.py", "print('v3')\n");
    const snap3 = await createSnapshot(cfg, db, userId, project.id, "Snapshot 3");

    let list = listSnapshots(db, userId, project.id);
    expect(list).toHaveLength(3);

    // Create 4th snapshot -> snap1 (oldest) must be evicted
    await writeProjectFile(wsDir, "main.py", "print('v4')\n");
    const snap4 = await createSnapshot(cfg, db, userId, project.id, "Snapshot 4");

    list = listSnapshots(db, userId, project.id);
    expect(list).toHaveLength(3);

    const ids = list.map((s) => s.id);
    expect(ids).not.toContain(snap1.id);
    expect(ids).toContain(snap2.id);
    expect(ids).toContain(snap3.id);
    expect(ids).toContain(snap4.id);

    // Verify evicted archive file is deleted from disk
    const snap1Archive = join(
      cfg.dataDir,
      "snapshots",
      project.id,
      `${snap1.id}.gz`,
    );
    expect(existsSync(snap1Archive)).toBe(false);

    // Verify surviving archive files exist on disk
    expect(
      existsSync(join(cfg.dataDir, "snapshots", project.id, `${snap4.id}.gz`)),
    ).toBe(true);
  });

  it("C. enforces byte quota with oldest-first eviction", async () => {
    // Configure small byte quota
    const smallByteCfg = makeTestConfig({
      maxSnapshotsPerProject: 10,
      maxSnapshotBytesPerProject: 2000, // 2000 bytes total
      maxSnapshotSizeBytes: 1000, // 1000 bytes per snapshot
    });
    const smallApi = await startTestApi(smallByteCfg);

    try {
      const reg = await smallApi.request("POST", "/api/auth/register", {
        body: { username: "byte_user", password: "password123" },
      });
      const uId = reg.data.user.id;

      const project = await createProject(smallByteCfg, smallApi.db, uId, {
        name: "ByteTest",
      });
      const wsDir = projectDir(smallByteCfg, project.id);

      // Write ~500 byte files
      await writeProjectFile(wsDir, "data.txt", "A".repeat(400));
      const s1 = await createSnapshot(smallByteCfg, smallApi.db, uId, project.id, "S1");

      await writeProjectFile(wsDir, "data.txt", "B".repeat(400));
      const s2 = await createSnapshot(smallByteCfg, smallApi.db, uId, project.id, "S2");

      await writeProjectFile(wsDir, "data.txt", "C".repeat(400));
      const s3 = await createSnapshot(smallByteCfg, smallApi.db, uId, project.id, "S3");

      // Adding S4 should evict S1 and/or S2 to stay under 2000 bytes
      await writeProjectFile(wsDir, "data.txt", "D".repeat(400));
      const s4 = await createSnapshot(smallByteCfg, smallApi.db, uId, project.id, "S4");

      const list = listSnapshots(smallApi.db, uId, project.id);
      const totalBytes = list.reduce((sum, s) => sum + s.size_bytes, 0);
      expect(totalBytes).toBeLessThanOrEqual(2000);
      expect(list.map((s) => s.id)).toContain(s4.id);
    } finally {
      await smallApi.close();
    }
  });

  it("D. rejects single snapshot that exceeds maxSnapshotSizeBytes", async () => {
    const project = await createProject(cfg, db, userId, {
      name: "LargeSnapTest",
    });
    const wsDir = projectDir(cfg, project.id);
    // Write 30KB of truly random uncompressible data
    const { randomBytes } = await import("node:crypto");
    await writeProjectFile(
      wsDir,
      "large.bin",
      randomBytes(30 * 1024).toString("base64"),
    );

    await expect(
      createSnapshot(cfg, db, userId, project.id, "TooLarge"),
    ).rejects.toThrow(/exceeds limit/);
  });

  it("E. ensures newest snapshot survives and restore works after eviction", async () => {
    const project = await createProject(cfg, db, userId, {
      name: "RestoreAfterEvict",
      language: "python",
    });
    const wsDir = projectDir(cfg, project.id);

    await writeProjectFile(wsDir, "main.py", "print('v1')\n");
    await createSnapshot(cfg, db, userId, project.id, "S1");

    await writeProjectFile(wsDir, "main.py", "print('v2')\n");
    await createSnapshot(cfg, db, userId, project.id, "S2");

    await writeProjectFile(wsDir, "main.py", "print('v3')\n");
    const s3 = await createSnapshot(cfg, db, userId, project.id, "S3");

    await writeProjectFile(wsDir, "main.py", "print('v4')\n");
    const s4 = await createSnapshot(cfg, db, userId, project.id, "S4");

    // S1 was evicted. Restore S3.
    await restoreSnapshot(cfg, db, userId, project.id, s3.id);
    const restoredContent = await readProjectFile(wsDir, "main.py");
    expect(restoredContent.content).toBe("print('v3')\n");
  });

  it("F. handles concurrent snapshot creations without exceeding count quota", async () => {
    const project = await createProject(cfg, db, userId, {
      name: "ConcurrentSnap",
    });
    const wsDir = projectDir(cfg, project.id);
    await writeProjectFile(wsDir, "main.py", "print('conc')\n");

    // Fire 6 snapshot creation requests simultaneously (quota is 3)
    const promises = Array.from({ length: 6 }, (_, i) =>
      createSnapshot(cfg, db, userId, project.id, `Concurrent ${i}`),
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(6);

    // List must have exactly maxSnapshotsPerProject = 3
    const list = listSnapshots(db, userId, project.id);
    expect(list.length).toBeLessThanOrEqual(3);
  });

  it("G. safely handles missing archive files during eviction", async () => {
    const project = await createProject(cfg, db, userId, {
      name: "MissingArchiveTest",
    });
    const wsDir = projectDir(cfg, project.id);

    await writeProjectFile(wsDir, "main.py", "print('s1')\n");
    const s1 = await createSnapshot(cfg, db, userId, project.id, "S1");

    // Delete archive on disk manually
    const a1 = join(cfg.dataDir, "snapshots", project.id, `${s1.id}.gz`);
    await fs.rm(a1, { force: true });
    expect(existsSync(a1)).toBe(false);

    // Create more snapshots to trigger eviction of S1
    for (let i = 2; i <= 4; i++) {
      await writeProjectFile(wsDir, "main.py", `print('s${i}')\n`);
      await createSnapshot(cfg, db, userId, project.id, `S${i}`);
    }

    // Eviction should have succeeded without throwing
    const list = listSnapshots(db, userId, project.id);
    expect(list).toHaveLength(3);
    expect(list.map((s) => s.id)).not.toContain(s1.id);
  });

  it("H. removes snapshot directory on project deletion", async () => {
    const project = await createProject(cfg, db, userId, {
      name: "ProjDeleteSnapTest",
    });
    const wsDir = projectDir(cfg, project.id);
    await writeProjectFile(wsDir, "main.py", "print('del')\n");
    await createSnapshot(cfg, db, userId, project.id, "S1");

    const snapDir = join(cfg.dataDir, "snapshots", project.id);
    expect(existsSync(snapDir)).toBe(true);

    await deleteProject(cfg, db, userId, project.id);
    expect(existsSync(snapDir)).toBe(false);
  });

  it("I. respects ownership: non-owner cannot create, restore, or delete snapshots", async () => {
    const reg2 = await api.request("POST", "/api/auth/register", {
      body: { username: "snap_user_2", password: "password123" },
    });
    const user2Id = reg2.data.user.id;

    const project = await createProject(cfg, db, userId, {
      name: "OwnerTestProj",
    });
    const wsDir = projectDir(cfg, project.id);
    await writeProjectFile(wsDir, "main.py", "print('owner')\n");
    const snap = await createSnapshot(cfg, db, userId, project.id, "OwnerSnap");

    // Non-owner trying to create snapshot
    await expect(
      createSnapshot(cfg, db, user2Id, project.id, "AttackerSnap"),
    ).rejects.toThrow();

    // Non-owner trying to restore snapshot
    await expect(
      restoreSnapshot(cfg, db, user2Id, project.id, snap.id),
    ).rejects.toThrow();

    // Non-owner trying to delete snapshot
    await expect(
      deleteSnapshot(cfg, db, user2Id, project.id, snap.id),
    ).rejects.toThrow();
  });

  it("J. rejects snapshot when single snapshot exceeds project storage limit", async () => {
    const tinyCfg = makeTestConfig({
      maxSnapshotBytesPerProject: 500, // 500 bytes max
      maxSnapshotSizeBytes: 1000,
    });
    const tinyApi = await startTestApi(tinyCfg);

    try {
      const reg = await tinyApi.request("POST", "/api/auth/register", {
        body: { username: "tiny_user", password: "password123" },
      });
      const project = await createProject(tinyCfg, tinyApi.db, reg.data.user.id, {
        name: "TinyProj",
      });
      const wsDir = projectDir(tinyCfg, project.id);
      const { randomBytes } = await import("node:crypto");
      await writeProjectFile(wsDir, "data.bin", randomBytes(600).toString("base64"));

      await expect(
        createSnapshot(tinyCfg, tinyApi.db, reg.data.user.id, project.id, "Overflow"),
      ).rejects.toThrow(/exceeds project storage quota/);
    } finally {
      await tinyApi.close();
    }
  });

  it("K. verifies default configuration values", async () => {
    const defaultConfig = (await import("../src/config.js")).resolveConfig();
    expect(defaultConfig.maxSnapshotsPerProject).toBe(10);
    expect(defaultConfig.maxSnapshotBytesPerProject).toBe(20 * 1024 * 1024);
    expect(defaultConfig.maxSnapshotSizeBytes).toBe(5 * 1024 * 1024);
  });
});
