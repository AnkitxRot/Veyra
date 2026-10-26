import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZipArchive, extractZipArchive } from "../src/projects/zip.js";
import { assertInsideWorkspace } from "../src/files/service.js";
import { makeTestConfig } from "./helpers.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "m97-sec-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("M97 — zip bomb: inflate is bounded by the declared size", () => {
  it("rejects an entry that inflates beyond its declared size without buffering it", async () => {
    const zip = createZipArchive([
      { path: "bomb.txt", content: Buffer.alloc(64 * 1024 * 1024) },
    ]);
    // Central directory entry: uncompressedSize lives at +24. Lie: claim 1 byte.
    const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(1, cd + 24);
    await expect(
      extractZipArchive(zip, tmp(), makeTestConfig()),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/beyond|exceeds its declared/i),
    });
  });

  it("still extracts an honest archive", async () => {
    const zip = createZipArchive([
      { path: "a.txt", content: Buffer.from("hello") },
    ]);
    const files = await extractZipArchive(zip, tmp(), makeTestConfig());
    expect(files.length).toBeGreaterThan(0);
  });
});

describe("M97 — dangling symlink cannot be used to create files outside the workspace", () => {
  it("assertInsideWorkspace refuses a dangling symlink whose target is outside", async () => {
    const base = tmp();
    const ws = join(base, "ws");
    const out = join(base, "out");
    mkdirSync(ws);
    mkdirSync(out);
    try {
      symlinkSync(join(out, "x"), join(ws, "evil"));
    } catch {
      return; // symlink creation not permitted on this host (Windows w/o privilege)
    }
    await expect(
      assertInsideWorkspace(ws, join(ws, "evil")),
    ).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(out, "x"))).toBe(false);
  });
});
