import { Readable } from "node:stream";

import { vi } from "vitest";

import type { ManagedCardHandle, ManagedCardSendOptions, ManagedCardTransport } from "../../src/core/managed-card.js";

/**
 * Explicit Core channel ports for fixtures that previously relied on an optional
 * transport deriving them from an SDK-shaped `rawClient` mock. These helpers only
 * adapt existing mocks to the neutral port contract: nothing is discovered,
 * authenticated, spawned or sent over a network.
 */

type SendManagedCard = (chatId: string, card: object, options: ManagedCardSendOptions) => Promise<ManagedCardHandle | undefined>;
type UpdateManagedCard = (handle: ManagedCardHandle, card: object) => Promise<unknown>;
type UpdateManagedCardElement = (handle: ManagedCardHandle, elementId: string, content: string) => Promise<unknown>;

function recorded<T extends (...args: never[]) => unknown>(fn: T) {
  return vi.isMockFunction(fn) ? fn : vi.fn(fn);
}

/**
 * Managed-card port backed by recording mocks. Calls are `send(chatId, card, options)`,
 * `update(handle, card)` and `updateElement(handle, elementId, content)`. A mock that
 * rejects or resolves `false` reports an unsuccessful send/update, as the port
 * contract requires; any other resolution is a successful update.
 */
export function managedCardPort(options: {
  messageId?: string;
  cardId?: string;
  send?: SendManagedCard;
  update?: UpdateManagedCard;
  updateElement?: UpdateManagedCardElement;
} = {}) {
  const send = recorded<SendManagedCard>(options.send ?? (async () => ({
    messageId: options.messageId ?? "om_card",
    cardId: options.cardId ?? "card_live",
    sequence: 0,
  })));
  const update = recorded<UpdateManagedCard>(options.update ?? (async () => true));
  const updateElement = recorded<UpdateManagedCardElement>(options.updateElement ?? (async () => true));
  const succeeded = async (work: () => Promise<unknown>): Promise<boolean> => {
    try {
      return (await work()) !== false;
    } catch {
      return false;
    }
  };
  const port: ManagedCardTransport = {
    send: async (chatId, card, sendOptions) => {
      try {
        return await send(chatId, card, sendOptions);
      } catch {
        return undefined;
      }
    },
    update: (handle, card) => succeeded(() => update(handle, card)),
    updateElement: (handle, elementId, content) => succeeded(() => updateElement(handle, elementId, content)),
  };
  return { port, send, update, updateElement };
}

/** `downloadMessageResource` port returning the same bytes for every resource. */
export function messageResourcePort(body: Buffer | string = "resource-bytes") {
  return vi.fn(async (_messageId: string, _fileKey: string, _type: "image" | "file") => Readable.from([Buffer.from(body)]));
}
