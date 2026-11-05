/** One active read and one dirty bit, so bursts cannot accumulate stale reads.
 * A completed prefix is still published during sustained updates. */
export function coalescedReader<T>(read: () => Promise<T>, publish: (value: T) => void) {
  let running = false, dirty = false, disposed = false;
  return {
    request() {
      if (disposed) return;
      dirty = true;
      if (running) return;
      running = true;
      void (async () => {
        do {
          dirty = false;
          try { const value = await read(); if (!disposed) publish(value); }
          catch { /* Retain the last valid view; a later revision retries. */ }
        } while (dirty && !disposed);
        running = false;
      })();
    },
    close() { disposed = true; dirty = false; },
  };
}
