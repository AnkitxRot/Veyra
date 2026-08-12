import React, { useRef, useEffect } from 'react';
import { monaco } from '../../monacoSetup';
import { getLanguageInfo } from '../../utils/language';

export default function Editor({ project, openFiles, setOpenFiles, activeFile, setActiveFile }: any) {
  const editorRef = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeFileRef = useRef(activeFile);
  const isUpdatingModelRef = useRef(false);

  useEffect(() => {
    activeFileRef.current = activeFile;
  }, [activeFile]);

  // Create monaco editor instance
  useEffect(() => {
    if (editorRef.current && !monacoRef.current) {
      monacoRef.current = monaco.editor.create(editorRef.current, {
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 14,
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
            return prev.map((f: any) => f.path === currentPath ? { ...f, content: val, dirty: true } : f);
          }
          return prev;
        });
      });

      monacoRef.current.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
        const val = monacoRef.current?.getValue();
        const currentPath = activeFileRef.current;
        if (currentPath && val !== undefined) {
          document.dispatchEvent(new CustomEvent('ide-save', { detail: { path: currentPath, content: val } }));
        }
      });
    }

    return () => {
      if (monacoRef.current) {
        monacoRef.current.dispose();
        monacoRef.current = null;
      }
    };
  }, []);

  // Manage models and active model switching
  useEffect(() => {
    if (!monacoRef.current || !activeFile) return;

    const activeFileData = openFiles.find((f: any) => f.path === activeFile);
    if (!activeFileData) return;

    const uri = monaco.Uri.file(activeFile);
    let model = monaco.editor.getModel(uri);
    const langInfo = getLanguageInfo(activeFile);

    isUpdatingModelRef.current = true;

    if (!model) {
      model = monaco.editor.createModel(activeFileData.content || '', langInfo.monacoId, uri);
    } else {
      if (model.getValue() !== activeFileData.content && !activeFileData.dirty) {
        model.setValue(activeFileData.content || '');
      }
      monaco.editor.setModelLanguage(model, langInfo.monacoId);
    }

    if (monacoRef.current.getModel() !== model) {
      monacoRef.current.setModel(model);
    }

    isUpdatingModelRef.current = false;
  }, [activeFile, openFiles]);

  // Clean up models for closed files
  useEffect(() => {
    const openPaths = new Set(openFiles.map((f: any) => f.path));
    const allModels = monaco.editor.getModels();
    for (const model of allModels) {
      const normPath = model.uri.path.startsWith('/') ? model.uri.path.slice(1) : model.uri.path;
      if (!openPaths.has(normPath) && !openPaths.has(model.uri.path)) {
        model.dispose();
      }
    }
  }, [openFiles]);

  if (!openFiles.length) {
    return (
      <div className="editor-container" style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
        Open a file to start editing
      </div>
    );
  }

  return (
    <div className="editor-container">
      <div className="editor-tabs">
        {openFiles.map((f: any) => (
          <div
            key={f.path}
            className={`editor-tab ${activeFile === f.path ? 'active' : ''}`}
            onClick={() => setActiveFile(f.path)}
          >
            {f.path.split('/').pop()} {f.dirty && '*'}
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                const newFiles = openFiles.filter((of: any) => of.path !== f.path);
                setOpenFiles(newFiles);
                if (activeFile === f.path) {
                  setActiveFile(newFiles.length ? newFiles[newFiles.length - 1].path : null);
                }
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="editor-wrapper" ref={editorRef} />
    </div>
  );
}
