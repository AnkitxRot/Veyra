import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import * as React from "react";

// M68 — behavioural coverage for the tree load / retry wiring. IDE.tsx itself
// is not rendered in unit tests (see IDE.connectionVisibility.test.tsx); this
// reproduces its exact wiring — the REAL useNotices hook + NoticeStack, a
// mocked `api` — around a minimal surface, mirroring the ideXMediation
// convention. It proves the parts the source-string guards can't: a retry
// fires exactly one request, a successful retry clears the error, and a
// project switch mid-flight discards the stale project's tree.

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
}));

import { useNotices } from "../src/hooks/useNotices";
import NoticeStack from "../src/components/common/NoticeStack";
import { api } from "../src/api";

beforeEach(() => apiMock.mockReset());
afterEach(cleanup);

/** Mirrors IDE.tsx's `loadTree` + notice wiring, keyed by project id. */
function TreeLoader({ pid }: { pid: string }) {
  const { notices, notify, dismiss, dismissKey } = useNotices();
  const [treeStatus, setTreeStatus] = React.useState<
    "loading" | "ready" | "error"
  >("loading");
  const [tree, setTree] = React.useState<{ pid: string; files: string[] }>({
    pid: "",
    files: [],
  });
  const loadedForRef = React.useRef<string | null>(null);
  const loadingPidRef = React.useRef<string | null>(null);
  const genRef = React.useRef(0);
  const loadTreeRef = React.useRef<() => void>(() => {});

  const loadTree = React.useCallback(async () => {
    if (loadingPidRef.current === pid) return;
    const gen = ++genRef.current;
    loadingPidRef.current = pid;
    if (loadedForRef.current !== pid) setTreeStatus("loading");
    try {
      const res = await api<{ tree: string[] }>(`/api/projects/${pid}/tree`);
      if (gen !== genRef.current) return;
      setTree({ pid, files: res.tree });
      loadedForRef.current = pid;
      setTreeStatus("ready");
      dismissKey("tree-load");
    } catch {
      if (gen !== genRef.current) return;
      setTreeStatus("error");
      notify({
        kind: "error",
        text: "Couldn't load this project's files.",
        ttl: null,
        dedupeKey: "tree-load",
        role: "alert",
        actions: [{ label: "Retry", onClick: () => loadTreeRef.current() }],
      });
    } finally {
      if (gen === genRef.current && loadingPidRef.current === pid) {
        loadingPidRef.current = null;
      }
    }
  }, [pid, notify, dismissKey]);

  React.useEffect(() => {
    loadTreeRef.current = () => void loadTree();
  }, [loadTree]);
  React.useEffect(() => {
    void loadTree();
  }, [loadTree]);

  return (
    <div>
      <span data-testid="status">{treeStatus}</span>
      <span data-testid="tree">
        {tree.pid}:{tree.files.join(",")}
      </span>
      <NoticeStack
        notices={notices.filter((n) => n.surface === "stack")}
        onDismiss={dismiss}
      />
    </div>
  );
}

describe("M68 tree load / retry — behaviour", () => {
  it("shows a retryable error notice when the initial load fails", async () => {
    apiMock.mockRejectedValueOnce(new Error("network"));
    render(<TreeLoader pid="p1" />);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("error"),
    );
    expect(
      screen.getByText("Couldn't load this project's files."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a single Retry click fires exactly one more request and clears the error", async () => {
    apiMock.mockRejectedValueOnce(new Error("network"));
    render(<TreeLoader pid="p1" />);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("error"),
    );
    expect(apiMock).toHaveBeenCalledTimes(1);

    apiMock.mockResolvedValueOnce({ tree: ["a.py", "b.py"] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ready"),
    );
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("tree").textContent).toBe("p1:a.py,b.py");
    expect(
      screen.queryByText("Couldn't load this project's files."),
    ).toBeNull();
  });

  it("rapid double Retry clicks do not overlap into two requests", async () => {
    apiMock.mockRejectedValueOnce(new Error("network"));
    render(<TreeLoader pid="p1" />);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("error"),
    );

    let resolve!: (v: { tree: string[] }) => void;
    apiMock.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const btn = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(apiMock).toHaveBeenCalledTimes(2); // 1 initial + 1 retry, not 4

    resolve({ tree: [] });
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ready"),
    );
  });

  it("a project switch mid-flight discards the previous project's tree", async () => {
    let resolveP1!: (v: { tree: string[] }) => void;
    apiMock.mockReturnValueOnce(
      new Promise((r) => {
        resolveP1 = r;
      }),
    );
    const { rerender } = render(<TreeLoader pid="p1" />);

    // switch to p2 before p1's fetch resolves
    apiMock.mockResolvedValueOnce({ tree: ["p2.py"] });
    rerender(<TreeLoader pid="p2" />);
    await waitFor(() =>
      expect(screen.getByTestId("tree").textContent).toBe("p2:p2.py"),
    );

    // p1 resolves LATE — it must not overwrite p2's tree
    resolveP1({ tree: ["p1.py"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("tree").textContent).toBe("p2:p2.py");
  });
});
