import React from 'react';
import { IconCode, IconActivity } from '../common/Icons';

export interface AIExplainModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProposeFix?: () => void;
  title: string;
  providerName?: string;
  providerType?: string;
  rootCause?: string;
  explanation: string;
  evidence?: string[];
  suggestedTests?: string;
  hasPatch?: boolean;
}

export default function AIExplainModal({
  isOpen,
  onClose,
  onProposeFix,
  title,
  providerName = 'Deterministic Rule & Static Analysis Engine',
  providerType = 'deterministic',
  rootCause,
  explanation,
  evidence = [],
  suggestedTests,
  hasPatch: _hasPatch = false,
}: AIExplainModalProps) {
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
      aria-labelledby="ai-explain-modal-title"
    >
      <div
        className="glass-panel"
        style={{
          width: '90vw',
          maxWidth: '700px',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#11131a',
          border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.1))',
          borderRadius: '12px',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.6)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 20px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '26px',
                height: '26px',
                borderRadius: '6px',
                background: 'linear-gradient(135deg, #89b4fa 0%, #a6e3a1 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#11111b',
              }}
            >
              <IconActivity size={14} />
            </div>
            <div>
              <h2
                id="ai-explain-modal-title"
                style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#cdd6f4' }}
              >
                {title}
              </h2>
              <div style={{ fontSize: '11px', color: '#6c7086', marginTop: '2px' }}>
                Provider: <strong>{providerName}</strong> ({providerType})
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="glass-btn glass-btn-icon"
            style={{ width: '28px', height: '28px' }}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            fontSize: '13px',
            color: '#cdd6f4',
          }}
        >
          {rootCause && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: '8px',
                backgroundColor: 'rgba(243, 139, 168, 0.08)',
                border: '1px solid rgba(243, 139, 168, 0.25)',
              }}
            >
              <div style={{ color: '#f38ba8', fontWeight: 700, fontSize: '12px', marginBottom: '4px' }}>
                Root Cause Analysis
              </div>
              <div style={{ color: '#cdd6f4', lineHeight: 1.4 }}>{rootCause}</div>
            </div>
          )}

          <div>
            <div style={{ fontWeight: 600, color: '#89b4fa', marginBottom: '6px' }}>
              Explanation &amp; Architecture Insights
            </div>
            <div style={{ lineHeight: 1.5, whiteSpace: 'pre-wrap', color: '#a6adc8' }}>
              {explanation}
            </div>
          </div>

          {evidence.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, color: '#fab387', marginBottom: '6px' }}>
                Observed Evidence &amp; Context
              </div>
              <ul style={{ margin: 0, paddingLeft: '20px', color: '#a6adc8', fontSize: '12px' }}>
                {evidence.map((ev, idx) => (
                  <li key={idx} style={{ marginBottom: '3px' }}>{ev}</li>
                ))}
              </ul>
            </div>
          )}

          {suggestedTests && (
            <div>
              <div style={{ fontWeight: 600, color: '#a6e3a1', marginBottom: '6px' }}>
                Suggested Test Suite
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: '10px',
                  borderRadius: '6px',
                  backgroundColor: 'rgba(0, 0, 0, 0.4)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12px',
                  overflowX: 'auto',
                  color: '#94e2d5',
                }}
              >
                {suggestedTests}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: '10px',
            padding: '12px 20px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <button type="button" onClick={onClose} className="glass-btn" style={{ padding: '6px 14px', fontSize: '12px' }}>
            Close
          </button>

          {onProposeFix && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onProposeFix();
              }}
              className="glass-btn glass-btn-primary"
              style={{
                padding: '6px 16px',
                fontSize: '12px',
                fontWeight: 600,
                background: 'linear-gradient(135deg, #cba6f7 0%, #89b4fa 100%)',
                color: '#11111b',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <IconCode size={14} />
              <span>Propose Fix</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
