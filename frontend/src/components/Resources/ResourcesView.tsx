import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import { Project } from '../../types';
import TimeSeriesChart from '../common/TimeSeriesChart';
import {
  IconRefresh,
  IconAlertTriangle,
  IconDownload,
} from '../common/Icons';

export interface TelemetrySample {
  id?: number;
  projectId: string;
  sandboxId: string;
  executionId?: string | null;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  pids: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  createdAt: string;
}

export interface TelemetrySummary {
  avgCpuPercent: number;
  peakCpuPercent: number;
  avgMemoryBytes: number;
  peakMemoryBytes: number;
  memoryLimitBytes: number;
  peakPids: number;
  totalNetworkRxBytes: number;
  totalNetworkTxBytes: number;
  totalBlockReadBytes: number;
  totalBlockWriteBytes: number;
  sampleCount: number;
}

export interface AnomalyRecord {
  id: string;
  projectId: string;
  sandboxId?: string | null;
  executionId?: string | null;
  anomalyType: string;
  severity: 'warning' | 'critical';
  title: string;
  reason: string;
  details: string;
  status: 'active' | 'resolved';
  createdAt: string;
}

export interface ResourcesViewProps {
  project: Project | null;
}

export default function ResourcesView({ project }: ResourcesViewProps) {
  const [range, setRange] = useState<'30s' | '5m' | '15m' | '1h' | 'all'>('5m');
  const [telemetry, setTelemetry] = useState<{
    samples: TelemetrySample[];
    summary: TelemetrySummary;
  } | null>(null);
  const [anomalies, setAnomalies] = useState<AnomalyRecord[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showTableFallback, setShowTableFallback] = useState(false);

  const fetchTelemetry = useCallback(async () => {
    if (!project) return;
    try {
      const [res, anomRes] = await Promise.all([
        api<{ samples: TelemetrySample[]; summary: TelemetrySummary }>(
          `/api/projects/${project.id}/telemetry?range=${range}`
        ),
        api<{ anomalies: AnomalyRecord[] }>(`/api/projects/${project.id}/anomalies`),
      ]);
      setTelemetry(res);
      setAnomalies(anomRes.anomalies || []);
    } catch {}
  }, [project, range]);

  useEffect(() => {
    fetchTelemetry();
    if (!autoRefresh) return;
    const interval = setInterval(fetchTelemetry, 2500);
    return () => clearInterval(interval);
  }, [fetchTelemetry, autoRefresh]);

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const cpuData = telemetry?.samples.map((s) => ({
    timestamp: s.createdAt,
    value: s.cpuPercent,
  })) || [];

  const memData = telemetry?.samples.map((s) => ({
    timestamp: s.createdAt,
    value: s.memoryUsageBytes / (1024 * 1024), // MB
  })) || [];

  const pidData = telemetry?.samples.map((s) => ({
    timestamp: s.createdAt,
    value: s.pids,
  })) || [];

  const handleExportJson = () => {
    if (!telemetry) return;
    const blob = new Blob([JSON.stringify(telemetry, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `telemetry-${project?.name || 'project'}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'rgba(10, 12, 18, 0.7)',
        overflowY: 'auto',
        padding: '14px 18px',
        gap: '14px',
      }}
    >
      {/* Top Header & Range Controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--fg-primary)' }}>
            Resource Intelligence
          </span>
          <span className="glass-badge glass-badge-info" style={{ fontSize: '10px' }}>
            {telemetry?.summary.sampleCount || 0} Samples
          </span>
          {autoRefresh && (
            <span className="glass-badge glass-badge-success" style={{ fontSize: '10px' }}>
              Live 2s Sync
            </span>
          )}
        </div>

        {/* Range Buttons & Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {(['30s', '5m', '15m', '1h', 'all'] as const).map((r) => (
            <button
              key={r}
              className={`glass-btn ${range === r ? 'glass-btn-primary' : 'glass-btn-ghost'}`}
              onClick={() => setRange(r)}
              style={{ fontSize: '11px', padding: '3px 8px' }}
            >
              {r.toUpperCase()}
            </button>
          ))}

          <button
            className={`glass-btn ${autoRefresh ? 'glass-btn-primary' : 'glass-btn-ghost'}`}
            onClick={() => setAutoRefresh(!autoRefresh)}
            title="Toggle Live Real-Time Auto-Refresh"
            style={{ fontSize: '11px', padding: '3px 8px' }}
          >
            <IconRefresh size={11} className={autoRefresh ? 'spinning' : ''} />
          </button>

          <button
            className="glass-btn glass-btn-ghost"
            onClick={() => setShowTableFallback(!showTableFallback)}
            title="Toggle Accessible Tabular View"
            style={{ fontSize: '11px', padding: '3px 8px' }}
          >
            Tables
          </button>

          <button
            className="glass-btn glass-btn-ghost"
            onClick={handleExportJson}
            title="Export Telemetry JSON"
            style={{ fontSize: '11px', padding: '3px 8px' }}
          >
            <IconDownload size={11} />
          </button>
        </div>
      </div>

      {/* Active Anomalies Alerts Banner */}
      {anomalies.filter((a) => a.status === 'active').length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            background: 'rgba(243, 139, 168, 0.08)',
            border: '1px solid rgba(243, 139, 168, 0.3)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#f38ba8', fontWeight: 600, fontSize: '12px' }}>
            <IconAlertTriangle size={14} />
            <span>Active Resource Anomalies ({anomalies.filter((a) => a.status === 'active').length})</span>
          </div>

          {anomalies
            .filter((a) => a.status === 'active')
            .map((anom) => (
              <div
                key={anom.id}
                style={{
                  fontSize: '11.5px',
                  color: 'var(--fg-secondary)',
                  padding: '4px 0',
                  borderTop: '1px solid rgba(243, 139, 168, 0.15)',
                }}
              >
                <div style={{ fontWeight: 600, color: 'var(--fg-primary)' }}>{anom.title}</div>
                <div style={{ color: 'var(--fg-secondary)' }}>{anom.reason}</div>
                <div style={{ color: 'var(--fg-muted)', fontSize: '10.5px', marginTop: '2px' }}>{anom.details}</div>
              </div>
            ))}
        </div>
      )}

      {/* Grid of Time-Series Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px' }}>
        {/* CPU Chart */}
        <TimeSeriesChart
          title="CPU Utilization"
          data={cpuData}
          color="#89b4fa"
          unit="%"
          maxValue={100}
          height={150}
          showTableFallback={showTableFallback}
        />

        {/* Memory Chart */}
        <TimeSeriesChart
          title="Memory Consumption"
          data={memData}
          color="#a6e3a1"
          unit="MB"
          maxValue={512}
          height={150}
          showTableFallback={showTableFallback}
          valueFormatter={(v) => `${v.toFixed(1)} MB`}
        />

        {/* Processes / PIDs Chart */}
        <TimeSeriesChart
          title="Process Count (PIDs)"
          data={pidData}
          color="#fab387"
          unit="PIDs"
          maxValue={64}
          height={150}
          showTableFallback={showTableFallback}
        />

        {/* Network & Block I/O Metrics Card */}
        <div
          className="glass-card"
          style={{
            padding: '12px 16px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--glass-border-subtle)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <span style={{ fontWeight: 600, fontSize: '12px', color: 'var(--fg-primary)' }}>
            I/O Throughput Totals
          </span>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', margin: '8px 0' }}>
            <div style={{ padding: '8px', background: 'rgba(0,0,0,0.2)', borderRadius: '6px' }}>
              <div style={{ fontSize: '10.5px', color: 'var(--fg-muted)' }}>Network RX / TX</div>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg-primary)', marginTop: '2px' }}>
                {formatBytes(telemetry?.summary.totalNetworkRxBytes || 0)} / {formatBytes(telemetry?.summary.totalNetworkTxBytes || 0)}
              </div>
            </div>

            <div style={{ padding: '8px', background: 'rgba(0,0,0,0.2)', borderRadius: '6px' }}>
              <div style={{ fontSize: '10.5px', color: 'var(--fg-muted)' }}>Disk Read / Write</div>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg-primary)', marginTop: '2px' }}>
                {formatBytes(telemetry?.summary.totalBlockReadBytes || 0)} / {formatBytes(telemetry?.summary.totalBlockWriteBytes || 0)}
              </div>
            </div>
          </div>

          <div style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>
            Peak CPU: <strong>{telemetry?.summary.peakCpuPercent || 0}%</strong> | Peak Mem: <strong>{formatBytes(telemetry?.summary.peakMemoryBytes || 0)}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
