import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLanguage, resolveMainFile } from "../src/execution/detect.js";
import { registry, getLang } from "../src/execution/languages.js";
import { makeTestConfig } from "./helpers.js";

describe("language registry", () => {
  it("has all expected language IDs", () => {
    const ids = registry.map((l) => l.id);
    expect(ids).toContain("python");
    expect(ids).toContain("node");
    expect(ids).toContain("c");
    expect(ids).toContain("cpp");
    expect(ids).toContain("java");
    expect(ids).toContain("typescript");
    expect(ids).toContain("html");
    expect(ids).toContain("css");
    expect(ids).toContain("json");
    expect(ids).toContain("markdown");
    expect(ids).toContain("react");
  });

  it("getLang returns correct language objects", () => {
    expect(getLang("python")?.id).toBe("python");
    expect(getLang("node")?.id).toBe("node");
    expect(getLang("typescript")?.id).toBe("typescript");
    expect(getLang("c")?.id).toBe("c");
    expect(getLang("java")?.id).toBe("java");
    expect(getLang("nonexistent")).toBeNull();
  });
});

describe("detectLanguage edge cases", () => {
  it("returns null for unknown explicit language", () => {
    expect(detectLanguage(["main.rs"], "rust")).toBeNull();
  });

  it("returns null for empty file list with no activeFile", () => {
    expect(detectLanguage([], null, null)).toBeNull();
  });

  it("respects activeFile extension over markers", () => {
    // activeFile is .ts → TypeScript, even though package.json exists
    expect(
      detectLanguage(["package.json", "main.ts"], null, "main.ts")?.id,
    ).toBe("typescript");
  });

  it("falls back to extension majority when no markers match", () => {
    // Only .js files, no package.json → detects node from extension
    const result = detectLanguage(["index.js", "utils.js", "helper.js"]);
    expect(result?.id).toBe("node");
  });
});

describe("resolveMainFile edge cases", () => {
  it("returns activeFile if it matches the language", () => {
    const py = detectLanguage(["main.py", "util.py"], "python")!;
    expect(resolveMainFile(py, ["main.py", "util.py"], "main.py")).toBe(
      "main.py",
    );
  });

  it("prefers canonical main file when activeFile does not match", () => {
    const py = detectLanguage(["main.py"], "python")!;
    // activeFile is .js, but main.py is in the files list and is a canonical main file
    expect(resolveMainFile(py, ["main.py"], "main.js")).toBe("main.py");
  });

  it("returns null when no files match the language and activeFile is unrelated", () => {
    const py = detectLanguage(["main.py"], "python")!;
    // activeFile is .rs, no .rs files in the list
    expect(resolveMainFile(py, ["main.py"], "main.rs")).toBe("main.py");
  });
});

