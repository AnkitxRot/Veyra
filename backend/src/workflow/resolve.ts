import { normalizeRelPath } from "../lsp/uri.js";
import { isForbiddenRelPath } from "../debug/paths.js";
import {
  discoverWorkflow,
  isAllowlistedScriptName,
  parseNpmTaskId,
  type WorkflowKind,
  type WorkflowTask,
} from "./discover.js";

export interface ResolvedWorkflow {
  task: WorkflowTask;
  command: string;
  args: string[];
  kind: WorkflowKind;
}

const MAX_TARGET = 260;
const EXTRA_ARG = /^[A-Za-z0-9_:=,./\\[\]*-]{1,128}$/;

export function sanitizeWorkflowTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TARGET) {
    return null;
  }
  const rel = normalizeRelPath(value.replace(/\\/g, "/"));
  if (!rel || isForbiddenRelPath(rel)) return null;
  return rel;
}

export function sanitizeExtraArg(value: unknown): string | null {
  if (typeof value !== "string" || !EXTRA_ARG.test(value)) return null;
  if (value.includes("..")) return null;
  return value;
}

export async function resolveWorkflowTask(
  workspaceDir: string,
  taskId: unknown,
  targetPath?: unknown,
): Promise<{ ok: true; value: ResolvedWorkflow } | { ok: false; error: string }> {
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 96) {
    return { ok: false, error: "invalid task" };
  }
  const manifest = await discoverWorkflow(workspaceDir);
  const task = manifest.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: "unknown or disallowed task" };

  const target = targetPath === undefined || targetPath === null
    ? null
    : sanitizeWorkflowTarget(targetPath);
  if (targetPath != null && target === null) {
    return { ok: false, error: "invalid target path" };
  }

  if (task.origin === "pytest") {
    const args = ["-m", "pytest", "-v", "--tb=short"];
    if (target) args.push("--", target);
    return {
      ok: true,
      value: {
        task,
        command: "python3",
        args,
        kind: "test",
      },
    };
  }

  const script = parseNpmTaskId(task.id);
  if (!script || !isAllowlistedScriptName(script)) {
    return { ok: false, error: "invalid task" };
  }
  const args = ["run", script];
  if (target) {
    args.push("--", target);
  }
  return {
    ok: true,
    value: {
      task,
      command: "npm",
      args,
      kind: task.kind,
    },
  };
}

/** Client may send only `{ taskId, targetPath? }`. Anything else is rejected. */
export function parseWorkflowRequest(
  value: unknown,
):
  | { ok: true; taskId: string; targetPath?: string }
  | { ok: false; error: string } {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "invalid workflow" };
  }
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "taskId" && key !== "targetPath") {
      return { ok: false, error: "invalid workflow" };
    }
  }
  if (typeof o.taskId !== "string" || o.taskId.length === 0 || o.taskId.length > 96) {
    return { ok: false, error: "invalid task" };
  }
  if (o.targetPath === undefined || o.targetPath === null) {
    return { ok: true, taskId: o.taskId };
  }
  const target = sanitizeWorkflowTarget(o.targetPath);
  if (!target) return { ok: false, error: "invalid target path" };
  return { ok: true, taskId: o.taskId, targetPath: target };
}
