import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * M79 — the XTerm must open into its host once the host gains a box, even
 * when `ensureStarted` runs while the panel is still `display:none` (0×0) and
 * the `display:none → flex` ancestor change does not fire the host's
 * ResizeObserver. Regression for the "terminal connects but never renders"
 * bug found in live Chrome.
 */

const { FakeXTerm, FakeFitAddon, FakeWS } = vi.hoisted(() => {
  class FakeXTerm {
    static instances: FakeXTerm[] = [];
    element: unknown = null;
    options: Record<string, unknown> = {};
    written: string[] = [];
    constructor() {
      FakeXTerm.instances.push(this);
    }
    loadAddon() {}
    open(el: unknown) {
      this.element = el ?? {};
    }
    write(d: string) {
      this.written.push(d);
    }
    writeln() {}
    clear() {}
    focus() {}
    onData() {}
    onResize() {}
    dispose() {
      this.element = null;
    }
  }
  class FakeFitAddon {
    fitCalls = 0;
    fit() {
      this.fitCalls++;
    }
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
    constructor(public url: string) {
      FakeWS.instances.push(this);
    }
    send() {}
    close() {
      this.readyState = FakeWS.CLOSED;
    }
    _open() {
      this.readyState = FakeWS.OPEN;
      this.onopen?.();
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

import { useTerminalSession } from "../src/hooks/useTerminalSession";

// Manual rAF queue so the bounded poll can be driven frame by frame.
let rafQueue: FrameRequestCallback[] = [];
function flushFrame() {
  const q = rafQueue;
  rafQueue = [];
  q.forEach((cb) => cb(performance.now()));
}

beforeEach(() => {
  FakeXTerm.instances = [];
  FakeWS.instances = [];
  rafQueue = [];
  (globalThis as any).WebSocket = FakeWS;
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  (globalThis as any).cancelAnimationFrame = () => {};
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => "tid-fixed" },
    configurable: true,
    writable: true,
  });
});
afterEach(() => {});

function hostEl(h: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { value: h, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: h ? 800 : 0, configurable: true });
  return el;
}

describe("M79 — XTerm mounts once the host gains a box", () => {
  it("defers open() while the host is 0×0, then opens when it gains a box", () => {
    const el = hostEl(0); // panel still display:none
    const h = renderHook(() => useTerminalSession("p1", "dark"));

    act(() => h.result.current.bindContainer(el));
    act(() => h.result.current.ensureStarted());
    act(() => FakeWS.instances[0]._open());

    // one XTerm created, but NOT opened yet — host has no box
    expect(FakeXTerm.instances).toHaveLength(1);
    act(() => flushFrame());
    expect(FakeXTerm.instances[0].element).toBeNull();

    // panel becomes visible: host gains a box
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });

    // the bounded poll's next frame opens it
    act(() => flushFrame());
    expect(FakeXTerm.instances[0].element).toBe(el);
    expect(FakeXTerm.instances).toHaveLength(1);
  });

  it("opens immediately when the host already has a box", () => {
    const el = hostEl(400);
    const h = renderHook(() => useTerminalSession("p1", "dark"));
    act(() => h.result.current.bindContainer(el));
    act(() => h.result.current.ensureStarted());
    act(() => flushFrame());
    expect(FakeXTerm.instances[0].element).toBe(el);
  });

  it("gives up after a bounded number of frames if the host never appears", () => {
    const el = hostEl(0);
    const h = renderHook(() => useTerminalSession("p1", "dark"));
    act(() => h.result.current.bindContainer(el));
    act(() => h.result.current.ensureStarted());
    // drain far more frames than the budget
    for (let i = 0; i < 200; i++) act(() => flushFrame());
    expect(rafQueue).toHaveLength(0); // poll stopped, no runaway rAF loop
    expect(FakeXTerm.instances[0].element).toBeNull();

    // a later fit() (panel finally shown) re-arms the poll
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
    act(() => h.result.current.fit());
    act(() => flushFrame());
    expect(FakeXTerm.instances[0].element).toBe(el);
  });

  it("buffered writes are preserved — open() flushes them (xterm buffers pre-open)", () => {
    const el = hostEl(0);
    const h = renderHook(() => useTerminalSession("p1", "dark"));
    act(() => h.result.current.bindContainer(el));
    act(() => h.result.current.ensureStarted());
    act(() => FakeWS.instances[0]._open());
    act(() =>
      FakeWS.instances[0].onmessage?.({
        data: JSON.stringify({ type: "data", seq: 1, data: "prompt$ " }),
      } as MessageEvent),
    );
    // write went to the (not-yet-open) xterm; it is retained
    expect(FakeXTerm.instances[0].written).toContain("prompt$ ");
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
    act(() => flushFrame());
    expect(FakeXTerm.instances[0].element).toBe(el);
    expect(FakeXTerm.instances[0].written).toContain("prompt$ ");
  });
});
