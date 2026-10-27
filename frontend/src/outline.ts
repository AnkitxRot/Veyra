/** M104: pure helpers over document symbols (outline view + symbol breadcrumbs). */
export interface OutlineSymbol {
  name: string;
  kind: number;
  range: { startLine: number; endLine: number };
  children: OutlineSymbol[];
}

export interface OutlineRow {
  symbol: OutlineSymbol;
  depth: number;
}

export function flattenSymbols(symbols: OutlineSymbol[], depth = 0): OutlineRow[] {
  const rows: OutlineRow[] = [];
  for (const s of [...symbols].sort((a, b) => a.range.startLine - b.range.startLine)) {
    rows.push({ symbol: s, depth });
    rows.push(...flattenSymbols(s.children, depth + 1));
  }
  return rows;
}

/** Names from the outermost symbol down to the innermost one containing `line`. */
export function symbolPathAt(symbols: OutlineSymbol[], line: number): string[] {
  const hit = symbols.find((s) => s.range.startLine <= line && line <= s.range.endLine);
  return hit ? [hit.name, ...symbolPathAt(hit.children, line)] : [];
}
