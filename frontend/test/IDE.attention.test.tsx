import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * M58 — attention navigation must go through the open-then-reveal primitive
 * and can never regress to dispatch-only. The strongest guard is behavioral:
 * openAndRevealLocation awaits openFile BEFORE dispatching ide-reveal-location.
 */

describe("M58 — attention navigation open-then-reveal", () => {
  it("openAndRevealLocation opens the file strictly before revealing", async () => {
    const calls: string[] = [];
    const openFile = vi.fn(async () => {
      calls.push("open");
    });
    const orig = document.dispatchEvent.bind(document);
    const spy = vi
      .spyOn(document, "dispatchEvent")
      .mockImplementation((e: Event) => {
        if ((e as CustomEvent).type === "ide-reveal-location") {
          calls.push("reveal");
        }
        return orig(e);
      });

    const { openAndRevealLocation } = await import(
      "../src/utils/revealLocation"
    );
    await openAndRevealLocation(openFile, {
      filePath: "auth/session.ts",
      line: 40,
      column: 1,
    });

    expect(calls).toEqual(["open", "reveal"]);
    spy.mockRestore();
  });

  it("IDE.tsx routes attention navigation AND collaborator Jump through openAndRevealLocation", () => {
    const src = readFileSync(
      join(here, "../src/components/IDE/IDE.tsx"),
      "utf-8",
    );
    // handleAttentionNavigate uses the primitive
    const navBlock = src.slice(
      src.indexOf("const handleAttentionNavigate"),
      src.indexOf("const handleAttentionNavigate") + 400,
    );
    expect(navBlock).toContain("openAndRevealLocation(handleOpenFile");

    // retrofitted Jump uses the primitive (no lingering setTimeout dispatch).
    // M59 added a `focusOn(c.userId, { follow: false })` line + comments ahead
    // of the navigation call, so the window is widened to reach it.
    const jumpBlock = src.slice(
      src.indexOf("const handleJumpToCollaborator"),
      src.indexOf("const handleJumpToCollaborator") + 800,
    );
    expect(jumpBlock).toContain("openAndRevealLocation(handleOpenFile");
    expect(jumpBlock).not.toContain('setTimeout(() => {\n          document.dispatchEvent');
  });
});
