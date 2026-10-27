import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectFile, readProjectBytes, writeProjectFile } from "../src/files/service.js";

describe("M103 file encoding/binary", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "m103-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports utf-8 + eol for text", async () => {
    await writeProjectFile(root, "a.txt", "x\r\ny\r\n");
    const r = await readProjectFile(root, "a.txt");
    expect(r.content).toBe("x\r\ny\r\n");
    expect(r.binary).toBe(false);
    expect(r.encoding).toBe("utf-8");
    expect(r.eol).toBe("CRLF");
  });

  it("flags binary files with empty content", async () => {
    writeFileSync(join(root, "b.bin"), Buffer.from([0, 1, 2, 0, 255]));
    const r = await readProjectFile(root, "b.bin");
    expect(r.binary).toBe(true);
    expect(r.content).toBe("");
  });

  it("round-trips utf-16le and latin1", async () => {
    await writeProjectFile(root, "u.txt", "héllo", "utf-16le");
    expect((await readProjectFile(root, "u.txt")).encoding).toBe("utf-16le");
    await writeProjectFile(root, "l.txt", "café", "latin1");
    const r = await readProjectFile(root, "l.txt");
    expect(r.content).toBe("café");
    expect(r.encoding).toBe("latin1");
  });

  it("readProjectBytes is confined", async () => {
    writeFileSync(join(root, "i.png"), Buffer.from([137, 80, 78, 71]));
    expect((await readProjectBytes(root, "i.png")).length).toBe(4);
    await expect(readProjectBytes(root, "../x")).rejects.toThrow();
    await expect(readProjectBytes(root, "nope.png")).rejects.toThrow();
  });
});
