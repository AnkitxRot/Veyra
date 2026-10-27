/**
 * M110: shape language-server edits before they reach the browser.
 *
 * A server may return resource operations (create/rename/delete), edits to
 * files outside the workspace, `command`s (we never run `workspace/executeCommand`),
 * or absurdly large edit sets. The browser only ever receives plain text edits
 * keyed by workspace URI, bounded in count and size.
 */
import { fromWorkspaceUri } from "./uri.js";

export interface SafeTextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}
export interface SafeWorkspaceEdit {
  changes: Record<string, SafeTextEdit[]>;
}

const MAX_FILES = 50;
const MAX_EDITS = 5000;
const MAX_NEWTEXT_TOTAL = 2 * 1024 * 1024;
const MAX_ACTIONS = 50;

const isPos = (p: unknown): boolean =>
  !!p &&
  typeof p === "object" &&
  Number.isInteger((p as { line?: unknown }).line) &&
  Number.isInteger((p as { character?: unknown }).character) &&
  (p as { line: number }).line >= 0 &&
  (p as { character: number }).character >= 0;

function asTextEdit(e: unknown): SafeTextEdit | null {
  if (!e || typeof e !== "object") return null;
  const { range, newText } = e as { range?: { start?: unknown; end?: unknown }; newText?: unknown };
  if (typeof newText !== "string" || !range || typeof range !== "object") return null;
  if (!isPos(range.start) || !isPos(range.end)) return null;
  return { range: range as SafeTextEdit["range"], newText };
}

export function sanitizeWorkspaceEdit(raw: unknown): SafeWorkspaceEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as { changes?: unknown; documentChanges?: unknown };
  const out: Record<string, SafeTextEdit[]> = {};
  let edits = 0;
  let chars = 0;
  let ok = true;
  const add = (uri: unknown, list: unknown) => {
    if (typeof uri !== "string" || !Array.isArray(list)) return;
    if (fromWorkspaceUri(uri) === null) return;
    for (const e of list) {
      const t = asTextEdit(e);
      if (!t) continue;
      edits++;
      chars += t.newText.length;
      if (edits > MAX_EDITS || chars > MAX_NEWTEXT_TOTAL) {
        ok = false;
        return;
      }
      (out[uri] ??= []).push(t);
    }
  };
  if (src.changes && typeof src.changes === "object" && !Array.isArray(src.changes)) {
    for (const [uri, list] of Object.entries(src.changes as Record<string, unknown>)) add(uri, list);
  }
  if (Array.isArray(src.documentChanges)) {
    for (const dc of src.documentChanges) {
      if (!dc || typeof dc !== "object") continue;
      if ("kind" in dc) continue; // create / rename / delete: never forwarded
      const d = dc as { textDocument?: { uri?: unknown }; edits?: unknown };
      add(d.textDocument?.uri, d.edits);
    }
  }
  if (!ok || Object.keys(out).length > MAX_FILES) return null;
  return { changes: out };
}

/** Result of textDocument/formatting & rangeFormatting. */
export function sanitizeTextEdits(raw: unknown): SafeTextEdit[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SafeTextEdit[] = [];
  let chars = 0;
  for (const e of raw) {
    const t = asTextEdit(e);
    if (!t) continue;
    chars += t.newText.length;
    if (out.length >= MAX_EDITS || chars > MAX_NEWTEXT_TOTAL) return null;
    out.push(t);
  }
  return out;
}

export function sanitizeCodeActions(raw: unknown): { title: string; kind?: string; isPreferred?: boolean; edit: SafeWorkspaceEdit }[] {
  if (!Array.isArray(raw)) return [];
  const out: { title: string; kind?: string; isPreferred?: boolean; edit: SafeWorkspaceEdit }[] = [];
  for (const a of raw) {
    if (out.length >= MAX_ACTIONS) break;
    if (!a || typeof a !== "object") continue;
    const { title, kind, isPreferred, edit } = a as Record<string, unknown>;
    if (typeof title !== "string" || !edit) continue;
    const safe = sanitizeWorkspaceEdit(edit);
    if (!safe || Object.keys(safe.changes).length === 0) continue;
    out.push({
      title: title.slice(0, 200),
      ...(typeof kind === "string" ? { kind: kind.slice(0, 80) } : {}),
      ...(isPreferred === true ? { isPreferred: true } : {}),
      edit: safe,
    });
  }
  return out;
}
