import React, { useRef, useEffect } from "react";
import { monaco } from "../../monacoSetup";
import { getLanguageInfo } from "../../utils/language";
import { Diagnostic } from "../../utils/diagnostics";
import { IconClose, IconCode } from "../common/Icons";
import { getLanguageIcon } from "../common/iconUtils";
import type { CollaborationClient } from "../../collab/client";
import type { UserPreferences } from "../../types";

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
 * Synchronous by design: save handlers need a consistent point-in-time read.
 *
 * Exported from a component file deliberately: M1's strict file boundary
 * forbids adding a shared module, and a value import here would drag the
 * Editor/Monaco chunk out of its lazy boundary for consumers anyway (IDE.tsx
 * accesses these through LiveContentApi ref indirection instead).
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

export interface EditorProps {
  project: any;
  openFiles: any[];
  setOpenFiles: React.Dispatch<React.SetStateAction<any[]>>;
  activeFile: string | null;
  setActiveFile: (file: string | null) => void;
  onCreateFile?: () => void;
  diagnostics?: Diagnostic[];
  collabClient?: CollaborationClient | null;
  isReadOnly?: boolean;
  liveApiRef?: React.MutableRefObject<LiveContentApi | null>;
  preferences?: UserPreferences;
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
  isReadOnly = false,
  liveApiRef,
  preferences,
}: EditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeFileRef = useRef(activeFile);
  const isUpdatingModelRef = useRef(false);
  const collabClientRef = useRef(collabClient);
  const isReadOnlyRef = useRef(isReadOnly);
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
        theme: "vs-dark",
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

      // Publish the live-content API for save consumers. Done as soon as the
      // editor exists so Ctrl+S issued while chunks/models settle still
      // resolves truthfully (or falls back cleanly when it cannot).
      if (liveApiRef) {
        liveApiRef.current = { get: getLiveContent, apply: applyLiveContent };
      }

      monacoRef.current.onDidChangeCursorPosition((e) => {
        if (collabClientRef.current) {
          collabClientRef.current.updateCursorPosition(
            e.position.lineNumber,
            e.position.column,
          );
        }
      });

      monacoRef.current.onDidChangeModelContent(() => {
        if (isUpdatingModelRef.current) return;
        const currentPath = activeFileRef.current;
        if (!currentPath) return;

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

      monacoRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        async () => {
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
      );

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
    }

    return () => {
      // Detach the live-content API first: after this point a save must never
      // observe content from a dying editor. Registry entries are dropped;
      // the models themselves stay governed by the openFiles cleanup effect
      // exactly as before (no disposal-order change for collab bindings).
      if (liveApiRef && liveApiRef.current) {
        liveApiRef.current = null;
      }
      liveModels.clear();
      if (monacoRef.current) {
        monacoRef.current.dispose();
        monacoRef.current = null;
      }
    };
    // liveApiRef is a stable ref object passed down from IDE; including it
    // satisfies exhaustive-deps without changing effect cadence.
  }, [setOpenFiles, liveApiRef]);

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

  const hasOpenFiles = openFiles.length > 0;

  return (
    <div className="editor-container">
      {/* Liquid Glass Tabs Strip */}
      {hasOpenFiles && (
        <div className="editor-tabs" role="tablist">
          {openFiles.map((f: any) => (
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
          ))}
        </div>
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
