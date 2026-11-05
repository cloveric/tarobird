type PinFocus = {
  owner: string; id: string; value: boolean; scope: "group" | "global";
  root: HTMLElement; trigger: HTMLElement; until: number;
};
const pending = new Map<string, PinFocus>();

/** A pin can move a row between independently mounted list slices. The new
 * owner restores focus only after its accepted data and DOM have committed. */
export function beginPinFocus(owner: string | undefined, id: string, value: boolean, scope: PinFocus["scope"], trigger: HTMLElement | null): PinFocus | undefined {
  const root = trigger?.closest<HTMLElement>(".host-directory") ?? trigger?.closest<HTMLElement>(".mobile-home") ?? trigger?.closest<HTMLElement>(".conversation-list");
  if (!owner || !trigger || !root) return;
  const intent = { owner, id, value, scope, root, trigger, until: Date.now() + 2000 };
  pending.set(owner, intent);
  setTimeout(() => cancelPinFocus(intent), 2000);
  return intent;
}

export function cancelPinFocus(intent: PinFocus | undefined): void {
  if (intent && pending.get(intent.owner) === intent) pending.delete(intent.owner);
}

export function restorePinFocus(owner: string | undefined, pins: readonly string[], globalPins: readonly string[], fallback: (id: string, scopes: HTMLElement[]) => HTMLElement | undefined): void {
  const intent = owner ? pending.get(owner) : undefined;
  if (!intent) return;
  if (Date.now() > intent.until || !intent.root.isConnected || !intent.root.getClientRects().length) { cancelPinFocus(intent); return; }
  if ((intent.scope === "global" ? globalPins : pins).includes(intent.id) !== intent.value) return;
  const focused = document.activeElement;
  // A user who moved to another row, the composer or another surface owns the
  // new focus. Staying inside the same directory is still a deliberate move.
  // A menu is a portal, so let its cleanup finish before attempting restoration.
  if (focused?.closest('[role="menu"], [role="dialog"], dialog')) return;
  if (focused && focused !== document.body && focused !== intent.trigger) { cancelPinFocus(intent); return; }
  const scopes = [...intent.root.querySelectorAll<HTMLElement>("[data-pin-scope]")].filter(node => node.dataset.pinScope === owner && node.getClientRects().length);
  if (intent.root.dataset.pinScope === owner) scopes.push(intent.root);
  const target = scopes.flatMap(node => node.matches("[data-conversation-id]") ? [node] : [...node.querySelectorAll<HTMLElement>("[data-conversation-id]")])
    .find(node => node.dataset.conversationId === intent.id && node.getClientRects().length)
    ?? fallback(intent.id, scopes);
  if (!target) return;
  cancelPinFocus(intent);
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
}
