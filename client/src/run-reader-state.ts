import { useContext, useLayoutEffect, useState } from "react";
import { MessageOverlayContext } from "./message-overlay.js";

type Reader = { key: string; kind: "report" | "process" };
type Lease = { value: Reader | undefined };
const readers = new WeakMap<object, Map<string, Lease>>();

/** A grouped member can become a standalone report in the same render. Hand
 * its existing reader to the new instance, within this timeline only. Dispose
 * after that commit if nobody takes over: leaving a chat must not reopen it. */
export function useRunReaderState(key: string) {
  const timeline = useContext(MessageOverlayContext);
  let registry = readers.get(timeline);
  if (!registry) { registry = new Map(); readers.set(timeline, registry); }
  const [opened, open] = useState<Reader | undefined>(() => registry.get(key)?.value);
  useLayoutEffect(() => {
    const lease = { value: opened?.key === key ? opened : undefined };
    registry.set(key, lease);
    return () => { queueMicrotask(() => { if (registry.get(key) === lease) registry.delete(key); }); };
  }, [registry, key, opened]);
  return [opened, open] as const;
}
