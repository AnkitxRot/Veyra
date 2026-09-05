import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, "../src/components/IDE/IDE.tsx"),
  "utf-8",
);

/**
 * M63 — IDE beforeunload guard while collaboration edits are unsynced.
 * Source-string guards (IDE.tsx is not rendered in unit tests — house
 * convention). The invariant: the beforeunload listener exists IFF
 * `pendingCollabUpdates > 0`, and is removed when the count returns to zero.
 */
describe("M63 — IDE.tsx beforeunload guard for unsynced collab edits", () => {
  it("has exactly one beforeunload registration, in an effect keyed on the pending count", () => {
    const adds = src.match(/addEventListener\(\s*["']beforeunload["']/g) ?? [];
    expect(adds.length).toBe(1);
    const at = src.indexOf('addEventListener("beforeunload"');
    const effect = src.slice(Math.max(0, at - 600), at + 400);
    expect(effect).toContain("pendingCollabUpdates");
  });

  it("only attaches the listener while edits are actually pending", () => {
    const at = src.indexOf('addEventListener("beforeunload"');
    const effect = src.slice(Math.max(0, at - 600), at);
    // early-return guard before the addEventListener
    expect(effect).toMatch(/if\s*\(pendingCollabUpdates\s*<=\s*0\)\s*return;/);
  });

  it("removes the listener on cleanup (so it never leaks past sync catch-up)", () => {
    const at = src.indexOf('addEventListener("beforeunload"');
    const effect = src.slice(at, at + 400);
    expect(effect).toMatch(
      /return \(\) =>\s*window\.removeEventListener\(\s*["']beforeunload["'],\s*onBeforeUnload\s*\)/,
    );
  });

  it("the effect dependency array is the pending count only", () => {
    const at = src.indexOf('addEventListener("beforeunload"');
    const after = src.slice(at, at + 500);
    expect(after).toContain("}, [pendingCollabUpdates]);");
  });
});
