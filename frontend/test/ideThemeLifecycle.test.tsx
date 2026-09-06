import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";
import {
  monaco,
  __resetMonacoMocks,
  __getEditorCreateCount,
  __getSetThemeCalls,
  __getLastEditorInstance,
} from "./mocks/monaco";
vi.mock("../src/monacoSetup", () => ({ monaco }));

import { useAppearance } from "../src/hooks/useAppearance";
import Editor from "../src/components/Editor/Editor";

// M69 — end-to-end theme lifecycle: the real `useAppearance` hook feeding the
// real `<Editor>` through the same `resolvedTheme` prop IDE.tsx uses. Proves
// a theme change re-themes Monaco in place (no recreate, view state kept) and
// that `prefers-color-scheme` is followed only in system mode with a listener
// that is cleaned up.

function installMatchMedia(initialLight: boolean) {
  const state = { light: initialLight };
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  (window as any).matchMedia = vi.fn(() => ({
    get matches() {
      return state.light;
    },
    media: "(prefers-color-scheme: light)",
    addEventListener: (_t: string, cb: any) => listeners.add(cb),
    removeEventListener: (_t: string, cb: any) => listeners.delete(cb),
    addListener: (cb: any) => listeners.add(cb),
    removeListener: (cb: any) => listeners.delete(cb),
    dispatchEvent: () => true,
  }));
  return {
    listenerCount: () => listeners.size,
    setLight(v: boolean) {
      state.light = v;
      act(() => {
        for (const cb of listeners) cb({ matches: v } as MediaQueryListEvent);
      });
    },
  };
}

const NOOP = () => {};
const FILE = { path: "main.py", content: "print('x')\n" };
// Stable refs — IDE.tsx passes `useRef` objects; an inline literal per render
// would churn the Editor's create effect and remount it (not a product bug).
const LIVE_REF = { current: null };
const OPEN_FILES = [FILE];
const EMPTY_ARR: never[] = [];
const EMPTY_PROJECT = {};

/** Mirrors IDE.tsx: one useAppearance from the preference, `resolvedTheme`
 *  into the Editor. `layoutHint` stands in for an unrelated preference that
 *  must be undisturbed by theme changes. */
function ThemedIde({
  preference,
  layoutHint = "start",
}: {
  preference: "system" | "dark" | "light";
  layoutHint?: string;
}) {
  const { resolvedTheme } = useAppearance(preference);
  return (
    <div data-testid="layout-hint" data-hint={layoutHint}>
      {React.createElement(Editor, {
        project: EMPTY_PROJECT,
        openFiles: OPEN_FILES,
        setOpenFiles: NOOP,
        activeFile: "main.py",
        setActiveFile: NOOP,
        resolvedTheme,
        liveApiRef: LIVE_REF,
        isReadOnly: false,
        collaborators: EMPTY_ARR,
        currentUserId: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)}
    </div>
  );
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  cleanup();
  __resetMonacoMocks();
  delete (window as any).matchMedia;
});

describe("M69 — theme lifecycle (integration)", () => {
  it("hydrates the resolved theme onto <html> immediately", () => {
    installMatchMedia(true);
    render(<ThemedIde preference="system" />);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(__getLastEditorInstance()?.options.theme).toBe("vs");
  });

  it("an explicit preference change re-themes Monaco without recreating it", () => {
    installMatchMedia(false);
    const view = render(<ThemedIde preference="dark" />);
    const inst = __getLastEditorInstance();
    const model = inst?.getModel();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(__getEditorCreateCount()).toBe(1);

    act(() => view.rerender(<ThemedIde preference="light" />));

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(__getSetThemeCalls()).toContain("vs");
    expect(__getEditorCreateCount()).toBe(1); // no remount
    expect(__getLastEditorInstance()).toBe(inst); // same instance
    expect(__getLastEditorInstance()?.getModel()).toBe(model); // same model
  });

  it("follows a live prefers-color-scheme change in system mode, no remount", () => {
    const mm = installMatchMedia(false);
    render(<ThemedIde preference="system" />);
    expect(document.documentElement.dataset.theme).toBe("dark");

    mm.setLight(true);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(__getSetThemeCalls()).toContain("vs");
    expect(__getEditorCreateCount()).toBe(1);
  });

  it("ignores a prefers-color-scheme change under an explicit preference", () => {
    const mm = installMatchMedia(false);
    render(<ThemedIde preference="dark" />);
    mm.setLight(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(__getSetThemeCalls()).not.toContain("vs");
  });

  it("registers exactly one media-query listener in system mode and drops it on unmount", () => {
    const mm = installMatchMedia(false);
    const view = render(<ThemedIde preference="system" />);
    expect(mm.listenerCount()).toBe(1);
    view.unmount();
    expect(mm.listenerCount()).toBe(0);
  });

  it("switching to an explicit preference removes the system listener", () => {
    const mm = installMatchMedia(false);
    const view = render(<ThemedIde preference="system" />);
    expect(mm.listenerCount()).toBe(1);
    act(() => view.rerender(<ThemedIde preference="light" />));
    expect(mm.listenerCount()).toBe(0);
  });

  it("a theme change leaves an unrelated preference untouched", () => {
    installMatchMedia(false);
    const view = render(
      <ThemedIde preference="dark" layoutHint="keep-me" />,
    );
    act(() =>
      view.rerender(<ThemedIde preference="light" layoutHint="keep-me" />),
    );
    expect(
      view.getByTestId("layout-hint").getAttribute("data-hint"),
    ).toBe("keep-me");
    expect(__getEditorCreateCount()).toBe(1);
  });
});
