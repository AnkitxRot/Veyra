import { useEffect, useRef } from "react";
import type * as MonacoNS from "monaco-editor";
import type * as Y from "yjs";
import type { CommentThreadDTO } from "../../types";
import { resolveAnchor, type AnchorState } from "../../comments/anchor";
import { reportAnchorStatus } from "../../comments/api";

/**
 * M61-A: gutter markers + clickable chips + range tint for a file's comment
 * threads. Reuses the M58 decoration-collection + content-widget pattern.
 * NEVER mutates the Monaco model. Marker/chip text is set via `textContent`.
 *
 * - exact / drifted → decorate the resolved range, show a `💬` chip.
 * - stale           → NOT decorated (panel-only; never rendered on unrelated
 *                     code) and reported back to the server as advisory.
 */
export interface CommentGutterProps {
  editor: MonacoNS.editor.IStandaloneCodeEditor;
  monaco: typeof MonacoNS;
  projectId: string;
  activeFile: string;
  doc: Y.Doc | null;
  threads: CommentThreadDTO[];
  onOpenThread: (threadId: string) => void;
}

function firstLine(body: string): string {
  return body.split("\n")[0]?.slice(0, 120) ?? "";
}

export default function CommentGutter({
  editor,
  monaco,
  projectId,
  activeFile,
  doc,
  threads,
  onOpenThread,
}: CommentGutterProps) {
  const decoRef = useRef<MonacoNS.editor.IEditorDecorationsCollection | null>(
    null,
  );
  const widgetsRef = useRef<Map<string, MonacoNS.editor.IContentWidget>>(
    new Map(),
  );
  const reportedRef = useRef<Map<string, AnchorState>>(new Map());

  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    if (!decoRef.current && editor.createDecorationsCollection) {
      decoRef.current = editor.createDecorationsCollection();
    }

    (async () => {
      const decos: MonacoNS.editor.IModelDeltaDecoration[] = [];
      const keep = new Set<string>();
      const fileThreads = threads.filter(
        (t) => t.filePath === activeFile && t.resolvedAt == null,
      );

      for (const thread of fileThreads) {
        const resolved = doc
          ? await resolveAnchor(doc, activeFile, {
              relStart: thread.anchor.relStart ?? "",
              relEnd: thread.anchor.relEnd ?? "",
              slice: thread.anchor.slice,
              startLine: thread.anchor.startLine,
              endLine: thread.anchor.endLine,
              prefixHash: thread.anchor.prefixHash,
            })
          : { state: "stale" as const, range: null, recovery: null };
        if (cancelled) return;

        // Advisory report — never load-bearing; fire and forget, once per state.
        if (reportedRef.current.get(thread.id) !== resolved.state) {
          reportedRef.current.set(thread.id, resolved.state);
          const advisory = resolved.state === "stale" ? "stale" : "ok";
          if (advisory !== thread.anchorStatus) {
            void reportAnchorStatus(projectId, thread.id, advisory).catch(
              () => {},
            );
          }
        }

        if (resolved.state === "stale" || !resolved.range) continue;
        const r = resolved.range;
        const replyCount = thread.replies.filter(
          (c) => c.deletedAt == null,
        ).length;

        decos.push({
          range: new monaco.Range(
            r.startLineNumber,
            1,
            r.endLineNumber,
            1,
          ),
          options: {
            glyphMarginClassName: "comment-glyph",
            className: "comment-range",
            isWholeLine: false,
          },
        });

        keep.add(thread.id);
        if (!widgetsRef.current.has(thread.id) && editor.addContentWidget) {
          const dom = document.createElement("button");
          dom.type = "button";
          dom.className = "comment-chip";
          dom.textContent = replyCount > 0 ? `💬 ${replyCount}` : "💬";
          dom.title =
            firstLine(thread.root.body || "(comment)") +
            (replyCount > 0 ? ` · ${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : "");
          dom.setAttribute("data-thread-id", thread.id);
          dom.onclick = (e) => {
            e.stopPropagation();
            onOpenThread(thread.id);
          };
          const widget: MonacoNS.editor.IContentWidget = {
            getId: () => `comment-chip-${thread.id}`,
            getDomNode: () => dom,
            getPosition: () => ({
              position: {
                lineNumber: r.startLineNumber,
                column: r.startColumn,
              },
              preference: [1, 2] as unknown as MonacoNS.editor.ContentWidgetPositionPreference[],
            }),
          };
          widgetsRef.current.set(thread.id, widget);
          editor.addContentWidget(widget);
        }
      }

      if (cancelled) return;
      decoRef.current?.set(decos);
      for (const [id, w] of widgetsRef.current) {
        if (!keep.has(id)) {
          editor.removeContentWidget?.(w);
          widgetsRef.current.delete(id);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [editor, monaco, projectId, activeFile, doc, threads, onOpenThread]);

  // Full teardown on unmount.
  useEffect(() => {
    const widgets = widgetsRef.current;
    const deco = decoRef;
    return () => {
      for (const w of widgets.values()) {
        try {
          editor?.removeContentWidget?.(w);
        } catch {
          /* editor already disposed */
        }
      }
      widgets.clear();
      try {
        deco.current?.clear();
      } catch {
        /* editor already disposed */
      }
      deco.current = null;
    };
  }, [editor]);

  return null;
}
