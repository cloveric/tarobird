/** Abort a wait even if the consumer ignores the request's signal. */
export async function raceAbort<T>(work: () => Promise<T>, signal: AbortSignal, aborted: () => T): Promise<T> {
  if (signal.aborted) return aborted();
  let listener!: () => void;
  const cancellation = new Promise<T>(resolve => { listener = () => resolve(aborted()); signal.addEventListener("abort", listener, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => signal.aborted ? aborted() : work()), cancellation]); }
  finally { signal.removeEventListener("abort", listener); }
}
