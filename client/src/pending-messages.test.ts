import { describe, expect, it } from "vitest";
import type { Message } from "../../src/client-protocol/index.js";
import {
  clearRememberedPendingPreviews,
  forwardedAuthorName,
  messageRowKey,
  partitionOutboxItems,
  pendingMessageBlocks,
  rememberForwardedMessage,
  rememberMessageAttachments,
  rememberUploadedAttachment,
  type OutboxViewItem,
  type PendingPreviewScope,
} from "./pending-messages.js";

function scope(): PendingPreviewScope {
  return { isClosed: false };
}

function sendItem(overrides: Partial<OutboxViewItem> = {}): OutboxViewItem {
  const id = overrides.id ?? "client_1";
  return {
    id,
    order: 1700000000100,
    frame: {
      v: 1,
      type: "message.send",
      clientMsgId: id,
      conversationId: "conv_1",
      text: "Hello",
      attachments: [],
    },
    copyable: true,
    text: "Hello",
    expired: false,
    blocked: false,
    sent: false,
    syncing: false,
    ...overrides,
  };
}

function forwardItem(overrides: Partial<OutboxViewItem> = {}): OutboxViewItem {
  const id = overrides.id ?? "forward_1";
  return {
    id,
    order: 1700000000200,
    frame: {
      v: 1,
      type: "message.forward",
      clientMsgId: id,
      conversationId: "conv_2",
      sourceMessageId: "msg_src",
    },
    copyable: false,
    text: "转发消息",
    expired: false,
    blocked: false,
    sent: false,
    syncing: false,
    ...overrides,
  };
}

function cardItem(overrides: Partial<OutboxViewItem> = {}): OutboxViewItem {
  const id = overrides.id ?? "action_1";
  return {
    id,
    order: 1700000000300,
    frame: {
      v: 1,
      type: "interaction.submit",
      clientActionId: id,
      conversationId: "conv_1",
      messageId: "msg_card",
      actionId: "approve",
      values: {},
    },
    copyable: false,
    text: "卡片操作",
    expired: false,
    blocked: false,
    sent: false,
    syncing: false,
    ...overrides,
  };
}

