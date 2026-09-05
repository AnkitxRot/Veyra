import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  useNotices,
  MAX_NOTICES,
  MAX_NOTICES_CEILING,
} from "../src/hooks/useNotices";

// M64 — unified notice lifecycle. Behaviour tests for the queue hook that
// owns stable IDs, TTL expiry, explicit dismissal, dedupe/replacement, a
// bounded queue and deterministic timer cleanup. Deterministic fake timers
// throughout — no real-time sleeps.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useNotices — creation & lookup", () => {
  it("notify returns an id and the entry appears with defaults applied", () => {
    const { result } = renderHook(() => useNotices());

    let id = "";
    act(() => {
      id = result.current.notify({ kind: "info", text: "hello" });
    });

    expect(id).toBeTruthy();
    expect(result.current.notices).toHaveLength(1);
    const n = result.current.notices[0];
    expect(n.id).toBe(id);
    expect(n.text).toBe("hello");
    expect(n.kind).toBe("info");
    expect(n.surface).toBe("stack"); // default surface
    expect(n.ttl).toBeNull(); // omitted ttl => persistent
    expect(n.role).toBe("status"); // non-error default role
  });

  it("an error notice defaults to role=alert", () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({ kind: "error", text: "boom" });
    });
    expect(result.current.notices[0].role).toBe("alert");
  });

  it("hasKey reflects presence and absence of a dedupeKey", () => {
    const { result } = renderHook(() => useNotices());
    expect(result.current.hasKey("k")).toBe(false);
    act(() => {
      result.current.notify({ kind: "info", text: "x", dedupeKey: "k" });
    });
    expect(result.current.hasKey("k")).toBe(true);
    act(() => {
      result.current.dismissKey("k");
    });
    expect(result.current.hasKey("k")).toBe(false);
  });
});

describe("useNotices — TTL lifecycle", () => {
  it("a transient notice auto-dismisses after exactly its ttl", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNotices());

    act(() => {
      result.current.notify({ kind: "info", text: "temp", ttl: 2000 });
    });
    expect(result.current.notices).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(result.current.notices).toHaveLength(1); // not yet

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current.notices).toHaveLength(0); // gone
  });

  it("a persistent notice (ttl:null) is never auto-dismissed", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({ kind: "error", text: "stay", ttl: null });
    });
    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });
    expect(result.current.notices).toHaveLength(1);
  });

  it("ttl:0 is treated as persistent, not an immediate dismissal", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({ kind: "warning", text: "zero", ttl: 0 });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.notices).toHaveLength(1);
  });
});

describe("useNotices — explicit dismissal", () => {
  it("dismiss(id) removes immediately", () => {
    const { result } = renderHook(() => useNotices());
    let id = "";
    act(() => {
      id = result.current.notify({ kind: "info", text: "a" });
    });
    act(() => {
      result.current.dismiss(id);
    });
    expect(result.current.notices).toHaveLength(0);
  });

  it("dismiss removes a persistent notice (it stays until then)", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNotices());
    let id = "";
    act(() => {
      id = result.current.notify({ kind: "error", text: "stuck", ttl: null });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.notices).toHaveLength(1); // still there
    act(() => {
      result.current.dismiss(id);
    });
    expect(result.current.notices).toHaveLength(0);
  });

  it("dismissKey(k) removes the keyed entry only", () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({ kind: "info", text: "a", dedupeKey: "ka" });
      result.current.notify({ kind: "info", text: "b", dedupeKey: "kb" });
    });
    act(() => {
      result.current.dismissKey("ka");
    });
    expect(result.current.notices.map((n) => n.text)).toEqual(["b"]);
  });

  it("dismiss does NOT invoke onExpire", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result } = renderHook(() => useNotices());
    let id = "";
    act(() => {
      id = result.current.notify({
        kind: "warning",
        text: "x",
        ttl: 5000,
        onExpire,
      });
    });
    act(() => {
      result.current.dismiss(id);
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe("useNotices — coexistence & ordering", () => {
  it("two notices fired in the same tick both remain, in insertion order", () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({ kind: "info", text: "first" });
      result.current.notify({ kind: "info", text: "second" });
    });
    expect(result.current.notices.map((n) => n.text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("a new notice never overwrites an unrelated existing one", () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({ kind: "info", text: "keep", dedupeKey: "a" });
    });
    act(() => {
      result.current.notify({ kind: "error", text: "other", dedupeKey: "b" });
    });
    expect(result.current.notices).toHaveLength(2);
  });
});

