import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import TimeSeriesChart from '../common/TimeSeriesChart';
import {
  IconCpu,
  IconHardDrive,
  IconServer,
  IconRefresh,
  IconAlertTriangle,
  IconLayers,
} from '../common/Icons';

export interface HistoricalTimelinePoint {
  timestamp: string;
  avgCpuPercent: number;
  peakCpuPercent: number;
  totalMemoryBytes: number;
  activeSandboxes: number;
  activePids: number;
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

export default function AdminResourceAnalytics() {
  const [range, setRange] = useState<'5m' | '15m' | '1h' | '24h'>('15m');
  const [timeline, setTimeline] = useState<HistoricalTimelinePoint[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchAnalytics = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api<{
        timeline: HistoricalTimelinePoint[];
        anomalies: AnomalyRecord[];
      }>(`/api/admin/telemetry/historical?range=${range}`);
      setTimeline(res.timeline || []);
      setAnomalies(res.anomalies || []);
    } catch {}
    finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    fetchAnalytics();
    if (!autoRefresh) return;
    const interval = setInterval(fetchAnalytics, 3000);
    return () => clearInterval(interval);
  }, [fetchAnalytics, autoRefresh]);

  const cpuData = timeline.map((p) => ({
    timestamp: p.timestamp,
    value: p.avgCpuPercent,
  }));

  const memData = timeline.map((p) => ({
    timestamp: p.timestamp,
    value: p.totalMemoryBytes / (1024 * 1024), // MB
  }));

  const sandboxData = timeline.map((p) => ({
    timestamp: p.timestamp,
    value: p.activeSandboxes,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Top Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h2 style={{ fontSize: '15px', fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <IconCpu size={16} color="#89b4fa" />
            <span>Platform Resource Analytics & Historian</span>
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--fg-muted)' }}>
            Historical aggregate telemetry and anomaly detection across all tenant sandboxes
          </p>
        </div>

        {/* Range Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {(['5m', '15m', '1h', '24h'] as const).map((r) => (
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
            title="Toggle Real-Time Auto-Refresh"
            style={{ fontSize: '11px', padding: '3px 8px' }}
          >
            <IconRefresh size={11} className={autoRefresh ? 'spinning' : ''} />
          </button>
        </div>
      </div>

      {/* Historical Time-Series Charts Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '14px' }}>
        {/* Aggregate CPU */}
        <TimeSeriesChart
          title="Aggregate Host / Sandbox CPU"
          data={cpuData}
          color="#89b4fa"
          unit="%"
          maxValue={100}
          height={160}
        />

        {/* Aggregate Memory */}
        <TimeSeriesChart
          title="Total Memory Allocated Across Sandboxes"
          data={memData}
          color="#a6e3a1"
          unit="MB"
          height={160}
          valueFormatter={(v) => `${v.toFixed(1)} MB`}
        />

        {/* Active Sandbox Count */}
        <TimeSeriesChart
          title="Active Sandbox Pool Concurrency"
          data={sandboxData}
          color="#fab387"
          unit="Containers"
          height={160}
          valueFormatter={(v) => `${Math.round(v)} sandboxes`}
        />
      </div>

      {/* Cross-Project Platform Anomaly Feed */}
      <div className="admin-table-wrap" style={{ marginTop: '10px' }}>
        <div className="admin-table-toolbar">
          <h3 style={{ fontSize: '13.5px', fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <IconAlertTriangle size={15} color="#f38ba8" />
            <span>Platform Anomaly Journal ({anomalies.length})</span>
          </h3>
          <span style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>
            Real-time rule-evaluated resource anomalies across all active projects
          </span>
        </div>

        <div className="admin-table-scroll">
          {anomalies.length === 0 ? (
            <div style={{ padding: '30px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '13px' }}>
              No resource anomalies detected across the platform. All tenant workloads are operating within defined limits.
            </div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Severity</th>
                  <th>Anomaly Type</th>
                  <th>Project ID</th>
                  <th>Reason & Remediation</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.map((anom) => (
                  <tr key={anom.id}>
                    <td style={{ color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
                      {new Date(anom.createdAt).toLocaleTimeString()}
                    </td>
                    <td>
                      <span
                        className={`glass-badge ${
                          anom.severity === 'critical' ? 'glass-badge-error' : 'glass-badge-warning'
                        }`}
                      >
                        {anom.severity.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600, color: 'var(--fg-primary)' }}>{anom.title}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: '#89b4fa' }}>
                      {anom.projectId.slice(0, 8)}
                    </td>
                    <td>
                      <div style={{ color: 'var(--fg-secondary)' }}>{anom.reason}</div>
                      <div style={{ color: 'var(--fg-muted)', fontSize: '11px', marginTop: '2px' }}>
                        {anom.details}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
