import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as decoding from "lib0/decoding";
import { openDb } from "../src/db.js";
import { resolveConfig } from "../src/config.js";
import {
  collaborationManager,
  CollaborationRoom,
  RUN_OUTPUT_MAX_BYTES,
  type RunStatusEntry,
} from "../src/collab/manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MESSAGE_CUSTOM = 3;

/** A ws mock recording every decoded MESSAGE_CUSTOM payload sent to it. */
function makeCapturingWs(readyState = 1) {
  const sent: any[] = [];
  const ws = {
    readyState,
    send: (data: Uint8Array) => {
      try {
        const dec = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(dec) === MESSAGE_CUSTOM) {
          sent.push(JSON.parse(decoding.readVarString(dec)));
        }
      } catch {
        /* non-custom frame (sync/awareness) — ignored */
      }
    },
    close: () => {},
  } as any;
  return {
    ws,
    sent,
    outputs: () => sent.filter((m) => m.type === "run_output"),
    liveOutputs: () => sent.filter((m) => m.type === "run_output" && !m.snapshot),
    snapshots: () => sent.filter((m) => m.type === "run_output" && m.snapshot),
  };
}

function statusEntry(over: Partial<RunStatusEntry> = {}): RunStatusEntry {
  return {
    executionId: "exec-1",
    userId: 1,
    username: "alice",
    state: "running",
    file: "src/main.py",
    language: "python",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    ...over,
  };
}

