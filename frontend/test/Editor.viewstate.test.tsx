import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";
import {
  monaco,
  __getLastEditorInstance,
  __resetMonacoMocks,
} from "./mocks/monaco";
vi.mock("../src/monacoSetup", () => ({ monaco }));
import Editor, { type EditorViewApi } from "../src/components/Editor/Editor";

afterEach(() => {
  cleanup();
  __resetMonacoMocks();
});

const NOOP = () => {};
const LIVE_REF = { current: null };

function el(
  activeFile: string,
  openFiles: unknown[],
  viewRef: React.MutableRefObject<EditorViewApi | null>,
) {
  return React.createElement(Editor, {
    project: {},
    openFiles,
    setOpenFiles: NOOP,
    activeFile,
    setActiveFile: NOOP,
    liveApiRef: LIVE_REF,
    isReadOnly: false,
    collaborators: [],
    currentUserId: 1,
    editorViewApiRef: viewRef,
  } as any);
}

// one stable viewRef per test module load — reset in afterEach via cleanup
const VIEW_REF = {
  current: null,
} as React.MutableRefObject<EditorViewApi | null>;

function mount(openFiles: unknown[], activeFile: string) {
  const utils = render(el(activeFile, openFiles, VIEW_REF));
  return { ...utils, viewRef: VIEW_REF, editor: __getLastEditorInstance()! };
}

const FILES = [
  { path: "a.ts", content: "hello", dirty: false },
  { path: "b.ts", content: "world", dirty: false },
];

describe("M59 — Editor model-safe view state", () => {
  it("save() returns the active file + an opaque view-state token", () => {
    const { viewRef } = mount([FILES[0]], "a.ts");
    const saved = viewRef.current!.save()!;
    expect(saved.filePath).toBe("a.ts");
    expect((saved.viewState as { __vs?: boolean }).__vs).toBe(true);
  });

  it("restore() refuses when the active model is a different file", () => {
    const { viewRef, editor } = mount(FILES, "a.ts");
    const saved = viewRef.current!.save()!;
    expect(viewRef.current!.restore("b.ts", saved.viewState)).toBe(false);
    expect(editor.restoreCalls.length).toBe(0);
  });

  it("restore() applies the view state when the active model matches", () => {
    const { viewRef, editor } = mount([FILES[0]], "a.ts");
    const saved = viewRef.current!.save()!;
    expect(viewRef.current!.restore("a.ts", saved.viewState)).toBe(true);
    expect(editor.restoreCalls.length).toBe(1);
    expect(editor.restoreCalls[0].modelPath).toBe("a.ts");
    expect(editor.restoreCalls[0].vs).toBe(saved.viewState);
  });

  it("ide-restore-view-state defers until the correct model is active, then restores once", () => {
    const { viewRef, editor, rerender } = mount(FILES, "a.ts");
    const saved = viewRef.current!.save()!;

    rerender(el("b.ts", FILES, viewRef));
    act(() => {
      document.dispatchEvent(
        new CustomEvent("ide-restore-view-state", {
          detail: {
            filePath: "a.ts",
            viewState: saved.viewState,
            cursor: { line: 3, column: 1 },
          },
        }),
      );
    });
    // b.ts is active → NOT restored yet
    expect(editor.restoreCalls.length).toBe(0);

    rerender(el("a.ts", FILES, viewRef));
    expect(editor.restoreCalls.length).toBe(1);
    expect(editor.restoreCalls[0].modelPath).toBe("a.ts");
    expect(editor.restoreCalls[0].vs).toBe(saved.viewState);
  });

  it("restores immediately when the file is already active", () => {
    const { viewRef, editor } = mount([FILES[0]], "a.ts");
    const saved = viewRef.current!.save()!;
    act(() => {
      document.dispatchEvent(
        new CustomEvent("ide-restore-view-state", {
          detail: { filePath: "a.ts", viewState: saved.viewState, cursor: null },
        }),
      );
    });
    expect(editor.restoreCalls.length).toBe(1);
  });

  it("falls back to a cursor reveal when there is no saved view state", () => {
    const { editor } = mount([FILES[0]], "a.ts");
    const spy = vi.spyOn(editor, "revealPositionInCenter");
    act(() => {
      document.dispatchEvent(
        new CustomEvent("ide-restore-view-state", {
          detail: { filePath: "a.ts", viewState: null, cursor: { line: 7, column: 2 } },
        }),
      );
    });
    expect(editor.restoreCalls.length).toBe(0);
    expect(spy).toHaveBeenCalledWith({ lineNumber: 7, column: 2 });
  });

  it("does not mutate the model", () => {
    const { editor, viewRef } = mount([FILES[0]], "a.ts");
    const saved = viewRef.current!.save()!;
    viewRef.current!.restore("a.ts", saved.viewState);
    expect(editor.getValue()).toBe("hello");
  });
});
