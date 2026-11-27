import { chunkMarkdown } from "./markdown-chunks.js";
import { extractQuotaResetHint, renderEngineSettingsError, renderEngineBusyError, renderMalformedToolInputError, renderDeepSeekOfficeTimeout, type FailureCategory } from "./error-classification.js";
import { hostT } from "../locales/index.js";

import type { Locale } from "./locale.js";
export type { Locale } from "./locale.js";
export type EngineName = "codex" | "claude" | "antigravity" | "kimi" | "deepseek" | "pi" | "omp";

// Bounded reply chunks preserve the existing shared command contract.
export function chunkReplyMessage(text: string, limit = 4000): string[] {
  return chunkMarkdown(text, limit);
}

export function renderWorkingMessage(locale: Locale = "en"): string {
  return hostT(locale, "收到，正在启动会话...");
}

export function renderErrorMessage(error: string, locale: Locale = "en"): string {
  return hostT(locale, "错误：{0}", error);
}

export function renderSessionResetMessage(repaired = false, locale: Locale = "en"): string {
  return repaired
    ? hostT(locale, "会话状态不可读，运维需要先修复实例会话状态才能重置此聊天。")
    : hostT(locale, "当前聊天的会话已重置。");
}

export function renderSessionStateErrorMessage(repairable: boolean, locale: Locale = "en"): string {
  return repairable
    ? hostT(locale, "错误：会话状态当前不可读，运维需要修复会话状态后重试。")
    : hostT(locale, "错误：会话状态当前不可用，运维需要恢复读取权限后重试。");
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
    return hostT(locale, "暂无用量数据——处理完一轮请求后再查。");
  }
  if (usage.requestCount === 0 && unmeteredRequestCount > 0) {
    const lastSeen = usage.lastUpdatedAt || "never";
    return hostT(
      locale,
      "累计用量（本实例）：\n• 可计量请求数：0\n• 未返回 token 明细的请求：{0}\n• 说明：当前引擎完成了请求，但没有返回 token 明细；不会假算为 0。\n• 最近更新：{1}",
      unmeteredRequestCount.toLocaleString(),
      lastSeen,
    );
  }
  const cost = usage.totalCostUsd.toFixed(4);
  const lastSeen = usage.lastUpdatedAt || "never";
  return [
    hostT(locale, "累计用量（本实例）：\n• 请求数：{0}", usage.requestCount.toLocaleString()),
    ...(unmeteredRequestCount > 0 ? [hostT(locale, "• 未返回 token 明细的请求：{0}", unmeteredRequestCount.toLocaleString())] : []),
    hostT(
      locale,
      "• 输入 tokens：{0}\n• 输出 tokens：{1}\n• 缓存 tokens：{2}\n• 花销：${3}\n• 最近更新：{4}",
      usage.totalInputTokens.toLocaleString(),
      usage.totalOutputTokens.toLocaleString(),
      usage.totalCachedTokens.toLocaleString(),
      cost,
      lastSeen,
    ),
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

function renderEngineName(engine: EngineName | undefined): "Codex" | "Claude" | "Kimi" | "DeepSeek" | "Antigravity" | "Pi" | "oh-my-pi" | undefined {
  if (engine === "omp") return "oh-my-pi";
  if (engine === "pi") return "Pi";
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

function inferEngineName(detail: string, target: string | undefined, engine?: EngineName): "Codex" | "Claude" | "Kimi" | "DeepSeek" | "Antigravity" | "Pi" | "oh-my-pi" | "Engine" {
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

  const targetPhrase = target === undefined ? "" : hostT(locale, "在调用 {0} 时", target);
  return hostT(locale, "详情：{0} 传输流{1}断开。上一轮还没有生成最终回答就失败了；这本身不能说明是浏览器或生图任务失败。", engineName, targetPhrase);
}

export function renderCategorizedErrorMessage(
  category: FailureCategory,
  detail: string,
  locale: Locale = "en",
  engine?: EngineName,
): string {
  const officeTimeout = category === "engine-timeout" ? renderDeepSeekOfficeTimeout(detail, locale) : undefined;
  if (officeTimeout) return officeTimeout;
  if (category === "engine-settings") return renderEngineSettingsError(detail, locale);
  if (category === "engine-busy") return renderEngineBusyError(locale, detail);
  if (category === "engine-tool-input") return renderMalformedToolInputError(locale);
  // Only a category and a recorded detail are known here; the provider's explanation is in the run's own reply.
  if (category === "engine-request-rejected") {
    return hostT(locale, "模型服务拒绝了上一轮请求。请检查所选模型、思考强度和附件后重试；重启实例无效。");
  }
  if (category === "engine-incomplete") {
    return hostT(locale, "引擎返回了占位内容，本轮未确认完成。请先检查已执行操作的结果，再决定是否继续。");
  }
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

  if (category === "write-permission") {
    return hostT(locale, "错误：当前写入策略禁止创建文件，请在允许写入的模式下重试。");
  }
  if (category === "auth") {
    if (isAntigravity) {
      return hostT(locale, "错误：Antigravity 认证缺失或过期。请先在本机打开 Antigravity CLI 重新登录，然后重试这轮 Telegram 请求。");
    }
    return hostT(locale, "错误：引擎认证缺失或过期，请重新登录此实例后重试。");
  }
  if (category === "telegram-conflict") {
    return hostT(locale, "错误：另一个 Telegram 轮询进程正在使用此 bot token，请停止重复的服务后重试。");
  }
  if (category === "telegram-delivery") {
    return hostT(
      locale,
      isTelegramFormattingError
        ? "错误：回复内容的格式被 Telegram 拒绝了。我已记录具体原因，请稍后重试或让运维检查日志。"
        : "错误：Telegram 投递暂时不可用，请稍后重试。",
    );
  }
  if (category === "engine-backend") {
    return hostT(
      locale,
      isModelCapacity
        ? "错误：模型服务暂时繁忙，无法继续本轮请求。此提示不代表账号额度用完或本机存储已满。请稍后重试，或临时切换模型；无需重启实例。"
        : "错误：引擎服务暂时过载或连接中断，请稍后再试；无需重启实例。",
    );
  }
  if (category === "engine-rate-limit") {
    return hostT(locale, "错误：模型服务当前触发限流。请稍等后重试；重置聊天或重启实例都无效。");
  }
  if (category === "engine-quota") {
    const message = hostT(
      locale,
      engine === "kimi"
        ? "错误：Kimi 当前 5 小时使用额度已用完。请等待额度窗口重置，或购买额外额度/升级套餐；重新登录或重启都无效。"
        : "错误：引擎使用额度已用完。请等待额度窗口重置或提高账户额度；重新登录或重启都无效。",
    );
    return quotaResetHint ? hostT(locale, "{0} 重置信息：{1}。", message, quotaResetHint) : message;
  }
  if (category === "engine-content-policy") {
    return hostT(locale, "错误：本轮被模型的内容安全策略拦截。请换一种表述，或移除可能触发风控的上下文或附件后重试；必要时发送 `/reset` 清除旧上下文，或切换模型。重启实例无效。");
  }
  if (category === "engine-timeout") {
    if (timeoutMinutes) {
      return isInactivityTimeout
        ? hostT(locale, "错误：任务连续 {0} 分钟没有引擎输出，已被空闲看门狗停止。请拆分任务，或先用 `/timeout` 调整时限。", timeoutMinutes)
        : hostT(locale, "错误：任务达到 {0} 分钟运行上限，已自动停止。直接原样重试通常还会超时；请拆分任务，或先用 `/timeout` 调整时限。", timeoutMinutes);
    }
    return isInactivityTimeout
      ? hostT(locale, "错误：任务连续配置的时限没有引擎输出，已被空闲看门狗停止。请拆分任务，或先用 `/timeout` 调整时限。")
      : hostT(locale, "错误：任务达到配置的时限运行上限，已自动停止。直接原样重试通常还会超时；请拆分任务，或先用 `/timeout` 调整时限。");
  }
  if (category === "engine-cli") {
    if (isUnsupportedAntigravityFlag) {
      return hostT(locale, "错误：Antigravity 拒绝了 CLI 启动参数。请更新 agy 或移除不支持的 bridge 设置后重试。");
    }
    return [
      hostT(locale, "错误：引擎运行时失败，请重启实例后重试。"),
      renderEngineDiagnosticDetail(detail, locale, engine),
    ].filter(Boolean).join("\n");
  }
  if (category === "file-workflow") {
    if (isTelegramAttachmentTooLargeError) {
      return hostT(locale, "错误：这个附件太大，当前 Telegram Bot API 不能下载到 bot 端。请压缩到 20MB 以内，或发可访问链接/把文件放到 bot workspace 后再让我读取。");
    }
    return hostT(locale, "错误：准备请求时文件处理失败，请尝试更小或不同的文件。");
  }
  if (category === "workflow-state") {
    return hostT(locale, "错误：内部工作流状态当前不可用，请稍后重试或让运维检查服务状态。");
  }
  if (category === "session-state") {
    return hostT(locale, "错误：会话状态当前不可用，运维需要修复会话状态后重试。");
  }
  if (category === "unknown") {
    return hostT(locale, "错误：发生了意外故障，请重置聊天或重试请求。");
  }

  return hostT(locale, "错误：发生了意外故障，请重试。");
}

export function renderAccessCheckMessage(locale: Locale = "en"): string {
  return hostT(locale, "正在检查访问权限...");
}

export function renderAttachmentDownloadMessage(count: number, locale: Locale = "en"): string {
  return count === 1
    ? hostT(locale, "正在下载 1 个附件...")
    : hostT(locale, "正在下载 {0} 个附件...", count);
}

export function renderExecutionMessage(locale: Locale = "en"): string {
  return hostT(locale, "正在处理你的请求...");
}

export function renderUnauthorizedMessage(locale: Locale = "en"): string {
  return hostT(locale, "此聊天未被授权使用该实例。");
}

export function renderPrivateChatRequiredMessage(locale: Locale = "en"): string {
  return hostT(locale, "此 bot 只接受私聊。");
}

export function renderSingleChatLockedMessage(locale: Locale = "en"): string {
  return hostT(locale, "此实例已锁定到另一个聊天。若要允许多个聊天，请先显式开启 multi-chat。");
}

export function renderPairingMessage(code: string, locale: Locale = "en"): string {
  return hostT(locale, "使用配对码 {0} 配对此私聊", code);
}