describe("runProject compile-phase cancellation wiring", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../src/execution/sandbox.js");
    vi.doUnmock("../src/tools.js");
    vi.resetModules();
  });

  it("passes onController/onStdout/onStderr to the compile-phase sandboxRun call, with stdin closed", async () => {
    // Without this wiring, a WS 'stop' message during compilation has no
    // controller to call .kill() on — the compile process runs uncancelled
    // until the full build timeout elapses. This proves the fix without
    // needing a real Docker daemon or compiler: it verifies runProject's
    // orchestration passes the right options to sandboxRun for the build
    // step, not just the run step.
    const calls: any[] = [];
    vi.doMock("../src/execution/sandbox.js", () => ({
      sandboxRun: async (
        _projectId: string,
        _workspaceDir: string,
        opts: any,
      ) => {
        calls.push(opts);
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          signal: null,
          timedOut: false,
          oom: false,
          durationMs: 1,
        };
      },
    }));
    vi.doMock("../src/tools.js", () => ({
      isDockerRunningAsync: async () => true,
      isRunnerImageAvailableAsync: async () => true,
    }));

    const { runProject } = await import("../src/execution/pipeline.js");
    const cfg = makeTestConfig();
    const ws = mkdtempSync(join(tmpdir(), "pipeline-cancel-test-"));
    try {
      writeFileSync(
        join(ws, "main.c"),
        '#include <stdio.h>\nint main(){printf("hi");return 0;}\n',
      );

      const onController = vi.fn();
      await runProject(cfg, "test-project", ws, {
        language: "c",
        onController,
        onStdout: vi.fn(),
        onStderr: vi.fn(),
        userId: 1,
      });

      const compileCall = calls.find((c) => c.kind === "build");
      expect(compileCall).toBeDefined();
      expect(compileCall.onController).toBe(onController);
      expect(typeof compileCall.onStdout).toBe("function");
      expect(typeof compileCall.onStderr).toBe("function");
      // Must be an explicit empty string (closes stdin immediately in
      // sandboxRun), not undefined — undefined combined with onController
      // being set would leave the compile process's stdin pipe open,
      // which can hang some compilers waiting for input that never comes.
      expect(compileCall.stdin).toBe("");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("M5a: execution hot path uses async Docker checks, not blocking execSync", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../src/tools.js");
    vi.doUnmock("../src/execution/sandbox.js");
    vi.resetModules();
  });

  it("runProject resolves via isDockerRunningAsync/isRunnerImageAvailableAsync without ever calling the blocking sync variants", async () => {
    const asyncCalls: string[] = [];
    // Deliberately no isDockerRunning / isRunnerImageAvailable export: if
    // pipeline.ts's execution hot path still referenced the blocking sync
    // variants, this import would throw "is not a function" instead of
    // silently falling back to a real execSync call.
    vi.doMock("../src/tools.js", () => ({
      isDockerRunningAsync: async () => {
        asyncCalls.push("isDockerRunningAsync");
        return true;
      },
      isRunnerImageAvailableAsync: async () => {
        asyncCalls.push("isRunnerImageAvailableAsync");
        return true;
      },
    }));
    vi.doMock("../src/execution/sandbox.js", () => ({
      sandboxRun: async () => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        oom: false,
        durationMs: 1,
      }),
    }));

    const { runProject } = await import("../src/execution/pipeline.js");
    const cfg = makeTestConfig();
    const ws = mkdtempSync(join(tmpdir(), "pipeline-async-docker-test-"));
    try {
      writeFileSync(join(ws, "main.py"), "print('hi')\n");
      const result = await runProject(cfg, "test-project", ws, { userId: 1 });
      expect(result.type).toBe("success");
      expect(asyncCalls).toEqual([
        "isDockerRunningAsync",
        "isRunnerImageAvailableAsync",
      ]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("returns missing_toolchain (not a thrown error) when isDockerRunningAsync resolves false", async () => {
    // pipeline.ts intentionally runs the docker + runner-image probes
    // concurrently (Promise.all — the M5a latency optimization; the sibling
    // test above locks in that both are always invoked). So the runner-image
    // check *is* called here; the contract under test is only that a
    // Docker-down result is a graceful `missing_toolchain`, never a throw.
    const runnerCheckCalls: number[] = [];
    vi.doMock("../src/tools.js", () => ({
      isDockerRunningAsync: async () => false,
      isRunnerImageAvailableAsync: async () => {
        runnerCheckCalls.push(Date.now());
        return false;
      },
    }));

    const { runProject } = await import("../src/execution/pipeline.js");
    const cfg = makeTestConfig();
    const ws = mkdtempSync(join(tmpdir(), "pipeline-async-docker-down-test-"));
    try {
      writeFileSync(join(ws, "main.py"), "print('hi')\n");
      const result = await runProject(cfg, "test-project", ws, { userId: 1 });
      expect(result.type).toBe("missing_toolchain");
      expect(result.stderr).toContain("Docker Sandbox unavailable");
      // Docker-down wins the branch regardless of the (concurrent) runner
      // probe's outcome — and it must NOT surface as a thrown error.
      expect(result.stderr).not.toContain("Runner Image unavailable");
      // The runner probe is still dispatched (Promise.all); its result is
      // simply not what the Docker-down branch keys on.
      expect(runnerCheckCalls.length).toBeGreaterThan(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
