import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitInternalRel, moveProjectPath, deleteProjectPath } from "../src/files/service.js";

describe("M100 follow-ups", () => {
  it("git-internal detection normalizes case and trailing dots", () => {
    for (const n of [".git/config", ".GIT/config", ".git./config", ".git"]) {
      expect(isGitInternalRel(n)).toBe(true);
    }
    expect(isGitInternalRel("src/.git/x")).toBe(false);
    expect(isGitInternalRel(".github/x")).toBe(false);
  });
  it("move/delete operate within the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "m100-"));
    const outside = mkdtempSync(join(tmpdir(), "m100-out-"));
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "f.txt"), "x");
    await moveProjectPath(root, "a/f.txt", "b/g.txt");
    expect(existsSync(join(root, "b", "g.txt"))).toBe(true);
    writeFileSync(join(outside, "keep.txt"), "k");
    try {
      symlinkSync(outside, join(root, "link"), "junction");
    } catch {
      return; // cannot create links here
    }
    await expect(deleteProjectPath(root, "link/keep.txt")).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });
});

import { existsSync as ex2, mkdtempSync as mk2 } from "node:fs";
import { createZipArchive, extractZipArchive } from "../src/projects/zip.js";
import { makeTestConfig } from "./helpers.js";

describe("zip skip normalization", () => {
  it("does not extract ./.git or dotted-path bypasses", async () => {
    const dir = mk2(join(tmpdir(), "m100-zip-"));
    const zip = createZipArchive([
      { path: "ok.txt", content: Buffer.from("1") },
      { path: "./.git/config", rawPath: "./.git/config", content: Buffer.from("[core]") },
      { path: ".GIT/hooks/x", rawPath: ".GIT/hooks/x", content: Buffer.from("x") },
      { path: "./node_modules/a.js", rawPath: "./node_modules/a.js", content: Buffer.from("x") },
    ]);
    await extractZipArchive(zip, dir, makeTestConfig());
    expect(ex2(join(dir, "ok.txt"))).toBe(true);
    expect(ex2(join(dir, ".git"))).toBe(false);
    expect(ex2(join(dir, "node_modules"))).toBe(false);
  });
});
