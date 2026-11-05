import { decodeBase64 } from "../../src/client-protocol/base64.js";
import { z } from "zod";
import { assertMessageTextSize } from "./message-validation.js";
import { idSchema, textSchema, fileSizeSchema, type ClientFrame } from "../../src/client-protocol/index.js";
import type { UploadSource } from "./files.js";

// mentions is optional: group/topic shares pin the chosen reply Bots, direct and legacy pins carry none.
export const shareDeliverySchema = z.object({ hubKey: z.string().min(1).max(512), deviceId: idSchema, conversationId: idSchema, text: textSchema, mentions: z.array(idSchema).min(1).max(64).optional() });
export const sharedItemSchema = z.object({
  id: z.string().uuid(), createdAt: z.number().finite(), text: textSchema,
  files: z.array(z.object({ name: z.string().min(1).max(255), type: z.string().max(200), size: fileSizeSchema })).max(64),
  error: z.string().max(500).optional(), delivery: shareDeliverySchema.optional(),
});
export type SharedItem = z.infer<typeof sharedItemSchema>;
export type ShareDelivery = z.infer<typeof shareDeliverySchema>;
// Editable local review state is separate from the immutable native delivery
// receipt. Merely saving a draft must never prepare or send a share.
export { shareDraftSchema, type ShareDraft, type SavedShareDraft } from "../../src/client-protocol/share-drafts.js";
export interface ShareBridge {
  setMaxFileBytes(options: { maxFileBytes: number }): Promise<void>;
  list(): Promise<{ items: unknown[] }>;
  prepare(options: { id: string; delivery: ShareDelivery }): Promise<unknown>;
  readChunk(options: { id: string; index: number; offset: number; length: number }): Promise<{ data: string }>;
  remove(options: { id: string }): Promise<void>;
  clear(): Promise<void>;
}
/** Native bridge transfers stay bounded even while the upload layer uses 8 MiB chunks. */
export function sharedFile(native: ShareBridge, item: SharedItem, index: number): UploadSource {
  const file = item.files[index]; if (!file) throw new Error("share_file_missing");
  return { ...file, async readChunk(start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > file.size) throw new Error("share_chunk_invalid");
    const chunks: BlobPart[] = [];
    for (let offset = start; offset < end; offset += 1024 * 1024) {
      const length = Math.min(1024 * 1024, end - offset);
      const { data } = await native.readChunk({ id: item.id, index, offset, length });
      if (data.length > Math.ceil(length / 3) * 4) throw new Error("share_chunk_invalid");
      const decoded = decodeBase64(data);
      if (decoded.length !== length) throw new Error("share_file_changed");
      chunks.push(decoded);
    }
    return new Blob(chunks, { type: file.type });
  } };
}
/** Every field, mentions by value and order. A legacy pin without mentions never matches a request that adds them:
 * the Hub answers a repeated clientMsgId with the first message, so a changed retry would silently mean something else. */
export function sameDelivery(a: ShareDelivery, b: ShareDelivery): boolean {
  const left = a.mentions ?? [], right = b.mentions ?? [];
  return a.hubKey === b.hubKey && a.deviceId === b.deviceId && a.conversationId === b.conversationId && a.text === b.text
    && left.length === right.length && left.every((id, index) => id === right[index]);
}
/** Persist the destination BEFORE any upload. A lost local acknowledgement reuses the same message ID. */
export async function sendSharedItem(native: ShareBridge, item: SharedItem, delivery: ShareDelivery,
  upload: (file: UploadSource, index: number) => Promise<string>, send: (frame: ClientFrame) => Promise<void>): Promise<void> {
  assertMessageTextSize(delivery.text);
  shareDeliverySchema.parse(delivery);
  if (item.error || (!delivery.text.trim() && !item.files.length)) throw new Error("share_empty_or_invalid");
  const pinned = sharedItemSchema.parse(await native.prepare({ id: item.id, delivery }));
  if (pinned.id !== item.id || !pinned.delivery || !sameDelivery(pinned.delivery, delivery)) throw new Error("share_destination_changed");
  const { conversationId, text, mentions } = pinned.delivery;
  const attachments: string[] = [];
  for (let index = 0; index < pinned.files.length; index++) attachments.push(await upload(sharedFile(native, pinned, index), index));
  await send({ v: 1, type: "message.send", clientMsgId: `share_${item.id}`, conversationId, text, attachments, ...(mentions ? { mentions } : {}) });
  // send resolves only after the browser outbox has durably stored the frame.
  await native.remove({ id: item.id });
}
