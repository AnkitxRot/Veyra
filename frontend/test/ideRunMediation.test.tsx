import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import * as React from "react";
import { flushSync } from "react-dom";
import type { Project } from "../src/types";

// M45: live browser QA caught the exact same defect M44 already fixed for
// ide-install, this time in ide-run. IDE.tsx's ide-run listener did
// `setBottomTab("output")` then an immediate
// `document.dispatchEvent(new Event("ide-run-confirmed"))`. React 18
// batches that setState, so when Output.tsx wasn't already mounted (the
// user is on the Terminal or Problems tab — both live-reproduced), the
// confirmed event fired into a DOM where nothing was listening yet and the
// run silently never started. The dirty-file-save `await` loop above this
// in the real handler only masked it when there were actual unsaved
// changes. The real fix lives in IDE.tsx (wrapping the state update in
// flushSync, mirroring the ide-install fix exactly); this test reproduces
// the exact mechanism with the same minimal harness shape as
// ideInstallMediation.test.tsx, without needing to render the full IDE
// component tree.

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (path: string, projectId: string) =>
    `ws://test${path}?projectId=${projectId}`,
}));

import Output from "../src/components/Output/Output";

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
 * Minimal stand-in for IDE.tsx's own relevant slice: a bottomTab state that
 * conditionally mounts <Output>, plus an ide-run listener that must
 * guarantee Output is mounted (and its own ide-run-confirmed listener
 * registered) before the confirmed event is dispatched. `useFlushSync`
 * toggles between the buggy (pre-fix) and correct (post-fix) shape so the
 * same test body proves both that the bug was real and that the fix closes
 * it — exactly mirroring ideInstallMediation.test.tsx's harness.
 */
function MediatorHarness({
  project,
  useFlushSync,
}: {
  project: Project;
  useFlushSync: boolean;
}) {
  const [bottomTab, setBottomTab] = React.useState<"output" | "terminal">(
    "terminal", // starts on a non-output tab, exactly like the real bug case
  );

  React.useEffect(() => {
    const handler = () => {
      if (useFlushSync) {
        flushSync(() => {
          setBottomTab("output");
        });
      } else {
        setBottomTab("output");
      }
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
  }, [useFlushSync]);

  return (
    <div>
      {bottomTab === "output" && (
        <Output project={project} onRefreshTree={() => {}} />
      )}
    </div>
  );
}

describe("M45 regression — ide-run must reach Output even when it starts unmounted", () => {
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

  it("reproduces the pre-fix bug: without flushSync, dispatching ide-run while Output is unmounted never starts the run", async () => {
    render(
      React.createElement(MediatorHarness, {
        project,
        useFlushSync: false,
      }),
    );

    document.dispatchEvent(new Event("ide-run"));

    // Give any pending microtasks/effects a chance to run; the bug is that
    // nothing happens, not that something happens slowly.
    await new Promise((r) => setTimeout(r, 50));
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it("with flushSync (the real fix), dispatching ide-run while Output is unmounted still starts the run", async () => {
    render(
      React.createElement(MediatorHarness, {
        project,
        useFlushSync: true,
      }),
    );

    document.dispatchEvent(new Event("ide-run"));

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    expect(FakeWebSocket.latest().url).toBe(
      "ws://test/ws/execute?projectId=proj-1",
    );
  });
});
