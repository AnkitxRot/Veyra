import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import * as React from "react";
import { monaco } from "./mocks/monaco";
vi.mock("../src/monacoSetup", () => ({ monaco }));
import CollaboratorAvatarStack from "../src/components/Collab/CollaboratorAvatarStack";
import TeamPanel from "../src/components/Collab/TeamPanel";
import CommentThread from "../src/components/Comments/CommentThread";
import CommentComposer from "../src/components/Comments/CommentComposer";
import FollowBanner from "../src/components/Collab/FollowBanner";
import Editor from "../src/components/Editor/Editor";
import {
  getUserColor,
  displayLabel,
  secondaryHandle,
  type CollaboratorPresence,
} from "../src/collab/presence";
import type { CommentThreadDTO } from "../src/types";

afterEach(cleanup);

const pres = (o: Partial<CollaboratorPresence>): CollaboratorPresence => ({
  clientId: o.clientId ?? Math.random(),
  userId: o.userId ?? 1,
  name: o.name ?? "x",
  role: "editor",
  color: getUserColor(o.userId ?? 1),
  status: "online",
  activity: { type: "editing", timestamp: 0 },
  lastActive: 0,
  ...o,
});

function commentThread(authorId: number): CommentThreadDTO {
  const iso = new Date().toISOString();
  return {
    id: "t1",
    projectId: "p",
    filePath: "a.ts",
    anchor: {
      relStart: "A",
      relEnd: "B",
      slice: "x",
      startLine: 1,
      endLine: 1,
      prefixHash: "0".repeat(16),
    },
    anchorStatus: "ok",
    createdBy: authorId,
    createdAt: iso,
    updatedAt: iso,
    resolvedAt: null,
    resolvedBy: null,
    root: {
      id: "c1",
      threadId: "t1",
      parentId: null,
      authorId,
      body: "look at @ada99 here",
      createdAt: iso,
      editedAt: null,
      deletedAt: null,
      reactions: [],
    },
    replies: [],
    mentions: [],
  };
}

const teamProps = {
  runStatuses: [],
  isDnd: false,
  followingUserId: null,
  onClose: () => {},
  onSetIntent: () => {},
  onToggleDnd: () => {},
  onFollow: () => {},
  onJump: () => {},
  timeline: [],
  timelineHasMore: false,
  onTimelineLoadMore: () => {},
  onTimelineNavigate: () => {},
};

