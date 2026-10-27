/**
 * M110: apply an LSP incremental `TextDocumentContentChangeEvent` to a string.
 * Positions are UTF-16 code units (the LSP default), lines split on "\n"
 * (editor models are LF-pinned). Returns null for any out-of-range edit so the
 * caller can ask the client to resync instead of guessing.
 */
export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRangeChange {
  range: { start: LspPosition; end: LspPosition };
  text: string;
}

function offsetOf(text: string, pos: LspPosition): number | null {
  if (!Number.isInteger(pos.line) || !Number.isInteger(pos.character)) return null;
  if (pos.line < 0 || pos.character < 0) return null;
  let off = 0;
  for (let l = 0; l < pos.line; l++) {
    const nl = text.indexOf("\n", off);
    if (nl === -1) return null;
    off = nl + 1;
  }
  const nl = text.indexOf("\n", off);
  const lineEnd = nl === -1 ? text.length : nl;
  if (off + pos.character > lineEnd) return null;
  return off + pos.character;
}

export function applyChange(text: string, change: LspRangeChange): string | null {
  const start = offsetOf(text, change.range.start);
  const end = offsetOf(text, change.range.end);
  if (start === null || end === null || end < start) return null;
  return text.slice(0, start) + change.text + text.slice(end);
}

export function isRangeChange(v: unknown): v is LspRangeChange {
  if (!v || typeof v !== "object") return false;
  const c = v as { range?: { start?: unknown; end?: unknown }; text?: unknown };
  const p = (x: unknown) =>
    !!x && typeof x === "object" && typeof (x as LspPosition).line === "number" && typeof (x as LspPosition).character === "number";
  return typeof c.text === "string" && !!c.range && p(c.range.start) && p(c.range.end);
}
