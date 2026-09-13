import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { IS_WINDOWS, type AppConfig } from "../config.js";
import { normalizeHttpsHostname } from "./remoteUrl.js";

/**
 * M80 — non-argv Git credential transport.
 *
 * Writes username/password to 0600 files under a server-owned temp directory
 * (never the project workspace) and points Git at a tiny askpass helper that
 * contains no secrets. Git's argv sees only the helper path. The helper
 * refuses to answer a prompt for a host other than the one we validated.
 */

const HELPER_SOURCE = `"use strict";
var fs = require("fs");
var prompt = process.argv.slice(2).join(" ");
var allowed = process.env.CLOUDIDE_GIT_ASKPASS_HOST || "";
if (allowed) {
  var m = prompt.match(/https:\\/\\/[^\\s'"]+/i);
  if (!m) process.exit(1);
  try {
    var prompted = new URL(m[0]).hostname;
    if (prompted.charAt(0) === "[" && prompted.charAt(prompted.length - 1) === "]") {
      prompted = prompted.slice(1, -1);
    }
    var allow = allowed;
    if (allow.charAt(0) === "[" && allow.charAt(allow.length - 1) === "]") {
      allow = allow.slice(1, -1);
    }
    if (prompted.toLowerCase() !== allow.toLowerCase()) process.exit(1);
  } catch (e) {
    process.exit(1);
  }
}
var userFile = process.env.CLOUDIDE_GIT_ASKPASS_USER;
var passFile = process.env.CLOUDIDE_GIT_ASKPASS_PASS;
if (!userFile || !passFile) process.exit(1);
var wantUser = /username/i.test(prompt);
try {
  process.stdout.write(fs.readFileSync(wantUser ? userFile : passFile, "utf8"));
} catch (e) {
  process.exit(1);
}
`;

/** True when the Git askpass prompt names the validated remote host. */
export function askpassAllowsPrompt(prompt: string, allowedHost: string): boolean {
  if (!allowedHost) return true;
  const m = prompt.match(/https:\/\/[^\s'"]+/i);
  if (!m) return false;
  try {
    return (
      normalizeHttpsHostname(new URL(m[0]).hostname).toLowerCase() ===
      normalizeHttpsHostname(allowedHost).toLowerCase()
    );
  } catch {
    return false;
  }
}

export interface GitAskpassCreds {
  username: string;
  token: string;
  host: string;
}

export interface GitAskpassSession {
  extraEnv: NodeJS.ProcessEnv;
  secrets: string[];
  cleanup: () => Promise<void>;
}

export async function createGitAskpass(
  cfg: AppConfig,
  creds: GitAskpassCreds,
): Promise<GitAskpassSession> {
  const dir = join(cfg.dataDir, ".git-askpass", randomUUID());
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const userFile = join(dir, "user");
  const passFile = join(dir, "pass");
  const helperJs = join(dir, "askpass-helper.cjs");
  const launcher = join(dir, IS_WINDOWS ? "askpass.cmd" : "askpass");

  await fs.writeFile(userFile, creds.username, { mode: 0o600, flag: "wx" });
  await fs.chmod(userFile, 0o600);
  await fs.writeFile(passFile, creds.token, { mode: 0o600, flag: "wx" });
  await fs.chmod(passFile, 0o600);
  await fs.writeFile(helperJs, HELPER_SOURCE, { mode: 0o600 });
  if (IS_WINDOWS) {
    await fs.writeFile(
      launcher,
      "@\"%CLOUDIDE_NODE%\" \"%CLOUDIDE_GIT_ASKPASS_JS%\" %*\r\n",
      { mode: 0o700 },
    );
  } else {
    await fs.writeFile(
      launcher,
      "#!/bin/sh\nexec \"$CLOUDIDE_NODE\" \"$CLOUDIDE_GIT_ASKPASS_JS\" \"$@\"\n",
      { mode: 0o700 },
    );
    await fs.chmod(launcher, 0o700);
  }

  const extraEnv: NodeJS.ProcessEnv = {
    GIT_ASKPASS: launcher,
    GIT_TERMINAL_PROMPT: "0",
    CLOUDIDE_NODE: process.execPath,
    CLOUDIDE_GIT_ASKPASS_JS: helperJs,
    CLOUDIDE_GIT_ASKPASS_USER: userFile,
    CLOUDIDE_GIT_ASKPASS_PASS: passFile,
    CLOUDIDE_GIT_ASKPASS_HOST: creds.host,
  };

  const secrets = [creds.token];
  if (creds.username.length >= 4) secrets.push(creds.username);

  return {
    extraEnv,
    secrets,
    cleanup: async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // best-effort; the directory is outside every workspace
      }
    },
  };
}

export async function withGitAskpass<T>(
  cfg: AppConfig,
  creds: GitAskpassCreds | null,
  fn: (session: { extraEnv: NodeJS.ProcessEnv; secrets: string[] }) => Promise<T>,
): Promise<T> {
  if (!creds) {
    return fn({ extraEnv: {}, secrets: [] });
  }
  const session = await createGitAskpass(cfg, creds);
  try {
    return await fn(session);
  } finally {
    await session.cleanup();
  }
}
