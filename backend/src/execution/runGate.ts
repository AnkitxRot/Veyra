/**
 * Tracks per-user concurrent executions across all execution entry points
 * (REST run, WebSocket execute, dependency install). In-memory: limits are
 * per backend process, which matches the single-instance architecture.
 */
export class RunGate {
  private active = new Map<number, number>();

  /** Returns true and increments the user's count when under the limit. */
  acquire(userId: number, max: number): boolean {
    const current = this.active.get(userId) ?? 0;
    if (current >= max) return false;
    this.active.set(userId, current + 1);
    return true;
  }

  release(userId: number): void {
    const current = this.active.get(userId) ?? 0;
    if (current <= 1) this.active.delete(userId);
    else this.active.set(userId, current - 1);
  }

  activeCount(userId: number): number {
    return this.active.get(userId) ?? 0;
  }
}

export const runGate = new RunGate();

/**
 * Separate per-user budget for workspace search. Each search spawns a real
 * OS-level worker thread that may run for up to the worker hard timeout, so
 * it needs its own cap — but it is a different resource class (CPU-bound
 * filesystem/regex work) than `runGate`'s Docker executions, and sharing one
 * counter would serialize unrelated operations against each other.
 */
export const searchGate = new RunGate();
