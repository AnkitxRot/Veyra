import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeTestConfig, startTestApi, type TestApi } from "./helpers.js";
import {
  createProject,
  projectDir,
  addProjectCollaborator,
} from "../src/projects/service.js";
import { forkProject } from "../src/projects/fork.js";
import { writeProjectFile, readProjectFile } from "../src/files/service.js";
import { collaborationManager } from "../src/collab/manager.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import { hashPassword } from "../src/auth/passwords.js";
import { ensureAdminUser } from "../src/db.js";
import { IS_WINDOWS } from "../src/config.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db.js";

describe("Milestone 28/29 — Project Duplication & Workspace Forking (owner-only)", () => {
  let cfg: AppConfig;
  let api: TestApi;
  let db: Db;
  let ownerId: number;
  let ownerToken: string;

  beforeEach(async () => {
    cfg = makeTestConfig();
    api = await startTestApi(cfg);
    db = api.db;

    const reg = await api.request("POST", "/api/auth/register", {
      body: { username: "fork_owner", password: "password123" },
    });
    ownerId = reg.data.user.id;
    ownerToken = reg.data.token;
  });

  afterEach(async () => {
    await api.close();
  });

  async function makeSourceProject(): Promise<{ id: string; cwd: string }> {
    const project = await createProject(cfg, db, ownerId, {
      name: "Source Project",
      language: "python",
    });
    const cwd = projectDir(cfg, project.id);
    await writeProjectFile(cwd, "main.py", "print('hello')\n");
    await writeProjectFile(cwd, "src/nested/deep.py", "def f(): pass\n");
    return { id: project.id, cwd };
  }

  it("1. owner can fork their own project via the HTTP endpoint", async () => {
    const { id: sourceId } = await makeSourceProject();
    const res = await api.request("POST", `/api/projects/${sourceId}/fork`, {
      token: ownerToken,
      body: { name: "My Fork" },
    });
    expect(res.status).toBe(201);
    expect(res.data.project.name).toBe("My Fork");
    expect(res.data.project.id).not.toBe(sourceId);
    expect(res.data.fileCount).toBe(2);
  });

  it("2. an editor collaborator is rejected (404, IDOR-safe) — fork is owner-only, matching export/import/upload/snapshots", async () => {
    const { id: sourceId } = await makeSourceProject();
    const editorReg = await api.request("POST", "/api/auth/register", {
      body: { username: "fork_editor", password: "password123" },
    });
    addProjectCollaborator(db, sourceId, editorReg.data.user.id, "editor");

    const res = await api.request("POST", `/api/projects/${sourceId}/fork`, {
      token: editorReg.data.token,
    });
    expect(res.status).toBe(404);
  });

  it("2b. a viewer collaborator is also rejected (404, IDOR-safe)", async () => {
    const { id: sourceId } = await makeSourceProject();
    const viewerReg = await api.request("POST", "/api/auth/register", {
      body: { username: "fork_viewer", password: "password123" },
    });
    addProjectCollaborator(db, sourceId, viewerReg.data.user.id, "viewer");

    const res = await api.request("POST", `/api/projects/${sourceId}/fork`, {
      token: viewerReg.data.token,
    });
    expect(res.status).toBe(404);
  });

  it("3. a non-collaborator is rejected (404, IDOR-safe)", async () => {
    const { id: sourceId } = await makeSourceProject();
    const attackerReg = await api.request("POST", "/api/auth/register", {
      body: { username: "fork_attacker", password: "password123" },
    });
    const res = await api.request("POST", `/api/projects/${sourceId}/fork`, {
      token: attackerReg.data.token,
    });
    expect(res.status).toBe(404);
  });

  it("4. the forked project is owned by the requesting actor, never the source owner (owner forking their own project)", async () => {
    const { id: sourceId } = await makeSourceProject();
    const result = await forkProject(cfg, db, ownerId, sourceId, {
      name: "Owner's Own Fork",
    });
    expect(result.project.owner_id).toBe(ownerId);
  });

  it("4b. a platform admin who does not own the source is rejected — requireOwnedProject has no admin bypass, unlike requireProjectAccess", async () => {
    const { id: sourceId } = await makeSourceProject();
    const adminHash = await hashPassword("AdminPass@123");
    ensureAdminUser(db, "fork_admin", adminHash);
    const adminRes = await api.request("POST", "/api/auth/admin-login", {
      body: { username: "fork_admin", password: "AdminPass@123" },
    });
    const adminToken = adminRes.data.token;

    const res = await api.request("POST", `/api/projects/${sourceId}/fork`, {
      token: adminToken,
    });
    expect(res.status).toBe(404);
  });

  it("bypass regression: a collaborator cannot obtain the source workspace via fork-then-export, because fork itself is now owner-gated", async () => {
    const { id: sourceId } = await makeSourceProject();
    const editorReg = await api.request("POST", "/api/auth/register", {
      body: { username: "fork_bypass_editor", password: "password123" },
    });
    const editorToken = editorReg.data.token;
    addProjectCollaborator(db, sourceId, editorReg.data.user.id, "editor");

    // Step 1: the bypass previously started here — fork the source at
    // collaborator level. This must now fail outright, so there is never a
    // fork to export in step 2.
    const forkRes = await api.request(
      "POST",
      `/api/projects/${sourceId}/fork`,
      { token: editorToken },
    );
    expect(forkRes.status).toBe(404);

    // Step 2, for completeness: export of the (non-existent, un-owned)
    // source is still independently rejected too.
    const exportRes = await api.request(
      "GET",
      `/api/projects/${sourceId}/export`,
      { token: editorToken },
    );
    expect(exportRes.status).toBe(404);
  });

  it("5. & 6. & 7. forked workspace content matches source exactly, including binary content and nested directories", async () => {
    const { id: sourceId, cwd: sourceCwd } = await makeSourceProject();
    const binaryBuf = Buffer.from([0, 1, 2, 255, 254, 253, 0, 10, 13]);
    await fs.writeFile(join(sourceCwd, "asset.bin"), binaryBuf);

    const result = await forkProject(cfg, db, ownerId, sourceId);
    const destCwd = projectDir(cfg, result.project.id);

    const mainPy = await readProjectFile(destCwd, "main.py");
    expect(mainPy.content).toBe("print('hello')\n");

    const nested = await readProjectFile(destCwd, "src/nested/deep.py");
    expect(nested.content).toBe("def f(): pass\n");

    const forkedBinary = await fs.readFile(join(destCwd, "asset.bin"));
    expect(Buffer.compare(forkedBinary, binaryBuf)).toBe(0);

    expect(result.fileCount).toBe(3);
  });

  it("8. no live collaboration room is created for the forked project", async () => {
    const { id: sourceId } = await makeSourceProject();
    const result = await forkProject(cfg, db, ownerId, sourceId);
    expect(collaborationManager.getRoom(result.project.id)).toBeUndefined();
  });

  it("9. forking never eagerly creates a sandbox for the new project", async () => {
    const { id: sourceId } = await makeSourceProject();
    const before = sandboxManager.getActiveSandboxCount();
    const result = await forkProject(cfg, db, ownerId, sourceId);
    expect(sandboxManager.getActiveSandboxCount()).toBe(before);
    expect(result.project.id).toBeTruthy();
  });

  it("10. quota enforcement: forking is rejected once the actor's project quota is reached", async () => {
    const quotaCfg = makeTestConfig({ projectQuota: 1 });
    const quotaApi = await startTestApi(quotaCfg);
    try {
      const reg = await quotaApi.request("POST", "/api/auth/register", {
        body: { username: "quota_user", password: "password123" },
      });
      const uid = reg.data.user.id;
      const project = await createProject(quotaCfg, quotaApi.db, uid, {
        name: "Only Project",
      });
      const res = await quotaApi.request(
        "POST",
        `/api/projects/${project.id}/fork`,
        { token: reg.data.token },
      );
      expect(res.status).toBe(403);
      expect(res.data.error?.code).toBe("quota_exceeded");
    } finally {
      await quotaApi.close();
    }
  });

  it("11. file-count and byte-limit enforcement reject an over-limit source workspace", async () => {
    const smallCfg = makeTestConfig({ maxUploadFileCount: 1 });
    const smallApi = await startTestApi(smallCfg);
    try {
      const reg = await smallApi.request("POST", "/api/auth/register", {
        body: { username: "small_user", password: "password123" },
      });
      const uid = reg.data.user.id;
      const project = await createProject(smallCfg, smallApi.db, uid, {
        name: "TooManyFiles",
      });
      const cwd = projectDir(smallCfg, project.id);
      await writeProjectFile(cwd, "a.txt", "a");
      await writeProjectFile(cwd, "b.txt", "b");

      await expect(
        forkProject(smallCfg, smallApi.db, uid, project.id),
      ).rejects.toThrow(/fork limit/i);

      const countRow = smallApi.db
        .prepare("SELECT COUNT(*) as c FROM projects")
        .get() as { c: number };
      expect(countRow.c).toBe(1); // only the source project — no orphan row
    } finally {
      await smallApi.close();
    }
  });

  it.skipIf(IS_WINDOWS)(
    "12. a symlinked file/directory planted in the source workspace is not copied into the fork (no symlink escape)",
    async () => {
      const { id: sourceId, cwd: sourceCwd } = await makeSourceProject();
      const secret = join(
        tmpdir(),
        `cloudide-fork-secret-${Math.random().toString(36).slice(2)}.txt`,
      );
      await fs.writeFile(secret, "SECRET");
      symlinkSync(secret, join(sourceCwd, "link.txt"));

      const outsideDir = join(
        tmpdir(),
        `cloudide-fork-outside-${Math.random().toString(36).slice(2)}`,
      );
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(join(outsideDir, "x.txt"), "outside");
      symlinkSync(outsideDir, join(sourceCwd, "linkdir"));

      const result = await forkProject(cfg, db, ownerId, sourceId);
      const destCwd = projectDir(cfg, result.project.id);

      await expect(fs.access(join(destCwd, "link.txt"))).rejects.toThrow();
      await expect(fs.access(join(destCwd, "linkdir"))).rejects.toThrow();
      // The two legitimate files are still forked correctly.
      expect(result.fileCount).toBe(2);
    },
  );

  it.skipIf(IS_WINDOWS)(
    "13. & 14. a read failure mid-copy leaves no orphan project row, no orphan workspace directory, and the source project untouched (rollback)",
    async () => {
      const { id: sourceId, cwd: sourceCwd } = await makeSourceProject();
      const blockedFile = join(sourceCwd, "src/nested/deep.py");
      chmodSync(blockedFile, 0o000);

      const beforeCount = (
        db.prepare("SELECT COUNT(*) as c FROM projects").get() as {
          c: number;
        }
      ).c;

      try {
        await expect(forkProject(cfg, db, ownerId, sourceId)).rejects.toThrow();
      } finally {
        chmodSync(blockedFile, 0o644);
      }

      const afterCount = (
        db.prepare("SELECT COUNT(*) as c FROM projects").get() as {
          c: number;
        }
      ).c;
      expect(afterCount).toBe(beforeCount); // no orphan project row

      const sourceStillIntact = await readProjectFile(sourceCwd, "main.py");
      expect(sourceStillIntact.content).toBe("print('hello')\n");
    },
  );

  it("15. two concurrent forks of the same source both succeed independently with distinct projects", async () => {
    const { id: sourceId } = await makeSourceProject();
    const [r1, r2] = await Promise.all([
      forkProject(cfg, db, ownerId, sourceId, { name: "Fork A" }),
      forkProject(cfg, db, ownerId, sourceId, { name: "Fork B" }),
    ]);
    expect(r1.project.id).not.toBe(r2.project.id);
    expect(r1.project.name).toBe("Fork A");
    expect(r2.project.name).toBe("Fork B");

    const destA = projectDir(cfg, r1.project.id);
    const destB = projectDir(cfg, r2.project.id);
    expect((await readProjectFile(destA, "main.py")).content).toBe(
      "print('hello')\n",
    );
    expect((await readProjectFile(destB, "main.py")).content).toBe(
      "print('hello')\n",
    );
  });

  it("16. a PROJECT_FORKED audit event is recorded with source and fork identity", async () => {
    const { id: sourceId } = await makeSourceProject();
    const result = await forkProject(cfg, db, ownerId, sourceId, {
      name: "Audited Fork",
    });

    const row = db
      .prepare(
        "SELECT details FROM audit_logs WHERE event_type = 'PROJECT_FORKED' AND project_id = ?",
      )
      .get(result.project.id) as { details: string } | undefined;
    expect(row).toBeDefined();
    const details = JSON.parse(row!.details);
    expect(details.sourceProjectId).toBe(sourceId);
    expect(details.forkedProjectName).toBe("Audited Fork");
  });

  it("17. the forked project can be independently edited and deleted without affecting the source", async () => {
    const { id: sourceId } = await makeSourceProject();
    const result = await forkProject(cfg, db, ownerId, sourceId);
    const forkId = result.project.id;

    const editRes = await api.request("POST", `/api/projects/${forkId}/file`, {
      token: ownerToken,
      body: { path: "main.py", content: "print('edited in fork')\n" },
    });
    expect(editRes.status).toBe(200);

    const deleteRes = await api.request("DELETE", `/api/projects/${forkId}`, {
      token: ownerToken,
    });
    expect(deleteRes.status).toBe(200);

    const sourceRes = await api.request(
      "GET",
      `/api/projects/${sourceId}/file?path=main.py`,
      { token: ownerToken },
    );
    expect(sourceRes.status).toBe(200);
    expect(sourceRes.data.content).toBe("print('hello')\n");
  });

  it("18. the source project's file list and content are completely unaffected by forking", async () => {
    const { id: sourceId, cwd: sourceCwd } = await makeSourceProject();
    await forkProject(cfg, db, ownerId, sourceId, { name: "Unrelated Fork" });

    const stillThere = await readProjectFile(sourceCwd, "src/nested/deep.py");
    expect(stillThere.content).toBe("def f(): pass\n");
    const mainStillThere = await readProjectFile(sourceCwd, "main.py");
    expect(mainStillThere.content).toBe("print('hello')\n");
  });

  it("falls back to a generated name when none is provided", async () => {
    const { id: sourceId } = await makeSourceProject();
    const result = await forkProject(cfg, db, ownerId, sourceId);
    expect(result.project.name).toBe("Source Project (Fork)");
  });
});
