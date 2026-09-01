import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import * as React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  monaco,
  __resetMonacoMocks,
} from "./mocks/monaco";
import type { CollaboratorPresence } from "../src/collab/presence";
import type { AttentionEvent } from "../src/collab/attention";

vi.mock("../src/monacoSetup", () => ({ monaco }));

import Editor from "../src/components/Editor/Editor";

const here = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  cleanup();
  __resetMonacoMocks();
});

describe("M58 — attention x Follow / M57 coexistence", () => {
  it("attention navigation does not cancel Follow (no handleUserEdit / setFollowedUserId in the nav handlers)", () => {
    const src = readFileSync(
      join(here, "../src/components/IDE/IDE.tsx"),
      "utf-8",
    );
    const nav = src.slice(
      src.indexOf("const handleAttentionNavigate"),
      src.indexOf("const handleAttentionDismiss"),
    );
    expect(nav).toContain("openAndRevealLocation");
    expect(nav).not.toContain("setFollowedUserId");
    expect(nav).not.toContain("handleUserEdit");
  });

  it("the M57 same-file strip and an M58 callout bubble coexist (not merged / duplicated)", () => {
    const collab: CollaboratorPresence = {
      clientId: 1,
      userId: 2,
      name: "Rahul",
      role: "editor",
      color: "#89b4fa",
      status: "online",
      activity: { type: "editing", timestamp: 0 },
      activeFile: "a.ts",
      lastActive: 0,
    };
    const callout: AttentionEvent = {
      id: "cid0000000000000",
      kind: "callout",
      author: { userId: 2, username: "Rahul", color: "#89b4fa" },
      file: "a.ts",
      range: { startLine: 3, startColumn: 1, endLine: 5, endColumn: 1 },
      message: "look here",
      createdAt: Date.now(),
      expiresAt: Date.now() + 90_000,
    };
    render(
      React.createElement(Editor, {
        project: {},
        openFiles: [{ path: "a.ts", content: "x", dirty: false }],
        setOpenFiles: () => {},
        activeFile: "a.ts",
        setActiveFile: () => {},
        liveApiRef: { current: null },
        isReadOnly: false,
        collaborators: [collab],
        currentUserId: 1,
        attention: [callout],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );
    expect(document.querySelectorAll(".editor-samefile-strip")).toHaveLength(1);
    expect(document.querySelectorAll(".attention-callout-bubble")).toHaveLength(
      1,
    );
    expect(screen.getByText(/Rahul ·/)).toBeTruthy();
    expect(
      document.querySelector(".attention-callout-msg")?.textContent,
    ).toBe("look here");
  });
});
