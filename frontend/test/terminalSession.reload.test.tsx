import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * M86 — same-tab remount (reload / project switch-back) must reuse the
 * stored terminalId and send resume=1 so the server reattaches instead of
 * minting a second PTY.
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
    dispose() {}
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
    onmessage: ((e?: unknown) => void) | null = null;
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
import { readTerminalResume } from "../src/utils/terminalResume";

let uuidN = 0;

beforeEach(() => {
  FakeXTerm.instances = [];
  FakeWS.instances = [];
  sessionStorage.clear();
  uuidN = 0;
  (globalThis as any).WebSocket = FakeWS;
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => "tid-" + uuidN++ },
    configurable: true,
    writable: true,
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
});

const sock = (i = -1) => FakeWS.instances.at(i)!;

describe("M86 — terminal remount resumes the same PTY id", () => {
  it("first connect with a userId stores the id after the PTY actually streams", () => {
    const h = renderHook(() => useTerminalSession("p1", "dark", 7));
    act(() => h.result.current.ensureStarted());
    expect(sock().url).toContain("terminalId=tid-0");
    expect(sock().url).not.toContain("resume=");
    act(() => sock()._open());
    expect(readTerminalResume(7, "p1")).toBeNull();
    act(() => sock()._message({ type: "data", seq: 1, data: "$ " }));
    expect(readTerminalResume(7, "p1")).toBe("tid-0");
  });

  it("unmount/remount reuses the stored id, lastSeq=0, and resume=1", () => {
    const h1 = renderHook(() => useTerminalSession("p1", "dark", 7));
    act(() => h1.result.current.ensureStarted());
    act(() => sock()._open());
    act(() => sock()._message({ type: "data", seq: 4, data: "hello" }));
    act(() => h1.unmount());

    const h2 = renderHook(() => useTerminalSession("p1", "dark", 7));
    act(() => h2.result.current.ensureStarted());
    expect(sock().url).toContain("terminalId=tid-0");
    expect(sock().url).toContain("lastSeq=0");
    expect(sock().url).toContain("resume=1");
    expect(uuidN).toBe(1);
  });

  it("without userId, remount still mints a new id (M79 in-page behaviour)", () => {
    const h1 = renderHook(() => useTerminalSession("p1", "dark"));
    act(() => h1.result.current.ensureStarted());
    act(() => h1.unmount());
    const h2 = renderHook(() => useTerminalSession("p1", "dark"));
    act(() => h2.result.current.ensureStarted());
    expect(sock().url).toContain("terminalId=tid-1");
    expect(sock().url).not.toContain("resume=");
  });

  it("a different userId does not resume the first user's terminalId", () => {
    const h1 = renderHook(() => useTerminalSession("p1", "dark", 7));
    act(() => h1.result.current.ensureStarted());
    act(() => sock()._open());
    act(() => sock()._message({ type: "data", seq: 1, data: "$ " }));
    act(() => h1.unmount());
    const h2 = renderHook(() => useTerminalSession("p1", "dark", 8));
    act(() => h2.result.current.ensureStarted());
    expect(sock().url).toContain("terminalId=tid-1");
    expect(sock().url).not.toContain("resume=");
    expect(readTerminalResume(7, "p1")).toBe("tid-0");
    expect(readTerminalResume(8, "p1")).toBeNull();
  });

  it("project switch-back restores the original project's terminalId", () => {
    const h = renderHook(
      ({ pid }: { pid: string }) => useTerminalSession(pid, "dark", 7),
      { initialProps: { pid: "p1" } },
    );
    act(() => h.result.current.ensureStarted());
    expect(sock().url).toContain("terminalId=tid-0");
    act(() => sock()._open());
    act(() => sock()._message({ type: "data", seq: 1, data: "p1 " }));

    act(() => h.rerender({ pid: "p2" }));
    act(() => h.result.current.ensureStarted());
    expect(sock().url).toContain("terminalId=tid-1");
    act(() => sock()._open());
    act(() => sock()._message({ type: "data", seq: 1, data: "p2 " }));

    act(() => h.rerender({ pid: "p1" }));
    act(() => h.result.current.ensureStarted());
    expect(sock().url).toContain("terminalId=tid-0");
    expect(sock().url).toContain("resume=1");
    expect(uuidN).toBe(2);
  });

  it("an ended session forgets the id so a later remount is a fresh shell", () => {
    const h1 = renderHook(() => useTerminalSession("p1", "dark", 7));
    act(() => h1.result.current.ensureStarted());
    act(() => sock()._open());
    act(() =>
      sock()._message({ type: "ended", reason: "grace_expired" }),
    );
    expect(h1.result.current.state).toBe(TERMINAL_STATES.ended);
    expect(readTerminalResume(7, "p1")).toBeNull();
    act(() => h1.unmount());

    const h2 = renderHook(() => useTerminalSession("p1", "dark", 7));
    act(() => h2.result.current.ensureStarted());
    expect(sock().url).toContain("terminalId=tid-1");
    expect(sock().url).not.toContain("resume=");
  });

  it("retry from ended mints a new id and stores it without resume", () => {
    const h = renderHook(() => useTerminalSession("p1", "dark", 7));
    act(() => h.result.current.ensureStarted());
    act(() => sock()._open());
    act(() => sock()._message({ type: "ended", reason: "process_exited" }));
    act(() => h.result.current.retry());
    expect(sock().url).toContain("terminalId=tid-1");
    expect(sock().url).toContain("lastSeq=0");
    expect(sock().url).not.toContain("resume=");
    expect(readTerminalResume(7, "p1")).toBeNull();
    act(() => sock()._open());
    act(() => sock()._message({ type: "data", seq: 1, data: "$ " }));
    expect(readTerminalResume(7, "p1")).toBe("tid-1");
  });
});
