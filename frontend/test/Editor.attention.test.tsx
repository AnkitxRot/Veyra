import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import * as React from "react";
import {
  monaco,
  __getLastEditorInstance,
  __resetMonacoMocks,
} from "./mocks/monaco";
import type { AttentionEvent } from "../src/collab/attention";

vi.mock("../src/monacoSetup", () => ({ monaco }));

import Editor from "../src/components/Editor/Editor";

afterEach(() => {
  cleanup();
  __resetMonacoMocks();
});

const evt = (over: Partial<AttentionEvent>): AttentionEvent => ({
  id: over.id ?? Math.random().toString(16).slice(2),
  kind: over.kind ?? "point",
  author: over.author ?? { userId: 7, username: "Rahul", color: "#89b4fa" },
  file: over.file ?? "src/a.ts",
  range: over.range ?? {
    startLine: 12,
    startColumn: 1,
    endLine: 12,
    endColumn: 1,
  },
  message: over.message,
  targetUserId: over.targetUserId,
  createdAt: over.createdAt ?? Date.now(),
  expiresAt: over.expiresAt ?? Date.now() + 90_000,
});

const NOOP = () => {};
const LIVE_REF = { current: null };
const OPEN_FILES = [{ path: "src/a.ts", content: "hello world", dirty: false }];

function editorEl(attention: AttentionEvent[]) {
  return React.createElement(Editor, {
    project: {},
    openFiles: OPEN_FILES,
    setOpenFiles: NOOP,
    activeFile: "src/a.ts",
    setActiveFile: NOOP,
    liveApiRef: LIVE_REF,
    isReadOnly: false,
    collaborators: [],
    currentUserId: 1,
    attention,
  } as any);
}

function renderEditor(attention: AttentionEvent[]) {
  const utils = render(editorEl(attention));
  return { ...utils, editor: __getLastEditorInstance()! };
}

describe("M58 — Editor attention decorations", () => {
  it("renders a point decoration for the author's line", () => {
    const { editor } = renderEditor([evt({ kind: "point", file: "src/a.ts" })]);
    const coll = editor.decorationCollections[0];
    expect(coll).toBeTruthy();
    expect(coll.decorations.length).toBe(1);
    const d = coll.decorations[0] as {
      options: { className?: string; overviewRuler?: unknown };
    };
    expect(
      d.options.className?.includes("attention") || d.options.overviewRuler,
    ).toBeTruthy();
  });

  it("renders a callout bubble with the message as TEXT (no HTML injection)", () => {
    renderEditor([
      evt({
        kind: "callout",
        file: "src/a.ts",
        message: `<img src=x onerror="window.__pwned=1">`,
      }),
    ]);
    const bubble = document.querySelector(".attention-callout-bubble")!;
    expect(bubble).toBeTruthy();
    expect(bubble.textContent).toContain(
      '<img src=x onerror="window.__pwned=1">',
    );
    expect(bubble.querySelector("img")).toBeNull();
    expect(
      (window as unknown as { __pwned?: number }).__pwned,
    ).toBeUndefined();
  });

  it("clears decorations and widgets when the attention list empties", () => {
    const { rerender, editor } = renderEditor([
      evt({ kind: "callout", file: "src/a.ts", message: "x" }),
    ]);
    expect(document.querySelector(".attention-callout-bubble")).not.toBeNull();
    rerender(editorEl([]));
    expect(document.querySelector(".attention-callout-bubble")).toBeNull();
    expect(editor.decorationCollections[0].decorations.length).toBe(0);
  });

  it("does not mutate the Monaco model", () => {
    const { editor } = renderEditor([
      evt({ kind: "point", file: "src/a.ts" }),
      evt({ kind: "callout", file: "src/a.ts", message: "x" }),
    ]);
    expect(editor.getValue()).toBe("hello world");
  });

  it("registers the three attention editor actions", () => {
    const { editor } = renderEditor([]);
    expect(editor.actions.has("cloudide.attention.point")).toBe(true);
    expect(editor.actions.has("cloudide.attention.callout")).toBe(true);
    expect(editor.actions.has("cloudide.attention.comeLook")).toBe(true);
  });

  it("M59 — clicking a callout bubble dispatches ide-attention-activate with its id", () => {
    const spy = vi.fn();
    const h = (e: Event) => spy((e as CustomEvent).detail);
    document.addEventListener("ide-attention-activate", h);
    renderEditor([
      evt({ kind: "callout", id: "c9", file: "src/a.ts", message: "look" }),
    ]);
    (
      document.querySelector(".attention-callout-bubble") as HTMLElement
    ).click();
    expect(spy).toHaveBeenCalledWith({ id: "c9" });
    document.removeEventListener("ide-attention-activate", h);
  });

  it("M59 — the callout Follow button dispatches ide-attention-follow, not activate", () => {
    const act = vi.fn();
    const fol = vi.fn();
    const ha = (e: Event) => act((e as CustomEvent).detail);
    const hf = (e: Event) => fol((e as CustomEvent).detail);
    document.addEventListener("ide-attention-activate", ha);
    document.addEventListener("ide-attention-follow", hf);
    renderEditor([
      evt({ kind: "callout", id: "c10", file: "src/a.ts", message: "x" }),
    ]);
    (
      document.querySelector(
        ".attention-callout-bubble button.attention-callout-follow",
      ) as HTMLElement
    ).click();
    expect(fol).toHaveBeenCalledWith({ id: "c10" });
    expect(act).not.toHaveBeenCalled();
    document.removeEventListener("ide-attention-activate", ha);
    document.removeEventListener("ide-attention-follow", hf);
  });

  it("M59 — clicking a point chip dispatches ide-attention-activate", () => {
    const spy = vi.fn();
    const h = (e: Event) => spy((e as CustomEvent).detail);
    document.addEventListener("ide-attention-activate", h);
    renderEditor([evt({ kind: "point", id: "p9", file: "src/a.ts" })]);
    (
      document.querySelector(".attention-point-chip") as HTMLElement
    ).click();
    expect(spy).toHaveBeenCalledWith({ id: "p9" });
    document.removeEventListener("ide-attention-activate", h);
  });
});
