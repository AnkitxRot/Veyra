import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/**
 * Regression (M62-1): the `icon-only` button class was never defined in CSS —
 * `.glass-btn-icon` is the real icon-button styling mechanism. Every
 * `glass-btn icon-only` usage was renamed to `glass-btn glass-btn-icon`.
 * This guard fails if `icon-only` reappears anywhere in live frontend TSX
 * source, catching a copy-paste of the dead class.
 */

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsxFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("icon-only class guard", () => {
  it("no live frontend TSX source references the dead `icon-only` class", () => {
    const offenders = tsxFiles(srcRoot).filter((f) =>
      readFileSync(f, "utf8").includes("icon-only"),
    );
    expect(
      offenders.map((f) => relative(srcRoot, f)),
      "use `glass-btn glass-btn-icon`; `icon-only` has no CSS definition",
    ).toEqual([]);
  });
});
