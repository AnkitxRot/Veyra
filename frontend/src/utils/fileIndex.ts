import { TreeNode } from '../types';
import { scoreFuzzyMatch } from './fuzzySearch';

export interface IndexedFile {
  path: string;
  filename: string;
  extension: string;
  directory: string;
}

/**
 * Traverses a TreeNode directory hierarchy and flattens it into an indexed file list.
 */
export function buildFileIndex(tree: TreeNode[]): IndexedFile[] {
  const index: IndexedFile[] = [];

  function traverse(nodes: TreeNode[], parentPath = '') {
    for (const node of nodes) {
      const currentPath = node.path || (parentPath ? `${parentPath}/${node.name}` : node.name);
      if (node.type === 'dir' && node.children) {
        traverse(node.children, currentPath);
      } else if (node.type === 'file') {
        const parts = currentPath.split('/');
        const filename = parts.pop() || currentPath;
        const directory = parts.join('/');
        const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() || '' : '';

        index.push({
          path: currentPath,
          filename,
          extension: ext,
          directory,
        });
      }
    }
  }

  traverse(tree);
  return index;
}

/**
 * Searches the file index with hierarchical priority ranking:
 * 1. Exact filename match
 * 2. Filename prefix match
 * 3. Filename substring match
 * 4. Full path substring match
 * 5. Subsequence fuzzy match
 */
export function searchFileIndex(
  index: IndexedFile[],
  query: string,
  recentPaths: string[] = []
): IndexedFile[] {
  if (!query || !query.trim()) {
    // When query is empty, return recent files first, then the rest
    if (recentPaths.length === 0) return index;
    const recentSet = new Set(recentPaths);
    const recents: IndexedFile[] = [];
    const others: IndexedFile[] = [];

    // Map in order of recents
    for (const p of recentPaths) {
      const found = index.find((f) => f.path === p);
      if (found) recents.push(found);
    }
    for (const f of index) {
      if (!recentSet.has(f.path)) others.push(f);
    }
    return [...recents, ...others];
  }

  const cleanQuery = query.trim().toLowerCase();
  const scoredItems: Array<{ file: IndexedFile; score: number }> = [];

  for (const file of index) {
    const filenameLower = file.filename.toLowerCase();
    const pathLower = file.path.toLowerCase();

    let score = 0;

    // 1. Exact filename match (highest)
    if (filenameLower === cleanQuery) {
      score = 3000;
    }
    // 2. Filename prefix match
    else if (filenameLower.startsWith(cleanQuery)) {
      score = 2000 + (cleanQuery.length / file.filename.length) * 200;
    }
    // 3. Filename substring match
    else if (filenameLower.includes(cleanQuery)) {
      score = 1500 + (cleanQuery.length / file.filename.length) * 100 - filenameLower.indexOf(cleanQuery);
    }
    // 4. Path substring match
    else if (pathLower.includes(cleanQuery)) {
      score = 1000 - pathLower.indexOf(cleanQuery);
    }
    // 5. Fuzzy match on filename or path
    else {
      const filenameFuzzy = scoreFuzzyMatch(file.filename, cleanQuery);
      const pathFuzzy = scoreFuzzyMatch(file.path, cleanQuery);
      score = Math.max(filenameFuzzy.score * 1.5, pathFuzzy.score);
    }

    // Boost if file was recently opened
    if (recentPaths.includes(file.path) && score > 0) {
      const recencyRank = recentPaths.indexOf(file.path);
      score += Math.max(0, 150 - recencyRank * 15);
    }

    if (score > 0) {
      scoredItems.push({ file, score });
    }
  }

  scoredItems.sort((a, b) => b.score - a.score);
  return scoredItems.map((item) => item.file);
}
