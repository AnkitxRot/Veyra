# Load test — level baseline-control

- Started: 2026-08-24T17:49:29.813Z
- Args: users=10 ramp=15s steady=60s rampdown=15s burst=false
- Total duration: 75.1s
- Rampdown wall time: 0.0s

## Throughput

- Successful requests/sec: 1.7 (131 over 75.1s)
- Completed DB operations/sec: 4.7 (353 over 75.1s)

## Per-endpoint-class latency and outcomes

| class | count | p50ms | p95ms | p99ms | success | quota_reject | timeout | conn_fail | crash |
|---|---|---|---|---|---|---|---|---|---|
| auth | 10 | 48.5 | 50.1 | 50.1 | 10 | 0 | 0 | 0 | 0 |
| project_create | 5 | 14.8 | 16.4 | 16.4 | 5 | 0 | 0 | 0 | 0 |
| file_save | 78 | 18.2 | 19.7 | 21.6 | 78 | 0 | 0 | 0 | 0 |
| auth_me | 26 | 16.6 | 17.7 | 18.6 | 26 | 0 | 0 | 0 | 0 |
| run | 12 | 449.8 | 984.4 | 984.4 | 12 | 0 | 0 | 0 | 0 |

## Save round-trip latency / collab edit-to-peer latency

| metric | count | p50ms | p95ms | p99ms |
|---|---|---|---|---|
| save round-trip | 77 | 18.2 | 19.7 | 21.6 |
| collab edit-to-peer | 147 | 0.7 | 1.7 | 4.3 |

## Final observability snapshot

- Event-loop lag: p50=30.8ms p95=32.0ms p99=32.6ms mean=30.5ms
- DB calls overall: count=353 p50=0.021ms p95=0.049ms p99=0.082ms
- Active WS connections: 3
- Active collab rooms: 2
- Active sandboxes: 1
- Process RSS: 91.8 MB

### DB calls by operation

| operation | count | p50ms | p95ms | p99ms |
|---|---|---|---|---|
| SELECT users | 15 | 0.015 | 0.024 | 0.025 |
| INSERT users | 12 | 0.064 | 0.081 | 0.112 |
| INSERT sessions | 12 | 0.019 | 0.035 | 0.039 |
| INSERT audit_logs | 12 | 0.018 | 0.021 | 0.031 |
| SELECT sessions | 79 | 0.025 | 0.039 | 0.081 |
| SELECT projects | 107 | 0.012 | 0.035 | 0.066 |
| INSERT projects | 6 | 0.024 | 0.038 | 0.038 |
| UPDATE projects | 78 | 0.020 | 0.032 | 0.036 |
| SELECT project_collaborators | 2 | 0.002 | 0.003 | 0.003 |
| INSERT telemetry_samples | 30 | 0.013 | 0.097 | 0.153 |

## Observability over time (event-loop lag p99 / DB p99 / gauges, sampled every 5s)

| t(s) | evloop p99ms | db p99ms | ws conns | rooms | sandboxes | rss MB |
|---|---|---|---|---|---|---|
| 5 | 32.7 | 0.064 | 3 | 2 | 0 | 99.0 |
| 10 | 32.6 | 0.069 | 3 | 2 | 0 | 84.8 |
| 15 | 32.7 | 0.081 | 3 | 2 | 1 | 86.9 |
| 20 | 32.6 | 0.081 | 3 | 2 | 1 | 87.6 |
| 25 | 32.6 | 0.081 | 3 | 2 | 1 | 88.2 |
| 30 | 32.4 | 0.081 | 3 | 2 | 1 | 88.5 |
| 35 | 32.4 | 0.081 | 3 | 2 | 1 | 88.9 |
| 40 | 32.4 | 0.081 | 3 | 2 | 1 | 89.3 |
| 45 | 32.4 | 0.082 | 3 | 2 | 1 | 89.6 |
| 50 | 32.6 | 0.081 | 3 | 2 | 1 | 90.0 |
| 55 | 32.6 | 0.082 | 3 | 2 | 1 | 89.6 |
| 60 | 32.5 | 0.082 | 3 | 2 | 1 | 90.2 |
| 65 | 32.6 | 0.082 | 3 | 2 | 1 | 90.8 |
| 70 | 32.6 | 0.097 | 3 | 2 | 1 | 91.1 |

Full raw per-sample data (including per-operation DB breakdowns at each sample point) is in the sibling `.json` file for this run.