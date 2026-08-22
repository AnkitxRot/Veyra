import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import { Project } from '../../types';
import {
  IconCheck,
  IconAlertTriangle,
  IconClose,
  IconRefresh,
} from '../common/Icons';

export interface ProjectHealthStatus {
  status: 'healthy' | 'warning' | 'critical';
  score: number;
  summary: string;
  runtime: {
    sandboxRunning: boolean;
    currentCpuPercent: number;
    currentMemoryBytes: number;
    currentPids: number;
  };
  usage: {
    executionsToday: number;
    totalDurationMsToday: number;
    snapshotCount: number;
  };
  anomalies: Array<{
    id: string;
    anomalyType: string;
    severity: 'warning' | 'critical';
    title: string;
    reason: string;
    details: string;
    createdAt: string;
  }>;
  failureRatePercent: number;
}

export interface ProjectHealthModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: Project | null;
}

export default function ProjectHealthModal({
  isOpen,
  onClose,
  project,
}: ProjectHealthModalProps) {
  const [health, setHealth] = useState<ProjectHealthStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchHealth = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const res = await api<{ health: ProjectHealthStatus }>(`/api/projects/${project.id}/health`);
      setHealth(res.health);
    } catch {}
    finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    if (isOpen && project) {
      fetchHealth();
    }
  }, [isOpen, project, fetchHealth]);

  if (!isOpen) return null;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getStatusColor = (s?: string) => {
    if (s === 'critical') return '#f38ba8';
    if (s === 'warning') return '#f9e2af';
    return '#a6e3a1';
  };

  return (
    <div
      className="command-palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Project Health Center"
    >
      <div
        className="command-palette-card"
        style={{ width: '680px', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--glass-border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: health?.status === 'critical' ? 'rgba(243,139,168,0.15)' : 'rgba(166,227,161,0.15)',
                color: getStatusColor(health?.status),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {health?.status === 'critical' || health?.status === 'warning' ? (
                <IconAlertTriangle size={18} />
              ) : (
                <IconCheck size={18} />
              )}
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--fg-primary)' }}>
                Project Health Center: {project?.name}
              </h3>
              <p style={{ margin: 0, fontSize: '11px', color: 'var(--fg-muted)' }}>
                Explainable runtime and resource integrity analysis
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button className="glass-btn glass-btn-ghost" onClick={fetchHealth} title="Refresh Health Diagnostics">
              <IconRefresh size={12} className={loading ? 'spinning' : ''} />
            </button>
            <button className="glass-btn glass-btn-ghost" onClick={onClose} title="Close">
              <IconClose size={12} />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div style={{ padding: '16px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Status Summary Banner */}
          <div
            style={{
              padding: '12px 16px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(255,255,255,0.02)',
              border: `1px solid ${getStatusColor(health?.status)}44`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span
                  style={{
                    textTransform: 'uppercase',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: getStatusColor(health?.status),
                    letterSpacing: '0.5px',
                  }}
                >
                  {health?.status || 'HEALTHY'}
                </span>
                <span style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>•</span>
                <span style={{ fontSize: '12px', color: 'var(--fg-secondary)' }}>
                  Health Score: <strong>{health?.score ?? 100}/100</strong>
                </span>
              </div>
              <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--fg-primary)' }}>
                {health?.summary || 'All systems operational within standard bounds.'}
              </p>
            </div>
          </div>

          {/* Runtime & Daily Usage Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            {/* Runtime State */}
            <div
              style={{
                padding: '12px',
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--glass-border-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--fg-primary)', marginBottom: '8px' }}>
                Runtime State
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11.5px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fg-muted)' }}>Sandbox Status</span>
                  <span style={{ color: health?.runtime.sandboxRunning ? '#a6e3a1' : 'var(--fg-muted)' }}>
                    {health?.runtime.sandboxRunning ? 'Active Container' : 'Idle (Standby)'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fg-muted)' }}>Live CPU</span>
                  <span>{health?.runtime.currentCpuPercent.toFixed(1)}%</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fg-muted)' }}>Live Memory</span>
                  <span>{formatBytes(health?.runtime.currentMemoryBytes || 0)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fg-muted)' }}>Active PIDs</span>
                  <span>{health?.runtime.currentPids || 0} / 64</span>
                </div>
              </div>
            </div>

            {/* Daily Usage */}
            <div
              style={{
                padding: '12px',
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--glass-border-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--fg-primary)', marginBottom: '8px' }}>
                Daily Activity & Reliability
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11.5px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fg-muted)' }}>Executions (24h)</span>
                  <span>{health?.usage.executionsToday || 0}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fg-muted)' }}>Total Runtime</span>
                  <span>{((health?.usage.totalDurationMsToday || 0) / 1000).toFixed(1)}s</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fg-muted)' }}>Failure Rate</span>
                  <span style={{ color: (health?.failureRatePercent || 0) > 20 ? '#f38ba8' : '#a6e3a1' }}>
                    {health?.failureRatePercent || 0}%
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fg-muted)' }}>Snapshots</span>
                  <span>{health?.usage.snapshotCount || 0}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Active Anomalies List */}
          <div>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg-primary)', marginBottom: '6px' }}>
              Anomaly Journal
            </div>

            {health?.anomalies && health.anomalies.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {health.anomalies.map((anom) => (
                  <div
                    key={anom.id}
                    style={{
                      padding: '8px 12px',
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(243,139,168,0.2)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '11.5px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 600, color: anom.severity === 'critical' ? '#f38ba8' : '#f9e2af' }}>
                        {anom.title}
                      </span>
                      <span style={{ fontSize: '10px', color: 'var(--fg-muted)' }}>
                        {new Date(anom.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <div style={{ color: 'var(--fg-secondary)', marginTop: '2px' }}>{anom.reason}</div>
                    <div style={{ color: 'var(--fg-muted)', fontSize: '10.5px', marginTop: '2px' }}>{anom.details}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                style={{
                  padding: '16px',
                  textAlign: 'center',
                  background: 'rgba(255,255,255,0.01)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--fg-muted)',
                  fontSize: '12px',
                }}
              >
                No active resource anomalies recorded.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 18px',
            borderTop: '1px solid var(--glass-border-subtle)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button className="glass-btn glass-btn-primary" onClick={onClose} style={{ fontSize: '12px', padding: '4px 14px' }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
