import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import * as React from "react";
import Sidebar from "../src/components/Sidebar/Sidebar";

const USER = { username: "owner", id: 1 } as any;
const PROJECT = { id: "p", name: "demo" } as any;

const tree = [
  { name: "src", path: "src", type: "dir" as const, children: [{ name: "a.ts", path: "src/a.ts", type: "file" as const }] },
  { name: "auth", path: "auth", type: "dir" as const, children: [{ name: "session.ts", path: "auth/session.ts", type: "file" as const }] },
];

describe("M61-A Explorer unresolved indicators", () => {
  afterEach(cleanup);

  it("shows 💬 badge for files with active unresolved comments only", () => {
    const counts = new Map<string, number>([
      ["src/a.ts", 1],
      ["auth/session.ts", 2],
    ]);
    const { container } = render(
      React.createElement(Sidebar, {
        user: USER,
        projects: [PROJECT],
        project: PROJECT,
        onSelectProject: () => {},
        onCreateProject: () => {},
        tree,
        onOpenFile: () => {},
        activeFile: null,
        onLogout: () => {},
        refreshTree: () => {},
        collaborators: [],
        runStatuses: [],
        currentUserId: 1,
        commentCountsByFile: counts,
      } as any),
    );
    const badges = container.querySelectorAll(".tree-node-comment-badge");
    expect(badges.length).toBe(2);
    const texts = Array.from(badges).map((n) => n.textContent);
    expect(texts.join(" ")).toContain("💬 1");
    expect(texts.join(" ")).toContain("💬 2");
  });

  it("shows no badge when count is zero or file has no entry", () => {
    const counts = new Map<string, number>();
    const { container } = render(
      React.createElement(Sidebar, {
        user: USER,
        projects: [PROJECT],
        project: PROJECT,
        onSelectProject: () => {},
        onCreateProject: () => {},
        tree,
        onOpenFile: () => {},
        activeFile: null,
        onLogout: () => {},
        refreshTree: () => {},
        collaborators: [],
        runStatuses: [],
        currentUserId: 1,
        commentCountsByFile: counts,
      } as any),
    );
    expect(container.querySelectorAll(".tree-node-comment-badge").length).toBe(0);
  });

  it("stale/resolved are not counted (map is derived from canonical store filtered)", () => {
    // countsByFile helper already filters stale/deleted; Sidebar just renders what it is given.
    // This test ensures Sidebar does not invent its own counting.
    const counts = new Map<string, number>([["src/a.ts", 0]]);
    // Even if map contains 0, badge should not show (our Sidebar checks >0)
    const { container } = render(
      React.createElement(Sidebar, {
        user: USER,
        projects: [PROJECT],
        project: PROJECT,
        onSelectProject: () => {},
        onCreateProject: () => {},
        tree: [{ name: "a.ts", path: "src/a.ts", type: "file" as const }],
        onOpenFile: () => {},
        activeFile: null,
        onLogout: () => {},
        refreshTree: () => {},
        collaborators: [],
        currentUserId: 1,
        commentCountsByFile: counts,
      } as any),
    );
    expect(container.querySelectorAll(".tree-node-comment-badge").length).toBe(0);
  });

  it("badge has accessible title and aria-label", () => {
    const counts = new Map<string, number>([["src/a.ts", 3]]);
    const { container } = render(
      React.createElement(Sidebar, {
        user: USER,
        projects: [PROJECT],
        project: PROJECT,
        onSelectProject: () => {},
        onCreateProject: () => {},
        tree: [{ name: "a.ts", path: "src/a.ts", type: "file" as const }],
        onOpenFile: () => {},
        activeFile: null,
        onLogout: () => {},
        refreshTree: () => {},
        collaborators: [],
        currentUserId: 1,
        commentCountsByFile: counts,
      } as any),
    );
    const badge = container.querySelector(".tree-node-comment-badge") as HTMLElement;
    expect(badge.getAttribute("aria-label")).toBe("3 unresolved comments");
    expect(badge.getAttribute("title")).toContain("3 unresolved");
  });
});
