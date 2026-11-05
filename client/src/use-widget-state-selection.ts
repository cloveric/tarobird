import { useLayoutEffect, useRef, useState } from "react";
import { discardWidgetStateOwner, flushWidgetStateOwner, hasWidgetStateSessions } from "./widget-state-lifecycle.js";

/** Delay only the conversation commit, never draft/recipient state separately.
 * External permission loss bypasses the grace period and tears down immediately. */
export function useWidgetStateSelection(requested: string, identity: string, canRetain: (selected: string) => boolean) {
  const [owner, setOwner] = useState(() => ({ identity, token: crypto.randomUUID() }));
  const [selected, setSelected] = useState(requested);
  const latest = useRef({ requested, identity }); latest.current = { requested, identity };
  const allowed = canRetain(selected);
  const bypass = owner.identity !== identity || !allowed;
  // With no running frame, this is the same synchronous selection as before.
  if (selected !== requested && (!hasWidgetStateSessions(owner.token) || bypass)) setSelected(requested);
  useLayoutEffect(() => () => discardWidgetStateOwner(owner.token), [owner.token]);
  useLayoutEffect(() => {
    if (owner.identity !== identity) { discardWidgetStateOwner(owner.token); setOwner({ identity, token: crypto.randomUUID() }); return; }
    if (!allowed) { discardWidgetStateOwner(owner.token); return; }
    if (selected === requested) return;
    let current = true;
    void flushWidgetStateOwner(owner.token).then(() => {
      if (current && latest.current.identity === identity && latest.current.requested === requested) setSelected(requested);
    });
    return () => { current = false; };
  }, [requested, selected, identity, allowed, owner]);
  return { selected: bypass ? requested : selected, owner: owner.token };
}
