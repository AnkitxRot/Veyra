import React from 'react';
import { IconCheck, IconAlertTriangle, IconActivity } from '../common/Icons';

export type AIVerificationStatus = 'VERIFIED' | 'FAILED' | 'UNVERIFIED';

export interface AIVerificationCardProps {
  status: AIVerificationStatus;
  action: string;
  filePath: string;
  explanation: string;
  exitCode?: number | null;
  stdoutSummary?: string;
  stderrSummary?: string;
  skipReason?: string;
  durationMs?: number;
  providerType?: string;
  onDismiss?: () => void;
  onViewDiff?: () => void;
}

export default function AIVerificationCard({
  status,
  action,
  filePath,
  explanation,
  exitCode,
  stdoutSummary,
  stderrSummary,
  skipReason,
  durationMs = 0,
  providerType = 'deterministic',
  onDismiss,
  onViewDiff,
}: AIVerificationCardProps) {
  const isVerified = status === 'VERIFIED';
  const isFailed = status === 'FAILED';
  const isUnverified = status === 'UNVERIFIED';

  const badgeColor = isVerified ? '#a6e3a1' : isFailed ? '#f38ba8' : '#fab387';
  const badgeBg = isVerified
    ? 'rgba(166, 227, 161, 0.15)'
    : isFailed
    ? 'rgba(243, 139, 168, 0.15)'
    : 'rgba(250, 179, 135, 0.15)';
  const badgeBorder = isVerified
    ? 'rgba(166, 227, 161, 0.35)'
    : isFailed
    ? 'rgba(243, 139, 168, 0.35)'
    : 'rgba(250, 179, 135, 0.35)';

  return (
    <div
      className="glass-panel"
      style={{
        padding: '12px 16px',
        backgroundColor: '#161922',
        border: `1px solid ${badgeBorder}`,
        borderRadius: '8px',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        fontSize: '12px',
        animation: 'slideUp 180ms ease',
      }}
      role="region"
      aria-label="AI Patch Verification Result"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '12px',
              background: badgeBg,
              border: `1px solid ${badgeBorder}`,
              color: badgeColor,
              fontWeight: 700,
              fontSize: '11px',
              letterSpacing: '0.5px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            {isVerified && <IconCheck size={11} />}
            {isFailed && <span style={{ fontWeight: 800 }}>✕</span>}
            {isUnverified && <IconAlertTriangle size={11} />}
            <span>STATUS: {status}</span>
          </span>

          <span style={{ color: '#a6adc8', fontSize: '11px' }}>
            {filePath} • {durationMs}ms
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span
            style={{
              fontSize: '10px',
              padding: '1px 6px',
              borderRadius: '4px',
              background: 'rgba(255, 255, 255, 0.05)',
              color: '#6c7086',
            }}
          >
            {providerType === 'deterministic' ? 'Rule Engine' : 'LLM Model'}
          </span>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="glass-btn icon-only"
              style={{ width: '20px', height: '20px', fontSize: '10px' }}
              title="Dismiss verification card"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div style={{ color: '#cdd6f4', lineHeight: 1.4 }}>
        <strong>{explanation}</strong>
      </div>

      {isUnverified && skipReason && (
        <div
          style={{
            padding: '6px 10px',
            borderRadius: '4px',
            background: 'rgba(250, 179, 135, 0.1)',
            border: '1px solid rgba(250, 179, 135, 0.25)',
            color: '#fab387',
            fontSize: '11px',
          }}
        >
          ℹ️ {skipReason}
        </div>
      )}

      {isFailed && stderrSummary && (
        <div
          style={{
            padding: '6px 10px',
            borderRadius: '4px',
            background: 'rgba(243, 139, 168, 0.1)',
            border: '1px solid rgba(243, 139, 168, 0.25)',
            color: '#f38ba8',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            maxHeight: '80px',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {stderrSummary}
        </div>
      )}

      {isVerified && stdoutSummary && (
        <div
          style={{
            padding: '4px 8px',
            borderRadius: '4px',
            background: 'rgba(166, 227, 161, 0.08)',
            color: '#a6e3a1',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            whiteSpace: 'pre-wrap',
            maxHeight: '60px',
            overflowY: 'auto',
          }}
        >
          ✓ Checks passed ({exitCode !== null ? `exit code ${exitCode}` : 'success'})
        </div>
      )}
    </div>
  );
}
