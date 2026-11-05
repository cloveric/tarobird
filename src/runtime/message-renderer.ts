import { chunkMarkdown } from "./markdown-chunks.js";
import { extractQuotaResetHint, renderEngineSettingsError, renderEngineBusyError, renderMalformedToolInputError, type FailureCategory } from "./error-classification.js";

import type { Locale } from "./locale.js";
export type { Locale } from "./locale.js";
export type EngineName = "codex" | "claude" | "antigravity" | "kimi" | "deepseek";

// Bounded reply chunks preserve the existing shared command contract.
export function chunkReplyMessage(text: string, limit = 4000): string[] {
  return chunkMarkdown(text, limit);
}

export function renderWorkingMessage(locale: Locale = "en"): string {
  return locale === "zh" ? "收到，正在启动会话..." : "Received. Starting your session...";
}

export function renderErrorMessage(error: string, locale: Locale = "en"): string {
  return locale === "zh" ? `错误：${error}` : `Error: ${error}`;
}

export function renderSessionResetMessage(repaired = false, locale: Locale = "en"): string {
  if (locale === "zh") {
    return repaired
      ? "会话状态不可读，运维需要先修复实例会话状态才能重置此聊天。"
      : "当前聊天的会话已重置。";
  }
  return repaired
    ? "Session state was unreadable. An operator needs to repair the instance session state before this chat can be reset."
    : "Session reset for this chat.";
}

export function renderSessionStateErrorMessage(repairable: boolean, locale: Locale = "en"): string {
  if (locale === "zh") {
    return repairable
      ? "错误：会话状态当前不可读，运维需要修复会话状态后重试。"
      : "错误：会话状态当前不可用，运维需要恢复读取权限后重试。";
  }
  return repairable
    ? "Error: Session state is unreadable right now. The operator needs to repair session state and retry."
    : "Error: Session state is unavailable right now. The operator needs to restore read access and retry.";
}

export function renderUsageMessage(
  usage: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalCostUsd: number;
    requestCount: number;
    unmeteredRequestCount?: number;
    lastUpdatedAt: string;
  },
  locale: Locale = "en",
): string {
  const unmeteredRequestCount = usage.unmeteredRequestCount ?? 0;
  if (usage.requestCount === 0 && unmeteredRequestCount === 0) {
    return locale === "zh"
      ? "暂无用量数据——处理完一轮请求后再查。"
      : "No usage data yet — run a request first.";
  }
  if (usage.requestCount === 0 && unmeteredRequestCount > 0) {
    const lastSeen = usage.lastUpdatedAt || "never";
    return locale === "zh"
      ? [
        `累计用量（本实例）：`,
        `• 可计量请求数：0`,
        `• 未返回 token 明细的请求：${unmeteredRequestCount.toLocaleString()}`,
        `• 说明：当前引擎完成了请求，但没有返回 token 明细；不会假算为 0。`,
        `• 最近更新：${lastSeen}`,
      ].join("\n")
      : [
        `Cumulative usage (this instance):`,
        `• Metered requests: 0`,
        `• Requests without token details: ${unmeteredRequestCount.toLocaleString()}`,
        `• Note: the current engine completed requests without returning token details; these are not counted as zero-token turns.`,
        `• Last updated: ${lastSeen}`,
      ].join("\n");
  }
  const cost = usage.totalCostUsd.toFixed(4);
  const lastSeen = usage.lastUpdatedAt || "never";
  if (locale === "zh") {
    return [
      `累计用量（本实例）：`,
      `• 请求数：${usage.requestCount.toLocaleString()}`,
      ...(unmeteredRequestCount > 0 ? [`• 未返回 token 明细的请求：${unmeteredRequestCount.toLocaleString()}`] : []),
      `• 输入 tokens：${usage.totalInputTokens.toLocaleString()}`,
      `• 输出 tokens：${usage.totalOutputTokens.toLocaleString()}`,
      `• 缓存 tokens：${usage.totalCachedTokens.toLocaleString()}`,
      `• 花销：$${cost}`,
      `• 最近更新：${lastSeen}`,
    ].join("\n");
  }
  return [
    `Cumulative usage (this instance):`,
    `• Requests: ${usage.requestCount.toLocaleString()}`,
    ...(unmeteredRequestCount > 0 ? [`• Requests without token details: ${unmeteredRequestCount.toLocaleString()}`] : []),
    `• Input tokens: ${usage.totalInputTokens.toLocaleString()}`,
    `• Output tokens: ${usage.totalOutputTokens.toLocaleString()}`,
    `• Cached tokens: ${usage.totalCachedTokens.toLocaleString()}`,
    `• Cost: $${cost}`,
    `• Last updated: ${lastSeen}`,
  ].join("\n");
}

