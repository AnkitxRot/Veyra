import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import {
  collaborationManager,
  CollaborationRoom,
} from "../src/collab/manager.js";
import {
  createProject,
  deleteProject,
  projectDir,
  getProject,
} from "../src/projects/service.js";
import { writeProjectFile } from "../src/files/service.js";
import { importProjectZip } from "../src/projects/archive.js";
import { createZipArchive } from "../src/projects/zip.js";
import { createWorkspaceBackup } from "../src/backup/workspaceBackup.js";
import { restoreWorkspaceBackup } from "../src/backup/workspaceRestore.js";

function makeMockWs() {
  return {
    readyState: 1,
    send: () => {},
    close: () => {},
  } as any;
}

/**
 * M41 — Prevent disposed collaboration rooms from flushing stale state.
 *
 * Root cause (discovered live during M40 browser verification):
 * CollaborationRoom.dispose() force-closes every client with
 * ws.close(1001, ...), but that close fires ASYNCHRONOUSLY — after
 * dispose() has already cleared this.clients, destroyed doc/awareness, and
 * removed the room from the manager's map. backend/src/ws/index.ts's
 * `ws.on("close", ...)` handler closes over the same room instance from
 * connection time and unconditionally calls room.removeClient(ws) on that
 * event. Pre-fix, removeClient() had no disposed guard, so it would find
 * clients.size === 0 (dispose() already cleared it) and re-arm a fresh
 * scheduleIdleDisposal() 10s timer on the already-destroyed room. That
 * timer's eventual flushToDisk() (also unguarded) would read
 * this.doc.getText(...) on the destroyed Y.Doc — Yjs returns the plain
 * string frozen at destroy time rather than throwing — and write that
 * stale, pre-disposal content back to disk, clobbering whatever
 * legitimately fresh content (an import, a restore) was written since.
 *
 * Live-reproduced 3/3 rounds against the QA server: disk reverted to
 * pre-import content ~10-11s after every import, matching
 * IDLE_DISPOSE_BASE_MS exactly.
 */