describe("partitionOutboxItems", () => {
  it("renders normal online message.send directly as a user bubble with no attention row", () => {
    const conn = scope();
    rememberUploadedAttachment(conn, "att_img", { name: "photo.png", size: 120, type: "image/png" });
    rememberUploadedAttachment(conn, "att_doc", { name: "notes.txt", size: 42, type: "text/plain" });
    const item = sendItem({
      frame: {
        v: 1,
        type: "message.send",
        clientMsgId: "client_1",
        conversationId: "conv_1",
        text: "Check https://example.com",
        attachments: ["att_img", "att_doc", "att_unknown"],
        replyTo: "msg_parent",
        previewUrl: "https://example.com",
        previewStyle: "card",
        mentions: ["bot_1"],
      },
    });
    const result = partitionOutboxItems(conn, [item], [], true, "owner");
    expect(result.attentionQueued).toEqual([]);
    expect(result.pendingMessages).toHaveLength(1);
    const msg = result.pendingMessages[0]!;
    expect(msg).toMatchObject({
      id: "client_1",
      clientMsgId: "client_1",
      conversationId: "conv_1",
      authorId: "owner",
      authorType: "user",
      replyTo: "msg_parent",
      previewUrl: "https://example.com",
      previewStyle: "card",
      mentions: ["bot_1"],
      status: "pending",
      createdAt: item.order,
    });
    expect(msg.blocks).toEqual([
      { type: "text", text: "Check https://example.com" },
      { type: "image", attachmentId: "att_img", title: "photo.png" },
      { type: "file", attachmentId: "att_doc", name: "notes.txt", size: 42, mime: "text/plain" },
      { type: "file", attachmentId: "att_unknown", name: "附件", size: 0, mime: "application/octet-stream" },
    ]);
    expect(result.pendingById.get("client_1")).toBe(item);
  });

  it("renders normal online message.forward with remembered source blocks and metadata", () => {
    const conn = scope();
    const source: Message = {
      id: "msg_src",
      conversationId: "conv_1",
      authorId: "bot_1",
      authorType: "bot",
      blocks: [
        { type: "text", text: "Forwarded body" },
        { type: "image", attachmentId: "att_1", title: "diagram.png" },
      ],
      status: "complete",
      version: 1,
      createdAt: 1700000000000,
    };
    rememberForwardedMessage(conn, "forward_1", source, "Source Chat", "Alpha Bot");
    const item = forwardItem();
    const result = partitionOutboxItems(conn, [item], [], true, "owner");
    expect(result.attentionQueued).toEqual([]);
    expect(result.pendingMessages).toHaveLength(1);
    expect(result.pendingMessages[0]).toMatchObject({
      id: "forward_1",
      clientMsgId: "forward_1",
      conversationId: "conv_2",
      authorType: "user",
      forwardedFrom: {
        messageId: "msg_src",
        conversationId: "conv_1",
        conversationTitle: "Source Chat",
        authorName: "Alpha Bot",
        createdAt: 1700000000000,
      },
      blocks: source.blocks,
    });
  });

  it("remembers image, audio, and file metadata from existing message blocks for resends", () => {
    const conn = scope();
    rememberMessageAttachments(conn, [
      { type: "text", text: "Resent" },
      { type: "image", attachmentId: "att_img", title: "shot.png" },
      { type: "image", attachmentId: "att_img_untitled" },
      { type: "audio", attachmentId: "att_voice", name: "voice.ogg" },
      { type: "audio", attachmentId: "att_voice_unnamed" },
      { type: "file", attachmentId: "att_pdf", name: "report.pdf", size: 2048, mime: "application/pdf" },
    ]);
    const blocks = pendingMessageBlocks(conn, {
      v: 1,
      type: "message.send",
      clientMsgId: "retry_1",
      conversationId: "conv_1",
      text: "Resent",
      attachments: ["att_img", "att_img_untitled", "att_voice", "att_voice_unnamed", "att_pdf"],
    });
    expect(blocks).toEqual([
      { type: "text", text: "Resent" },
      { type: "image", attachmentId: "att_img", title: "shot.png" },
      { type: "image", attachmentId: "att_img_untitled" },
      { type: "audio", attachmentId: "att_voice", name: "voice.ogg" },
      { type: "audio", attachmentId: "att_voice_unnamed" },
      { type: "file", attachmentId: "att_pdf", name: "report.pdf", size: 2048, mime: "application/pdf" },
    ]);
  });

  it("isolates remembered attachments and forwarded previews per host connection and clears them on close", () => {
    const hostA = scope();
    const hostB = scope();
    const source: Message = {
      id: "msg_src",
      conversationId: "conv_1",
      authorId: "bot_1",
      authorType: "bot",
      blocks: [{ type: "text", text: "Secret host A forward" }],
      status: "complete",
      version: 1,
      createdAt: 1700000000000,
    };
    rememberUploadedAttachment(hostA, "att_shared_id", { name: "host-a.png", size: 512, type: "image/png" });
    rememberForwardedMessage(hostA, "forward_1", source, "Host A Chat", "Host A Bot");

    const hostBSend = partitionOutboxItems(hostB, [sendItem({
      frame: { v: 1, type: "message.send", clientMsgId: "client_1", conversationId: "conv_1", text: "", attachments: ["att_shared_id"] },
    })], [], true, "owner");
    expect(hostBSend.pendingMessages[0]?.blocks).toEqual([
      { type: "file", attachmentId: "att_shared_id", name: "附件", size: 0, mime: "application/octet-stream" },
    ]);

    const hostBForward = partitionOutboxItems(hostB, [forwardItem()], [], true, "owner");
    expect(hostBForward.pendingMessages[0]?.blocks).toEqual([{ type: "text", text: "转发消息" }]);
    expect(hostBForward.pendingMessages[0]?.forwardedFrom).toBeUndefined();

    // Clearing hostA drops its cached content without affecting another host.
    rememberUploadedAttachment(hostB, "att_b", { name: "host-b.png", size: 64, type: "image/png" });
    clearRememberedPendingPreviews(hostA);
    const hostAAfterClear = partitionOutboxItems(hostA, [forwardItem()], [], true, "owner");
    expect(hostAAfterClear.pendingMessages[0]?.forwardedFrom).toBeUndefined();
    expect(pendingMessageBlocks(hostB, {
      v: 1, type: "message.send", clientMsgId: "c_b", conversationId: "conv_1", text: "", attachments: ["att_b"],
    })).toEqual([{ type: "image", attachmentId: "att_b", title: "host-b.png" }]);
  });

  it("tolerates legacy/migrated message.send frames that omit attachments", () => {
    const conn = scope();
    const legacyFrame = {
      v: 1 as const,
      type: "message.send" as const,
      clientMsgId: "legacy_1",
      conversationId: "conv_1",
      text: "Migrated message",
    } as unknown as Extract<OutboxViewItem["frame"], { type: "message.send" }>;
    expect(pendingMessageBlocks(conn, legacyFrame)).toEqual([{ type: "text", text: "Migrated message" }]);
    const result = partitionOutboxItems(conn, [sendItem({ id: "legacy_1", frame: legacyFrame })], [], true, "owner");
    expect(result.pendingMessages).toHaveLength(1);
    expect(result.pendingMessages[0]?.blocks).toEqual([{ type: "text", text: "Migrated message" }]);
  });

  it("hides normal online card actions while keeping offline, blocked, and failed actions in attentionQueued", () => {
    const conn = scope();
    const onlineCard = cardItem({ id: "action_online" });
    const onlineResult = partitionOutboxItems(conn, [onlineCard], [], true, "owner");
    expect(onlineResult.pendingMessages).toEqual([]);
    expect(onlineResult.attentionQueued).toEqual([]);

    const offlineCard = cardItem({ id: "action_offline" });
    const offlineResult = partitionOutboxItems(conn, [offlineCard], [], false, "owner");
    expect(offlineResult.pendingMessages).toEqual([]);
    expect(offlineResult.attentionQueued).toEqual([offlineCard]);

    const failedCard = cardItem({ id: "action_failed", error: "此卡片操作已失效，请查看最新卡片。", expired: true });
    const blockedMsg = sendItem({ id: "client_blocked", blocked: true });
    const failedResult = partitionOutboxItems(conn, [failedCard, blockedMsg], [], true, "owner");
    expect(failedResult.pendingMessages).toEqual([]);
    expect(failedResult.attentionQueued).toEqual([failedCard, blockedMsg]);
  });

  it("routes offline un-accepted sends to attentionQueued while keeping sent/syncing items in pendingMessages", () => {
    const conn = scope();
    const offlinePending = sendItem({ id: "c_offline" });
    const alreadySent = sendItem({ id: "c_sent", sent: true });
    const syncing = sendItem({ id: "c_syncing", syncing: true });
    const result = partitionOutboxItems(conn, [offlinePending, alreadySent, syncing], [], false, "owner");
    expect(result.attentionQueued).toEqual([offlinePending]);
    expect(result.pendingMessages.map((m) => m.id)).toEqual(["c_sent", "c_syncing"]);
  });

  it("deduplicates canonical history by (authorType, authorId, clientMsgId) matching Hub uniqueness", () => {
    const conn = scope();
    const item = sendItem({ id: "c_shared", sent: true });
    const otherUserCanonical: Message = {
      id: "msg_other",
      conversationId: "conv_1",
      authorId: "member_2",
      authorType: "user",
      blocks: [{ type: "text", text: "Other user's message" }],
      status: "complete",
      version: 1,
      clientMsgId: "c_shared",
      createdAt: 1700000000120,
    };
    const botWithSameClientId: Message = {
      id: "msg_bot",
      conversationId: "conv_1",
      authorId: "owner",
      authorType: "bot",
      blocks: [{ type: "text", text: "Bot message" }],
      status: "complete",
      version: 1,
      clientMsgId: "c_shared",
      createdAt: 1700000000125,
    };
    // Neither another user nor a bot message may suppress the local user's pending bubble.
    const stillPending = partitionOutboxItems(conn, [item], [otherUserCanonical, botWithSameClientId], true, "owner");
    expect(stillPending.pendingMessages).toHaveLength(1);
    expect(stillPending.pendingMessages[0]?.id).toBe("c_shared");

    const ownCanonical: Message = {
      id: "msg_99",
      conversationId: "conv_1",
      authorId: "owner",
      authorType: "user",
      blocks: [{ type: "text", text: "Hello" }],
      status: "complete",
      version: 1,
      clientMsgId: "c_shared",
      createdAt: 1700000000150,
    };
    const settled = partitionOutboxItems(conn, [item], [otherUserCanonical, ownCanonical], true, "owner");
    expect(settled.pendingMessages).toEqual([]);
    expect(settled.attentionQueued).toEqual([]);
  });
});

