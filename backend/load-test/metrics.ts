// M5a load harness: minimal client-side metrics collection. No external
// dependency — percentiles are computed from a bounded, capped sample array
// (sampling, not storing every request forever, keeps this harness itself
// from becoming a memory-pressure source during a long run).

export type Outcome =
  | "success"
  | "clean_quota_rejection"
  | "timeout"
  | "connection_failure"
  | "crash";

const MAX_SAMPLES_PER_CLASS = 20_000;

export class LatencyRecorder {
  private samplesMs: number[] = [];

  record(ms: number): void {
    if (this.samplesMs.length < MAX_SAMPLES_PER_CLASS) {
      this.samplesMs.push(ms);
    }
  }

  summary(): {
    count: number;
    minMs: number;
    maxMs: number;
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  } {
    const n = this.samplesMs.length;
    if (n === 0) {
      return {
        count: 0,
        minMs: 0,
        maxMs: 0,
        meanMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
      };
    }
    const sorted = [...this.samplesMs].sort((a, b) => a - b);
    const pct = (p: number) =>
      sorted[Math.min(n - 1, Math.floor((p / 100) * n))];
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: n,
      minMs: sorted[0],
      maxMs: sorted[n - 1],
      meanMs: sum / n,
      p50Ms: pct(50),
      p95Ms: pct(95),
      p99Ms: pct(99),
    };
  }
}

export class OutcomeCounter {
  private counts: Record<Outcome, number> = {
    success: 0,
    clean_quota_rejection: 0,
    timeout: 0,
    connection_failure: 0,
    crash: 0,
  };

  record(outcome: Outcome): void {
    this.counts[outcome]++;
  }

  snapshot(): Record<Outcome, number> {
    return { ...this.counts };
  }
}

/** Per-endpoint-class latency + outcome tracking for one load-test run. */
export class MetricsCollector {
  private latencyByClass = new Map<string, LatencyRecorder>();
  private outcomesByClass = new Map<string, OutcomeCounter>();
  readonly saveLatency = new LatencyRecorder();
  readonly collabEditToPeerLatency = new LatencyRecorder();

  private getLatency(cls: string): LatencyRecorder {
    let l = this.latencyByClass.get(cls);
    if (!l) {
      l = new LatencyRecorder();
      this.latencyByClass.set(cls, l);
    }
    return l;
  }

  private getOutcomes(cls: string): OutcomeCounter {
    let o = this.outcomesByClass.get(cls);
    if (!o) {
      o = new OutcomeCounter();
      this.outcomesByClass.set(cls, o);
    }
    return o;
  }

  recordRequest(endpointClass: string, ms: number, outcome: Outcome): void {
    this.getLatency(endpointClass).record(ms);
    this.getOutcomes(endpointClass).record(outcome);
  }

  report(): {
    byEndpointClass: Record<
      string,
      {
        latency: ReturnType<LatencyRecorder["summary"]>;
        outcomes: Record<Outcome, number>;
      }
    >;
    saveLatency: ReturnType<LatencyRecorder["summary"]>;
    collabEditToPeerLatency: ReturnType<LatencyRecorder["summary"]>;
  } {
    const byEndpointClass: Record<
      string,
      {
        latency: ReturnType<LatencyRecorder["summary"]>;
        outcomes: Record<Outcome, number>;
      }
    > = {};
    for (const [cls, latency] of this.latencyByClass) {
      byEndpointClass[cls] = {
        latency: latency.summary(),
        outcomes: this.getOutcomes(cls).snapshot(),
      };
    }
    return {
      byEndpointClass,
      saveLatency: this.saveLatency.summary(),
      collabEditToPeerLatency: this.collabEditToPeerLatency.summary(),
    };
  }
}
