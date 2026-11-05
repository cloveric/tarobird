import { isTaroCubCoreSlashCommand } from "./slash-command-registry.js";
import { channelProfile } from "./channel-profile.js";

export type CoreBridgeChatType = "private" | "group";
export type CoreChatMode = "p2p" | "group" | "topic";

export interface CoreResourceDescriptor {
  type: string;
  fileKey?: string;
  file_key?: string;
  fileName?: string;
  file_name?: string;
  fileSize?: number | string;
  file_size?: number | string;
}

export interface CoreIncomingMessage {
  reviewAdmission?: "native";
  nativeInput?: import("../client-protocol/native-input.js").NativeInputObserver;
  botSource?: import("../client-protocol/bot-messages.js").BotSource;
  agentBus?: import("../client-protocol/agent-bus.js").AgentBusDispatch;
  groupDiscussion?: import("../client-protocol/group-discussion.js").GroupDiscussionDispatch;
  engineOverride?: import("../state/instance-config.js").EngineOverride;
  /** Hub-owned dispatcher ticket directory for this conversation's turns. */
  workspaceOverride?: string;
  messageId: string;
  chatId: string;
  chatType: string;
  chatMode?: CoreChatMode;
  chatName?: string;
  senderId: string;
  senderName?: string;
  threadId?: string;
  rootId?: string;
  replyToMessageId?: string;
  content?: string;
  asrRoutingText?: string;
  rawContentType?: string;
  resources?: CoreResourceDescriptor[];
  mentions?: unknown[];
  mentionAll?: boolean;
  mentionedBot?: boolean;
  createTime?: number;
}

export interface CoreMessageNormalizerOptions {
  requireMentionInGroup?: boolean;
}

export interface CoreNormalizedAttachment {
  kind: "image" | "file" | "audio" | "video";
  fileKey: string;
  fileName?: string;
  fileSize?: number;
  /**
   * The Lark message that actually carries this resource. Set when an
   * attachment-burst merge moves attachments onto a merged message whose
   * messageId differs — Feishu's messageResource.get requires the ORIGINAL
   * carrier message_id for the file_key, so downloads must prefer this.
   */
  sourceMessageId?: string;
}

export interface CoreNormalizedBridgeMessage {
  reviewAdmission?: "native";
  nativeInput?: import("../client-protocol/native-input.js").NativeInputObserver;
  botSource?: import("../client-protocol/bot-messages.js").BotSource;
  agentBus?: import("../client-protocol/agent-bus.js").AgentBusDispatch;
  groupDiscussion?: import("../client-protocol/group-discussion.js").GroupDiscussionDispatch;
  engineOverride?: import("../state/instance-config.js").EngineOverride;
  /** Hub-owned dispatcher ticket directory for this conversation's turns. */
  workspaceOverride?: string;
  messageId: string;
  chatId: string;
  chatMode?: CoreChatMode;
  chatName?: string;
  threadId?: string;
  replyToMessageId?: string;
  senderId: string;
  senderName?: string;
  bridgeChatId: number;
  bridgeAccessChatId: number;
  bridgeUserId: number;
  bridgeChatType: CoreBridgeChatType;
  conversationKey: string;
  accessConversationKey: string;
  text: string;
  asrRoutingText?: string;
  replyContext?: {
    messageId: string;
    text: string;
  };
  mentions: unknown[];
  attachments: CoreNormalizedAttachment[];
  /**
   * Set by the /goal command handler (Claude/Antigravity path) before the message
   * falls through to a normal engine turn: it carries the goal objective so the
   * turn's run card renders the 🎯 goal banner (parity with the Codex goal card).
   */
  goalObjective?: string;
}

const SUPPORTED_RESOURCE_TYPES = new Set(["image", "file", "audio", "video"]);

export function stableCoreNumericId(value: string): number {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & 0x7fffffff;
}