function stripTrailingUrlPunctuation(value: string): string {
  return value.replace(/[),.;:!?]+$/g, "");
}

function extractDiagnosticHttpTarget(detail: string): string | undefined {
  const match = detail.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) {
    return undefined;
  }

  try {
    const parsed = new URL(stripTrailingUrlPunctuation(match[0]));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return `${parsed.hostname}${parsed.pathname}`.slice(0, 160);
  } catch {
    return undefined;
  }
}

function renderEngineName(engine: EngineName | undefined): "Codex" | "Claude" | "Kimi" | "DeepSeek" | "Antigravity" | undefined {
  if (engine === "codex") {
    return "Codex";
  }
  if (engine === "claude") {
    return "Claude";
  }
  if (engine === "kimi") {
    return "Kimi";
  }
  if (engine === "deepseek") {
    return "DeepSeek";
  }
  if (engine === "antigravity") {
    return "Antigravity";
  }
  return undefined;
}

function inferEngineName(detail: string, target: string | undefined, engine?: EngineName): "Codex" | "Claude" | "Kimi" | "DeepSeek" | "Antigravity" | "Engine" {
  const explicitEngineName = renderEngineName(engine);
  if (explicitEngineName) {
    return explicitEngineName;
  }

  const normalized = `${detail}\n${target ?? ""}`.toLowerCase();
  if (normalized.includes("codex")) {
    return "Codex";
  }
  if (normalized.includes("claude")) {
    return "Claude";
  }
  if (normalized.includes("kimi")) {
    return "Kimi";
  }
  if (normalized.includes("deepseek") || normalized.includes("dsh")) {
    return "DeepSeek";
  }
  if (normalized.includes("antigravity") || normalized.includes("agy")) {
    return "Antigravity";
  }
  return "Engine";
}

function renderEngineDiagnosticDetail(detail: string, locale: Locale, engine?: EngineName): string | undefined {
  const normalized = detail.toLowerCase();
  const target = extractDiagnosticHttpTarget(detail);
  const engineName = inferEngineName(detail, target, engine);
  const isTransportFailure =
    normalized.includes("stream disconnected") ||
    normalized.includes("error sending request") ||
    normalized.includes("fetch failed");

  if (!isTransportFailure) {
    return undefined;
  }

  const targetPhrase =
    target === undefined
      ? ""
      : locale === "zh"
        ? `在调用 ${target} 时`
        : ` while calling ${target}`;

  return locale === "zh"
    ? `详情：${engineName} 传输流${targetPhrase}断开。上一轮还没有生成最终回答就失败了；这本身不能说明是浏览器或生图任务失败。`
    : `Details: ${engineName} transport stream disconnected${targetPhrase}. The previous turn failed before producing a final answer; this does not identify a browser or image-generation task by itself.`;
}

