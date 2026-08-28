import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import * as React from "react";

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (p: string, id: string) => `ws://test${p}?projectId=${id}`,
}));

import Preview from "../src/components/Preview/Preview";

const PROJECT = { id: "proj-1", name: "P" };

/** api() responder: `/preview/ports` returns `portsResult`, everything else {}. */
function installApi(portsResult: () => { ports: number[]; sandbox: boolean }) {
  const calls: string[] = [];
  apiMock.mockImplementation(async (path: string) => {
    calls.push(path);
    if (path.includes("/preview/ports")) return portsResult();
    return {};
  });
  return calls;
}

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Preview — auto-detection", () => {
  it("polls /preview/ports for the current project on mount", async () => {
    const calls = installApi(() => ({ ports: [], sandbox: true }));
    render(<Preview project={PROJECT} />);
    await waitFor(() =>
      expect(
        calls.some((c) => c === "/api/projects/proj-1/preview/ports"),
      ).toBe(true),
    );
  });

  it("sandbox up but no server → 'No running preview server detected'", async () => {
    installApi(() => ({ ports: [], sandbox: true }));
    render(<Preview project={PROJECT} />);
    expect(
      await screen.findByText(/No running preview server detected/i),
    ).toBeTruthy();
  });

  it("no sandbox → 'No sandbox running yet' guidance", async () => {
    installApi(() => ({ ports: [], sandbox: false }));
    render(<Preview project={PROJECT} />);
    expect(
      await screen.findByText(/No sandbox running yet/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Run your project .* to start its sandbox/i),
    ).toBeTruthy();
  });

  it("a detected allowed port is surfaced as an 'Open :<port>' action that loads the proxy", async () => {
    installApi(() => ({ ports: [5173], sandbox: true }));
    render(<Preview project={PROJECT} />);
    expect(await screen.findByText("Detected server on :5173")).toBeTruthy();

    const openBtn = screen.getByRole("button", { name: "Open :5173" });
    fireEvent.click(openBtn);

    const iframe = await screen.findByTitle("Sandbox Web Preview");
    expect(iframe.getAttribute("src")).toMatch(
      /^\/api\/projects\/proj-1\/proxy\/5173\/\?_t=\d+$/,
    );
  });

  it("multiple detected ports are offered in the order the server returned them (deterministic)", async () => {
    installApi(() => ({ ports: [3000, 5173, 8080], sandbox: true }));
    render(<Preview project={PROJECT} />);
    await screen.findByText("3 servers detected");
    const btns = screen
      .getAllByRole("button")
      .filter((b) => /^Open :\d+$/.test(b.textContent || ""))
      .map((b) => b.textContent);
    expect(btns).toEqual(["Open :3000", "Open :5173", "Open :8080"]);
  });

  it("manual port entry still works independently of detection", async () => {
    installApi(() => ({ ports: [], sandbox: true }));
    render(<Preview project={PROJECT} />);
    await screen.findByText(/No running preview server detected/i);

    fireEvent.change(screen.getByLabelText("Preview server port"), {
      target: { value: "8080" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    const iframe = await screen.findByTitle("Sandbox Web Preview");
    expect(iframe.getAttribute("src")).toMatch(
      /\/api\/projects\/proj-1\/proxy\/8080\//,
    );
  });

  it("a stopped server disappears from the detected list on the next poll", async () => {
    vi.useFakeTimers();
    let up = true;
    installApi(() => ({ ports: up ? [8000] : [], sandbox: true }));
    render(<Preview project={PROJECT} />);

    await vi.waitFor(() =>
      expect(screen.queryByText("Detected server on :8000")).toBeTruthy(),
    );

    up = false;
    await vi.advanceTimersByTimeAsync(4100); // one poll interval
    await vi.waitFor(() =>
      expect(screen.queryByText("Detected server on :8000")).toBeNull(),
    );
    expect(
      screen.getByText(/No running preview server detected/i),
    ).toBeTruthy();
  });

  it("Rescan triggers an immediate re-poll", async () => {
    const calls = installApi(() => ({ ports: [], sandbox: true }));
    render(<Preview project={PROJECT} />);
    await screen.findByText(/No running preview server detected/i);
    const before = calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it("an auth/network failure on the probe never crashes the panel (manual path stays usable)", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("/preview/ports")) {
        throw Object.assign(new Error("nope"), { status: 404 });
      }
      return {};
    });
    render(<Preview project={PROJECT} />);
    // still renders, manual entry present
    expect(await screen.findByLabelText("Preview server port")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go" })).toBeTruthy();
  });

  it("while a preview is open, a NOT RESPONDING flag appears after the port drops out for 2 polls, without tearing down the iframe", async () => {
    vi.useFakeTimers();
    let up = true;
    installApi(() => ({ ports: up ? [3000] : [], sandbox: true }));
    render(<Preview project={PROJECT} />);

    await vi.waitFor(() =>
      screen.getByRole("button", { name: "Open :3000" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open :3000" }));
    await vi.waitFor(() => screen.getByTitle("Sandbox Web Preview"));
    expect(screen.getByText("LIVE SANDBOX")).toBeTruthy();

    up = false;
    await vi.advanceTimersByTimeAsync(4100); // miss 1
    await vi.advanceTimersByTimeAsync(4100); // miss 2
    await vi.waitFor(() =>
      expect(screen.queryByText("NOT RESPONDING")).toBeTruthy(),
    );
    // iframe is still there — we don't rip out the user's preview
    expect(screen.getByTitle("Sandbox Web Preview")).toBeTruthy();
  });
});
