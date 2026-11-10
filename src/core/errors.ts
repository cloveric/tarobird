import { archiveReadErrorMessage } from "../runtime/zip-archive.js";
import { classifyFailure, extractQuotaResetHint, renderEngineSettingsError, renderEngineBusyError, renderMalformedToolInputError } from "../runtime/error-classification.js";
import { EngineCancellationUnconfirmedError, EngineContextCompactionPendingError, EngineIncompleteResponseError, EngineStopTooLateError } from "../codex/adapter.js";
import { formatCoreFileSize, isCoreAttachmentTooLargeError } from "./files.js";
import type { Locale } from "../runtime/locale.js";
import { EngineRecoveryBudgetError, EngineRecoveryExhaustedError, EngineRecoveryUnconfirmedError } from "../runtime/engine-recovery.js";

const ATTACHMENT_KIND_LABELS_ZH: Record<string, string> = {
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
  if (locale === "en") {
    const kind = error.attachmentKind;
    return `This ${kind} is ${size}, over the ${limit} a Feishu bot can download. Please compress or split it and send again.`;
  }
  const kind = ATTACHMENT_KIND_LABELS_ZH[error.attachmentKind] ?? "文件";
  return `这个${kind} ${size}，超过飞书机器人可下载的上限（${limit}），请压缩或切分后再发。`;
}

/** Recovers the engine failure category from the user-facing text this module
 * rendered, for a Host that only sees the published reply (dispatcher tickets).
 * Keep the phrases in sync with renderCoreUserFacingError below. */
export function renderedEngineFailure(text: string): { category: "engine-quota" | "auth" | "engine-rate-limit" | "engine-backend" | "engine-cli"; resetHint?: string } | undefined {
  if (/使用额度已用完|usage quota is exhausted/.test(text)) {
    const hint = renderedEngineResetHint(text);
    return { category: "engine-quota", ...(hint ? { resetHint: hint } : {}) };
  }
  if (/尚未登录或登录已过期|认证刷新失败|sign-in is missing or expired|authentication could not be refreshed/.test(text)) return { category: "auth" };
  if (/当前触发限流|rate-limiting requests/.test(text)) return { category: "engine-rate-limit" };
  if (/模型后端暂时过载|模型服务暂时繁忙|model backend is temporarily overloaded|model service is temporarily busy/.test(text)) return { category: "engine-backend" };
  if (/引擎运行失败|无法启动引擎|engine runtime failed|engine could not start/.test(text)) return { category: "engine-cli" };
  return undefined;
}

/** The trailing hint is independent of which reply contained the quota error. */
export function renderedEngineResetHint(text: string): string | undefined {
  return (/重置信息：(.+?)。\s*$/.exec(text)?.[1] ?? /Reset information: (.+?)\.\s*$/.exec(text)?.[1])?.slice(0, 256);
}