describe("M41 — disposed collaboration rooms never re-arm timers or flush stale state", () => {
  let db: any;
  let cfg: any;
  let tempWorkspacesDir: string;
  let tempDataDir: string;

  beforeEach(async () => {
    tempWorkspacesDir = mkdtempSync(join(tmpdir(), "cloudide-m41-test-"));
    tempDataDir = mkdtempSync(join(tmpdir(), "cloudide-m41-data-"));
    db = openDb(":memory:");
    cfg = {
      ...resolveConfig(),
      workspacesDir: tempWorkspacesDir,
      dataDir: tempDataDir,
    };
    collaborationManager.init(cfg, db);
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("m41user", "h", "user"); // id 1
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      rmSync(tempWorkspacesDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(tempDataDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. Disposed room: removeClient() called from the async close-event path re-arms no idle timer", async () => {
    const project = await createProject(cfg, db, 1, { name: "DisposeGuard1" });
    const room = new CollaborationRoom(project.id, cfg, db, () => {});
    const ws = makeMockWs();
    await room.addClient(ws, {
      userId: 1,
      username: "m41user",
      role: "editor",
    });

    room.dispose();
    expect((room as any).idleDisposeTimer).toBeNull();

    // Simulate the async 'close' event arriving after dispose() has already
    // returned — exactly what ws/index.ts's handler does in production.
    room.removeClient(ws);

    expect((room as any).idleDisposeTimer).toBeNull();
  });

  it("2. Disposed room: flushToDisk() writes nothing, even when called directly with dirty content", async () => {
    const project = await createProject(cfg, db, 1, { name: "DisposeGuard2" });
    const cwd = projectDir(cfg, project.id);
    await writeProjectFile(cwd, "main.py", "original content\n");

    const room = new CollaborationRoom(project.id, cfg, db, () => {});
    const ws = makeMockWs();
    await room.addClient(ws, {
      userId: 1,
      username: "m41user",
      role: "editor",
    });

    room.doc.transact(() => {
      room.doc.getText("main.py").insert(0, "STALE CONTENT FROZEN AT DISPOSE");
    });
    room.markFileDirty("main.py");

    room.dispose();

    const writeSpy = vi.spyOn(fs, "writeFile");
    await room.flushToDisk();
    expect(writeSpy).not.toHaveBeenCalled();

    const onDisk = await fs.readFile(join(cwd, "main.py"), "utf-8");
    expect(onDisk).toBe("original content\n");
  });

  it("3. Import protection: a stale flush from the pre-import room never clobbers imported content", async () => {
    const project = await createProject(cfg, db, 1, { name: "ImportGuard" });
    const cwd = projectDir(cfg, project.id);
    await writeProjectFile(cwd, "main.py", "OLD PRE-IMPORT CONTENT\n");

    // A collaborator has the project open when the import happens.
    const room = collaborationManager.getOrCreateRoom(project.id);
    const ws = makeMockWs();
    await room.addClient(ws, {
      userId: 1,
      username: "m41user",
      role: "editor",
    });
    await room.ensureFileLoaded("main.py");
    // The pre-import room's own Y.Text holds the pre-import content — this
    // is exactly what a stale post-disposal flush would write back.
    expect(room.doc.getText("main.py").toString()).toBe(
      "OLD PRE-IMPORT CONTENT\n",
    );

    const zipBuffer = createZipArchive([
      { path: "main.py", content: Buffer.from("NEW IMPORTED CONTENT\n") },
    ]);
    const result = await importProjectZip(cfg, db, 1, project.id, zipBuffer, {
      replace: true,
    });
    expect(result.ok).toBe(true);

    // Simulate the async close-event path firing on the disposed pre-import
    // room after the import has already completed and written fresh
    // content — the exact race this milestone closes.
    room.removeClient(ws);
    expect((room as any).idleDisposeTimer).toBeNull();

    // Directly invoke what the orphaned idle timer would eventually have
    // called, deterministically rather than waiting a real/faked 10s.
    await room.flushToDisk();

    const onDisk = await fs.readFile(join(cwd, "main.py"), "utf-8");
    expect(onDisk).toBe("NEW IMPORTED CONTENT\n");
  });

  it("4. Restore protection: a stale flush from the pre-restore room never clobbers restored content", async () => {
    const project = await createProject(cfg, db, 1, { name: "RestoreGuard" });
    const cwd = projectDir(cfg, project.id);
    await writeProjectFile(cwd, "main.py", "CONTENT AT BACKUP TIME\n");
    const backup = await createWorkspaceBackup(cfg, db, project.id);

    // Mutate after the backup, then have a collaborator open the file —
    // its room holds the pre-restore (mutated) content.
    await writeProjectFile(cwd, "main.py", "STALE PRE-RESTORE CONTENT\n");
    const room = collaborationManager.getOrCreateRoom(project.id);
    const ws = makeMockWs();
    await room.addClient(ws, {
      userId: 1,
      username: "m41user",
      role: "editor",
    });
    await room.ensureFileLoaded("main.py");
    expect(room.doc.getText("main.py").toString()).toBe(
      "STALE PRE-RESTORE CONTENT\n",
    );

    const result = await restoreWorkspaceBackup(
      cfg,
      db,
      project.id,
      backup.filename,
      { actorUserId: 1 },
    );
    expect(result.workspaceFileCount).toBeGreaterThan(0);

    room.removeClient(ws);
    expect((room as any).idleDisposeTimer).toBeNull();
    await room.flushToDisk();

    const onDisk = await fs.readFile(join(cwd, "main.py"), "utf-8");
    expect(onDisk).toBe("CONTENT AT BACKUP TIME\n");
  });

  it("5. Delete protection: a stale flush from the pre-delete room cannot resurrect the project", async () => {
    const project = await createProject(cfg, db, 1, { name: "DeleteGuard" });
    const cwd = projectDir(cfg, project.id);
    await writeProjectFile(cwd, "main.py", "content before delete\n");

    const room = collaborationManager.getOrCreateRoom(project.id);
    const ws = makeMockWs();
    await room.addClient(ws, {
      userId: 1,
      username: "m41user",
      role: "editor",
    });
    await room.ensureFileLoaded("main.py");

    await deleteProject(cfg, db, 1, project.id);
    expect(getProject(db, project.id)).toBeNull();

    room.removeClient(ws);
    expect((room as any).idleDisposeTimer).toBeNull();

    const writeSpy = vi.spyOn(fs, "writeFile");
    await room.flushToDisk();
    expect(writeSpy).not.toHaveBeenCalled();

    const dirExists = await fs
      .access(cwd)
      .then(() => true)
      .catch(() => false);
    expect(dirExists).toBe(false);
    expect(getProject(db, project.id)).toBeNull();
  });

  it("6. Non-regression: a genuinely idle (non-disposed) room still arms its timer and disposes normally", async () => {
    const project = await createProject(cfg, db, 1, { name: "NormalIdle" });
    const onDispose = vi.fn();
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockResolvedValue(undefined as never);
    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockImplementation(async (p: any) => p);
    const accessSpy = vi
      .spyOn(fs, "access")
      .mockResolvedValue(undefined as never);
    vi.useFakeTimers();

    try {
      const room = new CollaborationRoom(project.id, cfg, db, onDispose);
      const ws = makeMockWs();
      await room.addClient(ws, {
        userId: 1,
        username: "m41user",
        role: "editor",
      });

      room.removeClient(ws);
      expect((room as any).idleDisposeTimer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(onDispose).toHaveBeenCalledWith(project.id);
    } finally {
      writeSpy.mockRestore();
      realpathSpy.mockRestore();
      accessSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("7. Non-regression: a normal dirty edit on a live (non-disposed) room still flushes to disk", async () => {
    const project = await createProject(cfg, db, 1, { name: "NormalFlush" });
    const cwd = projectDir(cfg, project.id);

    const room = new CollaborationRoom(project.id, cfg, db, () => {});
    const ws = makeMockWs();
    await room.addClient(ws, {
      userId: 1,
      username: "m41user",
      role: "editor",
    });

    room.doc.transact(() => {
      room.doc.getText("live.py").insert(0, "print('live edit')\n");
    });
    room.markFileDirty("live.py");

    await room.flushToDisk();

    const onDisk = await fs.readFile(join(cwd, "live.py"), "utf-8");
    expect(onDisk).toBe("print('live edit')\n");

    room.dispose();
  });

  it("8. Reconnect/remove race: removeClient() called multiple times after dispose (close + error both firing) stays idempotent, no timer resurrection", async () => {
    const project = await createProject(cfg, db, 1, { name: "RemoveRace" });
    const room = new CollaborationRoom(project.id, cfg, db, () => {});
    const ws = makeMockWs();
    await room.addClient(ws, {
      userId: 1,
      username: "m41user",
      role: "editor",
    });

    room.dispose();

    // ws/index.ts registers both 'close' and 'error' handlers, each calling
    // removeClient(ws) — a genuine disconnect can fire both for the same
    // socket. Neither call may resurrect any lifecycle state.
    expect(() => room.removeClient(ws)).not.toThrow();
    expect(() => room.removeClient(ws)).not.toThrow();

    expect((room as any).idleDisposeTimer).toBeNull();
    expect((room as any).disposed).toBe(true);
  });
});
