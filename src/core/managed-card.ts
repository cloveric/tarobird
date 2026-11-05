import type { CoreChannelLike } from "./types.js";
export interface ManagedCardHandle {
  messageId: string;
  cardId: string;
  sequence: number;
  /** Native client messages support the same lifecycle without a CardKit object. */
  native?: boolean;
  /** Internal: serializes update delivery per card. Set by updateManagedCard;
   * callers should not touch it. */
  updateChain?: Promise<void>;
}

export interface ManagedCardSendOptions {
  replyTo?: string;
  replyInThread?: boolean;
}

export interface ManagedCardTransport {
 send(chatId: string, card: object, options: ManagedCardSendOptions): Promise<ManagedCardHandle | undefined>;
 update(handle: ManagedCardHandle, card: object): Promise<boolean>;
 updateElement(handle: ManagedCardHandle, elementId: string, content: string): Promise<boolean>;
}
export async function sendManagedCard(channel: unknown, chatId: string, card: object, options: ManagedCardSendOptions = {}): Promise<ManagedCardHandle | undefined> {
 const port = channel as CoreChannelLike;
 if (port.managedCards) return port.managedCards.send(chatId, card, options);
 if (port.profile !== "gateway") return undefined;
 try { const result = await port.send(chatId, { card }, options); return { messageId: result.messageId, cardId: result.messageId, sequence: 0, native: true }; }
 catch (error) { if (error instanceof Error && error.message === "gateway_stopped") throw error; return undefined; }
}
export async function updateManagedCard(channel: unknown, handle: ManagedCardHandle, card: object): Promise<boolean> {
 const port = channel as CoreChannelLike;
 if (port.managedCards) return port.managedCards.update(handle, card);
 if (!handle.native || !port.updateCard) return false;
 let result = false;
 const next = (handle.updateChain ?? Promise.resolve()).then(async () => { handle.sequence++; try { await port.updateCard!(handle.messageId, card); result = true; } catch {} });
 handle.updateChain = next.catch(() => {}); await next; return result;
}
export async function updateManagedCardElement(channel: unknown, handle: ManagedCardHandle, elementId: string, content: string): Promise<boolean> {
 return (channel as CoreChannelLike).managedCards?.updateElement(handle, elementId, content) ?? false;
}
export const MANAGED_CARD_SETTLE_MS = 1000;

/**
 * Schedule a terminal in-place update of a just-interacted managed card: returns
 * synchronously (so the caller can return from the cardAction handler and let
 * Lark release the card's post-interaction lock), then after MANAGED_CARD_SETTLE_MS
 * runs updateManagedCard. If the update doesn't land, runs `onFailure` (e.g. post
 * a fresh notice + recall the stale card). See MANAGED_CARD_SETTLE_MS for why.
 */
export function settleThenUpdateManagedCard(
  channel: unknown,
  handle: ManagedCardHandle,
  cardSpec: object,
  onFailure?: () => Promise<void>,
  settleMs: number = MANAGED_CARD_SETTLE_MS,
): void {
  void (async () => {
    if (settleMs > 0 && !handle.native) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, settleMs);
        timer.unref?.();
      });
    }
    const updated = await updateManagedCard(channel, handle, cardSpec);
    if (!updated && onFailure) {
      await onFailure();
    }
  })().catch(() => {
    // Best-effort terminal card update — onFailure itself can reject (e.g. the
    // fallback channel.send fails). Swallow so a transient Lark API hiccup during
    // this detached, fire-and-forget update can't become an unhandled rejection.
  });
}
