import { z } from "zod";
import { automaticGroupDiscussion, groupDiscussionStartSchema, groupDiscussionNoteSchema, groupDiscussionViewSchema, GROUP_DISCUSSION_TEXT_LIMIT, hasVisibleGroupText, type GroupDiscussionView } from "../../src/client-protocol/group-discussion.js";
import type { ClientFrame } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { anySignal, timeoutSignal } from "./abort-signals.js";
import { HubHttpError } from "./http-error.js";
import type { GroupComposerIntent } from "./group-composer-intent.js";
import type { WorkbenchDraft } from "./workbench-draft.js";
import { t } from "./i18n.js";
import { LEGACY_GROUP_REPLY_REVISION, unknownGroupReplyMode, unavailableGroupReplyGuard } from "./group-reply-guard.js";

export type GroupReplyMode = {
  conversationId: string; mode: GroupDiscussionView["settings"]["policy"]["mode"]; revision: string;
  botOrder?: string[];
  activeRun?: Pick<NonNullable<GroupDiscussionView["run"]>, "id" | "conversationId"> & Partial<Pick<NonNullable<GroupDiscussionView["run"]>, "revision" | "status" | "topic" | "pauseReason" | "actions" | "participants">>;
  delivery?: "guarded" | "legacy" | "unguarded";
};
export const automaticComposer = (value?: GroupReplyMode): boolean => !!value && (automaticGroupDiscussion(value.mode) || !!value.activeRun);
export const groupReplyModeFromView = (conversationId: string, view: GroupDiscussionView): GroupReplyMode => ({
  conversationId, mode: view.settings.policy.mode, revision: view.settings.revision, botOrder: view.settings.policy.botOrder,
  ...(view.run && ["running", "pausing", "paused", "ending"].includes(view.run.status) ? { activeRun: { id: view.run.id, conversationId: view.run.conversationId, revision: view.run.revision, status: view.run.status, topic: view.run.topic.slice(0, 500), pauseReason: view.run.pauseReason, actions: view.run.actions, participants: view.run.participants } } : {}),
});
type MessageSend = Extract<ClientFrame, { type: "message.send" }>;
const pendingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), signature: z.string(), intentId: z.string().optional(), body: groupDiscussionStartSchema }),
  z.object({ kind: z.literal("note"), signature: z.string(), intentId: z.string().optional(), runId: z.string(), body: groupDiscussionNoteSchema }),
]);

export function discussionSendProblem(error: unknown): string {
  if (error instanceof HubHttpError) {
    if (error.message === "group_discussion_empty_topic" || error.message === "empty_message") return t("请输入可见的讨论内容或添加附件。");
    if (error.message === "group_discussion_worker_update_required") return t("参与 Bot 的运行组件需要更新。请更新主机并重启这些 Bot 后再试。");
    if (error.message === "group_discussion_not_active") return t("原讨论已结束，草稿已保留。请刷新状态后再发送。");
    if (error.message === "group_discussion_paused") return t("讨论已被暂停，补充尚未发送。请选择补充并继续，或作为新课题发送。");
    if (error.message === "group_discussion_resume_unavailable") return t("首轮还没有有效回答，请重试未完成发言，或停止讨论后重新开始。");
    if (error.message === "group_discussion_start_required") return t("多位 Bot 需要按群聊顺序发言，请从输入栏发起讨论。");
    if (error.message === "group_discussion_participants_invalid") return t("所选 Bot 已不在此群中，请重新选择可发言的 Bot。");
    if (error.message === "group_discussion_control_forbidden") return t("只有讨论发起人或群主可以控制这次讨论。");
    if (error.message === "group_discussion_active") return t("群内已有进行中的讨论，请先查看或结束该讨论。");
    if (error.status === 409) return t("讨论或设置已变化，已保留输入。请核对最新状态后重试。");
    if (error.status === 403) return t("当前账号无权操作此讨论。");
    if (error.message === "group_discussion_not_found") return t("此讨论已不可用，请刷新群组状态。");
    if (error.message === "bot_not_found") return t("参与 Bot 已不可用，请重新检查群成员。");
    if (error.status === 404) return t("主机尚不支持此功能，请先更新主机。");
  }
  return t("未能确认操作结果。请先刷新状态，再决定是否重试。");
}

/** The main composer uses the same explicit, revision-checked start API as
 * the topic dialog/CLI. No ordinary @ fan-out is allowed in discussion mode.
 * Persist the exact pending body before HTTP: a lost reply/reload must not
 * turn a retry into a second run or into a supplemental ordinary message. */
