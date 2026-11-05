import { describe, expect, it, vi } from "vitest";

import {
  sendManagedCard,
  settleThenUpdateManagedCard,
  updateManagedCard,
  updateManagedCardElement,
  type ManagedCardHandle,
} from "../src/core/managed-card.js";
import { managedCardPort } from "./helpers/core-compat-channel.js";

function nativeAppChannel(overrides: Record<string, unknown> = {}) {
  return {
    profile: "gateway" as const,
    send: vi.fn(async () => ({ messageId: "msg_native" })),
    updateCard: vi.fn(async (_messageId: string, _card: object) => undefined),
    ...overrides,
  };
}

describe("core managed card port", () => {
  it("forwards the chat, card and reply options to the explicit managed-card port", async () => {
    const cards = managedCardPort({ messageId: "om_reply", cardId: "card_abc" });
    const handle = await sendManagedCard({ managedCards: cards.port }, "oc_chat", { schema: "2.0" }, { replyTo: "om_src", replyInThread: true });

    expect(cards.send).toHaveBeenCalledWith("oc_chat", { schema: "2.0" }, { replyTo: "om_src", replyInThread: true });
    expect(handle).toEqual({ messageId: "om_reply", cardId: "card_abc", sequence: 0 });
  });

  it("never discovers a managed-card client from other channel fields", async () => {
    const create = vi.fn(async () => ({ data: { card_id: "card_should_not_exist" } }));
    const channel = { send: vi.fn(), rawClient: { cardkit: { v1: { card: { create, update: create } } } } };
    const handle: ManagedCardHandle = { messageId: "om", cardId: "card", sequence: 5 };

    expect(await sendManagedCard(channel, "oc_chat", { schema: "2.0" })).toBeUndefined();
    expect(await updateManagedCard(channel, handle, { schema: "2.0" })).toBe(false);
    expect(await updateManagedCardElement(channel, handle, "md_0", "x")).toBe(false);
    expect(handle.sequence).toBe(5);
    expect(create).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("delegates whole-card and element updates to the port and reports its failures", async () => {
    const cards = managedCardPort({
      update: vi.fn(async () => { throw new Error("card too big"); }),
      updateElement: vi.fn(async () => false),
    });
    const handle: ManagedCardHandle = { messageId: "om_1", cardId: "card_1", sequence: 3 };

    expect(await updateManagedCard({ managedCards: cards.port }, handle, { v: "full" })).toBe(false);
    expect(await updateManagedCardElement({ managedCards: cards.port }, handle, "md_0", "你好。")).toBe(false);
    expect(cards.update).toHaveBeenCalledWith(handle, { v: "full" });
    expect(cards.updateElement).toHaveBeenCalledWith(handle, "md_0", "你好。");

    cards.update.mockResolvedValueOnce(undefined);
    cards.updateElement.mockResolvedValueOnce(true);
    expect(await updateManagedCard({ managedCards: cards.port }, handle, { v: "compact" })).toBe(true);
    expect(await updateManagedCardElement({ managedCards: cards.port }, handle, "md_0", "你好。")).toBe(true);
  });

  it("does not stream element updates into a native App handle", async () => {
    const channel = nativeAppChannel();
    const handle: ManagedCardHandle = { messageId: "msg_native", cardId: "msg_native", sequence: 0, native: true };

    expect(await updateManagedCardElement(channel, handle, "md_0", "x")).toBe(false);
    expect(channel.updateCard).not.toHaveBeenCalled();
  });
});

describe("core managed card native App handles", () => {
  it("sends a native App card and updates it in place with an advancing sequence", async () => {
    const channel = nativeAppChannel();
    const handle = await sendManagedCard(channel, "gw_chat", { v: 0 }, { replyTo: "msg_src" });

    expect(channel.send).toHaveBeenCalledWith("gw_chat", { card: { v: 0 } }, { replyTo: "msg_src" });
    expect(handle).toEqual({ messageId: "msg_native", cardId: "msg_native", sequence: 0, native: true });
    expect(await updateManagedCard(channel, handle!, { v: 1 })).toBe(true);
    expect(await updateManagedCard(channel, handle!, { v: 2 })).toBe(true);
    expect(handle!.sequence).toBe(2);
    expect(channel.updateCard).toHaveBeenLastCalledWith("msg_native", { v: 2 });
  });

  it("serializes concurrent updates to the same native card so delivery stays in order", async () => {
    const deliveryOrder: number[] = [];
    const channel = nativeAppChannel({
      updateCard: vi.fn(async (_messageId: string, card: { v: number }) => {
        await new Promise((resolve) => setTimeout(resolve, card.v === 1 ? 60 : 5));
        deliveryOrder.push(card.v);
      }),
    });
    const handle: ManagedCardHandle = { messageId: "msg", cardId: "msg", sequence: 0, native: true };

    const [a, b] = await Promise.all([
      updateManagedCard(channel, handle, { v: 1 }),
      updateManagedCard(channel, handle, { v: 2 }),
    ]);

    expect([a, b]).toEqual([true, true]);
    expect(deliveryOrder).toEqual([1, 2]);
    expect(handle.sequence).toBe(2);
  });

  it("advances the native sequence even when an update attempt fails", async () => {
    const updateCard = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("rejected"));
    const channel = nativeAppChannel({ updateCard });
    const handle: ManagedCardHandle = { messageId: "msg", cardId: "msg", sequence: 0, native: true };

    expect(await updateManagedCard(channel, handle, { v: "full" })).toBe(false);
    expect(handle.sequence).toBe(1);
    expect(await updateManagedCard(channel, handle, { v: "compact" })).toBe(true);
    expect(handle.sequence).toBe(2);
  });

  it("returns undefined when a native send fails, but never hides an explicit shutdown", async () => {
    const failing = nativeAppChannel({ send: vi.fn(async () => { throw new Error("upload failed"); }) });
    expect(await sendManagedCard(failing, "gw_chat", { v: 0 })).toBeUndefined();

    const stopped = nativeAppChannel({ send: vi.fn(async () => { throw new Error("gateway_stopped"); }) });
    await expect(sendManagedCard(stopped, "gw_chat", { v: 0 })).rejects.toThrow("gateway_stopped");
  });
});

describe("settleThenUpdateManagedCard (post-interaction in-place update)", () => {
  it("returns synchronously, then updates after the settle delay; no failure callback on success", async () => {
    const cards = managedCardPort();
    const handle: ManagedCardHandle = { messageId: "om", cardId: "card_s", sequence: 0 };
    const onFailure = vi.fn(async () => undefined);

    settleThenUpdateManagedCard({ managedCards: cards.port }, handle, { v: 1 }, onFailure, 50);
    expect(cards.update).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(cards.update).toHaveBeenCalledTimes(1));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("runs the failure callback when the settled update fails", async () => {
    const cards = managedCardPort({ update: vi.fn(async () => { throw new Error("rejected"); }) });
    const handle: ManagedCardHandle = { messageId: "om", cardId: "card_s", sequence: 0 };
    const onFailure = vi.fn(async () => undefined);

    settleThenUpdateManagedCard({ managedCards: cards.port }, handle, { v: 1 }, onFailure, 0);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
  });
});
