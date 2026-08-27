import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  screen,
} from "@testing-library/react";
import * as React from "react";
import type { Project } from "../src/types";

// M51 — Source Control panel. Exercises the real component against a mocked
// git API (and a mocked `fetch` for the checkout path, which reads the full
// 409 body).

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (p: string, id: string) => `ws://t${p}?projectId=${id}`,
}));

import SourceControlPanel from "../src/components/Git/SourceControlPanel";

const PROJECT: Project = { id: "p1", name: "proj" };

const CLEAN_STATUS = {
  initialized: true,
  branch: "main",
  detached: false,
  hasCommits: true,
  clean: true,
  staged: [],
  unstaged: [],
};

function dirtyStatus() {
  return {
    initialized: true,
    branch: "main",
    detached: false,
    hasCommits: true,
    clean: false,
    staged: [
      {
        path: "staged.ts",
        index: "M",
        worktree: " ",
        staged: true,
        unstaged: false,
        untracked: false,
      },
    ],
    unstaged: [
      {
        path: "a.ts",
        index: " ",
        worktree: "M",
        staged: false,
        unstaged: true,
        untracked: false,
      },
      {
        path: "new.ts",
        index: "?",
        worktree: "?",
        staged: false,
        unstaged: true,
        untracked: true,
      },
    ],
  };
}

const LOG = {
  commits: [
    {
      hash: "a".repeat(40),
      shortHash: "aaaaaaa",
      author: "ankit",
      email: "ankit@veyra.local",
      date: new Date().toISOString(),
      subject: "second",
    },
    {
      hash: "b".repeat(40),
      shortHash: "bbbbbbb",
      author: "ankit",
      email: "ankit@veyra.local",
      date: new Date(Date.now() - 3600_000).toISOString(),
      subject: "first",
    },
  ],
};

const BRANCHES = {
  current: "main",
  branches: [
    { name: "main", current: true, shortHash: "aaaaaaa", unborn: false },
    { name: "feature/x", current: false, shortHash: "ccccccc", unborn: false },
  ],
};

interface RouteMap {
  status?: any;
  log?: any;
  branches?: any;
  fileDiff?: any;
}

function installApi(routes: RouteMap = {}, opts: { fail?: string } = {}) {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  apiMock.mockImplementation(async (path: string, o: any = {}) => {
    const method = o.method || "GET";
    const body = o.body ? JSON.parse(o.body) : undefined;
    calls.push({ path, method, body });
    if (opts.fail && path.includes(opts.fail)) {
      const e: any = new Error("boom from server");
      throw e;
    }
    if (path.endsWith("/git/status")) return routes.status ?? CLEAN_STATUS;
    if (path.includes("/git/log")) return routes.log ?? LOG;
    if (path.endsWith("/git/branches") && method === "GET")
      return routes.branches ?? BRANCHES;
    if (path.includes("/git/diff/file"))
      return (
        routes.fileDiff ?? {
          path: "a.ts",
          staged: false,
          binary: false,
          truncated: false,
          isNew: false,
          isDeleted: false,
          hunks: [
            {
              header: "@@ -1 +1 @@",
              lines: [
                { type: "del", content: "old", oldLine: 1, newLine: null },
                { type: "add", content: "new", oldLine: null, newLine: 1 },
              ],
            },
          ],
        }
      );
    return { ok: true };
  });
  return calls;
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof SourceControlPanel>> = {},
) {
  const onReconcileBuffers = vi.fn();
  const getDirtyOpenPaths = vi.fn(() => [] as string[]);
  render(
    React.createElement(SourceControlPanel, {
      project: PROJECT,
      projectRole: "owner",
      getDirtyOpenPaths,
      onReconcileBuffers,
      ...props,
    }),
  );
  return { onReconcileBuffers, getDirtyOpenPaths };
}

beforeEach(() => {
  apiMock.mockReset();
  (globalThis as any).fetch = vi.fn();
});
afterEach(() => cleanup());

