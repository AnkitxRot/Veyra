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
import { ExecutionSessionProvider } from "../src/hooks/useExecutionSession";

// jsdom does not implement Element.scrollIntoView.
Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView || (() => {});

// M45 (relocated by M53): the run WebSocket + its cleanup now live in the
// ExecutionSessionProvider, not <Output>. The M45 invariant is unchanged —
// teardown dispatches run-stopped exactly once IFF no other path (exit
// message, onclose, onerror) already did — but the teardown boundary is now
// the PROVIDER unmounting (project switch / IDE teardown), NOT <Output>
// unmounting. Unmounting <Output> alone (any bottom-tab switch / collapse)
// must leave a running program completely untouched: that is the core M53
// fix (also asserted in executionSession.test.tsx).

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
    // Mirrors the real WebSocket API: if the caller (the provider's teardown)
    // already nulled onclose before calling close(), it must not fire here.
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

describe("ExecutionSession — Milestone 45 run-stopped teardown guard (relocated by M53)", () => {
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

  // Renders the provider (the teardown boundary) with <Output> as its child.
  // `showOutput` toggles only the <Output> view; the provider stays mounted.
  function Harness({ showOutput = true }: { showOutput?: boolean }) {
    return (
      <ExecutionSessionProvider projectId={project.id}>
        {showOutput ? (
          <Output project={project} onRefreshTree={() => {}} />
        ) : null}
      </ExecutionSessionProvider>
    );
  }

  function renderSession(showOutput = true) {
    return render(<Harness showOutput={showOutput} />);
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

  it("unmounting only <Output> (bottom-tab switch) does NOT stop the run and does NOT close the socket", async () => {
    const { rerender } = renderSession(true);
    const ws = await startRun();

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    // Switch the bottom panel away from Output — provider stays mounted.
    rerender(<Harness showOutput={false} />);

    expect(stopSpy).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);

    document.removeEventListener("run-stopped", stopSpy);
  });

  it("unmounting the provider while a run is genuinely active dispatches run-stopped exactly once", async () => {
    const { unmount } = renderSession(true);
    await startRun();

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    unmount();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    document.removeEventListener("run-stopped", stopSpy);
  });

  it("normal completion (exit message) does not get a second dispatch from provider unmount", async () => {
    const { unmount } = renderSession(true);
    const ws = await startRun();

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    ws.simulateMessage({
      type: "exit",
      result: { exitCode: 0, signal: null },
    });
    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));

    unmount();
    expect(stopSpy).toHaveBeenCalledTimes(1);

    document.removeEventListener("run-stopped", stopSpy);
  });

  it("a websocket error does not get a second dispatch from provider unmount", async () => {
    const { unmount } = renderSession(true);
    const ws = await startRun();

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    ws.onerror?.();
    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));

    unmount();
    expect(stopSpy).toHaveBeenCalledTimes(1);

    document.removeEventListener("run-stopped", stopSpy);
  });

  it("Stop ending the run (server closes the socket) does not get a second dispatch from provider unmount", async () => {
    const { unmount } = renderSession(true);
    const ws = await startRun();

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    ws.onclose?.();
    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));

    unmount();
    expect(stopSpy).toHaveBeenCalledTimes(1);

    document.removeEventListener("run-stopped", stopSpy);
  });

  it("unmounting the provider with no run ever started does not dispatch run-stopped", () => {
    const { unmount } = renderSession(true);

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    unmount();

    expect(stopSpy).not.toHaveBeenCalled();
    document.removeEventListener("run-stopped", stopSpy);
  });

  it("cancels the in-flight websocket on provider unmount (existing behavior unchanged)", async () => {
    const { unmount } = renderSession(true);
    const ws = await startRun();

    unmount();

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
