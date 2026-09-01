import * as Y from "yjs";
import { encodeAnchor, positionToOffset } from "./anchor";
import * as commentsApi from "./api";
import type { AttentionEvent } from "../collab/attention";

/**
 * M61-A: Keep as comment — promote an ephemeral M58 callout to a persistent
 * M61 thread via the existing comment creation path. The original callout
 * keeps its ephemeral lifecycle and is never mutated into persistent state.
 * Deduplication is per-callout-id in memory (no duplicate persistence for a
 * single Keep click, even under rapid double-click).
 */
export class KeepDeduper {
  private readonly kept = new Set<string>();
  has(id: string): boolean {
    return this.kept.has(id);
  }
  /**
   * Try to claim `id` for a Keep operation. Returns true if this caller won
   * the claim (should proceed), false if it was already claimed (should no-op).
   */
  claim(id: string): boolean {
    if (this.kept.has(id)) return false;
    this.kept.add(id);
    return true;
  }
  release(id: string): void {
    this.kept.delete(id);
  }
  clear(): void {
    this.kept.clear();
  }
}

export interface KeepInput {
  callout: AttentionEvent;
  doc: Y.Doc;
  projectId: string;
}

/**
 * Compute a fresh anchor from the callout's file/range against the live doc,
 * then create a persistent thread via the canonical REST path.
 * Returns the created thread (or null if deduped/invalid).
 */
export async function keepCalloutAsComment(
  input: KeepInput,
  deduper: KeepDeduper,
): Promise<{ thread: import("../types").CommentThreadDTO } | null> {
  const { callout, doc, projectId } = input;
  if (callout.kind !== "callout" || !callout.message) return null;
  if (!deduper.claim(callout.id)) return null;
  try {
    const yText = doc.getText(callout.file);
    const text = yText.toString();
    let s = positionToOffset(text, callout.range.startLine, callout.range.startColumn);
    let e = positionToOffset(text, callout.range.endLine, callout.range.endColumn);
    if (s === e) {
      const lineStart = positionToOffset(text, callout.range.startLine, 1);
      const nl = text.indexOf("\n", lineStart);
      s = lineStart;
      e = nl === -1 ? text.length : nl;
    }
    s = Math.max(0, Math.min(s, text.length));
    e = Math.max(0, Math.min(e, text.length));
    if (s > e) [s, e] = [e, s];
    const anchor = await encodeAnchor(yText, s, e);
    const body = callout.message.trim();
    if (!body) {
      deduper.release(callout.id);
      return null;
    }
    const res = await commentsApi.createThread(projectId, {
      filePath: callout.file,
      anchor,
      body,
      mentions: [],
    });
    return res;
  } catch {
    deduper.release(callout.id);
    return null;
  }
}
