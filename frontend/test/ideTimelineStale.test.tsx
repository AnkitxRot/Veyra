import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import * as React from "react";

// M68 hardening — a slow initial Team-Activity timeline fetch for project A
// must not merge its events into project B's timeline when the user switches
// projects mid-flight. IDE.tsx is not rendered in unit tests; this mirrors
// the `fetch the initial timeline page` effect + the project-switch reset
// around a minimal surface (ideXMediation convention).

const fetchTimelineMock = vi.fn();
vi.mock("../src/api", () => ({
  fetchCollabTimeline: (...a: any[]) => fetchTimelineMock(...a),
}));
import { fetchCollabTimeline } from "../src/api";

beforeEach(() => fetchTimelineMock.mockReset());
afterEach(cleanup);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Mirrors IDE.tsx's timeline initial-load effect + per-project reset. */
function TimelineHarness({ pid }: { pid: string }) {
  const [timeline, setTimeline] = React.useState<{ id: string }[]>([]);
  const [timelineLoaded, setTimelineLoaded] = React.useState(false);
  // render-time mirror of the currently-open project (IDE: activeProjectIdRef)
  const activeProjectIdRef = React.useRef<string | null>(null);
  activeProjectIdRef.current = pid;

  // per-project reset (IDE: the collab lifecycle effect top)
  const seenPidRef = React.useRef<string | null>(null);
  if (seenPidRef.current !== pid) {
    seenPidRef.current = pid;
  }
  React.useEffect(() => {
    setTimeline([]);
    setTimelineLoaded(false);
  }, [pid]);

  React.useEffect(() => {
    if (timelineLoaded) return;
    const p = pid;
    setTimelineLoaded(true);
    void fetchCollabTimeline(p, { limit: 40 }).then((r: any) => {
      if (p !== activeProjectIdRef.current) return;
      setTimeline((prev) => [...prev, ...r.events]);
    });
  }, [pid, timelineLoaded]);

  return <span data-testid="tl">{timeline.map((e) => e.id).join(",")}</span>;
}

describe("M68 — timeline initial load does not leak across a project switch", () => {
  it("merges the initial page for the open project", async () => {
    fetchTimelineMock.mockResolvedValueOnce({
      events: [{ id: "a1" }],
      nextBefore: null,
    });
    render(<TimelineHarness pid="A" />);
    await waitFor(() =>
      expect(screen.getByTestId("tl").textContent).toBe("a1"),
    );
  });

  it("discards a slow project-A page that resolves after a switch to B", async () => {
    const a = deferred<any>();
    fetchTimelineMock.mockReturnValueOnce(a.promise); // A: slow
    fetchTimelineMock.mockResolvedValueOnce({
      events: [{ id: "b1" }],
      nextBefore: null,
    }); // B: fast

    const { rerender } = render(<TimelineHarness pid="A" />);
    rerender(<TimelineHarness pid="B" />);
    await waitFor(() =>
      expect(screen.getByTestId("tl").textContent).toBe("b1"),
    );

    // A resolves LATE — its events must not appear under B
    a.resolve({ events: [{ id: "STALE-A" }], nextBefore: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("tl").textContent).toBe("b1");
  });
});