describe("messageRowKey", () => {
  it("scopes user keys by authorId and preserves identity across pending-to-canonical settlement", () => {
    const pendingOwner = { id: "c_1", authorType: "user" as const, authorId: "owner", clientMsgId: "c_1" };
    const canonicalOwner = { id: "msg_100", authorType: "user" as const, authorId: "owner", clientMsgId: "c_1" };
    const otherUserSameClientId = { id: "msg_101", authorType: "user" as const, authorId: "member_2", clientMsgId: "c_1" };
    const botMsg = { id: "msg_bot", authorType: "bot" as const, authorId: "bot_1", clientMsgId: "c_1" };
    const noClientId = { id: "msg_plain", authorType: "user" as const, authorId: "owner" };

    expect(messageRowKey(pendingOwner)).toBe("user:owner:c_1");
    expect(messageRowKey(canonicalOwner)).toBe("user:owner:c_1");
    expect(messageRowKey(otherUserSameClientId)).toBe("user:member_2:c_1");
    expect(messageRowKey(canonicalOwner)).not.toBe(messageRowKey(otherUserSameClientId));
    expect(messageRowKey(botMsg)).toBe("msg_bot");
    expect(messageRowKey(noClientId)).toBe("msg_plain");
  });
});

describe("forwardedAuthorName", () => {
  const directory = {
    user: { id: "owner", name: "Owner", role: "owner" as const },
    bots: [
      { id: "bot_a", name: "Helper", engine: "codex", model: "", effort: "", online: 1 },
      { id: "bot_b", name: "Helper", engine: "claude", model: "", effort: "", online: 1 },
    ],
    deletedBots: [
      { id: "bot_old", name: "Retired Bot", engine: "codex", model: "", effort: "", online: 0, deletedAt: 1700000000000 },
    ],
    dispatchWorkers: [
      { id: "worker_1", name: "Ticket Worker", engine: "codex", model: "", effort: "", online: 1, role: "worker" },
    ],
  };

  it("matches Hub forwardMessage authorName for botSource, bots, deletedBots, dispatchWorkers, users, and system", () => {
    expect(forwardedAuthorName({
      authorType: "user",
      authorId: "owner",
      botSource: { hostId: "h1", hostName: "macmini", botId: "b1", botName: "Remote Bot", hops: 1, requestId: "req_1" },
    }, directory)).toBe("Remote Bot · macmini");

    // Raw bot.name even when two bots share the same display name (no disambiguation suffix).
    expect(forwardedAuthorName({ authorType: "bot", authorId: "bot_a" }, directory)).toBe("Helper");
    expect(forwardedAuthorName({ authorType: "bot", authorId: "bot_old" }, directory)).toBe("Retired Bot");
    expect(forwardedAuthorName({ authorType: "bot", authorId: "worker_1" }, directory)).toBe("Ticket Worker");
    expect(forwardedAuthorName({ authorType: "bot", authorId: "bot_cached" }, { ...directory, bots: [] }, [{ id: "bot_cached", name: "Cached Bot" }])).toBe("Cached Bot");
    expect(forwardedAuthorName({ authorType: "bot", authorId: "bot_missing" }, directory)).toBe("bot_missing");

    // Local user uses Hub's users.name (not localized "我"), other users/system use authorId.
    expect(forwardedAuthorName({ authorType: "user", authorId: "owner" }, directory)).toBe("Owner");
    expect(forwardedAuthorName({ authorType: "user", authorId: "member_2" }, directory)).toBe("member_2");
    expect(forwardedAuthorName({ authorType: "system", authorId: "system" }, directory)).toBe("system");
  });
});
