import { SessionHistoryPendingError } from "../state/session-history-error.js";
import { EngineHistoryBusyError } from "../codex/adapter.js";
import { PiRpcCommandError, PiStartupError } from "../codex/pi-rpc-client.js";
import { OmpRpcCommandError, OmpStartupError } from "../codex/omp-rpc-client.js";
import { OmpFrameError, OmpProtocolVersionError } from "../codex/omp-rpc-protocol.js";
import { CodexThreadMissingError } from "../codex/app-server-adapter.js";
import { ClaudeTurnWorkspaceUnavailableError } from "../runtime/conversation-resume.js";
import { archiveReadErrorMessage } from "../runtime/zip-archive.js";
import { classifyFailure, extractQuotaResetHint, renderEngineSettingsError, renderEngineBusyError, renderMalformedToolInputError, renderDeepSeekOfficeTimeout, renderPiProviderFailure } from "../runtime/error-classification.js";
import { EngineCancellationUnconfirmedError, EngineContextCompactionPendingError, EngineIncompleteResponseError, EngineStopTooLateError } from "../codex/adapter.js";
import { formatCoreFileSize, isCoreAttachmentTooLargeError } from "./files.js";
import { isChineseLocale, type Locale } from "../runtime/locale.js";
import { hostT } from "../locales/index.js";
import { EngineRecoveryBudgetError, EngineRecoveryExhaustedError, EngineRecoveryUnconfirmedError } from "../runtime/engine-recovery.js";

const ATTACHMENT_KIND_KEYS: Record<string, string> = {
  image: "图片",
  audio: "音频",
  video: "视频",
  file: "文件",
};

/**
 * An oversize inbound attachment gets its own message: the generic file-workflow
 * text ("换一个文件") does not tell the user what actually happened, and the
 * generic prepare text ("准备飞书消息时失败") is actively misleading.
 */
function renderCoreAttachmentTooLarge(error: unknown, locale: Locale): string | undefined {
  if (!isCoreAttachmentTooLargeError(error)) {
    return undefined;
  }
  const size = formatCoreFileSize(error.attachmentBytes);
  const limit = formatCoreFileSize(error.limitBytes);
  const kind = hostT(locale, ATTACHMENT_KIND_KEYS[error.attachmentKind] ?? "文件");
  return hostT(locale, "这个{0} {1}，超过飞书机器人可下载的上限（{2}），请压缩或切分后再发。", kind, size, limit);
}

/** Recovers the engine failure category from the user-facing text this module
 * rendered, for a Host that only sees the published reply (dispatcher tickets).
 * Keep the phrases in sync with renderCoreUserFacingError below. */
export function renderedEngineFailure(text: string): { category: "engine-quota" | "auth" | "engine-rate-limit" | "engine-backend" | "engine-cli"; resetHint?: string } | undefined {
  if (/使用额度已用完|usage quota is exhausted|利用枠の上限に達しました/.test(text)) {
    const hint = renderedEngineResetHint(text);
    return { category: "engine-quota", ...(hint ? { resetHint: hint } : {}) };
  }
  if (/尚未登录或登录已过期|认证刷新失败|sign-in is missing or expired|authentication could not be refreshed|サインインしていないか、有効期限が切れています|認証をリフレッシュできませんでした/.test(text)) return { category: "auth" };
  if (/当前触发限流|rate-limiting requests|現在レート制限がかかっています/.test(text)) return { category: "engine-rate-limit" };
  if (/模型后端暂时过载|模型服务暂时繁忙|model backend is temporarily overloaded|model service is temporarily busy|モデルバックエンドが一時的に過負荷|モデルサービスが一時的に混雑/.test(text)) return { category: "engine-backend" };
  if (/引擎运行失败|无法启动引擎|engine runtime failed|engine could not start|エンジンランタイムが失敗しました|エンジンを起動できませんでした/.test(text)) return { category: "engine-cli" };
  return undefined;
}

