/**
 * Canonical document text for language servers.
 *
 * Yjs/shared document state is the source of truth when a collaboration
 * room already holds the file. Clients still send didOpen/didChange so
 * solo editors (no room yet) work, but the session never lets a stale
 * socket overwrite a Yjs-backed buffer. LSP process state is never stored
 * in Yjs.
 */

import { collaborationManager } from "../collab/manager.js";

export interface LspDocumentSource {
  /** Current canonical text, or null when this source has no opinion. */
  read(relPath: string): string | null;
  /**
   * Observe live Yjs updates for an already-open LSP document. Returns a
   * no-op unsubscriber when the file is not in the room.
   */
  subscribe(relPath: string, onChange: (text: string) => void): () => void;
}

interface YTextLike {
  toString(): string;
  observe(fn: () => void): void;
  unobserve(fn: () => void): void;
}

export interface YDocLike {
  share: { has(key: string): boolean };
  getText(key: string): YTextLike;
}

function roomFor(projectId: string): { doc: YDocLike } | undefined {
  try {
    return collaborationManager.getRoom(projectId);
  } catch {
    return undefined;
  }
}

/**
 * Yjs-backed source that never materializes empty `Y.Text` keys. If the
 * room or share entry appears after subscribe(), a bounded poll attaches
 * the observer then — collab often connects a moment after `/ws/lsp`.
 */
export function yjsDocumentSource(
  getDoc: () => YDocLike | undefined,
): LspDocumentSource {
  return {
    read(relPath: string): string | null {
      const doc = getDoc();
      if (!doc || !doc.share.has(relPath)) return null;
      return doc.getText(relPath).toString();
    },
    subscribe(
      relPath: string,
      onChange: (text: string) => void,
    ): () => void {
      let stopped = false;
      let unobserve: (() => void) | null = null;
      let timer: ReturnType<typeof setInterval> | null = null;

      const attach = (): boolean => {
        if (stopped || unobserve) return true;
        const doc = getDoc();
        if (!doc || !doc.share.has(relPath)) return false;
        const yText = doc.getText(relPath);
        const handler = () => {
          onChange(yText.toString());
        };
        yText.observe(handler);
        unobserve = () => {
          try {
            yText.unobserve(handler);
          } catch {}
        };
        onChange(yText.toString());
        return true;
      };

      if (!attach()) {
        timer = setInterval(() => {
          if (attach() && timer) {
            clearInterval(timer);
            timer = null;
          }
        }, 50);
        timer.unref?.();
      }

      return () => {
        stopped = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        unobserve?.();
      };
    },
  };
}

/**
 * Lazy collab-backed source. Safe to construct before a room exists; reads
 * return null until `doc.share` actually holds the path (never materializes
 * empty Y.Text keys).
 */
export function collabDocumentSource(projectId: string): LspDocumentSource {
  return yjsDocumentSource(() => roomFor(projectId)?.doc);
}

export function resolveCanonicalText(
  source: LspDocumentSource | null | undefined,
  relPath: string,
  clientText: string,
): string {
  const fromSource = source?.read(relPath);
  return fromSource !== null && fromSource !== undefined
    ? fromSource
    : clientText;
}
