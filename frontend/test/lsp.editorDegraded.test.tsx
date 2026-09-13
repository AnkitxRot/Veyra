import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import * as React from "react";
import { monaco, __resetMonacoMocks } from "./mocks/monaco";
import { vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/monacoSetup", () => ({ monaco }));

import Editor from "../src/components/Editor/Editor";

describe("Editor language intelligence degrades without a project", () => {
  beforeEach(() => {
    __resetMonacoMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it("still mounts and edits when no projectId is provided", () => {
    const setOpenFiles = () => {};
    const setActiveFile = () => {};
    render(
      React.createElement(Editor, {
        project: {},
        openFiles: [{ path: "main.py", content: "print(1)\n", dirty: false }],
        setOpenFiles,
        activeFile: "main.py",
        setActiveFile,
      }),
    );
    const editor = (monaco as any).editor;
    expect(editor.getModels().length).toBeGreaterThan(0);
  });
});
