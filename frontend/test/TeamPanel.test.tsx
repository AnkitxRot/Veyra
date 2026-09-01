import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import TeamPanel from "../src/components/Collab/TeamPanel";
import type { CollaboratorPresence } from "../src/collab/presence";
import type { TimelineEvent } from "../src/types";

afterEach(cleanup);

const base = (o: Partial<CollaboratorPresence>): CollaboratorPresence => ({
  clientId: o.clientId ?? Math.random(),
  userId: o.userId ?? 1,
  name: o.name ?? "X",
  role: "editor",
  color: "#89b4fa",
  status: "online",
  activity: { type: "viewing", timestamp: 0 },
  lastActive: Date.now(),
  ...o,
});

const noop = () => {};
const handlers = {
  onClose: noop,
  onSetIntent: noop,
  onToggleDnd: noop,
  onFollow: noop,
  onJump: noop,
  timeline: [],
  timelineHasMore: false,
  onTimelineLoadMore: noop,
  onTimelineNavigate: noop,
};

describe("TeamPanel", () => {
  it("lists every collaborator with a count", () => {
    render(
      <TeamPanel
        collaborators={[
          base({ userId: 1, name: "Me" }),
          base({ userId: 2, name: "Rahul" }),
          base({ userId: 3, name: "Priya" }),
        ]}
        runStatuses={[]}
        currentUserId={1}
        isDnd={false}
        followingUserId={null}
        {...handlers}
      />,
    );
    // header "TEAM" — scoped to the panel header so it is unambiguous
    // alongside the M60 "TEAM ACTIVITY" section title
    expect(
      screen.getByText(
        (_, el) =>
          el?.parentElement?.className.includes("team-panel-header") === true &&
          el?.textContent?.startsWith("TEAM") === true,
      ),
    ).toBeTruthy();
    expect(screen.getByText("(3)")).toBeTruthy();
    expect(screen.getByText("Rahul")).toBeTruthy();
    expect(screen.getByText("Priya")).toBeTruthy();
  });

  it("shows a self row with an editable intent input that commits on blur", () => {
    const onSetIntent = vi.fn();
    render(
      <TeamPanel
        collaborators={[
          base({ userId: 1, name: "Me", intent: { text: "old", updatedAt: 0 } }),
        ]}
        runStatuses={[]}
        currentUserId={1}
        isDnd={false}
        followingUserId={null}
        {...handlers}
        onSetIntent={onSetIntent}
      />,
    );
    const input = screen.getByPlaceholderText(
      /what are you working on/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "JWT refresh" } });
    fireEvent.blur(input);
    expect(onSetIntent).toHaveBeenCalledWith("JWT refresh");
  });

  it("shows run-status text over the activity for a running collaborator", () => {
    render(
      <TeamPanel
        collaborators={[base({ userId: 1 }), base({ userId: 2, name: "Aman" })]}
        runStatuses={[
          {
            executionId: "e",
            userId: 2,
            username: "Aman",
            state: "running",
            file: "backend/x.py",
            language: "python",
            startedAt: Date.now(),
            endedAt: null,
            exitCode: null,
          },
        ]}
        currentUserId={1}
        isDnd={false}
        followingUserId={null}
        {...handlers}
      />,
    );
    expect(screen.getByText(/Running/i)).toBeTruthy();
  });

  it("renders working folder and intent for a collaborator", () => {
    render(
      <TeamPanel
        collaborators={[
          base({ userId: 1 }),
          base({
            userId: 2,
            name: "Rahul",
            activeFile: "src/auth/service.ts",
            workingFolder: "src/auth",
            intent: { text: "JWT refresh", updatedAt: 1 },
            activity: { type: "editing", timestamp: 0 },
          }),
        ]}
        runStatuses={[]}
        currentUserId={1}
        isDnd={false}
        followingUserId={null}
        {...handlers}
      />,
    );
    expect(screen.getByText("📁 src/auth")).toBeTruthy();
    expect(screen.getByText("🎯 JWT refresh")).toBeTruthy();
    expect(screen.getByText("✏️ Editing")).toBeTruthy();
  });

  it("Follow and Jump call handlers with the collaborator", () => {
    const onFollow = vi.fn();
    const onJump = vi.fn();
    const rahul = base({ userId: 2, name: "Rahul", activeFile: "src/a.ts" });
    render(
      <TeamPanel
        collaborators={[base({ userId: 1 }), rahul]}
        runStatuses={[]}
        currentUserId={1}
        isDnd={false}
        followingUserId={null}
        {...handlers}
        onFollow={onFollow}
        onJump={onJump}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /follow rahul/i }));
    expect(onFollow).toHaveBeenCalledWith(expect.objectContaining({ userId: 2 }));
    fireEvent.click(screen.getByRole("button", { name: /jump to rahul/i }));
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ userId: 2 }));
  });

  it("groups collaborators under WORKING IN by folder", () => {
    render(
      <TeamPanel
        collaborators={[
          base({ userId: 1 }),
          base({
            userId: 2,
            name: "Rahul",
            activeFile: "src/auth/service.ts",
            workingFolder: "src/auth",
          }),
          base({
            userId: 3,
            name: "Priya",
            activeFile: "src/ui/Login.tsx",
            workingFolder: "src/ui",
          }),
        ]}
        runStatuses={[]}
        currentUserId={1}
        isDnd={false}
        followingUserId={null}
        {...handlers}
      />,
    );
    expect(screen.getByText("WORKING IN")).toBeTruthy();
    expect(screen.getByText("src/auth")).toBeTruthy();
    expect(screen.getByText("src/ui")).toBeTruthy();
  });

  it("de-dupes the roster by userId for a multi-tab user", () => {
    render(
      <TeamPanel
        collaborators={[
          base({ userId: 1 }),
          base({ clientId: 10, userId: 2, name: "Rahul", lastActive: 100 }),
          base({ clientId: 11, userId: 2, name: "Rahul", lastActive: 200 }),
        ]}
        runStatuses={[]}
        currentUserId={1}
        isDnd={false}
        followingUserId={null}
        {...handlers}
      />,
    );
    expect(screen.getAllByText("Rahul").length).toBe(1);
  });

  it("shows availability label instead of activity when a collaborator is away", () => {
    render(
      <TeamPanel
        collaborators={[
          base({ userId: 1 }),
          base({
            userId: 2,
            name: "Rahul",
            status: "away",
            activity: { type: "editing", timestamp: 0 },
          }),
        ]}
        runStatuses={[]}
        currentUserId={1}
        isDnd={false}
        followingUserId={null}
        {...handlers}
      />,
    );
    expect(screen.getByText("Away")).toBeTruthy();
  });

  it("close button calls onClose", () => {
    const onClose = vi.fn();
    render(
      <TeamPanel
        collaborators={[base({ userId: 1 })]}
        runStatuses={[]}
        currentUserId={1}
        isDnd={false}
        followingUserId={null}
        {...handlers}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /close team panel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("M60: renders the Team Activity section and routes a row click to onTimelineNavigate", () => {
    const onTimelineNavigate = vi.fn();
    const ev: TimelineEvent = {
      id: "collab:1",
      kind: "edit_burst",
      at: new Date().toISOString(),
      actor: { userId: 2, username: "Rahul" },
      filePath: "src/auth/session.ts",
      title: "changed lines 40–52",
      navigable: true,
    };
    render(
      <TeamPanel
        collaborators={[base({ userId: 1 })]}
        runStatuses={[]}
        currentUserId={1}
        isDnd={false}
        followingUserId={null}
        {...handlers}
        timeline={[ev]}
        onTimelineNavigate={onTimelineNavigate}
      />,
    );
    expect(screen.getByText("TEAM ACTIVITY")).toBeTruthy();
    fireEvent.click(screen.getByText(/changed lines 40/));
    expect(onTimelineNavigate).toHaveBeenCalledWith(ev);
  });
});
