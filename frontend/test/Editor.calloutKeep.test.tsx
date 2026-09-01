import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import * as React from "react";
import { monaco, __getLastEditorInstance, __resetMonacoMocks } from "./mocks/monaco";
import type { AttentionEvent } from "../src/collab/attention";

vi.mock("../src/monacoSetup", () => ({ monaco }));

import Editor from "../src/components/Editor/Editor";

beforeEach(() => {
  document.querySelectorAll(".attention-callout-bubble, .attention-point-chip, .attention-callout-keep, .comment-chip, .comment-glyph").forEach((n) => n.remove());
});
afterEach(() => {
  cleanup();
  __resetMonacoMocks();
  document.querySelectorAll(".attention-callout-bubble, .attention-point-chip, .attention-callout-keep, .comment-chip, .comment-glyph").forEach((n) => n.remove());
});

const evt = (over: Partial<AttentionEvent>): AttentionEvent => ({
  id: over.id ?? Math.random().toString(16).slice(2),
  kind: "callout",
  author: over.author ?? { userId: 7, username: "Rahul", color: "#89b4fa" },
  file: over.file ?? "src/a.ts",
  range: over.range ?? { startLine: 3, startColumn: 1, endLine: 3, endColumn: 10 },
  message: over.message ?? "look at this",
  createdAt: over.createdAt ?? Date.now(),
  expiresAt: over.expiresAt ?? Date.now() + 90000,
});

const NOOP = () => {};
const LIVE_REF = { current: null };
const OPEN_FILES = [{ path: "src/a.ts", content: "line1\nline2\nTARGET\nline4\n", dirty: false }];

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

describe("M61-A Keep as comment — Editor callout bubble", () => {
  it("renders a Keep as comment button in the callout bubble", () => {
    render(editorEl([evt({ id: "c1", message: "please keep" })]));
    const btn = document.querySelector(".attention-callout-keep") as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toBe("Keep as comment");
    expect(btn!.getAttribute("aria-label")).toBe("Keep as comment");
  });

  it("clicking Keep dispatches ide-attention-keep-as-comment with the callout id and does not dismiss the callout", () => {
    const keepSpy = vi.fn();
    const hKeep = (e: Event) => keepSpy((e as CustomEvent).detail);
    document.addEventListener("ide-attention-keep-as-comment", hKeep);
    // Also listen for dismiss to ensure it is not fired
    // The callout's dismiss is via attentionStore.dismissLocal, not a DOM event, so we check the bubble still exists
    render(editorEl([evt({ id: "keep-1", message: "keep me" })]));
    const keepBtn = document.querySelector(".attention-callout-keep") as HTMLElement;
    expect(keepBtn).toBeTruthy();
    keepBtn.click();
    expect(keepSpy).toHaveBeenCalledWith({ id: "keep-1" });
    // Bubble should still be in DOM (not removed) immediately after Keep
    expect(document.querySelector(".attention-callout-bubble")).not.toBeNull();
    // The attention list still contains the callout (we didn't clear attention)
    expect(document.querySelector(".attention-callout-bubble")!.textContent).toContain("keep me");
    document.removeEventListener("ide-attention-keep-as-comment", hKeep);
  });

  it("Keep button does not appear for point attention (only callout)", () => {
    document.querySelectorAll(".attention-callout-bubble, .attention-point-chip, .attention-callout-keep").forEach((n) => n.remove());
    const point: AttentionEvent = {
      id: "p1",
      kind: "point",
      author: { userId: 7, username: "Rahul", color: "#89b4fa" },
      file: "src/a.ts",
      range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 10 },
      createdAt: Date.now(),
      expiresAt: Date.now() + 90000,
    };
    render(editorEl([point]));
    // Points create a chip, not a callout bubble, so no Keep button
    expect(document.querySelector(".attention-callout-bubble")).toBeNull();
    expect(document.querySelector(".attention-callout-keep")).toBeNull();
    expect(document.querySelector(".attention-point-chip")).not.toBeNull();
  });

  it("clears Keep button when the callout expires (list empties)", () => {
    const { rerender } = render(editorEl([evt({ id: "c2", message: "x" })]));
    expect(document.querySelector(".attention-callout-keep")).not.toBeNull();
    rerender(editorEl([]));
    expect(document.querySelector(".attention-callout-keep")).toBeNull();
    expect(document.querySelector(".attention-callout-bubble")).toBeNull();
  });
});
