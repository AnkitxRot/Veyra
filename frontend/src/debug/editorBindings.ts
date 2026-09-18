import { useEffect, useRef } from "react";
import { monaco } from "../monacoSetup";
import {
  DEBUG_BREAKPOINTS_EVENT,
  DEBUG_EXECUTION_EVENT,
  DEBUG_TOGGLE_BP_EVENT,
} from "./types";
import type { DebugBreakpoint } from "./types";

const MouseTargetType = (monaco.editor as { MouseTargetType?: { GUTTER_GLYPH_MARGIN: number } })
  .MouseTargetType ?? { GUTTER_GLYPH_MARGIN: 2 };

const REPAINT_EVENT = "ide-debug-repaint";

/**
 * Glyph-margin breakpoints + current-line highlight. Breakpoint *state* lives
 * in DebugSessionProvider (local, not Yjs). This only paints Monaco.
 */
export function bindDebugEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
  getActiveFile: () => string | null,
): () => void {
  const bpCol = editor.createDecorationsCollection();
  const execCol = editor.createDecorationsCollection();
  const lastBps = new Map<string, DebugBreakpoint[]>();
  let execPath: string | null = null;
  let execLine: number | null = null;

  const paintActive = () => {
    const active = getActiveFile();
    const bps = active ? (lastBps.get(active) ?? []) : [];
    bpCol.set(
      bps.map((bp) => ({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: bp.verified
            ? "debug-breakpoint-glyph verified"
            : "debug-breakpoint-glyph",
          glyphMarginHoverMessage: {
            value: bp.verified ? "Breakpoint" : "Unverified breakpoint",
          },
        },
      })),
    );
    if (!active || !execPath || !execLine || active !== execPath) {
      execCol.clear();
      return;
    }
    execCol.set([
      {
        range: new monaco.Range(execLine, 1, execLine, 1),
        options: {
          isWholeLine: true,
          className: "debug-current-line",
          glyphMarginClassName: "debug-current-line-glyph",
        },
      },
    ]);
  };

  const onBp = (e: Event) => {
    const d = (e as CustomEvent).detail as {
      path?: string;
      breakpoints?: DebugBreakpoint[];
    };
    if (!d?.path || !Array.isArray(d.breakpoints)) return;
    lastBps.set(d.path, d.breakpoints);
    paintActive();
  };
  const onExec = (e: Event) => {
    const d = (e as CustomEvent).detail as {
      path?: string | null;
      line?: number | null;
    };
    execPath = d?.path ?? null;
    execLine = d?.line ?? null;
    paintActive();
  };
  const onRepaint = () => paintActive();

  document.addEventListener(DEBUG_BREAKPOINTS_EVENT, onBp);
  document.addEventListener(DEBUG_EXECUTION_EVENT, onExec);
  document.addEventListener(REPAINT_EVENT, onRepaint);

  const mouse = editor.onMouseDown((ev) => {
    const t = ev.target;
    if (!t || t.type !== MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = t.position?.lineNumber;
    const path = getActiveFile();
    if (!line || !path) return;
    document.dispatchEvent(
      new CustomEvent(DEBUG_TOGGLE_BP_EVENT, { detail: { path, line } }),
    );
  });

  return () => {
    mouse.dispose();
    document.removeEventListener(DEBUG_BREAKPOINTS_EVENT, onBp);
    document.removeEventListener(DEBUG_EXECUTION_EVENT, onExec);
    document.removeEventListener(REPAINT_EVENT, onRepaint);
    bpCol.clear();
    execCol.clear();
  };
}

export function useDebugEditorBindings(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  activeFile: string | null,
): void {
  const fileRef = useRef(activeFile);
  fileRef.current = activeFile;
  useEffect(() => {
    if (!editor) return;
    return bindDebugEditor(editor, () => fileRef.current);
  }, [editor]);
  useEffect(() => {
    document.dispatchEvent(new Event(REPAINT_EVENT));
  }, [activeFile]);
}
