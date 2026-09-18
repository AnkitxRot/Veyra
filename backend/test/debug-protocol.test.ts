import { describe, it, expect } from "vitest";
import {
  fromWorkspaceLocation,
  toWorkspaceFsPath,
  isForbiddenRelPath,
} from "../src/debug/paths.js";
import { parseLaunch, parseSetBreakpoints, parseArgs } from "../src/debug/protocol.js";
import { sandboxDebugArgv, debugHostDockerEnv } from "../src/debug/process.js";
import { PYTHON_DEBUG, NODE_DEBUG, getDebugLanguage } from "../src/debug/languages.js";

describe("debug path mapping", () => {
  it("maps /workspace paths and file URIs", () => {
    expect(fromWorkspaceLocation("/workspace/main.py")).toBe("main.py");
    expect(fromWorkspaceLocation("file:///workspace/pkg/mod.py")).toBe(
      "pkg/mod.py",
    );
    expect(toWorkspaceFsPath("src/index.ts")).toBe("/workspace/src/index.ts");
  });

  it("rejects escapes and host paths", () => {
    expect(fromWorkspaceLocation("/etc/passwd")).toBeNull();
    expect(fromWorkspaceLocation("/workspace/../etc/passwd")).toBeNull();
    expect(fromWorkspaceLocation("file:///etc/passwd")).toBeNull();
    expect(fromWorkspaceLocation("C:\\Windows\\system32")).toBeNull();
    expect(fromWorkspaceLocation("/tmp/veyra-debug/1/src/main.js")).toBeNull();
    expect(fromWorkspaceLocation("\\\\server\\share")).toBeNull();
    expect(fromWorkspaceLocation("../../secret")).toBeNull();
    expect(toWorkspaceFsPath("../x")).toBeNull();
    expect(toWorkspaceFsPath("/abs")).toBeNull();
  });

  it("rejects .git internals", () => {
    expect(isForbiddenRelPath(".git/config")).toBe(true);
    expect(isForbiddenRelPath(".cloudide-build-debug/main.js")).toBe(true);
    expect(isForbiddenRelPath("src/main.py")).toBe(false);
  });

  it("rejects Node internals and generated debug emit", () => {
    expect(
      fromWorkspaceLocation("<node_internals>/internal/modules/cjs/loader"),
    ).toBeNull();
    expect(
      fromWorkspaceLocation("/workspace/.cloudide-build-debug/1/src/main.js"),
    ).toBeNull();
    expect(fromWorkspaceLocation("src/main.ts")).toBe("src/main.ts");
  });
});

describe("debug launch validation", () => {
  it("accepts python and node entry files", () => {
    const py = parseLaunch({ language: "python", entryFile: "main.py" });
    expect(py.ok).toBe(true);
    const js = parseLaunch({ language: "node", entryFile: "src/index.ts" });
    expect(js.ok).toBe(true);
  });

  it("rejects executable / language mismatches / escapes", () => {
    expect(parseLaunch({ language: "python", entryFile: "../x.py" }).ok).toBe(
      false,
    );
    expect(parseLaunch({ language: "python", entryFile: "/bin/sh" }).ok).toBe(
      false,
    );
    expect(parseLaunch({ language: "python", entryFile: "main.js" }).ok).toBe(
      false,
    );
    expect(parseLaunch({ language: "java", entryFile: "Main.java" }).ok).toBe(
      false,
    );
    expect(getDebugLanguage("/bin/sh")).toBeNull();
    expect(getDebugLanguage("PYTHON")).toBeNull();
  });

  it("rejects unsafe args and breakpoint maps", () => {
    expect(parseArgs(["ok", "also ok"])).toEqual(["ok", "also ok"]);
    expect(parseArgs(["a\0b"])).toBeNull();
    expect(parseArgs("not-array")).toBeNull();
    expect(
      parseSetBreakpoints({ path: "../x.py", lines: [1] }).ok,
    ).toBe(false);
    expect(
      parseSetBreakpoints({ path: "main.py", lines: [0] }).ok,
    ).toBe(false);
    expect(
      parseSetBreakpoints({ path: "main.py", lines: [3, 3, 5] }).ok,
    ).toBe(true);
  });
});

describe("debug spawn argv", () => {
  it("uses allowlisted adapters and never interpolates client input", () => {
    const py = sandboxDebugArgv({
      spec: PYTHON_DEBUG,
      containerId: "ide-sandbox-abc",
    });
    expect(py).toContain("veyra-debugpy");
    expect(py).toContain("ide-sandbox-abc");
    expect(py.join(" ")).not.toMatch(/secret|TOKEN|PASSWORD/i);

    const node = sandboxDebugArgv({
      spec: NODE_DEBUG,
      containerId: "ide-sandbox-abc",
    });
    expect(node).toContain("veyra-js-debug");
  });

  it("rejects illegal container ids", () => {
    expect(() =>
      sandboxDebugArgv({ spec: PYTHON_DEBUG, containerId: "../../x" }),
    ).toThrow(/invalid_container_id/);
    expect(() =>
      sandboxDebugArgv({ spec: PYTHON_DEBUG, containerId: "a; rm -rf /" }),
    ).toThrow(/invalid_container_id/);
  });

  it("does not inherit backend secrets into the docker CLI env", () => {
    const env = debugHostDockerEnv();
    expect(env.SECRETS_MASTER_KEY).toBeUndefined();
    expect(env.DATABASE_PATH).toBeUndefined();
    expect(env.ADMIN_PASSWORD).toBeUndefined();
  });
});

describe("debug command allowlist", () => {
  it("does not expose evaluate, watches, or adapter selection", async () => {
    const { CLIENT_COMMANDS, ADAPTER_REQUESTS, REJECTED_ADAPTER_REQUESTS } =
      await import("../src/debug/protocol.js");
    expect(CLIENT_COMMANDS.has("evaluate")).toBe(false);
    expect(CLIENT_COMMANDS.has("launch")).toBe(true);
    expect(ADAPTER_REQUESTS.has("evaluate")).toBe(false);
    expect(REJECTED_ADAPTER_REQUESTS.has("runInTerminal")).toBe(true);
  });
});
