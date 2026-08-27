import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as React from "react";

vi.mock("../src/monacoSetup", async () => {
  const { monaco } = await import("./mocks/monaco");
  return { monaco };
});

import FollowBanner from "../src/components/Collab/FollowBanner";
import CollaboratorAvatarStack from "../src/components/Collab/CollaboratorAvatarStack";
import Sidebar from "../src/components/Sidebar/Sidebar";
import Editor from "../src/components/Editor/Editor";
import { __resetMonacoMocks } from "./mocks/monaco";
import type { CollaboratorPresence } from "../src/collab/client";

describe("Milestone 48 — Follow Mode & UI Presence Indicators", () => {
  beforeEach(() => {
    __resetMonacoMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe("FollowBanner Component", () => {
    it("renders active follow mode with user details, current file and line", () => {
      const onStop = vi.fn();
      const followedUser: CollaboratorPresence = {
        clientId: 101,
        userId: 2,
        name: "Bob",
        role: "editor",
        color: "#fab387",
        status: "online",
        activity: { type: "editing", timestamp: Date.now() },
        activeFile: "src/index.ts",
        cursor: { line: 42, column: 15 },
        lastActive: Date.now(),
      };

      render(
        <FollowBanner
          followedUser={followedUser}
          isPaused={false}
          onStopFollowing={onStop}
        />,
      );

      expect(screen.getByText("Following Bob")).toBeDefined();
      expect(screen.getByText(/index\.ts · Line 42/)).toBeDefined();

      const stopBtn = screen.getByRole("button", { name: /Stop Following/i });
      fireEvent.click(stopBtn);
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("renders paused state with warning banner and pause reason", () => {
      const onStop = vi.fn();
      const followedUser: CollaboratorPresence = {
        clientId: 101,
        userId: 2,
        name: "Bob",
        role: "editor",
        color: "#fab387",
        status: "online",
        activity: { type: "viewing", timestamp: Date.now() },
        activeFile: "src/utils.ts",
        lastActive: Date.now(),
      };

      render(
        <FollowBanner
          followedUser={followedUser}
          isPaused={true}
          pauseReason="Follow paused — you have unsaved changes"
          onStopFollowing={onStop}
        />,
      );

      expect(screen.getByText("Follow Paused")).toBeDefined();
      expect(screen.getByText("Follow paused — you have unsaved changes")).toBeDefined();
    });

    it("stops following when Escape key is pressed", () => {
      const onStop = vi.fn();
      const followedUser: CollaboratorPresence = {
        clientId: 101,
        userId: 2,
        name: "Bob",
        role: "editor",
        color: "#fab387",
        status: "online",
        activity: { type: "viewing", timestamp: Date.now() },
        lastActive: Date.now(),
      };

      render(
        <FollowBanner
          followedUser={followedUser}
          isPaused={false}
          onStopFollowing={onStop}
        />,
      );

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onStop).toHaveBeenCalledTimes(1);
    });
  });

  describe("CollaboratorAvatarStack Component", () => {
    const mockCollaborators: CollaboratorPresence[] = [
      {
        clientId: 101,
        userId: 2,
        name: "Bob",
        role: "editor",
        color: "#fab387",
        status: "online",
        activity: { type: "editing", timestamp: Date.now() },
        activeFile: "server.ts",
        cursor: { line: 12, column: 4 },
        lastActive: Date.now(),
      },
      {
        clientId: 102,
        userId: 3,
        name: "Charlie",
        role: "viewer",
        color: "#cba6f7",
        status: "idle",
        activity: { type: "viewing", timestamp: Date.now() },
        activeFile: "package.json",
        lastActive: Date.now(),
      },
    ];

    it("renders collaborator avatars with status indicators and handles Follow and Jump actions", () => {
      const onFollow = vi.fn();
      const onJump = vi.fn();
      const onToggleDnd = vi.fn();

      render(
        <CollaboratorAvatarStack
          collaborators={mockCollaborators}
          status="connected"
          currentUserId={1}
          isDnd={false}
          followingUserId={null}
          onToggleDnd={onToggleDnd}
          onFollowCollaborator={onFollow}
          onJumpToCollaborator={onJump}
        />,
      );

      // Verify collaborator avatars
      const bobAvatar = screen.getByLabelText(/Bob/i);
      expect(bobAvatar).toBeDefined();

      // Click Bob's avatar to open popover
      fireEvent.click(bobAvatar);

      expect(screen.getByText("Bob")).toBeDefined();
      expect(screen.getByText(/Editing server\.ts · L12/i)).toBeDefined();

      // Click Follow button
      const followBtn = screen.getByRole("button", { name: /Follow/i });
      fireEvent.click(followBtn);
      expect(onFollow).toHaveBeenCalledWith(mockCollaborators[0]);

      // Re-open popover and click Jump button
      fireEvent.click(bobAvatar);
      const jumpBtn = screen.getByRole("button", { name: /Jump to File/i });
      fireEvent.click(jumpBtn);
      expect(onJump).toHaveBeenCalledWith(mockCollaborators[0]);
    });

    it("allows toggling DND mode for current user", () => {
      const onToggleDnd = vi.fn();

      render(
        <CollaboratorAvatarStack
          collaborators={mockCollaborators}
          status="connected"
          currentUserId={1}
          isDnd={false}
          onToggleDnd={onToggleDnd}
        />,
      );

      const dndBtn = screen.getByRole("button", { name: /Do Not Disturb/i });
      fireEvent.click(dndBtn);
      expect(onToggleDnd).toHaveBeenCalledWith(true);
    });
  });

  describe("FileTree Presence Badges in Sidebar", () => {
    it("renders presence badge in file tree for files with active collaborators", () => {
      const mockCollaborators: CollaboratorPresence[] = [
        {
          clientId: 101,
          userId: 2,
          name: "Bob",
          role: "editor",
          color: "#fab387",
          status: "online",
          activity: { type: "editing", timestamp: Date.now() },
          activeFile: "main.py",
          lastActive: Date.now(),
        },
      ];

      const tree = [
        {
          name: "main.py",
          path: "main.py",
          type: "file" as const,
        },
        {
          name: "readme.md",
          path: "readme.md",
          type: "file" as const,
        },
      ];

      render(
        <Sidebar
          user={{ id: 1, username: "alice" } as any}
          projects={[{ id: "p1", name: "Project 1" } as any]}
          project={{ id: "p1", name: "Project 1" } as any}
          onSelectProject={() => {}}
          onCreateProject={async () => {}}
          tree={tree}
          onOpenFile={() => {}}
          activeFile="readme.md"
          onLogout={() => {}}
          refreshTree={async () => {}}
          collaborators={mockCollaborators}
          currentUserId={1}
        />,
      );

      const badge = screen.getByLabelText(/active collaborator\(s\)/i);
      expect(badge).toBeDefined();
    });
  });

  describe("Editor Tabs Presence and Proximity Warning", () => {
    it("renders tab presence dots and proximity warning when collaborator edits nearby", () => {
      const mockCollaborators: CollaboratorPresence[] = [
        {
          clientId: 101,
          userId: 2,
          name: "Bob",
          role: "editor",
          color: "#fab387",
          status: "online",
          activity: { type: "editing", timestamp: Date.now() },
          activeFile: "main.py",
          cursor: { line: 3, column: 1 },
          lastActive: Date.now(),
        },
      ];

      const openFiles = [
        { path: "main.py", content: "line1\nline2\nline3\nline4\nline5", dirty: false },
      ];

      render(
        <Editor
          project={{ id: "p1" }}
          openFiles={openFiles}
          setOpenFiles={() => {}}
          activeFile="main.py"
          setActiveFile={() => {}}
          collaborators={mockCollaborators}
          currentUserId={1}
        />,
      );

      // Tab presence badge
      const tabBadge = screen.getByLabelText(/active collaborator\(s\) on this tab/i);
      expect(tabBadge).toBeDefined();

      // Proximity warning (local cursor at line 1, Bob editing at line 3 -> <= 5 lines apart)
      const proximityWarning = screen.getByRole("status");
      expect(proximityWarning).toBeDefined();
      expect(proximityWarning.textContent).toContain("Nearby edit: Bob");
    });
  });
});
