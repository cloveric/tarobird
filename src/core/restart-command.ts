import type { EngineTask } from "../client-protocol/engine-tasks.js";
import { hostT } from "../locales/index.js";
import type { BridgeConversationRestartOutcome } from "../runtime/bridge.js";
import type { Locale } from "../runtime/locale.js";
import { loadInstanceConfig } from "../state/instance-config.js";
import { abortCoreConversation, requestCoreApproval } from "./card-actions.js";
import type { CoreNormalizedBridgeMessage } from "./message-normalizer.js";
import type { CoreServiceRuntime } from "./runtime.js";
import { appendCoreTimelineEvent } from "./timeline.js";
import type { CoreBridgeLike, CoreChannelLike } from "./types.js";

export async function handleCoreRestart(
  input: { channel: CoreChannelLike; bridge: CoreBridgeLike; runtime: CoreServiceRuntime; stateDir: string },
  message: CoreNormalizedBridgeMessage,
  locale: Locale,
): Promise<void> {
  const { channel, bridge, runtime, stateDir } = input;
  const { chatId, conversationKey } = message;
  const reply = { replyTo: message.messageId, replyInThread: Boolean(message.threadId) };
  const supported = bridge.restartConversationSession && bridge.supportsConversationRestart?.() !== false;
  const pause = supported ? runtime.chatQueue.pause(conversationKey) : undefined;
  let result: BridgeConversationRestartOutcome = supported ? "busy" : "unsupported";
  let stopRequested = false;
  try {
    if (pause) {
      channel.releaseMessageAdmission?.();
      try {
        result = await bridge.restartConversationSession!({
          chatId: message.bridgeChatId, conversationKey, signal: pause.signal,
          isCurrentBinding: async () => (await channel.canSteerConversation?.(chatId)) !== false,
          confirm: tasks => confirmRestart(input, message, tasks, locale, pause.signal),
          // The same stop /stop uses, swarms included; attachment bursts are kept.
          // The adapter waits for it before it closes the engine process.
          onStopping: () => {
            stopRequested = true;
            return abortCoreConversation(runtime, conversationKey, bridge, locale).backgroundStop;
          },
        });
      } catch {
        result = pause.signal.aborted && !stopRequested ? "cancelled" : "failed";
      }
    }
    await channel.send(chatId, { text: restartReply(result, locale, stopRequested) }, reply);
    await appendCoreTimelineEvent(stateDir, message, {
      type: "command.handled", detail: "/restart",
      outcome: result === "closed" ? "success" : result === "failed" || result === "exit_unconfirmed" ? "error" : "noop",
      metadata: { result, stopRequested },
    });
  } finally {
    pause?.release();
  }
}

async function confirmRestart(
  input: { channel: CoreChannelLike; runtime: CoreServiceRuntime; stateDir: string },
  message: CoreNormalizedBridgeMessage,
  tasks: readonly EngineTask[],
  locale: Locale,
  abortSignal: AbortSignal,
): Promise<boolean> {
  const confirm = hostT(locale, "确认重启");
  const cancel = hostT(locale, "取消重启");
  const labels = tasks.slice(0, 10).map(task => task.label.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 120)
    .replace(/[\\`*_\[\]<>]/gu, "\\$&"));
  const remaining = tasks.length - labels.length;
  const more = remaining ? hostT(locale, "，另有 {0} 项，可在任务列表查看", remaining) : "";
  const question = hostT(locale, "重启将中断以下后台任务：{0}{1}。是否继续？", labels.join(hostT(locale, "、")), more);
  const { engine } = await loadInstanceConfig(input.stateDir);
  const decision = await requestCoreApproval({
    ...input, chatId: message.chatId, conversationKey: message.conversationKey,
    requesterUserId: message.bridgeUserId, bridgeChatType: message.bridgeChatType,
    replyTo: message.messageId, replyInThread: Boolean(message.threadId), locale, abortSignal,
    request: { engine, toolName: "AskUserQuestion", toolInput: {
      questions: [{ header: hostT(locale, "重启引擎"), question, options: [{ label: confirm }, { label: cancel }] }],
    } },
  });
  return decision.behavior === "allow"
    && (decision.updatedInput as { answers?: Record<string, string> } | undefined)?.answers?.[question] === confirm;
}

function restartReply(outcome: BridgeConversationRestartOutcome, locale: Locale, stopRequested: boolean): string {
  switch (outcome) {
    case "closed": return hostT(locale, "旧进程已结束，会话已保留，下次发消息时启动。");
    case "not_running": return hostT(locale, "当前没有在运行的引擎进程。会话已保留，下次发消息时启动。");
    case "no_session": return hostT(locale, "这个对话还没有已保存的引擎会话，无需重启。");
    case "unsupported": return hostT(locale, "当前引擎或运行模式暂不支持 /restart。");
    case "binding_changed": return hostT(locale, "会话选择已变更或尚未生效。请在选择生效后重试 /restart。");
    case "shared_session": return hostT(locale, "这个引擎会话由多个对话使用，无法在这里单独重启。");
    case "busy": return hostT(locale, "当前会话有另一项会话操作，请等它结束后再试。");
    case "cancelled": return hostT(locale, "已取消重启。");
    case "failed":
      if (!stopRequested) return hostT(locale, "暂时无法核对会话或后台任务，本次未开始关闭引擎。可重试 /restart。");
      // An unexpected failure after the stop started has the same uncertain outcome.
    case "exit_unconfirmed": return hostT(locale, "未能确认旧引擎进程已退出。会话已保留，可重试 /restart。");
  }
}
