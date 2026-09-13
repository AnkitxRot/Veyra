import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { AdminObservabilityData } from "../../types";
import {
  IconActivity,
  IconCpu,
  IconDatabase,
  IconRefresh,
  IconServer,
  IconAlertTriangle,
  IconLayers,
} from "../common/Icons";

const POLL_INTERVAL_MS = 5000;

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms === 0) return "0.00 ms";
  if (ms < 0.01) return "< 0.01 ms";
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  return `${ms.toFixed(1)} ms`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMicrosToSeconds(micros: number): string {
  return `${(micros / 1e6).toFixed(2)}s`;
}

export default function AdminObservabilityPanel() {
  const [data, setData] = useState<AdminObservabilityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [isHidden, setIsHidden] = useState(
    typeof document !== "undefined" ? document.hidden : false,
  );

  const inFlightRef = useRef(false);
  const isMountedRef = useRef(true);

  const fetchObservability = useCallback(async (isManual = false) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    if (isManual || !data) {
      setRefreshing(true);
    }

    try {
      const res = await api<AdminObservabilityData>("/api/admin/observability");
      if (isMountedRef.current) {
        setData(res);
        setLastUpdated(new Date());
        setSecondsAgo(0);
        setError(null);
        setRefreshError(null);
      }
    } catch (err: any) {
      if (isMountedRef.current) {
        if (!data) {
          setError(
            err?.message || "Failed to load platform observability telemetry",
          );
        } else {
          setRefreshError("Unable to refresh observability data");
        }
      }
    } finally {
      if (isMountedRef.current) {
        inFlightRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [data]);

  // Initial load
  useEffect(() => {
    isMountedRef.current = true;
    fetchObservability();

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Polling effect with visibility handling
  useEffect(() => {
    if (isHidden) return;

    const interval = setInterval(() => {
      if (!document.hidden && isMountedRef.current) {
        fetchObservability();
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [fetchObservability, isHidden]);

  // Visibility listener
  useEffect(() => {
    if (typeof document === "undefined") return;

    const handleVisibilityChange = () => {
      const hidden = document.hidden;
      setIsHidden(hidden);
      if (!hidden && isMountedRef.current) {
        fetchObservability();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchObservability]);

  // Seconds ago ticker
  useEffect(() => {
    if (!lastUpdated) return;

    const ticker = setInterval(() => {
      if (isMountedRef.current && lastUpdated) {
        const diff = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
        setSecondsAgo(Math.max(0, diff));
      }
    }, 1000);

    return () => clearInterval(ticker);
  }, [lastUpdated]);

  const handleManualRefresh = () => {
    fetchObservability(true);
  };

  if (loading && !data) {
    return (
      <div
        className="glass-card"
        style={{
          padding: "48px 24px",
          textAlign: "center",
          color: "var(--fg-muted)",
        }}
      >
        <IconRefresh
          size={24}
          className="spinning"
          style={{ margin: "0 auto 16px", color: "var(--accent)" }}
        />
        <div style={{ fontSize: "14px", fontWeight: 600 }}>
          Loading platform observability telemetry...
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div
        className="glass-card"
        style={{
          padding: "48px 24px",
          textAlign: "center",
          borderColor: "rgba(243, 139, 168, 0.3)",
        }}
      >
        <IconAlertTriangle
          size={28}
          style={{ margin: "0 auto 16px", color: "#f38ba8" }}
        />
        <div
          style={{
            fontSize: "15px",
            fontWeight: 600,
            color: "var(--fg-primary)",
            marginBottom: "8px",
          }}
        >
          Failed to load platform telemetry
        </div>
        <div
          style={{
            fontSize: "13px",
            color: "var(--fg-muted)",
            marginBottom: "20px",
          }}
        >
          {error}
        </div>
        <button
          className="glass-btn glass-btn-primary"
          onClick={() => fetchObservability(true)}
          style={{ margin: "0 auto" }}
        >
          <IconRefresh size={13} />
          <span>Retry</span>
        </button>
      </div>
    );
  }

  if (!data) return null;

  const dbOperationsList = Object.entries(data.dbCalls.byOperation).sort(
    ([, a], [, b]) => b.count - a.count,
  );

  const gcEntries = Object.entries(data.gc || {});

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Top Header & Refresh Control */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div>
          <h2
            style={{
              fontSize: "16px",
              fontWeight: 700,
              color: "var(--fg-primary)",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <IconActivity size={18} style={{ color: "var(--accent)" }} />
            <span>Platform Observability</span>
          </h2>
          <p
            style={{
              fontSize: "12px",
              color: "var(--fg-muted)",
              margin: "4px 0 0",
            }}
          >
            Real-time event loop latency, database query percentiles, and active
            system resource telemetry
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {/* Polling / Visibility Status Pill */}
          {isHidden ? (
            <span
              className="glass-badge glass-badge-warning"
              style={{ fontSize: "11px" }}
            >
              Updates paused while tab is hidden
            </span>
          ) : (
            <span
              className={`admin-live-capsule ${refreshing ? "reconnecting" : "connected"}`}
              style={{ fontSize: "11px" }}
            >
              <span className="admin-live-dot" />
              <span>{refreshing ? "REFRESHING..." : "LIVE (5.0s)"}</span>
            </span>
          )}

          {/* Last Updated Timestamp */}
          <span style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
            {secondsAgo === 0
              ? "Updated just now"
              : `Updated ${secondsAgo}s ago`}
          </span>

          <button
            className="glass-btn glass-btn-secondary"
            onClick={handleManualRefresh}
            disabled={refreshing || loading}
            aria-label="Refresh telemetry"
            title="Refresh telemetry"
            style={{ fontSize: "12px", padding: "6px 12px" }}
          >
            <IconRefresh size={12} className={refreshing ? "spinning" : ""} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Transient Refresh Error Warning */}
      {refreshError && (
        <div
          className="glass-card"
          style={{
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            background: "rgba(249, 226, 175, 0.08)",
            borderColor: "rgba(249, 226, 175, 0.25)",
            color: "#f9e2af",
            fontSize: "12px",
          }}
        >
          <IconAlertTriangle size={14} style={{ flexShrink: 0 }} />
          <span>
            {refreshError} — displaying last known good telemetry from{" "}
            {lastUpdated?.toLocaleTimeString()}.
          </span>
        </div>
      )}

      {/* Primary KPI Cards Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "14px",
        }}
      >
        {/* Event Loop Lag Card */}
        <div className="glass-card" style={{ padding: "16px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "8px",
            }}
          >
            <span
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--fg-muted)",
              }}
            >
              Event Loop Lag (p95)
            </span>
            <IconActivity size={14} style={{ color: "#89b4fa" }} />
          </div>
          <div
            style={{
              fontSize: "20px",
              fontWeight: 700,
              color: "var(--fg-primary)",
              marginBottom: "4px",
            }}
          >
            {data.eventLoopLagMs
              ? formatMs(data.eventLoopLagMs.p95Ms)
              : "Monitor inactive"}
          </div>
          <div style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
            {data.eventLoopLagMs ? (
              <>
                p50: {formatMs(data.eventLoopLagMs.p50Ms)} · max:{" "}
                {formatMs(data.eventLoopLagMs.maxMs)}
              </>
            ) : (
              "Event loop monitoring not initialized"
            )}
          </div>
        </div>

        {/* Database Latency Card */}
        <div className="glass-card" style={{ padding: "16px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "8px",
            }}
          >
            <span
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--fg-muted)",
              }}
            >
              DB Query Latency (p95)
            </span>
            <IconDatabase size={14} style={{ color: "#a6e3a1" }} />
          </div>
          <div
            style={{
              fontSize: "20px",
              fontWeight: 700,
              color: "var(--fg-primary)",
              marginBottom: "4px",
            }}
          >
            {formatMs(data.dbCalls.overall.p95Ms)}
          </div>
          <div style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
            p50: {formatMs(data.dbCalls.overall.p50Ms)} ·{" "}
            {data.dbCalls.overall.count.toLocaleString()} queries tracked
          </div>
        </div>

        {/* WebSockets & Collab Rooms Card */}
        <div className="glass-card" style={{ padding: "16px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "8px",
            }}
          >
            <span
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--fg-muted)",
              }}
            >
              Active WebSockets &amp; Rooms
            </span>
            <IconLayers size={14} style={{ color: "#cba6f7" }} />
          </div>
          <div
            style={{
              fontSize: "20px",
              fontWeight: 700,
              color: "var(--fg-primary)",
              marginBottom: "4px",
            }}
          >
            {data.activeWsConnections} WS / {data.activeCollabRooms} Rooms
          </div>
          <div style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
            {data.totalCollabBroadcastSends.toLocaleString()} broadcast sends
            (coalesced)
          </div>
        </div>

        {/* Sandboxes & Memory Card */}
        <div className="glass-card" style={{ padding: "16px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "8px",
            }}
          >
            <span
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--fg-muted)",
              }}
            >
              Active Sandboxes &amp; RSS
            </span>
            <IconServer size={14} style={{ color: "#fab387" }} />
          </div>
          <div
            style={{
              fontSize: "20px",
              fontWeight: 700,
              color: "var(--fg-primary)",
              marginBottom: "4px",
            }}
          >
            {data.activeSandboxes} Sandboxes
          </div>
          <div style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
            RSS: {formatBytes(data.memory.rssBytes)} · Heap:{" "}
            {formatBytes(data.memory.heapUsedBytes)}
          </div>
        </div>
      </div>

      {/* Two Column Layout: Runtime Diagnostics & System Memory */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: "16px",
        }}
      >
        {/* Runtime Diagnostics */}
        <div className="glass-card" style={{ padding: "18px" }}>
          <h3
            style={{
              fontSize: "13px",
              fontWeight: 700,
              color: "var(--fg-primary)",
              marginTop: 0,
              marginBottom: "14px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <IconActivity size={14} style={{ color: "var(--accent)" }} />
            <span>Event-Loop Latency Distribution</span>
          </h3>

          {data.eventLoopLagMs ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: "10px",
                marginBottom: "14px",
              }}
            >
              <div
                style={{
                  background: "rgba(0,0,0,0.2)",
                  padding: "10px",
                  borderRadius: "8px",
                }}
              >
                <div style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
                  Min
                </div>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>
                  {formatMs(data.eventLoopLagMs.minMs)}
                </div>
              </div>
              <div
                style={{
                  background: "rgba(0,0,0,0.2)",
                  padding: "10px",
                  borderRadius: "8px",
                }}
              >
                <div style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
                  Mean
                </div>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>
                  {formatMs(data.eventLoopLagMs.meanMs)}
                </div>
              </div>
              <div
                style={{
                  background: "rgba(0,0,0,0.2)",
                  padding: "10px",
                  borderRadius: "8px",
                }}
              >
                <div style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
                  p50 (Median)
                </div>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>
                  {formatMs(data.eventLoopLagMs.p50Ms)}
                </div>
              </div>
              <div
                style={{
                  background: "rgba(0,0,0,0.2)",
                  padding: "10px",
                  borderRadius: "8px",
                }}
              >
                <div style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
                  p95
                </div>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>
                  {formatMs(data.eventLoopLagMs.p95Ms)}
                </div>
              </div>
              <div
                style={{
                  background: "rgba(0,0,0,0.2)",
                  padding: "10px",
                  borderRadius: "8px",
                }}
              >
                <div style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
                  p99
                </div>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>
                  {formatMs(data.eventLoopLagMs.p99Ms)}
                </div>
              </div>
              <div
                style={{
                  background: "rgba(0,0,0,0.2)",
                  padding: "10px",
                  borderRadius: "8px",
                }}
              >
                <div style={{ fontSize: "11px", color: "var(--fg-muted)" }}>
                  Max
                </div>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>
                  {formatMs(data.eventLoopLagMs.maxMs)}
                </div>
              </div>
            </div>
          ) : (
            <div
              style={{
                fontSize: "12px",
                color: "var(--fg-muted)",
                marginBottom: "14px",
              }}
            >
              Event-loop monitor is currently inactive.
            </div>
          )}

          {/* Process CPU Breakdown */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
            <div
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--fg-muted)",
                marginBottom: "8px",
              }}
            >
              Cumulative Process CPU Time
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
              }}
            >
              <span>User Space:</span>
              <span style={{ fontWeight: 600 }}>
                {formatMicrosToSeconds(data.cpuUsageMicros.userMicros)}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
                marginTop: "4px",
              }}
            >
              <span>System / Kernel:</span>
              <span style={{ fontWeight: 600 }}>
                {formatMicrosToSeconds(data.cpuUsageMicros.systemMicros)}
              </span>
            </div>
          </div>
        </div>

        {/* Process Memory Breakdown & GC */}
        <div className="glass-card" style={{ padding: "18px" }}>
          <h3
            style={{
              fontSize: "13px",
              fontWeight: 700,
              color: "var(--fg-primary)",
              marginTop: 0,
              marginBottom: "14px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <IconCpu size={14} style={{ color: "var(--accent)" }} />
            <span>Process Memory &amp; Garbage Collection</span>
          </h3>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              marginBottom: "14px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
              }}
            >
              <span style={{ color: "var(--fg-muted)" }}>Resident Set Size (RSS):</span>
              <span style={{ fontWeight: 600 }}>
                {formatBytes(data.memory.rssBytes)}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
              }}
            >
              <span style={{ color: "var(--fg-muted)" }}>Heap Used / Total:</span>
              <span style={{ fontWeight: 600 }}>
                {formatBytes(data.memory.heapUsedBytes)} /{" "}
                {formatBytes(data.memory.heapTotalBytes)}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
              }}
            >
              <span style={{ color: "var(--fg-muted)" }}>External (Buffers/Native):</span>
              <span style={{ fontWeight: 600 }}>
                {formatBytes(data.memory.externalBytes)}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
              }}
            >
              <span style={{ color: "var(--fg-muted)" }}>ArrayBuffers:</span>
              <span style={{ fontWeight: 600 }}>
                {formatBytes(data.memory.arrayBuffersBytes)}
              </span>
            </div>
          </div>

          {/* GC Statistics Table */}
          {gcEntries.length > 0 && (
            <div
              style={{
                borderTop: "1px solid var(--border)",
                paddingTop: "12px",
              }}
            >
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "var(--fg-muted)",
                  marginBottom: "8px",
                }}
              >
                GC Activity by Kind
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                {gcEntries.map(([kind, stat]) => (
                  <div
                    key={kind}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "12px",
                    }}
                  >
                    <span style={{ textTransform: "capitalize" }}>{kind}:</span>
                    <span style={{ color: "var(--fg-muted)" }}>
                      {stat.count} collections · {stat.totalDurationMs.toFixed(1)} ms
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Database Latencies & Operations Table */}
      <div className="glass-card" style={{ padding: "18px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "10px",
            marginBottom: "14px",
          }}
        >
          <div>
            <h3
              style={{
                fontSize: "13px",
                fontWeight: 700,
                color: "var(--fg-primary)",
                margin: 0,
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <IconDatabase size={14} style={{ color: "#a6e3a1" }} />
              <span>Database Query Latency Breakdown</span>
            </h3>
            <div
              style={{
                fontSize: "11px",
                color: "var(--fg-muted)",
                marginTop: "2px",
              }}
            >
              Overall: {data.dbCalls.overall.count.toLocaleString()} calls · Mean:{" "}
              {formatMs(data.dbCalls.overall.meanMs)} · p50:{" "}
              {formatMs(data.dbCalls.overall.p50Ms)} · p95:{" "}
              {formatMs(data.dbCalls.overall.p95Ms)} · p99:{" "}
              {formatMs(data.dbCalls.overall.p99Ms)}
            </div>
          </div>
        </div>

        {dbOperationsList.length === 0 ? (
          <div
            style={{
              padding: "24px",
              textAlign: "center",
              color: "var(--fg-muted)",
              fontSize: "12px",
            }}
          >
            No individual database operation timing records observed yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              className="admin-table"
              style={{ width: "100%", fontSize: "12px" }}
            >
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>SQL Operation</th>
                  <th style={{ textAlign: "right" }}>Calls</th>
                  <th style={{ textAlign: "right" }}>Mean</th>
                  <th style={{ textAlign: "right" }}>p50 (Median)</th>
                  <th style={{ textAlign: "right" }}>p95</th>
                  <th style={{ textAlign: "right" }}>p99</th>
                  <th style={{ textAlign: "right" }}>Max</th>
                </tr>
              </thead>
              <tbody>
                {dbOperationsList.map(([opName, snapshot]) => (
                  <tr key={opName}>
                    <td style={{ fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                      {opName}
                    </td>
                    <td style={{ textAlign: "right", color: "var(--fg-muted)" }}>
                      {snapshot.count.toLocaleString()}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {formatMs(snapshot.meanMs)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {formatMs(snapshot.p50Ms)}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>
                      {formatMs(snapshot.p95Ms)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {formatMs(snapshot.p99Ms)}
                    </td>
                    <td style={{ textAlign: "right", color: "var(--fg-muted)" }}>
                      {formatMs(snapshot.maxMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
