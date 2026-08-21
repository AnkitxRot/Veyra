import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ApiError } from '../errors.js';

export interface SearchOptions {
  query: string;
  isCaseSensitive?: boolean;
  isWholeWord?: boolean;
  isRegex?: boolean;
  includePattern?: string;
  excludePattern?: string;
  maxResults?: number;
}

export interface SearchMatch {
  filePath: string;
  lineNumber: number;
  column: number;
  lineContent: string;
  matchLength: number;
}

export interface SearchFileGroup {
  filePath: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  groups: SearchFileGroup[];
  totalMatches: number;
  filesSearched: number;
  durationMs: number;
  truncated: boolean;
}

const DEFAULT_MAX_RESULTS = 500;

// Common ignore directories
const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.venv',
  '__pycache__',
  '.cache',
]);

// Binary file extensions to skip
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'webp', 'pdf', 'zip', 'tar', 'gz', '7z',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'pyc', 'class', 'db', 'sqlite', 'ttf', 'woff', 'woff2'
]);

function isBinaryString(str: string): boolean {
  const len = Math.min(str.length, 512);
  for (let i = 0; i < len; i++) {
    if (str.charCodeAt(i) === 0) return true;
  }
  return false;
}

/**
 * Executes an ultra-fast, Dirent-optimized text search across all files in a workspace.
 */
export async function searchProjectContent(
  workspaceDir: string,
  options: SearchOptions
): Promise<SearchResponse> {
  const startTime = performance.now();
  const {
    query,
    isCaseSensitive = false,
    isWholeWord = false,
    isRegex = false,
    includePattern,
    excludePattern,
    maxResults = DEFAULT_MAX_RESULTS,
  } = options;

  if (!query || query.trim().length === 0) {
    return {
      groups: [],
      totalMatches: 0,
      filesSearched: 0,
      durationMs: 0,
      truncated: false,
    };
  }

  // Build regex matcher safely with ReDoS protections
  let regex: RegExp;
  try {
    let pattern = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (isWholeWord) {
      pattern = `\\b${pattern}\\b`;
    }
    const flags = isCaseSensitive ? 'g' : 'gi';
    regex = new RegExp(pattern, flags);
  } catch (err: any) {
    throw new ApiError(400, `Invalid search pattern: ${err.message}`, 'invalid_regex');
  }

  // Include / Exclude globs matcher
  let includeRegex: RegExp | null = null;
  if (includePattern && includePattern.trim()) {
    const raw = includePattern.trim().split(',').map((p) => p.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).join('|');
    includeRegex = new RegExp(`^(${raw})$`, 'i');
  }

  let excludeRegex: RegExp | null = null;
  if (excludePattern && excludePattern.trim()) {
    const raw = excludePattern.trim().split(',').map((p) => p.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).join('|');
    excludeRegex = new RegExp(`^(${raw})$`, 'i');
  }

  const groupsMap = new Map<string, SearchMatch[]>();
  let totalMatches = 0;
  let filesSearched = 0;
  let truncated = false;

  function traverseDir(currentDir: string) {
    if (totalMatches >= maxResults) {
      truncated = true;
      return;
    }

    let dirents;
    try {
      dirents = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (let i = 0; i < dirents.length; i++) {
      if (totalMatches >= maxResults) {
        truncated = true;
        return;
      }

      const dirent = dirents[i];
      const name = dirent.name;

      if (IGNORE_DIRS.has(name)) continue;

      if (dirent.isDirectory()) {
        traverseDir(join(currentDir, name));
      } else if (dirent.isFile()) {
        const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : '';
        if (BINARY_EXTENSIONS.has(ext)) continue;

        const fullPath = join(currentDir, name);
        const relPath = relative(workspaceDir, fullPath).replace(/\\/g, '/');

        if (includeRegex && !includeRegex.test(relPath) && !includeRegex.test(name)) continue;
        if (excludeRegex && (excludeRegex.test(relPath) || excludeRegex.test(name))) continue;

        filesSearched++;

        let content: string;
        try {
          content = readFileSync(fullPath, 'utf8');
        } catch {
          continue;
        }

        if (isBinaryString(content)) continue;

        // Quick substring check before splitting into lines if not regex
        if (!isRegex && !isWholeWord) {
          const quickQuery = isCaseSensitive ? query : query.toLowerCase();
          const quickContent = isCaseSensitive ? content : content.toLowerCase();
          if (!quickContent.includes(quickQuery)) continue;
        }

        const lines = content.split('\n');

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          if (totalMatches >= maxResults) {
            truncated = true;
            break;
          }

          const lineContent = lines[lineIdx];
          regex.lastIndex = 0;

          let match: RegExpExecArray | null;
          while ((match = regex.exec(lineContent)) !== null) {
            const column = match.index + 1; // 1-indexed
            const matchLength = match[0].length || 1;

            const matchItem: SearchMatch = {
              filePath: relPath,
              lineNumber: lineIdx + 1,
              column,
              lineContent: lineContent.replace(/\r$/, ''),
              matchLength,
            };

            const existing = groupsMap.get(relPath) || [];
            existing.push(matchItem);
            groupsMap.set(relPath, existing);

            totalMatches++;

            if (totalMatches >= maxResults) {
              truncated = true;
              break;
            }

            if (match.index === regex.lastIndex) {
              regex.lastIndex++;
            }
          }
        }
      }
    }
  }

  traverseDir(workspaceDir);

  const groups: SearchFileGroup[] = Array.from(groupsMap.entries()).map(([filePath, matches]) => ({
    filePath,
    matches,
  }));

  const durationMs = Math.round((performance.now() - startTime) * 100) / 100;

  return {
    groups,
    totalMatches,
    filesSearched,
    durationMs,
    truncated,
  };
}
