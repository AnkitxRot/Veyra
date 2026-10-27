import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RUNNER_IMAGE, isValidImageRef, parseRunnerImages, resolveRuntimeImage } from "../src/execution/runtime.js";

describe("parseRunnerImages", () => {
  it("always includes the default and drops invalid entries", () => {
    expect(parseRunnerImages(undefined)).toEqual([DEFAULT_RUNNER_IMAGE]);
    expect(parseRunnerImages("python:3.12, bad image,-rm,node:22")).toEqual([DEFAULT_RUNNER_IMAGE, "python:3.12", "node:22"]);
  });
  it("rejects flag-like and shell-ish refs", () => {
    for (const v of ["-v", "a b", "x;y", "$(id)", "A/Upper", "", "a".repeat(200)]) expect(isValidImageRef(v)).toBe(false);
    expect(isValidImageRef("ghcr.io/org/img:1.2@sha256")).toBe(true);
  });
});

describe("resolveRuntimeImage", () => {
  let ws: string;
  const allowed = [DEFAULT_RUNNER_IMAGE, "python:3.12"];
  const yes = async () => true;
  const put = (content: string) => {
    mkdirSync(join(ws, ".veyra"), { recursive: true });
    writeFileSync(join(ws, ".veyra/runtime.json"), content);
  };
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "rt-"));
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("defaults without a file or without an image field", async () => {
    expect(await resolveRuntimeImage(ws, allowed, yes)).toEqual({ image: DEFAULT_RUNNER_IMAGE });
    put("{}");
    expect(await resolveRuntimeImage(ws, allowed, yes)).toEqual({ image: DEFAULT_RUNNER_IMAGE });
  });
  it("honours an allowlisted, available image", async () => {
    put('{"image":"python:3.12"}');
    expect(await resolveRuntimeImage(ws, allowed, yes)).toEqual({ image: "python:3.12" });
  });
  it("falls back for non-allowlisted, unavailable, malformed or hostile values", async () => {
    put('{"image":"evil:latest"}');
    expect((await resolveRuntimeImage(ws, allowed, yes)).fallbackReason).toMatch(/RUNNER_IMAGES/);
    put('{"image":"python:3.12"}');
    expect((await resolveRuntimeImage(ws, allowed, async () => false)).image).toBe(DEFAULT_RUNNER_IMAGE);
    put("not json");
    expect((await resolveRuntimeImage(ws, allowed, yes)).image).toBe(DEFAULT_RUNNER_IMAGE);
    put('{"image":"--privileged"}');
    expect((await resolveRuntimeImage(ws, allowed, yes)).fallbackReason).toMatch(/invalid/);
    put(`{"image":"${"a".repeat(9000)}"}`);
    expect((await resolveRuntimeImage(ws, allowed, yes)).image).toBe(DEFAULT_RUNNER_IMAGE);
  });
  it("does not follow a symlink out of the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "rt-out-"));
    try {
      writeFileSync(join(outside, "runtime.json"), '{"image":"python:3.12"}');
      mkdirSync(join(ws, ".veyra"));
      try {
        symlinkSync(join(outside, "runtime.json"), join(ws, ".veyra/runtime.json"));
      } catch {
        return; // symlinks unavailable (unprivileged Windows)
      }
      expect((await resolveRuntimeImage(ws, allowed, yes)).image).toBe(DEFAULT_RUNNER_IMAGE);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
