import type { IRange } from "monaco-editor";

export interface LspTextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

export interface MonacoTextEdit {
  range: IRange;
  text: string;
}

export function toMonacoEdits(edits: unknown): MonacoTextEdit[] {
  if (!Array.isArray(edits)) return [];
  const out: MonacoTextEdit[] = [];
  for (const e of edits as Partial<LspTextEdit>[]) {
    if (!e?.range?.start || !e.range.end || typeof e.newText !== "string") continue;
    out.push({
      range: {
        startLineNumber: e.range.start.line + 1,
        startColumn: e.range.start.character + 1,
        endLineNumber: e.range.end.line + 1,
        endColumn: e.range.end.character + 1,
      },
      text: e.newText,
    });
  }
  return out;
}

/** Split `{changes: {uri: edits}}` into entries for open files and the paths we cannot edit. */
export function splitChanges(
  changes: unknown,
  toPath: (uri: string) => string | null,
  isOpen: (path: string) => boolean,
): { open: { path: string; edits: MonacoTextEdit[] }[]; skipped: string[] } {
  const open: { path: string; edits: MonacoTextEdit[] }[] = [];
  const skipped: string[] = [];
  if (!changes || typeof changes !== "object") return { open, skipped };
  for (const [uri, edits] of Object.entries(changes as Record<string, unknown>)) {
    const path = toPath(uri);
    if (!path) continue;
    const mapped = toMonacoEdits(edits);
    if (!mapped.length) continue;
    if (isOpen(path)) open.push({ path, edits: mapped });
    else skipped.push(path);
  }
  return { open, skipped };
}