describe("M62-5 — display identity is consistent across every collaboration surface", () => {
  it("displayName present → 'Ada L.' + '@ada99' on avatar popover, Team row, and comment author; mention stays @ada99", () => {
    const ada = pres({ userId: 42, name: "ada99", displayName: "Ada L." });

    // Avatar stack popover
    const { unmount: u1 } = render(
      <CollaboratorAvatarStack
        collaborators={[pres({ userId: 1, name: "me" }), ada]}
        status="connected"
        currentUserId={1}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Collaborator Ada L\. \(@ada99\)/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Ada L.")).toBeTruthy();
    expect(within(dialog).getByText("@ada99")).toBeTruthy();
    u1();

    // Team panel row
    const { unmount: u2 } = render(
      <TeamPanel {...teamProps} collaborators={[pres({ userId: 1, name: "me" }), ada]} currentUserId={1} />,
    );
    const teamRow = screen.getByText("Ada L.").closest(".team-row")!;
    expect(within(teamRow as HTMLElement).getByText("@ada99")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Follow Ada L." })).toBeTruthy();
    u2();

    // Comment author row + mention chip
    render(
      <CommentThread
        thread={commentThread(42)}
        currentUserId={99}
        members={[{ userId: 42, username: "ada99", displayName: "Ada L." }]}
        onReply={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onResolve={() => {}}
        onReopen={() => {}}
        onReact={() => {}}
        onUnreact={() => {}}
        onClose={() => {}}
      />,
    );
    const head = document.querySelector(".comment-row-head")!;
    expect(within(head as HTMLElement).getByText("Ada L.")).toBeTruthy();
    expect(within(head as HTMLElement).getByText("@ada99")).toBeTruthy();
    // mention token in the body is styled and remains @ada99
    const mention = document.querySelector(".mention")!;
    expect(mention.textContent).toBe("@ada99");
  });

  it("displayName absent/null → every surface falls back to the username, no @suffix", () => {
    const ada = pres({ userId: 42, name: "ada99" }); // no displayName

    const { unmount: u1 } = render(
      <TeamPanel {...teamProps} collaborators={[pres({ userId: 1, name: "me" }), ada]} currentUserId={1} />,
    );
    const teamRow = screen.getByText("ada99").closest(".team-row")!;
    expect(within(teamRow as HTMLElement).queryByText("@ada99")).toBeNull();
    u1();

    render(
      <CommentThread
        thread={commentThread(42)}
        currentUserId={99}
        members={[{ userId: 42, username: "ada99", displayName: null }]}
        onReply={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onResolve={() => {}}
        onReopen={() => {}}
        onReact={() => {}}
        onUnreact={() => {}}
        onClose={() => {}}
      />,
    );
    const head = document.querySelector(".comment-row-head")!;
    expect(within(head as HTMLElement).getByText("ada99")).toBeTruthy();
    // no separate @handle span when label === username
    expect(head.querySelector(".comment-author-handle")).toBeNull();
  });

  it("two collaborators with the SAME displayName stay distinguishable by @username", () => {
    const a = pres({ userId: 1, name: "ada99", displayName: "Ada L." });
    const b = pres({ userId: 2, name: "ada100", displayName: "Ada L." });
    render(
      <TeamPanel {...teamProps} collaborators={[pres({ userId: 9, name: "me" }), a, b]} currentUserId={9} />,
    );
    // both display "Ada L."
    expect(screen.getAllByText("Ada L.").length).toBe(2);
    // …but each row carries its own distinct handle
    expect(screen.getByText("@ada99")).toBeTruthy();
    expect(screen.getByText("@ada100")).toBeTruthy();
  });

  it("stable identity: displayName does NOT drive colour or identity keys; mention token is username", () => {
    // colour is keyed by userId, independent of any name
    expect(getUserColor(42)).toBe(getUserColor(42));
    const before = getUserColor(42);
    const renamed = pres({ userId: 42, name: "ada99", displayName: "Grace" });
    expect(renamed.color).toBe(before); // pres() derives colour from userId only

    // the helpers never treat displayName as identity
    expect(displayLabel({ name: "ada99", displayName: "Grace" })).toBe("Grace");
    expect(secondaryHandle({ name: "ada99", displayName: "Grace" })).toBe("@ada99");
    expect(secondaryHandle({ name: "ada99", displayName: "ada99" })).toBeNull();
    expect(secondaryHandle({ name: "ada99" })).toBeNull();

    // composer autocomplete matches + inserts the USERNAME, never displayName
    render(
      <CommentComposer
        members={[{ userId: 42, username: "ada99", displayName: "Grace" }]}
        onSubmit={() => {}}
      />,
    );
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hey @ad" } });
    const option = screen.getByRole("option");
    expect(option.textContent).toBe("@ada99");
  });

  it("FollowBanner shows the display name, not the username", () => {
    render(
      <FollowBanner
        followedUser={pres({ userId: 42, name: "ada99", displayName: "Ada L." })}
        onStopFollowing={() => {}}
      />,
    );
    expect(screen.getByText("Following Ada L.")).toBeTruthy();
    // aria-label carries it too
    expect(screen.getByRole("status").getAttribute("aria-label")).toContain("Following Ada L.");
  });

  it("FollowBanner falls back to the username when no displayName", () => {
    render(
      <FollowBanner
        followedUser={pres({ userId: 42, name: "ada99" })}
        onStopFollowing={() => {}}
      />,
    );
    expect(screen.getByText("Following ada99")).toBeTruthy();
  });

  it("Editor same-file strip shows the display name", () => {
    render(
      React.createElement(Editor, {
        project: {},
        openFiles: [{ path: "src/a.ts", content: "x", dirty: false }],
        setOpenFiles: () => {},
        activeFile: "src/a.ts",
        setActiveFile: () => {},
        liveApiRef: { current: null },
        isReadOnly: false,
        currentUserId: 1,
        collaborators: [
          pres({ userId: 2, name: "ada99", displayName: "Ada L.", activeFile: "src/a.ts" }),
        ],
      } as unknown as React.ComponentProps<typeof Editor>),
    );
    expect(screen.getByText(/Ada L\. ·/)).toBeTruthy();
  });

  it("renders a display name containing HTML as plain text (no markup sink)", () => {
    const evil = pres({ userId: 5, name: "mallory", displayName: "<img src=x onerror=alert(1)>" });
    const { container } = render(
      <TeamPanel {...teamProps} collaborators={[pres({ userId: 1, name: "me" }), evil]} currentUserId={1} />,
    );
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});
