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

// M50 — Safe workspace-wide Replace All.
//
// These tests exercise the REAL WorkspaceSearchModal (per-file selection,
// safety-snapshot toggle, diff, and the onReplaceApplied callback that is the
// actual fix for the silent-revert data-loss bug: before M50 the modal wrote
// files on disk and never told IDE.tsx, so an open Monaco buffer stayed stale
// and a later save reverted the change).
//
// The editor-buffer reconciliation is a thin slice of IDE.tsx; following the
// M45 precedent (ideRunMediation.test.tsx) it is reproduced here in a minimal
// <Harness> that mirrors IDE.tsx's handleReplaceApplied exactly — clean open
// buffers are refreshed, dirty buffers are left untouched and surfaced.

const apiMock = vi.fn();
vi.mock("../src/api", () => ({
  api: (...args: any[]) => apiMock(...args),
  getWebSocketUrl: (path: string, projectId: string) =>
    `ws://test${path}?projectId=${projectId}`,
}));

import { api } from "../src/api";
import WorkspaceSearchModal from "../src/components/Search/WorkspaceSearchModal";

const PROJECT: Project = { id: "p1", name: "proj" };

// Two matched files. app.py replaces "hello" -> "hi"; util.py the same.
function previewResponse() {
  return {
    applied: false,
    totalMatches: 3,
    filesSearched: 5,
    durationMs: 4,
    truncated: false,
    groups: [
      {
        filePath: "app.py",
        matches: [
          {
            filePath: "app.py",
            lineNumber: 1,
            column: 8,
            lineContent: "print('hello world')",
            matchLength: 5,
            replacedLineContent: "print('hi world')",
          },
          {
            filePath: "app.py",
            lineNumber: 2,
            column: 8,
            lineContent: "print('hello again')",
            matchLength: 5,
            replacedLineContent: "print('hi again')",
          },
        ],
      },
      {
        filePath: "util.py",
        matches: [
          {
            filePath: "util.py",
            lineNumber: 2,
            column: 12,
            lineContent: "    return 'hello team'",
            matchLength: 5,
            replacedLineContent: "    return 'hi team'",
          },
        ],
      },
    ],
  };
}

interface Captured {
  path: string;
  body: any;
}

function installApi(applyOverride?: (body: any) => any) {
  const calls: Captured[] = [];
  apiMock.mockImplementation(async (path: string, opts: any = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ path, body });
    if (path.endsWith("/search/replace")) {
      if (body.dryRun === false) {
        if (applyOverride) return applyOverride(body);
        const targets: string[] =
          body.files ?? previewResponse().groups.map((g: any) => g.filePath);
        return {
          applied: true,
          filesChanged: targets.length,
          matchesReplaced: targets.length,
          truncated: false,
          snapshotId: body.createSafetySnapshot ? "snap-123" : null,
          results: targets.map((f) => ({
            filePath: f,
            status: "replaced",
            matchCount: 1,
          })),
        };
      }
      return previewResponse();
    }
    if (path.includes("/file?path=")) {
      // authoritative post-replace content used by the reconciliation slice
      return { content: "REPLACED-ON-DISK" };
    }
    return {};
  });
  return calls;
}

async function openReplacePreview() {
  render(
    React.createElement(WorkspaceSearchModal, {
      isOpen: true,
      onClose: vi.fn(),
      project: PROJECT,
      onSelectResult: vi.fn(),
    }),
  );
  fireEvent.change(screen.getByPlaceholderText("Search text in files..."), {
    target: { value: "hello" },
  });
  fireEvent.click(screen.getByTitle("Toggle Replace"));
  await screen.findByText(/of 3 matches selected/i);
}

beforeEach(() => {
  apiMock.mockReset();
});
afterEach(() => cleanup());

