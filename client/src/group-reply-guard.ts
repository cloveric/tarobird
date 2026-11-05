import type { ClientFrame } from "../../src/client-protocol/index.js";
import { t } from "./i18n.js";

/** Local outbox sentinel, removed only after a fresh legacy-host handshake.
 * It is never sent as a revision and cannot match a modern Hub revision. */
export const LEGACY_GROUP_REPLY_REVISION = "local-legacy-group";
export const changedGroupReply = () => t("群聊设置或讨论状态已变化，消息尚未发送。请核对后重新发送。");
export const unavailableGroupReplyGuard = () => t("当前主机无法校验这条离线群消息，内容已保留。请更新主机或核对后重新发送。");
export const unknownGroupReplyMode = (online: boolean) => online ? t("正在读取群聊方式，请稍后发送。") : t("离线时无法确认此群的回复方式，内容已保留为草稿。请连接后发送。");

/** Outbox replay must never let a pre-guard Host silently discard the guard. */
export function groupReplyWireFrame(frame: ClientFrame, capabilities: { groupDiscussionAvailable?: boolean; groupReplyGuardAvailable?: boolean }): ClientFrame {
  if (frame.type !== "message.send" || !frame.groupReplyGuard) return frame;
  if (frame.groupReplyGuard.revision === LEGACY_GROUP_REPLY_REVISION) {
    if (capabilities.groupDiscussionAvailable !== false) throw new Error(changedGroupReply());
    const { groupReplyGuard: _localOnly, ...legacy } = frame;
    return legacy;
  }
  if (!capabilities.groupReplyGuardAvailable) throw new Error(unavailableGroupReplyGuard());
  return frame;
}
