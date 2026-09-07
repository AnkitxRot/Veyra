import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * M79 — the client keeps its XTerm scrollback across a reconnect and applies
 * each replayed output frame exactly once, in order.
 */

const { FakeXTerm, FakeFitAddon, FakeWS } = vi.hoisted(() => {
  class FakeXTerm {
    static instances: FakeXTerm[] = [];
    static disposeCount = 0;
    element: unknown = null;
    options: Record<string, unknown> = {};
    written: string[] = [];
    constructor() {
      FakeXTerm.instances.push(this);
    }
    loadAddon() {}
    open() {
      this.element = {};
    }
    write(d: string) {
      this.written.push(d);
    }
    writeln(d: string) {
      this.written.push(d + "\n");
    }
    clear() {
      this.written.length = 0;
    }
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
    sent: string[] = [];
    constructor(public url: string) {
      FakeWS.instances.push(this);
    }
    send(d: string) {
      this.sent.push(d);
    }
    close() {
      this.readyState = FakeWS.CLOSED;
    }
    _open() {
      this.readyState = FakeWS.OPEN;
      this.onopen?.();
    }
    _message(obj: unknown) {
      this.onmessage?.({ data: JSON.stringify(obj) } as MessageEvent);
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

import { useTerminalSession } from "../src/hooks/useTerminalSession";
import { TERMINAL_STATES } from "../src/hooks/terminalSessionState";

beforeEach(() => {
  FakeXTerm.instances = [];
  FakeXTerm.disposeCount = 0;
  FakeWS.instances = [];
  (globalThis as any).WebSocket = FakeWS;
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => "tid-fixed" },
    configurable: true,
    writable: true,
  });
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const sock = (i = -1) => FakeWS.instances.at(i)!;

describe("M79 — XTerm buffer preservation + exactly-once replay", () => {
  it("keeps the same XTerm and its written buffer across a reconnect", () => {
    const h = renderHook(() => useTerminalSession("p1", "dark"));
    act(() => h.result.current.ensureStarted());
    act(() => sock()._open());
    act(() => sock()._message({ type: "data", seq: 1, data: "line-1\r\n" }));
    act(() => sock()._message({ type: "data", seq: 2, data: "line-2\r\n" }));
    const term = FakeXTerm.instances[0];
    expect(term.written.join("")).toBe("line-1\r\nline-2\r\n");

    act(() => sock()._drop());
    act(() => vi.advanceTimersByTime(2000));
    act(() => sock()._open());

    // same instance, buffer untouched
    expect(FakeXTerm.instances).toHaveLength(1);
    expect(FakeXTerm.instances[0]).toBe(term);
    expect(FakeXTerm.disposeCount).toBe(0);
    expect(term.written.join("")).toBe("line-1\r\nline-2\r\n");

    // server replays only what we missed (seq > 2)
    act(() => sock()._message({ type: "data", seq: 3, data: "missed-3\r\n" }));
    expect(term.written.join("")).toBe("line-1\r\nline-2\r\nmissed-3\r\n");
  });

  it("ignores a frame whose seq was already applied (double-replay guard)", () => {
    const h = renderHook(() => useTerminalSession("p1", "dark"));
    act(() => h.result.current.ensureStarted());
    act(() => sock()._open());
    act(() => sock()._message({ type: "data", seq: 5, data: "A" }));
    act(() => sock()._message({ type: "data", seq: 6, data: "B" }));
    const term = FakeXTerm.instances[0];
    expect(term.written.join("")).toBe("AB");

    act(() => sock()._drop());
    act(() => vi.advanceTimersByTime(2000));
    act(() => sock()._open());
    // buggy server re-sends 6 then a real 7
    act(() => sock()._message({ type: "data", seq: 6, data: "B" }));
    act(() => sock()._message({ type: "data", seq: 7, data: "C" }));
    expect(term.written.join("")).toBe("ABC");
  });

  it("reconnect URL carries the last applied seq so the server can trim replay", () => {
    const h = renderHook(() => useTerminalSession("p1", "dark"));
    act(() => h.result.current.ensureStarted());
    act(() => sock()._open());
    act(() => sock()._message({ type: "data", seq: 41, data: "x" }));
    act(() => sock()._drop());
    act(() => vi.advanceTimersByTime(2000));
    expect(sock().url).toContain("lastSeq=41");
    act(() => sock()._open());
    expect(h.result.current.state).toBe(TERMINAL_STATES.connected);
  });
});
