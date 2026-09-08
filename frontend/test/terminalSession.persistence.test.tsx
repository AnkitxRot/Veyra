import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as React from "react";

/**
 * M79 — RED regression specification.
 *
 * Today (`master`) the terminal is `{bottomTab === "terminal" && <Terminal/>}`
 * inside `{!isBottomCollapsed && ...}`. Switching the bottom tab or collapsing
 * the drawer unmounts <Terminal>, whose effect cleanup closes the WebSocket,
 * and the backend then kills the PTY. Reconnecting builds a fresh XTerm.
 *
 * The target contract: <Terminal projectId visible> keeps ONE XTerm and ONE
 * WebSocket for the project's lifetime; `visible` only toggles display.
 * These tests are RED until the project-lifetime session lands.
 */

const { FakeXTerm, FakeFitAddon, FakeWS } = vi.hoisted(() => {
  class FakeXTerm {
    static instances: FakeXTerm[] = [];
    static disposeCalls = 0;
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
    focus() {}
    onData() {}
    onResize() {}
    dispose() {
      this.disposed = true;
      FakeXTerm.disposeCalls++;
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
      queueMicrotask(() => {
        this.readyState = FakeWS.OPEN;
        this.onopen?.();
      });
    }
    send() {}
    close() {
      this.closed = true;
      this.readyState = FakeWS.CLOSED;
      this.onclose?.({ code: 1000 });
    }
  }
  return { FakeXTerm, FakeFitAddon, FakeWS };
});

vi.mock("@xterm/xterm", () => ({ Terminal: FakeXTerm }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: FakeFitAddon }));
vi.mock("../src/api", () => ({
  getWebSocketUrl: (p: string, id: string, extra?: Record<string, string>) => {
    const qs = new URLSearchParams({ projectId: id, ...(extra ?? {}) });
    return `ws://test${p}?${qs.toString()}`;
  },
}));

import Terminal from "../src/components/Terminal/Terminal";

beforeEach(() => {
  FakeXTerm.instances = [];
  FakeXTerm.disposeCalls = 0;
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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("M79 — terminal session survives bottom-panel navigation", () => {
  it("keeps one XTerm and one WebSocket when the panel is hidden then shown", async () => {
    const view = render(
      <Terminal projectId="p1" resolvedTheme="dark" visible={true} />,
    );
    await flush();
    expect(FakeXTerm.instances).toHaveLength(1);
    expect(FakeWS.instances).toHaveLength(1);
    const term = FakeXTerm.instances[0];
    const sock = FakeWS.instances[0];

    // Switch to another bottom tab: the host stays mounted, only `visible` flips.
    act(() => {
      view.rerender(
        <Terminal projectId="p1" resolvedTheme="dark" visible={false} />,
      );
    });
    await flush();

    expect(FakeXTerm.disposeCalls).toBe(0);
    expect(term.disposed).toBe(false);
    expect(sock.closed).toBe(false);
    expect(FakeWS.instances).toHaveLength(1);

    // Switch back.
    act(() => {
      view.rerender(
        <Terminal projectId="p1" resolvedTheme="dark" visible={true} />,
      );
    });
    await flush();

    expect(FakeXTerm.instances).toHaveLength(1);
    expect(FakeXTerm.instances[0]).toBe(term);
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0]).toBe(sock);
  });

  it("does not create a second WebSocket across repeated visibility toggles", async () => {
    const view = render(
      <Terminal projectId="p1" resolvedTheme="dark" visible={true} />,
    );
    await flush();
    for (let i = 0; i < 6; i++) {
      act(() => {
        view.rerender(
          <Terminal projectId="p1" resolvedTheme="dark" visible={i % 2 === 0} />,
        );
      });
      await flush();
    }
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeXTerm.instances).toHaveLength(1);
    expect(FakeXTerm.disposeCalls).toBe(0);
  });

  it("disposes the session and starts a new one on project change", async () => {
    const view = render(
      <Terminal projectId="p1" resolvedTheme="dark" visible={true} />,
    );
    await flush();
    const firstTerm = FakeXTerm.instances[0];

    act(() => {
      view.rerender(
        <Terminal projectId="p2" resolvedTheme="dark" visible={true} />,
      );
    });
    await flush();

    expect(firstTerm.disposed).toBe(true);
    expect(FakeXTerm.instances).toHaveLength(2);
    expect(FakeWS.instances).toHaveLength(2);
  });
});
