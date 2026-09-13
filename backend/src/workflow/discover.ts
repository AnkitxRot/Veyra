/**
 * Deterministic discovery of project tests and builds.
 * Script *bodies* are never executed or interpolated. npm is invoked as
 * `npm run <allowlisted-name>` with a validated name only.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

export type WorkflowKind = "test" | "build";
export type WorkflowOrigin = "package.json" | "pytest";

export interface WorkflowTask {
  id: string;
  name: string;
  kind: WorkflowKind;
  origin: WorkflowOrigin;
}

export interface WorkflowManifest {
  tasks: WorkflowTask[];
}

const MAX_PACKAGE_JSON = 64 * 1024;
const MAX_SCRIPT_NAME = 64;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,63}$/;

export function isAllowlistedScriptName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_SCRIPT_NAME) {
    return false;
  }
  if (!SCRIPT_NAME.test(name)) return false;
  if (name === "test" || name === "build") return true;
  return name.startsWith("test:") || name.startsWith("build:");
}

export function kindForScriptName(name: string): WorkflowKind | null {
  if (!isAllowlistedScriptName(name)) return null;
  return name === "build" || name.startsWith("build:") ? "build" : "test";
}

export function npmTaskId(script: string): string {
  return `npm:${script}`;
}

export function parseNpmTaskId(id: string): string | null {
  if (typeof id !== "string" || !id.startsWith("npm:")) return null;
  const script = id.slice(4);
  return isAllowlistedScriptName(script) ? script : null;
}

function scriptKind(name: string): WorkflowKind {
  return name === "build" || name.startsWith("build:") ? "build" : "test";
}

export async function discoverWorkflow(workspaceDir: string): Promise<WorkflowManifest> {
  const tasks: WorkflowTask[] = [];
  tasks.push(...(await discoverNpmTasks(workspaceDir)));
  if (await discoverPytest(workspaceDir)) {
    tasks.push({
      id: "pytest:all",
      name: "pytest",
      kind: "test",
      origin: "pytest",
    });
  }
  return { tasks };
}

async function discoverNpmTasks(workspaceDir: string): Promise<WorkflowTask[]> {
  let raw: string;
  try {
    raw = await fs.readFile(join(workspaceDir, "package.json"), "utf8");
  } catch {
    return [];
  }
  if (raw.length > MAX_PACKAGE_JSON) return [];
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return [];
  const scripts = (pkg as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return [];
  }
  const out: WorkflowTask[] = [];
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof body !== "string") continue;
    if (!isAllowlistedScriptName(name)) continue;
    out.push({
      id: npmTaskId(name),
      name,
      kind: scriptKind(name),
      origin: "package.json",
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function discoverPytest(workspaceDir: string): Promise<boolean> {
  const markers = ["pytest.ini", "conftest.py"];
  for (const file of markers) {
    try {
      await fs.access(join(workspaceDir, file));
      return true;
    } catch {
      /* continue */
    }
  }
  try {
    const pyproject = await fs.readFile(join(workspaceDir, "pyproject.toml"), "utf8");
    if (pyproject.includes("[tool.pytest") || pyproject.includes("[tool.pytest.ini_options]")) {
      return true;
    }
  } catch {
    /* no pyproject */
  }
  try {
    const req = await fs.readFile(join(workspaceDir, "requirements.txt"), "utf8");
    if (/(^|\n)\s*pytest(\s|[><=!;[]|$)/i.test(req.slice(0, 16_384))) return true;
  } catch {
    /* no requirements */
  }
  try {
    const ents = await fs.readdir(join(workspaceDir, "tests"), { withFileTypes: true });
    if (ents.some((e) => e.isFile() && /^test_.*\.py$/.test(e.name))) return true;
  } catch {
    /* no tests dir */
  }
  try {
    const ents = await fs.readdir(workspaceDir, { withFileTypes: true });
    if (ents.some((e) => e.isFile() && /^test_.*\.py$/.test(e.name))) return true;
  } catch {
    /* unreadable */
  }
  return false;
}
