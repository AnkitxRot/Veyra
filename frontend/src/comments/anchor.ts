import * as Y from "yjs";

/**
 * M61-A comment anchoring. A comment is pinned to code with a pair of
 * `Y.RelativePosition` blobs (encoded server-side as opaque base64, resolved
 * ONLY here against the live `Y.Text`), plus an advisory line range and a
 * bounded content fingerprint used for drift detection and fuzzy recovery.
 *
 * The server never decodes or resolves these — it stores them verbatim.
 * A successfully resolved relative position is NOT by itself proof of
 * semantic correctness: the fingerprint decides exact vs drifted, and a
 * failed resolution is stale (never silently relocated to unrelated code).
 */

export const MAX_SLICE = 256;

export interface AnchorPayload {
  relStart: string;
  relEnd: string;
  slice: string;
  startLine: number;
  endLine: number;
  prefixHash: string;
}

export type AnchorState = "exact" | "drifted" | "stale";

export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface ResolvedAnchor {
  state: AnchorState;
  range: MonacoRange | null;
  recovery: { line: number } | null;
}

/** SHA-256, first 16 hex chars, of the whitespace-collapsed ≤256-char text. */
export async function fingerprint(text: string): Promise<string> {
  const norm = text.replace(/\s+/g, " ").trim().slice(0, MAX_SLICE);
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(norm),
  );
  return [...new Uint8Array(buf)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function offsetToPosition(text: string, offset: number) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { lineNumber: line, column: col };
}

export function positionToOffset(text: string, line: number, col: number) {
  let off = 0;
  let l = 1;
  for (let i = 0; i < text.length && l < line; i++) {
    if (text[i] === "\n") {
      l++;
      off = i + 1;
    }
  }
  return off + (col - 1);
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encodeAnchor(
  yText: Y.Text,
  startOffset: number,
  endOffset: number,
): Promise<AnchorPayload> {
  const relS = Y.createRelativePositionFromTypeIndex(yText, startOffset);
  const relE = Y.createRelativePositionFromTypeIndex(yText, endOffset);
  const text = yText.toString();
  const slice = (
    text.slice(startOffset, endOffset) ||
    text.slice(startOffset, startOffset + MAX_SLICE)
  ).slice(0, MAX_SLICE);
  return {
    relStart: b64(Y.encodeRelativePosition(relS)),
    relEnd: b64(Y.encodeRelativePosition(relE)),
    slice,
    startLine: offsetToPosition(text, startOffset).lineNumber,
    endLine: offsetToPosition(text, endOffset).lineNumber,
    prefixHash: await fingerprint(slice),
  };
}

export async function resolveAnchor(
  doc: Y.Doc,
  filePath: string,
  a: AnchorPayload,
): Promise<ResolvedAnchor> {
  const yText = doc.getText(filePath);
  const text = yText.toString();
  let relS: Y.RelativePosition;
  let relE: Y.RelativePosition;
  try {
    relS = Y.decodeRelativePosition(unb64(a.relStart));
    relE = Y.decodeRelativePosition(unb64(a.relEnd));
  } catch {
    return stale(text, a);
  }
  const absS = Y.createAbsolutePositionFromRelativePosition(relS, doc);
  const absE = Y.createAbsolutePositionFromRelativePosition(relE, doc);
  if (!absS || !absE || absS.type !== yText || absE.type !== yText) {
    return stale(text, a);
  }
  const so = Math.min(absS.index, absE.index);
  const eo = Math.max(absS.index, absE.index);
  if (so === eo && a.slice.trim().length > 0) return stale(text, a);
  const p1 = offsetToPosition(text, so);
  const p2 = offsetToPosition(text, eo);
  const range: MonacoRange = {
    startLineNumber: p1.lineNumber,
    startColumn: p1.column,
    endLineNumber: p2.lineNumber,
    endColumn: p2.column,
  };
  const currentHash = await fingerprint(text.slice(so, eo));
  return {
    state: currentHash === a.prefixHash ? "exact" : "drifted",
    range,
    recovery: null,
  };
}

async function stale(text: string, a: AnchorPayload): Promise<ResolvedAnchor> {
  const m = fuzzyMatchSlice(text, a.slice);
  return { state: "stale", range: null, recovery: m ? { line: m.line } : null };
}

/**
 * Token-Jaccard similarity of the stored slice against every 3-line window of
 * the current doc. Returns the best window's 1-based start line iff its score
 * clears the approved 0.8 threshold — a weak match returns null so the UI
 * never auto-jumps.
 */
export function fuzzyMatchSlice(
  docText: string,
  slice: string,
): { line: number; score: number } | null {
  const want = new Set(slice.toLowerCase().split(/\W+/).filter(Boolean));
  if (want.size === 0) return null;
  const lines = docText.split("\n");
  let best: { line: number; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const have = new Set(
      lines
        .slice(i, i + 3)
        .join(" ")
        .toLowerCase()
        .split(/\W+/)
        .filter(Boolean),
    );
    let inter = 0;
    for (const w of want) if (have.has(w)) inter++;
    const score = inter / (want.size + have.size - inter || 1);
    if (!best || score > best.score) best = { line: i + 1, score };
  }
  return best && best.score >= 0.8 ? best : null;
}
