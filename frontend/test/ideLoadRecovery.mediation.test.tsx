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
// fires exactly one request, and a successful retry clears the error.

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
}));

import { useNotices } from "../src/hooks/useNotices";
import NoticeStack from "../src/components/common/NoticeStack";
import { api } from "../src/api";

beforeEach(() => apiMock.mockReset());
afterEach(cleanup);

/** Mirrors IDE.tsx's `loadTree` + notice wiring. */
function TreeLoader() {
  const { notices, notify, dismiss, dismissKey } = useNotices();
  const [treeStatus, setTreeStatus] = React.useState<
    "loading" | "ready" | "error"
  >("loading");
  const [fileCount, setFileCount] = React.useState(0);
  const loadedRef = React.useRef(false);
  const inFlightRef = React.useRef(false);
  const loadTreeRef = React.useRef<() => void>(() => {});

  const loadTree = React.useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (!loadedRef.current) setTreeStatus("loading");
    try {
      const res = await api<{ tree: string[] }>("/api/projects/p1/tree");
      setFileCount(res.tree.length);
      loadedRef.current = true;
      setTreeStatus("ready");
      dismissKey("tree-load");
    } catch {
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
      inFlightRef.current = false;
    }
  }, [notify, dismissKey]);

  React.useEffect(() => {
    loadTreeRef.current = () => void loadTree();
  }, [loadTree]);
  React.useEffect(() => {
    void loadTree();
  }, [loadTree]);

  return (
    <div>
      <span data-testid="status">{treeStatus}</span>
      <span data-testid="count">{fileCount}</span>
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
    render(<TreeLoader />);
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
    render(<TreeLoader />);
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
    expect(screen.getByTestId("count").textContent).toBe("2");
    // the standing error notice is gone
    expect(
      screen.queryByText("Couldn't load this project's files."),
    ).toBeNull();
  });

  it("rapid double Retry clicks do not overlap into two requests", async () => {
    apiMock.mockRejectedValueOnce(new Error("network"));
    render(<TreeLoader />);
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
});
