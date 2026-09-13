import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import {
  parseWorkflowRequest,
  resolveWorkflowTask,
  sanitizeExtraArg,
  sanitizeWorkflowTarget,
} from "../src/workflow/resolve.js";

describe("workflow resolve", () => {
  it("resolves npm test/build to argv, never a shell string", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({
        scripts: { test: "node --test", build: "echo built" },
      }),
    );
    const test = await resolveWorkflowTask(ws, "npm:test");
    expect(test.ok).toBe(true);
    if (test.ok) {
      expect(test.value.command).toBe("npm");
      expect(test.value.args).toEqual(["run", "test"]);
    }
    const build = await resolveWorkflowTask(ws, "npm:build", "src/main.ts");
    expect(build.ok).toBe(true);
    if (build.ok) {
      expect(build.value.command).toBe("npm");
      expect(build.value.args).toEqual(["run", "build", "--", "src/main.ts"]);
    }
  });

  it("resolves pytest without interpolating the target into a shell", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "pytest.ini"), "[pytest]\n");
    const r = await resolveWorkflowTask(ws, "pytest:all", "tests/test_math.py");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.command).toBe("python3");
      expect(r.value.args).toEqual([
        "-m",
        "pytest",
        "-v",
        "--tb=short",
        "--",
        "tests/test_math.py",
      ]);
    }
  });

  it("refuses unknown, start, and injected task ids", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({ scripts: { test: "node --test", start: "node ." } }),
    );
    expect((await resolveWorkflowTask(ws, "npm:start")).ok).toBe(false);
    expect((await resolveWorkflowTask(ws, "npm:test;id")).ok).toBe(false);
    expect((await resolveWorkflowTask(ws, "sh")).ok).toBe(false);
    expect((await resolveWorkflowTask(ws, "")).ok).toBe(false);
  });

  it("refuses path-escaping targets", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    expect(sanitizeWorkflowTarget("../etc/passwd")).toBeNull();
    expect(sanitizeWorkflowTarget("/etc/passwd")).toBeNull();
    expect(sanitizeWorkflowTarget(".git/config")).toBeNull();
    expect(sanitizeExtraArg("foo;rm -rf /")).toBeNull();
    expect(sanitizeExtraArg("ok_file.js")).toBe("ok_file.js");
    const bad = await resolveWorkflowTask(ws, "npm:test", "../secret");
    expect(bad.ok).toBe(false);
  });

  it("parseWorkflowRequest accepts only taskId + optional targetPath", () => {
    expect(parseWorkflowRequest({ taskId: "npm:test" })).toEqual({
      ok: true,
      taskId: "npm:test",
    });
    expect(
      parseWorkflowRequest({ taskId: "npm:test", targetPath: "a.test.js" }),
    ).toEqual({ ok: true, taskId: "npm:test", targetPath: "a.test.js" });
    expect(parseWorkflowRequest({ taskId: "npm:test", command: "sh" }).ok).toBe(
      false,
    );
    expect(parseWorkflowRequest({ taskId: "npm:test", env: { A: "1" } }).ok).toBe(
      false,
    );
    expect(
      parseWorkflowRequest({ taskId: "npm:test", cwd: "/tmp" }).ok,
    ).toBe(false);
    expect(
      parseWorkflowRequest({ taskId: "npm:test", targetPath: "../x" }).ok,
    ).toBe(false);
  });
});
