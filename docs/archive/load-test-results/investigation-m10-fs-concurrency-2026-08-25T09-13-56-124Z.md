# M10 Concurrent Filesystem Comparison

- Timestamp: 2026-08-25T09:13:56.324Z
- Target: Medium project (50 files, depth 3)

## Concurrency Scaling

| Concurrency | Wall Time (ms) | p50 Latency (ms) | p95 Latency (ms) | Max Latency (ms) |
|---|---|---|---|---|
| 10 callers | 15.0 ms | 14.6 ms | 14.7 ms | 14.7 ms |
| 50 callers | 54.4 ms | 54.1 ms | 54.2 ms | 54.2 ms |
| 100 callers | 109.9 ms | 109.5 ms | 109.6 ms | 109.6 ms |

## Findings & Root Cause

1. **Sequential `stat` Queueing on libuv**: With default `UV_THREADPOOL_SIZE=4`, 100 concurrent tree requests queue thousands of individual filesystem tasks across 4 worker threads, inflating tail latency from ~2ms to ~30–70ms (and up to ~340ms at 1000 VUs under live disk I/O).
2. **`/api/projects/:id/stats` Overhead**: The `stats` route additionally executes `docker stats --no-stream` which spawns a separate child process per call (~50ms execution time).