export async function sendGroupComposerMessage(connection: HubConnection, frame: MessageSend, mode: GroupReplyMode | undefined, signal: AbortSignal, accept?: (value: GroupReplyMode) => void, currentMode?: () => GroupReplyMode | undefined, intent?: GroupComposerIntent, designComments?: WorkbenchDraft): Promise<(() => Promise<void>) | undefined> {
  const key = `discussion-composer:${frame.conversationId}`;
  const signature = JSON.stringify([frame.text, frame.attachments, frame.replyTo ?? null]);
  let saved: z.infer<typeof pendingSchema> | undefined;
  const raw = await connection.cache.draft(key);
  if (raw) {
    try { saved = pendingSchema.parse(JSON.parse(raw)); }
    catch { throw new Error(t("上次发送结果无法确认，草稿已保留。请先核对聊天记录，避免重复发送。")); }
  }
  const retry = !!saved && (intent ? saved.intentId === intent.id || !saved.intentId && intent.legacy === true && saved.signature === signature : saved.signature === signature);
  const latestTarget = currentMode?.() ?? mode;
  if (!retry && ["ending", "pausing"].includes(latestTarget?.activeRun?.status ?? "")) throw new Error(t("请等待本次讨论停止或暂停完成，内容已保留。"));
  if (!retry && intent?.target?.activeRun && intent.target.activeRun.id !== latestTarget?.activeRun?.id) throw new Error(t("原讨论已结束，补充内容已保留。请确认后按当前群聊方式发送。"));
  if (!retry && intent?.target && !intent.target.activeRun && latestTarget?.activeRun) throw new Error(t("群内已有进行中的讨论，原问题已保留。请明确选择作为补充发送。"));
  if (!retry && intent?.target && latestTarget?.conversationId === frame.conversationId && automaticComposer(intent.target) !== automaticComposer(latestTarget)) throw new Error(t("群聊回复方式已变化，草稿已保留。请确认后按当前群聊方式发送。"));
  if (!retry && (!mode || mode.conversationId !== frame.conversationId)) throw new Error(unknownGroupReplyMode(connection.state.status === "online"));
  // Upload/cache writes may outlive the render that captured recipients and
  // mode. If another device changes that context, require a fresh explicit send
  // rather than delivering an old recipient list under the newly displayed mode.
  // A pending receipt is replayed first, regardless of later mode/run changes.
  if (!retry && currentMode) {
    const latest = currentMode();
    if (latest?.conversationId !== mode?.conversationId || latest?.revision !== mode?.revision
      || latest?.activeRun?.id !== mode?.activeRun?.id || latest?.activeRun?.conversationId !== mode?.activeRun?.conversationId) {
      throw new Error(t("讨论或设置已变化，已保留输入。请核对最新状态后重试。"));
    }
  }
  if (!retry && !automaticComposer(mode)) {
    const legacy = mode!.delivery === "legacy";
    const guarded = connection.state.groupReplyGuardAvailable || mode!.delivery === "guarded";
    if (!legacy && !guarded && connection.state.status !== "online") throw new Error(unavailableGroupReplyGuard());
    const message = { ...frame, ...(legacy || guarded ? { groupReplyGuard: { mode: mode!.mode as "mentions" | "parallel", revision: legacy ? LEGACY_GROUP_REPLY_REVISION : mode!.revision } } : {}) };
    if (designComments?.context.kind === "design") await connection.send(message, designComments); else await connection.send(message);
    return;
  }
  // Discussion HTTP bodies cannot carry the frozen Design context. Preserve
  // this draft before any request; only its supported ordinary-message paths
  // can receive a real message ACK and settle comment delivery.
  if (designComments?.context.kind === "design" && (retry || mode?.activeRun || new Set(frame.mentions ?? []).size !== 1)) throw new Error(t("设计评论暂不支持自动群讨论，请改用普通聊天或点名单个 Bot。草稿已保留。"));
  if (connection.state.status !== "online") throw new Error(t("讨论需要在线连接，内容已保留为草稿。"));
  if (!retry && !hasVisibleGroupText(frame.text) && !frame.attachments.length) throw new Error(t("请输入可见的讨论内容或添加附件。"));
  if (frame.text.length > GROUP_DISCUSSION_TEXT_LIMIT) throw new Error(t("讨论内容最多 {0} 个字符，请精简后发送。", GROUP_DISCUSSION_TEXT_LIMIT));
  if (frame.attachments.length > 16) throw new Error(t("每个课题最多添加 16 个附件。"));
  let pending = retry ? saved! : undefined;
  const recovery = !!connection.state.groupDiscussionRecoveryAvailable;
  const active = mode?.activeRun;
  const participants = frame.mentions?.length ? [...new Set(frame.mentions)] : undefined;
  if (!retry && (active?.status === "ending" || active?.status === "pausing")) throw new Error(t("请等待本次讨论停止或暂停完成，内容已保留。"));
  const replacesPaused = !retry && !!active && intent?.discussionAction === "new";
  if (!retry && !active && participants?.length === 1) {
    if (!recovery) throw new Error(t("更新主机后可在讨论模式中点名单个 Bot，内容已保留。"));
    const message = { ...frame, mentions: participants, groupReplyGuard: { mode: mode!.mode, revision: mode!.revision } };
    if (designComments?.context.kind === "design") await connection.send(message, designComments); else await connection.send(message);
    return;
  }
  if (replacesPaused && (!recovery || active?.status !== "paused" || active.conversationId !== frame.conversationId)) throw new Error(t("请先停止当前讨论，再发送新课题；内容已保留。"));
  if (!retry && active && !replacesPaused) {
    if (active.conversationId !== frame.conversationId) throw new Error(t("群内另一个话题正在讨论，请前往该话题补充，或结束后再开始。"));
    if (!connection.state.groupDiscussionComposerAvailable) throw new Error(t("更新主机后可从输入框补充讨论，内容已保留。"));
    const then = active.status === "paused" ? intent?.discussionAction === "retry" || intent?.discussionAction === "resume" ? intent.discussionAction : active.actions?.includes("retry") ? "retry" : "resume" : undefined;
    if (then && !recovery) throw new Error(t("更新主机后可补充并继续讨论；请先在上方继续讨论，内容已保留。"));
    let revision: string | undefined;
    if (then) {
      const latest = groupDiscussionViewSchema.parse(await connection.http(`/api/conversations/${frame.conversationId}/discussion?brief=1`, { signal: anySignal([signal, timeoutSignal(10_000)]) }));
      if (latest.run?.id !== active.id || latest.run.status !== "paused" || !active.revision || latest.run.revision !== active.revision || !latest.run.actions?.includes(then)) throw new Error(t("讨论或设置已变化，已保留输入。请核对最新状态后重试。"));
      revision = active.revision;
    }
    pending = { kind: "note", signature, ...(intent ? { intentId: intent.id } : {}), runId: active.id, body: groupDiscussionNoteSchema.parse({ requestId: `gdc_${crypto.randomUUID()}`, text: frame.text, attachments: frame.attachments, ...(frame.replyTo ? { replyTo: frame.replyTo } : {}), ...(then ? { then, revision } : recovery ? { ifRunning: true } : {}) }) };
  }
  if (!pending) {
    if (frame.replyTo && !connection.state.groupDiscussionComposerAvailable) throw new Error(t("更新主机后可引用消息发起讨论，内容已保留。"));
    if (!recovery && participants && (!mode!.botOrder || participants.length !== mode!.botOrder.length || participants.some(id => !mode!.botOrder!.includes(id)))) throw new Error(t("更新主机后可选择本次讨论的参与者，内容已保留。"));
    if (replacesPaused && participants?.length === 1) throw new Error(t("只点名一位 Bot 时，请先停止原讨论，再发送消息。"));
    const text = hasVisibleGroupText(frame.text) ? frame.text.trim() : frame.attachments.length ? t("请根据附件内容展开讨论。") : "";
    pending = { kind: "start", signature, ...(intent ? { intentId: intent.id } : {}), body: groupDiscussionStartSchema.parse({ requestId: `gdc_${crypto.randomUUID()}`, revision: mode!.revision, text, attachments: frame.attachments, ...(frame.replyTo ? { replyTo: frame.replyTo } : {}), ...(recovery && participants ? { participants } : {}), ...(replacesPaused ? { supersedes: { runId: active!.id } } : {}) }) };
  }
  const serialized = JSON.stringify(pending);
  await connection.cache.saveDraft(key, serialized);
  try {
    const route = `/api/conversations/${frame.conversationId}/discussion${pending.kind === "note" ? `/${pending.runId}/notes` : ""}`;
    const view = groupDiscussionViewSchema.parse(await connection.http(route, { method: "POST", body: JSON.stringify(pending.body), signal: anySignal([signal, timeoutSignal(30_000)]) }));
    accept?.(groupReplyModeFromView(frame.conversationId, view));
  } catch (error) {
    if (error instanceof HubHttpError && error.status >= 400 && error.status < 500) await connection.cache.clearDraftIfMatches(key, serialized);
    throw new Error(discussionSendProblem(error), { cause: error });
  }
  // Call only after clearing the confirmed source draft. If local cleanup fails,
  // the next explicit retry still uses the same Hub idempotency receipt.
  return () => connection.cache.clearDraftIfMatches(key, serialized);
}
