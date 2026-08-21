import React, { useState } from 'react';

export interface TimeSeriesPoint {
  timestamp: string | number;
  value: number;
}

export interface TimeSeriesChartProps {
  title: string;
  data: TimeSeriesPoint[];
  color?: string;
  unit?: string;
  maxValue?: number;
  height?: number;
  showTableFallback?: boolean;
  valueFormatter?: (val: number) => string;
}

export default function TimeSeriesChart({
  title,
  data,
  color = '#89b4fa',
  unit = '',
  maxValue,
  height = 140,
  showTableFallback = false,
  valueFormatter,
}: TimeSeriesChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const formatVal = (v: number) => {
    if (valueFormatter) return valueFormatter(v);
    if (unit === '%') return `${v.toFixed(1)}%`;
    if (unit === 'MB') return `${v.toFixed(1)} MB`;
    if (unit === 'PIDs') return `${Math.round(v)} PIDs`;
    return `${v.toLocaleString()} ${unit}`.trim();
  };

  if (!data || data.length === 0) {
    return (
      <div
        className="glass-card"
        style={{
          padding: '14px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: `${height}px`,
          color: 'var(--fg-muted)',
          fontSize: '12px',
        }}
      >
        <span>No telemetry samples recorded yet for {title}.</span>
      </div>
    );
  }

  // Calculate min, max, avg
  const values = data.map((d) => d.value);
  const minVal = Math.min(...values);
  const maxVal = maxValue !== undefined ? maxValue : Math.max(...values, 1);
  const avgVal = values.reduce((a, b) => a + b, 0) / values.length;
  const currentVal = values[values.length - 1];

  // SVG Geometry Dimensions
  const paddingX = 10;
  const paddingY = 16;
  const chartWidth = 500;
  const chartHeight = height - 40;

  const points = data.map((d, i) => {
    const x = paddingX + (i / Math.max(data.length - 1, 1)) * (chartWidth - 2 * paddingX);
    const normalizedY = Math.max(0, Math.min(d.value / maxVal, 1));
    const y = chartHeight - paddingY - normalizedY * (chartHeight - 2 * paddingY);
    return { x, y, raw: d };
  });

  const pathD = points.reduce((acc, p, i) => {
    return i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`;
  }, '');

  const areaD = `${pathD} L ${points[points.length - 1].x} ${chartHeight - paddingY} L ${points[0].x} ${chartHeight - paddingY} Z`;

  const gradientId = `grad-${title.replace(/[^a-zA-Z0-9]/g, '')}-${color.replace(/[^a-zA-Z0-9]/g, '')}`;

  const hoveredPoint = hoverIndex !== null && points[hoverIndex] ? points[hoverIndex] : null;

  return (
    <div
      className="glass-card"
      style={{
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        background: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid var(--glass-border-subtle)',
        borderRadius: 'var(--radius-md)',
      }}
      role="region"
      aria-label={`${title} Time Series Chart`}
    >
      {/* Header with Title and Metrics Pills */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px' }}>
        <span style={{ fontWeight: 600, color: 'var(--fg-primary)' }}>{title}</span>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
          <span style={{ color: color, fontWeight: 700 }}>
            Cur: {formatVal(currentVal)}
          </span>
          <span style={{ color: 'var(--fg-muted)' }}>
            Avg: {formatVal(avgVal)}
          </span>
          <span style={{ color: 'var(--fg-secondary)' }}>
            Peak: {formatVal(Math.max(...values))}
          </span>
        </div>
      </div>

      {/* SVG Time-Series Visualizer */}
      <div style={{ position: 'relative', width: '100%', height: `${chartHeight}px` }}>
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          style={{ width: '100%', height: '100%', overflow: 'visible' }}
          preserveAspectRatio="none"
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor={color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          <line
            x1={paddingX}
            y1={paddingY}
            x2={chartWidth - paddingX}
            y2={paddingY}
            stroke="rgba(255, 255, 255, 0.06)"
            strokeDasharray="3 3"
          />
          <line
            x1={paddingX}
            y1={chartHeight / 2}
            x2={chartWidth - paddingX}
            y2={chartHeight / 2}
            stroke="rgba(255, 255, 255, 0.06)"
            strokeDasharray="3 3"
          />
          <line
            x1={paddingX}
            y1={chartHeight - paddingY}
            x2={chartWidth - paddingX}
            y2={chartHeight - paddingY}
            stroke="rgba(255, 255, 255, 0.1)"
          />

          {/* Area fill */}
          <path d={areaD} fill={`url(#${gradientId})`} />

          {/* Line stroke */}
          <path d={pathD} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />

          {/* Data points & hover triggers */}
          {points.map((p, idx) => (
            <circle
              key={idx}
              cx={p.x}
              cy={p.y}
              r={hoverIndex === idx ? 4.5 : 2}
              fill={color}
              style={{ transition: 'r 100ms ease', cursor: 'pointer' }}
              onMouseEnter={() => setHoverIndex(idx)}
            />
          ))}

          {/* Hover Crosshair line */}
          {hoveredPoint && (
            <line
              x1={hoveredPoint.x}
              y1={paddingY}
              x2={hoveredPoint.x}
              y2={chartHeight - paddingY}
              stroke="rgba(255, 255, 255, 0.4)"
              strokeDasharray="2 2"
              strokeWidth="1"
            />
          )}
        </svg>

        {/* Hover Tooltip */}
        {hoveredPoint && (
          <div
            style={{
              position: 'absolute',
              left: `${(hoveredPoint.x / chartWidth) * 100}%`,
              top: `${Math.max(0, hoveredPoint.y - 32)}px`,
              transform: 'translateX(-50%)',
              background: 'rgba(17, 19, 28, 0.95)',
              border: `1px solid ${color}`,
              borderRadius: '4px',
              padding: '2px 8px',
              fontSize: '11px',
              color: 'var(--fg-primary)',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 10,
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            }}
          >
            <strong>{formatVal(hoveredPoint.raw.value)}</strong>
            <span style={{ marginLeft: '6px', color: 'var(--fg-muted)', fontSize: '10px' }}>
              {new Date(hoveredPoint.raw.timestamp).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>

      {/* Screen Reader Accessible Data Table Fallback */}
      {showTableFallback && (
        <details style={{ fontSize: '11px', marginTop: '4px', color: 'var(--fg-muted)' }}>
          <summary style={{ cursor: 'pointer' }}>View tabular data ({data.length} samples)</summary>
          <div style={{ maxHeight: '120px', overflowY: 'auto', marginTop: '4px' }}>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--glass-border-subtle)' }}>
                  <th style={{ padding: '2px 6px' }}>Time</th>
                  <th style={{ padding: '2px 6px' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                    <td style={{ padding: '2px 6px' }}>{new Date(d.timestamp).toLocaleTimeString()}</td>
                    <td style={{ padding: '2px 6px' }}>{formatVal(d.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
