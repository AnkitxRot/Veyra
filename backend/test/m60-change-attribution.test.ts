import { describe, it, expect } from "vitest";
import {
  burstKey,
  openBurst,
  extendBurst,
  shouldCloseForNextEdit,
  isStale,
  markContaminated,
  closeBurst,
  type EditInput,
} from "../src/collab/changeAttribution.js";

const IDLE = 15000;
const MAX = 300000;

const mk = (over: Partial<EditInput> = {}): EditInput => ({
  projectId: "p1",
  authorUserId: 7,
  username: "rahul",
  filePath: "a.ts",
  at: 1_000_000,
  range: { startLine: 10, endLine: 10, contiguous: true },
  linesAdded: 0,
  linesRemoved: 0,
  ...over,
});

describe("changeAttribution", () => {
  it("key is project:user:file", () => {
    expect(burstKey("p1", 7, "a.ts")).toBe("p1:7:a.ts");
  });

  it("opens and extends within the idle window; counts transactions", () => {
    const b = openBurst(mk({ at: 1000 }));
    extendBurst(b, mk({ at: 1000 + 5000 }));
    extendBurst(b, mk({ at: 1000 + 9000 }));
    expect(b.updateCount).toBe(3);
    expect(b.startedAt).toBe(1000);
    expect(b.endedAt).toBe(10000);
  });

  it("idle gap closes for the next edit", () => {
    const b = openBurst(mk({ at: 1000 }));
    expect(shouldCloseForNextEdit(b, 1000 + IDLE + 1, IDLE, MAX)).toBe(true);
    expect(shouldCloseForNextEdit(b, 1000 + IDLE - 1, IDLE, MAX)).toBe(false);
  });

  it("max age closes even with continuous typing", () => {
    const b = openBurst(mk({ at: 1000 }));
    for (let t = 2000; t < 1000 + MAX; t += 1000) extendBurst(b, mk({ at: t }));
    expect(shouldCloseForNextEdit(b, 1000 + MAX + 1, IDLE, MAX)).toBe(true);
  });

  it("isStale for the sweep timer", () => {
    const b = openBurst(mk({ at: 1000 }));
    expect(isStale(b, 1000 + IDLE + 1, IDLE, MAX)).toBe(true);
    expect(isStale(b, 1000 + 5, IDLE, MAX)).toBe(false);
  });

  it("contiguous single-region burst keeps an exact range", () => {
    const b = openBurst(
      mk({ at: 1, range: { startLine: 40, endLine: 44, contiguous: true } }),
    );
    extendBurst(
      b,
      mk({ at: 2, range: { startLine: 44, endLine: 52, contiguous: true } }),
    );
    const c = closeBurst(b, "idle");
    expect(c.startLine).toBe(40);
    expect(c.endLine).toBe(52);
  });

  it("non-contiguous folded regions => null range (not min..max)", () => {
    const b = openBurst(
      mk({ at: 1, range: { startLine: 10, endLine: 12, contiguous: true } }),
    );
    extendBurst(
      b,
      mk({ at: 2, range: { startLine: 80, endLine: 82, contiguous: true } }),
    );
    const c = closeBurst(b, "idle");
    expect(c.startLine).toBeNull();
    expect(c.endLine).toBeNull();
  });

  it("a single non-contiguous transaction => null range", () => {
    const b = openBurst(
      mk({ at: 1, range: { startLine: 10, endLine: 40, contiguous: false } }),
    );
    const c = closeBurst(b, "idle");
    expect(c.startLine).toBeNull();
  });

  it("observer miss anywhere in the burst => null range, event still valid", () => {
    const b = openBurst(
      mk({ at: 1, range: { startLine: 5, endLine: 6, contiguous: true } }),
    );
    extendBurst(b, mk({ at: 2, range: null }));
    const c = closeBurst(b, "idle");
    expect(c.startLine).toBeNull();
    expect(c.updateCount).toBe(2);
    expect(c.authorUserId).toBe(7);
    expect(c.filePath).toBe("a.ts");
  });

  it("contamination => null range", () => {
    const b = openBurst(mk({ at: 1 }));
    markContaminated(b);
    extendBurst(b, mk({ at: 2 }));
    const c = closeBurst(b, "author_switch");
    expect(c.startLine).toBeNull();
    expect(c.rangeContaminated).toBe(true);
  });

  it("aggregates line counts", () => {
    const b = openBurst(mk({ at: 1, linesAdded: 3, linesRemoved: 1 }));
    extendBurst(b, mk({ at: 2, linesAdded: 5, linesRemoved: 0 }));
    const c = closeBurst(b, "idle");
    expect(c.linesAdded).toBe(8);
    expect(c.linesRemoved).toBe(1);
  });

  it("adjacent contiguous regions merge into one interval", () => {
    const b = openBurst(
      mk({ at: 1, range: { startLine: 10, endLine: 12, contiguous: true } }),
    );
    extendBurst(
      b,
      mk({ at: 2, range: { startLine: 13, endLine: 15, contiguous: true } }),
    );
    const c = closeBurst(b, "idle");
    expect(c.startLine).toBe(10);
    expect(c.endLine).toBe(15);
  });
});
