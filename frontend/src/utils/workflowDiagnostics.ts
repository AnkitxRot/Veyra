import type { Diagnostic } from "./diagnostics";
import type { WorkflowTestResult } from "../api";

const MAX = 200;

export function workflowResultsToDiagnostics(
  tests: WorkflowTestResult[] | undefined,
): Diagnostic[] {
  if (!Array.isArray(tests) || tests.length === 0) return [];
  const out: Diagnostic[] = [];
  for (const t of tests.slice(0, MAX)) {
    if (t.status !== "failed" && t.status !== "error") continue;
    if (!t.file || typeof t.file !== "string") continue;
    if (t.file.includes("..") || t.file.startsWith("/") || t.file.startsWith("\\")) {
      continue;
    }
    out.push({
      id: `test-${out.length}-${t.file}-${t.line ?? 0}`,
      severity: "error",
      message: t.message?.trim() || t.name || "Test failed",
      filePath: t.file,
      line: typeof t.line === "number" && t.line > 0 ? t.line : 1,
      source: "test",
    });
  }
  return out;
}
