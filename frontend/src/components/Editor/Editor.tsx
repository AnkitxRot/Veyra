import React, { useRef, useEffect, useCallback } from "react";
import { monaco } from "../../monacoSetup";
import { chordToMonacoKeybinding } from "../../keymap/keymap";
import { getLanguageInfo } from "../../utils/language";
import { Diagnostic } from "../../utils/diagnostics";
import { IconClose, IconCode } from "../common/Icons";
import { getLanguageIcon } from "../common/iconUtils";
import { useLanguageIntelligence } from "../../hooks/useLanguageIntelligence";
import type { CollaborationClient, CollaboratorPresence } from "../../collab/client";
import { collaboratorsInFile, displayLabel } from "../../collab/presence";
import {
  rangesOverlap,
  normalizeRange,
  RANGE_NEAR_LINES,
  type AttentionEvent,
  type AttentionRange,
} from "../../collab/attention";
import AttentionComposer from "./AttentionComposer";
import type { UserPreferences, CommentThreadDTO } from "../../types";
import CommentGutter from "../Comments/CommentGutter";

// ---------------------------------------------------------------------------
// Live content registry (M1: truthful save primitive)
//
// Commit cc55a1a made React state (`openFiles[].content`) intentionally stale
// during typing: the content-change handler only flips the `dirty` flag so a
// keystroke never rebuilds the array (render-churn fix). That means React
// state must NEVER be treated as the save-time source of truth anymore.
//
// This module-level map is the authoritative side-channel from save consumers
// (IDE.tsx) to the Monaco models that hold what the user actually sees.
// Keys are workspace-relative paths with any leading "/" stripped, matching
// the normalization this file already applies when comparing openFiles paths
// against model URIs.
//
// Lifecycle:
//  - registered in the model-management effect (both branches: newly created
//    and pre-existing models found under the same URI),
//  - pruned whenever the closed-files cleanup effect disposes a model,
//    plus a defensive sweep for externally-disposed entries,
//  - detached entirely when the editor instance unmounts, so a late save can
//    never observe content from a dead editor.
// ---------------------------------------------------------------------------
const liveModels = new Map<string, monaco.editor.ITextModel>();

