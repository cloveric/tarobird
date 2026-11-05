type Remove = () => void | Promise<void>;
type Register<T> = (emit: (value: T) => void, active: () => boolean) => void | Remove | Promise<void | Remove>;
type Slot<T> = {
  active: boolean; attempt: number; failures: number; register?: Register<T>; consume?: (value: T) => void;
  remove?: Remove; timer?: ReturnType<typeof setTimeout>; retry: boolean;
};
const retryDelays = [1_000, 2_000, 5_000, 15_000, 30_000];
const maxAttempts = 8;
export function removeListenerSafely(remove?: Remove): void {
  // Some bridges throw synchronously, others reject. Cleanup is independent.
  try { void Promise.resolve(remove?.()).catch(() => undefined); } catch { /* Callback fences remain closed. */ }
}
function start<T>(slot: Slot<T>): void {
  if (!slot.active || !slot.register) return;
  const attempt = ++slot.attempt;
  const active = () => slot.active && slot.attempt === attempt;
  // Retained native events may be replayed before registration resolves.
  const emit = (value: T) => { if (active()) slot.consume?.(value); };
  const failed = () => {
    if (!active()) return;
    ++slot.attempt; // A rejected registration may still have left a callback behind.
    // A rejected SDK call can leak its callback without returning a handle.
    // Bound total attempts as well as frequency, including permanent ACL errors.
    if (slot.retry && slot.failures < maxAttempts - 1) slot.timer = setTimeout(() => { slot.timer = undefined; start(slot); }, retryDelays[Math.min(slot.failures++, retryDelays.length - 1)]!);
    else { slot.register = undefined; slot.consume = undefined; }
  };
  try {
    void Promise.resolve(slot.register(emit, active)).then((remove) => {
      if (!active()) { removeListenerSafely(remove || undefined); return; }
      slot.remove = remove || undefined; slot.register = undefined;
    }, failed);
  } catch { failed(); }
}

/** Own asynchronous registrations from the instant installation starts. Each
 * slot retries only a settled rejection; a pending bridge call is never doubled.
 * Native remove acknowledgments are not a guarantee that the OS freed a handle. */
export class ListenerScope {
  private stops: (() => Remove | undefined)[] = [];
  private closed = false;
  listen<T>(register: Register<T>, consume: (value: T) => void, options: { retry?: boolean } = {}): () => void {
    if (this.closed) return () => undefined;
    const slot: Slot<T> = { active: true, attempt: 0, failures: 0, register, consume, retry: options.retry !== false };
    const stop = () => {
      slot.active = false; clearTimeout(slot.timer);
      // An SDK may retain emit even when remove fails. It must not retain the
      // old connection/pool through our consumer or registration factory.
      slot.consume = undefined; slot.register = undefined;
      const remove = slot.remove; slot.remove = undefined; return remove;
    };
    this.stops.push(stop);
    start(slot);
    return () => removeListenerSafely(stop());
  }
  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    const stops = this.stops; this.stops = [];
    // Close every callback before asking any SDK to remove its handle: removal
    // itself may synchronously deliver another slot's queued event.
    const removals = stops.map((stop) => stop());
    removals.forEach(removeListenerSafely);
  };
}
