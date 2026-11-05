/** WebKit versions before AbortSignal.any/timeout still need bounded requests. */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError("Invalid timeout");
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), ms);
  return controller.signal;
}
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const abort = (signal: AbortSignal) => {
    for (const [source, listener] of listeners) source.removeEventListener("abort", listener);
    listeners.clear();
    controller.abort(signal.reason);
  };
  for (const signal of new Set(signals)) {
    if (signal.aborted) { abort(signal); break; }
    const listener = () => abort(signal);
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }
  return controller.signal;
}
