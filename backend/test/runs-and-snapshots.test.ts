import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let api: TestApi;
let cfg: ReturnType<typeof makeTestConfig>;
let token: string;
let projectId: string;

beforeAll(async () => {
  cfg = makeTestConfig();
  api = await startTestApi(cfg);

  const authRes = await api.request("POST", "/api/auth/register", {
    body: { username: "testruns", password: "password123" },
  });
  token = authRes.data.token;

  const projRes = await api.request("POST", "/api/projects", {
    token,
    body: { name: "Test Runs Project", language: "python" },
  });
  projectId = projRes.data.project.id;
});

afterAll(async () => {
  await api?.close();
});

describe("Job History, Telemetry Stats & Snapshots API", () => {
  it("GET /api/projects/:id/stats returns structured container metrics", async () => {
    const res = await api.request("GET", `/api/projects/${projectId}/stats`, {
      token,
    });
    expect(res.status).toBe(200);
    expect(res.data.stats).toBeDefined();
    expect(typeof res.data.stats.cpuPercent).toBe("number");
    expect(typeof res.data.stats.memoryUsageBytes).toBe("number");
    expect(typeof res.data.stats.memoryLimitBytes).toBe("number");
    expect(typeof res.data.stats.pids).toBe("number");
  });

  it("GET /api/projects/:id/runs returns recorded execution history", async () => {
    // Record sample run in database
    api.db
      .prepare(
        `
      INSERT INTO runs (id, project_id, user_id, language, file_path, status, exit_code, duration_ms)
      VALUES ('run-sample-1', ?, 1, 'python', 'main.py', 'success', 0, 42)
    `,
      )
      .run(projectId);

    const res = await api.request("GET", `/api/projects/${projectId}/runs`, {
      token,
    });
    expect(res.status).toBe(200);
    expect(res.data.runs).toHaveLength(1);
    expect(res.data.runs[0].id).toBe("run-sample-1");
    expect(res.data.runs[0].duration_ms).toBe(42);
    expect(res.data.total).toBe(1);
  });

  it("handles workspace snapshot creation, listing, restore, and deletion", async () => {
    // 1. Create a sample file
    await api.request("POST", `/api/projects/${projectId}/file`, {
      token,
      body: { path: "test.py", content: 'print("v1")' },
    });

    // 2. Create snapshot
    const snapRes = await api.request(
      "POST",
      `/api/projects/${projectId}/snapshots`,
      {
        token,
        body: { name: "Initial V1" },
      },
    );
    expect(snapRes.status).toBe(201);
    const snapshotId = snapRes.data.snapshot.id;
    expect(snapshotId).toBeDefined();
    expect(snapRes.data.snapshot.name).toBe("Initial V1");

    // 3. List snapshots
    const listRes = await api.request(
      "GET",
      `/api/projects/${projectId}/snapshots`,
      { token },
    );
    expect(listRes.status).toBe(200);
    expect(listRes.data.snapshots).toHaveLength(1);

    // 4. Modify workspace file
    await api.request("POST", `/api/projects/${projectId}/file`, {
      token,
      body: { path: "test.py", content: 'print("v2 - modified")' },
    });

    // 5. Restore snapshot
    const restoreRes = await api.request(
      "POST",
      `/api/projects/${projectId}/snapshots/${snapshotId}/restore`,
      { token },
    );
    expect(restoreRes.status).toBe(200);

    // 6. Verify restored file content
    const fileRes = await api.request(
      "GET",
      `/api/projects/${projectId}/file?path=test.py`,
      { token },
    );
    expect(fileRes.status).toBe(200);
    expect(fileRes.data.content).toBe('print("v1")');

    // 7. Delete snapshot
    const delRes = await api.request(
      "DELETE",
      `/api/projects/${projectId}/snapshots/${snapshotId}`,
      { token },
    );
    expect(delRes.status).toBe(200);

    const afterDelete = await api.request(
      "GET",
      `/api/projects/${projectId}/snapshots`,
      { token },
    );
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.data.snapshots).toHaveLength(0);
  });

  it("restore preserves untouched current files if a snapshot write fails partway through", async () => {
    const proj = await api.request("POST", "/api/projects", {
      token,
      body: { name: "Restore Ordering Project" },
    });
    const pid = proj.data.project.id;

    // Snapshot captures a.txt and b.txt.
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: "a.txt", content: "snapshot-a" },
    });
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: "b.txt", content: "snapshot-b" },
    });
    const snapRes = await api.request(
      "POST",
      `/api/projects/${pid}/snapshots`,
      {
        token,
        body: { name: "before-corruption" },
      },
    );
    const snapshotId = snapRes.data.snapshot.id;

    // After the snapshot, replace b.txt with a DIRECTORY of the same name,
    // so restoring it will fail (writeProjectFile can't write a file where
    // a directory exists), and add keep.txt — a file that must survive if
    // the restore's delete-leftovers phase never runs because the write
    // phase failed first.
    await api.request("POST", `/api/projects/${pid}/delete`, {
      token,
      body: { path: "b.txt" },
    });
    mkdirSync(join(cfg.workspacesDir, pid, "b.txt"), { recursive: true });
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: "keep.txt", content: "must-survive" },
    });

    const restoreRes = await api.request(
      "POST",
      `/api/projects/${pid}/snapshots/${snapshotId}/restore`,
      { token },
    );
    expect(restoreRes.status).toBeGreaterThanOrEqual(400);

    // keep.txt was never part of the snapshot and the write phase failed
    // before the delete-leftovers phase could run — it must still exist,
    // proving a partial write failure does not destroy content the
    // restore never got to. Under the old delete-then-write ordering,
    // this file would already have been deleted regardless of whether the
    // subsequent write succeeded.
    const keepRes = await api.request(
      "GET",
      `/api/projects/${pid}/file?path=keep.txt`,
      { token },
    );
    expect(keepRes.status).toBe(200);
    expect(keepRes.data.content).toBe("must-survive");
  });

  it("deleting a real snapshot removes both the archive file and the DB row", async () => {
    const proj = await api.request("POST", "/api/projects", {
      token,
      body: { name: "Delete Happy Path" },
    });
    const pid = proj.data.project.id;
    await api.request("POST", `/api/projects/${pid}/file`, {
      token,
      body: { path: "main.py", content: 'print("hi")' },
    });

    const snapRes = await api.request(
      "POST",
      `/api/projects/${pid}/snapshots`,
      { token, body: { name: "to-delete" } },
    );
    expect(snapRes.status).toBe(201);
    const snapshotId = snapRes.data.snapshot.id;
    const archivePath = join(cfg.dataDir, "snapshots", pid, `${snapshotId}.gz`);
    expect(existsSync(archivePath)).toBe(true);

    const delRes = await api.request(
      "DELETE",
      `/api/projects/${pid}/snapshots/${snapshotId}`,
      { token },
    );
    expect(delRes.status).toBe(200);
    expect(existsSync(archivePath)).toBe(false);
    expect(
      api.db
        .prepare("SELECT COUNT(*) AS n FROM snapshots WHERE id = ?")
        .get(snapshotId),
    ).toMatchObject({ n: 0 });
  });

  it("rejects a traversal snapshotId instead of unlinking a file outside the project's snapshot dir", async () => {
    // Victim project with a real snapshot archive living in a sibling
    // snapshot directory, plus a planted file outside dataDir/snapshots
    // entirely. Neither may be reachable from the attacker's own project.
    const victim = await api.request("POST", "/api/projects", {
      token,
      body: { name: "Victim Project" },
    });
    const victimId = victim.data.project.id;
    await api.request("POST", `/api/projects/${victimId}/file`, {
      token,
      body: { path: "secret.py", content: "victim-content" },
    });
    const victimSnap = await api.request(
      "POST",
      `/api/projects/${victimId}/snapshots`,
      { token, body: { name: "victim-snapshot" } },
    );
    const victimSnapshotId = victimSnap.data.snapshot.id;
    const victimArchive = join(
      cfg.dataDir,
      "snapshots",
      victimId,
      `${victimSnapshotId}.gz`,
    );
    expect(existsSync(victimArchive)).toBe(true);

    const plantedPath = join(cfg.dataDir, "planted.gz");
    writeFileSync(plantedPath, "do-not-delete");

    const attacker = await api.request("POST", "/api/projects", {
      token,
      body: { name: "Attacker Project" },
    });
    const attackerId = attacker.data.project.id;

    // %2f keeps the traversal intact through the URL parser; Express decodes
    // it back into `../..` inside req.params.snapshotId.
    const crossTenant = `..%2f${victimId}%2f${victimSnapshotId}`;
    const outsideDataDir = "..%2f..%2fplanted";
    const statuses: number[] = [];
    for (const payload of [crossTenant, outsideDataDir]) {
      const res = await api.request(
        "DELETE",
        `/api/projects/${attackerId}/snapshots/${payload}`,
        { token },
      );
      statuses.push(res.status);
    }

    // The traversal targets must be untouched — this is the security
    // assertion, checked before the status codes so a regression reports the
    // actual damage (an unlinked file) rather than just a wrong status.
    expect(existsSync(victimArchive)).toBe(true);
    expect(existsSync(plantedPath)).toBe(true);
    expect(statuses).toEqual([404, 404]);

    // And the victim's DB row still resolves through the normal path.
    const victimList = await api.request(
      "GET",
      `/api/projects/${victimId}/snapshots`,
      { token },
    );
    expect(victimList.data.snapshots).toHaveLength(1);
    expect(victimList.data.snapshots[0].id).toBe(victimSnapshotId);
  });

  it("returns 404 when deleting a snapshotId that does not exist", async () => {
    const res = await api.request(
      "DELETE",
      `/api/projects/${projectId}/snapshots/00000000-0000-4000-8000-000000000000`,
      { token },
    );
    expect(res.status).toBe(404);
    expect(res.data.error?.code ?? res.data.code).toBe("not_found");
  });
});
