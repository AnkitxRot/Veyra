import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import {
  discoverWorkflow,
  isAllowlistedScriptName,
  kindForScriptName,
  parseNpmTaskId,
} from "../src/workflow/discover.js";

describe("workflow discovery", () => {
  it("allowlists only test/build script names", () => {
    expect(isAllowlistedScriptName("test")).toBe(true);
    expect(isAllowlistedScriptName("build")).toBe(true);
    expect(isAllowlistedScriptName("test:unit")).toBe(true);
    expect(isAllowlistedScriptName("build:prod")).toBe(true);
    expect(kindForScriptName("build:prod")).toBe("build");
    expect(kindForScriptName("test:unit")).toBe("test");
    expect(isAllowlistedScriptName("start")).toBe(false);
    expect(isAllowlistedScriptName("pretest")).toBe(false);
    expect(isAllowlistedScriptName("posttest")).toBe(false);
    expect(isAllowlistedScriptName("test && rm -rf /")).toBe(false);
    expect(isAllowlistedScriptName("test;id")).toBe(false);
    expect(isAllowlistedScriptName("")).toBe(false);
    expect(parseNpmTaskId("npm:test")).toBe("test");
    expect(parseNpmTaskId("npm:start")).toBeNull();
    expect(parseNpmTaskId("pytest:all")).toBeNull();
  });

  it("discovers only allowlisted package.json scripts", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({
        name: "demo",
        scripts: {
          test: "node --test",
          "test:unit": "node --test tests",
          build: "tsc",
          start: "node server.js",
          pretest: "echo no",
          "rm -rf": "echo no",
        },
      }),
    );
    const manifest = await discoverWorkflow(ws);
    expect(manifest.tasks.map((t) => t.id).sort()).toEqual([
      "npm:build",
      "npm:test",
      "npm:test:unit",
    ]);
    expect(manifest.tasks.find((t) => t.id === "npm:build")?.kind).toBe("build");
  });

  it("ignores malformed or oversized package.json", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "package.json"), "{not json");
    expect((await discoverWorkflow(ws)).tasks).toEqual([]);
  });

  it("discovers pytest from conventional markers", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "pytest.ini"), "[pytest]\n");
    const manifest = await discoverWorkflow(ws);
    expect(manifest.tasks).toEqual([
      { id: "pytest:all", name: "pytest", kind: "test", origin: "pytest" },
    ]);
  });

  it("discovers pytest from tests/test_*.py", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    mkdirSync(join(ws, "tests"));
    writeFileSync(join(ws, "tests", "test_math.py"), "def test_ok():\n  assert 1\n");
    const manifest = await discoverWorkflow(ws);
    expect(manifest.tasks.some((t) => t.id === "pytest:all")).toBe(true);
  });

  it("does not invent tasks in an empty workspace", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    expect((await discoverWorkflow(ws)).tasks).toEqual([]);
  });
});
