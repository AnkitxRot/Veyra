/**
 * M91: Deterministic tests for idle-disposal retry behavior using VirtualClock.
 *
 * These tests exercise the bounded retry loop in scheduleIdleDisposal()
 * WITHOUT vi.useFakeTimers(). The clock abstraction is injected directly.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeTestConfig } from "./helpers.js";
import { openDb } from "../src/db.js";
import { createProject } from "../src/projects/service.js";
import {
  CollaborationRoom,
  VirtualClock,
} from "../src/collab/manager.js";

// -- helpers ----------------------------------------------------------

function makeWs() {
  return {
    readyState: 1,
    send: () => {},
    close: () => {},
  } as any;
}

async function setupRoom(onDispose: (projectId: string) => void) {
  const cfg = makeTestConfig();
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
  ).run("ida", "h", "user");
  const project = await createProject(cfg, db, 1, { name: "M91Proj" });
  const clock = new VirtualClock();
  const room = new CollaborationRoom(
    project.id,
    cfg,
    db,
    onDispose,
    {},
    undefined,
    clock,
  );
  const ws = makeWs();
  return { cfg, db, room, ws, project, clock };
}

describe("M91 Idle-Disposal Retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("13. retry cap of 3 then dispose even if flush keeps failing", async () => {
    const onDispose = vi.fn();
    const { room, _ws, _project, clock } = await setupRoom(onDispose);

    const filePath = "test.txt";
    const ws2 = makeWs();
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, "data");
    });
    room.markFileDirty(filePath);

    vi.spyOn(room as any, "flushToDisk").mockImplementation(async () => {
      return [filePath];
    });

    room.removeClient(ws2);

    // T=10: idle fires → retries=1, retry at T=30
    await clock.advanceBy(10_000);
    expect((room as any).idleDisposeRetries).toBe(1);
    expect(onDispose).not.toHaveBeenCalled();

    // T=30: retry fires → retries=2, retry at T=70
    await clock.advanceBy(20_000);
    expect((room as any).idleDisposeRetries).toBe(2);
    expect(onDispose).not.toHaveBeenCalled();

    // T=70: retry fires → retries=3, calls scheduleIdleDisposal → hits cap → dispose
    await clock.advanceBy(40_000);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(room.isDisposed).toBe(true);
    expect(room.doc.getText(filePath).toString()).toBe("data");
  });

  it("13b. successful retry disposes the room", async () => {
    const onDispose = vi.fn();
    const { room, _ws, clock } = await setupRoom(onDispose);

    const filePath = "recover.txt";
    const ws2 = makeWs();
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, "recovered");
    });
    room.markFileDirty(filePath);

    let attempts = 0;
    vi.spyOn(room as any, "flushToDisk").mockImplementation(async () => {
      attempts++;
      if (attempts <= 3) return [filePath];
      (room as any).dirtyFiles.delete(filePath);
      return [];
    });

    room.removeClient(ws2);

    // T=10: debounce+idle fail, retry scheduled at T=30
    await clock.advanceBy(10_000);
    expect(attempts).toBe(3); // debounce, maxFlush, idle
    expect((room as any).idleDisposeRetries).toBe(1);
    expect(onDispose).not.toHaveBeenCalled();

    // T=30: retry succeeds → dirtyFiles cleared → dispose()
    await clock.advanceBy(20_000);
    expect(attempts).toBe(4);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(room.isDisposed).toBe(true);
    expect(room.doc.getText(filePath).toString()).toBe("recovered");
  });

  it("14. retry counter resets on client rejoin", async () => {
    const onDispose = vi.fn();
    const { room, _ws, clock } = await setupRoom(onDispose);

    const filePath = "rejoin.txt";
    const ws2 = makeWs();
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, "rejoin-content");
    });
    room.markFileDirty(filePath);

    vi.spyOn(room as any, "flushToDisk").mockImplementation(async () => {
      return [filePath];
    });

    room.removeClient(ws2);
    await clock.advanceBy(10_000);
    expect((room as any).idleDisposeRetries).toBe(1);
    expect(onDispose).not.toHaveBeenCalled();

    // Rejoin resets counter
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    expect((room as any).idleDisposeRetries).toBe(0);

    // Leave again — starts fresh
    room.removeClient(ws2);
    await clock.advanceBy(10_000);
    expect((room as any).idleDisposeRetries).toBe(1);

    // Now flush succeeds
    vi.spyOn(room as any, "flushToDisk").mockImplementation(async () => {
      (room as any).dirtyFiles.delete(filePath);
      return [];
    });
    await clock.advanceBy(20_000);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(room.isDisposed).toBe(true);
  });

  it("15. stale timer cleared on rejoin prevents disposal", async () => {
    const onDispose = vi.fn();
    const { room, _ws, clock } = await setupRoom(onDispose);

    const filePath = "stale.txt";
    const ws2 = makeWs();
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, "stale-content");
    });
    room.markFileDirty(filePath);

    vi.spyOn(room as any, "flushToDisk").mockImplementation(async () => {
      return [filePath];
    });

    // Client leaves, timer armed
    room.removeClient(ws2);
    expect((room as any).idleDisposeTimer).not.toBeNull();

    // Client rejoins BEFORE timer fires — clears the idle timer
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    expect((room as any).idleDisposeTimer).toBeNull();

    // Even after time passes, room is not disposed
    await clock.advanceBy(30_000);
    expect(onDispose).not.toHaveBeenCalled();
    expect(room.isDisposed).toBe(false);

    room.dispose();
  });

  it("16. concurrent edit during retry keeps dirtyFiles dirty", async () => {
    const onDispose = vi.fn();
    const { room, _ws, clock } = await setupRoom(onDispose);

    const filePath = "concurrent.txt";
    const ws2 = makeWs();
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, "initial");
    });
    room.markFileDirty(filePath);

    let _flushCount = 0;
    vi.spyOn(room as any, "flushToDisk").mockImplementation(async () => {
      _flushCount++;
      return [filePath]; // always fail
    });

    room.removeClient(ws2);

    // T=10: debounce + maxFlush + idle fire → all fail → retry at T=30
    await clock.advanceBy(10_000);
    expect(_flushCount).toBe(3);
    expect((room as any).dirtyFiles.has(filePath)).toBe(true);

    // Concurrent edit during backoff
    room.doc.transact(() => {
      room.doc.getText(filePath).delete(0, "initial".length);
      room.doc.getText(filePath).insert(0, "concurrent-edit");
    });
    room.markFileDirty(filePath);

    // T=30: retry fires → flush fails → retries=2 → scheduleIdleDisposal
    // arms next retry at T=70
    await clock.advanceBy(20_000);
    expect((room as any).idleDisposeRetries).toBe(2);
    // dirtyFiles still dirty and doc holds the concurrent edit
    expect((room as any).dirtyFiles.has(filePath)).toBe(true);
    expect(room.doc.getText(filePath).toString()).toBe("concurrent-edit");

    // T=70: retry fires → flush fails → retries=3 → cap → dispose
    await clock.advanceBy(40_000);
    expect((room as any).idleDisposeRetries).toBe(3);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(room.isDisposed).toBe(true);
  });

  it("17. exponential backoff delay progression", async () => {
    const onDispose = vi.fn();
    const { room, _ws, clock } = await setupRoom(onDispose);

    const filePath = "backoff.txt";
    const ws2 = makeWs();
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, "backoff");
    });
    room.markFileDirty(filePath);

    let _flushCount = 0;
    vi.spyOn(room as any, "flushToDisk").mockImplementation(async () => {
      _flushCount++;
      return [filePath];
    });

    room.removeClient(ws2);

    // T=10: idle fires → retries=1, retry at T=30
    await clock.advanceBy(10_000);
    expect((room as any).idleDisposeRetries).toBe(1);

    // T=30: retry fires → retries=2, retry at T=70
    await clock.advanceBy(20_000);
    expect((room as any).idleDisposeRetries).toBe(2);

    // T=70: retry fires → retries=3, scheduleIdleDisposal hits cap → dispose
    await clock.advanceBy(40_000);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(room.isDisposed).toBe(true);
  });

  it("18. retry counter resets to allow fresh retry cycle after rejoin", async () => {
    const onDispose = vi.fn();
    const { room, _ws, clock } = await setupRoom(onDispose);

    const filePath = "reset.txt";
    const ws2 = makeWs();
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, "reset");
    });
    room.markFileDirty(filePath);

    vi.spyOn(room as any, "flushToDisk").mockImplementation(async () => {
      return [filePath];
    });

    // Leave → fail
    room.removeClient(ws2);
    await clock.advanceBy(10_000);
    expect((room as any).idleDisposeRetries).toBe(1);

    // Rejoin resets counter
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    expect((room as any).idleDisposeRetries).toBe(0);

    // Leave again — fresh retry cycle
    room.removeClient(ws2);

    await clock.advanceBy(10_000);
    expect((room as any).idleDisposeRetries).toBe(1);

    await clock.advanceBy(20_000);
    expect((room as any).idleDisposeRetries).toBe(2);

    await clock.advanceBy(40_000);
    expect((room as any).idleDisposeRetries).toBe(3);

    // Cap triggers dispose
    await clock.advanceBy(80_000);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(room.isDisposed).toBe(true);
  });

  it("19. timer field is null after successful disposal", async () => {
    const onDispose = vi.fn();
    const { room, _ws, clock } = await setupRoom(onDispose);

    const filePath = "cleanup.txt";
    const ws2 = makeWs();
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, "cleanup");
    });
    room.markFileDirty(filePath);

    vi.spyOn(room as any, "flushToDisk").mockImplementation(async () => {
      (room as any).dirtyFiles.delete(filePath);
      return [];
    });

    room.removeClient(ws2);

    // T=10: idle fires → flush succeeds → dirtyFiles empty → dispose()
    await clock.advanceBy(10_000);

    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(room.isDisposed).toBe(true);
    expect((room as any).idleDisposeTimer).toBeNull();
  });

  it("20. rejoin clears idle timer — room not disposed after timer deadline", async () => {
    const onDispose = vi.fn();
    const { room, _ws, clock } = await setupRoom(onDispose);

    const filePath = "rejoin-clear.txt";
    const ws2 = makeWs();
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    room.doc.transact(() => {
      room.doc.getText(filePath).insert(0, "rejoin-data");
    });
    room.markFileDirty(filePath);

    vi.spyOn(room as any, "flushToDisk").mockImplementation(async () => {
      return [filePath];
    });

    // Client leaves → idle timer armed
    room.removeClient(ws2);
    const timerBefore = (room as any).idleDisposeTimer;
    expect(timerBefore).not.toBeNull();

    // Client rejoins → idle timer cleared, retry counter reset
    await room.addClient(ws2, { userId: 1, username: "ida", role: "editor" });
    expect((room as any).idleDisposeTimer).toBeNull();
    expect((room as any).idleDisposeRetries).toBe(0);

    // Advance past when the OLD timer would have fired (T=10s)
    // The cleared timer cannot fire, so room stays alive
    await clock.advanceBy(20_000);
    expect(onDispose).not.toHaveBeenCalled();
    expect(room.isDisposed).toBe(false);

    room.dispose();
  });
});
