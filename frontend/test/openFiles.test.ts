import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendOpenFile } from "../src/utils/openFiles";

/**
 * Regression: opening an already-open file must never add a second tab.
 *
 * `IDE.handleOpenFile` became a `useCallback` keyed on `[project]` in M61,
 * which froze its `openFiles` closure — the early `existing` guard then reads
 * a stale snapshot, so a second open of an already-open file (clicking a
 * background tab's file in the tree, reopening a closed file, comment/session
 * navigation racing an explicit open) appended a duplicate `openFiles` entry
 * and rendered two `editor-tab` nodes with the same React `key={f.path}`.
 * The dedupe now lives in the functional update, which always sees the real
 * current list.
 */

describe("appendOpenFile — open-file tab dedupe", () => {
  it("appends a genuinely new path", () => {
    expect(appendOpenFile([], { path: "a.txt", content: "x" })).toEqual([
      { path: "a.txt", content: "x" },
    ]);
    expect(
      appendOpenFile([{ path: "a.txt", content: "x" }], {
        path: "b.txt",
        content: "y",
      }),
    ).toEqual([
      { path: "a.txt", content: "x" },
      { path: "b.txt", content: "y" },
    ]);
  });

  it("does not append a path that is already open, and returns prev by reference", () => {
    const prev = [
      { path: "notes.txt", content: "x" },
      { path: "b.txt", content: "y" },
    ];
    const out = appendOpenFile(prev, { path: "notes.txt", content: "stale" });
    expect(out).toBe(prev);
    expect(out).toHaveLength(2);
  });

  it("dedupes against the real list even when the caller's guard missed it", () => {
    // simulates the stale-closure case: handleOpenFile's `existing` check saw
    // an empty snapshot, but the functional update still gets the live list.
    const real = [{ path: "notes.txt", content: "x" }];
    expect(appendOpenFile(real, { path: "notes.txt", content: "x" })).toBe(real);
  });
});

describe("IDE.handleOpenFile wiring", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/components/IDE/IDE.tsx"),
    "utf-8",
  );
  const block = src.slice(
    src.indexOf("const handleOpenFile = useCallback"),
    src.indexOf("const handleOpenFile = useCallback") + 700,
  );

  it("inserts new tabs through the deduping appendOpenFile helper", () => {
    expect(block).toContain("appendOpenFile(prev, { path, content: res.content })");
    // the old un-guarded spread insert must be gone
    expect(block).not.toContain("[...prev, { path, content: res.content }]");
  });

  it("reads the current open-files list from the ref, not the frozen closure", () => {
    expect(block).toContain("openFilesRef.current.find((f) => f.path === path)");
  });
});
