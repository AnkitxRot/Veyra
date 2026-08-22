import React, { useState, useEffect } from 'react';
import { api } from '../../api';
import { RunRecord } from '../../types';
import TimeSeriesChart from '../common/TimeSeriesChart';
import { IconClose } from '../common/Icons';

export interface ExecutionTelemetryModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  run: RunRecord | null;
}

export default function ExecutionTelemetryModal({
  isOpen,
  onClose,
  projectId,
  run,
}: ExecutionTelemetryModalProps) {
  const [telemetry, setTelemetry] = useState<{
    samples: any[];
    summary: any;
  } | null>(null);
  const [, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !run || !projectId) return;

    const fetchRunTelemetry = async () => {
      setLoading(true);
      try {
        const res = await api<{ samples: any[]; summary: any }>(
          `/api/projects/${projectId}/runs/${run.id}/telemetry`
        );
        setTelemetry(res);
      } catch {}
      finally {
        setLoading(false);
      }
    };

    fetchRunTelemetry();
  }, [isOpen, run, projectId]);

  if (!isOpen || !run) return null;

  const formatBytes = (bytes: number) => {
    if (!bytes) return '0 MB';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const cpuData = telemetry?.samples.map((s) => ({
    timestamp: s.createdAt,
    value: s.cpuPercent,
  })) || [];

  const memData = telemetry?.samples.map((s) => ({
    timestamp: s.createdAt,
    value: s.memoryUsageBytes / (1024 * 1024),
  })) || [];

  return (
    <div
      className="command-palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Execution Resource Inspector"
    >
      <div
        className="command-palette-card"
        style={{ width: '640px', maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div
          style={{
            padding: '12px 18px',
            borderBottom: '1px solid var(--glass-border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '13.5px', fontWeight: 600, color: 'var(--fg-primary)' }}>
              Execution #{run.id.slice(0, 8)} — Resource Profile
            </h3>
            <p style={{ margin: 0, fontSize: '11px', color: 'var(--fg-muted)' }}>
              {run.file_path} ({run.language}) • Duration: {run.duration_ms} ms • Exit: {run.exit_code ?? 0}
            </p>
          </div>

          <button className="glass-btn glass-btn-ghost" onClick={onClose} title="Close">
            <IconClose size={12} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '14px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Summary Pills Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '8px',
              padding: '10px',
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid var(--glass-border-subtle)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '11px',
              textAlign: 'center',
            }}
          >
            <div>
              <div style={{ color: 'var(--fg-muted)', fontSize: '10px' }}>Peak CPU</div>
              <div style={{ fontWeight: 700, color: '#89b4fa', fontSize: '12.5px', marginTop: '2px' }}>
                {telemetry?.summary.peakCpuPercent || 0}%
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--fg-muted)', fontSize: '10px' }}>Peak RAM</div>
              <div style={{ fontWeight: 700, color: '#a6e3a1', fontSize: '12.5px', marginTop: '2px' }}>
                {formatBytes(telemetry?.summary.peakMemoryBytes || run.peak_memory_bytes || 0)}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--fg-muted)', fontSize: '10px' }}>Peak PIDs</div>
              <div style={{ fontWeight: 700, color: '#fab387', fontSize: '12.5px', marginTop: '2px' }}>
                {telemetry?.summary.peakPids || 1} / 64
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--fg-muted)', fontSize: '10px' }}>Status</div>
              <div style={{ fontWeight: 700, color: run.exit_code === 0 ? '#a6e3a1' : '#f38ba8', fontSize: '12px', marginTop: '2px' }}>
                {run.status.toUpperCase()}
              </div>
            </div>
          </div>

          {/* Charts */}
          {cpuData.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <TimeSeriesChart
                title="Execution CPU Timeline"
                data={cpuData}
                color="#89b4fa"
                unit="%"
                maxValue={100}
                height={120}
              />
              <TimeSeriesChart
                title="Execution Memory Timeline"
                data={memData}
                color="#a6e3a1"
                unit="MB"
                maxValue={512}
                height={120}
              />
            </div>
          ) : (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '12px' }}>
              Execution completed in single-sampling window ({run.duration_ms}ms). Peak resource telemetry recorded in summary table above.
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 18px', borderTop: '1px solid var(--glass-border-subtle)', display: 'flex', justifyContent: 'flex-end' }}>
          <button className="glass-btn glass-btn-primary" onClick={onClose} style={{ fontSize: '11.5px', padding: '3px 12px' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
