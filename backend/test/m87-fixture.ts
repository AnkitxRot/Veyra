/**
 * M87 test fixture: an app, a project, and an "attacker shell" that runs
 * inside the project sandbox exactly like a collaborator's terminal does
 * (`docker exec -u ide` into `ide-sandbox-<id>`, cwd /workspace).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  makeTestConfig,
  startTestApi,
  stopProjectSandboxesForTest,
  type TestApi,
} from "./helpers.js";
import type { AppConfig, ConfigOverrides } from "../src/config.js";
import type { Db } from "../src/db.js";
import {
  addProjectCollaborator,
  createProject,
  workspacePath,
} from "../src/projects/service.js";
import { sandboxManager } from "../src/execution/sandbox.js";

const execFileAsync = promisify(execFile);

export interface M87Fixture {
  cfg: AppConfig;
  api: TestApi;
  db: Db;
  ownerId: number;
  ownerToken: string;
  editorToken: string;
  viewerToken: string;
  outsiderToken: string;
  projectId: string;
  cwd: string;
  /** Host-only path; its existence proves host command execution. */
  hostMarker: string;
  g: (p: string) => string;
  /** Run a shell script in the project sandbox as the `ide` user. */
  sh: (script: string, opts?: { input?: string }) => Promise<string>;
  /** Plant `.m87/payload.sh` (see PAYLOAD) in the workspace. */
  plantPayload: () => Promise<void>;
  sandboxRan: () => Promise<string>;
  hostRan: () => boolean;
  close: () => Promise<void>;
}

/**
 * Runs wherever Git runs it. In the sandbox it records the invocation under
 * /workspace/.m87; anywhere else (the backend host) it writes the host
 * marker. It then behaves like `cat` so filters / textconv keep working.
 */
function payloadScript(hostMarker: string): string {
  return [
    "#!/bin/sh",
    'if [ -f /.dockerenv ] && [ -d /opt/debug/bin ]; then',
    '  printf "%s\\n" "ran $*" >> /workspace/.m87/ran-in-sandbox',
    "  env >> /workspace/.m87/sandbox-env",
    "else",
    `  printf "host\\n" > '${hostMarker}'`,
    "fi",
    'if [ "$#" -ge 1 ] && [ -f "$1" ]; then cat "$1"; else cat; fi',
    "",
  ].join("\n");
}

export async function makeM87Fixture(
  overrides: ConfigOverrides = {},
): Promise<M87Fixture> {
  const cfg = makeTestConfig(overrides);
  const api = await startTestApi(cfg);
  const db = api.db;
  const suffix = randomBytes(3).toString("hex");
  const mk = async (u: string) =>
    (
      await api.request("POST", "/api/auth/register", {
        body: { username: `${u}${suffix}`, password: "password123" },
      })
    ).data;
  const owner = await mk("m87own");
  const editor = await mk("m87edt");
  const viewer = await mk("m87vwr");
  const outsider = await mk("m87out");
  const proj = await createProject(cfg, db, owner.user.id, {
    name: "m87",
    language: "python",
  });
  addProjectCollaborator(db, proj.id, editor.user.id, "editor");
  addProjectCollaborator(db, proj.id, viewer.user.id, "viewer");
  const cwd = await workspacePath(cfg, proj.id);
  const hostMarker = join(cfg.dataDir, "HOST_EXECUTED").replace(/\\/g, "/");

  const sh = async (script: string, opts: { input?: string } = {}) => {
    const cid = await sandboxManager.ensureProjectSandbox(
      proj.id,
      cfg,
      cwd,
      owner.user.id,
    );
    const child = execFileAsync(
      "docker",
      // umask 0 like sandbox Git, so a backend with another uid can clean up.
      ["exec", "-i", "-u", "ide", "-w", "/workspace", cid, "sh", "-c", `umask 0; ${script}`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    child.child.stdin?.end(opts.input ?? "");
    const { stdout } = await child;
    return stdout;
  };

  return {
    cfg,
    api,
    db,
    ownerId: owner.user.id,
    ownerToken: owner.token,
    editorToken: editor.token,
    viewerToken: viewer.token,
    outsiderToken: outsider.token,
    projectId: proj.id,
    cwd,
    hostMarker,
    g: (p) => `/api/projects/${proj.id}/git${p}`,
    sh,
    plantPayload: async () => {
      // .m87/ is kept out of every commit and status via info/exclude.
      await sh(
        "mkdir -p .m87 .git/info && cat > .m87/payload.sh && chmod 755 .m87/payload.sh" +
          " && printf '.m87/\n' >> .git/info/exclude",
        {
          input: payloadScript(hostMarker),
        },
      );
    },
    sandboxRan: async () =>
      sh("cat .m87/ran-in-sandbox 2>/dev/null || true"),
    hostRan: () => existsSync(hostMarker),
    close: async () => {
      await stopProjectSandboxesForTest(db);
      await api.close();
      await fs.rm(cfg.dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
