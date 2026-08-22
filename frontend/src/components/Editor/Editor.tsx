import React, { useRef, useEffect } from 'react';
import { monaco } from '../../monacoSetup';
import { getLanguageInfo } from '../../utils/language';
import { Diagnostic } from '../../utils/diagnostics';
import { IconClose, IconCode } from '../common/Icons';
import { getLanguageIcon } from '../common/iconUtils';
import type { CollaborationClient } from '../../collab/client';

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
}: EditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeFileRef = useRef(activeFile);
  const isUpdatingModelRef = useRef(false);
  const collabClientRef = useRef(collabClient);
  const isReadOnlyRef = useRef(isReadOnly);

  useEffect(() => {
    activeFileRef.current = activeFile;
  }, [activeFile]);

  useEffect(() => {
    collabClientRef.current = collabClient;
  }, [collabClient]);

  // Create Monaco instance on component mount
  useEffect(() => {
    if (editorRef.current && !monacoRef.current) {
      monacoRef.current = monaco.editor.create(editorRef.current, {
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13.5,
        lineNumbers: 'on',
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        tabSize: 4,
        wordWrap: 'off',
        fontFamily: 'var(--font-mono)',
        cursorSmoothCaretAnimation: 'on',
        cursorBlinking: 'smooth',
        smoothScrolling: true,
        padding: { top: 12, bottom: 12 },
        bracketPairColorization: { enabled: true },
        readOnly: isReadOnlyRef.current,
      });

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
        const val = monacoRef.current?.getValue();
        if (val === undefined) return;

        setOpenFiles((prev: any) => {
          const currentFile = prev.find((f: any) => f.path === currentPath);
          if (currentFile && currentFile.content !== val) {
            return prev.map((f: any) =>
              f.path === currentPath ? { ...f, content: val, dirty: true } : f,
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
              new CustomEvent('ide-save', {
                detail: { path: currentPath, content: val },
              }),
            );
          }
        },
      );

      // Register AI Context Menu Actions in Monaco
      const editorInstance = monacoRef.current;
      editorInstance.addAction({
        id: 'workbench.action.aiExplainSelection',
        label: 'AI: Explain Code / Selection',
        contextMenuGroupId: '1_ai',
        contextMenuOrder: 1,
        run: (ed) => {
          const sel = ed.getSelection();
          const selectedText = sel
            ? ed.getModel()?.getValueInRange(sel)
            : undefined;
          document.dispatchEvent(
            new CustomEvent('ide-ai-action', {
              detail: {
                action: 'explain',
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
        id: 'workbench.action.aiRefactorSelection',
        label: 'AI: Refactor Selection',
        contextMenuGroupId: '1_ai',
        contextMenuOrder: 2,
        run: (ed) => {
          const sel = ed.getSelection();
          const selectedText = sel
            ? ed.getModel()?.getValueInRange(sel)
            : undefined;
          document.dispatchEvent(
            new CustomEvent('ide-ai-action', {
              detail: {
                action: 'refactor',
                path: activeFileRef.current,
                selectedCode: selectedText,
              },
            }),
          );
        },
      });

      editorInstance.addAction({
        id: 'workbench.action.aiGenerateTests',
        label: 'AI: Generate Unit Tests',
        contextMenuGroupId: '1_ai',
        contextMenuOrder: 3,
        run: () => {
          document.dispatchEvent(
            new CustomEvent('ide-ai-action', {
              detail: {
                action: 'generate_tests',
                path: activeFileRef.current,
              },
            }),
          );
        },
      });

      editorInstance.addAction({
        id: 'workbench.action.aiOptimizeSelection',
        label: 'AI: Optimize Selection',
        contextMenuGroupId: '1_ai',
        contextMenuOrder: 4,
        run: (ed) => {
          const sel = ed.getSelection();
          const selectedText = sel
            ? ed.getModel()?.getValueInRange(sel)
            : undefined;
          document.dispatchEvent(
            new CustomEvent('ide-ai-action', {
              detail: {
                action: 'optimize',
                path: activeFileRef.current,
                selectedCode: selectedText,
              },
            }),
          );
        },
      });
    }

    return () => {
      if (monacoRef.current) {
        monacoRef.current.dispose();
        monacoRef.current = null;
      }
    };
  }, [setOpenFiles]);

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
      return;
    }

    const activeFileData = openFiles.find((f: any) => f.path === activeFile);
    if (!activeFileData) return;

    const uri = monaco.Uri.file(activeFile);
    let model = monaco.editor.getModel(uri);
    const langInfo = getLanguageInfo(activeFile);

    isUpdatingModelRef.current = true;
    try {
      if (!model) {
        model = monaco.editor.createModel(
          activeFileData.content || '',
          langInfo.monacoId,
          uri,
        );
      } else {
        if (
          !collabClient &&
          model.getValue() !== activeFileData.content &&
          !activeFileData.dirty
        ) {
          model.setValue(activeFileData.content || '');
        }
        monaco.editor.setModelLanguage(model, langInfo.monacoId);
      }

      if (monacoRef.current.getModel() !== model) {
        monacoRef.current.setModel(model);
      }

      // Attach y-monaco collaborative binding
      if (collabClient && model) {
        collabClient.bindMonacoModel(
          activeFile,
          model,
          monacoRef.current,
          isReadOnly,
        );
      }

      monacoRef.current.layout();
    } finally {
      isUpdatingModelRef.current = false;
    }
  }, [activeFile, openFiles, collabClient, isReadOnly]);

  // Synchronize Monaco Error Markers with Diagnostics
  useEffect(() => {
    const allModels = monaco.editor.getModels();

    for (const model of allModels) {
      const normPath = model.uri.path.startsWith('/')
        ? model.uri.path.slice(1)
        : model.uri.path;

      const fileDiagnostics = diagnostics.filter(
        (d) => d.filePath === normPath || d.filePath === model.uri.path,
      );

      const markers: monaco.editor.IMarkerData[] = fileDiagnostics.map((d) => ({
        severity:
          d.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : d.severity === 'warning'
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        message: d.message,
        startLineNumber: d.line,
        startColumn: d.column || 1,
        endLineNumber: d.endLine || d.line,
        endColumn: d.endColumn || (d.column ? d.column + 25 : 100),
        source: d.source,
      }));

      monaco.editor.setModelMarkers(model, 'cloudeee-problems', markers);
    }
  }, [diagnostics, activeFile, openFiles]);

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

    document.addEventListener('ide-reveal-location', handleReveal);
    return () =>
      document.removeEventListener('ide-reveal-location', handleReveal);
  }, [setActiveFile]);

  // Clean up models for closed files
  useEffect(() => {
    const openPaths = new Set(openFiles.map((f: any) => f.path));
    const allModels = monaco.editor.getModels();
    for (const model of allModels) {
      const normPath = model.uri.path.startsWith('/')
        ? model.uri.path.slice(1)
        : model.uri.path;
      if (!openPaths.has(normPath) && !openPaths.has(model.uri.path)) {
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
              className={`editor-tab ${activeFile === f.path ? 'active' : ''}`}
              onClick={() => setActiveFile(f.path)}
              role="tab"
              aria-selected={activeFile === f.path}
              title={f.path}
            >
              {getLanguageIcon(f.path, 13)}
              <span className="tab-filename">{f.path.split('/').pop()}</span>
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
          display: hasOpenFiles ? 'block' : 'none',
          flex: 1,
          width: '100%',
          height: hasOpenFiles ? 'calc(100% - 38px)' : '100%',
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
              style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
            >
              <h3
                style={{
                  margin: 0,
                  fontSize: 'var(--text-lg)',
                  fontWeight: 600,
                  color: 'var(--fg-primary)',
                }}
              >
                No Open Files
              </h3>
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--text-sm)',
                  color: 'var(--fg-muted)',
                }}
              >
                Select a file from the sidebar explorer, Quick Open (Ctrl+P), or
                create a new file to start coding.
              </p>
            </div>
            {onCreateFile && (
              <button
                className="glass-btn glass-btn-primary"
                style={{ marginTop: '8px' }}
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
