import { describe, it, expect } from "vitest";
import { buildFileIndex, searchFileIndex, MAX_QUICK_OPEN_RESULTS } from "../src/utils/fileIndex";
import type { TreeNode } from "../src/types";

function file(path: string): TreeNode {
  const name = path.split("/").pop()!;
  return { name, path, type: "file" };
}

describe("fileIndex", () => {
  it("flattens nested tree nodes", () => {
    const tree: TreeNode[] = [
      {
        name: "src",
        path: "src",
        type: "dir",
        children: [file("src/a.ts"), file("src/b.ts")],
      },
      file("README.md"),
    ];
    const index = buildFileIndex(tree);
    expect(index.map((f) => f.path).sort()).toEqual([
      "README.md",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("caps empty-query results so Quick Open cannot mount thousands of rows", () => {
    const index = Array.from({ length: 400 }, (_, i) => ({
      path: `f${i}.ts`,
      filename: `f${i}.ts`,
      extension: "ts",
      directory: "",
    }));
    const result = searchFileIndex(index, "");
    expect(result.length).toBe(MAX_QUICK_OPEN_RESULTS);
  });

  it("ranks exact filename matches first", () => {
    const index = [
      { path: "pkg/main.ts", filename: "main.ts", extension: "ts", directory: "pkg" },
      { path: "main.ts", filename: "main.ts", extension: "ts", directory: "" },
      { path: "src/helper.ts", filename: "helper.ts", extension: "ts", directory: "src" },
    ];
    const result = searchFileIndex(index, "main.ts");
    expect(result[0]?.path).toBe("main.ts");
  });
});
