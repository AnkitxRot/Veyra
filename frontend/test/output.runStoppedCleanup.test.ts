import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import * as React from "react";
import type { Project } from "../src/types";

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (path: string, projectId: string) =>
    `ws://test${path}?projectId=${projectId}`,
}));

import Output from "../src/components/Output/Output";

// jsdom does not implement Element.scrollIntoView; see
// output.installStream.test.ts for the same, more detailed note.
Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView || (() => {});

// M45: Output.tsx's ide-run-confirmed effect cleanup nulls
// ws.onclose/onerror/onmessage before calling ws.close() (deliberately, to
// avoid a post-unmount setState) — but had no equivalent to M43's
// installInFlight cleanup-time dispatch for run-stopped. Live-confirmed:
// unmounting Output while a run was genuinely active (no exit/close
// received yet) left Toolbar's isRunning permanently true, with the Stop
// button stuck forever and no self-heal on returning to the Output tab.
// This suite proves the fix's exact invariant: cleanup dispatches
// run-stopped exactly once if and only if no other path (exit message,
// onclose, onerror) already did so for that run.

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    // Mirrors the real WebSocket API: if the caller (Output's unmount
    // cleanup) already nulled onclose before calling close(), it must not
    // fire here — this is exactly what makes the pre-fix bug possible.
    this.onclose?.();
  }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  static latest(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

describe("Output — Milestone 45 run-stopped cleanup-dispatch guard", () => {
  const project: Project = { id: "proj-1", name: "My Project" };

  beforeEach(() => {
    apiMock.mockReset();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderOutput() {
    return render(
      React.createElement(Output, { project, onRefreshTree: vi.fn() }),
    );
  }

  async function startRun() {
    document.dispatchEvent(
      new CustomEvent("ide-run-confirmed", {
        detail: {
          language: "python",
          activeFile: "main.py",
          langDisplay: "Python",
        },
      }),
    );
    await waitFor(() =>
      expect(FakeWebSocket.instances.length).toBeGreaterThan(0),
    );
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();
    return ws;
  }

  it("unmounting while a run is genuinely active dispatches run-stopped exactly once", async () => {
    const { unmount } = renderOutput();
    await startRun();

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    unmount();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    document.removeEventListener("run-stopped", stopSpy);
  });

  it("normal completion (exit message) does not get a second dispatch from unmount", async () => {
    const { unmount } = renderOutput();
    const ws = await startRun();

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    ws.simulateMessage({
      type: "exit",
      result: { exitCode: 0, signal: null },
    });
    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));

    // The run already completed normally before unmount — runInFlight is
    // already false, so cleanup must not add a second dispatch.
    unmount();
    expect(stopSpy).toHaveBeenCalledTimes(1);

    document.removeEventListener("run-stopped", stopSpy);
  });

  it("a websocket error does not get a second dispatch from unmount", async () => {
    const { unmount } = renderOutput();
    const ws = await startRun();

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    ws.onerror?.();
    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));

    unmount();
    expect(stopSpy).toHaveBeenCalledTimes(1);

    document.removeEventListener("run-stopped", stopSpy);
  });

  it("Stop ending the run (server closes the socket) does not get a second dispatch from unmount", async () => {
    const { unmount } = renderOutput();
    const ws = await startRun();

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    // Simulate the server closing the socket in response to a stop
    // request — onclose is still wired at this point (run genuinely ended
    // via the normal in-mount path, not via unmount).
    ws.onclose?.();
    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));

    unmount();
    expect(stopSpy).toHaveBeenCalledTimes(1);

    document.removeEventListener("run-stopped", stopSpy);
  });

  it("unmounting with no run ever started does not dispatch run-stopped", () => {
    const { unmount } = renderOutput();

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    unmount();

    expect(stopSpy).not.toHaveBeenCalled();
    document.removeEventListener("run-stopped", stopSpy);
  });

  it("cancels the in-flight websocket on unmount (existing behavior unchanged)", async () => {
    const { unmount } = renderOutput();
    const ws = await startRun();

    unmount();

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
