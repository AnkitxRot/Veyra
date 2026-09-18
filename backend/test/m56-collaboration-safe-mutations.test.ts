import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import {
  collaborationManager,
  CollaborationRoom,
} from "../src/collab/manager.js";
import { createProject, projectDir } from "../src/projects/service.js";
import { writeProjectFile } from "../src/files/service.js";
import { importProjectZip } from "../src/projects/archive.js";
import { createZipArchive } from "../src/projects/zip.js";
import { createWorkspaceBackup } from "../src/backup/workspaceBackup.js";
import { restoreWorkspaceBackup } from "../src/backup/workspaceRestore.js";
import {
  controlWriteFile,
  resetWriteControl,
} from "./confinedWriteMock.js";

const MESSAGE_CUSTOM = 3;
const MESSAGE_AWARENESS = 1;

/** ws stand-in that records every custom JSON frame the room sends it. */
function makeWs() {
  const notices: any[] = [];
  const ws: any = {
    readyState: 1,
    notices,
    send: (data: Uint8Array) => {
      try {
        const dec = decoding.createDecoder(data);
        const type = decoding.readVarUint(dec);
        if (type === MESSAGE_CUSTOM) {
          notices.push(JSON.parse(decoding.readVarString(dec)));
        }
      } catch {}
    },
    close: () => {},
  };
  return ws;
}

function awarenessFrame(
  entries: Array<{ clientId: number; clock: number; state: unknown }>,
): Uint8Array {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const e of entries) {
    encoding.writeVarUint(inner, e.clientId);
    encoding.writeVarUint(inner, e.clock);
    encoding.writeVarString(inner, JSON.stringify(e.state));
  }
  const outer = encoding.createEncoder();
  encoding.writeVarUint(outer, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner));
  return encoding.toUint8Array(outer);
}

function externalNotices(ws: any) {
  return (ws.notices as any[]).filter(
    (n) => n.type === "external_mutation_notice",
  );
}