describe("useNotices — dedupe / replacement", () => {
  it("notify with a live dedupeKey replaces in place with a fresh id", () => {
    const { result } = renderHook(() => useNotices());
    let firstId = "";
    let secondId = "";
    act(() => {
      firstId = result.current.notify({
        kind: "info",
        text: "v1",
        dedupeKey: "slot",
      });
    });
    act(() => {
      secondId = result.current.notify({
        kind: "info",
        text: "v2",
        dedupeKey: "slot",
      });
    });
    expect(result.current.notices).toHaveLength(1);
    expect(result.current.notices[0].text).toBe("v2");
    expect(result.current.notices[0].id).toBe(secondId);
    expect(secondId).not.toBe(firstId);
  });

  it("a replaced notice's stale timer cannot remove the replacement", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNotices());

    act(() => {
      result.current.notify({
        kind: "info",
        text: "old",
        ttl: 1000,
        dedupeKey: "slot",
      });
    });
    act(() => {
      vi.advanceTimersByTime(999);
    });
    // replace 1ms before the old timer would fire
    act(() => {
      result.current.notify({
        kind: "info",
        text: "new",
        ttl: 5000,
        dedupeKey: "slot",
      });
    });
    act(() => {
      vi.advanceTimersByTime(2); // old timer's original deadline passes
    });

    expect(result.current.notices).toHaveLength(1);
    expect(result.current.notices[0].text).toBe("new");
  });

  it("replacing via dedupeKey does NOT invoke the old notice's onExpire", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({
        kind: "warning",
        text: "old",
        ttl: 1000,
        dedupeKey: "slot",
        onExpire,
      });
    });
    act(() => {
      result.current.notify({
        kind: "warning",
        text: "new",
        ttl: 1000,
        dedupeKey: "slot",
      });
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe("useNotices — onExpire side effect", () => {
  it("onExpire fires exactly once, on TTL expiry", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({
        kind: "warning",
        text: "x",
        ttl: 1000,
        onExpire,
      });
    });
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});

describe("useNotices — bounded queue", () => {
  it("retains at most MAX_NOTICES, evicting the oldest transient first", () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      // one persistent, then MAX_NOTICES transient — total MAX_NOTICES + 1
      result.current.notify({ kind: "error", text: "persistent", ttl: null });
      for (let i = 0; i < MAX_NOTICES; i++) {
        result.current.notify({ kind: "info", text: `t${i}`, ttl: 5000 });
      }
    });

    expect(result.current.notices).toHaveLength(MAX_NOTICES);
    // persistent survived; oldest transient (t0) was evicted
    expect(result.current.notices.map((n) => n.text)).toContain("persistent");
    expect(result.current.notices.map((n) => n.text)).not.toContain("t0");
    expect(result.current.notices.map((n) => n.text)).toContain(
      `t${MAX_NOTICES - 1}`,
    );
  });

  it("eviction never drops a persistent notice ahead of a transient one", () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({ kind: "error", text: "p1", ttl: null });
      result.current.notify({ kind: "error", text: "p2", ttl: null });
      // enough transient to force eviction past MAX_NOTICES
      for (let i = 0; i < MAX_NOTICES; i++) {
        result.current.notify({ kind: "info", text: `t${i}`, ttl: 5000 });
      }
    });
    const texts = result.current.notices.map((n) => n.text);
    expect(texts).toHaveLength(MAX_NOTICES);
    expect(texts).toContain("p1");
    expect(texts).toContain("p2");
    // oldest transients evicted first
    expect(texts).not.toContain("t0");
    expect(texts).toContain(`t${MAX_NOTICES - 1}`);
  });

  it("an evicted notice's timer is cleared (no callback after eviction)", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({
        kind: "info",
        text: "victim",
        ttl: 1000,
        onExpire,
      });
      for (let i = 0; i < MAX_NOTICES; i++) {
        result.current.notify({ kind: "info", text: `f${i}`, ttl: 9000 });
      }
    });
    // "victim" is the oldest transient -> evicted
    expect(result.current.notices.map((n) => n.text)).not.toContain("victim");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe("useNotices — headless notices (audit)", () => {
  it("a headless notice needs neither kind nor text", () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({
        ttl: 4000,
        surface: "headless",
        dedupeKey: "attn-rate",
      });
    });
    expect(result.current.hasKey("attn-rate")).toBe(true);
    const n = result.current.notices[0];
    expect(n.surface).toBe("headless");
    expect(n.kind).toBe("info"); // default
    expect(n.text).toBe(""); // default
    expect(n.role).toBe("status");
  });

  it("a headless notice still auto-dismisses on its TTL", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({
        ttl: 4000,
        surface: "headless",
        dedupeKey: "attn-rate",
      });
    });
    expect(result.current.hasKey("attn-rate")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(4001);
    });
    expect(result.current.hasKey("attn-rate")).toBe(false);
  });
});