describe("M65 — shared run output (server-authoritative, ephemeral)", () => {
  let db: any;
  let cfg: any;
  let tmp: string;
  const rooms: CollaborationRoom[] = [];

  const makeRoom = (projectId = "p1") => {
    const r = new CollaborationRoom(projectId, cfg, db, () => {});
    rooms.push(r);
    return r;
  };

  const addClient = async (
    room: CollaborationRoom,
    role: "owner" | "editor" | "viewer",
    userId = 10,
  ) => {
    const cap = makeCapturingWs();
    await room.addClient(cap.ws, {
      userId,
      username: `${role}-${userId}`,
      role,
    });
    return cap;
  };

  /** Push output and flush the coalescing window. */
  const emit = (
    room: CollaborationRoom,
    stream: "stdout" | "stderr",
    data: string,
    executionId = "exec-1",
  ) => {
    room.handleRunOutput(executionId, stream, data);
  };
  const flush = () => vi.advanceTimersByTime(200);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cloudide-m65-"));
    db = openDb(":memory:");
    cfg = { ...resolveConfig(), workspacesDir: tmp, dataDir: tmp };
    collaborationManager.init(cfg, db);
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const r of rooms.splice(0)) {
      try {
        r.dispose();
      } catch {}
    }
    vi.useRealTimers();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("delivers stdout batches to an editor collaborator", async () => {
    const room = makeRoom();
    const editor = await addClient(room, "editor");
    room.handleRunStatus(statusEntry());

    emit(room, "stdout", "hello ");
    emit(room, "stdout", "world\n");
    flush();

    const live = editor.liveOutputs();
    expect(live).toHaveLength(1);
    expect(live[0].executionId).toBe("exec-1");
    expect(live[0].chunks).toEqual([
      { stream: "stdout", data: "hello " },
      { stream: "stdout", data: "world\n" },
    ]);
    expect(live[0].seq).toBe(1);
  });

  it("delivers stderr as well as stdout", async () => {
    const room = makeRoom();
    const editor = await addClient(room, "editor");
    room.handleRunStatus(statusEntry());

    emit(room, "stderr", "Traceback...\n");
    flush();

    const live = editor.liveOutputs();
    expect(live).toHaveLength(1);
    expect(live[0].chunks).toEqual([
      { stream: "stderr", data: "Traceback...\n" },
    ]);
  });

  it("delivers to the owner too", async () => {
    const room = makeRoom();
    const owner = await addClient(room, "owner");
    room.handleRunStatus(statusEntry());
    emit(room, "stdout", "x\n");
    flush();
    expect(owner.liveOutputs()).toHaveLength(1);
  });

  it("NEVER delivers run output to a viewer (owner/editor-only access)", async () => {
    const room = makeRoom();
    const viewer = await addClient(room, "viewer");
    room.handleRunStatus(statusEntry());

    emit(room, "stdout", "secret build output\n");
    flush();

    expect(viewer.outputs()).toHaveLength(0);
  });

  it("ignores output for an execution with no active run status", async () => {
    const room = makeRoom();
    const editor = await addClient(room, "editor");
    // no handleRunStatus() — the run was never announced
    emit(room, "stdout", "orphan\n");
    flush();
    expect(editor.outputs()).toHaveLength(0);
  });

  it("coalesces rapid chunks into fewer batches with monotonic seq", async () => {
    const room = makeRoom();
    const editor = await addClient(room, "editor");
    room.handleRunStatus(statusEntry());

    for (let i = 0; i < 20; i++) emit(room, "stdout", `line ${i}\n`);
    flush();
    for (let i = 20; i < 25; i++) emit(room, "stdout", `line ${i}\n`);
    flush();

    const live = editor.liveOutputs();
    expect(live.length).toBeLessThan(25);
    expect(live.length).toBeGreaterThanOrEqual(2);
    expect(live.map((b) => b.seq)).toEqual(
      [...live.map((_, i) => i + 1)],
    );
  });

  it("bounds the server buffer to 256 KB, dropping oldest and latching truncated", async () => {
    const room = makeRoom();
    await addClient(room, "editor");
    room.handleRunStatus(statusEntry());

    // 400 KB of output in 8 KB chunks
    const chunk = "A".repeat(8 * 1024);
    for (let i = 0; i < 50; i++) emit(room, "stdout", chunk);
    flush();

    const snap = room.getRunOutputSnapshotForTest("exec-1");
    expect(snap).not.toBeNull();
    expect(snap!.bytes).toBeLessThanOrEqual(RUN_OUTPUT_MAX_BYTES);
    expect(snap!.truncated).toBe(true);
    // newest chunk retained
    expect(snap!.chunks[snap!.chunks.length - 1].data).toBe(chunk);
  });

  it("truncates the head of a single oversized chunk rather than dropping it whole", async () => {
    const room = makeRoom();
    await addClient(room, "editor");
    room.handleRunStatus(statusEntry());

    emit(room, "stdout", "B".repeat(RUN_OUTPUT_MAX_BYTES + 50_000));
    flush();

    const snap = room.getRunOutputSnapshotForTest("exec-1")!;
    expect(snap.chunks).toHaveLength(1);
    expect(snap.bytes).toBeLessThanOrEqual(RUN_OUTPUT_MAX_BYTES);
    expect(snap.truncated).toBe(true);
  });

  it("sends a snapshot of buffered output to an editor that joins mid-run", async () => {
    const room = makeRoom();
    room.handleRunStatus(statusEntry());
    emit(room, "stdout", "already printed\n");
    flush();

    const latecomer = await addClient(room, "editor", 20);
    const snaps = latecomer.snapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].executionId).toBe("exec-1");
    expect(snaps[0].snapshot).toBe(true);
    expect(snaps[0].chunks).toEqual([
      { stream: "stdout", data: "already printed\n" },
    ]);
    expect(typeof snaps[0].seq).toBe("number");
  });

  it("does NOT send an output snapshot to a viewer that joins mid-run", async () => {
    const room = makeRoom();
    room.handleRunStatus(statusEntry());
    emit(room, "stdout", "printed\n");
    flush();

    const viewer = await addClient(room, "viewer", 21);
    expect(viewer.outputs()).toHaveLength(0);
  });

  it("retains output through the terminal linger window, then drops it", async () => {
    const room = makeRoom();
    const editor = await addClient(room, "editor");
    room.handleRunStatus(statusEntry());
    emit(room, "stdout", "building\n");
    flush();

    // terminal state — output must survive the linger
    room.handleRunStatus(statusEntry({ state: "success", exitCode: 0 }));
    expect(room.getRunOutputSnapshotForTest("exec-1")).not.toBeNull();

    // late chunk during linger still flows
    emit(room, "stdout", "post-exit note\n");
    flush();
    expect(editor.liveOutputs().at(-1)!.chunks).toEqual([
      { stream: "stdout", data: "post-exit note\n" },
    ]);

    // linger expires → buffer gone, further output rejected
    vi.advanceTimersByTime(10_000);
    expect(room.getRunOutputSnapshotForTest("exec-1")).toBeNull();

    const before = editor.outputs().length;
    emit(room, "stdout", "way too late\n");
    flush();
    expect(editor.outputs().length).toBe(before);
  });

  it("drops output when the stale-run sweep reaps a stuck running entry", async () => {
    const room = makeRoom();
    await addClient(room, "editor");
    room.handleRunStatus(
      statusEntry({ startedAt: Date.now() - 31 * 60 * 1000 }),
    );
    emit(room, "stdout", "stuck\n");
    flush();
    expect(room.getRunOutputSnapshotForTest("exec-1")).not.toBeNull();

    vi.advanceTimersByTime(60_000); // sweep interval
    expect(room.getRunOutputSnapshotForTest("exec-1")).toBeNull();
  });

  it("dispose() clears every run-output buffer and flush timer", async () => {
    const room = makeRoom();
    await addClient(room, "editor");
    room.handleRunStatus(statusEntry());
    emit(room, "stdout", "x");
    // deliberately do NOT flush — a timer is pending
    room.dispose();
    expect(room.getRunOutputSnapshotForTest("exec-1")).toBeNull();
    // advancing time must not throw / broadcast on a disposed room
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });

  it("a disposed room ignores further run output", async () => {
    const room = makeRoom();
    room.handleRunStatus(statusEntry());
    room.dispose();
    expect(() => room.handleRunOutput("exec-1", "stdout", "late")).not.toThrow();
    expect(room.getRunOutputSnapshotForTest("exec-1")).toBeNull();
  });

  it("does not persist anything to the runs table from the output path", async () => {
    const room = makeRoom();
    await addClient(room, "editor");
    room.handleRunStatus(statusEntry());
    for (let i = 0; i < 5; i++) emit(room, "stdout", `line ${i}\n`);
    flush();
    const rows = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  it("CollaborationManager.notifyRunOutput routes to the room and is a no-op with no room", async () => {
    const room = collaborationManager.getOrCreateRoom("routed");
    rooms.push(room);
    const editor = makeCapturingWs();
    await room.addClient(editor.ws, {
      userId: 30,
      username: "ed",
      role: "editor",
    });
    room.handleRunStatus(statusEntry({ executionId: "e2" }));

    collaborationManager.notifyRunOutput("routed", "e2", "stdout", "hi\n");
    flush();
    expect(editor.liveOutputs()).toHaveLength(1);

    expect(() =>
      collaborationManager.notifyRunOutput("no-such-room", "e2", "stdout", "x"),
    ).not.toThrow();
  });

  it("skips output frames to a client whose socket is not OPEN", async () => {
    const room = makeRoom();
    const editor = await addClient(room, "editor");
    room.handleRunStatus(statusEntry());
    editor.ws.readyState = 3; // CLOSED
    emit(room, "stdout", "into the void\n");
    flush();
    expect(editor.outputs()).toHaveLength(0);
  });
});
