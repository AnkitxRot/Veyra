import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, within } from "@testing-library/react";
import * as React from "react";
import CommentThread from "../src/components/Comments/CommentThread";
import type { CommentThreadDTO } from "../src/types";

afterEach(cleanup);

const members = [
  { userId: 1, username: "owner" },
  { userId: 2, username: "rahul" },
];

function makeThread(over: Partial<CommentThreadDTO> = {}): CommentThreadDTO {
  return {
    id: "t1",
    projectId: "p",
    filePath: "a.ts",
    anchor: {
      relStart: "A",
      relEnd: "B",
      slice: "x",
      startLine: 3,
      endLine: 3,
      prefixHash: "0".repeat(16),
    },
    anchorStatus: "ok",
    createdBy: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    root: {
      id: "c1",
      threadId: "t1",
      parentId: null,
      authorId: 2,
      body: "the race is here",
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      reactions: [],
    },
    replies: [
      {
        id: "c2",
        threadId: "t1",
        parentId: "c1",
        authorId: 1,
        body: "agreed",
        createdAt: new Date().toISOString(),
        editedAt: null,
        deletedAt: null,
        reactions: [],
      },
    ],
    mentions: [],
    ...over,
  };
}

const handlers = () => ({
  onReply: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onResolve: vi.fn(),
  onReopen: vi.fn(),
  onReact: vi.fn(),
  onUnreact: vi.fn(),
  onClose: vi.fn(),
});

describe("M61-A CommentThread", () => {
  it("renders root + ordered replies; XSS body renders literally", () => {
    const h = handlers();
    render(
      React.createElement(CommentThread, {
        thread: makeThread({
          root: {
            ...makeThread().root,
            body: "<img src=x onerror=alert(1)>",
          },
        }),
        currentUserId: 1,
        members,
        ...h,
      } as never),
    );
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("agreed")).toBeTruthy();
  });

  it("resolve button fires onResolve; a resolved thread shows Reopen", () => {
    const h = handlers();
    const { rerender } = render(
      React.createElement(CommentThread, {
        thread: makeThread(),
        currentUserId: 1,
        members,
        ...h,
      } as never),
    );
    fireEvent.click(screen.getByText("Resolve"));
    expect(h.onResolve).toHaveBeenCalled();
    rerender(
      React.createElement(CommentThread, {
        thread: makeThread({ resolvedAt: new Date().toISOString(), resolvedBy: 1 }),
        currentUserId: 1,
        members,
        ...h,
      } as never),
    );
    expect(screen.getByText("Reopen")).toBeTruthy();
  });

  it("author sees Edit/Delete; non-author non-owner does not", () => {
    const h = handlers();
    render(
      React.createElement(CommentThread, {
        thread: makeThread(),
        currentUserId: 2, // author of root
        projectOwnerId: 1,
        members,
        ...h,
      } as never),
    );
    const rootRow = document.querySelector('[data-comment-id="c1"]') as HTMLElement;
    expect(within(rootRow).getByText("Edit")).toBeTruthy();
  });

  it("reaction: + then an emoji calls onReact; Esc calls onClose", () => {
    const h = handlers();
    render(
      React.createElement(CommentThread, {
        thread: makeThread(),
        currentUserId: 1,
        members,
        ...h,
      } as never),
    );
    const rootRow = document.querySelector('[data-comment-id="c1"]') as HTMLElement;
    fireEvent.click(within(rootRow).getByLabelText("Add reaction"));
    fireEvent.click(within(rootRow).getByText("\u{1F44D}"));
    expect(h.onReact).toHaveBeenCalledWith("c1", "\u{1F44D}");

    fireEvent.keyDown(document.querySelector(".comment-thread")!, {
      key: "Escape",
    });
    expect(h.onClose).toHaveBeenCalled();
  });

  it("stale anchor shows the explicit warning on the root", () => {
    const h = handlers();
    render(
      React.createElement(CommentThread, {
        thread: makeThread({ anchorStatus: "stale" }),
        currentUserId: 1,
        members,
        ...h,
      } as never),
    );
    expect(screen.getByText(/Original code location changed/)).toBeTruthy();
  });
});