describe("M56 — collaboration-safe destructive operations", () => {
  let db: any;
  let cfg: any;
  let tmpWs: string;
  let tmpData: string;
  const rooms: CollaborationRoom[] = [];

  const makeRoom = (projectId: string) => {
    const r = new CollaborationRoom(projectId, cfg, db, () => {});
    rooms.push(r);
    return r;
  };

  beforeEach(() => {
    tmpWs = mkdtempSync(join(tmpdir(), "cloudide-m56-ws-"));
    tmpData = mkdtempSync(join(tmpdir(), "cloudide-m56-data-"));
    db = openDb(":memory:");
    cfg = { ...resolveConfig(), workspacesDir: tmpWs, dataDir: tmpData };
    collaborationManager.init(cfg, db);
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("alice", "h", "admin"); // id 1
    db.prepare(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    ).run("bob", "h", "user"); // id 2
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetWriteControl();
    for (const r of rooms.splice(0)) {
      try {
        r.dispose();
      } catch {}
    }
    for (const p of [tmpWs, tmpData]) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  });

  // ===================================================================
  // A. flushBeforeDestructiveDispose
  // ===================================================================

  describe("flushBeforeDestructiveDispose", () => {
    it("1. flushes a dirty Y.Doc to disk before a destructive dispose", async () => {
      const project = await createProject(cfg, db, 1, { name: "F1" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "main.py", "disk\n");
      const room = makeRoom(project.id);
      const ws = makeWs();
      await room.addClient(ws, {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      await room.ensureFileLoaded("main.py");
      room.doc.transact(() => {
        const t = room.doc.getText("main.py");
        t.delete(0, t.length);
        t.insert(0, "IN MEMORY EDIT\n");
      });
      room.markFileDirty("main.py");

      const res = await room.flushBeforeDestructiveDispose();
      expect(res).toEqual({ flushed: true, remainingDirty: [] });
      expect(await fs.readFile(join(cwd, "main.py"), "utf-8")).toBe(
        "IN MEMORY EDIT\n",
      );
    });

    it("2. a room with nothing dirty and nothing loaded performs no write", async () => {
      const project = await createProject(cfg, db, 1, { name: "F2" });
      await writeProjectFile(projectDir(cfg, project.id), "main.py", "disk\n");
      const room = makeRoom(project.id);
      await room.addClient(makeWs(), {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      const spy = vi.spyOn(fs, "writeFile");
      const res = await room.flushBeforeDestructiveDispose();
      expect(res).toEqual({ flushed: true, remainingDirty: [] });
      expect(spy).not.toHaveBeenCalled();
    });

    it("2b. a clean room's flush is idempotent — content is preserved exactly", async () => {
      const project = await createProject(cfg, db, 1, { name: "F2b" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "main.py", "disk\n");
      const room = makeRoom(project.id);
      await room.addClient(makeWs(), {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      await room.ensureFileLoaded("main.py");
      const res = await room.flushBeforeDestructiveDispose();
      expect(res.flushed).toBe(true);
      expect(await fs.readFile(join(cwd, "main.py"), "utf-8")).toBe("disk\n");
    });

    it("3. a disposed room returns flushed:false and writes nothing", async () => {
      const project = await createProject(cfg, db, 1, { name: "F3" });
      const room = makeRoom(project.id);
      await room.addClient(makeWs(), {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      room.dispose();
      const spy = vi.spyOn(fs, "writeFile");
      const res = await room.flushBeforeDestructiveDispose();
      expect(res).toEqual({ flushed: false, remainingDirty: [] });
      expect(spy).not.toHaveBeenCalled();
    });

    it("4. concurrent calls share one flush (no double flush)", async () => {
      const project = await createProject(cfg, db, 1, { name: "F4" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "a.txt", "x");
      const room = makeRoom(project.id);
      await room.addClient(makeWs(), {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      await room.ensureFileLoaded("a.txt");
      room.doc.transact(() => room.doc.getText("a.txt").insert(0, "y"));
      room.markFileDirty("a.txt");

      let writes = 0;
      // M90: flushToDisk() uses writeConfinedFile (handle-based I/O), so
      // fs.writeFile mocks are silently bypassed. Use controlWriteFile.
      const cleanup4 = controlWriteFile(async (abs: string, data: string) => {
        writes++;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(abs, data, "utf-8");
      });

      const [r1, r2] = await Promise.all([
        room.flushBeforeDestructiveDispose(),
        room.flushBeforeDestructiveDispose(),
      ]);
      expect(r1).toEqual(r2);
      expect(writes).toBe(1);
      cleanup4();
    });

    it("5. a hung disk write is bounded by the timeout and reported as not flushed", async () => {
      const project = await createProject(cfg, db, 1, { name: "F5" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "slow.txt", "x");
      const room = makeRoom(project.id);
      await room.addClient(makeWs(), {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      await room.ensureFileLoaded("slow.txt");
      room.doc.transact(() => room.doc.getText("slow.txt").insert(0, "y"));
      room.markFileDirty("slow.txt");

      // M90: flushToDisk() uses writeConfinedFile (handle-based I/O), so
      // fs.writeFile mocks are silently bypassed. Use controlWriteFile to
      // hang the confined write indefinitely.
      const cleanup5 = controlWriteFile(
        () => new Promise(() => {}) as Promise<void>,
      );

      const start = Date.now();
      const res = await room.flushBeforeDestructiveDispose({ timeoutMs: 200 });
      expect(Date.now() - start).toBeLessThan(2000);
      expect(res.flushed).toBe(false);
      expect(res.remainingDirty).toContain("slow.txt");
      cleanup5();
    });

    it("6. multiple dirty files are all flushed", async () => {
      const project = await createProject(cfg, db, 1, { name: "F6" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "a.txt", "a");
      await writeProjectFile(cwd, "b.txt", "b");
      const room = makeRoom(project.id);
      await room.addClient(makeWs(), {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      await room.ensureFileLoaded("a.txt");
      await room.ensureFileLoaded("b.txt");
      room.doc.transact(() => {
        room.doc.getText("a.txt").insert(1, "A");
        room.doc.getText("b.txt").insert(1, "B");
      });
      room.markFileDirty("a.txt");
      room.markFileDirty("b.txt");

      const res = await room.flushBeforeDestructiveDispose();
      expect(res.flushed).toBe(true);
      expect(await fs.readFile(join(cwd, "a.txt"), "utf-8")).toBe("aA");
      expect(await fs.readFile(join(cwd, "b.txt"), "utf-8")).toBe("bB");
    });

    it("7. flushToDisk keeps its own disposed-guard (M41 invariant intact)", async () => {
      const project = await createProject(cfg, db, 1, { name: "F7" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "main.py", "orig\n");
      const room = makeRoom(project.id);
      await room.addClient(makeWs(), {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      await room.ensureFileLoaded("main.py");
      room.doc.transact(() => room.doc.getText("main.py").insert(0, "STALE"));
      room.markFileDirty("main.py");
      room.dispose();
      const spy = vi.spyOn(fs, "writeFile");
      await room.flushToDisk();
      expect(spy).not.toHaveBeenCalled();
      expect(await fs.readFile(join(cwd, "main.py"), "utf-8")).toBe("orig\n");
    });

    it("8. multiple rooms stay isolated when one flushes", async () => {
      const p1 = await createProject(cfg, db, 1, { name: "F8a" });
      const p2 = await createProject(cfg, db, 1, { name: "F8b" });
      await writeProjectFile(projectDir(cfg, p1.id), "x.txt", "1");
      await writeProjectFile(projectDir(cfg, p2.id), "x.txt", "2");
      const r1 = makeRoom(p1.id);
      const r2 = makeRoom(p2.id);
      await r1.addClient(makeWs(), {
        userId: 1,
        username: "a",
        role: "editor",
      });
      await r2.addClient(makeWs(), {
        userId: 1,
        username: "a",
        role: "editor",
      });
      await r1.ensureFileLoaded("x.txt");
      r1.doc.transact(() => r1.doc.getText("x.txt").insert(1, "!"));
      r1.markFileDirty("x.txt");

      await r1.flushBeforeDestructiveDispose();
      expect(
        await fs.readFile(join(projectDir(cfg, p1.id), "x.txt"), "utf-8"),
      ).toBe("1!");
      expect(
        await fs.readFile(join(projectDir(cfg, p2.id), "x.txt"), "utf-8"),
      ).toBe("2");
    });
  });

  // ===================================================================
  // B. restore / import integration
  // ===================================================================

  describe("restore & import flush safety", () => {
    it("9. full workspace restore flushes the live room before destroying it; target stays authoritative", async () => {
      const project = await createProject(cfg, db, 1, { name: "R9" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "main.py", "BACKUP CONTENT\n");
      const backup = await createWorkspaceBackup(cfg, db, project.id);
      await writeProjectFile(cwd, "main.py", "POST-BACKUP DISK\n");

      const room = collaborationManager.getOrCreateRoom(project.id);
      const ws = makeWs();
      await room.addClient(ws, { userId: 2, username: "bob", role: "editor" });
      await room.ensureFileLoaded("main.py");
      room.doc.transact(() => {
        const t = room.doc.getText("main.py");
        t.delete(0, t.length);
        t.insert(0, "UNSAVED COLLAB EDIT\n");
      });
      room.markFileDirty("main.py");

      const flushSpy = vi.spyOn(
        collaborationManager,
        "flushRoomBeforeDestruction",
      );

      const result = await restoreWorkspaceBackup(
        cfg,
        db,
        project.id,
        backup.filename,
        { actorUserId: 1, actorUsername: "alice" },
      );
      expect(result.workspaceFileCount).toBeGreaterThan(0);
      expect(flushSpy).toHaveBeenCalledWith(project.id);

      // Restore target is authoritative; the pre-restore edit does NOT
      // resurrect / merge back.
      const onDisk = await fs.readFile(join(cwd, "main.py"), "utf-8");
      expect(onDisk).toBe("BACKUP CONTENT\n");
    });

    it("10. restore is blocked with 409 collab_flush_failed when the room cannot flush, and the workspace is untouched", async () => {
      const project = await createProject(cfg, db, 1, { name: "R10" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "main.py", "LIVE DISK\n");
      const backup = await createWorkspaceBackup(cfg, db, project.id);

      const room = collaborationManager.getOrCreateRoom(project.id);
      await room.addClient(makeWs(), {
        userId: 2,
        username: "bob",
        role: "editor",
      });
      await room.ensureFileLoaded("main.py");
      room.doc.transact(() => room.doc.getText("main.py").insert(0, "x"));
      room.markFileDirty("main.py");

      vi.spyOn(
        collaborationManager,
        "flushRoomBeforeDestruction",
      ).mockResolvedValue({ flushed: false, remainingDirty: ["main.py"] });

      await expect(
        restoreWorkspaceBackup(cfg, db, project.id, backup.filename, {
          actorUserId: 1,
        }),
      ).rejects.toMatchObject({ code: "collab_flush_failed", status: 409 });

      // Room still alive, workspace file untouched.
      expect(collaborationManager.getRoom(project.id)).toBeDefined();
      expect(await fs.readFile(join(cwd, "main.py"), "utf-8")).toBe(
        "LIVE DISK\n",
      );
    });

    it("11. force:true proceeds past an un-flushable room", async () => {
      const project = await createProject(cfg, db, 1, { name: "R11" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "main.py", "BACKUP\n");
      const backup = await createWorkspaceBackup(cfg, db, project.id);
      await writeProjectFile(cwd, "main.py", "DISK NOW\n");

      const room = collaborationManager.getOrCreateRoom(project.id);
      await room.addClient(makeWs(), {
        userId: 2,
        username: "bob",
        role: "editor",
      });

      vi.spyOn(
        collaborationManager,
        "flushRoomBeforeDestruction",
      ).mockResolvedValue({ flushed: false, remainingDirty: ["main.py"] });

      const result = await restoreWorkspaceBackup(
        cfg,
        db,
        project.id,
        backup.filename,
        { actorUserId: 1, force: true },
      );
      expect(result.workspaceFileCount).toBeGreaterThan(0);
      expect(await fs.readFile(join(cwd, "main.py"), "utf-8")).toBe("BACKUP\n");
    });

    it("12. replace-import flushes then the imported content is authoritative", async () => {
      const project = await createProject(cfg, db, 1, { name: "R12" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "main.py", "OLD\n");
      const room = collaborationManager.getOrCreateRoom(project.id);
      await room.addClient(makeWs(), {
        userId: 2,
        username: "bob",
        role: "editor",
      });
      await room.ensureFileLoaded("main.py");
      room.doc.transact(() => room.doc.getText("main.py").insert(0, "EDIT "));
      room.markFileDirty("main.py");

      const flushSpy = vi.spyOn(
        collaborationManager,
        "flushRoomBeforeDestruction",
      );
      const zip = createZipArchive([
        { path: "main.py", content: Buffer.from("IMPORTED\n") },
      ]);
      const res = await importProjectZip(cfg, db, 1, project.id, zip, {
        replace: true,
        actorUsername: "alice",
      });
      expect(res.ok).toBe(true);
      expect(flushSpy).toHaveBeenCalledWith(project.id);
      expect(await fs.readFile(join(cwd, "main.py"), "utf-8")).toBe(
        "IMPORTED\n",
      );
    });

    it("13. a rolled-back restore still restores the original workspace", async () => {
      const project = await createProject(cfg, db, 1, { name: "R13" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "main.py", "ORIGINAL\n");
      const backup = await createWorkspaceBackup(cfg, db, project.id);
      await writeProjectFile(cwd, "main.py", "MODIFIED\n");

      await expect(
        restoreWorkspaceBackup(cfg, db, project.id, backup.filename, {
          actorUserId: 1,
          __testHookAfterWorkspaceSwap: () => {
            throw new Error("simulated swap failure");
          },
        }),
      ).rejects.toBeTruthy();

      // ROLLBACK restored the pre-restore live workspace.
      expect(await fs.readFile(join(cwd, "main.py"), "utf-8")).toBe(
        "MODIFIED\n",
      );
    });

    it("14. restore registers a destructive mutation replayed to a reconnecting non-actor", async () => {
      const project = await createProject(cfg, db, 1, { name: "R14" });
      const cwd = projectDir(cfg, project.id);
      await writeProjectFile(cwd, "main.py", "C\n");
      const backup = await createWorkspaceBackup(cfg, db, project.id);

      await restoreWorkspaceBackup(cfg, db, project.id, backup.filename, {
        actorUserId: 1,
        actorUsername: "alice",
      });

      const rec = collaborationManager.getRecentDestructiveMutation(project.id);
      expect(rec?.mutationType).toBe("workspace_restore");
      expect(rec?.actor).toEqual({ userId: 1, username: "alice" });

      // A non-actor reconnecting gets the notice; the actor does not.
      const freshRoom = collaborationManager.getOrCreateRoom(project.id);
      rooms.push(freshRoom);
      const bobWs = makeWs();
      await freshRoom.addClient(bobWs, {
        userId: 2,
        username: "bob",
        role: "editor",
      });
      expect(externalNotices(bobWs)).toHaveLength(1);
      expect(externalNotices(bobWs)[0]).toMatchObject({
        mutationType: "workspace_restore",
        path: null,
        actor: { userId: 1, username: "alice" },
      });

      const aliceWs = makeWs();
      await freshRoom.addClient(aliceWs, {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      expect(externalNotices(aliceWs)).toHaveLength(0);
    });

    it("15. room disposal still force-closes clients", async () => {
      const project = await createProject(cfg, db, 1, { name: "R15" });
      const room = makeRoom(project.id);
      let closed = false;
      const ws: any = {
        readyState: 1,
        send: () => {},
        close: () => {
          closed = true;
        },
      };
      await room.addClient(ws, {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      room.dispose();
      expect(closed).toBe(true);
      expect(room.clients.size).toBe(0);
    });
  });

  // ===================================================================
  // C. getCollaboratorFileState — editing != dirty
  // ===================================================================

  describe("getCollaboratorFileState", () => {
    async function roomWith(
      name: string,
      clients: Array<{
        ws: any;
        userId: number;
        username: string;
        role: "owner" | "editor" | "viewer";
        activeFile?: string;
        clientId?: number;
        activity?: string;
        dirty?: boolean;
      }>,
    ) {
      const project = await createProject(cfg, db, 1, { name });
      for (const c of clients) {
        if (c.activeFile) {
          await writeProjectFile(
            projectDir(cfg, project.id),
            c.activeFile,
            "x",
          );
        }
      }
      const room = makeRoom(project.id);
      for (const c of clients) {
        await room.addClient(c.ws, {
          userId: c.userId,
          username: c.username,
          role: c.role,
        });
        if (c.activeFile) {
          room.handleMessage(c.ws, encodeFileOpen(c.activeFile));
        }
        if (c.clientId) {
          const state: any = { user: {} };
          if (c.activeFile) state.activeFile = c.activeFile;
          if (c.activity) state.activity = { type: c.activity, timestamp: 1 };
          if (c.dirty !== undefined) state.activeFileDirty = c.dirty;
          room.handleMessage(
            c.ws,
            awarenessFrame([{ clientId: c.clientId, clock: 1, state }]),
          );
        }
      }
      return room;
    }

    function encodeFileOpen(path: string): Uint8Array {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_CUSTOM);
      encoding.writeVarString(enc, JSON.stringify({ type: "file_open", path }));
      return encoding.toUint8Array(enc);
    }

    it("16. a clean collaborator with the file open is detected (dirty:'unknown')", async () => {
      const room = await roomWith("p16", [
        {
          ws: makeWs(),
          userId: 2,
          username: "bob",
          role: "editor",
          activeFile: "src/a.ts",
          clientId: 20,
        },
      ]);
      const st = room.getCollaboratorFileState(["src/a.ts"]);
      expect(st).toHaveLength(1);
      expect(st[0]).toMatchObject({
        userId: 2,
        username: "bob",
        path: "src/a.ts",
        open: true,
        editing: false,
        dirty: "unknown",
      });
    });

    it("17. an editing-only collaborator reports editing:true but dirty:'unknown' (never a false dirty claim)", async () => {
      const room = await roomWith("p17", [
        {
          ws: makeWs(),
          userId: 2,
          username: "bob",
          role: "editor",
          activeFile: "src/a.ts",
          clientId: 20,
          activity: "editing",
        },
      ]);
      const st = room.getCollaboratorFileState(["src/a.ts"]);
      expect(st[0].editing).toBe(true);
      expect(st[0].dirty).toBe("unknown");
    });

    it("18. an explicitly-dirty collaborator reports dirty:true", async () => {
      const room = await roomWith("p18", [
        {
          ws: makeWs(),
          userId: 2,
          username: "bob",
          role: "editor",
          activeFile: "src/a.ts",
          clientId: 20,
          activity: "editing",
          dirty: true,
        },
      ]);
      const st = room.getCollaboratorFileState(["src/a.ts"]);
      expect(st[0].dirty).toBe(true);
    });

    it("19. excludeUserId filters the initiator out", async () => {
      const room = await roomWith("p19", [
        {
          ws: makeWs(),
          userId: 1,
          username: "alice",
          role: "owner",
          activeFile: "src/a.ts",
          clientId: 10,
        },
        {
          ws: makeWs(),
          userId: 2,
          username: "bob",
          role: "editor",
          activeFile: "src/a.ts",
          clientId: 20,
        },
      ]);
      const st = room.getCollaboratorFileState(["src/a.ts"], 1);
      expect(st.map((s) => s.userId)).toEqual([2]);
    });

    it("20. an unrelated file is not reported", async () => {
      const room = await roomWith("p20", [
        {
          ws: makeWs(),
          userId: 2,
          username: "bob",
          role: "editor",
          activeFile: "src/other.ts",
          clientId: 20,
        },
      ]);
      expect(room.getCollaboratorFileState(["src/a.ts"])).toHaveLength(0);
    });

    it("21. a viewer is represented with role 'viewer'", async () => {
      const room = await roomWith("p21", [
        {
          ws: makeWs(),
          userId: 2,
          username: "bob",
          role: "viewer",
          activeFile: "src/a.ts",
          clientId: 20,
        },
      ]);
      expect(room.getCollaboratorFileState(["src/a.ts"])[0].role).toBe(
        "viewer",
      );
    });

    it("22. project isolation: the manager returns [] for a project with no room", () => {
      expect(
        collaborationManager.getCollaboratorFileState("no-such-project", [
          "a.ts",
        ]),
      ).toEqual([]);
    });

    it("23. a disconnected collaborator is no longer reported", async () => {
      const ws = makeWs();
      const room = await roomWith("p23", [
        {
          ws,
          userId: 2,
          username: "bob",
          role: "editor",
          activeFile: "src/a.ts",
          clientId: 20,
        },
      ]);
      expect(room.getCollaboratorFileState(["src/a.ts"])).toHaveLength(1);
      room.removeClient(ws);
      expect(room.getCollaboratorFileState(["src/a.ts"])).toHaveLength(0);
    });
  });

  // ===================================================================
  // D. external mutation notice
  // ===================================================================

  describe("emitExternalMutationNotice", () => {
    function encodeFileOpen(path: string): Uint8Array {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_CUSTOM);
      encoding.writeVarString(enc, JSON.stringify({ type: "file_open", path }));
      return encoding.toUint8Array(enc);
    }

    it("24. a non-initiating collaborator with the file open receives a notice; the initiator does not", async () => {
      const project = await createProject(cfg, db, 1, { name: "N24" });
      const room = collaborationManager.getOrCreateRoom(project.id);
      rooms.push(room);
      const initiatorWs = makeWs();
      const bobWs = makeWs();
      await room.addClient(initiatorWs, {
        userId: 1,
        username: "alice",
        role: "editor",
      });
      await room.addClient(bobWs, {
        userId: 2,
        username: "bob",
        role: "editor",
      });
      room.handleMessage(initiatorWs, encodeFileOpen("src/a.ts"));
      room.handleMessage(bobWs, encodeFileOpen("src/a.ts"));

      collaborationManager.emitExternalMutationNotice(project.id, {
        paths: ["src/a.ts"],
        mutationType: "replace",
        actorUserId: 1,
        actorUsername: "alice",
        matchCounts: { "src/a.ts": 4 },
      });

      const bobNotices = externalNotices(bobWs);
      expect(bobNotices).toHaveLength(1);
      expect(bobNotices[0]).toMatchObject({
        type: "external_mutation_notice",
        path: "src/a.ts",
        mutationType: "replace",
        actor: { userId: 1, username: "alice" },
        matchCount: 4,
      });
      expect(typeof bobNotices[0].timestamp).toBe("number");
      expect(externalNotices(initiatorWs)).toHaveLength(0);
    });

    it("25. a collaborator with a different active file receives nothing", async () => {
      const project = await createProject(cfg, db, 1, { name: "N25" });
      const room = collaborationManager.getOrCreateRoom(project.id);
      rooms.push(room);
      const bobWs = makeWs();
      await room.addClient(bobWs, {
        userId: 2,
        username: "bob",
        role: "editor",
      });
      room.handleMessage(bobWs, encodeFileOpen("src/other.ts"));
      collaborationManager.emitExternalMutationNotice(project.id, {
        paths: ["src/a.ts"],
        mutationType: "git_checkout",
        actorUserId: 1,
        actorUsername: "alice",
      });
      expect(externalNotices(bobWs)).toHaveLength(0);
    });

    it("26. a collaborator with no file open receives nothing", async () => {
      const project = await createProject(cfg, db, 1, { name: "N26" });
      const room = collaborationManager.getOrCreateRoom(project.id);
      rooms.push(room);
      const bobWs = makeWs();
      await room.addClient(bobWs, {
        userId: 2,
        username: "bob",
        role: "editor",
      });
      collaborationManager.emitExternalMutationNotice(project.id, {
        paths: ["src/a.ts"],
        mutationType: "upload",
        actorUserId: 1,
        actorUsername: "alice",
      });
      expect(externalNotices(bobWs)).toHaveLength(0);
    });

    it("27. an invalid mutation type is a no-op", async () => {
      const project = await createProject(cfg, db, 1, { name: "N27" });
      const room = collaborationManager.getOrCreateRoom(project.id);
      rooms.push(room);
      const bobWs = makeWs();
      await room.addClient(bobWs, {
        userId: 2,
        username: "bob",
        role: "editor",
      });
      room.handleMessage(bobWs, encodeFileOpen("src/a.ts"));
      collaborationManager.emitExternalMutationNotice(project.id, {
        paths: ["src/a.ts"],
        mutationType: "totally_made_up" as any,
        actorUserId: 1,
        actorUsername: "alice",
      });
      expect(externalNotices(bobWs)).toHaveLength(0);
    });

    it("28. rapid repeats for the same recipient+path are de-duplicated within the window", async () => {
      const project = await createProject(cfg, db, 1, { name: "N28" });
      const room = collaborationManager.getOrCreateRoom(project.id);
      rooms.push(room);
      const bobWs = makeWs();
      await room.addClient(bobWs, {
        userId: 2,
        username: "bob",
        role: "editor",
      });
      room.handleMessage(bobWs, encodeFileOpen("src/a.ts"));
      for (let i = 0; i < 5; i++) {
        collaborationManager.emitExternalMutationNotice(project.id, {
          paths: ["src/a.ts"],
          mutationType: "replace",
          actorUserId: 1,
          actorUsername: "alice",
        });
      }
      expect(externalNotices(bobWs)).toHaveLength(1);
    });

    it("29. a fresh destructive-mutation record expires after its TTL", async () => {
      const project = await createProject(cfg, db, 1, { name: "N29" });
      collaborationManager.registerDestructiveMutation(
        project.id,
        "workspace_import",
        1,
        "alice",
      );
      expect(
        collaborationManager.getRecentDestructiveMutation(project.id),
      ).toBeDefined();
      const rec = (collaborationManager as any).recentDestructiveMutations.get(
        project.id,
      );
      rec.timestamp = Date.now() - 61_000;
      expect(
        collaborationManager.getRecentDestructiveMutation(project.id),
      ).toBeUndefined();
    });

    it("30. registerDestructiveMutation ignores an unknown actor", async () => {
      const project = await createProject(cfg, db, 1, { name: "N30" });
      collaborationManager.registerDestructiveMutation(
        project.id,
        "workspace_restore",
        undefined,
        undefined,
      );
      expect(
        collaborationManager.getRecentDestructiveMutation(project.id),
      ).toBeUndefined();
    });
  });
});
