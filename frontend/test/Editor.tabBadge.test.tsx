import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import * as React from "react";
import { monaco, __resetMonacoMocks } from "./mocks/monaco";

vi.mock("../src/monacoSetup", () => ({ monaco }));
import Editor from "../src/components/Editor/Editor";

afterEach(() => {
  cleanup();
  __resetMonacoMocks();
});

const NOOP = () => {};

function renderEditor(over: Partial<React.ComponentProps<typeof Editor>> = {}) {
  return render(
    React.createElement(Editor as any, {
      project: {},
      openFiles: [
        { path: "src/a.ts", content: "hello", dirty: false },
        { path: "auth/session.ts", content: "world", dirty: false },
      ],
      setOpenFiles: NOOP,
      activeFile: "src/a.ts",
      setActiveFile: NOOP,
      collaborators: [],
      currentUserId: 1,
      commentCountsByFile: new Map([
        ["src/a.ts", 1],
        ["auth/session.ts", 2],
      ]),
      ...over,
    }),
  );
}

describe("M61-A Editor tab unresolved indicators", () => {
  it("shows 💬 badge on tabs with unresolved comments", () => {
    const { container } = renderEditor();
    const badges = container.querySelectorAll(".tab-comment-badge");
    expect(badges.length).toBe(2);
    const texts = Array.from(badges).map((n) => n.textContent);
    expect(texts.join(" ")).toContain("💬 1");
    expect(texts.join(" ")).toContain("💬 2");
  });

  it("shows no badge when count is zero", () => {
    const { container } = renderEditor({ commentCountsByFile: new Map() } as any);
    expect(container.querySelectorAll(".tab-comment-badge").length).toBe(0);
  });

  it("does not show badge for closed file (openFiles filtering)", () => {
    const { container } = renderEditor({
      openFiles: [{ path: "src/a.ts", content: "hello", dirty: false }],
      commentCountsByFile: new Map([["auth/session.ts", 5]]),
    } as any);
    // Only src/a.ts tab is open, but its count is not 5, so no badge for auth/session.ts
    // auth/session.ts is not an open tab, so its badge should not appear in tabs
    const badges = container.querySelectorAll(".tab-comment-badge");
    expect(badges.length).toBe(0);
  });

  it("badge is subtle and has accessible title", () => {
    const { container } = renderEditor();
    const badge = container.querySelector(".tab-comment-badge") as HTMLElement;
    expect(badge.getAttribute("aria-label")).toMatch(/unresolved comments/);
    expect(badge.getAttribute("title")).toMatch(/unresolved/);
  });
});
