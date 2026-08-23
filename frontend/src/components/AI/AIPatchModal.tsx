import React, { useEffect, useRef, useState } from 'react';
import { monaco } from '../../monacoSetup';
import { IconCheck, IconCode } from '../common/Icons';

export interface AIPatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: (options: { runVerification: boolean; createSnapshot: boolean }) => void;
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  explanation: string;
  providerName?: string;
  providerType?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

export default function AIPatchModal({
  isOpen,
  onClose,
  onAccept,
  filePath,
  originalContent,
  modifiedContent,
  explanation,
  providerName = 'Deterministic Rule & Static Analysis Engine',
  providerType: _providerType = 'deterministic',
  linesAdded = 0,
  linesRemoved = 0,
}: AIPatchModalProps) {
  const diffContainerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [createSnapshot, setCreateSnapshot] = useState(true);

  useEffect(() => {
    if (!isOpen || !diffContainerRef.current) return;

    // Detect language from file extension
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      py: 'python',
      c: 'c',
      cpp: 'cpp',
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      java: 'java',
      json: 'json',
      md: 'markdown',
    };
    const language = langMap[ext] || 'plaintext';

    // Create Monaco models with distinct, explicit URIs
    const timestamp = Date.now();
    const originalUri = monaco.Uri.parse(`inmemory://ai-patch-orig-${timestamp}/${filePath}`);
    const modifiedUri = monaco.Uri.parse(`inmemory://ai-patch-mod-${timestamp}/${filePath}`);

    const originalModel = monaco.editor.createModel(originalContent, language, originalUri);
    const modifiedModel = monaco.editor.createModel(modifiedContent, language, modifiedUri);

    // Instantiate Diff Editor
    const diffEditor = monaco.editor.createDiffEditor(diffContainerRef.current, {
      originalEditable: false,
      readOnly: true,
      theme: 'vs-dark',
      renderSideBySide: true,
      automaticLayout: true,
      diffAlgorithm: 'legacy',
      fontFamily: 'var(--font-mono, "JetBrains Mono", Consolas, monospace)',
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });

    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    diffEditorRef.current = diffEditor;

    return () => {
      diffEditor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [isOpen, filePath, originalContent, modifiedContent]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-patch-modal-title"
    >
      <div
        className="glass-panel"
        style={{
          width: '92vw',
          maxWidth: '1200px',
          height: '85vh',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#11131a',
          border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.1))',
          borderRadius: '12px',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.6)',
          overflow: 'hidden',
        }}
      >
        {/* Header Bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 20px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '6px',
                background: 'linear-gradient(135deg, #cba6f7 0%, #89b4fa 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#11111b',
                fontWeight: 700,
              }}
            >
              <IconCode size={16} />
            </div>

            <div>
              <h2
                id="ai-patch-modal-title"
                style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--fg-primary, #cdd6f4)' }}
              >
                Review AI Proposed Patch: <span style={{ color: '#89b4fa' }}>{filePath}</span>
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#6c7086', marginTop: '2px' }}>
                <span>Provider: <strong>{providerName}</strong></span>
                <span>•</span>
                <span style={{ color: '#a6e3a1' }}>+{linesAdded} lines</span>
                <span style={{ color: '#f38ba8' }}>-{linesRemoved} lines</span>
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="glass-btn icon-only"
            style={{ width: '28px', height: '28px' }}
            title="Reject and close"
          >
            ✕
          </button>
        </div>

        {/* Explanation Banner */}
        <div
          style={{
            padding: '10px 20px',
            backgroundColor: 'rgba(137, 180, 250, 0.05)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
            fontSize: '12px',
            color: '#cdd6f4',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}
        >
          <span style={{ color: '#89b4fa', fontWeight: 600 }}>Rationale:</span>
          <span>{explanation}</span>
        </div>

        {/* Monaco Diff Viewer */}
        <div
          ref={diffContainerRef}
          style={{
            flex: 1,
            width: '100%',
            minHeight: '200px',
            backgroundColor: '#11131a',
          }}
        />

        {/* Action Controls & Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 20px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          {/* Safety Options */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              cursor: 'pointer',
              fontSize: '12px',
              color: '#a6adc8',
            }}
          >
            <input
              type="checkbox"
              checked={createSnapshot}
              onChange={(e) => setCreateSnapshot(e.target.checked)}
              style={{ cursor: 'pointer', accentColor: '#89b4fa' }}
            />
            <span>Create Safety Snapshot before applying patch</span>
          </label>

          {/* Action Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              onClick={onClose}
              className="glass-btn"
              style={{
                padding: '6px 14px',
                fontSize: '12px',
                color: '#f38ba8',
                borderColor: 'rgba(243, 139, 168, 0.3)',
              }}
            >
              Reject Patch
            </button>

            <button
              type="button"
              onClick={() => onAccept({ runVerification: false, createSnapshot })}
              className="glass-btn"
              style={{
                padding: '6px 14px',
                fontSize: '12px',
                color: '#fab387',
                borderColor: 'rgba(250, 179, 135, 0.3)',
              }}
              title="Apply patch directly without running sandbox verification (marked as UNVERIFIED)"
            >
              Accept &amp; Skip Verification
            </button>

            <button
              type="button"
              onClick={() => onAccept({ runVerification: true, createSnapshot })}
              className="glass-btn glass-btn-primary"
              style={{
                padding: '6px 16px',
                fontSize: '12px',
                fontWeight: 600,
                background: 'linear-gradient(135deg, #a6e3a1 0%, #94e2d5 100%)',
                color: '#11111b',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              title="Apply patch and execute authoritative sandbox verification"
            >
              <IconCheck size={14} />
              <span>Accept &amp; Verify</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
