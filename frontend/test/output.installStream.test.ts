import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import * as React from "react";
import type { Project } from "../src/types";

// Output.tsx also imports `api` (used for run history / snapshots loading,
// neither of which is exercised by these install-focused tests) — mocked
// defensively so no stray real fetches happen via that path.
const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (path: string, projectId: string) =>
    `ws://test${path}?projectId=${projectId}`,
}));

import Output from "../src/components/Output/Output";
// M53: the install lifecycle now lives in the always-mounted execution
// session, not Output. These tests still drive everything via document
// events and assert Output's DOM — only the render wrapper changed, and the
// mid-stream "unmount" step now tears down the provider (the real teardown
// boundary) rather than Output.
import { ExecutionSessionProvider } from "../src/hooks/useExecutionSession";

// jsdom does not implement Element.scrollIntoView; Output's own (unrelated,
// pre-existing) auto-scroll effect calls it on every log-console render.
// This is a test-environment gap, not a component bug — a real browser has
// this method — so it's polyfilled here rather than touched in production
// code.
Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView || (() => {});

// A controllable fake ReadableStreamDefaultReader: read() resolves in the
// order push()/close() are called, or immediately if a value was already
// pushed before read() was awaited — giving tests precise control over
// when each chunk becomes visible, rather than fighting real stream timing.
function makeGatedReader() {
  const queue: Array<{ done: boolean; value?: Uint8Array }> = [];
  const waiters: Array<(v: { done: boolean; value?: Uint8Array }) => void> = [];
  return {
    reader: {
      read: () =>
        new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
          if (queue.length > 0) resolve(queue.shift()!);
          else waiters.push(resolve);
        }),
      cancel: vi.fn(async () => {}),
    },
    push(value: Uint8Array) {
      const item = { done: false, value };
      if (waiters.length > 0) waiters.shift()!(item);
      else queue.push(item);
    },
    close() {
      const item = { done: true, value: undefined };
      if (waiters.length > 0) waiters.shift()!(item);
      else queue.push(item);
    },
  };
}

function makeResponse(
  reader: ReturnType<typeof makeGatedReader>["reader"],
  opts: { ok?: boolean; status?: number } = {},
) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body: { getReader: () => reader },
    text: async () => "",
  };
}

describe("Output — Milestone 43 dependency-install stream", () => {
  const project: Project = { id: "proj-1", name: "My Project" };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    apiMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderOutput() {
    return render(
      React.createElement(
        ExecutionSessionProvider,
        { projectId: "proj-1" },
        React.createElement(Output, { project, onRefreshTree: vi.fn() }),
      ),
    );
  }

  it("1. dispatching ide-install-confirmed POSTs to the install endpoint with credentials included", async () => {
    const { close, reader } = makeGatedReader();
    fetchMock.mockResolvedValueOnce(makeResponse(reader));
    renderOutput();

    document.dispatchEvent(new Event("ide-install-confirmed"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/proj-1/install",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );

    close();
  });

  it("2. streams chunks incrementally — the first chunk renders before the second is delivered", async () => {
    const { push, close, reader } = makeGatedReader();
    fetchMock.mockResolvedValueOnce(makeResponse(reader));
    const { container } = renderOutput();

    document.dispatchEvent(new Event("ide-install-confirmed"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const encoder = new TextEncoder();
    push(encoder.encode("Collecting requests...\n"));

    await waitFor(() =>
      expect(container.textContent).toContain("Collecting requests..."),
    );
    // Second chunk must NOT already be present — proves the first chunk was
    // rendered as its own incremental update, not buffered alongside later
    // output until the stream finished.
    expect(container.textContent).not.toContain("Successfully installed");

    push(encoder.encode("Successfully installed requests-2.31.0\n"));
    await waitFor(() =>
      expect(container.textContent).toContain(
        "Successfully installed requests-2.31.0",
      ),
    );

    close();
    await waitFor(() =>
      expect(container.textContent).toContain("Install Complete"),
    );
  });

  it("3. finalizes a multibyte UTF-8 sequence split across chunk boundaries", async () => {
    const { push, close, reader } = makeGatedReader();
    fetchMock.mockResolvedValueOnce(makeResponse(reader));
    const { container } = renderOutput();

    document.dispatchEvent(new Event("ide-install-confirmed"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // "café" — the é (U+00E9) encodes as the two bytes 0xC3 0xA9; split the
    // encoded buffer so each half arrives in a separate chunk.
    const full = new TextEncoder().encode("café installed\n");
    const splitAt = 4; // "caf" + first byte of the 2-byte é sequence
    push(full.slice(0, splitAt));
    push(full.slice(splitAt));
    close();

    await waitFor(() =>
      expect(container.textContent).toContain("café installed"),
    );
  });

  it("4. on success, flushes pending output and returns install state to idle", async () => {
    const { push, close, reader } = makeGatedReader();
    fetchMock.mockResolvedValueOnce(makeResponse(reader));
    const { container } = renderOutput();

    const stopSpy = vi.fn();
    document.addEventListener("install-stopped", stopSpy);

    document.dispatchEvent(new Event("ide-install-confirmed"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    push(new TextEncoder().encode("done\n"));
    close();

    await waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));
    expect(container.textContent).toContain("Install Complete");

    document.removeEventListener("install-stopped", stopSpy);
  });

  it("5. a non-2xx response surfaces a visible error and resets install state", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      body: null,
      text: async () => "pip: command not found",
    });
    const { container } = renderOutput();

    const stopSpy = vi.fn();
    document.addEventListener("install-stopped", stopSpy);

    document.dispatchEvent(new Event("ide-install-confirmed"));

    await waitFor(() =>
      expect(container.textContent).toContain("pip: command not found"),
    );
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Install Failed");

    document.removeEventListener("install-stopped", stopSpy);
  });

  it("6. a network/fetch rejection surfaces a visible error and does not leave a stuck busy state", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { container } = renderOutput();

    const stopSpy = vi.fn();
    document.addEventListener("install-stopped", stopSpy);

    document.dispatchEvent(new Event("ide-install-confirmed"));

    await waitFor(() =>
      expect(container.textContent).toContain("Failed to fetch"),
    );
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Install Failed");

    document.removeEventListener("install-stopped", stopSpy);
  });

  it("9. a second ide-install-confirmed while one is already in flight does not trigger a second request", async () => {
    const { close, reader } = makeGatedReader();
    fetchMock.mockResolvedValueOnce(makeResponse(reader));
    renderOutput();

    document.dispatchEvent(new Event("ide-install-confirmed"));
    document.dispatchEvent(new Event("ide-install-confirmed"));
    document.dispatchEvent(new Event("ide-install-confirmed"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    close();
  });

  it("cancels the in-flight reader and aborts the request on unmount mid-stream, without a stuck busy state", async () => {
    const { reader } = makeGatedReader();
    fetchMock.mockResolvedValueOnce(makeResponse(reader));
    const { unmount } = renderOutput();

    const stopSpy = vi.fn();
    document.addEventListener("install-stopped", stopSpy);

    document.dispatchEvent(new Event("ide-install-confirmed"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    unmount();

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    // Cleanup itself resets the mirrored busy state since the async
    // handler's own finally intentionally skips it post-unmount.
    expect(stopSpy).toHaveBeenCalledTimes(1);

    document.removeEventListener("install-stopped", stopSpy);
  });
});
