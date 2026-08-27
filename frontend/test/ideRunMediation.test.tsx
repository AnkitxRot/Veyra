import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import * as React from "react";
import type { Project } from "../src/types";

// M45 originally: IDE.tsx's ide-run listener did `setBottomTab("output")` then
// an immediate `dispatchEvent("ide-run-confirmed")`. React 18 batches the
// setState, so when Output.tsx (which owned the run WebSocket) was not already
// mounted (user on the Terminal/Problems tab), the confirmed event fired into
// a DOM with nothing listening and the run silently never started. M45's fix
// was `flushSync`.
//
// M53 removes the whole class of bug: the run lifecycle moved out of <Output>
// into the always-mounted ExecutionSessionProvider. The confirmed event always
// has a listener regardless of which bottom tab is showing (or whether
// <Output> is mounted at all). This test now asserts that M53 guarantee —
// no flushSync required.

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (path: string, projectId: string) =>
    `ws://test${path}?projectId=${projectId}`,
}));

import Output from "../src/components/Output/Output";
import { ExecutionSessionProvider } from "../src/hooks/useExecutionSession";

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

  static latest(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

/**
 * Mirrors IDE.tsx's M53 shape: the ExecutionSessionProvider wraps everything
 * and is never unmounted by a bottom-tab change; <Output> is only mounted
 * while its tab is active. The ide-run handler switches the tab and dispatches
 * ide-run-confirmed with a plain setState (no flushSync).
 */
function MediatorHarness({
  project,
  mountOutput = true,
}: {
  project: Project;
  mountOutput?: boolean;
}) {
  const [bottomTab, setBottomTab] = React.useState<"output" | "terminal">(
    "terminal", // starts on a non-output tab, exactly like the real bug case
  );

  React.useEffect(() => {
    const handler = () => {
      setBottomTab("output"); // plain setState — M53 no longer needs flushSync
      document.dispatchEvent(
        new CustomEvent("ide-run-confirmed", {
          detail: {
            language: "python",
            activeFile: "main.py",
            langDisplay: "Python",
          },
        }),
      );
    };
    document.addEventListener("ide-run", handler);
    return () => document.removeEventListener("ide-run", handler);
  }, []);

  return (
    <ExecutionSessionProvider projectId={project.id}>
      <div>
        {mountOutput && bottomTab === "output" && (
          <Output project={project} onRefreshTree={() => {}} />
        )}
      </div>
    </ExecutionSessionProvider>
  );
}

describe("M53 — ide-run reaches the execution session regardless of Output mount state", () => {
  const project: Project = { id: "proj-1", name: "My Project" };

  beforeEach(() => {
    apiMock.mockReset();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("dispatching ide-run while Output is unmounted still starts the run (no flushSync)", async () => {
    render(React.createElement(MediatorHarness, { project }));

    document.dispatchEvent(new Event("ide-run"));

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    expect(FakeWebSocket.latest().url).toBe(
      "ws://test/ws/execute?projectId=proj-1",
    );
  });

  it("the run still starts even if <Output> never mounts at all — the session, not Output, owns it", async () => {
    render(
      React.createElement(MediatorHarness, { project, mountOutput: false }),
    );

    document.dispatchEvent(
      new CustomEvent("ide-run-confirmed", {
        detail: { language: "python", activeFile: "main.py" },
      }),
    );

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  });
});
