# M15 Bounded Cold-Sandbox Prewarming Experiment Report

- Timestamp: 2026-08-25T11:33:29.695Z

## 50-VU Cold Execution Burst Comparison

| Variant | Prewarm Pool Size | Prewarmed Hits | Cold Creations | Burst p50 (ms) | Burst p95 (ms) | Burst p99 (ms) | Wall Clock (s) | Peak Load (/20) | Isolation Violations | Leftovers |
|---|---|---|---|---|---|---|---|---|---|---|
| **P0 (Baseline)** | 0 | 0 | 50 | 4904.0 ms | 10006.8 ms | 10087.5 ms | 11.38 s | 51/20 | 0 | 0 |
| **P1** | 1 | 1 | 49 | 5151.4 ms | 10624.7 ms | 10870.3 ms | 12.79 s | 51/20 | 0 | 0 |
| **P2** | 2 | 2 | 48 | 5487.7 ms | 9587.6 ms | 9700.0 ms | 11.91 s | 51/20 | 0 | 0 |
| **P4** | 4 | 4 | 46 | 5527.9 ms | 10042.0 ms | 10892.9 ms | 11.91 s | 51/20 | 0 | 0 |

## Repeated Validation of Best Variant (P2)

| Metric | First Run | Repeated Run | Difference |
|---|---|---|---|
| Burst p50 | 5487.7 ms | 5262.9 ms | -224.8 ms |
| Burst p95 | 9587.6 ms | 10845.9 ms | 1258.3 ms |
| Burst p99 | 9700.0 ms | 11220.1 ms | 1520.1 ms |
| Total Wall Clock | 11.91 s | 13.06 s | 1.14 s |

## Warm Execution Parity

- **Warm Exec p50 / p95**: 145.4 ms / 165.8 ms (P0) vs 151.0 ms / 153.7 ms (P2)
