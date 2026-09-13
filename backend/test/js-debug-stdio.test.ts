import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  shouldForwardParentMessage,
  shouldStartChildDebuggee,
  isTypeScriptProgram,
  normalizeWorkspaceTsProgram,
  toWorkspaceSource,
  rewriteSourceMapSources,
  rewriteSourceMapsUnder,
  compileTypeScriptProgram,
  prepareChildLaunchConfig,
  compiledJsPath,
} from "../../docker/js-debug-stdio.mjs";

const require = createRequire(import.meta.url);

describe("js-debug parent/child event routing", () => {
  it("forwards parent traffic until the child session is ready", () => {
    expect(
      shouldForwardParentMessage({ type: "event", event: "continued" }, false),
    ).toBe(true);
    expect(
      shouldForwardParentMessage({ type: "response", command: "launch" }, false),
    ).toBe(true);
  });

  it("drops parent events after the child owns the debuggee", () => {
    expect(
      shouldForwardParentMessage({ type: "event", event: "continued" }, true),
    ).toBe(false);
    expect(
      shouldForwardParentMessage({ type: "event", event: "stopped" }, true),
    ).toBe(false);
    expect(
      shouldForwardParentMessage({ type: "event", event: "terminated" }, true),
    ).toBe(false);
    expect(
      shouldForwardParentMessage({ type: "event", event: "thread" }, true),
    ).toBe(false);
    expect(
      shouldForwardParentMessage({ type: "request", command: "startDebugging" }, true),
    ).toBe(false);
  });

  it("still forwards parent responses after child attach (launch handshake)", () => {
    expect(
      shouldForwardParentMessage(
        { type: "response", command: "launch", request_seq: 2 },
        true,
      ),
    ).toBe(true);
  });

  it("does not start the child debuggee until backend configurationDone", () => {
    expect(shouldStartChildDebuggee(false, 0)).toBe(false);
    expect(shouldStartChildDebuggee(false, 1999)).toBe(false);
    expect(shouldStartChildDebuggee(true, 0)).toBe(true);
    expect(shouldStartChildDebuggee(false, 2000)).toBe(true);
  });
});

