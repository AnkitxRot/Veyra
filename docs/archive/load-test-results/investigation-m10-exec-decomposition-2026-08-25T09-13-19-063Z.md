# M10 Execution Phase Decomposition

- Timestamp: 2026-08-25T09:13:19.063Z

## Direct Phase Timings (Single Isolated Cold Start)

| Phase | Duration (ms) | % of Creation |
|---|---|---|
| 1. Docker daemon check (`docker info`) | 177.8 | 18.9% |
| 2. Image inspect (`docker image inspect`) | 63.8 | 6.8% |
| 3. Pre-cleanup (`docker rm -f`) | 39.7 | 4.2% |
| 4. Network setup (`docker network create`) | 118.0 | 12.6% |
| 5. Container creation (`docker run -d`) | 342.5 | 36.5% |
| 6. Port inspection (`docker port`) | 44.7 | 4.8% |
| 7. Exec startup (`docker exec` spawn to stdout) | 86.0 | 9.2% |
| 8. Program execution (`python3` runtime) | 63.5 | - |
| 9. Teardown (`docker rm` + `network rm`) | 932.7 | - |
| **Total Cold Creation + Execution** | **938.3 ms** | 100.0% |

## Cold vs Warm Execution Comparison

- **Cold Sandbox Creation + Exec**: ~938.3 ms
- **Warm Sandbox Reused Exec (p50 / p95)**: **116.0 ms / 132.0 ms** (Speedup: ~8.1x)

## Concurrency Scaling (Cold Start Contention)

| Concurrency | Wall Time (s) | p50 per Container (ms) | p95 per Container (ms) | Max (ms) |
|---|---|---|---|---|
| 1 | 1.91 | 1906.5 | 1906.5 | 1906.5 |
| 5 | 5.56 | 5101.1 | 5552.0 | 5552.0 |
| 20 | 21.78 | 19479.0 | 21174.8 | 21174.8 |