describe("WorkspaceSearchModal — M50 selection, snapshot & diff", () => {
  it("shows a per-file checkbox and a -/+ diff for each match in replace mode", async () => {
    installApi();
    await openReplacePreview();

    expect(screen.getByLabelText("Include app.py in Replace All")).toBeTruthy();
    expect(
      screen.getByLabelText("Include util.py in Replace All"),
    ).toBeTruthy();

    const diffs = screen.getAllByTestId("replace-diff");
    expect(diffs.length).toBe(3);
    expect(diffs[0].textContent).toContain("- print('hello world')");
    expect(diffs[0].textContent).toContain("+ print('hi world')");
  });

  it("collapses / expands a file's diff", async () => {
    installApi();
    await openReplacePreview();
    expect(screen.getAllByTestId("replace-diff").length).toBe(3);

    // toggle app.py collapsed
    fireEvent.click(screen.getByText("app.py"));
    await waitFor(() =>
      expect(screen.getAllByTestId("replace-diff").length).toBe(1),
    );
    fireEvent.click(screen.getByText("app.py"));
    await waitFor(() =>
      expect(screen.getAllByTestId("replace-diff").length).toBe(3),
    );
  });

  it("defaults the safety-snapshot toggle ON for an owner", async () => {
    installApi();
    await openReplacePreview();
    const cb = screen.getByRole("checkbox", {
      name: /safety snapshot/i,
    }) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(cb.disabled).toBe(false);
  });

  it("disables and unchecks the snapshot toggle for a non-owner editor", async () => {
    installApi();
    render(
      React.createElement(WorkspaceSearchModal, {
        isOpen: true,
        onClose: vi.fn(),
        project: PROJECT,
        projectRole: "editor",
        onSelectResult: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByPlaceholderText("Search text in files..."), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByTitle("Toggle Replace"));
    await screen.findByText(/of 3 matches selected/i);

    const cb = screen.getByRole("checkbox", {
      name: /safety snapshot/i,
    }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    expect(cb.disabled).toBe(true);
  });

  it("sends the selected files and createSafetySnapshot in the apply request", async () => {
    const calls = installApi();
    await openReplacePreview();

    // deselect util.py
    fireEvent.click(screen.getByLabelText("Include util.py in Replace All"));
    await screen.findByText(/2 of 3 matches selected/i);

    fireEvent.click(screen.getByRole("button", { name: /Replace Selected/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace files" }),
    );

    await waitFor(() => {
      const apply = calls.find((c) => c.body.dryRun === false);
      expect(apply).toBeTruthy();
      expect(apply!.body.files).toEqual(["app.py"]);
      expect(apply!.body.createSafetySnapshot).toBe(true);
    });
  });

  it("omits files[] when every file is still selected (server acts on the fresh match set)", async () => {
    const calls = installApi();
    await openReplacePreview();

    fireEvent.click(screen.getByRole("button", { name: /Replace All/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace files" }),
    );

    await waitFor(() => {
      const apply = calls.find((c) => c.body.dryRun === false);
      expect(apply).toBeTruthy();
      expect(apply!.body.files).toBeUndefined();
    });
  });

  it("can disable the safety snapshot before applying", async () => {
    const calls = installApi();
    await openReplacePreview();
    fireEvent.click(screen.getByRole("checkbox", { name: /safety snapshot/i }));

    fireEvent.click(screen.getByRole("button", { name: /Replace All/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace files" }),
    );

    await waitFor(() => {
      const apply = calls.find((c) => c.body.dryRun === false);
      expect(apply!.body.createSafetySnapshot).toBe(false);
    });
  });

  it("renders the snapshot-created state in the apply summary", async () => {
    installApi();
    await openReplacePreview();
    fireEvent.click(screen.getByRole("button", { name: /Replace All/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace files" }),
    );

    expect(
      await screen.findByText(/A safety snapshot was created/i),
    ).toBeTruthy();
  });

  it("shows a distinct collaborator-conflict summary (not the 'too large / truncated' skipped copy) when a file was held at a collaborator's version", async () => {
    installApi((body: any) => ({
      applied: true,
      filesChanged: 1,
      matchesReplaced: 1,
      truncated: false,
      snapshotId: body.createSafetySnapshot ? "snap-123" : null,
      results: [
        { filePath: "app.py", status: "replaced", matchCount: 1 },
        {
          filePath: "util.py",
          status: "conflict",
          matchCount: 1,
          reason:
            "a collaborator has unsaved changes in this file in the live session — their version was kept",
        },
      ],
    }));
    await openReplacePreview();
    fireEvent.click(screen.getByRole("button", { name: /Replace All/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace files" }),
    );

    const summary = await screen.findByText(
      /a collaborator has unsaved changes in the live session and their version was kept/i,
    );
    expect(summary).toBeTruthy();
    // Must NOT mislabel a conflict as the size/truncation skip reason.
    expect(
      screen.queryByText(/too large or results were truncated/i),
    ).toBeNull();
    // The replaced file is still reported as replaced.
    expect(screen.getByText(/Replaced 1 match across 1 file/i)).toBeTruthy();
  });

  it("emits onReplaceApplied with exactly the paths the server reported replaced", async () => {
    installApi(() => ({
      applied: true,
      filesChanged: 1,
      matchesReplaced: 2,
      truncated: false,
      snapshotId: "snap-123",
      results: [
        { filePath: "app.py", status: "replaced", matchCount: 2 },
        { filePath: "util.py", status: "skipped", matchCount: 1 },
      ],
    }));
    const onReplaceApplied = vi.fn();
    render(
      React.createElement(WorkspaceSearchModal, {
        isOpen: true,
        onClose: vi.fn(),
        project: PROJECT,
        onReplaceApplied,
        onSelectResult: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByPlaceholderText("Search text in files..."), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByTitle("Toggle Replace"));
    await screen.findByText(/of 3 matches selected/i);
    fireEvent.click(screen.getByRole("button", { name: /Replace All/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace files" }),
    );

    await waitFor(() =>
      expect(onReplaceApplied).toHaveBeenCalledWith(["app.py"]),
    );
  });

  it("does not call onReplaceApplied when nothing was replaced", async () => {
    installApi(() => ({
      applied: true,
      filesChanged: 0,
      matchesReplaced: 0,
      truncated: false,
      snapshotId: null,
      results: [{ filePath: "app.py", status: "skipped", matchCount: 2 }],
    }));
    const onReplaceApplied = vi.fn();
    render(
      React.createElement(WorkspaceSearchModal, {
        isOpen: true,
        onClose: vi.fn(),
        project: PROJECT,
        onReplaceApplied,
        onSelectResult: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByPlaceholderText("Search text in files..."), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByTitle("Toggle Replace"));
    await screen.findByText(/of 3 matches selected/i);
    fireEvent.click(screen.getByRole("button", { name: /Replace All/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace files" }),
    );

    await screen.findByText(/Replaced 0 matches/i);
    expect(onReplaceApplied).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Editor-buffer reconciliation slice.
//
// Harness mirrors IDE.tsx's handleReplaceApplied: for each replaced path that
// is currently open, a CLEAN buffer is refetched + updated, a DIRTY buffer is
// left untouched and named in a notice. This is the fix for the silent-revert
// bug — pre-M50 the modal had no onReplaceApplied prop at all, so this test's
// "reconciles" assertion fails against pre-fix code.
// ---------------------------------------------------------------------------

type Buf = { path: string; content: string; dirty?: boolean };

function Harness({ initial }: { initial: Buf[] }) {
  const [openFiles, setOpenFiles] = React.useState<Buf[]>(initial);
  const [notice, setNotice] = React.useState<string | null>(null);
  const openRef = React.useRef(openFiles);
  React.useEffect(() => {
    openRef.current = openFiles;
  }, [openFiles]);

  const onReplaceApplied = React.useCallback(async (changed: string[]) => {
    const open = openRef.current;
    const dirtySkipped: string[] = [];
    const toRefresh: string[] = [];
    for (const p of changed) {
      const f = open.find((o) => o.path === p);
      if (!f) continue;
      if (f.dirty) dirtySkipped.push(p);
      else toRefresh.push(p);
    }
    const fetched = new Map<string, string>();
    await Promise.all(
      toRefresh.map(async (p) => {
        const res = (await api(`/api/projects/p1/file?path=${p}`)) as {
          content: string;
        };
        fetched.set(p, res.content);
      }),
    );
    if (fetched.size > 0) {
      setOpenFiles((prev) =>
        prev.map((f) =>
          fetched.has(f.path) && !f.dirty
            ? { ...f, content: fetched.get(f.path)! }
            : f,
        ),
      );
    }
    if (dirtySkipped.length > 0) {
      setNotice(`unsaved changes left untouched: ${dirtySkipped.join(", ")}`);
    }
  }, []);

  return React.createElement(
    "div",
    null,
    React.createElement(
      "ul",
      { "data-testid": "buffers" },
      openFiles.map((f) =>
        React.createElement(
          "li",
          { key: f.path, "data-path": f.path },
          `${f.path}=${f.content}${f.dirty ? " (dirty)" : ""}`,
        ),
      ),
    ),
    notice && React.createElement("div", { role: "status" }, notice),
    React.createElement(WorkspaceSearchModal, {
      isOpen: true,
      onClose: vi.fn(),
      project: PROJECT,
      onReplaceApplied,
      onSelectResult: vi.fn(),
    }),
  );
}

async function driveReplace() {
  fireEvent.change(screen.getByPlaceholderText("Search text in files..."), {
    target: { value: "hello" },
  });
  fireEvent.click(screen.getByTitle("Toggle Replace"));
  await screen.findByText(/of 3 matches selected/i);
  fireEvent.click(screen.getByRole("button", { name: /Replace All/i }));
  fireEvent.click(await screen.findByRole("button", { name: "Replace files" }));
}

describe("M50 — open editor buffer reconciliation (silent-revert fix)", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });
  afterEach(() => cleanup());

  it("refreshes a clean open buffer to the on-disk replacement (was stale pre-fix)", async () => {
    installApi();
    render(
      React.createElement(Harness, {
        initial: [{ path: "app.py", content: "print('hello world')" }],
      }),
    );
    await driveReplace();

    await waitFor(() => {
      const li = screen
        .getByTestId("buffers")
        .querySelector('[data-path="app.py"]')!;
      expect(li.textContent).toBe("app.py=REPLACED-ON-DISK");
    });
  });

  it("refreshes a clean NON-active background buffer too", async () => {
    installApi();
    render(
      React.createElement(Harness, {
        initial: [
          { path: "main.py", content: "unrelated" },
          { path: "util.py", content: "    return 'hello team'" },
        ],
      }),
    );
    await driveReplace();

    await waitFor(() => {
      const li = screen
        .getByTestId("buffers")
        .querySelector('[data-path="util.py"]')!;
      expect(li.textContent).toBe("util.py=REPLACED-ON-DISK");
    });
  });

  it("never overwrites a dirty buffer and names it in a notice", async () => {
    installApi();
    render(
      React.createElement(Harness, {
        initial: [{ path: "app.py", content: "my unsaved edits", dirty: true }],
      }),
    );
    await driveReplace();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "unsaved changes left untouched: app.py",
      ),
    );
    const li = screen
      .getByTestId("buffers")
      .querySelector('[data-path="app.py"]')!;
    expect(li.textContent).toBe("app.py=my unsaved edits (dirty)");
  });

  it("does nothing for a replaced file that is not open", async () => {
    installApi();
    render(
      React.createElement(Harness, {
        initial: [{ path: "elsewhere.py", content: "keep me" }],
      }),
    );
    await driveReplace();
    // allow any async work to settle
    await new Promise((r) => setTimeout(r, 20));
    const li = screen
      .getByTestId("buffers")
      .querySelector('[data-path="elsewhere.py"]')!;
    expect(li.textContent).toBe("elsewhere.py=keep me");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
