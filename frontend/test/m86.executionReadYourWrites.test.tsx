import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import * as React from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// M86: Test/Build must execute what the editor shows. Run and Debug already
// flush dirty editor buffers before starting; workflow tasks now go through
// the same preparation, and a server refusal (`error` frame — e.g. live edits
// that could not be persisted) must end the attempt instead of leaving the
// Run/Test UI stuck in "Running".

vi.mock("../src/api", () => ({
  api: vi.fn(),
  getWebSocketUrl: (path: string, projectId: string) =>
    `ws://test${path}?projectId=${projectId}`,
  getWorkflow: vi.fn(async () => ({ tasks: [] })),
}));

import {
  ExecutionSessionProvider,
  useExecutionSession,
} from "../src/hooks/useExecutionSession";

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
    this.onclose?.();
  }
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  simulateMessage(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  static latest() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

function Probe() {
  const s = useExecutionSession();
  return (
    <div>
      <button type="button" onClick={() => s.runWorkflow({ taskId: "npm:test" })}>
        wf
      </button>
      <button
        type="button"
        onClick={() => s.run({ language: "python", activeFile: "main.py" })}
      >
        run
      </button>
      <span data-testid="running">{String(s.isRunning)}</span>
      <span data-testid="status">{s.status.text}</span>
      <span data-testid="logs">{s.logs.map((l) => l.text).join("|")}</span>
    </div>
  );
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("M86 — a server refusal ends the execution attempt", () => {
  it("clears Running, dispatches run-stopped, closes the socket, and keeps the error visible", async () => {
    const stopped = vi.fn();
    document.addEventListener("run-stopped", stopped);
    try {
      const view = render(
        <ExecutionSessionProvider projectId="p1">
          <Probe />
        </ExecutionSessionProvider>,
      );
      fireEvent.click(view.getByText("run"));
      await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
      const ws = FakeWebSocket.latest();
      act(() => ws.simulateOpen());
      expect(view.getByTestId("running").textContent).toBe("true");

      act(() =>
        ws.simulateMessage({
          type: "error",
          data: "Latest edits to main.py could not be saved to disk; not started so stale code is not run.",
        }),
      );

      await waitFor(() =>
        expect(view.getByTestId("running").textContent).toBe("false"),
      );
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
      expect(view.getByTestId("status").textContent).toBe("Error");
      expect(view.getByTestId("logs").textContent).toContain(
        "could not be saved to disk",
      );
      expect(view.getByTestId("logs").textContent).not.toContain(
        "Execution stream closed",
      );
    } finally {
      document.removeEventListener("run-stopped", stopped);
    }
  });

  it("a later exit frame on the same socket cannot resurrect the ended attempt", async () => {
    const view = render(
      <ExecutionSessionProvider projectId="p1">
        <Probe />
      </ExecutionSessionProvider>,
    );
    fireEvent.click(view.getByText("run"));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.latest();
    act(() => ws.simulateOpen());
    const onmessage = ws.onmessage;
    act(() => ws.simulateMessage({ type: "error", data: "refused" }));
    await waitFor(() =>
      expect(view.getByTestId("running").textContent).toBe("false"),
    );
    // Even if a stale frame were delivered, it must not change the state.
    act(() =>
      onmessage?.({
        data: JSON.stringify({ type: "exit", result: { exitCode: 0 } }),
      }),
    );
    expect(view.getByTestId("status").textContent).toBe("Error");
  });
});

describe("M86 — Stop pressed while the execution socket is still connecting", () => {
  it("is sent right after the start frame instead of being dropped", async () => {
    function StopProbe() {
      const s = useExecutionSession();
      return (
        <div>
          <button type="button" onClick={() => s.run({ language: "python", activeFile: "main.py" })}>
            run
          </button>
          <button type="button" onClick={() => s.stop()}>
            stop
          </button>
        </div>
      );
    }
    const view = render(
      <ExecutionSessionProvider projectId="p1">
        <StopProbe />
      </ExecutionSessionProvider>,
    );
    fireEvent.click(view.getByText("run"));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.latest();
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);

    fireEvent.click(view.getByText("stop"));
    expect(ws.sent).toEqual([]);
    act(() => ws.simulateOpen());

    expect(ws.sent.map((m) => JSON.parse(m).type)).toEqual(["start", "stop"]);
  });
});

describe("M86 — workflow tasks prepare the workspace before starting", () => {
  it("does not open the socket until prepareRun resolves", async () => {
    let resolvePrepare!: () => void;
    const prepareRun = vi.fn(
      () => new Promise<void>((r) => (resolvePrepare = r)),
    );
    const view = render(
      <ExecutionSessionProvider projectId="p1" prepareRun={prepareRun}>
        <Probe />
      </ExecutionSessionProvider>,
    );

    fireEvent.click(view.getByText("wf"));
    await waitFor(() => expect(prepareRun).toHaveBeenCalledTimes(1));
    expect(FakeWebSocket.instances.length).toBe(0);

    await act(async () => resolvePrepare());
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.latest();
    act(() => ws.simulateOpen());
    expect(ws.sent.map((m) => JSON.parse(m))).toEqual([
      { type: "start", workflow: { taskId: "npm:test" } },
    ]);
  });

  it("ignores a second request while the first is still preparing", async () => {
    let resolvePrepare!: () => void;
    const prepareRun = vi.fn(
      () => new Promise<void>((r) => (resolvePrepare = r)),
    );
    const view = render(
      <ExecutionSessionProvider projectId="p1" prepareRun={prepareRun}>
        <Probe />
      </ExecutionSessionProvider>,
    );

    fireEvent.click(view.getByText("wf"));
    fireEvent.click(view.getByText("wf"));
    await waitFor(() => expect(prepareRun).toHaveBeenCalledTimes(1));

    await act(async () => resolvePrepare());
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("does not start the task for a project the user already switched away from", async () => {
    let resolvePrepare!: () => void;
    const prepareRun = vi.fn(
      () => new Promise<void>((r) => (resolvePrepare = r)),
    );
    const view = render(
      <ExecutionSessionProvider projectId="p1" prepareRun={prepareRun}>
        <Probe />
      </ExecutionSessionProvider>,
    );
    fireEvent.click(view.getByText("wf"));
    await waitFor(() => expect(prepareRun).toHaveBeenCalledTimes(1));

    view.rerender(
      <ExecutionSessionProvider projectId="p2" prepareRun={prepareRun}>
        <Probe />
      </ExecutionSessionProvider>,
    );
    await act(async () => resolvePrepare());
    await new Promise((r) => setTimeout(r, 20));

    expect(FakeWebSocket.instances.length).toBe(0);
    expect(view.getByTestId("running").textContent).toBe("false");
  });

  it("IDE wires the same dirty-buffer flush into Run and Test/Build", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const ide = readFileSync(join(here, "../src/components/IDE/IDE.tsx"), "utf-8");
    expect(ide).toContain("prepareRun={saveDirtyFilesBeforeExecution}");
    const runHandler = ide.slice(
      ide.indexOf("const handleRunRequest = async"),
      ide.indexOf('document.addEventListener("ide-run", handleRunRequest)'),
    );
    expect(runHandler).toContain("await saveDirtyFilesBeforeExecution();");
  });

  it("still starts the task when preparation fails (the server barrier stays authoritative)", async () => {
    const prepareRun = vi.fn(async () => {
      throw new Error("offline");
    });
    const view = render(
      <ExecutionSessionProvider projectId="p1" prepareRun={prepareRun}>
        <Probe />
      </ExecutionSessionProvider>,
    );
    fireEvent.click(view.getByText("wf"));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  });
});