export function renderCategorizedErrorMessage(
  category: FailureCategory,
  detail: string,
  locale: Locale = "en",
  engine?: EngineName,
): string {
  if (category === "engine-settings") return renderEngineSettingsError(detail, locale);
  if (category === "engine-busy") return renderEngineBusyError(locale, detail);
  if (category === "engine-tool-input") return renderMalformedToolInputError(locale);
  if (category === "engine-incomplete") return locale === "en"
    ? "The engine returned a placeholder instead of an answer; this turn is not confirmed complete. Review any tool effects before deciding whether to continue."
    : "引擎返回了占位内容，本轮未确认完成。请先检查已执行操作的结果，再决定是否继续。";
  const normalizedDetail = detail.toLowerCase();
  const isAntigravity = engine === "antigravity";
  const isModelCapacity =
    category === "engine-backend" &&
    (
      normalizedDetail.includes("selected model is at capacity") ||
      normalizedDetail.includes("no capacity available for model")
    );
  const isUnsupportedAntigravityFlag =
    isAntigravity &&
    category === "engine-cli" &&
    (
      normalizedDetail.includes("flags provided but not defined") ||
      normalizedDetail.includes("unknown flag") ||
      normalizedDetail.includes("unknown shorthand flag") ||
      normalizedDetail.includes("flag provided but not defined")
    );
  const isTelegramFormattingError =
    category === "telegram-delivery" &&
    (
      normalizedDetail.includes("can't parse entities") ||
      normalizedDetail.includes("cannot parse entities") ||
      normalizedDetail.includes("parse entities")
    );
  const isTelegramAttachmentTooLargeError =
    category === "file-workflow" &&
    (
      normalizedDetail.includes("telegram attachment is too large to download via bot api") ||
      normalizedDetail.includes("getfile: bad request: file is too big")
    );
  const timeoutMatch = detail.match(/turn (timed out|became inactive) after\s+(\d+(?:\.\d+)?)\s*minute/i);
  const timeoutMinutes = timeoutMatch?.[2];
  const isInactivityTimeout = timeoutMatch?.[1]?.toLowerCase() === "became inactive";
  const quotaResetHint = category === "engine-quota" ? extractQuotaResetHint(detail) : undefined;

  if (locale === "zh") {
    if (category === "write-permission") {
      return "错误：当前写入策略禁止创建文件，请在允许写入的模式下重试。";
    }
    if (category === "auth") {
      if (isAntigravity) {
        return "错误：Antigravity 认证缺失或过期。请先在本机打开 Antigravity CLI 重新登录，然后重试这轮 Telegram 请求。";
      }
      return "错误：引擎认证缺失或过期，请重新登录此实例后重试。";
    }
    if (category === "telegram-conflict") {
      return "错误：另一个 Telegram 轮询进程正在使用此 bot token，请停止重复的服务后重试。";
    }
    if (category === "telegram-delivery") {
      return isTelegramFormattingError
        ? "错误：回复内容的格式被 Telegram 拒绝了。我已记录具体原因，请稍后重试或让运维检查日志。"
        : "错误：Telegram 投递暂时不可用，请稍后重试。";
    }
    if (category === "engine-backend") {
      return isModelCapacity
        ? "错误：模型服务暂时繁忙，无法继续本轮请求。此提示不代表账号额度用完或本机存储已满。请稍后重试，或临时切换模型；无需重启实例。"
        : "错误：引擎服务暂时过载或连接中断，请稍后再试；无需重启实例。";
    }
    if (category === "engine-rate-limit") {
      return "错误：模型服务当前触发限流。请稍等后重试；重置聊天或重启实例都无效。";
    }
    if (category === "engine-quota") {
      const message = engine === "kimi"
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
        ? `错误：任务连续 ${duration}没有引擎输出，已被空闲看门狗停止。请拆分任务，或先用 \`/timeout\` 调整时限。`
        : `错误：任务达到${duration}运行上限，已自动停止。直接原样重试通常还会超时；请拆分任务，或先用 \`/timeout\` 调整时限。`;
    }
    if (category === "engine-cli") {
      if (isUnsupportedAntigravityFlag) {
        return "错误：Antigravity 拒绝了 CLI 启动参数。请更新 agy 或移除不支持的 bridge 设置后重试。";
      }
      return [
        "错误：引擎运行时失败，请重启实例后重试。",
        renderEngineDiagnosticDetail(detail, locale, engine),
      ].filter(Boolean).join("\n");
    }
    if (category === "file-workflow") {
      if (isTelegramAttachmentTooLargeError) {
        return "错误：这个附件太大，当前 Telegram Bot API 不能下载到 bot 端。请压缩到 20MB 以内，或发可访问链接/把文件放到 bot workspace 后再让我读取。";
      }
      return "错误：准备请求时文件处理失败，请尝试更小或不同的文件。";
    }
    if (category === "workflow-state") {
      return "错误：内部工作流状态当前不可用，请稍后重试或让运维检查服务状态。";
    }
    if (category === "session-state") {
      return "错误：会话状态当前不可用，运维需要修复会话状态后重试。";
    }
    if (category === "unknown") {
      return "错误：发生了意外故障，请重置聊天或重试请求。";
    }
    return "错误：发生了意外故障，请重试。";
  }

  if (category === "write-permission") {
    return "Error: File creation is blocked by the current write policy. Retry in a writable mode.";
  }
  if (category === "auth") {
    if (isAntigravity) {
      return "Error: Antigravity authentication is missing or expired. Open Antigravity CLI locally, sign in again, then retry this Telegram turn.";
    }
    return "Error: Engine authentication is missing or expired. Re-login for this instance and retry.";
  }
  if (category === "telegram-conflict") {
    return "Error: Another Telegram poller is using this bot token. Stop the duplicate service and retry.";
  }
  if (category === "telegram-delivery") {
    return isTelegramFormattingError
      ? "Error: Telegram rejected the reply formatting. The detailed parse error has been logged; retry the request or inspect the logs."
      : "Error: Telegram delivery is temporarily unavailable. Retry the request or try again later.";
  }
  if (category === "engine-backend") {
    return isModelCapacity
      ? "Error: the model service is temporarily busy and could not continue this request. This does not mean your account quota is exhausted or your local storage is full. Retry shortly or switch models; restarting the instance is not required."
      : "Error: The engine backend is temporarily overloaded or disconnected. Retry later; restarting the instance is not required.";
  }
  if (category === "engine-rate-limit") {
    return "Error: The model service is rate-limiting requests. Wait briefly and retry; resetting the chat or restarting the instance will not help.";
  }
  if (category === "engine-quota") {
    const message = engine === "kimi"
      ? "Error: Kimi's current 5-hour usage quota is exhausted. Wait for the usage window to reset, or purchase extra usage/upgrade; signing in again or restarting will not help."
      : "Error: The engine usage quota is exhausted. Wait for the quota window to reset or increase the account quota; signing in again or restarting will not help.";
    return quotaResetHint ? `${message} Reset information: ${quotaResetHint}.` : message;
  }
  if (category === "engine-content-policy") {
    return "Error: the model's content-safety policy blocked this turn. Rephrase the request or remove the triggering context or attachment, then retry. If needed, send `/reset` or switch models; restarting the instance will not help.";
  }
  if (category === "engine-timeout") {
    const duration = timeoutMinutes ? `${timeoutMinutes}-minute` : "configured";
    return isInactivityTimeout
      ? `Error: The task produced no engine output for the ${duration} inactivity interval and was stopped. Split the task or adjust \`/timeout\` first.`
      : `Error: The task hit the ${duration} runtime limit and was stopped. Retrying unchanged will likely time out again; split the task or adjust \`/timeout\` first.`;
  }
  if (category === "engine-cli") {
    if (isUnsupportedAntigravityFlag) {
      return "Error: Antigravity rejected a CLI startup flag. Update agy or remove the unsupported bridge setting, then retry.";
    }
    return [
      "Error: The engine runtime failed. Restart the instance and retry.",
      renderEngineDiagnosticDetail(detail, locale, engine),
    ].filter(Boolean).join("\n");
  }
  if (category === "file-workflow") {
    if (isTelegramAttachmentTooLargeError) {
      return "Error: This attachment is too large for the current Telegram Bot API download path. Send a file under 20 MB, share a reachable link, or place the file in the bot workspace.";
    }
    return "Error: File handling failed while preparing your request. Retry with a smaller or different file.";
  }
  if (category === "workflow-state") {
    return "Error: Internal workflow state is unavailable right now. Retry the request later or ask the operator to inspect the service state.";
  }
  if (category === "session-state") {
    return "Error: Session state is unavailable right now. The operator needs to repair session state and retry.";
  }
  if (category === "unknown") {
    return "Error: An unexpected failure occurred. Reset the chat or retry the request.";
  }

  return "Error: An unexpected failure occurred. Please retry.";
}

