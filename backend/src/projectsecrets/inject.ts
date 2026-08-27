import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

/**
 * M47 — secure, non-argv secret injection into sandbox containers.
 *
 * Secret VALUES are never passed on a `docker` command line (that would leak
 * them via host `ps` / `/proc/<pid>/cmdline`). Instead a `0600` env file is
 * streamed over STDIN into the container's `/run` tmpfs and sourced there by
 * the target process. The file is removed after use; even if that fails the
 * tmpfs is destroyed when the container is reaped. No secret value is ever
 * written to the project workspace.
 */

const CONTAINER_SECRETS_DIR = "/run/cloudide-secrets";
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Render a POSIX-sh-sourceable file: `export NAME='value'` with single-quote
 * escaping (`'` -> `'\''`). Names are re-validated defensively; anything that
 * is not a plain identifier is dropped rather than risk shell injection.
 */
export function renderSecretsEnvFile(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!NAME_RE.test(k)) continue;
    lines.push(`export ${k}='${v.replace(/'/g, "'\\''")}'`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * argv prefix that sources the staged env file and then execs the real
 * command. Only the file path (a UUID under /run) is interpolated — never a
 * secret value — so `ps` / `/proc/<pid>/cmdline` on the host never sees a
 * secret. Used as: `docker exec ... <containerId> <prefix> <command> <args>`.
 */
export function secretsExecPrefix(filePath: string): string[] {
  return ["sh", "-c", `set -a; . '${filePath}'; set +a; exec "$@"`, "sh"];
}

export interface ContainerSecretsFile {
  /** Absolute path inside the container. Safe to embed in a shell command
   *  (derived solely from a UUID). */
  path: string;
  /** Best-effort removal of the file from the container. */
  cleanup: () => Promise<void>;
}

/**
 * Write `content` to a fresh `0600` file in the container's `/run` tmpfs by
 * streaming it over the child process STDIN. The content never appears in the
 * host argv. Returns the in-container path and a cleanup function.
 */
export async function writeContainerSecretsFile(
  containerId: string,
  content: string,
): Promise<ContainerSecretsFile> {
  const token = randomUUID();
  const path = `${CONTAINER_SECRETS_DIR}/${token}.env`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "ide",
        containerId,
        "sh",
        "-c",
        `set -e; mkdir -p ${CONTAINER_SECRETS_DIR}; chmod 700 ${CONTAINER_SECRETS_DIR}; umask 077; cat > ${path}`,
      ],
      { stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `could not stage secrets file (exit ${code})${
              stderr.trim() ? `: ${stderr.trim()}` : ""
            }`,
          ),
        );
    });
    child.stdin.write(content);
    child.stdin.end();
  });

  return {
    path,
    cleanup: async () => {
      try {
        await execFileAsync("docker", [
          "exec",
          "--user",
          "ide",
          containerId,
          "rm",
          "-f",
          path,
        ]);
      } catch {
        // The /run tmpfs is wiped when the container is removed.
      }
    },
  };
}
