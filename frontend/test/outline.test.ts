import { describe, it, expect } from "vitest";
import { flattenSymbols, symbolPathAt, type OutlineSymbol } from "../src/outline";
import { parseSnippets } from "../src/snippets";

const sym = (name: string, s: number, e: number, children: OutlineSymbol[] = []): OutlineSymbol => ({
  name,
  kind: 5,
  range: { startLine: s, endLine: e },
  children,
});

describe("outline", () => {
  const tree = [sym("B", 20, 30), sym("A", 1, 10, [sym("m", 2, 5)])];
  it("flattens sorted with depth", () => {
    expect(flattenSymbols(tree).map((r) => [r.symbol.name, r.depth])).toEqual([
      ["A", 0],
      ["m", 1],
      ["B", 0],
    ]);
  });
  it("finds the symbol path at a line", () => {
    expect(symbolPathAt(tree, 3)).toEqual(["A", "m"]);
    expect(symbolPathAt(tree, 8)).toEqual(["A"]);
    expect(symbolPathAt(tree, 15)).toEqual([]);
  });
});

describe("parseSnippets", () => {
  it("parses VS Code shape incl. array prefix/body", () => {
    const s = parseSnippets(
      JSON.stringify({ log: { prefix: ["cl", "log"], body: ["console.log($1);", "$0"], description: "d" } }),
    );
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ prefix: "cl", body: "console.log($1);\n$0", description: "d" });
  });
  it("drops garbage safely", () => {
    expect(parseSnippets("nope")).toEqual([]);
    expect(parseSnippets("[]")).toEqual([]);
    expect(parseSnippets(JSON.stringify({ a: { prefix: 1, body: "x" }, b: { prefix: "p" }, c: 3 }))).toEqual([]);
  });
});
