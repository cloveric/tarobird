// iOS 15 lacks AbortSignal.any/timeout. Also bound the caller's wait when a
// native IPC operation is slow to acknowledge cancellation; its late result
// must not revive a completed request or become an unhandled rejection.
export function queueRequest(parents: AbortSignal[], timeoutMs: number) {
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  for (const parent of parents) { if (parent.aborted) abort(); else parent.addEventListener("abort", abort, { once: true }); }
  return {
    signal: controller.signal,
    wait: <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const cancelled = () => reject(new DOMException("The request was aborted", "AbortError"));
      if (controller.signal.aborted) cancelled();
      else controller.signal.addEventListener("abort", cancelled, { once: true });
      const remove = () => controller.signal.removeEventListener("abort", cancelled);
      operation.then(value => { remove(); resolve(value); }, error => { remove(); reject(error); });
    }),
    dispose: () => { clearTimeout(timer); for (const parent of parents) parent.removeEventListener("abort", abort); },
  };
}