describe("TypeScript program + source-map rewriting", () => {
  it("accepts only /workspace .ts programs", () => {
    expect(isTypeScriptProgram("/workspace/src/main.ts")).toBe(true);
    expect(isTypeScriptProgram("file:///workspace/src/main.ts")).toBe(true);
    expect(normalizeWorkspaceTsProgram("file:///workspace/src/main.ts")).toBe(
      "/workspace/src/main.ts",
    );
    expect(normalizeWorkspaceTsProgram("src/main.ts", "/workspace")).toBe(
      "/workspace/src/main.ts",
    );
    expect(isTypeScriptProgram("/workspace/../etc/passwd.ts")).toBe(false);
    expect(isTypeScriptProgram("/tmp/main.ts")).toBe(false);
    expect(isTypeScriptProgram("/workspace/main.js")).toBe(false);
  });

  it("refuses to compile a program outside /workspace", () => {
    expect(() =>
      compileTypeScriptProgram("/tmp/evil.ts", {
        outRoot: "/tmp/veyra-debug/1",
      }),
    ).toThrow(/invalid TypeScript program/);
    expect(() =>
      compileTypeScriptProgram("/workspace/src/main.ts", {
        outRoot: "/tmp/other/1",
      }),
    ).toThrow(/invalid TypeScript outDir/);
  });

  it("maps sources onto /workspace and rejects escapes", () => {
    expect(toWorkspaceSource("src/main.ts")).toBe("/workspace/src/main.ts");
    expect(
      toWorkspaceSource("src/main.ts", { sourceRoot: "/workspace/" }),
    ).toBe("/workspace/src/main.ts");
    expect(toWorkspaceSource("/etc/passwd")).toBeNull();
    expect(toWorkspaceSource("../secret.ts")).toBeNull();
    expect(
      toWorkspaceSource("../../src/main.ts", {
        mapDir: "/tmp/proj/out/src",
        actualRoot: "/tmp/proj",
      }),
    ).toBe("/workspace/src/main.ts");
    expect(
      toWorkspaceSource("../../../etc/passwd", {
        mapDir: "/tmp/proj/out/src",
        actualRoot: "/tmp/proj",
      }),
    ).toBeNull();
    expect(toWorkspaceSource("file:///workspace/src/helper.ts")).toBe(
      "/workspace/src/helper.ts",
    );
    expect(
      toWorkspaceSource("D:/tmp/proj/src/app.ts", {
        actualRoot: "D:/tmp/proj",
      }),
    ).toBe("/workspace/src/app.ts");
  });

  it("rewrites source maps to workspace paths only", () => {
    const map = rewriteSourceMapSources({
      version: 3,
      sourceRoot: "/workspace/",
      sources: ["src/main.ts", "../secret.ts", "/etc/passwd"],
      mappings: "",
    });
    expect(map.sources).toEqual(["/workspace/src/main.ts"]);
    expect(map.sourceRoot).toBe("");
  });

  it("computes isolated compiled JS paths", () => {
    expect(compiledJsPath("/workspace/src/nested/app.ts", "/tmp/veyra-debug/9")).toBe(
      "/tmp/veyra-debug/9/src/nested/app.js",
    );
    expect(compiledJsPath("/workspace/../x.ts", "/tmp/veyra-debug/9")).toBeNull();
  });

  it("prepares child launch to use compiled JS and isolated maps", () => {
    const next = prepareChildLaunchConfig(
      {
        program: "/workspace/src/main.ts",
        runtimeArgs: ["--import", "tsx"],
        type: "pwa-node",
      },
      "/tmp/veyra-debug/1/src/main.js",
    );
    expect(next.program).toBe("/tmp/veyra-debug/1/src/main.js");
    expect(next.runtimeArgs).toBeUndefined();
    expect(next.outFiles).toContain("/workspace/.cloudide-build-debug/**/*.js");
    expect(next.resolveSourceMapLocations).toContain("/workspace/**");
  });

  it("compiles a nested TypeScript fixture with workspace source maps", () => {
    const tsc = require.resolve("typescript/bin/tsc");
    const root = mkdtempSync(join(tmpdir(), "veyra-ts-debug-"));
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "helper.ts"),
      [
        "export interface Point { x: number; y: number }",
        "export function add(a: number, b: number): number {",
        "  const sum = a + b;",
        "  return sum;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(src, "main.ts"),
      [
        'import { add, type Point } from "./helper";',
        "const p: Point = { x: 1, y: 2 };",
        "const z: number = add(p.x, p.y);",
        "console.log(z);",
        "",
      ].join("\n"),
      "utf8",
    );
    const out = join(root, "out");
    const js = compileTypeScriptProgram(join(src, "main.ts"), {
      allowHostPaths: true,
      workspaceRoot: root,
      outRoot: out,
      tscPath: tsc,
      preferTsc: true,
    });
    expect(existsSync(js)).toBe(true);
    const map = JSON.parse(readFileSync(`${js}.map`, "utf8"));
    expect(map.sources).toContain("/workspace/src/main.ts");
    expect(map.sources.every((s: string) => s.startsWith("/workspace/"))).toBe(
      true,
    );
    const helperMap = JSON.parse(
      readFileSync(join(out, "src", "helper.js.map"), "utf8"),
    );
    expect(helperMap.sources).toContain("/workspace/src/helper.ts");
  });

  it("rewrites tsc maps from outDir even when relative sources are off by a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "veyra-ts-maps-"));
    const srcDir = join(root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "main.js"), "console.log(1)\n", "utf8");
    writeFileSync(
      join(srcDir, "main.js.map"),
      JSON.stringify({
        version: 3,
        file: "main.js",
        sourceRoot: "",
        sources: ["../../../workspace/src/main.ts"],
        mappings: "",
      }),
      "utf8",
    );
    rewriteSourceMapsUnder(root, { workspaceAlias: "/workspace" });
    const map = JSON.parse(readFileSync(join(srcDir, "main.js.map"), "utf8"));
    expect(map.sources).toEqual(["/workspace/src/main.ts"]);
  });
});
