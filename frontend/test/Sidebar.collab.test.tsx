import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import * as React from "react";
import type { Project, User, TreeNode } from "../src/types";
import type { CollaboratorPresence } from "../src/collab/presence";

vi.mock("../src/api", () => ({ api: vi.fn() }));

import Sidebar from "../src/components/Sidebar/Sidebar";

afterEach(cleanup);

const user: User = { id: 1, username: "alice" };
const project: Project = { id: "proj-1", name: "P" };

const tree: TreeNode[] = [
  {
    name: "src",
    path: "src",
    type: "dir",
    children: [
      {
        name: "auth",
        path: "src/auth",
        type: "dir",
        children: [
          { name: "service.ts", path: "src/auth/service.ts", type: "file" },
        ],
      },
    ],
  },
];

const rahul = (over: Partial<CollaboratorPresence> = {}): CollaboratorPresence => ({
  clientId: 99,
  userId: 2,
  name: "Rahul",
  role: "editor",
  color: "#f38ba8",
  status: "online",
  activity: { type: "editing", timestamp: 0 },
  activeFile: "src/auth/service.ts",
  workingFolder: "src/auth",
  lastActive: 0,
  ...over,
});

function props(collaborators: CollaboratorPresence[]) {
  return {
    user,
    projects: [project],
    project,
    onSelectProject: vi.fn(),
    onCreateProject: vi.fn(),
    tree,
    onOpenFile: vi.fn(),
    activeFile: null,
    onLogout: vi.fn(),
    refreshTree: vi.fn(),
    collaborators,
    currentUserId: 1,
  };
}

describe("Sidebar — M57 folder-level collaborator indicators", () => {
  it("shows a collaborator dot on the ancestor folder rows of a collaborator's active file", () => {
    const { container, getByText } = render(
      React.createElement(Sidebar, props([rahul()]) as any),
    );
    // both "src" and "src/auth" rows should carry a collab badge
    const badges = container.querySelectorAll(".tree-node-collab-badge");
    expect(badges.length).toBeGreaterThanOrEqual(2);
    // the badge titles name Rahul
    expect(
      [...badges].some((b) => (b.getAttribute("title") || "").includes("Rahul")),
    ).toBe(true);
    expect(getByText("auth")).toBeTruthy();
  });

  it("shows no folder indicators when there are no collaborators", () => {
    const { container } = render(
      React.createElement(Sidebar, props([]) as any),
    );
    expect(container.querySelectorAll(".tree-node-collab-badge").length).toBe(0);
  });

  it("excludes the current user from folder indicators", () => {
    const { container } = render(
      React.createElement(
        Sidebar,
        props([rahul({ userId: 1, name: "alice" })]) as any,
      ),
    );
    expect(container.querySelectorAll(".tree-node-collab-badge").length).toBe(0);
  });
});
