/**
 * M86 — workspace read-your-writes.
 *
 * Collaboration is always on: every keystroke lands in the server's Y.Doc and
 * reaches disk only after the 2s debounce (10s max). Run, Test/Build tasks,
 * Debug launch, dependency install, and Git stage all read the workspace from
 * disk, so without a barrier they could execute or stage content older than
 * what the editor shows. These tests pin the barrier:
 *
 *  1. Room level (no Docker): dirty-only, serialized, bounded, and truthful
 *     about files it could not persist.
 *  2. Server integration (no Docker): every consumer calls the barrier after
 *     authorization, refuses instead of using stale bytes when persistence
 *     fails, and releases its gate slot.
 *  3. Docker: a real test task and a real run see edits that exist only in
 *     the live room.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, promises as fsp } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

import { makeTestConfig } from "./helpers.js";
import { openDb, type Db } from "../src/db.js";
import type { AppConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { setupWebSocketServer } from "../src/ws/index.js";
import { collaborationManager } from "../src/collab/manager.js";
import { createProject } from "../src/projects/service.js";
import { runGate } from "../src/execution/runGate.js";
import { sandboxManager } from "../src/execution/sandbox.js";
import {
  debugSessions,
  resetDebugSessionsForTests,
} from "../src/debug/manager.js";
import type { DebugSpawnRequest } from "../src/debug/process.js";
import { isDockerRunning, isRunnerImageAvailable } from "../src/tools.js";

const MESSAGE_SYNC = 0;
const realWriteFile = fsp.writeFile.bind(fsp);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error("waitFor timeout");
}

function replaceText(doc: Y.Doc, path: string, text: string) {
  doc.transact(() => {
    const t = doc.getText(path);
    t.delete(0, t.length);
    t.insert(0, text);
  }, "m86-test-edit");
}

/** Poison fs.promises.writeFile for paths ending in `suffix`. */
function failWritesTo(suffix: string) {
  return vi.spyOn(fsp, "writeFile").mockImplementation(((
    p: any,
    ...rest: any[]
  ) => {
    if (String(p).replace(/\\/g, "/").endsWith(suffix)) {
      return Promise.reject(
        Object.assign(new Error("EACCES: m86 poisoned write"), {
          code: "EACCES",
        }),
      );
    }
    return (realWriteFile as any)(p, ...rest);
  }) as any);
}

// ---------------------------------------------------------------------------
// 1. Room-level barrier semantics
// ---------------------------------------------------------------------------

