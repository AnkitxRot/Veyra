/**
 * High-performance deterministic fuzzy scoring and matching algorithm.
 * Optimized for real-time sub-millisecond filtering across thousands of files and commands.
 */

export interface FuzzyMatchResult<T> {
  item: T;
  score: number;
  matchedIndices?: number[];
}

/**
 * Computes a relevance score between a target string and search query.
 * Higher score indicates better match. Returns 0 if no match.
 */
export function scoreFuzzyMatch(target: string, query: string): { score: number; indices: number[] } {
  if (!query) return { score: 1, indices: [] };
  if (!target) return { score: 0, indices: [] };

  const targetLower = target.toLowerCase();
  const queryLower = query.toLowerCase();

  // 1. Exact Match
  if (targetLower === queryLower) {
    return { score: 2000, indices: Array.from({ length: target.length }, (_, i) => i) };
  }

  // 2. Exact Prefix Match
  if (targetLower.startsWith(queryLower)) {
    const score = 1200 + (query.length / target.length) * 100;
    return { score, indices: Array.from({ length: query.length }, (_, i) => i) };
  }

  // 3. Exact Substring Match
  const subIdx = targetLower.indexOf(queryLower);
  if (subIdx !== -1) {
    const isWordBoundary = subIdx === 0 || /[\s/._-]/.test(target[subIdx - 1]);
    const score = (isWordBoundary ? 900 : 700) + (query.length / target.length) * 100 - subIdx;
    return {
      score,
      indices: Array.from({ length: query.length }, (_, i) => subIdx + i),
    };
  }

  // 4. Subsequence Matching with Word Boundary & Consecutive Bonuses
  let targetIdx = 0;
  let queryIdx = 0;
  let score = 0;
  const indices: number[] = [];
  let consecutiveCount = 0;

  while (targetIdx < target.length && queryIdx < query.length) {
    const tChar = targetLower[targetIdx];
    const qChar = queryLower[queryIdx];

    if (tChar === qChar) {
      indices.push(targetIdx);
      let matchScore = 10;

      // Bonus: Consecutive matches
      if (consecutiveCount > 0) {
        matchScore += consecutiveCount * 15;
      }
      consecutiveCount++;

      // Bonus: Word boundary match (after space, slash, dot, underscore, dash, or camelCase)
      if (
        targetIdx === 0 ||
        /[\s/._-]/.test(target[targetIdx - 1]) ||
        (target[targetIdx] === target[targetIdx].toUpperCase() &&
          target[targetIdx - 1] === target[targetIdx - 1].toLowerCase())
      ) {
        matchScore += 40;
      }

      // Bonus: Exact case match
      if (target[targetIdx] === query[queryIdx]) {
        matchScore += 5;
      }

      score += matchScore;
      queryIdx++;
    } else {
      consecutiveCount = 0;
    }
    targetIdx++;
  }

  // If query was not fully matched as a subsequence, return 0
  if (queryIdx < query.length) {
    return { score: 0, indices: [] };
  }

  // Normalize by length penalty so shorter matching strings rank higher
  const lengthPenalty = Math.max(0, target.length - query.length) * 0.5;
  score = Math.max(1, score - lengthPenalty);

  return { score, indices };
}

/**
 * Filters and ranks items based on fuzzy search query over an extracted target string.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getString: (item: T) => string
): FuzzyMatchResult<T>[] {
  if (!query || !query.trim()) {
    return items.map((item) => ({ item, score: 1, matchedIndices: [] }));
  }

  const cleanQuery = query.trim();
  const results: FuzzyMatchResult<T>[] = [];

  for (const item of items) {
    const targetStr = getString(item);
    const { score, indices } = scoreFuzzyMatch(targetStr, cleanQuery);
    if (score > 0) {
      results.push({ item, score, matchedIndices: indices });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
