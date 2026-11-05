import { channelProfile } from "./channel-profile.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import type { CoreNormalizedBridgeMessage } from "./message-normalizer.js";

export async function appendCoreTimelineEvent(
  stateDir: string,
  normalized: CoreNormalizedBridgeMessage,
  input: {
    type: Parameters<typeof appendTimelineEventBestEffort>[1]["type"];
    outcome?: string;
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendTimelineEventBestEffort(stateDir, {
    type: input.type,
    channel: channelProfile() === "gateway" ? "gateway" : "lark",
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    conversationKey: normalized.conversationKey,
    outcome: input.outcome,
    detail: input.detail,
    metadata: {
      ...(channelProfile() === "gateway" ? { sourceChatId: normalized.chatId, messageId: normalized.messageId } : { larkChatId: normalized.chatId, larkMessageId: normalized.messageId }),
      bridgeChatType: normalized.bridgeChatType,
      ...input.metadata,
    },
  }, "Conversation timeline event");
}
