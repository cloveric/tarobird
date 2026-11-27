type GlobalTarget = Window | Document;

export type GlobalListenerOptions = {
  capture?: boolean;
  passive?: boolean;
  first?: boolean;
};

type Registration = {
  listener: EventListener;
  active: boolean;
  passive: boolean;
};

type Bucket = {
  registrations: Registration[];
  nativeListener: EventListener;
  capture: boolean;
  passive: boolean;
};

const targetBuckets = new WeakMap<GlobalTarget, Map<string, Bucket>>();
const mediaPool = new Map<string, { mql: MediaQueryList; listeners: Set<() => void>; onChange: () => void }>();

function bucketKey(type: string, capture: boolean): string {
  return `${type}:${capture ? "1" : "0"}`;
}

function dispatchBucket(bucket: Bucket, event: Event): void {
  const snapshot = bucket.registrations.slice();
  let stoppedImmediately = false;
  const originalStop = event.stopImmediatePropagation;
  event.stopImmediatePropagation = () => {
    stoppedImmediately = true;
    originalStop.call(event);
  };
  try {
    for (const registration of snapshot) {
      if (stoppedImmediately) break;
      if (!registration.active) continue;
      try {
        registration.listener(event);
      } catch (error) {
        if (typeof reportError === "function") reportError(error);
      }
    }
  } finally {
    event.stopImmediatePropagation = originalStop;
  }
}

function attachBucket(target: GlobalTarget, type: string, bucket: Bucket): void {
  // Always pass `passive` explicitly so default-passive events (wheel, touchstart,
  // touchmove on window/document) genuinely become active when passive is false.
  target.addEventListener(type, bucket.nativeListener, { capture: bucket.capture, passive: bucket.passive });
}

function detachBucket(target: GlobalTarget, type: string, bucket: Bucket): void {
  if (!bucket.capture) {
    target.removeEventListener(type, bucket.nativeListener);
    return;
  }
  target.removeEventListener(type, bucket.nativeListener, { capture: true });
}

/**
 * Pool global window/document listeners behind a single native listener per
 * (target, type, capture) tuple, matching Orca's keyboard-router pattern.
 * Preserves stopImmediatePropagation and isolates per-subscriber errors.
 */
export function addGlobalListener<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: GlobalListenerOptions,
): () => void;
export function addGlobalListener<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  listener: (event: DocumentEventMap[K]) => void,
  options?: GlobalListenerOptions,
): () => void;
export function addGlobalListener(
  target: GlobalTarget,
  type: string,
  listener: EventListener,
  options?: GlobalListenerOptions,
): () => void;
export function addGlobalListener(
  target: GlobalTarget,
  type: string,
  listener: EventListener,
  options: GlobalListenerOptions = {},
): () => void {
  const capture = !!options.capture;
  const passive = options.passive === true;
  let buckets = targetBuckets.get(target);
  if (!buckets) {
    buckets = new Map();
    targetBuckets.set(target, buckets);
  }
  const key = bucketKey(type, capture);
  let bucket = buckets.get(key);
  if (!bucket) {
    const next: Bucket = {
      registrations: [],
      capture,
      passive,
      nativeListener: (event: Event) => dispatchBucket(next, event),
    };
    bucket = next;
    buckets.set(key, bucket);
    attachBucket(target, type, bucket);
  } else if (bucket.passive && !passive) {
    // Upgrade from passive to active if any subscriber needs preventDefault().
    detachBucket(target, type, bucket);
    bucket.passive = false;
    attachBucket(target, type, bucket);
  }

  const registration: Registration = { listener, active: true, passive };
  if (options.first) bucket.registrations.unshift(registration);
  else bucket.registrations.push(registration);

  return () => {
    if (!registration.active) return;
    registration.active = false;
    const index = bucket.registrations.indexOf(registration);
    if (index !== -1) bucket.registrations.splice(index, 1);
    if (!bucket.registrations.length) {
      detachBucket(target, type, bucket);
      buckets.delete(key);
      return;
    }
    if (!registration.passive && !bucket.passive && bucket.registrations.every(item => item.passive)) {
      detachBucket(target, type, bucket);
      bucket.passive = true;
      attachBucket(target, type, bucket);
    }
  };
}

/** Share one MediaQueryList listener per query string across mounted components. */
export function subscribeMediaQuery(query: string, listener: () => void): () => void {
  let entry = mediaPool.get(query);
  if (!entry) {
    const mql = matchMedia(query);
    const listeners = new Set<() => void>();
    const onChange = () => {
      for (const notify of [...listeners]) notify();
    };
    mql.addEventListener("change", onChange);
    entry = { mql, listeners, onChange };
    mediaPool.set(query, entry);
  }
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size) {
      entry.mql.removeEventListener("change", entry.onChange);
      mediaPool.delete(query);
    }
  };
}

export function getGlobalListenerStats(target: GlobalTarget): { nativeCount: number; subscriberCount: number; byKey: Record<string, number> } {
  const buckets = targetBuckets.get(target);
  if (!buckets) return { nativeCount: 0, subscriberCount: 0, byKey: {} };
  const byKey: Record<string, number> = {};
  let subscriberCount = 0;
  for (const [key, bucket] of buckets.entries()) {
    byKey[key] = bucket.registrations.length;
    subscriberCount += bucket.registrations.length;
  }
  return { nativeCount: buckets.size, subscriberCount, byKey };
}
