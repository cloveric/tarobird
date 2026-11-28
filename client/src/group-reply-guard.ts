import type { ClientFrame, Message } from "../../src/client-protocol/index.js";
import { t } from "./i18n.js";

/** Local outbox sentinel, removed only after a fresh legacy-host handshake.
 * It is never sent as a revision and cannot match a modern Hub revision. */
export const LEGACY_GROUP_REPLY_REVISION = "local-legacy-group";
// Keep the single-host assumption in the outbox until the next wire send.
const LEGACY_LOCAL_RETRY_REVISION = "local-legacy-group-retry";
export const changedGroupReply = () => t("群聊设置或讨论状态已变化，消息尚未发送。请核对后重新发送。");
export const unavailableGroupReplyGuard = () => t("当前主机无法校验这条离线群消息，内容已保留。请更新主机或核对后重新发送。");
export const unknownGroupReplyMode = (online: boolean) => online ? t("正在读取群聊方式，请稍后发送。") : t("离线时无法确认此群的回复方式，内容已保留为草稿。请连接后发送。");

const recipientRetryUnavailable = () => t("当前主机不支持此回复选择。消息已保留，请更新主机后重试。");

type RetryCapabilities = {
  groupRecipientRetryAvailable?: boolean;
  groupRecipientKeysAvailable?: boolean;
  crossHostGroupsAvailable?: boolean;
};

export function groupMessageRetryAddress(source: Message, localBotId: string | undefined, capabilities: RetryCapabilities): Pick<Extract<ClientFrame, { type: "message.send" }>, "retryOf" | "mentions" | "groupReplyGuard"> {
  const localKey = localBotId ? [`local:${localBotId}`] : undefined;
  if (capabilities.groupRecipientRetryAvailable !== false) {
    return { retryOf: source.id, ...(localKey ? { mentions: localKey } : {}) };
  }
  const keys = localKey ?? source.groupRecipientKeys;
  if (capabilities.groupRecipientKeysAvailable && keys?.length) return { mentions: keys };
  if (capabilities.crossHostGroupsAvailable === false) {
    // A pre-cross-host Hub understood explicit bare IDs as local recipients.
    // Saved scoped evidence takes precedence over historical display IDs.
    const mentions = keys === undefined ? source.mentions
      : keys.every(key => key.startsWith("local:")) ? keys.map(key => key.slice("local:".length)) : undefined;
    if (mentions?.length) return { mentions, groupReplyGuard: { mode: "mentions", revision: LEGACY_LOCAL_RETRY_REVISION } };
  }
  throw new Error(recipientRetryUnavailable());
}

/** Outbox replay must never let an older Host discard a routing guard or the retry source. */
export function groupReplyWireFrame(frame: ClientFrame, capabilities: RetryCapabilities & { groupDiscussionAvailable?: boolean; groupReplyGuardAvailable?: boolean }): ClientFrame {
  if (frame.type !== "message.send") return frame;
  if ((frame.retryOf && !capabilities.groupRecipientRetryAvailable) || (!capabilities.groupRecipientKeysAvailable && frame.mentions?.some(id => id.includes(":")))) {
    throw new Error(recipientRetryUnavailable());
  }
  if (!frame.groupReplyGuard) return frame;
  if (frame.groupReplyGuard.revision === LEGACY_LOCAL_RETRY_REVISION) {
    if (capabilities.crossHostGroupsAvailable !== false) throw new Error(recipientRetryUnavailable());
    const { groupReplyGuard: _localOnly, ...legacy } = frame;
    return legacy;
  }
  if (frame.groupReplyGuard.revision === LEGACY_GROUP_REPLY_REVISION) {
    if (capabilities.groupDiscussionAvailable !== false) throw new Error(changedGroupReply());
    const { groupReplyGuard: _localOnly, ...legacy } = frame;
    return legacy;
  }
  if (!capabilities.groupReplyGuardAvailable) throw new Error(unavailableGroupReplyGuard());
  return frame;
}
