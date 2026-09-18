import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import { projectDir } from "../projects/service.js";
import { safeResolve, assertInsideWorkspace } from "../files/service.js";
import { readConfinedFile } from "../files/confined.js";
import { searchProjectContent } from "../projects/search.js";
import { searchGate } from "../execution/runGate.js";
import type { AIContextBundle } from "./provider.js";

export interface BuildContextOptions {
  activeFilePath: string;
  selectedCode?: string;
  selectionRange?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  diagnostics?: Array<{
    message: string;
    line: number;
    column?: number;
    source: string;
    severity: string;
    code?: string;
  }>;
  searchQuery?: string;
  maxChars?: number;
}

/**
 * Builds a bounded, deduplicated context bundle for AI actions.
 */
export async function buildAIContext(
  cfg: AppConfig,
  db: Db,
  projectId: string,
  userId: number,
  opts: BuildContextOptions,
): Promise<AIContextBundle> {
  const maxChars = opts.maxChars || 16000;
  const baseDir = projectDir(cfg, projectId);

  // 1. Read Active File Content
  // `activeFilePath` is caller-supplied (POST /:id/ai/action body) and project
  // access alone says nothing about which path *within* the project is legal,
  // so it must be contained before it reaches the filesystem: safeResolve()
  // rejects absolute/lexical-traversal paths and assertInsideWorkspace()
  // resolves symlinks so a planted junction cannot escape either. Both throw,
  // and both are deliberately caught here so a rejected path degrades to "no
  // file content" exactly like a genuine ENOENT already does — this endpoint
  // must not become a path-existence oracle, and its response shape is
  // unchanged.
  let fileContent = "";
  try {
    const fullPath = safeResolve(baseDir, opts.activeFilePath);
    await assertInsideWorkspace(baseDir, fullPath);
    fileContent = (await readConfinedFile(baseDir, fullPath)).content;
  } catch {
    fileContent = "";
  }

  // Detect language from extension
  const ext = opts.activeFilePath.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    py: "python",
    c: "c",
    cpp: "cpp",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    java: "java",
    json: "json",
    md: "markdown",
  };
  const language = langMap[ext] || "plaintext";

  // 2. Fetch Recent Execution History
  let recentExecution: AIContextBundle["recentExecution"] = undefined;
  try {
    const lastRun = db
      .prepare(
        `SELECT exit_code, status, duration_ms
         FROM runs
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(projectId) as
      | { exit_code: number | null; status: string; duration_ms: number }
      | undefined;

    if (lastRun) {
      recentExecution = {
        exitCode: lastRun.exit_code,
        stdout: "",
        stderr:
          lastRun.status === "failed"
            ? `Execution status: ${lastRun.status}`
            : "",
      };
    }
  } catch {}

  // 3. Relevant Workspace Search Results (if query provided)
  // Search results are supplementary context, not required for the AI
  // action to proceed — mirrors the swallow-on-error behavior above rather
  // than failing the whole action. Gated by the same searchGate used by
  // /api/projects/:id/search: this still spawns a real worker thread (see
  // search.ts), so it must count against the same per-user concurrency
  // budget, otherwise a burst of AI actions with searchQuery would be an
  // unbounded worker-thread-spawn path outside that budget's coverage.
  let searchResults: AIContextBundle["searchResults"] = undefined;
  if (opts.searchQuery && opts.searchQuery.trim().length > 2) {
    if (searchGate.acquire(userId, cfg.maxConcurrentRuns)) {
      try {
        const searchRes = await searchProjectContent(baseDir, {
          query: opts.searchQuery.trim(),
          maxResults: 5,
        });
        const allMatches = searchRes.groups.flatMap((g) => g.matches);
        searchResults = allMatches.slice(0, 5).map((m) => ({
          file: m.filePath,
          line: m.lineNumber,
          content: m.lineContent.trim(),
        }));
      } catch {
      } finally {
        searchGate.release(userId);
      }
    }
  }

  // 4. Token Budget & Bounded Truncation
  if (fileContent.length > maxChars) {
    if (opts.selectionRange) {
      const lines = fileContent.split("\n");
      const start = Math.max(0, opts.selectionRange.startLine - 20);
      const end = Math.min(lines.length, opts.selectionRange.endLine + 20);
      fileContent =
        `// [Truncated context: lines ${start + 1} - ${end}]\n` +
        lines.slice(start, end).join("\n");
    } else {
      fileContent =
        fileContent.slice(0, maxChars) +
        "\n// [Truncated: reached context character limit]";
    }
  }

  return {
    projectId,
    activeFilePath: opts.activeFilePath,
    fileContent,
    language,
    selectedCode: opts.selectedCode,
    selectionRange: opts.selectionRange,
    diagnostics: opts.diagnostics,
    recentExecution,
    searchResults,
  };
}