export function normalizeCoreMessage(
  message: CoreIncomingMessage,
  options: CoreMessageNormalizerOptions = {},
): CoreNormalizedBridgeMessage | null {
  const requireMentionInGroup = options.requireMentionInGroup ?? false;
  const isGroupLike = message.chatType !== "p2p";
  const isExplicitSlashCommand = isTaroCubCoreSlashCommand(message.content);

  if (isGroupLike && requireMentionInGroup && !message.mentionedBot && !message.mentionAll && !isExplicitSlashCommand) {
    return null;
  }

  const conversationKey = buildCoreConversationKey(
    message.chatId,
    coreSessionThreadIdForMessage(message.chatType, message.threadId, message.chatMode),
  );
  const accessConversationKey = buildCoreConversationKey(message.chatId);
  const attachments = normalizeCoreResources(message.resources ?? []);
  const text = buildCoreText(message, attachments);

  return {
    ...(message.botSource ? { botSource: message.botSource } : {}),
    ...(message.agentBus ? { agentBus: message.agentBus } : {}),
    ...(message.groupDiscussion ? { groupDiscussion: message.groupDiscussion } : {}),
    ...(message.engineOverride ? { engineOverride: message.engineOverride } : {}),
    ...(message.workspaceOverride ? { workspaceOverride: message.workspaceOverride } : {}),
    ...(message.reviewAdmission === "native" && !message.botSource && !message.agentBus && !message.groupDiscussion && message.chatType === "p2p" ? { reviewAdmission: message.reviewAdmission, nativeInput: message.nativeInput } : {}),
    messageId: message.messageId,
    chatId: message.chatId,
    ...(message.chatMode ? { chatMode: message.chatMode } : {}),
    ...(message.chatName ? { chatName: message.chatName } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    senderId: message.senderId,
    ...(message.senderName ? { senderName: message.senderName } : {}),
    bridgeChatId: stableCoreNumericId(conversationKey),
    bridgeAccessChatId: stableCoreNumericId(accessConversationKey),
    bridgeUserId: stableCoreNumericId(`user:${message.senderId}`),
    bridgeChatType: message.chatType === "p2p" ? "private" : "group",
    conversationKey,
    accessConversationKey,
    text,
    ...(message.asrRoutingText !== undefined ? { asrRoutingText: message.asrRoutingText } : {}),
    mentions: message.mentions ?? [],
    attachments,
  };
}

export function buildCoreConversationKey(chatId: string, threadId?: string): string {
  return threadId ? `lark:${chatId}:${threadId}` : `lark:${chatId}`;
}

export function coreSessionThreadIdForMessage(
  chatType: string,
  threadId?: string,
  chatMode?: CoreChatMode,
): string | undefined {
  // A real thread in a private chat is an explicit user-created side
  // conversation, so isolate it even though the containing chat remains p2p.
  // Access control still uses the parent chat key through accessConversationKey.
  if (chatType === "p2p") {
    return threadId;
  }

  // For groups, isolate by thread only when the chat is in topic-message form.
  // The caller resolves chatMode to "topic" for both a native topic group
  // (chat_mode='topic') and a conversation group switched to the topic message
  // form (group_message_type='thread'); a conversation-form group stays "group"
  // so its replies share the one group session.
  const effectiveMode = chatMode ?? (chatType === "p2p" ? "p2p" : "topic");
  return effectiveMode === "topic" ? threadId : undefined;
}

/**
 * Decide, from a Feishu `im.v1.chat.get` payload, whether a chat is in
 * topic-message form (each topic = its own isolated session). True for a native
 * topic group (`chat_mode: "topic"`) and for a conversation group switched to
 * the topic message form (`group_message_type: "thread"`). The default
 * conversation form (`group_message_type: "chat"`) shares one group session.
 */
export function coreChatIsTopicForm(chat: { chat_mode?: unknown; group_message_type?: unknown }): boolean {
  return chat.chat_mode === "topic" || chat.group_message_type === "thread";
}

export function coreAccessConversationKeyFromConversationKey(conversationKey: string): string {
  const match = conversationKey.match(/^lark:([^:]+)(?::.+)?$/);
  if (!match) {
    return conversationKey;
  }
  return buildCoreConversationKey(match[1]!);
}

export function coreAccessChatIdFromConversationKey(conversationKey: string): number {
  return stableCoreNumericId(coreAccessConversationKeyFromConversationKey(conversationKey));
}

function normalizeCoreResources(resources: CoreResourceDescriptor[]): CoreNormalizedAttachment[] {
  return resources.flatMap((resource) => {
    if (!SUPPORTED_RESOURCE_TYPES.has(resource.type)) {
      return [];
    }

    const fileKey = resource.fileKey ?? resource.file_key;
    if (!fileKey) {
      return [];
    }

    const attachment: CoreNormalizedAttachment = {
      kind: resource.type as CoreNormalizedAttachment["kind"],
      fileKey,
    };
    const fileName = resource.fileName ?? resource.file_name;
    if (fileName) {
      attachment.fileName = fileName;
    }
    const fileSize = resource.fileSize ?? resource.file_size;
    const parsedFileSize = typeof fileSize === "string" && /^\d+$/.test(fileSize.trim())
      ? Number(fileSize.trim())
      : fileSize;
    if (typeof parsedFileSize === "number" && Number.isFinite(parsedFileSize) && parsedFileSize >= 0) {
      attachment.fileSize = parsedFileSize;
    }
    return [attachment];
  });
}

/** App routing is carried by normalized fields and bound native tools. Its
 * user text has no transport envelope; literal tags there are user content.
 * Keep the legacy envelope only for the optional Feishu surface. */
export function splitMessageContext(text: string): { envelope: string; body: string } {
  const envelope = channelProfile() === "gateway"
    ? ""
    : text.match(/^<lark_context>[\s\S]*?<\/lark_context>/)?.[0] ?? "";
  return { envelope, body: text.slice(envelope.length) };
}

function buildCoreText(
  message: CoreIncomingMessage,
  attachments: CoreNormalizedAttachment[],
): string {
  // Preserve stored lark:* conversation identities, but do not prepend those
  // implementation details to App prompts/native session titles.
  const contextLines = channelProfile() === "gateway" ? [] : [
    "<lark_context>",
    `chat_id: ${message.chatId}`,
    `chat_type: ${message.chatType}`,
    ...(message.threadId ? [`thread_id: ${message.threadId}`] : []),
    ...(message.rootId ? [`root_id: ${message.rootId}`] : []),
    ...(message.replyToMessageId ? [`reply_to_message_id: ${message.replyToMessageId}`] : []),
    `message_id: ${message.messageId}`,
    `sender_id: ${message.senderId}`,
    ...(message.senderName ? [`sender_name: ${message.senderName}`] : []),
    ...(typeof message.createTime === "number" ? [`create_time: ${message.createTime}`] : []),
    "</lark_context>",
  ];

  const body = formatCoreBody(message);
  const attachmentSummary = attachments.length > 0
    ? attachments
      .map((attachment) => {
        const name = attachment.fileName ? ` ${attachment.fileName}` : "";
        return `[${attachment.kind}:${attachment.fileKey}${name}]`;
      })
      .join("\n")
    : "";

  return [contextLines.join("\n"), body, attachmentSummary]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function formatCoreBody(message: CoreIncomingMessage): string {
  const body = (message.content ?? "").trim();
  if (!body) {
    return "";
  }
  if (message.rawContentType === "merge_forward") {
    return `<forwarded_lark_messages>\n${body}\n</forwarded_lark_messages>`;
  }
  return body;
}
