import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";
import {
  monaco,
  __resetMonacoMocks,
  __getLastEditorInstance,
  __getEditorCreateCount,
  __getSetThemeCalls,
} from "./mocks/monaco";
vi.mock("../src/monacoSetup", () => ({ monaco }));
import Editor from "../src/components/Editor/Editor";

afterEach(() => {
  cleanup();
  __resetMonacoMocks();
});

const NOOP = () => {};
const LIVE_REF = { current: null };

function el(resolvedTheme: "dark" | "light", openFiles: unknown[], activeFile: string) {
  return React.createElement(Editor, {
    project: {},
    openFiles,
    setOpenFiles: NOOP,
    activeFile,
    setActiveFile: NOOP,
    resolvedTheme,
    liveApiRef: LIVE_REF,
    isReadOnly: false,
    collaborators: [],
    currentUserId: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const FILE = { path: "main.py", content: "print('hi')\n" };

describe("M69 — Editor Monaco theme sync", () => {
  it("creates the editor with the Monaco light theme when resolvedTheme is light", () => {
    render(el("light", [FILE], "main.py"));
    expect(__getLastEditorInstance()?.options.theme).toBe("vs");
    expect(__getEditorCreateCount()).toBe(1);
  });

  it("creates the editor with vs-dark when resolvedTheme is dark", () => {
    render(el("dark", [FILE], "main.py"));
    expect(__getLastEditorInstance()?.options.theme).toBe("vs-dark");
  });

  it("switches the live editor's theme via setTheme without recreating it", () => {
    const view = render(el("dark", [FILE], "main.py"));
    const instanceBefore = __getLastEditorInstance();
    const modelBefore = instanceBefore?.getModel();
    expect(__getEditorCreateCount()).toBe(1);

    act(() => {
      view.rerender(el("light", [FILE], "main.py"));
    });

    expect(__getSetThemeCalls()).toContain("vs");
    // the SAME editor instance and model — no remount, no model replacement
    expect(__getLastEditorInstance()).toBe(instanceBefore);
    expect(__getEditorCreateCount()).toBe(1);
    expect(__getLastEditorInstance()?.getModel()).toBe(modelBefore);
    expect(__getLastEditorInstance()?.options.theme).toBe("vs");
  });

  it("switching back to dark calls setTheme('vs-dark'), still one create", () => {
    const view = render(el("dark", [FILE], "main.py"));
    act(() => view.rerender(el("light", [FILE], "main.py")));
    act(() => view.rerender(el("dark", [FILE], "main.py")));
    expect(__getSetThemeCalls()).toEqual(["vs", "vs-dark"]);
    expect(__getEditorCreateCount()).toBe(1);
  });

  it("preserves the editor's saved view state across a theme switch", () => {
    const view = render(el("dark", [FILE], "main.py"));
    const inst = __getLastEditorInstance()!;
    const vs = inst.saveViewState();
    act(() => view.rerender(el("light", [FILE], "main.py")));
    // same instance → its view state is still restorable
    inst.restoreViewState(vs);
    expect(inst.lastRestoredViewState).toBe(vs);
    expect(__getEditorCreateCount()).toBe(1);
  });
});