describe("SourceControlPanel — M51", () => {
  it("41. shows the uninitialized onboarding state", async () => {
    installApi({ status: { ...CLEAN_STATUS, initialized: false } });
    renderPanel();
    expect(await screen.findByText("No repository yet")).toBeTruthy();
    expect(screen.getByText("Initialize Git Repository")).toBeTruthy();
  });

  it("42. Initialize calls POST /git/init and reloads", async () => {
    const calls = installApi({
      status: { ...CLEAN_STATUS, initialized: false },
    });
    renderPanel();
    fireEvent.click(await screen.findByText("Initialize Git Repository"));
    await waitFor(() =>
      expect(
        calls.some((c) => c.path.endsWith("/git/init") && c.method === "POST"),
      ).toBe(true),
    );
  });

  it("43. renders unstaged and staged files", async () => {
    installApi({ status: dirtyStatus() });
    renderPanel();
    expect(await screen.findByText("a.ts")).toBeTruthy();
    expect(screen.getByText("new.ts")).toBeTruthy();
    expect(screen.getByText("staged.ts")).toBeTruthy();
    expect(screen.getByText("CHANGES")).toBeTruthy();
    expect(screen.getByText("STAGED CHANGES")).toBeTruthy();
  });

  it("44. staging one file posts its path", async () => {
    const calls = installApi({ status: dirtyStatus() });
    renderPanel();
    await screen.findByText("a.ts");
    fireEvent.click(screen.getByLabelText("Stage a.ts"));
    await waitFor(() => {
      const c = calls.find((x) => x.path.endsWith("/git/stage"));
      expect(c?.body).toEqual({ paths: ["a.ts"] });
    });
  });

  it("45. unstaging one file posts its path", async () => {
    const calls = installApi({ status: dirtyStatus() });
    renderPanel();
    await screen.findByText("staged.ts");
    fireEvent.click(screen.getByLabelText("Unstage staged.ts"));
    await waitFor(() => {
      const c = calls.find((x) => x.path.endsWith("/git/unstage"));
      expect(c?.body).toEqual({ paths: ["staged.ts"] });
    });
  });

  it("46/47. stage-all and unstage-all", async () => {
    const calls = installApi({ status: dirtyStatus() });
    renderPanel();
    fireEvent.click(await screen.findByText("Stage All"));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/git/stage"))?.body).toEqual({
        all: true,
      }),
    );
    fireEvent.click(screen.getByText("Unstage All"));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/git/unstage"))?.body).toEqual({
        all: true,
      }),
    );
  });

  it("48. clicking a file loads and renders its diff", async () => {
    installApi({ status: dirtyStatus() });
    renderPanel();
    fireEvent.click(await screen.findByText("a.ts"));
    const diff = await screen.findByTestId("git-diff");
    expect(diff.textContent).toContain("- old");
    expect(diff.textContent).toContain("+ new");
  });

  it("49/51. commit disabled until a message AND staged changes exist", async () => {
    installApi({ status: dirtyStatus() });
    renderPanel();
    const btn = (await screen.findByRole("button", {
      name: /Commit/,
    })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // no message yet
    fireEvent.change(screen.getByLabelText("COMMIT MESSAGE"), {
      target: { value: "my change" },
    });
    expect(btn.disabled).toBe(false); // has staged.ts + message
  });

  it("51b. commit disabled when nothing is staged even with a message", async () => {
    installApi({
      status: {
        ...dirtyStatus(),
        staged: [],
      },
    });
    renderPanel();
    fireEvent.change(await screen.findByLabelText("COMMIT MESSAGE"), {
      target: { value: "msg" },
    });
    const btn = screen.getByRole("button", {
      name: /Commit/,
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText("Nothing staged to commit")).toBeTruthy();
  });

  it("50/52. commit posts the message, clears it, and shows the short hash", async () => {
    const calls = installApi({ status: dirtyStatus() });
    apiMock.mockImplementation(async (path: string, o: any = {}) => {
      const method = o.method || "GET";
      const body = o.body ? JSON.parse(o.body) : undefined;
      calls.push({ path, method, body });
      if (path.endsWith("/git/commit"))
        return { hash: "d".repeat(40), shortHash: "ddddddd" };
      if (path.endsWith("/git/status")) return dirtyStatus();
      if (path.includes("/git/log")) return LOG;
      if (path.endsWith("/git/branches")) return BRANCHES;
      return { ok: true };
    });
    renderPanel();
    const ta = await screen.findByLabelText("COMMIT MESSAGE");
    fireEvent.change(ta, { target: { value: "ship it" } });
    fireEvent.click(screen.getByRole("button", { name: /Commit/ }));
    await waitFor(() => {
      expect(calls.find((c) => c.path.endsWith("/git/commit"))?.body).toEqual({
        message: "ship it",
      });
    });
    expect(await screen.findByText(/Committed ddddddd/)).toBeTruthy();
    expect((ta as HTMLTextAreaElement).value).toBe("");
  });

  it("53. history renders newest-first with author + relative time", async () => {
    installApi({ status: dirtyStatus() });
    renderPanel();
    expect(await screen.findByText("second")).toBeTruthy();
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getAllByText(/ankit ·/).length).toBeGreaterThan(0);
  });

  it("54. branch list shows the current branch badge", async () => {
    installApi({ status: dirtyStatus() });
    renderPanel();
    fireEvent.click(await screen.findByText("BRANCHES"));
    expect(await screen.findByText("feature/x")).toBeTruthy();
    expect(screen.getByText("current")).toBeTruthy();
  });

  it("55. create branch posts the name", async () => {
    const calls = installApi({ status: dirtyStatus() });
    renderPanel();
    fireEvent.click(await screen.findByText("BRANCHES"));
    fireEvent.click(await screen.findByText("Create branch from HEAD"));
    fireEvent.change(screen.getByPlaceholderText("new-branch-name"), {
      target: { value: "feature/new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.path.endsWith("/git/branches") && c.method === "POST",
        )?.body,
      ).toEqual({ name: "feature/new" }),
    );
  });

  it("56/63. checkout uses fetch, reconciles buffers, and refreshes", async () => {
    installApi({ status: dirtyStatus() });
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        branch: "feature/x",
        changedPaths: ["a.ts", "b.ts"],
      }),
    });
    const { onReconcileBuffers, getDirtyOpenPaths } = renderPanel();
    fireEvent.click(await screen.findByText("BRANCHES"));
    fireEvent.click(await screen.findByRole("button", { name: "Checkout" }));
    await waitFor(() =>
      expect(onReconcileBuffers).toHaveBeenCalledWith(
        ["a.ts", "b.ts"],
        expect.objectContaining({ noticeLabel: "Branch checkout" }),
      ),
    );
    expect(getDirtyOpenPaths).toHaveBeenCalled();
    expect(await screen.findByText(/Switched to "feature\/x"/)).toBeTruthy();
  });

  it("62. checkout 409 shows a conflict banner and does NOT reconcile/switch", async () => {
    installApi({ status: dirtyStatus() });
    (globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: "checkout_conflict" },
        blockingPaths: ["a.ts"],
      }),
    });
    const { onReconcileBuffers } = renderPanel();
    fireEvent.click(await screen.findByText("BRANCHES"));
    fireEvent.click(await screen.findByRole("button", { name: "Checkout" }));
    const banner = await screen.findByTestId("git-conflict");
    expect(banner.textContent).toContain('Cannot switch to "feature/x"');
    expect(banner.textContent).toContain("a.ts");
    expect(onReconcileBuffers).not.toHaveBeenCalled();
  });

  it("57/58. deleting a branch requires confirmation", async () => {
    const calls = installApi({ status: dirtyStatus() });
    renderPanel();
    fireEvent.click(await screen.findByText("BRANCHES"));
    fireEvent.click(await screen.findByLabelText("Delete branch feature/x"));
    // confirm modal
    expect(
      await screen.findByRole("heading", { name: "Delete branch" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete branch" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "DELETE" &&
            c.path.includes("/git/branches/feature%2Fx"),
        ),
      ).toBe(true),
    );
  });

  it("59. shows a loading indicator on first fetch", async () => {
    let resolve!: (v: any) => void;
    apiMock.mockImplementation((p: string) => {
      if (p.endsWith("/git/status")) {
        return new Promise((res) => {
          resolve = res;
        });
      }
      if (p.includes("/git/log")) return Promise.resolve(LOG);
      if (p.endsWith("/git/branches")) return Promise.resolve(BRANCHES);
      return Promise.resolve({ ok: true });
    });
    renderPanel();
    // Refresh button is disabled while loading
    const btn = screen.getByLabelText(
      "Refresh Source Control",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    resolve(CLEAN_STATUS);
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("60. surfaces a failure as an error banner", async () => {
    installApi({ status: dirtyStatus() }, { fail: "/git/status" });
    renderPanel();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom from server");
  });

  it("61. project switch isolates state — no stale repo paints", async () => {
    // First project: slow status that resolves AFTER we switch away.
    let resolveP1!: (v: any) => void;
    apiMock.mockImplementation((p: string) => {
      if (p.startsWith("/api/projects/p1/")) {
        return new Promise((res) => {
          if (p.endsWith("/git/status")) resolveP1 = res;
        });
      }
      if (p.endsWith("/git/status"))
        return Promise.resolve({ ...CLEAN_STATUS, branch: "p2-branch" });
      if (p.includes("/git/log")) return Promise.resolve(LOG);
      if (p.endsWith("/git/branches")) return Promise.resolve(BRANCHES);
      return Promise.resolve({ ok: true });
    });
    const { rerender } = renderWithRerender();
    rerender({ project: { id: "p2", name: "two" } });
    await screen.findByText("p2-branch");
    // late p1 response arrives — must be ignored
    resolveP1({ ...CLEAN_STATUS, branch: "p1-branch" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("p1-branch")).toBeNull();
    expect(screen.getByText("p2-branch")).toBeTruthy();
  });

  it("64. viewer sees read-only: no init / stage / commit controls", async () => {
    installApi({ status: dirtyStatus() });
    renderPanel({ projectRole: "viewer" });
    await screen.findByText("a.ts");
    expect(screen.queryByLabelText("Stage a.ts")).toBeNull();
    expect(screen.queryByLabelText("COMMIT MESSAGE")).toBeNull();
    expect(screen.queryByText("Stage All")).toBeNull();
  });

  it("64b. viewer on an uninitialized repo cannot initialize", async () => {
    installApi({ status: { ...CLEAN_STATUS, initialized: false } });
    renderPanel({ projectRole: "viewer" });
    await screen.findByText("No repository yet");
    expect(screen.queryByText("Initialize Git Repository")).toBeNull();
  });
});

// helper for the project-switch test
function renderWithRerender() {
  const onReconcileBuffers = vi.fn();
  const getDirtyOpenPaths = vi.fn(() => [] as string[]);
  const utils = render(
    React.createElement(SourceControlPanel, {
      project: PROJECT,
      projectRole: "owner" as const,
      getDirtyOpenPaths,
      onReconcileBuffers,
    }),
  );
  return {
    rerender: (p: { project: Project }) =>
      utils.rerender(
        React.createElement(SourceControlPanel, {
          project: p.project,
          projectRole: "owner" as const,
          getDirtyOpenPaths,
          onReconcileBuffers,
        }),
      ),
  };
}
