import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import * as React from "react";
import {
  monaco,
  __resetMonacoMocks,
  __getLastEditorInstance,
} from "./mocks/monaco";

vi.mock("../src/monacoSetup", () => ({ monaco }));

import Editor, { getLiveContent } from "../src/components/Editor/Editor";

type OpenFile = { path: string; content: string; dirty?: boolean };

function renderEditor(
  overrides: {
    openFiles?: OpenFile[];
    activeFile?: string | null;
    isReadOnly?: boolean;
  } = {},
) {
  const liveApiRef = { current: null } as React.MutableRefObject<any>;
  // Stable across a test's lifetime: Editor's mount effect depends on
  // [setOpenFiles, liveApiRef], so a fresh setOpenFiles reference on rerender
  // would tear down and recreate the (fake) Monaco editor instance.
  const setOpenFiles = () => {};
  const setActiveFile = () => {};
  const openFiles = overrides.openFiles ?? [
    { path: "main.py", content: "print('open-time')", dirty: false },
  ];
  const activeFile = overrides.activeFile ?? "main.py";
  const isReadOnly = overrides.isReadOnly ?? false;

  const utils = render(
    React.createElement(Editor, {
      project: {},
      openFiles,
      setOpenFiles,
      activeFile,
      setActiveFile,
      liveApiRef,
      isReadOnly,
    }),
  );

  return { ...utils, liveApiRef, setOpenFiles, setActiveFile };
}

describe("Editor — save truthfulness (M1 regression: BUG-1) and read-only sync", () => {
  beforeEach(() => {
    __resetMonacoMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it("getLiveContent reflects the current Monaco model content, not the stale open-time snapshot", () => {
    const { liveApiRef } = renderEditor();
    const editorInstance = __getLastEditorInstance()!;
    const model = editorInstance.getModel()!;

    // Simulate the user typing: real Monaco mutates the model's value in
    // place and fires onDidChangeModelContent, exactly like this handler
    // in Editor.tsx expects.
    model.setValue("print('live edit, never synced to React state')");
    editorInstance._fireContentChange();

    expect(getLiveContent("main.py")).toBe(
      "print('live edit, never synced to React state')",
    );
    expect(liveApiRef.current!.get("main.py")).toBe(
      "print('live edit, never synced to React state')",
    );
    // The exact defect BUG-1 guarded against: falling back to
    // openFiles[].content, which is still the stale open-time string here.
    expect(liveApiRef.current!.get("main.py")).not.toBe("print('open-time')");
  });

  it("Monaco's own Ctrl+S command dispatches ide-save with the live content, not stale props", async () => {
    renderEditor();
    const editorInstance = __getLastEditorInstance()!;
    const model = editorInstance.getModel()!;
    model.setValue("edited-before-save");

    const handler = editorInstance.commands.get("__last__")!;
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    document.addEventListener("ide-save", listener);
    try {
      await handler();
    } finally {
      document.removeEventListener("ide-save", listener);
    }

    expect(events).toHaveLength(1);
    expect(events[0].detail.path).toBe("main.py");
    expect(events[0].detail.content).toBe("edited-before-save");
  });

  it("getLiveContent returns null once the editor unmounts (never reads from a dead editor)", () => {
    const { unmount } = renderEditor();
    expect(getLiveContent("main.py")).not.toBeNull();

    unmount();
    expect(getLiveContent("main.py")).toBeNull();
  });

  it("applies isReadOnly to the underlying Monaco editor on mount and keeps it in sync on prop changes", () => {
    const { rerender, liveApiRef, setOpenFiles, setActiveFile } = renderEditor({
      isReadOnly: false,
    });
    const editorInstance = __getLastEditorInstance()!;
    expect(editorInstance.options.readOnly).toBe(false);

    rerender(
      React.createElement(Editor, {
        project: {},
        openFiles: [{ path: "main.py", content: "x", dirty: false }],
        setOpenFiles,
        activeFile: "main.py",
        setActiveFile,
        liveApiRef,
        isReadOnly: true,
      }),
    );

    expect(
      editorInstance.updateOptionsCalls.some((c) => c.readOnly === true),
    ).toBe(true);
  });
});
