export function debounceWithFlush<T>(
  fn: () => T | Promise<T>,
  ms: number,
): {
  trigger(): void;
  runNow(): Promise<T>;
  flush(): Promise<T | undefined>;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<T> | undefined;

  function runNow(): Promise<T> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const result = Promise.resolve(fn());
    inFlight = result;
    void result.finally(() => {
      if (inFlight === result) inFlight = undefined;
    });
    return result;
  }

  function trigger(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runNow();
    }, ms);
  }

  function flush(): Promise<T | undefined> {
    if (timer !== undefined) return runNow();
    return inFlight ?? Promise.resolve(undefined);
  }

  return { trigger, runNow, flush };
}
