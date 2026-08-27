import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import * as React from "react";
import { flushSync } from "react-dom";
import type { Project } from "../src/types";

// M44: live browser QA caught a real defect that none of the M43/M44
// component-level tests (which always dispatch ide-install-confirmed
// directly, bypassing IDE.tsx's mediation entirely) could have caught:
// IDE.tsx's ide-install listener did `setBottomTab("output")` then an
// immediate `document.dispatchEvent(new Event("ide-install-confirmed"))`.
// React 18 batches that setState, so when Output.tsx wasn't already
// mounted (e.g. the user is on the Problems tab — which every failing run
// with diagnostics auto-switches to, i.e. exactly the case M44's own
// "Install Dependencies" action fires from), the confirmed event fired
// into a DOM where nothing was listening yet and the install silently
// never started. The real fix lives in IDE.tsx (wrapping the state update
// in flushSync); this test reproduces the exact mechanism — a
// conditionally-mounted Output-like consumer behind a mediating "ide-x" ->
// "ide-x-confirmed" event, driven by a tab-switching state update — without
// needing to render the full multi-thousand-line IDE component tree.

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (path: string, projectId: string) =>
    `ws://test${path}?projectId=${projectId}`,
}));

import Output from "../src/components/Output/Output";

Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView || (() => {});

/**
 * Minimal stand-in for IDE.tsx's own relevant slice: a bottomTab state that
 * conditionally mounts <Output>, plus an ide-install listener that must
 * guarantee Output is mounted (and its own ide-install-confirmed listener
 * registered) before the confirmed event is dispatched. `useFlushSync`
 * toggles between the buggy (pre-fix) and correct (post-fix) shape so the
 * same test body proves both that the bug was real and that the fix closes
 * it.
 */
function MediatorHarness({
  project,
  useFlushSync,
}: {
  project: Project;
  useFlushSync: boolean;
}) {
  const [bottomTab, setBottomTab] = React.useState<"output" | "problems">(
    "problems", // starts on a non-output tab, exactly like the real bug case
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
      document.dispatchEvent(new Event("ide-install-confirmed"));
    };
    document.addEventListener("ide-install", handler);
    return () => document.removeEventListener("ide-install", handler);
  }, [useFlushSync]);

  return (
    <div>
      {bottomTab === "output" && (
        <Output project={project} onRefreshTree={() => {}} />
      )}
    </div>
  );
}

describe("M44 regression — ide-install must reach Output even when it starts unmounted", () => {
  const project: Project = { id: "proj-1", name: "My Project" };

  beforeEach(() => {
    apiMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reproduces the pre-fix bug: without flushSync, dispatching ide-install while Output is unmounted never starts the install", async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(MediatorHarness, {
        project,
        useFlushSync: false,
      }),
    );

    document.dispatchEvent(new Event("ide-install"));

    // Give any pending microtasks/effects a chance to run; the bug is that
    // nothing happens, not that something happens slowly.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with flushSync (the real fix), dispatching ide-install while Output is unmounted still starts the install", async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(MediatorHarness, {
        project,
        useFlushSync: true,
      }),
    );

    document.dispatchEvent(new Event("ide-install"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/proj-1/install",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });
});
