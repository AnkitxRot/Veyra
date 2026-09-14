import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  cleanup,
  waitFor,
  act,
  within,
  fireEvent,
} from "@testing-library/react";
import * as React from "react";
import type { Project } from "../src/types";

// M53: the run + install lifecycle lives in the project-scoped
// ExecutionSessionProvider, NOT in <Output>. Switching the bottom panel away
// from Output (or collapsing it) unmounts <Output> but MUST NOT touch a
// running program. This suite is the core proof of that guarantee.

const apiMock = vi.fn();
const getWorkflowMock = vi.fn(
  async (_projectId?: string): Promise<{ tasks: unknown[] }> => ({ tasks: [] }),
);
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (path: string, projectId: string) =>
    `ws://test${path}?projectId=${projectId}`,
  getWorkflow: (projectId: string) => getWorkflowMock(projectId),
}));

import Output from "../src/components/Output/Output";
import {
  ExecutionSessionProvider,
  useExecutionSession,
} from "../src/hooks/useExecutionSession";

Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView || (() => {});

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

const project: Project = { id: "proj-1", name: "My Project" };

function OutputHost({ show }: { show: boolean }) {
  return (
    <ExecutionSessionProvider projectId={project.id}>
      {show ? <Output project={project} onRefreshTree={() => {}} /> : null}
    </ExecutionSessionProvider>
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
  act(() => ws.simulateOpen());
  return ws;
}

beforeEach(() => {
  apiMock.mockReset();
  getWorkflowMock.mockReset();
  getWorkflowMock.mockResolvedValue({ tasks: [] });
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("M53 — persistent project-scoped execution session", () => {
  it("a run survives <Output> unmounting (bottom-tab switch) and its output is intact on remount", async () => {
    const view = render(<OutputHost show={true} />);
    const ws = await startRun();

    act(() => ws.simulateMessage({ type: "stdout", data: "line-before\n" }));
    await waitFor(() =>
      expect(view.container.textContent).toContain("line-before"),
    );

    // Bottom-tab switch: <Output> unmounts, provider stays.
    view.rerender(<OutputHost show={false} />);

    // The run WebSocket is untouched — still OPEN, no stop frame sent.
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(ws.sent.some((m) => m.includes('"stop"'))).toBe(false);

    // More output arrives while Output is not on screen.
    act(() =>
      ws.simulateMessage({ type: "stdout", data: "line-while-away\n" }),
    );

    // Reopen the Output tab — the full accumulated log is there.
    view.rerender(<OutputHost show={true} />);
    await waitFor(() => {
      expect(view.container.textContent).toContain("line-before");
      expect(view.container.textContent).toContain("line-while-away");
    });
  });

  it("Stop still works after <Output> was unmounted and remounted", async () => {
    const view = render(<OutputHost show={true} />);
    const ws = await startRun();

    view.rerender(<OutputHost show={false} />);
    view.rerender(<OutputHost show={true} />);

    document.dispatchEvent(new Event("ide-stop"));
    await waitFor(() =>
      expect(ws.sent.some((m) => JSON.parse(m).type === "stop")).toBe(true),
    );
  });

  it("stdin still works after <Output> was unmounted and remounted", async () => {
    const view = render(<OutputHost show={true} />);
    const ws = await startRun();
    // Program is waiting for input — the stdin form renders while isRunning.
    view.rerender(<OutputHost show={false} />);
    view.rerender(<OutputHost show={true} />);

    const form = view.container.querySelector(
      "form.output-stdin-form",
    ) as HTMLFormElement;
    expect(form).toBeTruthy();
    const input = within(form).getByPlaceholderText(
      /standard input/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(form);

    await waitFor(() => {
      const stdin = ws.sent
        .map((m) => JSON.parse(m))
        .find((m) => m.type === "stdin");
      expect(stdin?.data).toBe("hello\n");
    });
  });

  it("a dependency install survives <Output> unmounting and finishes", async () => {
    let resolveRead: (v: {
      done: boolean;
      value?: Uint8Array;
    }) => void = () => {};
    const reader = {
      read: vi.fn(
        () =>
          new Promise<{ done: boolean; value?: Uint8Array }>((res) => {
            resolveRead = res;
          }),
      ),
      cancel: vi.fn(() => Promise.resolve()),
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: { getReader: () => reader },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<OutputHost show={true} />);

    document.dispatchEvent(new Event("ide-install-confirmed"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Output leaves the screen mid-install.
    view.rerender(<OutputHost show={false} />);

    // The stream keeps being consumed — deliver a chunk, then finish.
    act(() =>
      resolveRead({
        done: false,
        value: new TextEncoder().encode("installed pkg\n"),
      }),
    );
    await waitFor(() => expect(reader.read).toHaveBeenCalledTimes(2));
    act(() => resolveRead({ done: true }));

    // Back to Output — the streamed line is present, install completed.
    view.rerender(<OutputHost show={true} />);
    await waitFor(() =>
      expect(view.container.textContent).toContain("installed pkg"),
    );
  });

  it("changing projectId tears down the old run: old socket closed + run-stopped dispatched once", async () => {
    function Host({ pid }: { pid: string }) {
      return (
        <ExecutionSessionProvider projectId={pid}>
          <Output project={{ id: pid, name: pid }} onRefreshTree={() => {}} />
        </ExecutionSessionProvider>
      );
    }
    const view = render(<Host pid="proj-1" />);
    const ws = await startRun();

    const stopSpy = vi.fn();
    document.addEventListener("run-stopped", stopSpy);

    view.rerender(<Host pid="proj-2" />);

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    document.removeEventListener("run-stopped", stopSpy);
  });

  it("project switch drops logs, running flag, and a late workflow fetch from the previous project", async () => {
    let resolveA: ((value: { tasks: unknown[] }) => void) | undefined;
    getWorkflowMock.mockImplementation((pid?: string) => {
      if (pid === "proj-1") {
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve({
        tasks: [
          {
            id: "npm:test",
            name: "test",
            kind: "test",
            origin: "package.json",
          },
        ],
      });
    });

    function Probe() {
      const s = useExecutionSession();
      return (
        <div>
          <span data-testid="logs">{s.logs.length}</span>
          <span data-testid="running">{String(s.isRunning)}</span>
          <span data-testid="results">{s.testResults.length}</span>
          <span data-testid="tasks">
            {s.workflowTasks.map((t) => t.id).join(",")}
          </span>
        </div>
      );
    }
    function Host({ pid }: { pid: string }) {
      return (
        <ExecutionSessionProvider projectId={pid}>
          <Probe />
        </ExecutionSessionProvider>
      );
    }

    const view = render(<Host pid="proj-1" />);
    const ws = await startRun();
    act(() => {
      ws.simulateMessage({ type: "stdout", data: "from-a\n" });
      ws.simulateMessage({
        type: "workflow",
        kind: "test",
        tests: [{ name: "a", status: "fail" }],
      });
    });
    await waitFor(() =>
      expect(Number(view.getByTestId("logs").textContent)).toBeGreaterThan(0),
    );
    expect(view.getByTestId("running").textContent).toBe("true");

    view.rerender(<Host pid="proj-2" />);
    expect(view.getByTestId("logs").textContent).toBe("0");
    expect(view.getByTestId("running").textContent).toBe("false");
    expect(view.getByTestId("results").textContent).toBe("0");

    await act(async () => {
      resolveA?.({
        tasks: [
          {
            id: "pytest:all",
            name: "pytest",
            kind: "test",
            origin: "pytest",
          },
        ],
      });
    });
    await waitFor(() =>
      expect(view.getByTestId("tasks").textContent).toBe("npm:test"),
    );
  });

  it("M48 regression: a run dispatches the `run-started` document event (was `ide-run-started`, never fired)", async () => {
    // Mirrors IDE.tsx's M48 activity effect after the M53 fix.
    const activitySpy = vi.fn();
    function M48Listener() {
      React.useEffect(() => {
        const onStart = () => activitySpy("running");
        const onStop = () => activitySpy("restore");
        document.addEventListener("run-started", onStart);
        document.addEventListener("run-stopped", onStop);
        return () => {
          document.removeEventListener("run-started", onStart);
          document.removeEventListener("run-stopped", onStop);
        };
      }, []);
      return null;
    }
    render(
      <ExecutionSessionProvider projectId={project.id}>
        <M48Listener />
        <Output project={project} onRefreshTree={() => {}} />
      </ExecutionSessionProvider>,
    );

    const ws = await startRun();
    expect(activitySpy).toHaveBeenCalledWith("running");

    act(() =>
      ws.simulateMessage({
        type: "exit",
        result: { exitCode: 0, signal: null },
      }),
    );
    await waitFor(() => expect(activitySpy).toHaveBeenCalledWith("restore"));
  });

  it("runWorkflow sends a structured start frame without a command", async () => {
    function Probe() {
      const { runWorkflow } = useExecutionSession();
      return (
        <button
          type="button"
          onClick={() => runWorkflow({ taskId: "npm:test", targetPath: "a.js" })}
        >
          wf
        </button>
      );
    }
    const view = render(
      <ExecutionSessionProvider projectId={project.id}>
        <Probe />
      </ExecutionSessionProvider>,
    );
    fireEvent.click(view.getByText("wf"));
    await waitFor(() =>
      expect(FakeWebSocket.instances.length).toBeGreaterThan(0),
    );
    const ws = FakeWebSocket.latest();
    act(() => ws.simulateOpen());
    const start = ws.sent.map((m) => JSON.parse(m)).find((m) => m.type === "start");
    expect(start).toEqual({
      type: "start",
      workflow: { taskId: "npm:test", targetPath: "a.js" },
    });
    expect(start.command).toBeUndefined();
  });

  it("useExecutionSession() outside a provider throws", () => {
    function Bare() {
      useExecutionSession();
      return null;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow(/ExecutionSessionProvider/);
    spy.mockRestore();
  });

  it("the log buffer is capped at 2000 lines", async () => {
    function Probe() {
      const { logs } = useExecutionSession();
      return <div data-testid="count">{logs.length}</div>;
    }
    const view = render(
      <ExecutionSessionProvider projectId={project.id}>
        <Probe />
      </ExecutionSessionProvider>,
    );
    const ws = await startRun();

    act(() => {
      for (let i = 0; i < 2500; i++) {
        ws.simulateMessage({ type: "stdout", data: `l${i}\n` });
      }
    });

    await waitFor(() => {
      const n = Number(view.getByTestId("count").textContent);
      expect(n).toBe(2000);
    });
  });
});
