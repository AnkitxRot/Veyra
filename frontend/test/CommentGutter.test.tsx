import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import * as React from "react";
import * as Y from "yjs";
import { monaco, __resetMonacoMocks } from "./mocks/monaco";

vi.mock("../src/comments/api", () => ({
  reportAnchorStatus: vi.fn().mockResolvedValue({ ok: true }),
}));

import CommentGutter from "../src/components/Comments/CommentGutter";
import { encodeAnchor } from "../src/comments/anchor";
import { reportAnchorStatus } from "../src/comments/api";

afterEach(() => {
  cleanup();
  __resetMonacoMocks();
  vi.mocked(reportAnchorStatus).mockClear();
  document.querySelectorAll("[data-thread-id]").forEach((n) => n.remove());
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });

// The mock editor / monaco intentionally implement only the slice the
// component touches; render through an `any` prop bag like the other
// Editor mock tests.
const mount = (props: Record<string, unknown>) =>
  render(React.createElement(CommentGutter as never, props as never));

async function makeThread(
  doc: Y.Doc,
  file: string,
  s: number,
  e: number,
  over: Record<string, unknown> = {},
) {
  const a = await encodeAnchor(doc.getText(file), s, e);
  return {
    id: `t-${s}-${Math.random().toString(36).slice(2, 6)}`,
    projectId: "p",
    filePath: file,
    anchor: a,
    anchorStatus: "ok",
    createdBy: 1,
    createdAt: "",
    updatedAt: "",
    resolvedAt: null,
    resolvedBy: null,
    root: { id: "c1", body: "look at this", deletedAt: null, reactions: [] },
    replies: [],
    mentions: [],
    ...over,
  };
}

describe("M61-A CommentGutter", () => {
  it("marks the resolved line for an active thread; nothing for a stale one", async () => {
    const doc = new Y.Doc();
    doc.getText("a.ts").insert(0, "line1\nline2\nTARGET\nline4\n");
    const active = await makeThread(
      doc,
      "a.ts",
      "line1\nline2\n".length,
      "line1\nline2\n".length + "TARGET".length,
    );
    const staleDoc = new Y.Doc();
    staleDoc.getText("a.ts").insert(0, "GONE CONTENT\n");
    const stale = await makeThread(staleDoc, "a.ts", 0, 12, { id: "t-stale" });

    const editor = monaco.editor.create(document.createElement("div"), {});
    mount({
      editor,
      monaco,
      projectId: "p",
      activeFile: "a.ts",
      doc,
      threads: [active, stale],
      onOpenThread: () => {},
    });
    await flush();

    const coll = (editor as unknown as { decorationCollections: any[] })
      .decorationCollections[0];
    const glyphs = coll.decorations.filter(
      (d: any) => d.options.glyphMarginClassName === "comment-glyph",
    );
    expect(glyphs.length).toBe(1);
  });

  it("clicking a marker chip calls onOpenThread(id)", async () => {
    const doc = new Y.Doc();
    doc.getText("a.ts").insert(0, "alpha\nbeta\ngamma\n");
    const t = await makeThread(doc, "a.ts", 0, 5);
    const onOpen = vi.fn();
    const editor = monaco.editor.create(document.createElement("div"), {});
    mount({
      editor,
      monaco,
      projectId: "p",
      activeFile: "a.ts",
      doc,
      threads: [t],
      onOpenThread: onOpen,
    });
    await flush();
    const chip = document.querySelector("[data-thread-id]") as HTMLButtonElement;
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith(t.id);
  });

  it("does not persist a false 'stale' while the Y.Doc is still syncing, and recovers on content change", async () => {
    const file = "a.ts";
    // The authoritative doc — the anchor is encoded against these real items.
    const sourceDoc = new Y.Doc();
    sourceDoc.getText(file).insert(0, "line1\nline2\nTARGET\nline4\n");
    const t = await makeThread(
      sourceDoc,
      file,
      "line1\nline2\n".length,
      "line1\nline2\n".length + "TARGET".length,
      // as if a previous sync-race pass had already persisted a false stale
      { anchorStatus: "stale" },
    );

    // The doc the component gets starts EMPTY (server sync not finished yet).
    const doc = new Y.Doc();
    const editor = monaco.editor.create(document.createElement("div"), {});
    mount({
      editor,
      monaco,
      projectId: "p",
      activeFile: file,
      doc,
      threads: [t],
      onOpenThread: () => {},
    });
    await flush();

    // While the file's Y.Text is empty we must NOT report anything — a
    // resolve here would be a false stale and reportAnchorStatus persists it.
    expect(reportAnchorStatus).not.toHaveBeenCalled();
    expect(document.querySelector("[data-thread-id]")).toBeNull();

    // Sync completes: the real items (and their content) arrive.
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(sourceDoc));
    (editor as unknown as { _fireContentChange: () => void })._fireContentChange();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300)); // clear the 250ms debounce
    });
    await flush();

    // Now it resolves to a real anchor: the marker appears and the stale
    // advisory is corrected back to "ok".
    expect(document.querySelector("[data-thread-id]")).toBeTruthy();
    expect(reportAnchorStatus).toHaveBeenCalledWith("p", t.id, "ok");
  });

  it("recovers via the sync poll when no model content event fires (deferred y-monaco bind)", async () => {
    const file = "a.ts";
    const sourceDoc = new Y.Doc();
    sourceDoc.getText(file).insert(0, "alpha\nbeta\nGAMMA\n");
    const t = await makeThread(
      sourceDoc,
      file,
      "alpha\nbeta\n".length,
      "alpha\nbeta\n".length + "GAMMA".length,
    );

    const doc = new Y.Doc();
    const editor = monaco.editor.create(document.createElement("div"), {});
    mount({
      editor,
      monaco,
      projectId: "p",
      activeFile: file,
      doc,
      threads: [t],
      onOpenThread: () => {},
    });
    await flush();
    expect(document.querySelector("[data-thread-id]")).toBeNull();

    // Content arrives on the Y.Doc, but the editor never fires a content
    // change (e.g. y-monaco has not bound yet — M52 deferred bind window).
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(sourceDoc));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 650)); // past one 500ms poll
    });
    await flush();

    expect(document.querySelector("[data-thread-id]")).toBeTruthy();
  });

  it("never mutates the Monaco model", async () => {
    const doc = new Y.Doc();
    doc.getText("a.ts").insert(0, "one\ntwo\n");
    const t = await makeThread(doc, "a.ts", 0, 3);
    const model = monaco.editor.createModel(
      "one\ntwo\n",
      "typescript",
      monaco.Uri.file("a.ts"),
    );
    const spy = vi.spyOn(model, "pushEditOperations");
    const editor = monaco.editor.create(document.createElement("div"), {});
    editor.setModel(model);
    mount({
      editor,
      monaco,
      projectId: "p",
      activeFile: "a.ts",
      doc,
      threads: [t],
      onOpenThread: () => {},
    });
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });
});
