import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

// M68 — the project access-role fetch must FAIL CLOSED. A failed or in-flight
// `GET /api/projects/:id` role lookup must never leave the UI believing the
// user is owner/editor; it resolves to the read-only `viewer` state, stays
// visible as an error, and is explicitly retryable.

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
}));

import { useProjectRole } from "../src/hooks/useProjectRole";

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(cleanup);

/** A promise plus its resolve/reject handles, so a test controls fetch timing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useProjectRole", () => {
  it("does not fetch and reports viewer when there is no project", () => {
    const { result } = renderHook(() => useProjectRole(null));
    expect(apiMock).not.toHaveBeenCalled();
    expect(result.current.role).toBe("viewer");
    expect(result.current.status).toBe("idle");
  });

  it("is viewer + loading while the role fetch is in flight", async () => {
    const d = deferred<{ role: string }>();
    apiMock.mockReturnValueOnce(d.promise);
    const { result } = renderHook(() => useProjectRole("p1"));
    expect(apiMock).toHaveBeenCalledWith("/api/projects/p1");
    expect(result.current.role).toBe("viewer");
    expect(result.current.status).toBe("loading");
    await act(async () => {
      d.resolve({ role: "owner" });
    });
  });

  it("adopts the server role on a successful fetch", async () => {
    apiMock.mockResolvedValueOnce({ role: "editor" });
    const { result } = renderHook(() => useProjectRole("p1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.role).toBe("editor");
  });

  it("falls back to viewer and reports an error when the fetch fails", async () => {
    apiMock.mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useProjectRole("p1"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.role).toBe("viewer");
  });

  it("never yields owner or editor when the fetch fails", async () => {
    apiMock.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useProjectRole("p1"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.role).not.toBe("owner");
    expect(result.current.role).not.toBe("editor");
  });

  it("treats a role-less success response as viewer, not owner", async () => {
    apiMock.mockResolvedValueOnce({ project: {} });
    const { result } = renderHook(() => useProjectRole("p1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.role).toBe("viewer");
  });

  it("retry refetches and adopts the real role after a failure", async () => {
    apiMock.mockRejectedValueOnce(new Error("down"));
    const { result } = renderHook(() => useProjectRole("p1"));
    await waitFor(() => expect(result.current.status).toBe("error"));

    apiMock.mockResolvedValueOnce({ role: "owner" });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.role).toBe("owner");
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("retry is a no-op while a fetch is already in flight (one click, one request)", async () => {
    const d = deferred<{ role: string }>();
    apiMock.mockReturnValue(d.promise);
    const { result } = renderHook(() => useProjectRole("p1"));
    expect(result.current.status).toBe("loading");

    act(() => result.current.retry());
    act(() => result.current.retry());
    act(() => result.current.retry());
    expect(apiMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve({ role: "viewer" });
    });
  });

  it("ignores a stale in-flight response after the project id changes", async () => {
    const first = deferred<{ role: string }>();
    const second = deferred<{ role: string }>();
    apiMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useProjectRole(id),
      { initialProps: { id: "p1" } },
    );
    rerender({ id: "p2" });

    // p1's request resolves LATE with owner — it must not win.
    await act(async () => {
      first.resolve({ role: "owner" });
    });
    expect(result.current.role).toBe("viewer");

    await act(async () => {
      second.resolve({ role: "editor" });
    });
    expect(result.current.role).toBe("editor");
  });

  it("resets to viewer + loading when the project id changes", async () => {
    apiMock.mockResolvedValueOnce({ role: "owner" });
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useProjectRole(id),
      { initialProps: { id: "p1" as string | null } },
    );
    await waitFor(() => expect(result.current.role).toBe("owner"));

    const d = deferred<{ role: string }>();
    apiMock.mockReturnValueOnce(d.promise);
    rerender({ id: "p2" });
    expect(result.current.role).toBe("viewer");
    expect(result.current.status).toBe("loading");
    await act(async () => {
      d.resolve({ role: "editor" });
    });
  });
});
