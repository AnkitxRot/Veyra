# Milestone 18 — Cold-Wait Decomposition & Scheduling Decision

- Timestamp: 2026-08-25T12:29:34.455Z
- maxSandboxes: 20

## Phase 1: Cold Wait Decomposition

| Concurrency | Success | Rejected | Total p50 (ms) | Total p95 (ms) | Total p99 (ms) | Wall (ms) |
|---|---|---|---|---|---|---|
| **C=1** | 1/1 | 0 | 4860.0 | 4860.0 | 4860.0 | 4860.5 |
| **C=5** | 5/5 | 0 | 830.8 | 1013.7 | 1013.7 | 1016.1 |
| **C=10** | 10/10 | 0 | 1334.8 | 1748.7 | 1748.7 | 1749.9 |
| **C=20** | 20/20 | 0 | 2813.7 | 3921.4 | 3921.4 | 3924.7 |
| **C=40** | 40/40 | 0 | 1763.9 | 4022.7 | 4157.0 | 4159.2 |

### Wait Decomposition Analysis

For C≤20, all requests are admitted immediately (no admission wait).
For C=40, 0 requests are rejected immediately at the maxSandboxes=20 gate.
The remaining 40 admitted requests proceed directly to Docker provisioning.

**Key finding**: There is no queuing delay — the system either admits immediately or rejects.
The entire cold latency is Docker provisioning + execution time.

## Phase 2: User-Impact Latency Distribution

### Steady Traffic (20 sequential requests, 500ms apart)

| Metric | Value |
|---|---|
| p50 | 620.5 ms |
| p95 | 838.4 ms |
| p99 | 838.4 ms |
| <1s | 20 (100%) |
| 1-2s | 0 (0%) |
| 2-5s | 0 (0%) |
| >5s | 0 (0%) |

### 20-Concurrent Cold Burst

| Metric | Value |
|---|---|
| Success / Total | 20 / 20 |
| Rejected | 0 |
| p50 | 2813.7 ms |
| p95 | 3921.4 ms |
| p99 | 3921.4 ms |
| <1s | 0 |
| 1-2s | 3 |
| 2-5s | 17 |
| >5s | 0 |

### 40-Concurrent Cold Burst

| Metric | Value |
|---|---|
| Success / Total | 40 / 40 |
| Rejected | 0 |
| p50 | 1763.9 ms |
| p95 | 4022.7 ms |
| p99 | 4157.0 ms |
| <1s | 20 |
| 1-2s | 2 |
| 2-5s | 18 |
| >5s | 0 |

## Phase 3: Scheduling Strategy Simulation

### A. Current: Immediate Admission
Under C≤20: all requests admitted, no queuing.
Under C>20: 0/40 requests rejected immediately (no wait, clear error).
No head-of-line blocking. No starvation. No queue memory.
Rejected requests can retry (client-side).
Throughput data: C=1: 0.2 req/s, avg=4860ms; C=5: 4.9 req/s, avg=827ms; C=10: 5.7 req/s, avg=1291ms; C=20: 5.1 req/s, avg=2765ms; C=40: 9.6 req/s, avg=1619ms

### B. Strict FIFO Queue
Would eliminate immediate rejections at C>20.
But: adds admission wait to ALL queued requests (at C=40, 20 requests wait for the first batch to complete).
Estimated added wait for queued requests at C=40: ~3.9s (full C=20 batch wall time).
Risks: head-of-line blocking, starvation under sustained load, unbounded queue growth.
Requires: disconnect detection, cancellation, timeout, queue depth limit, per-user fairness.
Net effect: converts fast rejection into slow queuing — user waits longer for the same outcome.

### C. Shortest-Job Ordering
All cold starts have similar cost (Docker provisioning dominates).
Cannot estimate job duration before running it.
For this system, all executions are roughly equivalent (print-hello).
No meaningful scheduling advantage over FIFO.
Adds complexity: cost estimation, priority inversion, starvation prevention.

### D. Bounded Docker Concurrency
Optimal measured concurrency: C=5 (best throughput/latency ratio).
Could reduce p95/p99 for the admitted batch by avoiding Docker daemon serialization.
But: current system already has maxSandboxes=20 which naturally bounds concurrency.
Adding an inner concurrency limit below 20 would reduce effective capacity.
The Docker daemon is the bottleneck, not the admission logic.

## Phase 4: Resource & Fairness Tradeoff

Any scheduling/queuing layer introduces:
- **Queue memory**: O(queued requests) — bounded if limited, but adds a new resource dimension.
- **Cancellation**: Must detect client disconnect while queued and free the slot.
- **Starvation**: FIFO prevents starvation but adds head-of-line blocking; priority queues risk starvation for low-priority.
- **Per-user fairness**: Current system uses sandboxGate (maxSandboxesPerUser=5). A queue must preserve this.
- **Project lock interaction**: sandboxManager.withProjectLock serializes per-project. A global queue adds a second serialization layer.
- **Retry semantics**: Rejected requests are retried by the client. Queued requests are retried by the server (implicit retry = longer hold).
- **Disconnect handling**: WebSocket disconnect during queue wait must release the slot before provisioning.
- **maxSandboxes interaction**: A queue does not increase capacity; it only changes failure mode from fast-reject to slow-wait.

**Net assessment**: Scheduling complexity does NOT increase throughput. It converts a fast, clear failure (rejection) into a slow, opaque wait. The Docker daemon is the throughput bottleneck, and no admission strategy changes Docker's processing rate.
