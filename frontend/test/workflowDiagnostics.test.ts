import { describe, it, expect } from "vitest";
import { workflowResultsToDiagnostics } from "../src/utils/workflowDiagnostics";

describe("workflowResultsToDiagnostics", () => {
  it("maps failed tests with files and rejects escapes", () => {
    const diags = workflowResultsToDiagnostics([
      {
        name: "adds",
        status: "passed",
        file: "tests/add.test.js",
        line: 3,
      },
      {
        name: "fails",
        status: "failed",
        file: "tests/add.test.js",
        line: 8,
        message: "expected 3",
      },
      {
        name: "escape",
        status: "failed",
        file: "../secret",
        line: 1,
        message: "nope",
      },
    ]);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      filePath: "tests/add.test.js",
      line: 8,
      source: "test",
      severity: "error",
      message: "expected 3",
    });
  });
});
