import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";

// --- xterm / addon / api / transport fakes -------------------------------

const { FakeXTerm, FakeFitAddon, FakeWS } = vi.hoisted(() => {
  class FakeXTerm {
    static instances: FakeXTerm[] = [];
    options: Record<string, unknown>;
    element: unknown = null;
    disposed = false;
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      FakeXTerm.instances.push(this);
    }
    loadAddon() {}
    open() {
      this.element = {};
    }
    writeln() {}
    write() {}
    clear() {}
    focus() {}
    onData() {}
    onResize() {}
    dispose() {
      this.disposed = true;
    }
  }
  class FakeFitAddon {
    fit() {}
  }
  class FakeWS {
    static instances: FakeWS[] = [];
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    closed = false;
    constructor(public url: string) {
      FakeWS.instances.push(this);
    }
    send() {}
    close() {
      this.closed = true;
      this.readyState = FakeWS.CLOSED;
    }
  }
  return { FakeXTerm, FakeFitAddon, FakeWS };
});

vi.mock("@xterm/xterm", () => ({ Terminal: FakeXTerm }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: FakeFitAddon }));
vi.mock("../src/api", () => ({
  getWebSocketUrl: (p: string, id: string) => `ws://test${p}?projectId=${id}`,
}));

import { TERMINAL_THEMES } from "../src/components/Terminal/terminalThemes";
import Terminal from "../src/components/Terminal/Terminal";

beforeEach(() => {
  FakeXTerm.instances = [];
  FakeWS.instances = [];
  (globalThis as any).WebSocket = FakeWS;
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  if (!(globalThis.crypto as any)?.randomUUID) {
    (globalThis as any).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => "uuid-" + Math.random().toString(16).slice(2),
    };
  }
});
afterEach(cleanup);

describe("M69 → M79 — terminal theme sync (in place, session-preserving)", () => {
  it("opens the terminal with the dark palette by default", () => {
    render(<Terminal projectId="p1" resolvedTheme="dark" visible />);
    expect(FakeXTerm.instances).toHaveLength(1);
    expect(
      (FakeXTerm.instances[0].options.theme as any).background,
    ).toBe(TERMINAL_THEMES.dark.background);
  });

  it("opens the terminal with the light palette when resolvedTheme is light", () => {
    render(<Terminal projectId="p1" resolvedTheme="light" visible />);
    expect((FakeXTerm.instances[0].options.theme as any).background).toBe(
      TERMINAL_THEMES.light.background,
    );
  });

  it("updates the live terminal theme in place — no new xterm, no new socket", () => {
    const view = render(
      <Terminal projectId="p1" resolvedTheme="dark" visible />,
    );
    const term = FakeXTerm.instances[0];
    expect(FakeWS.instances).toHaveLength(1);

    act(() => {
      view.rerender(<Terminal projectId="p1" resolvedTheme="light" visible />);
    });

    expect(FakeXTerm.instances).toHaveLength(1);
    expect(FakeXTerm.instances[0]).toBe(term);
    expect(term.disposed).toBe(false);
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0].closed).toBe(false);
    expect((term.options.theme as any).background).toBe(
      TERMINAL_THEMES.light.background,
    );
  });

  it("still recreates the session when the project changes", () => {
    const view = render(
      <Terminal projectId="p1" resolvedTheme="dark" visible />,
    );
    expect(FakeXTerm.instances).toHaveLength(1);
    act(() => {
      view.rerender(<Terminal projectId="p2" resolvedTheme="dark" visible />);
    });
    expect(FakeXTerm.instances.length).toBe(2);
    expect(FakeWS.instances.length).toBe(2);
  });
});