describe("M86 room barrier (persistLiveEdits)", () => {
  let cfg: AppConfig;
  let db: Db;
  let ownerId: number;
  const rooms: string[] = [];

  beforeAll(() => {
    cfg = makeTestConfig();
    db = openDb(":memory:");
    collaborationManager.init(cfg, db);
    const info = db
      .prepare(
        "INSERT INTO users (username, password_hash) VALUES ('m86unit', 'x')",
      )
      .run();
    ownerId = Number(info.lastInsertRowid);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const pid of rooms.splice(0)) {
      collaborationManager.getRoom(pid)?.dispose();
    }
  });

  async function newRoom() {
    const project = await createProject(cfg, db, ownerId, {
      name: `m86-${randomUUID().slice(0, 6)}`,
    });
    rooms.push(project.id);
    const room = collaborationManager.getOrCreateRoom(project.id);
    const dir = join(cfg.workspacesDir, project.id);
    return { projectId: project.id, room, dir };
  }

  it("is a no-op success when the project has no live room", async () => {
    const r = await collaborationManager.persistLiveEdits(randomUUID());
    expect(r).toEqual({ ok: true, unpersisted: [] });
  });

  it("does not rewrite files when the room has nothing unpersisted", async () => {
    const { projectId, room, dir } = await newRoom();
    // Loaded-from-disk content is never dirty; the disk copy is deliberately
    // different so any rewrite would be visible.
    room.doc.transact(() => {
      room.doc.getText("clean.txt").insert(0, "room copy");
    }, "initial_disk_load");
    writeFileSync(join(dir, "clean.txt"), "disk copy");
    const spy = vi.spyOn(fsp, "writeFile");

    const r = await collaborationManager.persistLiveEdits(projectId);

    expect(r).toEqual({ ok: true, unpersisted: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "clean.txt"), "utf8")).toBe("disk copy");
  });

  it("persists dirty room content immediately instead of waiting for the debounce", async () => {
    const { projectId, room, dir } = await newRoom();
    replaceText(room.doc, "main.py", 'print("latest")\n');
    expect(existsSync(join(dir, "main.py"))).toBe(false);

    const r = await collaborationManager.persistLiveEdits(projectId);

    expect(r).toEqual({ ok: true, unpersisted: [] });
    expect(readFileSync(join(dir, "main.py"), "utf8")).toBe('print("latest")\n');
  });

  it("keeps a file dirty when an edit lands while its write is in flight", async () => {
    const { projectId, room, dir } = await newRoom();
    replaceText(room.doc, "race.txt", "v1");

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    vi.spyOn(fsp, "writeFile").mockImplementationOnce((async (
      ...args: any[]
    ) => {
      entered();
      await gate;
      return (realWriteFile as any)(...args);
    }) as any);

    const timerFlush = room.flushToDisk();
    await enteredP;
    replaceText(room.doc, "race.txt", "v2");
    release();
    await timerFlush;
    expect(readFileSync(join(dir, "race.txt"), "utf8")).toBe("v1");

    const r = await collaborationManager.persistLiveEdits(projectId);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "race.txt"), "utf8")).toBe("v2");
  });

  it("never overlaps two flush passes, so an older snapshot cannot land last", async () => {
    const { room, dir } = await newRoom();
    replaceText(room.doc, "order.txt", "older");

    let active = 0;
    let maxActive = 0;
    let first = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    vi.spyOn(fsp, "writeFile").mockImplementation((async (...args: any[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (first) {
          first = false;
          entered();
          await gate;
        }
        return await (realWriteFile as any)(...args);
      } finally {
        active -= 1;
      }
    }) as any);

    // Debounce timer pass holding "older" in a slow write…
    const firstPass = room.flushToDisk();
    await enteredP;
    replaceText(room.doc, "order.txt", "newer");
    // …while another pass (max-delay timer / shutdown / M56) starts.
    const secondPass = room.flushToDisk();
    await sleep(30);
    release();
    await Promise.all([firstPass, secondPass]);

    expect(maxActive).toBe(1);
    expect(readFileSync(join(dir, "order.txt"), "utf8")).toBe("newer");
  });

  it("a barrier pass queued behind timer passes still never rewrites clean files", async () => {
    const { projectId, room, dir } = await newRoom();
    room.doc.transact(() => {
      room.doc.getText("untouched.txt").insert(0, "room copy");
    }, "initial_disk_load");
    writeFileSync(join(dir, "untouched.txt"), "disk copy");
    replaceText(room.doc, "busy.txt", "v1");

    let first = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    const writes: string[] = [];
    vi.spyOn(fsp, "writeFile").mockImplementation((async (...args: any[]) => {
      writes.push(String(args[0]).replace(/\\/g, "/"));
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return (realWriteFile as any)(...args);
    }) as any);

    const timerPass = room.flushToDisk();
    await enteredP;
    replaceText(room.doc, "busy.txt", "v2");
    const queuedTimerPass = room.flushToDisk();
    const barrier = collaborationManager.persistLiveEdits(projectId);
    release();
    await Promise.all([timerPass, queuedTimerPass]);
    const r = await barrier;
    // Let any pass the barrier queued finish too.
    await room.persistLiveEdits();

    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "busy.txt"), "utf8")).toBe("v2");
    expect(writes.some((w) => w.endsWith("untouched.txt"))).toBe(false);
    expect(readFileSync(join(dir, "untouched.txt"), "utf8")).toBe("disk copy");
  });

  it("the barrier waits for an in-flight flush before persisting", async () => {
    const { projectId, room, dir } = await newRoom();
    replaceText(room.doc, "serial.txt", "old");

    let active = 0;
    let maxActive = 0;
    let first = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    vi.spyOn(fsp, "writeFile").mockImplementation((async (...args: any[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (first) {
          first = false;
          entered();
          await gate;
        }
        return await (realWriteFile as any)(...args);
      } finally {
        active -= 1;
      }
    }) as any);

    const timerFlush = room.flushToDisk();
    await enteredP;
    replaceText(room.doc, "serial.txt", "new");
    let barrierSettled = false;
    const barrier = collaborationManager
      .persistLiveEdits(projectId)
      .then((r) => {
        barrierSettled = true;
        return r;
      });
    await sleep(50);
    expect(barrierSettled).toBe(false);

    release();
    await timerFlush;
    const r = await barrier;

    expect(r.ok).toBe(true);
    expect(maxActive).toBe(1);
    expect(readFileSync(join(dir, "serial.txt"), "utf8")).toBe("new");
  });

  it("reports the files it could not persist and leaves them dirty", async () => {
    const { projectId, room, dir } = await newRoom();
    replaceText(room.doc, "ok.txt", "fine");
    replaceText(room.doc, "locked.txt", "cannot land");
    failWritesTo("locked.txt");

    const r = await collaborationManager.persistLiveEdits(projectId);

    expect(r.ok).toBe(false);
    expect(r.unpersisted).toEqual(["locked.txt"]);
    expect(readFileSync(join(dir, "ok.txt"), "utf8")).toBe("fine");

    vi.restoreAllMocks();
    const retry = await collaborationManager.persistLiveEdits(projectId);
    expect(retry).toEqual({ ok: true, unpersisted: [] });
    expect(readFileSync(join(dir, "locked.txt"), "utf8")).toBe("cannot land");
  });

  it("drops keys that can never be written so they cannot block every consumer", async () => {
    const { projectId, room, dir } = await newRoom();
    mkdirSync(join(dir, "src"), { recursive: true });
    // A key naming an existing directory (EISDIR) and one under a missing
    // parent (ENOENT): any collaborator — or a folder rename racing an edit —
    // can produce these.
    replaceText(room.doc, "src", "not a file");
    replaceText(room.doc, "gone/child.txt", "parent does not exist");
    replaceText(room.doc, "real.txt", "real content");

    const first = await collaborationManager.persistLiveEdits(projectId);
    expect(first).toEqual({ ok: true, unpersisted: [] });
    expect(readFileSync(join(dir, "real.txt"), "utf8")).toBe("real content");

    // …and they do not come back to block later consumers.
    replaceText(room.doc, "real.txt", "next edit");
    const second = await collaborationManager.persistLiveEdits(projectId);
    expect(second).toEqual({ ok: true, unpersisted: [] });
    expect(readFileSync(join(dir, "real.txt"), "utf8")).toBe("next edit");
  });

  it("never writes or loads collaborative keys inside .git", async () => {
    const { projectId, room, dir } = await newRoom();
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "config"), "[core]\n");
    replaceText(room.doc, ".git/config", '[filter "x"]\n\tclean = evil\n');
    replaceText(room.doc, ".gitattributes", "* filter=x\n");

    const r = await collaborationManager.persistLiveEdits(projectId);
    await room.flushToDisk(); // legacy clean-key fallback path too

    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).toBe("[core]\n");

    const loaded = await room.ensureFileLoaded(".git/HEAD");
    expect(loaded.toString()).toBe("");
    expect(room.doc.share.has(".git/HEAD")).toBe(false);
  });

  it("is bounded by its timeout when the disk hangs", async () => {
    const { projectId, room } = await newRoom();
    replaceText(room.doc, "hang.txt", "never");
    vi.spyOn(fsp, "writeFile").mockImplementation(
      (() => new Promise(() => {})) as any,
    );

    const started = Date.now();
    const r = await collaborationManager.persistLiveEdits(projectId, {
      timeoutMs: 150,
    });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.ok).toBe(false);
    expect(r.unpersisted).toEqual(["hang.txt"]);
  });

  it("never writes from a disposed room", async () => {
    const { room } = await newRoom();
    replaceText(room.doc, "gone.txt", "stale snapshot");
    const spy = vi.spyOn(fsp, "writeFile");
    room.dispose();

    const r = await room.persistLiveEdits();

    expect(r).toEqual({ ok: true, unpersisted: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Shared real-server harness
// ---------------------------------------------------------------------------

interface Booted {
  cfg: AppConfig;
  db: Db;
  server: Server;
  base: string;
}

async function bootServer(overrides: Parameters<typeof makeTestConfig>[0] = {}): Promise<Booted> {
  const cfg = makeTestConfig(overrides);
  const db = openDb(":memory:");
  const app = createApp(cfg, db);
  const server = createServer(app);
  setupWebSocketServer(server, db, cfg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { cfg, db, server, base: `http://127.0.0.1:${address.port}` };
}

async function api(
  base: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, text };
}

async function register(base: string, prefix: string) {
  const username = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
  const r = await api(base, "POST", "/api/auth/register", undefined, {
    username,
    password: "secret123",
  });
  expect(r.status).toBe(201);
  return {
    token: r.data.token as string,
    id: r.data.user.id as number,
    username,
  };
}

function wsBase(base: string) {
  return base.replace(/^http/, "ws");
}

async function connectCollab(base: string, projectId: string, token: string) {
  const ws = new WebSocket(
    `${wsBase(base)}/ws/collab?projectId=${encodeURIComponent(projectId)}`,
    { headers: { Cookie: `session_token=${token}` } },
  );
  const step1 = new Promise<void>((resolve) =>
    ws.once("message", () => resolve()),
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await step1;
  return ws;
}

/** A genuine y-sync UPDATE frame from an independent client doc. */
function sendRoomOnlyEdit(ws: WebSocket, path: string, text: string) {
  const doc = new Y.Doc();
  let update: Uint8Array | null = null;
  doc.on("update", (u: Uint8Array) => {
    update = u;
  });
  doc.getText(path).insert(0, text);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update!);
  ws.send(encoding.toUint8Array(encoder));
}

/** Freeze a room's persistence debounce so disk stays stale until something
 *  else (the barrier) writes it — sandbox startup can outlast the 2s timer. */
function freezeDebounce(projectId: string) {
  const room = collaborationManager.getRoom(projectId);
  if (!room) throw new Error("room missing");
  (room as unknown as { scheduleDebouncedPersistence: () => void }).scheduleDebouncedPersistence =
    () => {};
}

async function roomHas(projectId: string, path: string, text: string) {
  await waitFor(
    () =>
      collaborationManager.getRoom(projectId)?.doc.getText(path).toString() ===
      text,
  );
}

async function openSocket(url: string, token: string) {
  const ws = new WebSocket(url, {
    headers: { Cookie: `session_token=${token}` },
  });
  const messages: any[] = [];
  ws.on("message", (data) => {
    try {
      messages.push(JSON.parse(String(data)));
    } catch {}
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, messages };
}

// ---------------------------------------------------------------------------
// 2. Server integration — every consumer uses the barrier (no Docker)
// ---------------------------------------------------------------------------

describe("M86 consumers call the barrier after authorization", () => {
  let booted: Booted;
  let owner: { token: string; id: number; username: string };
  let viewer: { token: string; id: number; username: string };
  let stranger: { token: string; id: number; username: string };
  let projectId: string;
  let dir: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    booted = await bootServer();
    owner = await register(booted.base, "m86o");
    viewer = await register(booted.base, "m86v");
    stranger = await register(booted.base, "m86s");
    const proj = await api(booted.base, "POST", "/api/projects", owner.token, {
      name: "m86-consumers",
      language: "python",
    });
    expect(proj.status).toBe(201);
    projectId = proj.data.project.id;
    dir = join(booted.cfg.workspacesDir, projectId);
    const collab = await api(
      booted.base,
      "POST",
      `/api/projects/${projectId}/collaborators`,
      owner.token,
      { username: viewer.username, role: "viewer" },
    );
    expect(collab.status).toBeLessThan(300);
    writeFileSync(join(dir, "main.py"), "x = 1\ny = 2\nz = x + y\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const s of sockets.splice(0)) s.close();
    resetDebugSessionsForTests();
  });

  afterAll(async () => {
    collaborationManager.getRoom(projectId)?.dispose();
    booted.server.closeIdleConnections?.();
    await new Promise<void>((resolve) => booted.server.close(() => resolve()));
  });

  it("Git stage stages the live room content, not the stale disk copy", async () => {
    const init = await api(
      booted.base,
      "POST",
      `/api/projects/${projectId}/git/init`,
      owner.token,
    );
    expect(init.status).toBe(200);

    const collab = await connectCollab(booted.base, projectId, owner.token);
    sockets.push(collab);
    freezeDebounce(projectId);
    sendRoomOnlyEdit(collab, "notes.txt", "staged from the live room\n");
    await roomHas(projectId, "notes.txt", "staged from the live room\n");

    const stage = await api(
      booted.base,
      "POST",
      `/api/projects/${projectId}/git/stage`,
      owner.token,
      { paths: ["notes.txt"] },
    );

    expect(stage.status).toBe(200);
    const indexed = execFileSync("git", ["-C", dir, "show", ":notes.txt"], {
      encoding: "utf8",
    });
    expect(indexed).toBe("staged from the live room\n");
  });

  it("Git stage refuses instead of staging stale bytes when persistence fails", async () => {
    const collab = await connectCollab(booted.base, projectId, owner.token);
    sockets.push(collab);
    sendRoomOnlyEdit(collab, "blocked.txt", "cannot be persisted\n");
    await roomHas(projectId, "blocked.txt", "cannot be persisted\n");
    failWritesTo("blocked.txt");

    const stage = await api(
      booted.base,
      "POST",
      `/api/projects/${projectId}/git/stage`,
      owner.token,
      { all: true },
    );

    expect(stage.status).toBe(409);
    expect(stage.data.error.code).toBe("live_edits_not_persisted");
    expect(stage.data.error.message).toContain("blocked.txt");
    expect(stage.data.unpersisted).toEqual(["blocked.txt"]);
    const cached = execFileSync(
      "git",
      ["-C", dir, "diff", "--cached", "--name-only"],
      { encoding: "utf8" },
    );
    expect(cached).not.toContain("blocked.txt");

    vi.restoreAllMocks();
    // The room stays authoritative: the next barrier lands the content.
    const r = await collaborationManager.persistLiveEdits(projectId);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "blocked.txt"), "utf8")).toBe(
      "cannot be persisted\n",
    );
  });

  it("a viewer or outsider cannot trigger a flush through Git stage", async () => {
    const spy = vi.spyOn(collaborationManager, "persistLiveEdits");
    const asViewer = await api(
      booted.base,
      "POST",
      `/api/projects/${projectId}/git/stage`,
      viewer.token,
      { all: true },
    );
    const asStranger = await api(
      booted.base,
      "POST",
      `/api/projects/${projectId}/git/stage`,
      stranger.token,
      { all: true },
    );
    expect(asViewer.status).toBe(403);
    expect([403, 404]).toContain(asStranger.status);
    expect(spy).not.toHaveBeenCalled();
  });

  it("/ws/execute refuses to start and releases the run slot when persistence fails", async () => {
    const collab = await connectCollab(booted.base, projectId, owner.token);
    sockets.push(collab);
    sendRoomOnlyEdit(collab, "run_me.py", 'print("fresh")\n');
    await roomHas(projectId, "run_me.py", 'print("fresh")\n');
    failWritesTo("run_me.py");
    const sandboxSpy = vi.spyOn(sandboxManager, "ensureProjectSandbox");

    const { ws, messages } = await openSocket(
      `${wsBase(booted.base)}/ws/execute?projectId=${projectId}`,
      owner.token,
    );
    sockets.push(ws);
    ws.send(
      JSON.stringify({ type: "start", language: "python", activeFile: "run_me.py" }),
    );
    await waitFor(() => messages.some((m) => m.type === "error"));

    const err = messages.find((m) => m.type === "error");
    expect(err.data).toContain("run_me.py");
    expect(err.data).toMatch(/not (started|run)/i);
    expect(messages.some((m) => m.type === "exit")).toBe(false);
    expect(sandboxSpy).not.toHaveBeenCalled();
    await waitFor(() => runGate.activeCount(owner.id) === 0);
  });

  it("/ws/execute re-checks editor access on every start (demotion on an open socket)", async () => {
    const editor = await register(booted.base, "m86e");
    const added = await api(
      booted.base,
      "POST",
      `/api/projects/${projectId}/collaborators`,
      owner.token,
      { username: editor.username, role: "editor" },
    );
    expect(added.status).toBeLessThan(300);
    const { ws, messages } = await openSocket(
      `${wsBase(booted.base)}/ws/execute?projectId=${projectId}`,
      editor.token,
    );
    sockets.push(ws);

    const demoted = await api(
      booted.base,
      "PATCH",
      `/api/projects/${projectId}/collaborators/${editor.id}`,
      owner.token,
      { role: "viewer" },
    );
    expect(demoted.status).toBeLessThan(300);
    const barrier = vi.spyOn(collaborationManager, "persistLiveEdits");
    const sandboxSpy = vi.spyOn(sandboxManager, "ensureProjectSandbox");

    ws.send(JSON.stringify({ type: "start", language: "python", activeFile: "main.py" }));
    await waitFor(() => messages.some((m) => m.type === "error"));

    expect(messages.find((m) => m.type === "error").data).toMatch(/no longer have permission/i);
    expect(barrier).not.toHaveBeenCalled();
    expect(sandboxSpy).not.toHaveBeenCalled();
    expect(runGate.activeCount(editor.id)).toBe(0);
  });

  it("an unwritable key planted by a collaborator does not block Git stage", async () => {
    mkdirSync(join(dir, "pkgdir"), { recursive: true });
    const collab = await connectCollab(booted.base, projectId, owner.token);
    sockets.push(collab);
    sendRoomOnlyEdit(collab, "pkgdir", "a directory, not a file\n");
    await roomHas(projectId, "pkgdir", "a directory, not a file\n");

    const stage = await api(
      booted.base,
      "POST",
      `/api/projects/${projectId}/git/stage`,
      owner.token,
      { all: true },
    );

    expect(stage.status).toBe(200);
  });

  it("/ws/execute refuses a test task the same way", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "m86", scripts: { test: "node --test" } }),
    );
    const collab = await connectCollab(booted.base, projectId, owner.token);
    sockets.push(collab);
    sendRoomOnlyEdit(collab, "task_input.js", "module.exports = 1;\n");
    await roomHas(projectId, "task_input.js", "module.exports = 1;\n");
    failWritesTo("task_input.js");

    const { ws, messages } = await openSocket(
      `${wsBase(booted.base)}/ws/execute?projectId=${projectId}`,
      owner.token,
    );
    sockets.push(ws);
    ws.send(JSON.stringify({ type: "start", workflow: { taskId: "npm:test" } }));
    await waitFor(() => messages.some((m) => m.type === "error"));

    expect(messages.find((m) => m.type === "error").data).toContain(
      "task_input.js",
    );
    expect(messages.some((m) => m.type === "workflow" || m.type === "exit")).toBe(
      false,
    );
    await waitFor(() => runGate.activeCount(owner.id) === 0);
  });

  it("dependency install refuses with 409 and releases the run slot when persistence fails", async () => {
    const collab = await connectCollab(booted.base, projectId, owner.token);
    sockets.push(collab);
    sendRoomOnlyEdit(collab, "requirements.txt", "requests==2.32.3\n");
    await roomHas(projectId, "requirements.txt", "requests==2.32.3\n");
    failWritesTo("requirements.txt");

    const r = await api(
      booted.base,
      "POST",
      `/api/projects/${projectId}/install`,
      owner.token,
    );

    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("live_edits_not_persisted");
    expect(r.data.unpersisted).toEqual(["requirements.txt"]);
    expect(runGate.activeCount(owner.id)).toBe(0);
  });

  it("debug launch refuses and never spawns an adapter when persistence fails", async () => {
    const collab = await connectCollab(booted.base, projectId, owner.token);
    sockets.push(collab);
    sendRoomOnlyEdit(collab, "debug_me.py", "a = 1\n");
    await roomHas(projectId, "debug_me.py", "a = 1\n");
    failWritesTo("debug_me.py");

    const fakeDap = fileURLToPath(
      new URL("./fixtures/fake-dap.mjs", import.meta.url),
    );
    let spawned = 0;
    debugSessions.setSpawnForTests((_req: DebugSpawnRequest) => {
      spawned += 1;
      return spawn(process.execPath, [fakeDap], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      });
    });
    debugSessions.setContainerForTests(() => "ide-sandbox-m86");

    const { ws, messages } = await openSocket(
      `${wsBase(booted.base)}/ws/debug?projectId=${projectId}`,
      owner.token,
    );
    sockets.push(ws);
    await waitFor(() => messages.some((m) => m.type === "status"));
    ws.send(
      JSON.stringify({
        type: "launch",
        language: "python",
        entryFile: "main.py",
        breakpoints: {},
      }),
    );
    await waitFor(() => messages.some((m) => m.type === "error"));

    expect(messages.find((m) => m.type === "error").message).toContain(
      "debug_me.py",
    );
    await sleep(100);
    expect(spawned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Docker — real task and run see room-only edits
// ---------------------------------------------------------------------------

const dockerOk = isDockerRunning() && isRunnerImageAvailable();
if (process.env.CI === "true" && !dockerOk) {
  throw new Error(
    "M86 CI requires Docker and cloudeeeide-runner:latest for read-your-writes tests",
  );
}

describe.skipIf(!dockerOk)("M86 execution reads live edits (Docker)", () => {
  let booted: Booted;
  let owner: { token: string; id: number; username: string };
  const projects: string[] = [];
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    booted = await bootServer({ buildTimeoutMs: 45_000 });
    owner = await register(booted.base, "m86d");
  });

  afterEach(() => {
    for (const s of sockets.splice(0)) s.close();
  });

  afterAll(async () => {
    for (const pid of projects) collaborationManager.getRoom(pid)?.dispose();
    await sandboxManager.cleanupAllSandboxes();
    booted.server.closeIdleConnections?.();
    await new Promise<void>((resolve) => booted.server.close(() => resolve()));
  }, 120_000);

  async function project(language: string) {
    const r = await api(booted.base, "POST", "/api/projects", owner.token, {
      name: `m86-docker-${language}`,
      language,
    });
    expect(r.status).toBe(201);
    projects.push(r.data.project.id);
    return {
      projectId: r.data.project.id as string,
      dir: join(booted.cfg.workspacesDir, r.data.project.id),
    };
  }

  async function execute(projectId: string, start: unknown) {
    const { ws, messages } = await openSocket(
      `${wsBase(booted.base)}/ws/execute?projectId=${projectId}`,
      owner.token,
    );
    sockets.push(ws);
    ws.send(JSON.stringify(start));
    await waitFor(
      () => messages.some((m) => m.type === "exit" || m.type === "error"),
      90_000,
    );
    return messages;
  }

  it("a test task runs the test file that so far exists only in the live room", async () => {
    const { projectId, dir } = await project("javascript");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "m86-task",
        scripts: { test: "node --test --test-reporter=tap tests/live.test.js" },
      }),
    );
    mkdirSync(join(dir, "tests"), { recursive: true });

    const collab = await connectCollab(booted.base, projectId, owner.token);
    sockets.push(collab);
    freezeDebounce(projectId);
    const testFile = [
      "const test = require('node:test');",
      "const assert = require('node:assert');",
      "test('m86 live edit one', () => { assert.strictEqual(2 + 2, 4); });",
      "test('m86 live edit two', () => { assert.ok(true); });",
      "",
    ].join("\n");
    sendRoomOnlyEdit(collab, "tests/live.test.js", testFile);
    await roomHas(projectId, "tests/live.test.js", testFile);
    // Inside the debounce window the disk has not caught up yet.
    expect(existsSync(join(dir, "tests", "live.test.js"))).toBe(false);

    const messages = await execute(projectId, {
      type: "start",
      workflow: { taskId: "npm:test" },
    });

    const exit = messages.find((m) => m.type === "exit");
    expect(exit, JSON.stringify(messages.filter((m) => m.type === "error"))).toBeTruthy();
    expect(exit.result.exitCode).toBe(0);
    const names = (exit.tests ?? []).map((t: { name: string }) => t.name);
    expect(names.some((n: string) => /m86 live edit one/.test(n))).toBe(true);
    expect(exit.tests.every((t: { status: string }) => t.status === "passed")).toBe(true);
  }, 120_000);

  it("Run executes the file content that so far exists only in the live room", async () => {
    const { projectId, dir } = await project("python");
    const collab = await connectCollab(booted.base, projectId, owner.token);
    sockets.push(collab);
    freezeDebounce(projectId);
    const source = 'print("m86-fresh-" + str(40 + 2))\n';
    sendRoomOnlyEdit(collab, "fresh.py", source);
    await roomHas(projectId, "fresh.py", source);
    expect(existsSync(join(dir, "fresh.py"))).toBe(false);

    const messages = await execute(projectId, {
      type: "start",
      language: "python",
      activeFile: "fresh.py",
    });

    const stdout = messages
      .filter((m) => m.type === "stdout")
      .map((m) => m.data)
      .join("");
    expect(stdout, JSON.stringify(messages.filter((m) => m.type !== "stdout"))).toContain(
      "m86-fresh-42",
    );
  }, 120_000);
});
