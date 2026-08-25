// Milestone 7b: deterministic lifecycle tests for the load-test harness's
// simulated collaboration clients (backend/load-test/virtualUser.ts).
// Milestone 7 found that these never explicitly released their Y.Doc/
// WebSocket/AbortSignal listeners, causing every virtual user's replica of
// the shared document to be retained for the rest of the process — this
// file proves the fix without any real network I/O or real timers.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { getEventListeners } from "node:events";
import * as Y from "yjs";

/**
 * Duck-types as a `ws` WebSocket closely enough for virtualUser.ts's
 * purposes (readyState + EventEmitter + send/close) without opening any
 * real socket. Instances register themselves in `FakeWebSocket.instances`
 * so tests can reach the ws that `connectCollab()` constructs internally.
 */
class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });

  constructor(
    public url: string,
    public opts?: unknown,
  ) {
    super();
    FakeWebSocket.instances.push(this);
  }
}

vi.mock("ws", () => ({ default: FakeWebSocket }));

const {
  sleep,
  wireYjsClient,
  waitForOpenOrAbort,
  disposeCollabClient,
  runCollabRoom,
} = await import("../load-test/virtualUser.js");

function fakeMetrics() {
  return { collabEditToPeerLatency: { record: vi.fn() } } as any;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("virtualUser.ts collaboration client lifecycle (M7b)", () => {
  it("A. runCollabRoom disposes the socket and destroys the doc on normal loop exit", async () => {
    vi.useFakeTimers();
    const destroySpy = vi.spyOn(Y.Doc.prototype, "destroy");
    const controller = new AbortController();
    const ctx = {
      wsBase: "ws://fake",
      metrics: fakeMetrics(),
      signal: controller.signal,
      vuIndex: 0,
      sharedProjectIds: [],
    } as any;

    const promise = runCollabRoom(ctx, "tok", "proj1", 200);
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.emit("open");
    await vi.advanceTimersByTimeAsync(0);

    // One full edit/sleep cycle, then abort — the while loop's own
    // condition exits as soon as ctx.signal.aborted flips.
    await vi.advanceTimersByTimeAsync(300);
    controller.abort();
    await promise;

    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(ws.listenerCount("open")).toBe(0);
    expect(ws.listenerCount("message")).toBe(0);
  });

  it("B. disposeCollabClient teardown is idempotent", () => {
    const ws = new FakeWebSocket("ws://fake");
    const doc = new Y.Doc();
    const destroySpy = vi.spyOn(doc, "destroy");
    const unwire = vi.fn();

    const dispose = disposeCollabClient(ws as any, doc, unwire);
    dispose();
    dispose();
    dispose();

    expect(unwire).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("C. aborting before the socket ever opens still disposes the socket and doc", async () => {
    const destroySpy = vi.spyOn(Y.Doc.prototype, "destroy");
    const controller = new AbortController();
    const ctx = {
      wsBase: "ws://fake",
      metrics: fakeMetrics(),
      signal: controller.signal,
      vuIndex: 0,
      sharedProjectIds: [],
    } as any;

    const promise = runCollabRoom(ctx, "tok", "proj1", 200);
    await Promise.resolve(); // let connectCollab() construct the fake ws
    const ws = FakeWebSocket.instances.at(-1)!;
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);

    controller.abort();
    await promise;

    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("D. sleep() removes its abort listener after normal (timeout) completion", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const p = sleep(1000, controller.signal);
    expect(getEventListeners(controller.signal, "abort").length).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("E. sleep() removes its listener when the signal aborts before the timeout", async () => {
    const controller = new AbortController();

    const p = sleep(5000, controller.signal);
    expect(getEventListeners(controller.signal, "abort").length).toBe(1);

    controller.abort();
    await p;

    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("F. repeated sleep() calls on the same signal never accumulate listeners", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    for (let i = 0; i < 25; i++) {
      const p = sleep(100, controller.signal);
      expect(getEventListeners(controller.signal, "abort").length).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      await p;
    }

    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("G. after a multi-VU collaboration workload finishes, no client-side ws/doc resources remain", async () => {
    vi.useFakeTimers();
    const destroySpy = vi.spyOn(Y.Doc.prototype, "destroy");
    const controller = new AbortController();
    const vuCount = 3;

    const promises = Array.from({ length: vuCount }, (_, i) => {
      const ctx = {
        wsBase: "ws://fake",
        metrics: fakeMetrics(),
        signal: controller.signal,
        vuIndex: i,
        sharedProjectIds: [],
      } as any;
      return runCollabRoom(ctx, `tok${i}`, "shared-proj", 200);
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeWebSocket.instances.length).toBe(vuCount);
    for (const ws of FakeWebSocket.instances) {
      ws.readyState = FakeWebSocket.OPEN;
      ws.emit("open");
    }
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300);

    controller.abort();
    await Promise.all(promises);

    expect(destroySpy).toHaveBeenCalledTimes(vuCount);
    for (const ws of FakeWebSocket.instances) {
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(ws.listenerCount("open")).toBe(0);
      expect(ws.listenerCount("message")).toBe(0);
    }
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });
});

describe("wireYjsClient / waitForOpenOrAbort listener hygiene", () => {
  it("wireYjsClient's disposer removes exactly the listeners it added, nothing else", () => {
    const ws = new FakeWebSocket("ws://fake");
    ws.on("close", () => {}); // a listener this module must not touch
    const doc = new Y.Doc();

    const unwire = wireYjsClient(ws as any, doc);
    expect(ws.listenerCount("open")).toBe(1);
    expect(ws.listenerCount("message")).toBe(1);

    unwire();
    expect(ws.listenerCount("open")).toBe(0);
    expect(ws.listenerCount("message")).toBe(0);
    expect(ws.listenerCount("close")).toBe(1);
  });

  it("waitForOpenOrAbort resolves and cleans up on open, leaving no dangling listeners", async () => {
    const ws = new FakeWebSocket("ws://fake");
    const controller = new AbortController();

    const p = waitForOpenOrAbort(ws as any, controller.signal);
    ws.readyState = FakeWebSocket.OPEN;
    ws.emit("open");
    await p;

    expect(ws.listenerCount("open")).toBe(0);
    expect(ws.listenerCount("error")).toBe(0);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });
});