describe("useNotices — persistent-notice ceiling (audit)", () => {
  it("does not force-evict persistent notices when the queue passes MAX_NOTICES", () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      for (let i = 0; i < MAX_NOTICES + 3; i++) {
        result.current.notify({
          kind: "error",
          text: `save-fail ${i}`,
          ttl: null,
          dedupeKey: `save-fail:${i}`,
        });
      }
    });
    // every persistent error is still represented — none silently dropped
    expect(result.current.notices).toHaveLength(MAX_NOTICES + 3);
    expect(result.current.notices.map((n) => n.text)).toContain("save-fail 0");
  });

  it("sheds the oldest only past an absolute ceiling (bounded growth)", () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      for (let i = 0; i < 20; i++) {
        result.current.notify({
          kind: "error",
          text: `p${i}`,
          ttl: null,
          dedupeKey: `p:${i}`,
        });
      }
    });
    expect(result.current.notices.length).toBeLessThanOrEqual(MAX_NOTICES_CEILING);
    // oldest were shed, newest kept
    expect(result.current.notices.map((n) => n.text)).toContain("p19");
    expect(result.current.notices.map((n) => n.text)).not.toContain("p0");
  });

  it("sheds the OLDEST transient (never a persistent) when transients pile up over the cap", () => {
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({
        kind: "error",
        text: "persistent",
        ttl: null,
        dedupeKey: "p",
      });
      for (let i = 0; i < MAX_NOTICES + 2; i++) {
        result.current.notify({ kind: "info", text: `t${i}`, ttl: 5000 });
      }
    });
    const texts = result.current.notices.map((n) => n.text);
    expect(texts).toContain("persistent"); // never evicted
    expect(texts).not.toContain("t0"); // oldest transient shed
    expect(texts).not.toContain("t1");
    expect(texts).toContain(`t${MAX_NOTICES + 1}`); // newest kept
    expect(result.current.notices).toHaveLength(MAX_NOTICES);
  });
});

describe("useNotices — expiry cannot act after the timer is cleared (audit)", () => {
  it("onExpire never fires for a notice removed by dismissKey", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({
        kind: "warning",
        text: "x",
        ttl: 1000,
        dedupeKey: "k",
        onExpire,
      });
    });
    act(() => {
      result.current.dismissKey("k");
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onExpire).not.toHaveBeenCalled();
    expect(result.current.notices).toHaveLength(0);
  });
});

describe("useNotices — clear (audit)", () => {
  it("clear() empties the queue and cancels every pending timer", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({ kind: "error", text: "persistent", ttl: null });
      result.current.notify({ kind: "info", text: "t", ttl: 3000, onExpire });
      result.current.notify({
        surface: "headless",
        ttl: 4000,
        dedupeKey: "flag",
      });
    });
    expect(result.current.notices).toHaveLength(3);

    act(() => {
      result.current.clear();
    });
    expect(result.current.notices).toHaveLength(0);
    expect(result.current.hasKey("flag")).toBe(false);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onExpire).not.toHaveBeenCalled(); // timer was cancelled
  });
});

describe("useNotices — cleanup", () => {
  it("clears all pending timers on unmount (no stray callbacks)", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result, unmount } = renderHook(() => useNotices());
    act(() => {
      result.current.notify({
        kind: "warning",
        text: "x",
        ttl: 3000,
        onExpire,
      });
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onExpire).not.toHaveBeenCalled();
  });
});
