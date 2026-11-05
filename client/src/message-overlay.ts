import { createContext, useCallback, useContext, useLayoutEffect, useState } from "react";

/** Keep a message's portalled reader mounted while the timeline virtualizes. */
export const MessageOverlayContext = createContext<(id: string) => () => void>(() => () => {});
// Readers nested in cards, Markdown or file bundles share their owning row.
// Outside a timeline (for example File Center) no retention is necessary.
export const MessageOverlayOwnerContext = createContext<string | undefined>(undefined);
export function useMessageReader(open: boolean) {
  const id = useContext(MessageOverlayOwnerContext);
  useMessageOverlay(id ?? "", open && id !== undefined);
}
export function useMessageOverlay(id: string, open: boolean) {
  const retain = useContext(MessageOverlayContext);
  useLayoutEffect(() => open ? retain(id) : undefined, [id, open, retain]);
}
export function useMessageOverlayRows() {
  const [rows, setRows] = useState<ReadonlyMap<string, number>>(() => new Map());
  const retain = useCallback((id: string) => {
    setRows(previous => new Map(previous).set(id, (previous.get(id) ?? 0) + 1));
    return () => setRows(previous => {
      const next = new Map(previous), count = (next.get(id) ?? 1) - 1;
      if (count > 0) next.set(id, count); else next.delete(id);
      return next;
    });
  }, []);
  return { rows, retain };
}
