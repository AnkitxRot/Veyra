import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import * as React from "react";
import { monaco } from "./mocks/monaco";
import type { CollaboratorPresence } from "../src/collab/presence";

vi.mock("../src/monacoSetup", () => ({ monaco }));

import Editor from "../src/components/Editor/Editor";

afterEach(cleanup);

const c = (o: Partial<CollaboratorPresence>): CollaboratorPresence => ({
  clientId: Math.random(),
  userId: o.userId ?? 2,
  name: o.name ?? "Rahul",
  role: "editor",
  color: "#f38ba8",
  status: "online",
  activity: o.activity ?? { type: "editing", timestamp: 0 },
  lastActive: 0,
  ...o,
});

function renderEditor(collaborators: CollaboratorPresence[], activeFile = "src/a.ts") {
  return render(
    React.createElement(Editor, {
      project: {},
      openFiles: [{ path: activeFile, content: "x", dirty: false }],
      setOpenFiles: () => {},
      activeFile,
      setActiveFile: () => {},
      liveApiRef: { current: null } as any,
      isReadOnly: false,
      collaborators,
      currentUserId: 1,
    } as any),
  );
}

describe("Editor — M57 same-file collaborator strip", () => {
  it("lists a collaborator whose active file matches, with their activity", () => {
    renderEditor([
      c({ userId: 2, name: "Rahul", activeFile: "src/a.ts", activity: { type: "editing", timestamp: 0 } }),
      c({ userId: 3, name: "Priya", activeFile: "src/b.ts" }),
    ]);
    expect(screen.getByText(/Rahul ·/)).toBeTruthy();
    expect(screen.getByText(/Rahul ·/).textContent).toContain("Editing");
    expect(screen.queryByText(/Priya/)).toBeNull();
  });

  it("renders nothing when no collaborator shares the file", () => {
    const { container } = renderEditor([
      c({ userId: 2, name: "Rahul", activeFile: "src/other.ts" }),
    ]);
    expect(container.querySelector(".editor-samefile-strip")).toBeNull();
  });

  it("excludes the current user", () => {
    const { container } = renderEditor([
      c({ userId: 1, name: "Me", activeFile: "src/a.ts" }),
    ]);
    expect(container.querySelector(".editor-samefile-strip")).toBeNull();
  });

  it("de-dupes a multi-tab collaborator to one chip", () => {
    renderEditor([
      c({ clientId: 10, userId: 2, name: "Rahul", activeFile: "src/a.ts" }),
      c({ clientId: 11, userId: 2, name: "Rahul", activeFile: "src/a.ts" }),
    ]);
    expect(screen.getAllByText(/Rahul ·/).length).toBe(1);
  });
});
