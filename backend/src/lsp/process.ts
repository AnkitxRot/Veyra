import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LspLanguageSpec } from "./languages.js";

export interface LspSpawnRequest {
  spec: LspLanguageSpec;
  /** Trusted sandbox container id (`ide-sandbox-<projectId>`). */
  containerId: string;
}

export type LspSpawnFn = (
  req: LspSpawnRequest,
) => ChildProcessWithoutNullStreams;

/**
 * Host-side env for the `docker` CLI only. The language server itself runs
 * inside the sandbox and receives the `-e` values below — never the backend
 * process environment (secrets, Git PATs, admin password, DB path).
 */
export function lspHostDockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C",
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.PROGRAMDATA) env.PROGRAMDATA = process.env.PROGRAMDATA;
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  if (process.env.DOCKER_TLS_VERIFY) {
    env.DOCKER_TLS_VERIFY = process.env.DOCKER_TLS_VERIFY;
  }
  if (process.env.DOCKER_CERT_PATH) {
    env.DOCKER_CERT_PATH = process.env.DOCKER_CERT_PATH;
  }
  return env;
}

const SHARED_CONTAINER_ENV = [
  "HOME=/tmp",
  "XDG_CACHE_HOME=/tmp/xdg-cache",
  "XDG_CONFIG_HOME=/tmp/xdg-config",
  "XDG_DATA_HOME=/tmp/xdg-data",
  "TMPDIR=/tmp",
  "LC_ALL=C.UTF-8",
  "LANG=C.UTF-8",
];

function envFlags(spec: LspLanguageSpec): string[] {
  const out: string[] = [];
  for (const pair of [...SHARED_CONTAINER_ENV, ...spec.extraEnv]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(pair)) continue;
    if (/SECRET|TOKEN|PASSWORD|DATABASE|PAT|MASTER_KEY/i.test(pair)) continue;
    out.push("-e", pair);
  }
  return out;
}

export function sandboxLspArgv(req: LspSpawnRequest): string[] {
  const { spec, containerId } = req;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerId)) {
    throw new Error("invalid_container_id");
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(spec.command)) {
    throw new Error("invalid_lsp_command");
  }
  for (const arg of spec.args) {
    if (typeof arg !== "string" || arg.length > 128) {
      throw new Error("invalid_lsp_args");
    }
  }
  return [
    "exec",
    "-i",
    "-w",
    "/workspace",
    "-u",
    "ide",
    ...envFlags(spec),
    containerId,
    spec.command,
    ...spec.args,
  ];
}

/**
 * `docker exec -i` into the project sandbox. Executable and argv come from
 * the allowlist (`spec`), never from the client. Container env is explicit
 * and minimal — no secrets file, no `-e` passthrough of backend env.
 */
export function spawnSandboxLsp(
  req: LspSpawnRequest,
): ChildProcessWithoutNullStreams {
  const child = spawn("docker", sandboxLspArgv(req), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: lspHostDockerEnv(),
  });
  child.on("error", () => {});
  return child;
}
