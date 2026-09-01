import type { CommentEventWire, CommentThreadDTO } from "../types";
import * as api from "./api";

/**
 * M61-A client comment cache — scoped to one project, keyed by file. NOT a
 * global unbounded cache. `comment_event` pings trigger a per-file debounced
 * REST refetch (the wire frame carries no authoritative data). SQLite + REST
 * stay authoritative.
 */

const REFETCH_DEBOUNCE_MS = 250;

export class CommentStore {
  private threadsByFile = new Map<string, CommentThreadDTO[]>();
  private unresolvedList: CommentThreadDTO[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly projectId: string) {}

  async load(file: string): Promise<void> {
    const res = await api.fetchThreads(this.projectId, file, "all");
    if (this.disposed) return;
    this.threadsByFile.set(file, res.threads);
    this.notify();
  }

  async loadUnresolved(): Promise<void> {
    const res = await api.fetchThreads(this.projectId, null, "active");
    if (this.disposed) return;
    this.unresolvedList = res.threads;
    this.notify();
  }

  threadsFor(file: string): CommentThreadDTO[] {
    return this.threadsByFile.get(file) ?? [];
  }

  unresolved(): CommentThreadDTO[] {
    return this.unresolvedList;
  }

  /** Schedule ONE debounced scoped refetch for the affected file. */
  applyEvent(ev: CommentEventWire): void {
    if (this.disposed || !ev.filePath) return;
    const key = ev.filePath;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.refetch(key);
      }, REFETCH_DEBOUNCE_MS),
    );
  }

  private async refetch(file: string): Promise<void> {
    try {
      const res = await api.fetchThreads(this.projectId, file, "all");
      if (this.disposed) return;
      this.threadsByFile.set(file, res.threads);
      this.notify();
    } catch {
      /* transient — the next event or a manual reload recovers */
    }
  }

  /** Optimistically replace a thread from a mutation response. */
  upsertThread(thread: CommentThreadDTO): void {
    const arr = this.threadsByFile.get(thread.filePath) ?? [];
    const next = arr.filter((t) => t.id !== thread.id);
    next.unshift(thread);
    this.threadsByFile.set(thread.filePath, next);
    this.notify();
  }

  on(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
    this.threadsByFile.clear();
    this.unresolvedList = [];
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }
}
