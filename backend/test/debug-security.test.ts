import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestConfig, makeWorkspace } from "./helpers.js";
import {
  debugSessions,
  resetDebugSessionsForTests,
} from "../src/debug/manager.js";
import type { DebugClientSocket } from "../src/debug/session.js";
import type { DebugSpawnRequest } from "../src/debug/process.js";
import { sandboxDebugArgv, debugHostDockerEnv } from "../src/debug/process.js";
import { PYTHON_DEBUG } from "../src/debug/languages.js";

const fakeDap = fileURLToPath(new URL("./fixtures/fake-dap.mjs", import.meta.url));

function spawnFake() {
  return (_req: DebugSpawnRequest) =>
    spawn(process.execPath, [fakeDap], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
}

class FakeSock implements DebugClientSocket {
  readyState = 1;
  messages: any[] = [];
  send(data: string): void {
    this.messages.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
}

describe("debug security envelope", () => {
  beforeEach(() => {
    resetDebugSessionsForTests();
    debugSessions.setSpawnForTests(spawnFake());
    debugSessions.setContainerForTests(() => "ide-sandbox-secure");
  });
  afterEach(() => {
    resetDebugSessionsForTests();
  });

  it("never puts client-chosen executables or containers on argv", () => {
    const argv = sandboxDebugArgv({
      spec: PYTHON_DEBUG,
      containerId: "ide-sandbox-a",
    });
    expect(argv[0]).toBe("exec");
    expect(argv.includes("veyra-debugpy")).toBe(true);
    expect(argv.includes("/bin/sh")).toBe(false);
    expect(argv.some((a) => a.includes(".."))).toBe(false);
  });

  it("docker host env is an allowlist, not process.env", () => {
    const env = debugHostDockerEnv();
    expect(Object.keys(env).every((k) =>
      /^(PATH|LANG|SystemRoot|USERPROFILE|HOME|PROGRAMDATA|DOCKER_HOST|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH)$/.test(
        k,
      ),
    )).toBe(true);
  });

  it("drops evaluate / watch-style client commands", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "x = 1\n");
    const sock = new FakeSock();
    const session = await debugSessions.attach({
      projectId: "sec",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: ws,
    });
    session!.handleClientMessage(sock, {
      type: "evaluate",
      expression: "open('/etc/passwd').read()",
    });
    session!.handleClientMessage(sock, {
      jsonrpc: "2.0",
      method: "evaluate",
      expression: "1+1",
    });
    expect(sock.messages.some((m) => m.type === "variables" && m.result)).toBe(
      false,
    );
    expect(
      sock.messages.some((m) => typeof m.result === "string" && m.result.includes("passwd")),
    ).toBe(false);
  });

  it("does not accept a container id or host path from the client", async () => {
    const cfg = makeTestConfig();
    const ws = makeWorkspace(cfg);
    writeFileSync(join(ws, "main.py"), "x = 1\n");
    const sock = new FakeSock();
    const session = await debugSessions.attach({
      projectId: "sec",
      userId: 1,
      cfg,
      socket: sock,
      workspaceDir: ws,
    });
    session!.handleClientMessage(sock, {
      type: "launch",
      language: "python",
      entryFile: "main.py",
      containerId: "ide-sandbox-other-project",
      cwd: "/etc",
      env: { SECRETS_MASTER_KEY: "leak" },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(sock.messages.some((m) => m.type === "error")).toBe(true);
  });
});
