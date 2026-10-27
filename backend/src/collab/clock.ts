// ===========================================================================
// M91 — Clock abstraction for deterministic idle-disposal testing
// ===========================================================================
//
// Production: SystemClock uses real setTimeout/Date.now.
// Tests: VirtualClock queues timers and fires them from advanceBy(), so
// tests can advance 10s/20s/40s/… of backoff in a single microtask — no
// vi.useFakeTimers() needed (which breaks real I/O like fs.realpath/fs.access
// and causes worker crashes).

export interface IClock {
  setTimeout(fn: () => void, ms: number): ITimer;
  setInterval(fn: () => void, ms: number): ITimer;
  now(): number;
}

export interface ITimer {
  clear(): void;
}

/** Production clock — delegates to real Node.js timers. */
export class SystemClock implements IClock {
  setTimeout(fn: () => void, ms: number): ITimer {
    return new RealTimer(setTimeout(fn, ms));
  }
  setInterval(fn: () => void, ms: number): ITimer {
    return new RealTimer(setInterval(fn, ms));
  }
  now(): number {
    return Date.now();
  }
}

class RealTimer implements ITimer {
  private readonly t: ReturnType<typeof setTimeout | typeof setInterval>;
  constructor(t: ReturnType<typeof setTimeout | typeof setInterval>) {
    this.t = t;
  }
  clear(): void {
    clearTimeout(this.t);
    clearInterval(this.t);
  }
}

/** Deterministic clock for tests. */
export class VirtualClock implements IClock {
  private readonly timers: VTimer[] = [];
  public virtualTime = 0;

  setTimeout(fn: () => void, ms: number): ITimer {
    const t = new VTimer(this, this.virtualTime + ms, fn, false);
    this.timers.push(t);
    return t;
  }

  setInterval(fn: () => void, ms: number): ITimer {
    const t = new VTimer(this, this.virtualTime + ms, fn, true, ms);
    this.timers.push(t);
    return t;
  }

  cancel(t: VTimer): void {
    const i = this.timers.indexOf(t);
    if (i >= 0) this.timers.splice(i, 1);
  }

  async advanceBy(ms: number): Promise<void> {
    this.virtualTime += ms;
    let guard = 0;
    while (this.timers.length > 0 && guard++ < 10000) {
      this.timers.sort((a, b) => a.fireAt - b.fireAt);
      const due = this.timers.filter((t) => t.fireAt <= this.virtualTime);
      if (due.length === 0) break;
      for (const t of due) {
        this.cancel(t);
        if (t.isInterval) {
          // Reschedule interval
          t.fireAt = this.virtualTime + t.intervalMs!;
          this.timers.push(t);
        }
        await Promise.resolve(t.fn());
      }
    }
  }

  now(): number {
    return this.virtualTime;
  }
}

class VTimer implements ITimer {
  constructor(
    private readonly clock: VirtualClock,
    public fireAt: number,
    public readonly fn: () => void,
    public readonly isInterval: boolean = false,
    public readonly intervalMs?: number,
  ) {}
  clear(): void {
    this.clock.cancel(this);
  }
}
