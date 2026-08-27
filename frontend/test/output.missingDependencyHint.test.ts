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

// jsdom does not implement Element.scrollIntoView; Output's own (unrelated,
// pre-existing) auto-scroll effect calls it on every log-console render —
// see output.installStream.test.ts for the same, more detailed note.
Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView || (() => {});

// A minimal controllable fake of the WebSocket the run effect constructs,
// giving tests precise control over open/message/close timing without a
// real socket. Static readyState constants matter — Output.tsx reads
// WebSocket.OPEN / WebSocket.CLOSED off the *global* constructor.
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

  static latest(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

describe("Output — Milestone 44 inline missing-dependency install hint", () => {
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

  async function runToExit(exitCode: number, stderr: string) {
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
    if (stderr) {
      ws.simulateMessage({ type: "stderr", data: stderr });
    }
    ws.simulateMessage({ type: "exit", result: { exitCode, signal: null } });
  }

  it("1. Python detection: ModuleNotFoundError produces a visible install affordance", async () => {
    const { getByText } = renderOutput();
    await runToExit(1, "ModuleNotFoundError: No module named 'requests'\n");
    await waitFor(() => expect(getByText("Install Dependencies")).toBeTruthy());
  });

  it("2. Node detection: 'Cannot find module' produces a visible install affordance", async () => {
    const { getByText } = renderOutput();
    await runToExit(1, "Error: Cannot find module 'express'\n");
    await waitFor(() => expect(getByText("Install Dependencies")).toBeTruthy());
  });

  it("3. false positive guard: a ZeroDivisionError does not produce the affordance", async () => {
    const { queryByText } = renderOutput();
    await runToExit(1, "ZeroDivisionError: division by zero\n");
    // Give the exit handler's synchronous setState a tick to land.
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    expect(queryByText("Install Dependencies")).toBeNull();
  });

  it("4. false positive guard: an unrelated Node runtime/syntax error does not produce the affordance", async () => {
    const { queryByText } = renderOutput();
    await runToExit(1, "SyntaxError: Unexpected token '}'\n");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    expect(queryByText("Install Dependencies")).toBeNull();
  });

  it("5. a successful run does not produce the affordance", async () => {
    const { queryByText } = renderOutput();
    await runToExit(0, "");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    expect(queryByText("Install Dependencies")).toBeNull();
  });

  it("6. clicking the affordance dispatches exactly one ide-install event", async () => {
    const { getByText } = renderOutput();
    await runToExit(1, "ModuleNotFoundError: No module named 'requests'\n");
    await waitFor(() => expect(getByText("Install Dependencies")).toBeTruthy());

    const listener = vi.fn();
    document.addEventListener("ide-install", listener);
    getByText("Install Dependencies").click();
    expect(listener).toHaveBeenCalledTimes(1);
    document.removeEventListener("ide-install", listener);
  });

  it("7. starting a new run clears the previous run's hint", async () => {
    const { getByText, queryByText } = renderOutput();
    await runToExit(1, "ModuleNotFoundError: No module named 'requests'\n");
    await waitFor(() => expect(getByText("Install Dependencies")).toBeTruthy());

    // A second run begins — even before it finishes, the stale hint from
    // the previous run must not still be showing.
    document.dispatchEvent(
      new CustomEvent("ide-run-confirmed", {
        detail: {
          language: "python",
          activeFile: "main.py",
          langDisplay: "Python",
        },
      }),
    );
    await waitFor(() => expect(queryByText("Install Dependencies")).toBeNull());
  });

  it("8. clicking the affordance starts the M43 install flow and the hint does not linger as a duplicate affordance", async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise(() => {
          /* never resolves — hold the install "in flight" for this assertion */
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getByText, queryAllByText } = renderOutput();
    await runToExit(1, "ModuleNotFoundError: No module named 'requests'\n");
    await waitFor(() => expect(getByText("Install Dependencies")).toBeTruthy());

    // In the real app, IDE.tsx mediates ide-install -> ide-install-confirmed
    // (ensuring the Output tab is visible) before Output's own M43 install
    // effect — the only thing under test here — ever sees it. IDE.tsx isn't
    // mounted in this Output-only test, so its mediation is simulated
    // directly; the click -> ide-install dispatch itself is already proven
    // by test 6 above.
    document.addEventListener(
      "ide-install",
      () => document.dispatchEvent(new Event("ide-install-confirmed")),
      { once: true },
    );
    getByText("Install Dependencies").click();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The hint is cleared the moment install begins (M43's own console
    // reset also wipes the log that held it) — no duplicate/second
    // affordance is ever rendered alongside the fresh "Installing..." log.
    await waitFor(() =>
      expect(queryAllByText("Install Dependencies").length).toBe(0),
    );
  });

  it("9. multiple missing-module lines in one run's output still produce exactly one affordance", async () => {
    const { getAllByText } = renderOutput();
    await runToExit(
      1,
      "ModuleNotFoundError: No module named 'six'\n" +
        "During handling of the above exception, another exception occurred:\n" +
        "ModuleNotFoundError: No module named 'six'\n",
    );
    await waitFor(() =>
      expect(getAllByText("Install Dependencies").length).toBe(1),
    );
  });

  it("10. the affordance does not alter or replace the existing traceback content", async () => {
    const { container, getByText } = renderOutput();
    await runToExit(1, "ModuleNotFoundError: No module named 'requests'\n");
    await waitFor(() => expect(getByText("Install Dependencies")).toBeTruthy());
    expect(container.textContent).toContain(
      "ModuleNotFoundError: No module named 'requests'",
    );
    expect(container.textContent).toContain("Process exited with code 1");
  });
});
