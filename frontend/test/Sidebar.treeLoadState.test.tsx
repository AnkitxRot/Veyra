import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";
import type { Project, User, TreeNode } from "../src/types";

vi.mock("../src/api", () => ({ api: vi.fn() }));

import Sidebar from "../src/components/Sidebar/Sidebar";

afterEach(cleanup);

const user: User = { id: 1, username: "alice" };
const project: Project = { id: "proj-1", name: "P" };

const tree: TreeNode[] = [
  { name: "main.py", path: "main.py", type: "file" },
];

function props(over: Record<string, unknown>) {
  return {
    user,
    projects: [project],
    project,
    onSelectProject: vi.fn(),
    onCreateProject: vi.fn(),
    tree: [] as TreeNode[],
    onOpenFile: vi.fn(),
    activeFile: null,
    onLogout: vi.fn(),
    refreshTree: vi.fn(),
    collaborators: [],
    currentUserId: 1,
    ...over,
  };
}

/**
 * M68 — the file tree must tell the truth while it loads and when it fails.
 * Before this, a failed `GET /api/projects/:id/tree` was swallowed and the
 * empty `tree` rendered as "Workspace is empty" with an "Add File" button —
 * indistinguishable from a genuinely empty project.
 */
describe("Sidebar file tree — load state", () => {
  it("shows a loading state (not the empty state) while the first tree loads", () => {
    const { queryByText, getByTestId } = render(
      React.createElement(Sidebar, props({ treeStatus: "loading" }) as any),
    );
    expect(getByTestId("file-tree-loading")).toBeTruthy();
    expect(queryByText("Workspace is empty")).toBeNull();
  });

  it("shows a retryable error state when the tree fails to load", () => {
    const onRetryTree = vi.fn();
    const { getByTestId, getByRole, queryByText } = render(
      React.createElement(
        Sidebar,
        props({ treeStatus: "error", onRetryTree }) as any,
      ),
    );
    expect(getByTestId("file-tree-error")).toBeTruthy();
    expect(queryByText("Workspace is empty")).toBeNull();
    fireEvent.click(getByRole("button", { name: /retry/i }));
    expect(onRetryTree).toHaveBeenCalledTimes(1);
  });

  it("still shows the genuine empty state once a load succeeds with no files", () => {
    const { getByText, queryByTestId } = render(
      React.createElement(Sidebar, props({ treeStatus: "ready" }) as any),
    );
    expect(getByText("Workspace is empty")).toBeTruthy();
    expect(queryByTestId("file-tree-loading")).toBeNull();
    expect(queryByTestId("file-tree-error")).toBeNull();
  });

  it("keeps an already-loaded tree visible when a refresh errors", () => {
    const { getByText, queryByTestId } = render(
      React.createElement(
        Sidebar,
        props({ tree, treeStatus: "error", onRetryTree: vi.fn() }) as any,
      ),
    );
    expect(getByText("main.py")).toBeTruthy();
    // no full-panel error takeover when there is still a valid tree
    expect(queryByTestId("file-tree-error")).toBeNull();
  });

  it("keeps an already-loaded tree visible during a background refresh", () => {
    const { getByText, queryByTestId } = render(
      React.createElement(
        Sidebar,
        props({ tree, treeStatus: "loading" }) as any,
      ),
    );
    expect(getByText("main.py")).toBeTruthy();
    expect(queryByTestId("file-tree-loading")).toBeNull();
  });
});
