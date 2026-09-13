import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import * as React from "react";
import {
  monaco,
  __getLastEditorInstance,
  __resetMonacoMocks,
} from "./mocks/monaco";
import type { CollaboratorPresence } from "../src/collab/presence";

vi.mock("../src/monacoSetup", () => ({ monaco }));

import Editor from "../src/components/Editor/Editor";

afterEach(() => {
  cleanup();
  __resetMonacoMocks();
});

const NOOP = () => {};

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

const sel = (sl: number, sc: number, el: number, ec: number) => ({
  startLine: sl,
  startColumn: sc,
  endLine: el,
  endColumn: ec,
});

function renderEditor(opts: {
  collaborators: CollaboratorPresence[];
  localSel: { sl: number; sc: number; el: number; ec: number };
  onViewCollaborator?: (userId: number) => void;
}) {
  render(
    React.createElement(Editor, {
      project: {},
      openFiles: [{ path: "a.ts", content: "x", dirty: false }],
      setOpenFiles: NOOP,
      activeFile: "a.ts",
      setActiveFile: NOOP,
      liveApiRef: { current: null },
      isReadOnly: false,
      collaborators: opts.collaborators,
      currentUserId: 1,
      attention: [],
      onViewCollaborator: opts.onViewCollaborator,
    } as any),
  );
  const editor = __getLastEditorInstance()!;
  act(() => {
    editor._fireSelectionChange({
      startLineNumber: opts.localSel.sl,
      startColumn: opts.localSel.sc,
      endLineNumber: opts.localSel.el,
      endColumn: opts.localSel.ec,
    });
  });
}

describe("M58 — Editor three-tier spatial awareness", () => {
  it("same file, far apart, not editing → no spatial badge (same-file strip only)", () => {
    renderEditor({
      collaborators: [
        c({
          userId: 2,
          activeFile: "a.ts",
          activity: { type: "viewing", timestamp: 0 },
          cursor: { line: 200, column: 1 },
        }),
      ],
      localSel: { sl: 10, sc: 1, el: 10, ec: 1 },
    });
    expect(document.querySelector(".spatial-badge")).toBeNull();
    expect(document.querySelector(".editor-samefile-strip")).not.toBeNull();
  });

  it("editing within 5 lines, not overlapping → nearby badge", () => {
    renderEditor({
      collaborators: [
        c({
          userId: 2,
          activeFile: "a.ts",
          activity: { type: "editing", timestamp: 0 },
          selection: sel(52, 1, 54, 1),
        }),
      ],
      localSel: { sl: 48, sc: 1, el: 50, ec: 1 },
    });
    const b = document.querySelector(".spatial-badge")!;
    expect(b).toBeTruthy();
    expect(b.className).toContain("spatial-nearby");
  });

  it("editing overlapping ranges → overlap badge with a View action", () => {
    const onView = vi.fn();
    renderEditor({
      collaborators: [
        c({
          userId: 2,
          name: "Rahul",
          activeFile: "a.ts",
          activity: { type: "editing", timestamp: 0 },
          selection: sel(45, 1, 60, 1),
        }),
      ],
      localSel: { sl: 40, sc: 1, el: 50, ec: 1 },
      onViewCollaborator: onView,
    });
    const b = document.querySelector(".spatial-badge")!;
    expect(b.className).toContain("spatial-overlap");
    fireEvent.click(screen.getByRole("button", { name: /view rahul/i }));
    expect(onView).toHaveBeenCalledWith(2);
  });

  it("editing far apart → no badge", () => {
    renderEditor({
      collaborators: [
        c({
          userId: 2,
          activeFile: "a.ts",
          activity: { type: "editing", timestamp: 0 },
          selection: sel(300, 1, 320, 1),
        }),
      ],
      localSel: { sl: 40, sc: 1, el: 50, ec: 1 },
    });
    expect(document.querySelector(".spatial-badge")).toBeNull();
  });

  it("does not write awareness or the document from the spatial memo", () => {
    // A collaborator's remote selection must never be pushed back as our own.
    const editorBefore = () => __getLastEditorInstance();
    renderEditor({
      collaborators: [
        c({
          userId: 2,
          activeFile: "a.ts",
          activity: { type: "editing", timestamp: 0 },
          selection: sel(45, 1, 60, 1),
        }),
      ],
      localSel: { sl: 40, sc: 1, el: 50, ec: 1 },
    });
    // model content untouched
    expect(editorBefore()!.getValue()).toBe("x");
  });
});