/** The trailing hint is independent of which reply contained the quota error. */
export function renderedEngineResetHint(text: string): string | undefined {
  return (/重置信息：(.+?)。\s*$/.exec(text)?.[1]
    ?? /Reset information: (.+?)\.\s*$/.exec(text)?.[1]
    ?? /リセット情報：(.+?)。\s*$/.exec(text)?.[1])?.slice(0, 256);
}

export function renderCoreUserFacingError(
  error: unknown,
  phase: "prepare" | "engine" | "tool",
  locale: Locale = "zh",
): string {
  if (error instanceof ClaudeTurnWorkspaceUnavailableError) return hostT(locale, "为恢复 Claude 会话选用的工作区不可用。请恢复原文件夹或修复主机对已配置文件夹的访问权限，然后重试。如需使用其他文件夹，请选择有效的工作区新建对话，再用 /resume 绑定同一个 Claude 会话。");
  if (error instanceof SessionHistoryPendingError) return hostT(locale, "上一次历史操作的结果尚未确认，请先在会话历史操作中核对结果，再继续。对话和文件已保留。");
  if (error instanceof EngineHistoryBusyError) return hostT(locale, "会话历史操作仍在处理中，请等待结果确认后再发送消息。");
  if (error instanceof CodexThreadMissingError) return hostT(locale, "主机上找不到对应的 Codex 原生会话，本次目标操作未执行。App 消息记录仍可查看，请检查主机上的 Codex 历史，恢复原会话或选择其他会话。");
  const archiveError = archiveReadErrorMessage(error, locale);
  if (archiveError) return archiveError;
  if (error instanceof EngineRecoveryBudgetError) return error.message;
  if (error instanceof EngineRecoveryUnconfirmedError) {
    const causeKey = error.retryReason ? ({
      capacity: "模型服务暂时繁忙。",
      connection: "模型服务连接中断。",
      "rate-limit": "模型服务当前触发限流。",
    } as const)[error.retryReason] : "";
    const cause = causeKey ? hostT(locale, causeKey) : "";
    const detail = error.reason === "unfinished-work"
      ? hostT(locale, "还有工具或后台任务尚未确认结束，暂未自动续接，以免重复执行。原会话已保留，请先核对这些任务的状态，再继续。")
      : hostT(locale, "引擎的恢复回执与当前会话或执行记录不一致，已停止自动恢复。原会话已保留，请核对运行过程后继续。");
    return cause + detail;
  }
  if (error instanceof EngineRecoveryExhaustedError) return hostT(locale, "模型服务仍未恢复，本轮自动恢复已结束。原会话和已完成的工作已保留；服务恢复后发送“继续”，即可接着处理未完成的任务。");
  if (error instanceof EngineIncompleteResponseError && error.reason === "interrupted") {
    // Rewind is offered only when the adapter's native history can drop the
    // refused input; the App still shows the action only where it applies.
    if (error.requestRejection === "invalid-argument" && error.nativeRewind === true) return hostT(locale, "模型服务判定本次请求无效，请检查所选模型、设置和附件。这并不能证明对话已损坏。之前的操作可能已执行；原对话已保留，未自动重发请求。被拒收的内容可能仍留在本对话上下文中。若之后的消息也被拒收，且带入该内容的消息上有「回退到这条消息之前」，可用它回退（工作区文件不会回滚）；否则可新开对话。");
    if (error.requestRejection === "invalid-argument") return hostT(locale, "模型服务判定本次请求无效，请检查所选模型、设置和附件。这并不能证明对话已损坏。之前的操作可能已执行；原对话已保留，未自动重发请求。若确认输入有效后仍持续失败，可新开对话。");
    // Keep the incomplete type non-retryable. Only bounded known causes are
    // exposed; never print the engine's raw diagnostics.
    const category = classifyFailure(new Error(error.message));
    const cause = category === "auth" ? hostT(locale, "引擎尚未登录或登录已过期，请先在主机上完成登录。")
      : category === "engine-quota" ? hostT(locale, "引擎额度已用尽，请等待额度恢复或增加账户额度。") : "";
    return cause + hostT(locale, "引擎提前结束了本轮，回答可能不完整。请先核对已执行的操作，再继续未完成的任务。原会话已保留，未自动重发请求。");
  }
  if (error instanceof EngineIncompleteResponseError) return hostT(locale, "引擎返回了占位内容，本轮未确认完成。已执行操作的结果可能仍不确定；请先查看运行过程，再决定是否继续。");
  if (error instanceof EngineStopTooLateError) return hostT(locale, "这条消息在停止请求到达前已结束，未取消任何任务；完整结果请查看主机记录。");
  if (error instanceof EngineCancellationUnconfirmedError && error.reason === "goal-active") return hostT(locale, "这条消息已在目标轮次之间开始执行。DeepSeek 暂不支持单独停止它而保留目标运行，因此没有停止。");
  if (error instanceof EngineCancellationUnconfirmedError && error.reason === "runtime-deadline") return hostT(locale, "本轮已达到运行时限，但已启动的命令尚未确认结束。原会话已保留，请先核对命令结果再继续。");
  if (error instanceof EngineCancellationUnconfirmedError && error.reason === "tool-recovery") return hostT(locale, "已停止自动恢复，但先前启动的命令尚未确认结束。请先核对执行结果再继续，避免重复执行。");
  if (error instanceof EngineCancellationUnconfirmedError) return hostT(locale, "尚未确认停止。这条消息可能仍会在主机上执行，请先检查主机状态，避免重复发送。");
  if (error instanceof EngineContextCompactionPendingError) {
    // Unknown is not failure: the original session and its context are kept.
    const minutes = Math.max(1, Math.round(error.limitMs / 60_000));
    if (error.state === "recovering") return hostT(locale, "上下文压缩已超过 {0} 分钟仍无结果。等这个 Bot 的其他任务结束后，Codex 会自动重启并恢复原会话，现有上下文不会丢失。请稍后再发送。", minutes);
    if (error.state === "waiting") return hostT(locale, "上一次上下文压缩仍在等待结果，这条消息尚未发送；没有重复压缩，原会话已保留。请稍后再发送。");
    return hostT(locale, "上下文压缩 {0} 分钟内未确认完成，结果未知。原会话已保留，系统会继续等待这次压缩，不会重复压缩或改用新会话。请稍后再发送。", minutes);
  }
  const tooLarge = renderCoreAttachmentTooLarge(error, locale);
  if (tooLarge) {
    return tooLarge;
  }
  const category = classifyFailure(error);
  const officeTimeout = category === "engine-timeout" ? renderDeepSeekOfficeTimeout(error, locale) : undefined;
  if (officeTimeout) return officeTimeout;
  if (category === "engine-tool-input") return renderMalformedToolInputError(locale);
  if (category === "engine-settings") return renderEngineSettingsError(error, locale);
  if (category === "engine-busy") return renderEngineBusyError(locale, error);
  const piProvider = renderPiProviderFailure(error, category, locale);
  if (piProvider) return piProvider;
  const errorText = error instanceof Error ? `${error.name}\n${error.message}` : String(error);
  if (error instanceof OmpProtocolVersionError) return !isChineseLocale(locale)
    ? "Error: engine could not start because this oh-my-pi (omp) RPC protocol version is not supported. Update TaroBird or oh-my-pi on the host, then retry."
    : "错误：无法启动引擎，当前主机上的 oh-my-pi (omp) RPC 协议版本不受支持。请更新主机上的 TaroBird 或 oh-my-pi 后重试。";
  if (error instanceof OmpFrameError) return !isChineseLocale(locale)
    ? "Error: engine runtime failed because an oh-my-pi (omp) RPC frame was malformed or interrupted. The conversation is preserved; retry or check the omp version on the host."
    : "错误：引擎运行失败，oh-my-pi (omp) RPC 通信帧损坏或中断。原会话已保留，请重试或检查主机上的 omp 版本。";
  // ENOENT from spawn can mean either the executable/interpreter or cwd is missing.
  const missingLaunchPath = /^spawn [^\r\n]+ ENOENT(?:\r?\n|$)/.test(error instanceof Error ? error.message : String(error));
  if (phase === "engine" && (missingLaunchPath || error instanceof PiStartupError && error.reason === "spawn" && error.message === "Pi executable was not found" || error instanceof OmpStartupError && error.reason === "spawn" && error.message === "omp executable was not found")) {
    return hostT(locale, "错误：无法启动引擎，找不到启动程序或工作目录。请检查主机的 CLI 安装、启动路径（PATH）和 Bot 工作目录后重试。主机所有者可到「设置 → 引擎程序」检查检测结果或指定程序路径。");
  }
  if (error instanceof OmpRpcCommandError && error.code?.toLowerCase() === "cost_cap") {
    return hostT(locale, "错误：此 omp 会话已达到费用上限（当前预算使用额度已用完）。请在 omp 中调整或清除上限，或新开对话。");
  }
  if (category === "auth" && error instanceof PiRpcCommandError) {
    return hostT(locale, "Pi 提供商凭据缺失或已失效。请在运行 Bot 的主机上执行 `pi auth login` 或更新提供商凭据后重试；原会话已保留。");
  }
  if (category === "auth" && error instanceof OmpRpcCommandError) {
    return hostT(locale, "omp 提供商凭据缺失或已失效。请在运行 Bot 的主机上运行 `omp` 并执行 `/login`（或更新提供商凭据）后重试；原会话已保留。");
  }
  if (category === "engine-request-rejected" && error instanceof OmpRpcCommandError) {
    const label = [error.httpStatus !== undefined ? `HTTP ${error.httpStatus}` : "", error.code ?? ""].filter(Boolean).join(" · ");
    return label
      ? hostT(locale, "错误：模型服务拒绝了本轮 omp 请求（{0}）。请检查所选模型、思考强度和附件后重试；重启实例无效。原会话已保留，未自动重发请求。", label)
      : hostT(locale, "错误：模型服务拒绝了本轮 omp 请求。请检查所选模型、思考强度和附件后重试；重启实例无效。原会话已保留，未自动重发请求。");
  }
  const isAntigravityAuth = category === "auth" && /(?:antigravity|\bagy\b)/i.test(errorText);
  const isClaudeAuth = category === "auth" && error instanceof Error && error.name === "ClaudeError";
  const isKimiAuth = category === "auth" && error instanceof Error && /^Kimi Code authentication required(?:$|\n)/.test(error.message);
  const isKimiQuota = category === "engine-quota" && /(?:kimi|5-hour usage limit)/i.test(errorText);
  const quotaResetHint = category === "engine-quota" ? extractQuotaResetHint(error) : undefined;
  const isModelCapacity =
    category === "engine-backend" &&
    /(?:selected model is at capacity|no capacity available for model)/i.test(errorText);
  const timeoutMatch = errorText.match(/turn (timed out|became inactive) after\s+(\d+(?:\.\d+)?)\s*minute/i);
  const timeoutMinutes = timeoutMatch?.[2];
  const isInactivityTimeout = timeoutMatch?.[1]?.toLowerCase() === "became inactive";
  if (category === "engine-thread-locked") {
    // The adapter already produced an operator-actionable explanation (who
    // holds the lock, what to do). Surfacing it verbatim is the whole point —
    // a generic "run failed" is exactly what sent the operator hunting.
    const detail = error instanceof Error ? error.message.split("\n\n").slice(1).join("\n\n").trim() : "";
    const header = hostT(locale, "错误：该会话的 Codex 线程被其他写入方占用。");
    return detail ? `${header}\n${detail}` : header;
  }

  if (category === "auth") {
    if (isKimiAuth) return hostT(locale, "错误：Kimi Code 尚未登录或登录已过期。请在运行此 Bot 的主机上执行 `kimi login`，完成登录后重试。聊天记录会保留。");
    if (isClaudeAuth) return hostT(locale, "错误：Claude Code 尚未登录或登录已过期。请在运行此 Bot 的主机上执行 `claude auth login`，完成登录后重试。聊天记录会保留。");
    if (isAntigravityAuth) {
      return hostT(locale, "错误：Antigravity 认证刷新失败。请先在本机运行 `agy` 完成登录，再重试。");
    }
    return phase === "engine"
      ? hostT(locale, "错误：模型引擎尚未登录或登录已过期。请在运行此 Bot 的主机上登录对应 CLI，再重试。")
      : hostT(locale, "错误：服务授权缺失或已过期，请重新连接对应服务后重试。");
  }
  if (category === "write-permission") {
    return hostT(locale, "错误：当前运行环境没有写入权限，请调整权限后重试。");
  }
  if (category === "file-workflow") {
    return hostT(locale, "错误：文件处理失败，请换一个文件或缩小文件后重试。");
  }
  if (category === "session-state") {
    return hostT(locale, "错误：会话状态不可用，请重置会话或让运维检查状态文件。");
  }
  if (category === "workflow-state") {
    return hostT(locale, "错误：工作流状态不可用，请稍后重试或让运维检查服务状态。");
  }
  if (category === "engine-cli") {
    return hostT(locale, "错误：引擎运行失败，请重启实例后重试。");
  }
  if (category === "engine-backend") {
    return isModelCapacity
      ? hostT(locale, "错误：模型服务暂时繁忙，无法继续本轮请求。此提示不代表账号额度用完或本机存储已满。请稍后重试，或临时切换模型；无需重启实例。")
      : hostT(locale, "错误：模型后端暂时过载或连接中断，请重试；无需重启实例。");
  }
  if (category === "engine-rate-limit") {
    return hostT(locale, "错误：模型服务当前触发限流。请稍等后重试；重置聊天或重启实例都无效。");
  }
  if (category === "engine-quota") {
    const message = isKimiQuota
      ? hostT(locale, "错误：Kimi 当前 5 小时使用额度已用完。请等待额度窗口重置，或购买额外额度/升级套餐；重新登录或重启都无效。")
      : hostT(locale, "错误：引擎使用额度已用完。请等待额度窗口重置或提高账户额度；重新登录或重启都无效。");
    return quotaResetHint ? `${message}${hostT(locale, " 重置信息：{0}。", quotaResetHint)}` : message;
  }
  if (category === "engine-content-policy") {
    return hostT(locale, "错误：本轮被模型的内容安全策略拦截。请换一种表述，或移除可能触发风控的上下文或附件后重试；必要时发送 `/reset` 清除旧上下文，或切换模型。重启实例无效。");
  }
  if (category === "engine-timeout") {
    if (timeoutMinutes) {
      return isInactivityTimeout
        ? hostT(locale, "⏱️ 本轮连续 {0} 分钟没有引擎输出，已被空闲看门狗停止；这不是崩溃。请拆分任务，或在确实需要长时间静默运行前发送 `/timeout off`。", timeoutMinutes)
        : hostT(locale, "⏱️ 本轮达到 {0} 分钟运行上限，已自动停止；这不是崩溃。请拆分任务，或在重跑真正的长任务前发送 `/timeout off`。", timeoutMinutes);
    }
    return isInactivityTimeout
      ? hostT(locale, "⏱️ 本轮连续配置的时限没有引擎输出，已被空闲看门狗停止；这不是崩溃。请拆分任务，或在确实需要长时间静默运行前发送 `/timeout off`。")
      : hostT(locale, "⏱️ 本轮达到配置的时限运行上限，已自动停止；这不是崩溃。请拆分任务，或在重跑真正的长任务前发送 `/timeout off`。");
  }

  switch (phase) {
    case "prepare":
      return hostT(locale, "错误：准备飞书消息时失败，请稍后重试。");
    case "tool":
      return hostT(locale, "错误：飞书工具执行失败，详细原因已记录到日志。");
    case "engine":
      return hostT(locale, "错误：本轮运行失败，详细原因已记录到日志。");
  }
}
