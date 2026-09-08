import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * M79 — the bounded terminal reconnect state machine.
 * States: connecting → connected → reconnecting → reconnect_exhausted | ended.
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
    static CONNECTING = 0;
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
    // test helpers
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
import {
  TERMINAL_STATES,
  RECONNECT_MAX_ATTEMPTS,
} from "../src/hooks/terminalSessionState";

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
afterEach(() => {
  vi.useRealTimers();
});

function mount() {
  const h = renderHook(() => useTerminalSession("p1", "dark"));
  act(() => {
    h.result.current.ensureStarted();
  });
  return h;
}
const sock = (i = -1) =>
  FakeWS.instances.at(i)!;
const lastReconnectTimerCount = () => vi.getTimerCount();

describe("M79 — terminal reconnect state machine", () => {
  it("goes connecting → connected on socket open", () => {
    const h = mount();
    expect(h.result.current.state).toBe(TERMINAL_STATES.connecting);
    act(() => sock()._open());
    expect(h.result.current.state).toBe(TERMINAL_STATES.connected);
  });

  it("an unexpected close moves to reconnecting and arms exactly one timer", () => {
    const h = mount();
    act(() => sock()._open());
    act(() => sock()._drop());
    expect(h.result.current.state).toBe(TERMINAL_STATES.reconnecting);
    expect(lastReconnectTimerCount()).toBe(1);
    // a second spurious close does not stack timers
    act(() => sock()._drop());
    expect(lastReconnectTimerCount()).toBe(1);
  });

  it("reconnect creates a new socket but never a new XTerm / dispose", () => {
    const h = mount();
    act(() => sock()._open());
    expect(FakeWS.instances).toHaveLength(1);
    const term = FakeXTerm.instances[0];

    act(() => sock()._drop());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(FakeWS.instances).toHaveLength(2);
    act(() => sock()._open());
    expect(h.result.current.state).toBe(TERMINAL_STATES.connected);
    expect(FakeXTerm.instances).toHaveLength(1);
    expect(FakeXTerm.instances[0]).toBe(term);
    expect(FakeXTerm.disposeCount).toBe(0);
  });

  it("stops after RECONNECT_MAX_ATTEMPTS and reaches reconnect_exhausted", () => {
    const h = mount();
    act(() => sock()._open());
    act(() => sock()._drop());
    for (let i = 0; i < RECONNECT_MAX_ATTEMPTS; i++) {
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      // each retry opens a fresh socket which we immediately drop
      act(() => sock()._drop());
    }
    expect(h.result.current.state).toBe(TERMINAL_STATES.reconnect_exhausted);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("manual retry from reconnect_exhausted resumes connecting", () => {
    const h = mount();
    act(() => sock()._open());
    act(() => sock()._drop());
    for (let i = 0; i < RECONNECT_MAX_ATTEMPTS; i++) {
      act(() => vi.advanceTimersByTime(20_000));
      act(() => sock()._drop());
    }
    expect(h.result.current.state).toBe(TERMINAL_STATES.reconnect_exhausted);
    const socketsBefore = FakeWS.instances.length;
    act(() => h.result.current.retry());
    expect(h.result.current.state).toBe(TERMINAL_STATES.connecting);
    expect(FakeWS.instances.length).toBe(socketsBefore + 1);
  });

  it("lastSeq advances from data frames and the reconnect URL carries it", () => {
    mount();
    act(() => sock()._open());
    act(() => sock()._message({ type: "data", seq: 7, data: "hello" }));
    act(() => sock()._message({ type: "data", seq: 12, data: "world" }));
    act(() => sock()._drop());
    act(() => vi.advanceTimersByTime(2000));
    expect(sock().url).toContain("lastSeq=12");
    expect(sock().url).toContain("terminalId=tid-fixed");
  });

  it("a server 'ended' frame stops the reconnect loop and yields state ended", () => {
    const h = mount();
    act(() => sock()._open());
    act(() =>
      sock()._message({ type: "ended", reason: "grace_expired" }),
    );
    expect(h.result.current.state).toBe(TERMINAL_STATES.ended);
    expect(h.result.current.endedReason).toBe("grace_expired");
    // no reconnect timer, and a subsequent close does not restart the loop
    expect(vi.getTimerCount()).toBe(0);
    act(() => sock()._drop());
    expect(h.result.current.state).toBe(TERMINAL_STATES.ended);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retry from ended mints a fresh terminalId and zeroes lastSeq", () => {
    let n = 0;
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: () => "tid-" + n++ },
      configurable: true,
      writable: true,
    });
    const h = renderHook(() => useTerminalSession("p1", "dark"));
    act(() => h.result.current.ensureStarted());
    act(() => sock()._open());
    act(() => sock()._message({ type: "data", seq: 40, data: "x" }));
    act(() => sock()._message({ type: "ended", reason: "process_exited" }));
    expect(h.result.current.state).toBe(TERMINAL_STATES.ended);

    act(() => h.result.current.retry());
    expect(h.result.current.state).toBe(TERMINAL_STATES.connecting);
    expect(sock().url).toContain("lastSeq=0");
    expect(sock().url).not.toContain("tid-0"); // a new id
  });

  it("teardown clears the reconnect timer and closes the socket", () => {
    const h = mount();
    act(() => sock()._open());
    act(() => sock()._drop());
    expect(vi.getTimerCount()).toBe(1);
    act(() => h.unmount());
    expect(vi.getTimerCount()).toBe(0);
    expect(sock().readyState).toBe(FakeWS.CLOSED);
  });
});
