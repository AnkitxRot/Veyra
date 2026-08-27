import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import * as React from "react";
import type { Project } from "../src/types";

// M44 originally: IDE.tsx's ide-install listener did `setBottomTab("output")`
// then an immediate `dispatchEvent("ide-install-confirmed")`. React 18 batches
// the setState, so when Output.tsx (which owned the install listener) was not
// already mounted, the confirmed event fired into a DOM with nothing
// listening and the install silently never started. M44's fix was `flushSync`.
//
// M53 removes the whole class of bug: the install lifecycle moved out of
// <Output> into the always-mounted ExecutionSessionProvider, so the confirmed
// event always has a listener regardless of which bottom tab is showing (or
// whether <Output> is mounted at all). This test now asserts that M53
// guarantee — no flushSync required.

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

/**
 * Mirrors IDE.tsx's M53 shape: the ExecutionSessionProvider wraps everything
 * and is never unmounted by a bottom-tab change; <Output> is only mounted
 * while its tab is active. The ide-install handler switches the tab and
 * dispatches ide-install-confirmed with a plain setState (no flushSync).
 */
function MediatorHarness({
  project,
  mountOutput = true,
}: {
  project: Project;
  mountOutput?: boolean;
}) {
  const [bottomTab, setBottomTab] = React.useState<"output" | "problems">(
    "problems", // starts on a non-output tab, exactly like the real bug case
  );

  React.useEffect(() => {
    const handler = () => {
      setBottomTab("output"); // plain setState — M53 no longer needs flushSync
      document.dispatchEvent(new Event("ide-install-confirmed"));
    };
    document.addEventListener("ide-install", handler);
    return () => document.removeEventListener("ide-install", handler);
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

describe("M53 — ide-install reaches the execution session regardless of Output mount state", () => {
  const project: Project = { id: "proj-1", name: "My Project" };

  beforeEach(() => {
    apiMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("dispatching ide-install while Output is unmounted still starts the install (no flushSync)", async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(MediatorHarness, { project }));

    document.dispatchEvent(new Event("ide-install"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/proj-1/install",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("the install still starts even if <Output> never mounts at all — the session, not Output, owns it", async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(MediatorHarness, { project, mountOutput: false }),
    );

    document.dispatchEvent(new Event("ide-install-confirmed"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
