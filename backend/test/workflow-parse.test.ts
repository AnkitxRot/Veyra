import { describe, it, expect } from "vitest";
import { parseTestOutput } from "../src/workflow/parse.js";

describe("workflow test output parsers", () => {
  it("parses pytest -v lines and maps workspace files", () => {
    const out = parseTestOutput(
      [
        "tests/test_math.py::test_add PASSED",
        "tests/test_math.py::test_fail FAILED",
        "tests/test_math.py::test_skip SKIPPED",
      ].join("\n"),
    );
    expect(out).toEqual([
      {
        name: "test_add",
        file: "tests/test_math.py",
        line: undefined,
        status: "passed",
      },
      {
        name: "test_fail",
        file: "tests/test_math.py",
        line: undefined,
        status: "failed",
      },
      {
        name: "test_skip",
        file: "tests/test_math.py",
        line: undefined,
        status: "skipped",
      },
    ]);
  });

  it("parses TAP and node --test checkmarks with stack locations", () => {
    const tap = parseTestOutput("ok 1 - adds\nnot ok 2 - fails\n");
    expect(tap.map((t) => t.status)).toEqual(["passed", "failed"]);

    const nodeTap = parseTestOutput(
      [
        "TAP version 13",
        "ok 1 - adds",
        "not ok 2 - fails",
        "  ---",
        "  location: '/workspace/tests/add.test.js:4:1'",
        "  stack: |-",
        "    TestContext.<anonymous> (/workspace/tests/add.test.js:4:30)",
        "  ...",
      ].join("\n"),
    );
    const tapFail = nodeTap.find((t) => t.status === "failed");
    expect(tapFail?.file).toBe("tests/add.test.js");
    expect(tapFail?.line).toBe(4);

    const node = parseTestOutput(
      [
        "✔ adds (0.4ms)",
        "✖ fails (1.2ms)",
        "  Error: bad",
        "      at TestContext.<anonymous> (/workspace/tests/add.test.js:8:3)",
      ].join("\n"),
    );
    expect(node[0]).toMatchObject({ name: "adds", status: "passed" });
    const failed = node.find((t) => t.status === "failed");
    expect(failed?.file).toBe("tests/add.test.js");
    expect(failed?.line).toBe(8);
  });

  it("rejects source locations outside the workspace", () => {
    const out = parseTestOutput(
      "✖ escape (1ms)\n      at boom (/etc/passwd:1:1)\n",
    );
    const failed = out.find((t) => t.status === "failed");
    expect(failed?.file).toBeUndefined();
  });

  it("bounds huge input and case counts", () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `ok ${i + 1} - case-${i}`,
    );
    const out = parseTestOutput(lines.join("\n"));
    expect(out.length).toBe(200);
  });

  it("does not treat ordinary source lines as results", () => {
    expect(parseTestOutput("x = 1\nconst y = 2\n")).toEqual([]);
  });
});
