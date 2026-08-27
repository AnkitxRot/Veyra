import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import * as React from "react";

vi.mock("../src/monacoSetup", async () => {
  const { monaco } = await import("./mocks/monaco");
  return { monaco };
});

import CollaboratorAvatarStack from "../src/components/Collab/CollaboratorAvatarStack";
import Sidebar from "../src/components/Sidebar/Sidebar";
import { __resetMonacoMocks } from "./mocks/monaco";
import type { CollaboratorPresence } from "../src/collab/client";
import type { RunStatusEntry } from "../src/types";

const bob: CollaboratorPresence = {
  clientId: 101,
  userId: 2,
  name: "Bob",
  role: "editor",
  color: "#fab387",
  status: "online",
  activity: { type: "viewing", timestamp: Date.now() },
  activeFile: "src/app.py",
  lastActive: Date.now(),
};

const running = (over: Partial<RunStatusEntry> = {}): RunStatusEntry => ({
  executionId: "e1",
  userId: 2,
  username: "Bob",
  state: "running",
  file: "src/app.py",
  language: "python",
  startedAt: Date.now(),
  endedAt: null,
  exitCode: null,
  ...over,
});

describe("M54 — run awareness UI surfaces", () => {
  beforeEach(() => __resetMonacoMocks());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("avatar popover shows Running <file> · <language> and a ▶ glyph", () => {
    render(
      <CollaboratorAvatarStack
        collaborators={[bob]}
        runStatuses={[running()]}
        status="connected"
        currentUserId={1}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Bob/i));
    expect(screen.getByText(/Running app\.py · python/i)).toBeDefined();
    expect(screen.getAllByText("▶").length).toBeGreaterThan(0);
  });

  it("elapsed clock ticks locally", () => {
    vi.useFakeTimers();
    const started = Date.now() - 61_000;
    render(
      <CollaboratorAvatarStack
        collaborators={[bob]}
        runStatuses={[running({ startedAt: started })]}
        status="connected"
        currentUserId={1}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Bob/i));
    expect(screen.getByText(/1:0[12]/)).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText(/1:0[4-6]/)).toBeDefined();
  });

  it("terminal states render exited / failed / stopped", () => {
    for (const [state, expected] of [
      ["success", /app\.py exited 0/i],
      ["failed", /app\.py failed/i],
      ["stopped", /app\.py stopped/i],
    ] as const) {
      const { unmount } = render(
        <CollaboratorAvatarStack
          collaborators={[bob]}
          runStatuses={[
            running({
              state: state as any,
              endedAt: Date.now(),
              exitCode: state === "success" ? 0 : 1,
            }),
          ]}
          status="connected"
          currentUserId={1}
        />,
      );
      fireEvent.click(screen.getByLabelText(/Bob/i));
      expect(screen.getByText(expected)).toBeDefined();
      unmount();
    }
  });

  it("a run entry for the current user is not shown as a peer badge", () => {
    render(
      <CollaboratorAvatarStack
        collaborators={[{ ...bob, userId: 1 }]}
        runStatuses={[running({ userId: 1 })]}
        status="connected"
        currentUserId={1}
      />,
    );
    // self is filtered out of otherCollaborators entirely
    expect(screen.queryByText(/Running app\.py/i)).toBeNull();
  });

  const tree = [
    {
      name: "src",
      path: "src",
      type: "dir" as const,
      children: [
        { name: "app.py", path: "src/app.py", type: "file" as const },
        { name: "util.py", path: "src/util.py", type: "file" as const },
      ],
    },
  ];

  it("Sidebar shows a ▶ running badge on the file being run, and none for terminal", () => {
    const { rerender } = render(
      <Sidebar
        user={{ id: 1, username: "alice" } as any}
        projects={[{ id: "p1", name: "P" } as any]}
        project={{ id: "p1", name: "P" } as any}
        onSelectProject={() => {}}
        onCreateProject={async () => {}}
        tree={tree}
        onOpenFile={() => {}}
        activeFile={null}
        onLogout={() => {}}
        refreshTree={async () => {}}
        collaborators={[bob]}
        runStatuses={[running()]}
        currentUserId={1}
      />,
    );
    expect(screen.getByLabelText(/running this file/i)).toBeDefined();

    rerender(
      <Sidebar
        user={{ id: 1, username: "alice" } as any}
        projects={[{ id: "p1", name: "P" } as any]}
        project={{ id: "p1", name: "P" } as any}
        onSelectProject={() => {}}
        onCreateProject={async () => {}}
        tree={tree}
        onOpenFile={() => {}}
        activeFile={null}
        onLogout={() => {}}
        refreshTree={async () => {}}
        collaborators={[bob]}
        runStatuses={[
          running({ state: "success", endedAt: Date.now(), exitCode: 0 }),
        ]}
        currentUserId={1}
      />,
    );
    expect(screen.queryByLabelText(/running this file/i)).toBeNull();
  });

  it("DND does not hide run status and no toast/alert is rendered", () => {
    render(
      <CollaboratorAvatarStack
        collaborators={[{ ...bob, status: "dnd" }]}
        runStatuses={[running()]}
        status="connected"
        currentUserId={1}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Bob/i));
    expect(screen.getByText(/Running app\.py/i)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
