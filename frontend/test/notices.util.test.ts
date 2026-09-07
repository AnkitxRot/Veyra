import { describe, it, expect, afterEach } from "vitest";
import {
  emitNotice,
  emitErrorNotice,
  IDE_NOTICE_EVENT,
} from "../src/utils/notices";

/**
 * M75 — the cross-component notice bridge. `emitNotice` dispatches an
 * `ide-notice` CustomEvent whose `detail` is the exact NoticeInput; IDE.tsx
 * owns the single listener (guarded in ideNotices.wiring.test.tsx).
 */
describe("M75 — emitNotice bridge", () => {
  const seen: any[] = [];
  const listener = (e: Event) => seen.push((e as CustomEvent).detail);

  afterEach(() => {
    document.removeEventListener(IDE_NOTICE_EVENT, listener);
    seen.length = 0;
  });

  it("dispatches the NoticeInput verbatim on the ide-notice event", () => {
    document.addEventListener(IDE_NOTICE_EVENT, listener);
    const input = { kind: "warning" as const, text: "heads up", ttl: 1234 };
    emitNotice(input);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(input);
  });

  it("passes action callbacks by reference (no structured clone)", () => {
    document.addEventListener(IDE_NOTICE_EVENT, listener);
    const onClick = () => {};
    emitNotice({ text: "x", actions: [{ label: "Undo", onClick }] });
    expect(seen[0].actions[0].onClick).toBe(onClick);
  });

  it("emitErrorNotice is a transient error toast", () => {
    document.addEventListener(IDE_NOTICE_EVENT, listener);
    emitErrorNotice("it broke");
    expect(seen[0]).toEqual({ kind: "error", text: "it broke", ttl: 6000 });
  });

  it("is a no-op with no listener attached (standalone routes)", () => {
    expect(() => emitNotice({ text: "nobody home" })).not.toThrow();
  });
});
