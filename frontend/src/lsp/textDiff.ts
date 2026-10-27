/**
 * M110: reduce two versions of a document to ONE LSP incremental change
 * (common prefix/suffix trimmed), so didChange no longer ships the whole file.
 * Positions are UTF-16 code units on "\n"-split lines (models are LF-pinned).
 */
export interface RangeChange {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  text: string;
}

function posAt(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let last = -1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    last = i;
  }
  return { line, character: offset - (last + 1) };
}

export function diffToChange(prev: string, next: string): RangeChange | null {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let s = 0;
  while (s < max && prev.charCodeAt(s) === next.charCodeAt(s)) s++;
  let e = 0;
  while (e < max - s && prev.charCodeAt(prev.length - 1 - e) === next.charCodeAt(next.length - 1 - e)) e++;
  // Never split a surrogate pair at either boundary.
  const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  if (s > 0 && isHigh(prev.charCodeAt(s - 1))) s--;
  if (e > 0 && isLow(prev.charCodeAt(prev.length - e))) e--;
  const endPrev = prev.length - e;
  return {
    range: { start: posAt(prev, s), end: posAt(prev, endPrev) },
    text: next.slice(s, next.length - e),
  };
}
