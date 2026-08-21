import React, { useState } from 'react';
import { Diagnostic, groupDiagnosticsByFile } from '../../utils/diagnostics';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconCheck,
  IconCode,
  IconTrash,
} from '../common/Icons';

export interface ProblemsPanelProps {
  diagnostics: Diagnostic[];
  onSelectDiagnostic: (filePath: string, line: number, column?: number) => void;
  onClearDiagnostics: () => void;
  onExplainDiagnostic?: (diag: Diagnostic) => void;
  onFixDiagnostic?: (diag: Diagnostic) => void;
}

export default function ProblemsPanel({
  diagnostics,
  onSelectDiagnostic,
  onClearDiagnostics,
  onExplainDiagnostic,
  onFixDiagnostic,
}: ProblemsPanelProps) {
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const groups = groupDiagnosticsByFile(diagnostics);

  let totalErrors = 0;
  let totalWarnings = 0;
  let totalInfo = 0;

  for (const d of diagnostics) {
    if (d.severity === 'error') totalErrors++;
    else if (d.severity === 'warning') totalWarnings++;
    else totalInfo++;
  }

  const toggleFile = (filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  return (
    <div
      className="problems-panel-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'rgba(10, 12, 18, 0.7)',
        overflow: 'hidden',
      }}
    >
      {/* Header Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--glass-border-subtle)',
          background: 'rgba(255, 255, 255, 0.02)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
          <span style={{ fontWeight: 600, color: 'var(--fg-primary)' }}>Problems</span>
          <div style={{ display: 'flex', gap: '6px' }}>
            <span
              className="glass-badge glass-badge-error"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}
            >
              <span>✕</span> {totalErrors}
            </span>
            <span
              className="glass-badge glass-badge-warning"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}
            >
              <IconAlertTriangle size={10} /> {totalWarnings}
            </span>
            {totalInfo > 0 && (
              <span className="glass-badge glass-badge-info" style={{ fontSize: '11px' }}>
                ℹ {totalInfo}
              </span>
            )}
          </div>
        </div>

        {diagnostics.length > 0 && (
          <button
            type="button"
            className="glass-btn icon-only"
            onClick={onClearDiagnostics}
            title="Clear all problems"
            style={{ width: '24px', height: '24px' }}
          >
            <IconTrash size={12} />
          </button>
        )}
      </div>

      {/* Problems List */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        {diagnostics.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: '8px',
              color: 'var(--fg-muted)',
              fontSize: '12px',
            }}
          >
            <IconCheck size={20} color="#a6e3a1" />
            <span>No problems detected in the workspace.</span>
          </div>
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsedFiles.has(group.filePath);

            return (
              <div
                key={group.filePath}
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--glass-border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                }}
              >
                {/* File Group Header */}
                <button
                  type="button"
                  onClick={() => toggleFile(group.filePath)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 10px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: 'none',
                    color: 'var(--fg-primary)',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {isCollapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                    <IconCode size={13} color="var(--accent)" />
                    <span>{group.filePath}</span>
                  </div>

                  <span className="glass-badge glass-badge-info" style={{ fontSize: '10px', padding: '1px 5px' }}>
                    {group.diagnostics.length}
                  </span>
                </button>

                {/* Diagnostics Rows */}
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {group.diagnostics.map((diag) => (
                      <div
                        key={diag.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '6px 12px 6px 28px',
                          borderTop: '1px solid rgba(255, 255, 255, 0.04)',
                          gap: '8px',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => onSelectDiagnostic(diag.filePath, diag.line, diag.column)}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '8px',
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--fg-secondary)',
                            fontSize: '12px',
                            cursor: 'pointer',
                            textAlign: 'left',
                            flex: 1,
                            minWidth: 0,
                            padding: 0,
                          }}
                          title={`Click to jump to ${diag.filePath}:${diag.line}:${diag.column || 1}`}
                        >
                          <div style={{ marginTop: '2px', flexShrink: 0 }}>
                            {diag.severity === 'error' ? (
                              <span style={{ color: '#f38ba8', fontWeight: 700, fontSize: '12px' }}>✕</span>
                            ) : (
                              <IconAlertTriangle size={12} color="#f9e2af" />
                            )}
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
                            <span style={{ color: 'var(--fg-primary)', wordBreak: 'break-word' }}>
                              {diag.message}
                            </span>
                            <span style={{ fontSize: '11px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
                              [{diag.source.toUpperCase()}] Line {diag.line}
                              {diag.column ? `, Col ${diag.column}` : ''}
                              {diag.code ? ` (${diag.code})` : ''}
                            </span>
                          </div>
                        </button>

                        {/* AI Quick Actions */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                          {onExplainDiagnostic && (
                            <button
                              type="button"
                              onClick={() => onExplainDiagnostic(diag)}
                              className="glass-btn"
                              style={{
                                padding: '2px 6px',
                                fontSize: '10px',
                                color: '#89b4fa',
                                borderColor: 'rgba(137, 180, 250, 0.3)',
                              }}
                              title="Explain root cause with AI"
                            >
                              Explain
                            </button>
                          )}
                          {onFixDiagnostic && (
                            <button
                              type="button"
                              onClick={() => onFixDiagnostic(diag)}
                              className="glass-btn"
                              style={{
                                padding: '2px 6px',
                                fontSize: '10px',
                                color: '#a6e3a1',
                                borderColor: 'rgba(166, 227, 161, 0.3)',
                                fontWeight: 600,
                              }}
                              title="Propose AI fix"
                            >
                              Fix
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
