import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";

// --- xterm / addon / api / transport fakes -------------------------------

const { FakeXTerm, FakeFitAddon, FakeWS } = vi.hoisted(() => {
  class FakeXTerm {
    static instances: FakeXTerm[] = [];
    options: Record<string, unknown>;
    disposed = false;
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      FakeXTerm.instances.push(this);
    }
    loadAddon() {}
    open() {}
    writeln() {}
    write() {}
    clear() {}
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
});
afterEach(cleanup);

const P1 = { id: "p1", name: "P1" };

describe("M69 — terminal theme sync", () => {
  it("opens the terminal with the dark palette by default", () => {
    render(<Terminal project={P1} resolvedTheme="dark" />);
    expect(FakeXTerm.instances).toHaveLength(1);
    expect(
      (FakeXTerm.instances[0].options.theme as any).background,
    ).toBe(TERMINAL_THEMES.dark.background);
  });

  it("opens the terminal with the light palette when resolvedTheme is light", () => {
    render(<Terminal project={P1} resolvedTheme="light" />);
    expect((FakeXTerm.instances[0].options.theme as any).background).toBe(
      TERMINAL_THEMES.light.background,
    );
  });

  it("updates the live terminal theme in place — no new xterm, no new socket", () => {
    const view = render(<Terminal project={P1} resolvedTheme="dark" />);
    const term = FakeXTerm.instances[0];
    const wsCount = FakeWS.instances.length;
    expect(wsCount).toBe(1);

    act(() => {
      view.rerender(<Terminal project={P1} resolvedTheme="light" />);
    });

    // same instance, not disposed, no reconnect
    expect(FakeXTerm.instances).toHaveLength(1);
    expect(FakeXTerm.instances[0]).toBe(term);
    expect(term.disposed).toBe(false);
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0].closed).toBe(false);
    // theme actually changed
    expect((term.options.theme as any).background).toBe(
      TERMINAL_THEMES.light.background,
    );
  });

  it("still recreates the session when the project changes (theme guard is theme-only)", () => {
    const view = render(<Terminal project={P1} resolvedTheme="dark" />);
    expect(FakeXTerm.instances).toHaveLength(1);
    act(() => {
      view.rerender(
        <Terminal project={{ id: "p2", name: "P2" }} resolvedTheme="dark" />,
      );
    });
    expect(FakeXTerm.instances.length).toBe(2);
    expect(FakeWS.instances.length).toBe(2);
  });
});
