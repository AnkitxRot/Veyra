# M10 Execution Burst Cross-Check

- Timestamp: 2026-08-25T09:13:35.244Z
- Workload: 50 simultaneous cold sandbox execution requests across 50 distinct projects
- Max sandboxes configured: 20

## Summary Metrics

- **Total Wall Clock Duration**: 12.12s
- **Success Count (admitted/completed)**: 50
- **Rejections / Capacity Rejections**: 0
- **Active Sandboxes at Peak**: 20 (Max Cap: 20)

## Latency Profile

| Metric | All Requests (ms) | Successful Requests (ms) |
|---|---|---|
| p50 | 9189.7 | 9189.7 |
| p95 | 11830.8 | 11830.8 |
| p99 | 12112.9 | 12112.9 |
| Max | 12112.9 | 12112.9 |

## Root-Cause Attribution

1. **Capacity Gating (maxSandboxes=20)**: The first 20 containers are created in parallel under Docker daemon contention; the remaining 30 requests hit capacity limits or wait on idle reaper, causing clean rejection or queueing.
2. **Docker Daemon Concurrency Serialization**: When 20 `docker run` commands are spawned concurrently on Windows Docker Desktop, the daemon serializes container setup, stretching container creation from ~400ms to ~8–14s.
