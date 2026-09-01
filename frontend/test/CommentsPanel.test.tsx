import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import * as React from "react";
import CommentsPanel from "../src/components/Comments/CommentsPanel";
import type { CommentThreadDTO } from "../src/types";

afterEach(cleanup);

function t(over: Partial<CommentThreadDTO> = {}): CommentThreadDTO {
  return {
    id: `t${Math.random()}`,
    projectId: "p",
    filePath: "src/a.ts",
    anchor: {
      relStart: "A",
      relEnd: "B",
      slice: "x",
      startLine: 5,
      endLine: 5,
      prefixHash: "0".repeat(16),
    },
    anchorStatus: "ok",
    createdBy: 1,
    createdAt: "",
    updatedAt: "",
    resolvedAt: null,
    resolvedBy: null,
    root: {
      id: "c1",
      threadId: "t1",
      parentId: null,
      authorId: 1,
      body: "look here",
      createdAt: "",
      editedAt: null,
      deletedAt: null,
      reactions: [],
    },
    replies: [],
    mentions: [],
    ...over,
  };
}

describe("M61-A CommentsPanel", () => {
  it("shows active file threads + a project-wide unresolved roll-up; row click navigates", () => {
    const onNavigate = vi.fn();
    const active = t();
    render(
      React.createElement(CommentsPanel, {
        activeFile: "src/a.ts",
        threads: [active],
        unresolved: [active, t({ filePath: "src/b.ts" })],
        showResolved: false,
        onToggleResolved: () => {},
        onNavigate,
      } as never),
    );
    expect(screen.getByText("2 unresolved")).toBeTruthy();
    fireEvent.click(screen.getAllByText(/look here/)[0].closest("button")!);
    expect(onNavigate).toHaveBeenCalledWith(active);
  });

  it("resolved threads hide behind a collapsible toggle", () => {
    const resolved = t({ resolvedAt: new Date().toISOString(), resolvedBy: 1 });
    const onToggle = vi.fn();
    const { rerender } = render(
      React.createElement(CommentsPanel, {
        activeFile: "src/a.ts",
        threads: [resolved],
        unresolved: [],
        showResolved: false,
        onToggleResolved: onToggle,
        onNavigate: () => {},
      } as never),
    );
    expect(screen.queryByText(/look here/)).toBeNull();
    fireEvent.click(screen.getByText("Resolved (1)"));
    expect(onToggle).toHaveBeenCalledWith(true);
    rerender(
      React.createElement(CommentsPanel, {
        activeFile: "src/a.ts",
        threads: [resolved],
        unresolved: [],
        showResolved: true,
        onToggleResolved: onToggle,
        onNavigate: () => {},
      } as never),
    );
    expect(screen.getByText(/look here/)).toBeTruthy();
  });
});