function normalizeModelKey(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * Returns the content currently visible in the live Monaco model for `path`,
 * or null when no live model exists (file not materialized in an editor).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function getLiveContent(path: string): string | null {
  const model = liveModels.get(normalizeModelKey(path));
  if (!model || model.isDisposed()) return null;
  return model.getValue();
}

/**
 * Replaces the full contents of the live model for `path` as a single,
 * undo-able edit. Returns false when no live model exists, letting callers
 * fall back to state-only updates (previous behavior).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function applyLiveContent(path: string, content: string): boolean {
  const model = liveModels.get(normalizeModelKey(path));
  if (!model || model.isDisposed()) return false;
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: content }],
    () => null,
  );
  return true;
}

function registerLiveModel(
  path: string,
  model: monaco.editor.ITextModel,
): void {
  liveModels.set(normalizeModelKey(path), model);
}

/**
 * Handle through which the lazily-loaded Editor exposes the live-content API
 * to IDE.tsx without forcing Editor (and therefore Monaco) into the entry
 * bundle. IDE holds a ref; this component populates it on mount and detaches
 * on unmount. Typed via `import type` on the consumer side so the lazy chunk
 * boundary is preserved.
 */
export interface LiveContentApi {
  get(path: string): string | null;
  apply(path: string, content: string): boolean;
}

/**
 * M59: model-safe Monaco view-state (cursor + selection + scroll + folding).
 * The anchor "return to my location" flow uses this. `restore` refuses (returns
 * false) unless the active model IS `filePath` — a saved view state is NEVER
 * applied to the wrong model. Never touches model content.
 */
export interface EditorViewApi {
  save(): {
    filePath: string;
    viewState: unknown;
    cursor: { line: number; column: number } | null;
  } | null;
  restore(filePath: string, viewState: unknown): boolean;
}

export interface EditorProps {
  project: any;
  openFiles: any[];
  setOpenFiles: React.Dispatch<React.SetStateAction<any[]>>;
  activeFile: string | null;
  setActiveFile: (file: string | null) => void;
  onCreateFile?: () => void;
  diagnostics?: Diagnostic[];
  collabClient?: CollaborationClient | null;
  collaborators?: CollaboratorPresence[];
  currentUserId?: number;
  /** M58: transient attention events for the currently open project. */
  attention?: AttentionEvent[];
  onAttentionNavigate?: (e: AttentionEvent) => void;
  /** M58: "View" a collaborator from the spatial-overlap badge. */
  onViewCollaborator?: (userId: number) => void;
  onUserEdit?: () => void;
  isReadOnly?: boolean;
  /** M69: the resolved appearance ("dark" | "light") from `useAppearance`.
   *  Drives the Monaco theme; a change updates the live editor in place. */
  resolvedTheme?: "dark" | "light";
  /** M70: the resolved `save` chord (canonical, e.g. "mod+s"). Registers the
   *  in-editor Monaco save keybinding; a remap re-registers it in place. */
  saveChord?: string;
  liveApiRef?: React.MutableRefObject<LiveContentApi | null>;
  /** M59: model-safe view-state save/restore for the follow anchor. */
  editorViewApiRef?: React.MutableRefObject<EditorViewApi | null>;
  preferences?: UserPreferences;
  /** M61-A: comment threads for the active project. */
  commentThreads?: CommentThreadDTO[];
  projectId?: string;
  commentCountsByFile?: Map<string, number>;
  onOpenCommentThread?: (threadId: string) => void;
  /** M61-A: create a thread from the current selection. */
  onCreateComment?: (input: {
    filePath: string;
    selection: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  }) => void;
}

export default function Editor({
  project: _project,
  openFiles,
  setOpenFiles,
  activeFile,
  setActiveFile,
  onCreateFile,
  diagnostics = [],
  collabClient,
  collaborators = [],
  currentUserId,
  attention = [],
  onAttentionNavigate: _onAttentionNavigate,
  onViewCollaborator,
  onUserEdit,
  isReadOnly = false,
  resolvedTheme = "dark",
  saveChord = "mod+s",
  liveApiRef,
  editorViewApiRef,
  preferences,
  commentThreads = [],
  projectId,
  commentCountsByFile,
  onOpenCommentThread,
  onCreateComment,
}: EditorProps) {
  // M61-A: mirror the created editor instance into state so <CommentGutter>
  // (which needs the live instance) mounts once it exists.
  const [commentEditor, setCommentEditor] =
    React.useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeFileRef = useRef(activeFile);
  const isUpdatingModelRef = useRef(false);
  const collabClientRef = useRef(collabClient);
  const onUserEditRef = useRef(onUserEdit);
  const onCreateCommentRef = useRef(onCreateComment);
  const isReadOnlyRef = useRef(isReadOnly);

  useLanguageIntelligence({
    projectId,
    openFiles,
    getLiveContent,
  });
  // M69: Monaco built-in theme id for the resolved appearance. Kept in a ref
  // so the mount-time create() closure reads the current value; a later
  // change is applied in place by the effect below (never a remount).
  const monacoThemeRef = useRef(
    resolvedTheme === "light" ? "vs" : "vs-dark",
  );
  monacoThemeRef.current = resolvedTheme === "light" ? "vs" : "vs-dark";
  // M70: the resolved save chord + the live Monaco save action's disposable.
  const saveChordRef = useRef(saveChord);
  saveChordRef.current = saveChord;
  const saveActionRef = useRef<{ dispose: () => void } | null>(null);
  // M58: current local selection (zero-width when just a cursor) for spatial
  // overlap; refs so the Monaco action closures see fresh values.
  const [localSelection, setLocalSelection] = React.useState<AttentionRange>({
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  });
  const collaboratorsRef = useRef(collaborators);
  const [composer, setComposer] = React.useState<{
    mode: "callout" | "comeLook";
    anchorTop: number;
    anchorLeft: number;
    range: AttentionRange;
  } | null>(null);
  const attnDecorationsRef =
    useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const calloutWidgetsRef = useRef<Map<string, monaco.editor.IContentWidget>>(
    new Map(),
  );
  // M59: clickable point chips (parity with callout bubbles, for navigation).
  const pointWidgetsRef = useRef<Map<string, monaco.editor.IContentWidget>>(
    new Map(),
  );
  // M59: a pending "restore this view state once the right model is active".
  const restorePendingRef = useRef<{
    filePath: string;
    viewState: unknown;
    cursor: { line: number; column: number } | null;
  } | null>(null);
  // Tracks what the model-management effect last *fully* processed. Used to
  // skip expensive setup (setModelLanguage / bindMonacoModel / layout) when the
  // effect only re-ran because `openFiles` got a new array reference from a
  // keystroke content update on the already-active file.
  const lastBoundKeyRef = useRef<{
    activeFile: string | null;
    collabClient: CollaborationClient | null | undefined;
    isReadOnly: boolean;
  } | null>(null);

  useEffect(() => {
    activeFileRef.current = activeFile;
  }, [activeFile]);

  useEffect(() => {
    collabClientRef.current = collabClient;
  }, [collabClient]);

  useEffect(() => {
    onUserEditRef.current = onUserEdit;
  }, [onUserEdit]);

  useEffect(() => {
    onCreateCommentRef.current = onCreateComment;
  }, [onCreateComment]);

  useEffect(() => {
    collaboratorsRef.current = collaborators;
  }, [collaborators]);

  // M58: three-tier spatial awareness. same-file (the M57 strip, unchanged) →
  // nearby (editing within RANGE_NEAR_LINES, not overlapping) → overlapping
  // (rangesOverlap of the active selections). Never a lock, never a semantic
  // conflict claim.
  const spatialCollaborators = React.useMemo(() => {
    if (!activeFile) return [] as {
      collaborator: CollaboratorPresence;
      tier: "nearby" | "overlapping";
    }[];
    const out: {
      collaborator: CollaboratorPresence;
      tier: "nearby" | "overlapping";
    }[] = [];
    for (const cbr of collaborators) {
      if (cbr.userId === currentUserId || cbr.activeFile !== activeFile) {
        continue;
      }
      if (cbr.activity?.type !== "editing") continue;
      const raw = cbr.selection
        ? {
            startLine: cbr.selection.startLine,
            startColumn: cbr.selection.startColumn,
            endLine: cbr.selection.endLine,
            endColumn: cbr.selection.endColumn,
          }
        : cbr.cursor
          ? {
              startLine: cbr.cursor.line,
              startColumn: cbr.cursor.column,
              endLine: cbr.cursor.line,
              endColumn: cbr.cursor.column,
            }
          : null;
      const theirs = normalizeRange(raw);
      if (!theirs) continue;
      if (rangesOverlap(localSelection, theirs)) {
        out.push({ collaborator: cbr, tier: "overlapping" });
      } else if (
        Math.abs(theirs.startLine - localSelection.startLine) <=
        RANGE_NEAR_LINES
      ) {
        out.push({ collaborator: cbr, tier: "nearby" });
      }
    }
    return out;
  }, [activeFile, collaborators, currentUserId, localSelection]);

  const overlappingCollaborators = spatialCollaborators.filter(
    (s) => s.tier === "overlapping",
  );
  const nearbyCollaborators = spatialCollaborators.filter(
    (s) => s.tier === "nearby",
  );

  // M57: everyone whose focused file IS this file (distinct from the
  // within-5-lines proximity warning above — this is "who else is in here at
  // all"). De-duped by userId so a multi-tab collaborator shows once.
  const sameFileCollaborators = React.useMemo(() => {
    if (!activeFile) return [];
    const seen = new Set<number>();
    return collaboratorsInFile(collaborators ?? [], activeFile, currentUserId).filter(
      (c) => (seen.has(c.userId) ? false : (seen.add(c.userId), true)),
    );
  }, [activeFile, collaborators, currentUserId]);

  // M70: (re)register the in-editor Monaco save keybinding from the resolved
  // save chord. Disposable + re-added on change — no remount. `run` reads
  // refs so it always saves the live model content (BUG-1 guarantee).
  const registerSaveAction = useCallback(() => {
    const ed = monacoRef.current;
    if (!ed) return;
    saveActionRef.current?.dispose();
    saveActionRef.current = null;
    const kb = chordToMonacoKeybinding(saveChordRef.current, monaco);
    saveActionRef.current = ed.addAction({
      id: "cloudeee.action.save",
      label: "Save File",
      keybindings: kb != null ? [kb] : [],
      run: async () => {
        const val = monacoRef.current?.getValue();
        const currentPath = activeFileRef.current;
        if (currentPath && val !== undefined) {
          document.dispatchEvent(
            new CustomEvent("ide-save", {
              detail: { path: currentPath, content: val },
            }),
          );
        }
      },
    });
  }, []);

  // Re-register on a save-chord change (after mount — the create effect does
  // the initial registration since it owns the editor instance).
  useEffect(() => {
    if (monacoRef.current) registerSaveAction();
  }, [saveChord, registerSaveAction]);

  // M69: apply the resolved appearance to the LIVE editor without remounting
  // it or replacing any model. `monaco.editor.setTheme` swaps the global
  // theme in place — view state, cursor, selection, collaboration bindings
  // and the model registry are all untouched.
  useEffect(() => {
    if (!monacoRef.current) return;
    monaco.editor.setTheme(monacoThemeRef.current);
  }, [resolvedTheme]);

  // Dynamically apply preferences changes without remounting editor or replacing models
  useEffect(() => {
    if (!monacoRef.current || !preferences) return;
    monacoRef.current.updateOptions({
      fontSize: preferences.fontSize,
      tabSize: preferences.tabSize,
      wordWrap: preferences.wordWrap,
      minimap: { enabled: preferences.minimap },
      lineNumbers: preferences.lineNumbers,
      cursorBlinking: preferences.cursorBlinking,
      renderWhitespace: preferences.renderWhitespace,
    });
  }, [preferences]);

  // Create Monaco instance on component mount
  useEffect(() => {
    if (editorRef.current && !monacoRef.current) {
      monacoRef.current = monaco.editor.create(editorRef.current, {
        theme: monacoThemeRef.current,
        automaticLayout: true,
        minimap: { enabled: preferences?.minimap ?? false },
        fontSize: preferences?.fontSize ?? 13.5,
        lineNumbers: preferences?.lineNumbers ?? "on",
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        renderWhitespace: preferences?.renderWhitespace ?? "selection",
        tabSize: preferences?.tabSize ?? 4,
        wordWrap: preferences?.wordWrap ?? "off",
        fontFamily: "var(--font-mono)",
        cursorSmoothCaretAnimation: "on",
        cursorBlinking: preferences?.cursorBlinking ?? "smooth",
        smoothScrolling: true,
        padding: { top: 12, bottom: 12 },
        bracketPairColorization: { enabled: true },
        readOnly: isReadOnlyRef.current,
      });
      setCommentEditor(monacoRef.current);

      // Publish the live-content API for save consumers. Done as soon as the
      // editor exists so Ctrl+S issued while chunks/models settle still
      // resolves truthfully (or falls back cleanly when it cannot).
      if (liveApiRef) {
        liveApiRef.current = { get: getLiveContent, apply: applyLiveContent };
      }

      // M59: model-safe view-state API for the follow anchor.
      if (editorViewApiRef) {
        editorViewApiRef.current = {
          save: () => {
            const ed = monacoRef.current;
            if (!ed || !activeFileRef.current) return null;
            const pos = ed.getPosition?.();
            return {
              filePath: activeFileRef.current,
              viewState: ed.saveViewState?.() ?? null,
              cursor: pos
                ? { line: pos.lineNumber, column: pos.column }
                : null,
            };
          },
          restore: (filePath, viewState) => {
            const ed = monacoRef.current;
            if (!ed || viewState == null) return false;
            const m = ed.getModel?.();
            const active = m ? normalizeModelKey(m.uri.path) : null;
            if (active !== filePath) return false;
            try {
              ed.restoreViewState?.(
                viewState as monaco.editor.ICodeEditorViewState,
              );
              ed.focus?.();
              return true;
            } catch {
              return false;
            }
          },
        };
      }

      monacoRef.current.onDidChangeCursorPosition((e) => {
        if (collabClientRef.current) {
          collabClientRef.current.updateCursorPosition(
            e.position.lineNumber,
            e.position.column,
          );
        }
      });

      monacoRef.current.onDidChangeCursorSelection((e) => {
        const sel = e.selection;
        // M58: track the local selection for spatial-overlap awareness. This
        // is a LOCAL read only — it never writes awareness (that is the line
        // below, unchanged).
        setLocalSelection({
          startLine: sel.startLineNumber,
          startColumn: sel.startColumn,
          endLine: sel.endLineNumber,
          endColumn: sel.endColumn,
        });
        if (collabClientRef.current) {
          collabClientRef.current.updateSelection({
            startLine: sel.startLineNumber,
            startColumn: sel.startColumn,
            endLine: sel.endLineNumber,
            endColumn: sel.endColumn,
          });
        }
      });

      monacoRef.current.onDidChangeModelContent(() => {
        if (isUpdatingModelRef.current) return;
        if (collabClientRef.current) {
          collabClientRef.current.recordEdit();
        }
        onUserEditRef.current?.();

        const currentPath = activeFileRef.current;
        if (!currentPath) return;

        const live = getLiveContent(currentPath);
        if (live !== null) {
          document.dispatchEvent(
            new CustomEvent("ide-live-content-change", {
              detail: { path: currentPath },
            }),
          );
        }

        setOpenFiles((prev: any) => {
          const currentFile = prev.find((f: any) => f.path === currentPath);
          if (currentFile && !currentFile.dirty) {
            return prev.map((f: any) =>
              f.path === currentPath ? { ...f, dirty: true } : f,
            );
          }
          return prev;
        });
      });

      // M70: the in-editor save keybinding, from the resolved `save` chord
      // (not a hardcoded Ctrl+S) so a remap moves it. The window-level
      // dispatcher (useKeyboardShortcuts) owns save for the rest of the IDE
      // chrome; its capture-phase stopPropagation shadows this one when both
      // would match — no double dispatch.
      registerSaveAction();

      // Register AI Context Menu Actions in Monaco
      const editorInstance = monacoRef.current;
      editorInstance.addAction({
        id: "workbench.action.aiExplainSelection",
        label: "AI: Explain Code / Selection",
        contextMenuGroupId: "1_ai",
        contextMenuOrder: 1,
        run: (ed) => {
          const sel = ed.getSelection();
          const selectedText = sel
            ? ed.getModel()?.getValueInRange(sel)
            : undefined;
          document.dispatchEvent(
            new CustomEvent("ide-ai-action", {
              detail: {
                action: "explain",
                path: activeFileRef.current,
                selectedCode: selectedText,
                selectionRange: sel
                  ? {
                      startLine: sel.startLineNumber,
                      startColumn: sel.startColumn,
                      endLine: sel.endLineNumber,
                      endColumn: sel.endColumn,
                    }
                  : undefined,
              },
            }),
          );
        },
      });

      editorInstance.addAction({
        id: "workbench.action.aiRefactorSelection",
        label: "AI: Refactor Selection",
        contextMenuGroupId: "1_ai",
        contextMenuOrder: 2,
        run: (ed) => {
          const sel = ed.getSelection();
          const selectedText = sel
            ? ed.getModel()?.getValueInRange(sel)
            : undefined;
          document.dispatchEvent(
            new CustomEvent("ide-ai-action", {
              detail: {
                action: "refactor",
                path: activeFileRef.current,
                selectedCode: selectedText,
              },
            }),
          );
        },
      });

      editorInstance.addAction({
        id: "workbench.action.aiGenerateTests",
        label: "AI: Generate Unit Tests",
        contextMenuGroupId: "1_ai",
        contextMenuOrder: 3,
        run: () => {
          document.dispatchEvent(
            new CustomEvent("ide-ai-action", {
              detail: {
                action: "generate_tests",
                path: activeFileRef.current,
              },
            }),
          );
        },
      });

      editorInstance.addAction({
        id: "workbench.action.aiOptimizeSelection",
        label: "AI: Optimize Selection",
        contextMenuGroupId: "1_ai",
        contextMenuOrder: 4,
        run: (ed) => {
          const sel = ed.getSelection();
          const selectedText = sel
            ? ed.getModel()?.getValueInRange(sel)
            : undefined;
          document.dispatchEvent(
            new CustomEvent("ide-ai-action", {
              detail: {
                action: "optimize",
                path: activeFileRef.current,
                selectedCode: selectedText,
              },
            }),
          );
        },
      });

      // --- M58: attention actions ---------------------------------------
      const attentionAvailable = () =>
        !!activeFileRef.current &&
        !isReadOnlyRef.current &&
        collabClientRef.current?.status === "connected";

      const rangeFromSelection = (
        sel: monaco.Selection | null,
      ): AttentionRange => ({
        startLine: sel?.startLineNumber ?? 1,
        startColumn: sel?.startColumn ?? 1,
        endLine: sel?.endLineNumber ?? 1,
        endColumn: sel?.endColumn ?? 1,
      });

      const anchorFor = (
        ed: monaco.editor.ICodeEditor,
        sel: monaco.Selection | null,
      ): { top: number; left: number } => {
        const pos = sel
          ? { lineNumber: sel.startLineNumber, column: sel.startColumn }
          : ed.getPosition() ?? { lineNumber: 1, column: 1 };
        const vp = ed.getScrolledVisiblePosition(pos);
        return { top: (vp?.top ?? 40) + 4, left: (vp?.left ?? 40) + 8 };
      };

      editorInstance.addAction({
        id: "cloudide.attention.point",
        label: "👉 Point here",
        contextMenuGroupId: "9_collab",
        contextMenuOrder: 1,
        run: (ed) => {
          if (!attentionAvailable()) return;
          collabClientRef.current?.sendAttentionPoint(
            activeFileRef.current!,
            rangeFromSelection(ed.getSelection()),
          );
        },
      });

      editorInstance.addAction({
        id: "cloudide.attention.callout",
        label: "📣 Call out selection",
        contextMenuGroupId: "9_collab",
        contextMenuOrder: 2,
        run: (ed) => {
          if (!attentionAvailable()) return;
          const sel = ed.getSelection();
          const a = anchorFor(ed, sel);
          setComposer({
            mode: "callout",
            anchorTop: a.top,
            anchorLeft: a.left,
            range: rangeFromSelection(sel),
          });
        },
      });

      editorInstance.addAction({
        id: "cloudide.attention.comeLook",
        label: "📣 Come look here…",
        contextMenuGroupId: "9_collab",
        contextMenuOrder: 3,
        run: (ed) => {
          if (!attentionAvailable()) return;
          const sel = ed.getSelection();
          const a = anchorFor(ed, sel);
          setComposer({
            mode: "comeLook",
            anchorTop: a.top,
            anchorLeft: a.left,
            range: rangeFromSelection(sel),
          });
        },
      });

      // --- M61-A: create a persistent comment from the selection ----------
      editorInstance.addAction({
        id: "cloudide.comment.create",
        label: "💬 Comment on selection",
        contextMenuGroupId: "9_collab",
        contextMenuOrder: 4,
        run: (ed) => {
          const path = activeFileRef.current;
          if (!path || isReadOnlyRef.current) return;
          const sel = ed.getSelection();
          onCreateCommentRef.current?.({
            filePath: path,
            selection: {
              startLine: sel?.startLineNumber ?? 1,
              startColumn: sel?.startColumn ?? 1,
              endLine: sel?.endLineNumber ?? 1,
              endColumn: sel?.endColumn ?? 1,
            },
          });
        },
      });
    }

    return () => {
      // Detach the live-content API first: after this point a save must never
      // observe content from a dying editor. Registry entries are dropped;
      // the models themselves stay governed by the openFiles cleanup effect
      // exactly as before (no disposal-order change for collab bindings).
      if (liveApiRef && liveApiRef.current) {
        liveApiRef.current = null;
      }
      if (editorViewApiRef && editorViewApiRef.current) {
        editorViewApiRef.current = null;
      }
      liveModels.clear();
      saveActionRef.current?.dispose();
      saveActionRef.current = null;
      const leftover = monaco.editor.getModels().slice();
      if (monacoRef.current) {
        monacoRef.current.dispose();
        monacoRef.current = null;
      }
      queueMicrotask(() => {
        for (const model of leftover) {
          try {
            if (!model.isDisposed()) model.dispose();
          } catch {
            /* binding teardown may race this */
          }
        }
      });
      setCommentEditor(null);
    };
    // liveApiRef / editorViewApiRef are stable ref objects passed down from
    // IDE; including them satisfies exhaustive-deps without changing cadence.
  }, [setOpenFiles, liveApiRef, editorViewApiRef, registerSaveAction]);

  // Sync read-only status with Monaco options
  useEffect(() => {
    isReadOnlyRef.current = isReadOnly;
    if (monacoRef.current) {
      monacoRef.current.updateOptions({ readOnly: isReadOnly });
    }
  }, [isReadOnly]);

  // Manage models, active model switching, and collaborative Yjs bindings
  useEffect(() => {
    if (!monacoRef.current) return;

    if (!activeFile || !openFiles.length) {
      if (collabClient) collabClient.unbindCurrentModel();
      monacoRef.current.setModel(null);
      lastBoundKeyRef.current = null;
      return;
    }

    const activeFileData = openFiles.find((f: any) => f.path === activeFile);
    if (!activeFileData) return;

    const uri = monaco.Uri.file(activeFile);
    let model = monaco.editor.getModel(uri);
    const langInfo = getLanguageInfo(activeFile);

    // A brand-new model, a different active file, or a change of collaboration
    // state all require the full (expensive) setup path. Anything else means
    // this effect only re-ran because `openFiles` changed identity, which
    // happens on every keystroke since the content-change handler rebuilds the
    // array via `.map()`.
    const lastKey = lastBoundKeyRef.current;
    const needsFullSetup =
      !model ||
      lastKey === null ||
      lastKey.activeFile !== activeFile ||
      lastKey.collabClient !== collabClient ||
      lastKey.isReadOnly !== isReadOnly ||
      monacoRef.current.getModel() !== model;

    // Both paths (freshly created or pre-existing under the same URI) flow
    // through here: from this moment the live model is the save-time source
    // of truth for this path.
    isUpdatingModelRef.current = true;
    try {
      let didSetValue = false;

      if (!model) {
        model = monaco.editor.createModel(
          activeFileData.content || "",
          langInfo.monacoId,
          uri,
        );
        // Force LF regardless of platform/content-detection: when the initial
        // value is still empty (a real race — this effect can run before the
        // REST fetch or the collab Y.Text seed resolves), Monaco falls back to
        // a platform default (CRLF on Windows) and that choice sticks for the
        // model's lifetime, since later content arrives via incremental edits
        // (Yjs) or setValue(), neither of which re-detects EOL. The backend
        // (files/service.ts, collab/manager.ts) only ever reads/writes/seeds
        // raw "\n" content, so a client that keeps CRLF silently diverges:
        // its keystrokes translate to Y.Text offsets assuming 2-byte line
        // breaks that don't exist in the shared \n-only document, corrupting
        // position for every other collaborator (verified live: two browser
        // sessions on the same OS ended up LF vs CRLF for the same file, and
        // a same-line edit landed one line apart across clients). Pinning LF
        // here removes the platform/race dependency entirely.
        model.setEOL(monaco.editor.EndOfLineSequence.LF);
      } else {
        // External content sync: another part of the app (AI patch apply,
        // save/format response, snapshot restore) replaced the content of the
        // active, non-dirty file. Always evaluated because it is a cheap
        // comparison, and it never fires for local keystrokes, which set
        // `dirty: true` in the same update.
        if (
          !collabClient &&
          model.getValue() !== activeFileData.content &&
          !activeFileData.dirty
        ) {
          model.setValue(activeFileData.content || "");
          didSetValue = true;
        }
        if (needsFullSetup) {
          monaco.editor.setModelLanguage(model, langInfo.monacoId);
        }
      }

      // Both paths (freshly created above, or pre-existing under the same
      // URI) flow through here with a non-null model: from this moment the
      // live model is the save-time source of truth for this path.
      registerLiveModel(activeFile, model);

      if (needsFullSetup && collabClient) {
        collabClient.unbindCurrentModel();
      }

      if (monacoRef.current.getModel() !== model) {
        monacoRef.current.setModel(model);
      }

      if (needsFullSetup) {
        // Attach y-monaco collaborative binding
        if (collabClient && model) {
          collabClient.bindMonacoModel(
            activeFile,
            model,
            monacoRef.current,
            isReadOnly,
          );
          // M57: a real tab/active-file switch (not first mount, not a
          // collab-state change) is an observable navigation.
          if (lastKey && lastKey.activeFile !== activeFile) {
            collabClient.recordNavigation();
          }
        }

        lastBoundKeyRef.current = { activeFile, collabClient, isReadOnly };
      }

      // `layout()` forces a synchronous reflow, so it must not run on the
      // per-keystroke path. It still runs for real model swaps and for the
      // external-sync path, preserving previous behavior there.
      if (needsFullSetup || didSetValue) {
        monacoRef.current.layout();
      }
    } finally {
      isUpdatingModelRef.current = false;
    }
  }, [activeFile, openFiles, collabClient, isReadOnly]);

  // M59: consume a pending view-state restore ONLY when the requested file is
  // now the active file AND its Monaco model is attached. If the exact restore
  // is not safe (no saved state / model mismatch) fall back to a plain cursor
  // reveal. Never restores a view state into the wrong model.
  const tryConsumeRestoreRef = useRef<() => void>(() => {});
  tryConsumeRestoreRef.current = () => {
    const pending = restorePendingRef.current;
    if (!pending) return;
    if (activeFileRef.current !== pending.filePath) return;
    const ed = monacoRef.current;
    if (!ed) return;
    const m = ed.getModel?.();
    if (!m || normalizeModelKey(m.uri.path) !== pending.filePath) return;

    restorePendingRef.current = null;
    let restored = false;
    if (pending.viewState != null) {
      try {
        ed.restoreViewState?.(
          pending.viewState as monaco.editor.ICodeEditorViewState,
        );
        restored = true;
      } catch {
        restored = false;
      }
    }
    if (!restored) {
      const line = Math.max(1, pending.cursor?.line ?? 1);
      const column = Math.max(1, pending.cursor?.column ?? 1);
      ed.revealPositionInCenter({ lineNumber: line, column });
      ed.setPosition({ lineNumber: line, column });
    }
    ed.focus?.();
  };

  // Re-check after every model-management pass (same deps as that effect).
  useEffect(() => {
    tryConsumeRestoreRef.current();
  }, [activeFile, openFiles]);

  // Receive a restore request; try immediately (file may already be active),
  // otherwise the effect above consumes it once the right model attaches.
  useEffect(() => {
    const onRestore = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        filePath?: string;
        viewState?: unknown;
        cursor?: { line: number; column: number } | null;
      };
      if (!d?.filePath) return;
      restorePendingRef.current = {
        filePath: d.filePath,
        viewState: d.viewState ?? null,
        cursor: d.cursor ?? null,
      };
      tryConsumeRestoreRef.current();
    };
    document.addEventListener("ide-restore-view-state", onRestore);
    return () =>
      document.removeEventListener("ide-restore-view-state", onRestore);
  }, []);

  // Synchronize Monaco Error Markers with Diagnostics
  useEffect(() => {
    const allModels = monaco.editor.getModels();

    for (const model of allModels) {
      const normPath = model.uri.path.startsWith("/")
        ? model.uri.path.slice(1)
        : model.uri.path;

      const fileDiagnostics = diagnostics.filter(
        (d) => d.filePath === normPath || d.filePath === model.uri.path,
      );

      const markers: monaco.editor.IMarkerData[] = fileDiagnostics.map((d) => ({
        severity:
          d.severity === "error"
            ? monaco.MarkerSeverity.Error
            : d.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        message: d.message,
        startLineNumber: d.line,
        startColumn: d.column || 1,
        endLineNumber: d.endLine || d.line,
        endColumn: d.endColumn || (d.column ? d.column + 25 : 100),
        source: d.source,
      }));

      monaco.editor.setModelMarkers(model, "cloudeee-problems", markers);
    }
  }, [diagnostics, activeFile]);

  // Listen for Reveal Location events (from Problems panel or Workspace Search)
  useEffect(() => {
    const handleReveal = (e: Event) => {
      const { filePath, line, column, matchLength } = (e as CustomEvent).detail;
      if (!filePath || !monacoRef.current) return;

      if (activeFileRef.current !== filePath) {
        setActiveFile(filePath);
      }

      setTimeout(() => {
        if (!monacoRef.current) return;
        const lineNum = Math.max(1, line || 1);
        const colNum = Math.max(1, column || 1);

        monacoRef.current.revealPositionInCenter({
          lineNumber: lineNum,
          column: colNum,
        });
        monacoRef.current.setPosition({ lineNumber: lineNum, column: colNum });

        if (matchLength && matchLength > 0) {
          monacoRef.current.setSelection(
            new monaco.Range(lineNum, colNum, lineNum, colNum + matchLength),
          );
        }
        monacoRef.current.focus();
      }, 50);
    };

    document.addEventListener("ide-reveal-location", handleReveal);
    return () =>
      document.removeEventListener("ide-reveal-location", handleReveal);
  }, [setActiveFile]);

  // Clean up models for closed files
  useEffect(() => {
    // Defensive sweep: drop registry entries whose model was disposed by any
    // other path, so getLiveContent can never read from a disposed model.
    for (const [key, m] of liveModels) {
      if (m.isDisposed()) liveModels.delete(key);
    }

    const openPaths = new Set(openFiles.map((f: any) => f.path));
    const allModels = monaco.editor.getModels();
    for (const model of allModels) {
      const normPath = model.uri.path.startsWith("/")
        ? model.uri.path.slice(1)
        : model.uri.path;
      if (!openPaths.has(normPath) && !openPaths.has(model.uri.path)) {
        liveModels.delete(normPath);
        model.dispose();
      }
    }
  }, [openFiles]);

  // M58: render incoming point/callout decorations + callout bubbles for the
  // ACTIVE file only. Never mutates the Monaco model. Message text is always
  // set via textContent — never innerHTML.
  useEffect(() => {
    const editor = monacoRef.current;
    if (!editor) return;
    if (!attnDecorationsRef.current && editor.createDecorationsCollection) {
      attnDecorationsRef.current = editor.createDecorationsCollection();
    }

    const relevant = attention.filter(
      (e) =>
        e.file === activeFile &&
        (e.kind === "point" || e.kind === "callout"),
    );

    const decos: monaco.editor.IModelDeltaDecoration[] = relevant.map((e) => {
      const isPoint = e.kind === "point";
      return {
        range: new monaco.Range(
          e.range.startLine,
          e.range.startColumn,
          isPoint ? e.range.startLine : e.range.endLine,
          isPoint ? e.range.startColumn : e.range.endColumn,
        ),
        options: {
          className: isPoint
            ? "attention-point-line"
            : "attention-callout-range",
          glyphMarginClassName: isPoint ? "attention-point-glyph" : undefined,
          isWholeLine: false,
          // M59: the "👉 name" text now lives in a clickable point chip widget
          // (below), so the inline `after` label is dropped to avoid duplication.
          overviewRuler: monaco.editor.OverviewRulerLane
            ? {
                color: e.author.color,
                position: monaco.editor.OverviewRulerLane.Right,
              }
            : undefined,
        },
      };
    });
    attnDecorationsRef.current?.set(decos);

    // Callout bubbles as content widgets (imperative DOM → guaranteed
    // textContent for the message).
    const widgets = calloutWidgetsRef.current;
    const seen = new Set<string>();
    for (const e of relevant) {
      if (e.kind !== "callout") continue;
      seen.add(e.id);
      if (widgets.has(e.id)) continue;
      if (!editor.addContentWidget) continue;

      const dom = document.createElement("div");
      dom.className = "attention-callout-bubble";
      // M59: clicking the bubble body steps into the author's context
      // (navigate + end any different follow). Button clicks are excluded.
      dom.onclick = (ev) => {
        if ((ev.target as HTMLElement)?.closest("button")) return;
        document.dispatchEvent(
          new CustomEvent("ide-attention-activate", { detail: { id: e.id } }),
        );
      };
      const dot = document.createElement("span");
      dot.className = "attention-callout-dot";
      dot.style.background = e.author.color;
      dot.setAttribute("aria-hidden", "true");
      const who = document.createElement("span");
      who.className = "attention-callout-who";
      who.textContent = `📣 ${e.author.username}`;
      const msg = document.createElement("div");
      msg.className = "attention-callout-msg";
      msg.textContent = e.message ?? "";
      const follow = document.createElement("button");
      follow.type = "button";
      follow.className = "attention-callout-follow";
      follow.textContent = "Follow";
      follow.setAttribute("aria-label", `Follow ${e.author.username}`);
      follow.onclick = (ev) => {
        ev.stopPropagation();
        document.dispatchEvent(
          new CustomEvent("ide-attention-follow", { detail: { id: e.id } }),
        );
      };
      const keep = document.createElement("button");
      keep.type = "button";
      keep.className = "attention-callout-keep";
      keep.textContent = "Keep as comment";
      keep.setAttribute("aria-label", "Keep as comment");
      keep.onclick = (ev) => {
        ev.stopPropagation();
        document.dispatchEvent(
          new CustomEvent("ide-attention-keep-as-comment", { detail: { id: e.id } }),
        );
      };
      const x = document.createElement("button");
      x.type = "button";
      x.className = "attention-callout-x";
      x.textContent = "×";
      x.setAttribute("aria-label", "Dismiss callout");
      x.onclick = (ev) => {
        ev.stopPropagation();
        collabClientRef.current?.attentionStore.dismissLocal(e.id);
      };
      dom.append(dot, who, msg, follow, keep, x);

      const widget: monaco.editor.IContentWidget = {
        getId: () => `attention-callout-${e.id}`,
        getDomNode: () => dom,
        getPosition: () => ({
          position: {
            lineNumber: e.range.startLine,
            column: e.range.startColumn,
          },
          // [ABOVE, BELOW]
          preference: [1, 2] as unknown as monaco.editor.ContentWidgetPositionPreference[],
        }),
      };
      widgets.set(e.id, widget);
      editor.addContentWidget(widget);
    }
    for (const [id, w] of widgets) {
      if (!seen.has(id)) {
        editor.removeContentWidget?.(w);
        widgets.delete(id);
      }
    }

    // M59: point chips — a tiny clickable "👉 name" widget so a point is a
    // navigation affordance (parity with the callout bubble), not just a label.
    const pointWidgets = pointWidgetsRef.current;
    const seenPoints = new Set<string>();
    for (const e of relevant) {
      if (e.kind !== "point") continue;
      seenPoints.add(e.id);
      if (pointWidgets.has(e.id)) continue;
      if (!editor.addContentWidget) continue;

      const dom = document.createElement("div");
      dom.className = "attention-point-chip";
      dom.textContent = `👉 ${e.author.username}`;
      dom.setAttribute("role", "button");
      dom.onclick = () => {
        document.dispatchEvent(
          new CustomEvent("ide-attention-activate", { detail: { id: e.id } }),
        );
      };
      const widget: monaco.editor.IContentWidget = {
        getId: () => `attention-point-${e.id}`,
        getDomNode: () => dom,
        getPosition: () => ({
          position: {
            lineNumber: e.range.startLine,
            column: e.range.startColumn,
          },
          preference: [1, 2] as unknown as monaco.editor.ContentWidgetPositionPreference[],
        }),
      };
      pointWidgets.set(e.id, widget);
      editor.addContentWidget(widget);
    }
    for (const [id, w] of pointWidgets) {
      if (!seenPoints.has(id)) {
        editor.removeContentWidget?.(w);
        pointWidgets.delete(id);
      }
    }
  }, [attention, activeFile]);

  // M58: tear down every attention widget/decoration on unmount. Runs after
  // the Monaco-create effect's own cleanup (which nulls monacoRef), so it
  // detaches the widget DOM directly rather than via the editor.
  useEffect(() => {
    const widgets = calloutWidgetsRef.current;
    const pointWidgets = pointWidgetsRef.current;
    const decos = attnDecorationsRef;
    return () => {
      const editor = monacoRef.current;
      for (const w of [...widgets.values(), ...pointWidgets.values()]) {
        try {
          editor?.removeContentWidget?.(w);
        } catch {
          /* editor already disposed */
        }
        try {
          w.getDomNode().remove();
        } catch {
          /* node already detached */
        }
      }
      widgets.clear();
      pointWidgets.clear();
      decos.current?.clear();
    };
  }, []);

  const hasOpenFiles = openFiles.length > 0;

  return (
    <div className="editor-container">
      {/* Liquid Glass Tabs Strip */}
      {hasOpenFiles && (
        <div className="editor-tabs" role="tablist">
          {openFiles.map((f: any) => {
            const tabCollaborators = (collaborators || []).filter(
              (c) => c.userId !== currentUserId && c.activeFile === f.path,
            );
            return (
              <div
                key={f.path}
                className={`editor-tab ${activeFile === f.path ? "active" : ""}`}
                onClick={() => setActiveFile(f.path)}
                role="tab"
                aria-selected={activeFile === f.path}
                title={f.path}
              >
                {getLanguageIcon(f.path, 13)}
                <span className="tab-filename">{f.path.split("/").pop()}</span>
                {f.dirty && (
                  <span className="tab-dirty-indicator" title="Unsaved changes" />
                )}
                {(() => {
                  const cc = commentCountsByFile?.get(f.path) ?? 0;
                  return cc > 0 ? (
                    <span
                      className="tab-comment-badge"
                      title={`${cc} unresolved comment${cc === 1 ? "" : "s"}`}
                      aria-label={`${cc} unresolved comments`}
                    >
                      💬 {cc}
                    </span>
                  ) : null;
                })()}
                {tabCollaborators.length > 0 && (
                  <span
                    className="tab-collab-badge"
                    title={tabCollaborators
                      .map((c) => `${displayLabel(c)} (${c.activity?.type || "viewing"})`)
                      .join(", ")}
                    aria-label={`${tabCollaborators.length} active collaborator(s) on this tab`}
                  >
                    {tabCollaborators.slice(0, 3).map((c) => (
                      <span
                        key={c.clientId}
                        className="tab-collab-dot"
                        style={{ backgroundColor: c.color }}
                      />
                    ))}
                    {tabCollaborators.length > 3 && (
                      <span className="tab-collab-count">
                        +{tabCollaborators.length - 3}
                      </span>
                    )}
                  </span>
                )}
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    const newFiles = openFiles.filter(
                      (of: any) => of.path !== f.path,
                    );
                    setOpenFiles(newFiles);
                    if (activeFile === f.path) {
                      setActiveFile(
                        newFiles.length
                          ? newFiles[newFiles.length - 1].path
                          : null,
                      );
                    }
                  }}
                  title="Close Tab"
                  aria-label={`Close ${f.path}`}
                >
                  <IconClose size={10} />
                </button>
              </div>
            );
          })}

          {/* M58: spatial awareness — overlap wins over nearby. Never a lock,
              never a semantic-conflict claim. */}
          {overlappingCollaborators.length > 0 ? (
            <div
              className="spatial-badge spatial-overlap"
              role="status"
              aria-live="polite"
              title={`Editing the same lines: ${overlappingCollaborators
                .map((s) => displayLabel(s.collaborator))
                .join(", ")}`}
            >
              <span className="spatial-dot" aria-hidden="true" />
              <span>
                ⚠{" "}
                {overlappingCollaborators
                  .map((s) => displayLabel(s.collaborator))
                  .join(", ")}{" "}
                {overlappingCollaborators.length === 1 ? "is" : "are"} editing
                the same lines
              </span>
              {onViewCollaborator && overlappingCollaborators[0] && (
                <button
                  type="button"
                  className="spatial-view"
                  onClick={() =>
                    onViewCollaborator(
                      overlappingCollaborators[0].collaborator.userId,
                    )
                  }
                >
                  View {displayLabel(overlappingCollaborators[0].collaborator)}
                </button>
              )}
            </div>
          ) : nearbyCollaborators.length > 0 ? (
            <div
              className="spatial-badge spatial-nearby"
              role="status"
              aria-live="polite"
              title={`Editing nearby: ${nearbyCollaborators
                .map((s) => displayLabel(s.collaborator))
                .join(", ")}`}
            >
              <span className="spatial-dot" aria-hidden="true" />
              <span>
                {nearbyCollaborators
                  .map((s) => displayLabel(s.collaborator))
                  .join(", ")}{" "}
                editing nearby (within {RANGE_NEAR_LINES} lines)
              </span>
            </div>
          ) : null}
        </div>
      )}

      {/* M57: who else is in this file right now (persistent, distinct from
          the within-5-lines proximity warning above). */}
      {sameFileCollaborators.length > 0 && (
        <div
          className="editor-samefile-strip"
          role="status"
          aria-live="polite"
          aria-label="Collaborators in this file"
        >
          {sameFileCollaborators.map((c) => (
            <span key={c.userId} className="samefile-chip">
              <span
                className="samefile-dot"
                style={{ backgroundColor: c.color }}
                aria-hidden="true"
              />
              {displayLabel(c)} ·{" "}
              {c.activity?.type === "editing" ? "✏️ Editing" : "👀 Viewing"}
            </span>
          ))}
        </div>
      )}

      {/* M58: attention message composer (Call out / Come look). */}
      {composer && (
        <AttentionComposer
          mode={composer.mode}
          anchorTop={composer.anchorTop}
          anchorLeft={composer.anchorLeft}
          collaborators={(collaborators ?? [])
            .filter(
              (c) =>
                c.userId !== currentUserId &&
                (c.status === "online" ||
                  c.status === "idle" ||
                  c.status === "away"),
            )
            .filter(
              (c, i, arr) =>
                arr.findIndex((x) => x.userId === c.userId) === i,
            )
            .map((c) => ({
              userId: c.userId,
              name: displayLabel(c),
              color: c.color,
            }))}
          onSubmit={(message, targetUserId) => {
            const client = collabClientRef.current;
            const file = activeFileRef.current;
            if (client && file) {
              if (composer.mode === "callout") {
                client.sendAttentionCallout(file, composer.range, message);
              } else if (targetUserId != null) {
                client.sendAttentionRequest(
                  targetUserId,
                  file,
                  composer.range,
                  message,
                );
              }
            }
            setComposer(null);
          }}
          onCancel={() => setComposer(null)}
        />
      )}

      {/* Editor DOM container ALWAYS stays mounted so Monaco initializes on component mount */}
      <div
        className="editor-wrapper"
        ref={editorRef}
        style={{
          display: hasOpenFiles ? "block" : "none",
          flex: 1,
          width: "100%",
          height: hasOpenFiles ? "calc(100% - 38px)" : "100%",
        }}
      />

      {/* M61-A: comment gutter markers + chips for the active file. */}
      {commentEditor && activeFile && projectId && (
        <CommentGutter
          editor={commentEditor}
          monaco={monaco}
          projectId={projectId}
          activeFile={activeFile}
          doc={collabClientRef.current?.doc ?? null}
          threads={commentThreads}
          onOpenThread={(id) => onOpenCommentThread?.(id)}
        />
      )}

      {/* Empty State when no files are open */}
      {!hasOpenFiles && (
        <div className="editor-empty-state">
          <div className="empty-state-card">
            <div className="empty-state-icon">
              <IconCode size={24} />
            </div>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <h3
                style={{
                  margin: 0,
                  fontSize: "var(--text-lg)",
                  fontWeight: 600,
                  color: "var(--fg-primary)",
                }}
              >
                No Open Files
              </h3>
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--text-sm)",
                  color: "var(--fg-muted)",
                }}
              >
                Select a file from the sidebar explorer, Quick Open (Ctrl+P), or
                create a new file to start coding.
              </p>
            </div>
            {onCreateFile && (
              <button
                className="glass-btn glass-btn-primary"
                style={{ marginTop: "8px" }}
                onClick={onCreateFile}
              >
                + New File
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
