import { forwardedBlocks, messageAttachmentIds } from "../../src/client-protocol/forwarding.js";
import type { Block, ClientFrame, Message } from "../../src/client-protocol/index.js";
import type { ConnectionState, HubConnection } from "./connection.js";
import { t } from "./i18n.js";

export type OutboxViewItem = {
  id: string;
  order: number;
  frame: ClientFrame;
  copyable: boolean;
  text: string;
  expired: boolean;
  error?: string;
  blocked: boolean;
  sent: boolean;
  syncing: boolean;
};

export type PendingPreviewScope = Pick<HubConnection, "isClosed">;

type RememberedAttachmentMeta =
  | { kind: "image"; title?: string }
  | { kind: "audio"; name?: string }
  | { kind: "file"; name: string; size: number; mime: string };

type ForwardedPreviewMeta = Pick<Message, "blocks" | "forwardedFrom" | "previewUrl" | "previewStyle" | "linkPreview">;
type ForwardAuthorDirectory = Pick<ConnectionState, "bots" | "deletedBots" | "dispatchWorkers" | "user">;

const MAX_REMEMBERED_ATTACHMENTS = 256;
const MAX_REMEMBERED_FORWARDS = 128;
const uploadedAttachments = new WeakMap<PendingPreviewScope, Map<string, RememberedAttachmentMeta>>();
const forwardedPreviews = new WeakMap<PendingPreviewScope, Map<string, ForwardedPreviewMeta>>();

function scopeCache<V>(store: WeakMap<PendingPreviewScope, Map<string, V>>, connection: PendingPreviewScope): Map<string, V> {
  let cache = store.get(connection);
  if (!cache) {
    cache = new Map();
    store.set(connection, cache);
  }
  return cache;
}

function rememberBounded<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Stable React/virtualizer key for a message row that survives the pending
 * (clientMsgId) to canonical (msg_...) ID transition. Scoped by authorId to
 * match Hub's UNIQUE(author_id, client_msg_id) constraint. */
export function messageRowKey(message: Pick<Message, "id" | "authorType" | "authorId" | "clientMsgId">): string {
  return message.authorType === "user" && message.clientMsgId
    ? `user:${message.authorId}:${message.clientMsgId}`
    : message.id;
}

/** Match Hub's forwardMessage authorName resolution so a pending forwarded
 * bubble shows the same origin label as the canonical message. */
export function forwardedAuthorName(
  source: Pick<Message, "authorId" | "authorType" | "botSource">,
  state: ForwardAuthorDirectory,
  fallbackBots?: readonly { id: string; name: string }[],
): string {
  if (source.botSource) return `${source.botSource.botName} · ${source.botSource.hostName}`;
  if (source.authorType === "bot") {
    const bots = [...state.bots, ...(state.deletedBots ?? []), ...(state.dispatchWorkers ?? []), ...(fallbackBots ?? [])];
    return bots.find((bot) => bot.id === source.authorId)?.name ?? source.authorId;
  }
  if (source.authorType === "user") {
    return source.authorId === state.user?.id ? (state.user?.name ?? source.authorId) : source.authorId;
  }
  return source.authorId;
}

/** Remember uploaded attachment metadata so a pending bubble renders the same
 * image, audio, or file card as the canonical message before history refreshes. */
export function rememberUploadedAttachment(
  connection: PendingPreviewScope,
  attachmentId: string,
  file: { name: string; size: number; type: string },
) {
  const mime = file.type.split(";")[0] || "application/octet-stream";
  const meta: RememberedAttachmentMeta =
    mime.startsWith("image/") ? { kind: "image", title: file.name }
    : mime.startsWith("audio/") ? { kind: "audio", name: file.name }
    : { kind: "file", name: file.name, size: file.size, mime };
  rememberBounded(scopeCache(uploadedAttachments, connection), attachmentId, meta, MAX_REMEMBERED_ATTACHMENTS);
}

/** Remember attachment block metadata from an existing message before resending
 * its attachment IDs so the pending retry renders the exact media/file card. */
export function rememberMessageAttachments(connection: PendingPreviewScope, blocks: readonly Block[]) {
  const cache = scopeCache(uploadedAttachments, connection);
  for (const block of blocks) {
    if (block.type === "image") {
      rememberBounded(cache, block.attachmentId, { kind: "image", ...(block.title !== undefined ? { title: block.title } : {}) }, MAX_REMEMBERED_ATTACHMENTS);
    } else if (block.type === "audio") {
      rememberBounded(cache, block.attachmentId, { kind: "audio", ...(block.name !== undefined ? { name: block.name } : {}) }, MAX_REMEMBERED_ATTACHMENTS);
    } else if (block.type === "file") {
      rememberBounded(cache, block.attachmentId, { kind: "file", name: block.name, size: block.size, mime: block.mime }, MAX_REMEMBERED_ATTACHMENTS);
    }
  }
}

/** Remember forwarded message content so a pending forward renders in its final
 * forwarded-bubble layout before the Hub event reaches local history. */
