import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchProjectContent } from "../src/projects/search.js";
import { formatProjectFile } from "../src/projects/format.js";

describe("M2 Code Intelligence: Workspace Content Search", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cloudeee-search-test-"));

    // Populate mock project files
    writeFileSync(
      join(tempDir, "main.py"),
      'def hello():\n    print("Hello CloudeeeIDE")\n    x = 42\n',
    );
    writeFileSync(
      join(tempDir, "utils.py"),
      "def calculate():\n    return 42\n# Hello world comment\n",
    );

    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "App.tsx"),
      'import React from "react";\nexport const App = () => <div>Hello React</div>;\n',
    );
    writeFileSync(
      join(tempDir, "src", "index.ts"),
      'console.log("App starting...");\nconst HELLO_CONST = 100;\n',
    );

    // Add binary mock file
    writeFileSync(
      join(tempDir, "image.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]),
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("performs plain text content search across files", async () => {
    const res = await searchProjectContent(tempDir, { query: "Hello" });
    expect(res.totalMatches).toBe(5); // main.py (2), utils.py (1), src/App.tsx (1), src/index.ts (1)
    expect(res.groups.length).toBe(4);
    expect(res.filesSearched).toBeGreaterThanOrEqual(4);
    expect(res.truncated).toBe(false);
  });

  it("respects case sensitivity flag", async () => {
    const caseInsensitiveRes = await searchProjectContent(tempDir, {
      query: "hello",
      isCaseSensitive: false,
    });
    expect(caseInsensitiveRes.totalMatches).toBe(5); // all case variations

    const caseSensitiveRes = await searchProjectContent(tempDir, {
      query: "Hello",
      isCaseSensitive: true,
    });
    expect(caseSensitiveRes.totalMatches).toBe(3); // main.py, utils.py, src/App.tsx
  });

  it("respects whole word matching flag", async () => {
    const allMatches = await searchProjectContent(tempDir, {
      query: "App",
      isCaseSensitive: true,
    });
    expect(allMatches.totalMatches).toBe(2); // src/App.tsx (App = () =>), src/index.ts (App starting)

    const wholeWordRes = await searchProjectContent(tempDir, {
      query: "App",
      isWholeWord: true,
      isCaseSensitive: true,
    });
    expect(wholeWordRes.totalMatches).toBe(2);
  });

  it("executes regular expression search safely", async () => {
    const regexRes = await searchProjectContent(tempDir, {
      query: "x\\s*=\\s*\\d+",
      isRegex: true,
    });
    expect(regexRes.totalMatches).toBe(1);
    expect(regexRes.groups[0].filePath).toBe("main.py");
    expect(regexRes.groups[0].matches[0].lineContent).toContain("x = 42");
  });

  it("ignores binary files automatically", async () => {
    const res = await searchProjectContent(tempDir, { query: "PNG" });
    const binaryGroup = res.groups.find((g) => g.filePath.endsWith(".png"));
    expect(binaryGroup).toBeUndefined();
  });

  it("enforces maximum result limit and sets truncated flag", async () => {
    const res = await searchProjectContent(tempDir, {
      query: "e",
      maxResults: 2,
    });
    expect(res.totalMatches).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it("rejects invalid regex patterns with 400 error", async () => {
    await expect(
      searchProjectContent(tempDir, {
        query: "[unclosed regex",
        isRegex: true,
      }),
    ).rejects.toThrow();
  });

  it("does not hang the process on catastrophic-backtracking regex patterns; terminates and returns a truncated result", async () => {
    // `((a+))+$` is a two-character mutation of the textbook `(a+)+$`
    // ReDoS shape and was a confirmed bypass of an earlier pattern-shape
    // heuristic (rejected by inspecting parens, defeated by adding a
    // redundant pair). This proves the actual defense — running the
    // search in a killable worker thread — works regardless of pattern
    // shape, by driving genuine catastrophic backtracking against
    // adversarial content and confirming the call still resolves.
    writeFileSync(join(tempDir, "redos.txt"), "a".repeat(40) + "!");

    const start = Date.now();
    const res = await searchProjectContent(tempDir, {
      query: "((a+))+$",
      isRegex: true,
    });
    const elapsed = Date.now() - start;

    // Must actually resolve (not hang indefinitely) and be terminated
    // well under vitest's global test timeout.
    expect(elapsed).toBeLessThan(15000);
    expect(res.truncated).toBe(true);
  }, 20000);

  it("does not reject benign regex patterns that merely contain groups or quantifiers", async () => {
    // A group with no quantifier inside, itself repeated, is safe (no
    // nested repetition) and must keep working normally.
    const res = await searchProjectContent(tempDir, {
      query: "(Hello|Hi)",
      isRegex: true,
    });
    expect(res.totalMatches).toBeGreaterThan(0);

    // A quantifier inside a group with nothing repeating the group itself
    // is also safe.
    const res2 = await searchProjectContent(tempDir, {
      query: "(\\d+)",
      isRegex: true,
    });
    expect(res2.totalMatches).toBeGreaterThan(0);
  });
});

describe("M2 Code Intelligence: Auto-Formatting Engine", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cloudeee-format-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("formats JSON files with standard 2-space indentation", async () => {
    const rawJson =
      '{"name":"CloudeeeIDE","version":1,"features":["terminal","editor"]}';
    const res = await formatProjectFile(tempDir, "package.json", rawJson);
    expect(res.changed).toBe(true);
    expect(res.formatted).toContain('  "name": "CloudeeeIDE"');
    expect(res.formatted.endsWith("\n")).toBe(true);
  });

  it("handles invalid JSON gracefully without destroying user code", async () => {
    const brokenJson = '{"broken": json}';
    const res = await formatProjectFile(tempDir, "broken.json", brokenJson);
    expect(res.changed).toBe(false);
    expect(res.formatted).toBe(brokenJson);
    expect(res.warning).toBeDefined();
  });

  it("normalizes Python whitespace and trailing newlines", async () => {
    const rawPy = "def add(a, b):   \n    return a + b    \n\n\n\n";
    const res = await formatProjectFile(tempDir, "math.py", rawPy);
    expect(res.changed).toBe(true);
    expect(res.formatted).toBe("def add(a, b):\n    return a + b\n");
  });

  it("normalizes C/C++ source code whitespace and trailing lines", async () => {
    const rawC =
      '#include <stdio.h>   \nint main() {   \n    printf("hi\\n");   \n}   \n\n\n';
    const res = await formatProjectFile(tempDir, "main.c", rawC);
    expect(res.changed).toBe(true);

    // `commandExists("clang-format")` can be true while the spawn still
    // fails (broken/stub binary on some CI images). The product then
    // falls back to the built-in normalizer — assert the formatter that
    // actually produced `res`, not the PATH probe.
    if (res.formatter === "clang-format") {
      expect(res.formatted).not.toMatch(/[ \t]+$/m);
      expect(res.formatted).toContain("#include <stdio.h>");
      expect(res.formatted).toContain('printf("hi\\n")');
    } else {
      expect(res.formatter).toBe("c-normalizer");
      expect(res.formatted).toBe(
        '#include <stdio.h>\nint main() {\n    printf("hi\\n");\n}\n',
      );
    }
  });

  it("blocks path traversal attempts on format", async () => {
    await expect(
      formatProjectFile(tempDir, "../escape.js", 'console.log("bad");'),
    ).rejects.toThrow("Invalid file path");
  });
});