export function renderCoreUserFacingError(
  error: unknown,
  phase: "prepare" | "engine" | "tool",
  locale: Locale = "zh",
): string {
  const archiveError = archiveReadErrorMessage(error, locale);
  if (archiveError) return archiveError;
  if (error instanceof EngineRecoveryBudgetError) return error.message;
  if (error instanceof EngineRecoveryUnconfirmedError) {
    const cause = error.retryReason ? (locale === "en" ? {
      capacity: "The model service is temporarily busy. ",
      connection: "The connection to the model service was interrupted. ",
      "rate-limit": "The model service is rate-limiting requests. ",
    } : {
      capacity: "模型服务暂时繁忙。",
      connection: "模型服务连接中断。",
      "rate-limit": "模型服务当前触发限流。",
    })[error.retryReason] : "";
    const detail = error.reason === "unfinished-work"
      ? locale === "en"
        ? "Some tool or background work has not reported completion, so automatic recovery has stopped to avoid starting it twice. The conversation is preserved; check the outstanding work before continuing."
        : "还有工具或后台任务尚未确认结束，暂未自动续接，以免重复执行。原会话已保留，请先核对这些任务的状态，再继续。"
      : locale === "en"
        ? "The engine's recovery receipt did not match the observed session or work, so automatic recovery stopped. The conversation is preserved; review the run before continuing."
        : "引擎的恢复回执与当前会话或执行记录不一致，已停止自动恢复。原会话已保留，请核对运行过程后继续。";
    return cause + detail;
  }
  if (error instanceof EngineRecoveryExhaustedError) return locale === "en"
    ? "The model service is still unavailable and automatic recovery has ended. The conversation and completed work are preserved. Once the service recovers, send ‘continue’ to resume the unfinished task."
    : "模型服务仍未恢复，本轮自动恢复已结束。原会话和已完成的工作已保留；服务恢复后发送“继续”，即可接着处理未完成的任务。";
  if (error instanceof EngineIncompleteResponseError) return locale === "en"
    ? "The engine returned a placeholder instead of an answer; this turn is not confirmed complete. Prior tool effects may be unknown. Review the run before deciding whether to continue."
    : "引擎返回了占位内容，本轮未确认完成。已执行操作的结果可能仍不确定；请先查看运行过程，再决定是否继续。";
  if (error instanceof EngineStopTooLateError) return locale === "en"
    ? "This message finished before Stop arrived. Nothing was cancelled; check the host record for any final output."
    : "这条消息在停止请求到达前已结束，未取消任何任务；完整结果请查看主机记录。";
  if (error instanceof EngineCancellationUnconfirmedError && error.reason === "goal-active") return locale === "en"
    ? "This message has started between goal rounds. DeepSeek cannot stop it separately without pausing the goal, so it is still running."
    : "这条消息已在目标轮次之间开始执行。DeepSeek 暂不支持单独停止它而保留目标运行，因此没有停止。";
  if (error instanceof EngineCancellationUnconfirmedError && error.reason === "runtime-deadline") return locale === "en"
    ? "This turn reached its runtime limit while an already-started command was still unconfirmed. The conversation is preserved; check the command's result before continuing."
    : "本轮已达到运行时限，但已启动的命令尚未确认结束。原会话已保留，请先核对命令结果再继续。";
  if (error instanceof EngineCancellationUnconfirmedError && error.reason === "tool-recovery") return locale === "en"
    ? "Automatic recovery has stopped, but the already-started command's outcome is still unconfirmed. Check its result before continuing to avoid duplicate execution."
    : "已停止自动恢复，但先前启动的命令尚未确认结束。请先核对执行结果再继续，避免重复执行。";
  if (error instanceof EngineCancellationUnconfirmedError) return locale === "en"
    ? "Stop could not be confirmed. This message may still run on the host. Check the host before sending it again."
    : "尚未确认停止。这条消息可能仍会在主机上执行，请先检查主机状态，避免重复发送。";
  if (error instanceof EngineContextCompactionPendingError) {
    // Unknown is not failure: the original session and its context are kept.
    const minutes = Math.max(1, Math.round(error.limitMs / 60_000));
    if (error.state === "recovering") return locale === "en"
      ? `Context compaction has reported no result for ${minutes} minutes. Codex will restart once this Bot's other tasks finish, then resume this conversation with its context. Send the message again shortly.`
      : `上下文压缩已超过 ${minutes} 分钟仍无结果。等这个 Bot 的其他任务结束后，Codex 会自动重启并恢复原会话，现有上下文不会丢失。请稍后再发送。`;
    if (error.state === "waiting") return locale === "en"
      ? "The previous context compaction is still unconfirmed. This message was not sent, no second compaction was started, and the conversation is preserved. Send it again shortly."
      : "上一次上下文压缩仍在等待结果，这条消息尚未发送；没有重复压缩，原会话已保留。请稍后再发送。";
    return locale === "en"
      ? `Context compaction did not confirm completion within ${minutes} minutes, so its result is unknown. The conversation is preserved and the compaction is still being tracked; it will not be repeated or replaced with a new conversation. Send the message again shortly.`
      : `上下文压缩 ${minutes} 分钟内未确认完成，结果未知。原会话已保留，系统会继续等待这次压缩，不会重复压缩或改用新会话。请稍后再发送。`;
  }
  const tooLarge = renderCoreAttachmentTooLarge(error, locale);
  if (tooLarge) {
    return tooLarge;
  }
  const category = classifyFailure(error);
  if (category === "engine-tool-input") return renderMalformedToolInputError(locale);
  if (category === "engine-settings") return renderEngineSettingsError(error, locale);
  if (category === "engine-busy") return renderEngineBusyError(locale, error);
  const errorText = error instanceof Error ? `${error.name}\n${error.message}` : String(error);
  // ENOENT from spawn can mean either the executable/interpreter or cwd is missing.
  const missingLaunchPath = /^spawn [^\r\n]+ ENOENT(?:\r?\n|$)/.test(error instanceof Error ? error.message : String(error));
  if (phase === "engine" && missingLaunchPath) return locale === "en"
    ? "Error: the engine could not start because its executable or working directory was not found. Check the CLI installation, host PATH and Bot workspace, then retry."
    : "错误：无法启动引擎，找不到启动程序或工作目录。请检查主机的 CLI 安装、启动路径（PATH）和 Bot 工作目录后重试。";
  const isAntigravityAuth = category === "auth" && /(?:antigravity|\bagy\b)/i.test(errorText);
  const isClaudeAuth = category === "auth" && error instanceof Error && error.name === "ClaudeError";
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
    const header = locale === "en"
      ? "Error: this conversation's Codex thread is locked by another writer."
      : "错误：该会话的 Codex 线程被其他写入方占用。";
    return detail ? `${header}\n${detail}` : header;
  }
  if (locale === "en") {
    if (category === "auth") {
      if (isClaudeAuth) return "Error: Claude Code sign-in is missing or expired. Run `claude auth login` on the host running this Bot, then retry. Chat history is preserved.";
      if (isAntigravityAuth) {
        return "Error: Antigravity authentication could not be refreshed. Run `agy` locally to sign in, then retry.";
      }
      return phase === "engine"
        ? "Error: engine sign-in is missing or expired. Sign in to the corresponding CLI on the host running this Bot, then retry."
        : "Error: service authorization is missing or expired. Reconnect the affected service, then retry.";
    }
    if (category === "write-permission") {
      return "Error: the current runtime cannot write to disk. Please adjust permissions and retry.";
    }
    if (category === "file-workflow") {
      return "Error: file processing failed. Try a smaller or different file.";
    }
    if (category === "session-state") {
      return "Error: session state is unavailable. Reset the session or ask an operator to check state files.";
    }
    if (category === "workflow-state") {
      return "Error: workflow state is unavailable. Retry later or ask an operator to check the service.";
    }
    if (category === "engine-cli") {
      return "Error: engine runtime failed. Restart the instance and retry.";
    }
    if (category === "engine-backend") {
      return isModelCapacity
        ? "Error: the model service is temporarily busy and could not continue this request. This does not mean your account quota is exhausted or your local storage is full. Retry shortly or switch models; restarting the instance is not required."
        : "Error: the model backend is temporarily overloaded or disconnected. Please retry; restarting the instance is not required.";
    }
    if (category === "engine-rate-limit") {
      return "Error: the model service is rate-limiting requests. Wait briefly and retry; resetting the chat or restarting the instance will not help.";
    }
    if (category === "engine-quota") {
      const message = isKimiQuota
        ? "Error: Kimi's current 5-hour usage quota is exhausted. Wait for the usage window to reset, or purchase extra usage/upgrade; signing in again or restarting will not help."
        : "Error: the engine usage quota is exhausted. Wait for the quota window to reset or increase the account quota; signing in again or restarting will not help.";
      return quotaResetHint ? `${message} Reset information: ${quotaResetHint}.` : message;
    }
    if (category === "engine-content-policy") {
      return "Error: the model's content-safety policy blocked this turn. Rephrase the request or remove the triggering context or attachment, then retry. If needed, send `/reset` or switch models; restarting the instance will not help.";
    }
    if (category === "engine-timeout") {
      const duration = timeoutMinutes ? `${timeoutMinutes} minutes` : "the configured interval";
      return isInactivityTimeout
        ? `⏱️ This turn produced no engine output for ${duration} and was stopped by the inactivity watchdog. It was not a crash; split the task or send \`/timeout off\` before a genuinely long silent operation.`
        : `⏱️ This turn hit its ${duration} runtime cap and was stopped. It was not a crash; split the task or send \`/timeout off\` before rerunning a genuinely long task.`;
    }

    switch (phase) {
      case "prepare":
        return "Error: failed to prepare the Lark message. Please retry later.";
      case "tool":
        return "Error: Lark tool execution failed. Details were recorded in logs.";
      case "engine":
        return "Error: this turn failed. Details were recorded in logs.";
    }
  }

  if (category === "auth") {
    if (isClaudeAuth) return "错误：Claude Code 尚未登录或登录已过期。请在运行此 Bot 的主机上执行 `claude auth login`，完成登录后重试。聊天记录会保留。";
    if (isAntigravityAuth) {
      return "错误：Antigravity 认证刷新失败。请先在本机运行 `agy` 完成登录，再重试。";
    }
    return phase === "engine"
      ? "错误：模型引擎尚未登录或登录已过期。请在运行此 Bot 的主机上登录对应 CLI，再重试。"
      : "错误：服务授权缺失或已过期，请重新连接对应服务后重试。";
  }
  if (category === "write-permission") {
    return "错误：当前运行环境没有写入权限，请调整权限后重试。";
  }
  if (category === "file-workflow") {
    return "错误：文件处理失败，请换一个文件或缩小文件后重试。";
  }
  if (category === "session-state") {
    return "错误：会话状态不可用，请重置会话或让运维检查状态文件。";
  }
  if (category === "workflow-state") {
    return "错误：工作流状态不可用，请稍后重试或让运维检查服务状态。";
  }
  if (category === "engine-cli") {
    return "错误：引擎运行失败，请重启实例后重试。";
  }
  if (category === "engine-backend") {
    return isModelCapacity
      ? "错误：模型服务暂时繁忙，无法继续本轮请求。此提示不代表账号额度用完或本机存储已满。请稍后重试，或临时切换模型；无需重启实例。"
      : "错误：模型后端暂时过载或连接中断，请重试；无需重启实例。";
  }
  if (category === "engine-rate-limit") {
    return "错误：模型服务当前触发限流。请稍等后重试；重置聊天或重启实例都无效。";
  }
  if (category === "engine-quota") {
    const message = isKimiQuota
      ? "错误：Kimi 当前 5 小时使用额度已用完。请等待额度窗口重置，或购买额外额度/升级套餐；重新登录或重启都无效。"
      : "错误：引擎使用额度已用完。请等待额度窗口重置或提高账户额度；重新登录或重启都无效。";
    return quotaResetHint ? `${message} 重置信息：${quotaResetHint}。` : message;
  }
  if (category === "engine-content-policy") {
    return "错误：本轮被模型的内容安全策略拦截。请换一种表述，或移除可能触发风控的上下文或附件后重试；必要时发送 `/reset` 清除旧上下文，或切换模型。重启实例无效。";
  }
  if (category === "engine-timeout") {
    const duration = timeoutMinutes ? `${timeoutMinutes} 分钟` : "配置的时限";
    return isInactivityTimeout
      ? `⏱️ 本轮连续 ${duration}没有引擎输出，已被空闲看门狗停止；这不是崩溃。请拆分任务，或在确实需要长时间静默运行前发送 \`/timeout off\`。`
      : `⏱️ 本轮达到${duration}运行上限，已自动停止；这不是崩溃。请拆分任务，或在重跑真正的长任务前发送 \`/timeout off\`。`;
  }

  switch (phase) {
    case "prepare":
      return "错误：准备飞书消息时失败，请稍后重试。";
    case "tool":
      return "错误：飞书工具执行失败，详细原因已记录到日志。";
    case "engine":
      return "错误：本轮运行失败，详细原因已记录到日志。";
  }
}
