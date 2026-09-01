// Regression test for a live-browser-verified collaborative-editing bug:
// two authenticated sessions opening the same file ended up with different
// Monaco model EOL settings (one LF, one CRLF) even though the backend
// (files/service.ts, collab/manager.ts) only ever reads/writes/seeds raw
// "\n" content. The divergence surfaced when Monaco's own EOL-detection
// falls back to a platform default (CRLF on Windows) for a model created
// with still-empty content — a real race between this effect running and
// the REST fetch / collab Y.Text seed resolving. Once one client's model
// is CRLF, its keystrokes translate into Y.Text character offsets assuming
// 2-byte line breaks that don't exist in the shared \n-only document, so a
// same-line edit lands at a different position for other collaborators
// (verified live: an edit appended after "greet(\"world\");" showed up one
// line later, with a spurious blank line, on the LF-side client).
//
// Fix: Editor.tsx pins the model to LF immediately after createModel(),
// removing the platform/content-detection race entirely.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import * as React from "react";
import { monaco, __resetMonacoMocks, __getLastEditorInstance } from "./mocks/monaco";

vi.mock("../src/monacoSetup", () => ({ monaco }));

import Editor from "../src/components/Editor/Editor";

afterEach(() => {
  cleanup();
  __resetMonacoMocks();
});

function renderEditor(content: string, activeFile = "fileA.js") {
  return render(
    React.createElement(Editor, {
      project: {},
      openFiles: [{ path: activeFile, content, dirty: false }],
      setOpenFiles: () => {},
      activeFile,
      setActiveFile: () => {},
      liveApiRef: { current: null } as any,
      isReadOnly: false,
      collaborators: [],
      currentUserId: 1,
    } as any),
  );
}

describe("Editor — model EOL is pinned to LF", () => {
  it("forces LF on a freshly created model with real content", () => {
    renderEditor("function greet(name) {\n  return name;\n}\n");
    const model = __getLastEditorInstance()!.getModel()!;
    expect(model.getEOL()).toBe("\n");
  });

  it("forces LF even when the initial content is still empty (the race)", () => {
    // Mirrors the exact race: this effect can run before the REST fetch or
    // the collab Y.Text seed has resolved, so `activeFileData.content` is
    // still "". Real Monaco would fall back to a platform default here
    // (CRLF on Windows) without the explicit setEOL() pin.
    renderEditor("");
    const model = __getLastEditorInstance()!.getModel()!;
    expect(model.getEOL()).toBe("\n");
  });
});