export function rememberForwardedMessage(
  connection: PendingPreviewScope,
  clientMsgId: string,
  source: Message,
  sourceConversationTitle?: string,
  sourceAuthorName?: string,
) {
  const identityAttachments = new Map<string, string>();
  for (const id of messageAttachmentIds(source.blocks)) identityAttachments.set(id, id);
  if (source.linkPreview?.imageAttachmentId) {
    identityAttachments.set(source.linkPreview.imageAttachmentId, source.linkPreview.imageAttachmentId);
  }
  rememberBounded(scopeCache(forwardedPreviews, connection), clientMsgId, {
    blocks: forwardedBlocks(source.blocks, identityAttachments),
    forwardedFrom: {
      messageId: source.id,
      conversationId: source.conversationId,
      conversationTitle: sourceConversationTitle ?? "",
      authorName: (sourceAuthorName ?? "").slice(0, 256),
      createdAt: source.createdAt,
    },
    ...(source.previewUrl !== undefined ? { previewUrl: source.previewUrl } : {}),
    ...(source.previewStyle ? { previewStyle: source.previewStyle } : {}),
    ...(source.linkPreview ? { linkPreview: source.linkPreview } : {}),
  }, MAX_REMEMBERED_FORWARDS);
}

/** Release all cached pending attachment/forward previews for a closed or forgotten host. */
export function clearRememberedPendingPreviews(connection: PendingPreviewScope) {
  uploadedAttachments.delete(connection);
  forwardedPreviews.delete(connection);
}

export function pendingMessageBlocks(
  connection: PendingPreviewScope,
  frame: Extract<ClientFrame, { type: "message.send" }>,
): Block[] {
  const blocks: Block[] = frame.text ? [{ type: "text", text: frame.text }] : [];
  const attachments = uploadedAttachments.get(connection);
  for (const id of frame.attachments ?? []) {
    const meta = attachments?.get(id);
    if (!meta) {
      blocks.push({ type: "file", attachmentId: id, name: t("附件"), size: 0, mime: "application/octet-stream" });
      continue;
    }
    if (meta.kind === "image") {
      blocks.push({ type: "image", attachmentId: id, ...(meta.title !== undefined ? { title: meta.title } : {}) });
    } else if (meta.kind === "audio") {
      blocks.push({ type: "audio", attachmentId: id, ...(meta.name !== undefined ? { name: meta.name } : {}) });
    } else {
      blocks.push({ type: "file", attachmentId: id, name: meta.name, size: meta.size, mime: meta.mime });
    }
  }
  return blocks;
}

/** Split outbox items into normal online message bubbles (rendered seamlessly in
 * the message list) and attention-needing rows (failed, blocked, or offline). */
export function partitionOutboxItems<T extends OutboxViewItem>(
  connection: PendingPreviewScope,
  queued: readonly T[],
  messages: readonly Message[],
  online: boolean,
  authorId: string,
): { pendingMessages: Message[]; pendingById: Map<string, T>; attentionQueued: T[] } {
  const existing = new Set<string>();
  for (const message of messages) {
    if (message.authorType === "user" && message.authorId === authorId && message.clientMsgId) {
      existing.add(message.clientMsgId);
    }
  }
  const pendingMessages: Message[] = [];
  const pendingById = new Map<string, T>();
  const attentionQueued: T[] = [];
  const forwards = forwardedPreviews.get(connection);

  for (const item of queued) {
    if (!item.error && existing.has(item.id)) continue;
    const isMessage = item.frame.type === "message.send" || item.frame.type === "message.forward";
    const needsAttention = !!item.error || item.blocked || (!online && !item.sent && !item.syncing);
    if (needsAttention) {
      attentionQueued.push(item);
      continue;
    }
    if (!isMessage) continue;
    let message: Message;
    if (item.frame.type === "message.send") {
      const frame = item.frame;
      message = {
        id: item.id,
        conversationId: frame.conversationId,
        authorId,
        authorType: "user",
        blocks: pendingMessageBlocks(connection, frame),
        status: "pending",
        version: 1,
        clientMsgId: frame.clientMsgId,
        ...(frame.mentions?.length ? { mentions: frame.mentions } : {}),
        ...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
        ...(frame.previewUrl !== undefined ? { previewUrl: frame.previewUrl } : {}),
        ...(frame.previewUrl && frame.previewStyle ? { previewStyle: frame.previewStyle } : {}),
        createdAt: item.order,
      };
    } else if (item.frame.type === "message.forward") {
      const frame = item.frame;
      const preview = forwards?.get(item.id);
      message = {
        id: item.id,
        conversationId: frame.conversationId,
        authorId,
        authorType: "user",
        blocks: preview?.blocks ?? [{ type: "text", text: t("转发消息") }],
        status: "pending",
        version: 1,
        clientMsgId: frame.clientMsgId,
        ...(frame.mentions?.length ? { mentions: frame.mentions } : {}),
        ...(preview?.forwardedFrom ? { forwardedFrom: preview.forwardedFrom } : {}),
        ...(preview?.previewUrl !== undefined ? { previewUrl: preview.previewUrl } : {}),
        ...(preview?.previewStyle ? { previewStyle: preview.previewStyle } : {}),
        ...(preview?.linkPreview ? { linkPreview: preview.linkPreview } : {}),
        createdAt: item.order,
      };
    } else {
      continue;
    }
    pendingMessages.push(message);
    pendingById.set(item.id, item);
  }
  return { pendingMessages, pendingById, attentionQueued };
}