export function renderAccessCheckMessage(locale: Locale = "en"): string {
  return locale === "zh" ? "正在检查访问权限..." : "Checking access policy...";
}

export function renderAttachmentDownloadMessage(count: number, locale: Locale = "en"): string {
  if (locale === "zh") {
    return `正在下载 ${count} 个附件...`;
  }
  return `Downloading ${count} attachment${count === 1 ? "" : "s"}...`;
}

export function renderExecutionMessage(locale: Locale = "en"): string {
  return locale === "zh" ? "正在处理你的请求..." : "Working on your request...";
}

export function renderUnauthorizedMessage(locale: Locale = "en"): string {
  return locale === "zh" ? "此聊天未被授权使用该实例。" : "This chat is not authorized for this instance.";
}

export function renderPrivateChatRequiredMessage(locale: Locale = "en"): string {
  return locale === "zh" ? "此 bot 只接受私聊。" : "This bot only accepts private chats.";
}

export function renderSingleChatLockedMessage(locale: Locale = "en"): string {
  return locale === "zh"
    ? "此实例已锁定到另一个聊天。若要允许多个聊天，请先显式开启 multi-chat。"
    : "This instance is locked to another chat. Enable multi-chat before pairing or allowing a different chat.";
}

export function renderPairingMessage(code: string, locale: Locale = "en"): string {
  return locale === "zh" ? `使用配对码 ${code} 配对此私聊` : `Pair this private chat with code ${code}`;
}
