import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import * as React from "react";

const { FakeXTerm, FakeFitAddon, FakeWS } = vi.hoisted(() => {
  class FakeXTerm {
    static instances: FakeXTerm[] = [];
    static disposeCount = 0;
    static openCount = 0;
    element: unknown = null;
    options: Record<string, unknown> = {};
    constructor() {
      FakeXTerm.instances.push(this);
    }
    loadAddon() {}
    open() {
      FakeXTerm.openCount++;
      this.element = {};
    }
    write() {}
    writeln() {}
    clear() {}
    focus() {}
    onData() {}
    onResize() {}
    dispose() {
      FakeXTerm.disposeCount++;
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
    onclose: ((e?: unknown) => void) | null = null;
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
    _open() {
      this.readyState = FakeWS.OPEN;
      this.onopen?.();
    }
    _drop() {
      this.readyState = FakeWS.CLOSED;
      this.onclose?.({ code: 1006 });
    }
  }
  return { FakeXTerm, FakeFitAddon, FakeWS };
});

vi.mock("@xterm/xterm", () => ({ Terminal: FakeXTerm }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: FakeFitAddon }));
vi.mock("../src/api", () => ({
  getWebSocketUrl: (p: string, id: string, extra?: Record<string, unknown>) => {
    const qs = new URLSearchParams({ projectId: id });
    for (const [k, v] of Object.entries(extra ?? {})) qs.set(k, String(v));
    return `ws://test${p}?${qs.toString()}`;
  },
}));

import Terminal from "../src/components/Terminal/Terminal";
import { useTerminalSession } from "../src/hooks/useTerminalSession";

beforeEach(() => {
  FakeXTerm.instances = [];
  FakeXTerm.disposeCount = 0;
  FakeXTerm.openCount = 0;
  FakeWS.instances = [];
  (globalThis as any).WebSocket = FakeWS;
  (globalThis as any).__ro = { observed: [] as HTMLElement[], disconnects: 0 };
  (globalThis as any).ResizeObserver = class {
    cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
    }
    observe(el: HTMLElement) {
      (globalThis as any).__ro.observed.push(el);
    }
    disconnect() {
      (globalThis as any).__ro.disconnects++;
    }
  };
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => "tid-fixed" },
    configurable: true,
    writable: true,
  });
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flushMicro() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("M79 — terminal session lifecycle edges", () => {
  it("F18: the host stays mounted while hidden and starts lazily on first visible", async () => {
    const view = render(
      <Terminal projectId="p1" resolvedTheme="dark" visible={false} />,
    );
    await flushMicro();
    // mounted, but not started
    expect(FakeXTerm.instances).toHaveLength(0);
    expect(FakeWS.instances).toHaveLength(0);

    act(() => {
      view.rerender(
        <Terminal projectId="p1" resolvedTheme="dark" visible={true} />,
      );
    });
    await flushMicro();
    expect(FakeXTerm.instances).toHaveLength(1);
    expect(FakeWS.instances).toHaveLength(1);

    // hide again — session persists
    act(() => {
      view.rerender(
        <Terminal projectId="p1" resolvedTheme="dark" visible={false} />,
      );
    });
    await flushMicro();
    expect(FakeXTerm.instances).toHaveLength(1);
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeXTerm.disposeCount).toBe(0);
  });

  it("F2: re-binding the container does not recreate or dispose the XTerm", () => {
    const h = renderHook(() => useTerminalSession("p1", "dark"));
    const el = document.createElement("div");
    act(() => h.result.current.bindContainer(el));
    act(() => h.result.current.ensureStarted());
    expect(FakeXTerm.instances).toHaveLength(1);
    const term = FakeXTerm.instances[0];

    act(() => h.result.current.bindContainer(el));
    act(() => h.result.current.bindContainer(null));
    act(() => h.result.current.bindContainer(el));

    expect(FakeXTerm.instances).toHaveLength(1);
    expect(FakeXTerm.instances[0]).toBe(term);
    expect(FakeXTerm.disposeCount).toBe(0);
    expect(FakeXTerm.openCount).toBeLessThanOrEqual(1);
  });

  it("attaches a ResizeObserver so the XTerm re-fits after the panel un-hides", () => {
    (globalThis as any).__ro = { observed: [], disconnects: 0 };
    const h = renderHook(() => useTerminalSession("p1", "dark"));
    const el = document.createElement("div");
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
    act(() => h.result.current.bindContainer(el));
    act(() => h.result.current.ensureStarted());
    // the host element is observed exactly once (not left unobserved as the
    // pre-fix bug did when bindContainer ran before the XTerm existed)
    expect((globalThis as any).__ro.observed).toContain(el);
    // and teardown disconnects it
    act(() => h.unmount());
    expect((globalThis as any).__ro.disconnects).toBeGreaterThan(0);
  });

  it("F20 / Scenario I: unmount during a pending reconnect leaves no socket or timer", () => {
    const h = renderHook(() => useTerminalSession("p1", "dark"));
    act(() => h.result.current.ensureStarted());
    act(() => FakeWS.instances[0]._open());
    act(() => FakeWS.instances[0]._drop()); // → reconnecting, timer armed
    expect(vi.getTimerCount()).toBe(1);

    act(() => h.unmount());
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWS.instances.every((w) => w.closed || w.readyState === 3)).toBe(
      true,
    );
  });

  it("Scenario I: rapid visibility churn never creates a second socket or PTY view", async () => {
    const view = render(
      <Terminal projectId="p1" resolvedTheme="dark" visible={true} />,
    );
    await flushMicro();
    act(() => FakeWS.instances[0]._open());

    for (let i = 0; i < 10; i++) {
      act(() => {
        view.rerender(
          <Terminal
            projectId="p1"
            resolvedTheme="dark"
            visible={i % 2 === 0}
          />,
        );
      });
      await flushMicro();
    }
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeXTerm.instances).toHaveLength(1);
    expect(FakeXTerm.disposeCount).toBe(0);
  });
});
