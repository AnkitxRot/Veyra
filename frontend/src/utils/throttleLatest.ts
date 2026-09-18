export interface ThrottledFn<T> {
  (value: T): void;
  cancel(): void;
  /** Deliver the pending value immediately, if any. */
  flush(): void;
}

/**
 * Coalesces a burst of calls into at most one invocation of `fn` per
 * `waitMs` window, always delivering the most recently passed value.
 * Trailing-edge only: the first call in a burst also waits the full
 * window before firing, so bursts never trigger `fn` synchronously.
 */
export function throttleLatest<T>(
  fn: (value: T) => void,
  waitMs: number,
): ThrottledFn<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | undefined;
  let hasPending = false;

  const fire = () => {
    timer = null;
    if (!hasPending) return;
    hasPending = false;
    const value = pending as T;
    pending = undefined;
    fn(value);
  };

  const throttled = ((value: T) => {
    pending = value;
    hasPending = true;
    if (timer) return;
    timer = setTimeout(fire, waitMs);
  }) as ThrottledFn<T>;

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    hasPending = false;
    pending = undefined;
  };

  throttled.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fire();
  };

  return throttled;
}

export interface ThrottledPaths {
  (path: string): void;
  cancel(): void;
  flush(): void;
}

/**
 * Coalesces a burst of path notifications into one flush of every dirty
 * path after `waitMs`. Editing A then B within the window must not drop A.
 * Close / project-switch callers must `flush()` so the last keystroke is
 * not lost.
 */
export function throttleDirtyPaths(
  fn: (path: string) => void,
  waitMs: number,
): ThrottledPaths {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fire = () => {
    timer = null;
    if (pending.size === 0) return;
    const paths = [...pending];
    pending.clear();
    for (const path of paths) fn(path);
  };

  const throttled = ((path: string) => {
    pending.add(path);
    if (timer) return;
    timer = setTimeout(fire, waitMs);
  }) as ThrottledPaths;

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending.clear();
  };

  throttled.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fire();
  };

  return throttled;
}
