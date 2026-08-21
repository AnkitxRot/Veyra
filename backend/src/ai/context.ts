import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import { projectDir } from '../projects/service.js';
import { searchProjectContent } from '../projects/search.js';
import type { AIContextBundle } from './provider.js';

export interface BuildContextOptions {
  activeFilePath: string;
  selectedCode?: string;
  selectionRange?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  diagnostics?: Array<{ message: string; line: number; column?: number; source: string; severity: string; code?: string }>;
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
  opts: BuildContextOptions
): Promise<AIContextBundle> {
  const maxChars = opts.maxChars || 16000;
  const baseDir = projectDir(cfg, projectId);
  const fullPath = join(baseDir, opts.activeFilePath);

  // 1. Read Active File Content
  let fileContent = '';
  try {
    fileContent = await fs.readFile(fullPath, 'utf-8');
  } catch {
    fileContent = '';
  }

  // Detect language from extension
  const ext = opts.activeFilePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    py: 'python',
    c: 'c',
    cpp: 'cpp',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    java: 'java',
    json: 'json',
    md: 'markdown',
  };
  const language = langMap[ext] || 'plaintext';

  // 2. Fetch Recent Execution History
  let recentExecution: AIContextBundle['recentExecution'] = undefined;
  try {
    const lastRun = db
      .prepare(
        `SELECT exit_code, status, duration_ms
         FROM runs
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(projectId) as { exit_code: number | null; status: string; duration_ms: number } | undefined;

    if (lastRun) {
      recentExecution = {
        exitCode: lastRun.exit_code,
        stdout: '',
        stderr: lastRun.status === 'failed' ? `Execution status: ${lastRun.status}` : '',
      };
    }
  } catch {}

  // 3. Relevant Workspace Search Results (if query provided)
  let searchResults: AIContextBundle['searchResults'] = undefined;
  if (opts.searchQuery && opts.searchQuery.trim().length > 2) {
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
    } catch {}
  }

  // 4. Token Budget & Bounded Truncation
  if (fileContent.length > maxChars) {
    if (opts.selectionRange) {
      const lines = fileContent.split('\n');
      const start = Math.max(0, opts.selectionRange.startLine - 20);
      const end = Math.min(lines.length, opts.selectionRange.endLine + 20);
      fileContent = `// [Truncated context: lines ${start + 1} - ${end}]\n` + lines.slice(start, end).join('\n');
    } else {
      fileContent = fileContent.slice(0, maxChars) + '\n// [Truncated: reached context character limit]';
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
