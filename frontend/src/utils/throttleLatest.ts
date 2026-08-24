export interface ThrottledFn<T> {
  (value: T): void;
  cancel(): void;
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

  const throttled = ((value: T) => {
    pending = value;
    hasPending = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (hasPending) {
        hasPending = false;
        const value = pending as T;
        pending = undefined;
        fn(value);
      }
    }, waitMs);
  }) as ThrottledFn<T>;

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    hasPending = false;
    pending = undefined;
  };

  return throttled;
}
