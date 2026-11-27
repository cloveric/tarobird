import { SessionHistoryPendingError } from "../state/session-history-error.js";
import { PiRpcCommandError } from "../codex/pi-rpc-client.js";
import { OmpRpcCommandError, OmpStartupError } from "../codex/omp-rpc-client.js";
import { OmpFrameError, OmpProtocolVersionError } from "../codex/omp-rpc-protocol.js";
import { ENGINE_CONFIG_ERROR_CODE, EngineConfigError } from "../state/engine-config-error.js";
import { FileWorkflowPreparationError } from "./file-workflow.js";
import { EngineHistoryBusyError, EngineIncompleteResponseError } from "../codex/adapter.js";
import { hostT } from "../locales/index.js";
import type { Locale } from "./locale.js";

export type FailureCategory =
  | "auth"
  | "write-permission"
  | "telegram-conflict"
  | "telegram-delivery"
  | "engine-settings"
  | "engine-cli"
  | "engine-backend"
  | "engine-rate-limit"
  | "engine-quota"
  | "engine-content-policy"
  | "engine-timeout"
  | "engine-busy"
  | "engine-thread-locked"
  | "engine-incomplete"
  | "engine-tool-input"
  | "engine-request-rejected"
  | "file-workflow"
  | "workflow-state"
  | "session-state"
  | "unknown";

export interface BusErrorSemantics {
  code: string;
  retryable: boolean;
}

function normalizeErrorText(error: unknown): string {
  if (error instanceof Error) {
    return [error.name, error.message].filter(Boolean).join("\n");
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

export function renderMalformedToolInputError(locale: Locale): string {
  return hostT(locale, "模型返回的工具调用参数格式有误，本轮已停止。请先核对已执行操作的结果，再继续未完成的任务；无需重启实例。");
}

/** An Office-specific wait is not evidence that the user needs to remove all
 * runtime limits. Keep the recovery advice consistent across App and CLI. */
export function renderDeepSeekOfficeTimeout(error: unknown, locale: Locale): string | undefined {
  const minutes = normalizeErrorText(error).match(/DeepSeek Harness turn timed out after (\d+) minutes? waiting for office_(?:render|convert|recalculate);/)?.[1];
  if (!minutes) return undefined;
  return hostT(locale, "Office 工具超过 {0} 分钟未返回，本轮已停止。请先检查运行 Bot 的 Mac 上是否有待处理的权限提示；若文件已经生成，可让 Bot 先发送文件，再重试预览或转换。", minutes);
}

export function extractModelEffortMismatch(error: unknown): { model: string; effort: string; available: string[] } | undefined {
  const text = normalizeErrorText(error);
  if (!/invalid model selection/i.test(text)) return undefined;
  // A concrete AGY preset encodes its only effort. Capture only the bounded
  // model identifier and known levels; never surface the surrounding stderr.
  const conflict = text.match(/--model ([a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}-(low|medium|high|xhigh|max|ultra)) conflicts with --effort=(low|medium|high|xhigh|max|ultra)\b/i);
  if (conflict) return { model: conflict[1]!, effort: conflict[3]!.toLowerCase(), available: [conflict[2]!.toLowerCase()] };
  // Pi provider/model IDs may include escaped providers, tags and context
  // suffixes. Require the whole bounded identifier, never a partial path/tail.
  const match = text.match(/invalid model selection(?: \([^\r\n]{1,512}\))?: ([a-zA-Z0-9][a-zA-Z0-9._/%:\[\]-]{0,511}|the current model) has no "(off|minimal|low|medium|high|xhigh|max|ultra)" effort \(available: ([a-z, ]{1,80})\)/i);
  if (!match) return undefined;
  const available = match[3]!.split(",").map((v) => v.trim().toLowerCase()).filter((v) => /^(off|minimal|low|medium|high|xhigh|max|ultra)$/.test(v));
  return available.length ? { model: match[1]!, effort: match[2]!, available } : undefined;
}
export function renderEngineSettingsError(error: unknown, locale: Locale): string {
  if (error instanceof PiRpcCommandError && error.kind === "no-model") {
    return hostT(locale, "Pi 尚无可用模型。请在运行 Bot 的主机上执行 `pi auth login` 或配置提供商凭据，然后重新读取模型列表并重试。");
  }
  if (error instanceof OmpRpcCommandError) {
    const code = error.code?.toLowerCase();
    if (code === "no_model" || code === "no-model") {
      return hostT(locale, "omp 尚无可用模型。请在运行 Bot 的主机上运行 `omp` 并执行 `/login`（或配置提供商凭据），然后重新读取模型列表并重试。");
    }
    if (code === "goal_continuation_disabled") {
      return hostT(locale, "此 omp 运行时未启用 RPC 目标自动续接，目标模式无法自动推进。请检查主机上的 omp 配置或更新 omp 后重试。");
    }
    if (code === "model_unavailable" || code === "model-unavailable" || code === "invalid_model") {
      return hostT(locale, "所选模型在 omp 中不可用。请检查模型名称和供应商登录状态，或选择可用模型后重试。");
    }
    if (code === "invalid_thinking_level") {
      return hostT(locale, "所选模型不支持此思考强度。请在 Bot 的思考强度设置中调整，或选择跟随默认；无需重启。");
    }
  }
  if (error instanceof EngineConfigError && error.setting === "budget" || normalizeErrorText(error).includes(`${ENGINE_CONFIG_ERROR_CODE}: Bot budget configuration is invalid`)) {
    return hostT(locale, "无法确认 Bot 的预算配置，自动恢复已停止。请修复主机上此 Bot 的 config.json 后继续；原会话已保留。");
  }
  if (error instanceof EngineConfigError || normalizeErrorText(error).includes(`${ENGINE_CONFIG_ERROR_CODE}:`)) {
    return hostT(locale, "无法确认 Bot 的权限配置，本次执行已停止。请修复主机上此 Bot 的 config.json 后重试；不会自动切换为完全访问。");
  }
  switch (deepSeekSelectionFailure(error)) {
    case "model_unavailable":
      return hostT(locale, "此 Bot 使用的模型不在主机当前的 DeepSeek Harness 目录中（可能已删除，或其供应商不可用）。请在 Bot 的模型设置中重新读取并选择可用模型，或检查 DSH 默认模型；不会自动换成其他模型，无需重启实例。");
    case "model_id_invalid":
      return hostT(locale, "此 Bot 保存的 DeepSeek 模型标识无效。请在 Bot 的模型设置中重新选择模型；不会自动换成其他模型，无需重启实例。");
    case "effort_incompatible":
      return hostT(locale, "所选 DeepSeek 模型不支持此 Bot 的思考强度。请在 Bot 的思考强度设置中选择该模型提供的档位，或选择跟随默认；不会自动改用其他档位，无需重启实例。");
    case "model_catalog_unavailable":
      return hostT(locale, "DeepSeek Harness 暂未完整返回模型目录（有供应商读取失败），为避免用错模型，本轮未执行。请检查主机上的 DSH 供应商配置与授权后重试；不会自动换成其他模型，无需重启实例。");
    case "selection_unconfirmed":
      return hostT(locale, "DeepSeek Harness 未确认此 Bot 的模型选择，为避免用错模型，本轮未执行。请重试；若持续出现，请在 Bot 的模型设置中重新选择模型。不会自动换成其他模型。");
  }
  if (isOmpModelUnavailable(normalizeErrorText(error))) {
    return hostT(locale, "所选模型在 omp 中不可用。请检查模型名称和供应商登录状态，或选择可用模型后重试。");
  }
  if (isPiModelUnavailable(normalizeErrorText(error))) {
    return hostT(locale, "所选模型在 Pi 中不可用。请检查模型名称和供应商登录状态，或选择可用模型后重试。");
  }
  const mismatch = extractModelEffortMismatch(error);
  if (!mismatch) return hostT(locale, "模型与思考强度不兼容，请调整 Bot 的模型或 effort 后重试。");
  const listSep = locale === "en" ? ", " : "、";
  return hostT(locale, "模型 {0} 不支持 {1}。可用档位：{2}。请在 Bot 的思考强度设置中调整，或选择跟随默认；无需重启。", mismatch.model, mismatch.effort, mismatch.available.join(listSep));
}

const PROVIDER_MODEL_REFUSAL_RE = /\bmodel\b[^.]{0,80}\b(?:not (?:found|supported|available|allowed|enabled)|does not exist|unsupported|no access)|\b(?:unsupported|unknown|invalid) model\b|do(?:es)? not have access to (?:the )?model|model_not_found/i;
const PROVIDER_SIZE_RE = /too (?:long|large)|context(?:[ _-](?:length|window))|maximum context|token limit|payload/i;

/** A CommonMark code span around one line of text: a fence longer than any backtick run inside it. */
function codeSpan(text: string): string {
  const fence = "`".repeat(Math.max(0, ...Array.from(text.matchAll(/`+/g), run => run[0].length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * The reply for a model request Pi reported as failed: what the provider said
 * (as read by piProviderFailure) and the step that can help. Quota,
 * rate-limit, content-policy and sign-in failures keep their own wording.
 */
export function renderPiProviderFailure(error: unknown, category: FailureCategory, locale: Locale): string | undefined {
  if (!(error instanceof PiRpcCommandError) || !error.provider) return undefined;
  if (!["engine-request-rejected", "engine-backend", "engine-cli", "unknown"].includes(category)) return undefined;
  const { status, code, reason } = error.provider;
  const label = [status !== undefined ? `HTTP ${status}` : "", code ?? ""].filter(Boolean).join(" · ");
  const parenLabel = label ? (locale === "en" ? ` (${label})` : `（${label}）`) : "";
  // The provider's own words in a code span, so no Markdown renderer reads them as markup.
  const said = reason ? hostT(locale, "\n提供商说明：{0}", codeSpan(reason)) : "";
  const kept = hostT(locale, "原会话已保留，未自动重发请求。");
  if (category === "engine-request-rejected") {
    const head = hostT(locale, "错误：模型服务拒绝了本轮请求{0}。", parenLabel);
    const subject = `${code ?? ""} ${reason ?? ""}`;
    const step = status === 403 || status === 404 || PROVIDER_MODEL_REFUSAL_RE.test(subject)
      ? hostT(locale, "所选模型可能不适用于当前提供商账号或登录方式。请换一个模型（/model 或「Pi 对话设置」）后重试，或检查该提供商的账号权限；重启实例无效。")
      : status === 413 || PROVIDER_SIZE_RE.test(subject)
        ? hostT(locale, "请求内容超出了模型或服务的限制。请缩短输入、减少附件，或先用 /compact 压缩上下文后重试；重启实例无效。")
        : hostT(locale, "请检查所选模型、思考强度和附件后重试；重启实例无效。");
    return `${head}${said}\n${step}${kept}`;
  }
  if (category === "engine-backend") {
    const head = hostT(locale, "错误：模型服务暂时出错或连接中断{0}。", parenLabel);
    const step = hostT(locale, "请稍后重试，或临时换一个模型；无需重启实例。");
    return `${head}${said}\n${step}${kept}`;
  }
  const head = hostT(locale, "错误：Pi 的模型请求失败{0}。", parenLabel);
  const step = hostT(locale, "可以稍后重试；若反复出现，请换一个模型或检查提供商设置。");
  return `${head}${said}\n${step}${kept}`;
}

function isDeepSeekWriterHeld(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "session/writer-held";
}

/** Kimi answered at once with no output and no queue receipt: the prompt was
 * not processed. The adapter owns this exact message; model text never uses it. */
export const KIMI_PROMPT_NOT_PROCESSED_MESSAGE = "Kimi did not process this message: the prompt ended at once with no output and no queue receipt";
function isKimiPromptNotProcessed(error: unknown): boolean {
  return normalizeErrorText(error).includes(KIMI_PROMPT_NOT_PROCESSED_MESSAGE);
}

export function renderEngineBusyError(locale: Locale, error?: unknown): string {
  if (isKimiPromptNotProcessed(error)) {
    return hostT(locale, "Kimi 没有处理这条消息：它立即结束了本轮，没有任何输出，可能正忙于自己的后台任务。请稍后重新发送。");
  }
  // Telegram passes the detail string only after classifying the typed error.
  if (isDeepSeekWriterHeld(error) || typeof error === "string" && error.includes("is already owned by an active write handle")) {
    return hostT(locale, "DeepSeek 会话仍被占用，暂时无法接收这条消息。请稍后重试，无需清空对话。");
  }
  return hostT(locale, "此 Bot 的当前任务或后台工作尚未结束。请等待完成后再重试，无需重启或清空对话。");
}

export function extractQuotaResetHint(error: unknown): string | undefined {
  const text = normalizeErrorText(error).replace(/\s+/g, " ").trim();
  const match = text.match(/\b(?:resets?|will reset)\s+(?:in|at|on)\s+([^.;\n]{1,96})/i);
  return match?.[0]?.trim();
}

const NAMED_ENGINE_RE = /(?:^|[^a-z0-9_./-])(?:codex|claude|kimi|deepseek|dsh|antigravity|agy)(?=$|[^a-z0-9_./-])/;
// A bare "pi" also means a number or a Raspberry Pi. Require a runtime label
// or one of our typed adapter error names before treating it as this engine.
const PI_RUNTIME_LABEL_RE = /(?:^|[^a-z0-9_./-])pi (?:cli|rpc|adapter|bridge)(?=$|[^a-z0-9_./-])/;
const PI_RUNTIME_ERROR_RE = /(?:^|[\r\n])pi(?:startup|rpc(?:command|closed|timeout)|bridge(?:control|handshake)|nativebridgeunavailable)error(?:$|[\r\n:])/;
const OMP_RUNTIME_LABEL_RE = /(?:^|[^a-z0-9_./-])(?:omp|oh-my-pi) (?:cli|rpc|adapter|bridge|session|worker)(?=$|[^a-z0-9_./-])/;
const OMP_RUNTIME_ERROR_RE = /(?:^|[\r\n])omp(?:startup|protocolversion|frame|rpccommand)error(?:$|[\r\n:])/;
function hasNamedEngineSignal(text: string): boolean {
  return NAMED_ENGINE_RE.test(text) || PI_RUNTIME_LABEL_RE.test(text) || PI_RUNTIME_ERROR_RE.test(text) || OMP_RUNTIME_LABEL_RE.test(text) || OMP_RUNTIME_ERROR_RE.test(text);
}
// Exact messages thrown by deepseek-harness-adapter.ts while selecting the Bot's model before a
// prompt. Only the adapter's own bounded message matches; native or tool text is never scanned.
const DEEPSEEK_SELECTION_RE = /^DeepSeek Harness (model_unavailable|model_id_invalid|effort_incompatible|model_catalog_unavailable|selection_unconfirmed)$/;
function deepSeekSelectionFailure(error: unknown): string | undefined {
  return DEEPSEEK_SELECTION_RE.exec(error instanceof Error ? error.message : typeof error === "string" ? error : "")?.[1];
}
function isPiModelUnavailable(text: string): boolean {
  return /invalid model selection: [^\r\n]{1,512} is not available in pi\./i.test(text);
}
function isOmpModelUnavailable(text: string): boolean {
  return /invalid model selection: [^\r\n]{1,512} is not available in omp\./i.test(text);
}
const ENGINE_RUNTIME_RE =
  /\b(?:runtime|process|spawn|adapter|binary|cli|app-server|startup|start|starting|transport|stream|session|turn|exited|exit code)\b/;
const ENGINE_FAILURE_RE = /\b(?:failed|failure|error|crash|crashed|timeout|timed out|disconnected)\b/;

function hasEngineCliSignal(text: string): boolean {
  if (text.includes("turn.failed") || text.includes("engine cli")) {
    return true;
  }

  if (/\bengine\b/.test(text) && (ENGINE_RUNTIME_RE.test(text) || ENGINE_FAILURE_RE.test(text))) {
    return true;
  }

  return PI_RUNTIME_ERROR_RE.test(text) || OMP_RUNTIME_ERROR_RE.test(text) || hasNamedEngineSignal(text) && (ENGINE_RUNTIME_RE.test(text) || ENGINE_FAILURE_RE.test(text));
}


/** Category of a failed Pi model request by the provider's status; undefined when nothing says which. */
export function piProviderFailureCategory(error: unknown): "engine-request-rejected" | "engine-backend" | undefined {
  if (!(error instanceof PiRpcCommandError) || !error.provider) return undefined;
  const { status, connection } = error.provider;
  // 408: the provider gave up waiting for this request, which is not a refusal of its content.
  if (status !== undefined) return status >= 500 || status === 408 ? "engine-backend" : "engine-request-rejected";
  return connection ? "engine-backend" : undefined;
}

export function classifyFailure(error: unknown): FailureCategory {
  if (error instanceof SessionHistoryPendingError) return "workflow-state";
  if (error instanceof EngineHistoryBusyError) return "engine-busy";
  if (error instanceof PiRpcCommandError) {
    if (error.kind === "no-model" || error.kind === "model-unavailable") return "engine-settings";
    if (error.kind === "auth") return "auth";
    if (error.kind === "busy" || error.kind === "compacting") return "engine-busy";
  }
  if (error instanceof OmpProtocolVersionError || error instanceof OmpFrameError || error instanceof OmpStartupError) {
    return "engine-cli";
  }
  if (error instanceof OmpRpcCommandError) {
    const code = error.code?.toLowerCase();
    if (code === "cost_cap" || code === "budget_exceeded" || code === "quota_exceeded") return "engine-quota";
    if (code === "no_model" || code === "no-model" || code === "model_unavailable" || code === "model-unavailable" || code === "invalid_model" || code === "invalid_thinking_level" || code === "goal_continuation_disabled") {
      return "engine-settings";
    }
    if (code === "auth" || code === "unauthorized" || code === "unauthenticated" || error.httpStatus === 401) return "auth";
    if (code === "rate_limit" || code === "rate_limited" || error.httpStatus === 429) return "engine-rate-limit";
    if (code === "session_busy" || code === "busy" || code === "compacting") return "engine-busy";
    if (error.httpStatus !== undefined) {
      return error.httpStatus >= 500 || error.httpStatus === 408 ? "engine-backend" : "engine-request-rejected";
    }
  }
  if (error instanceof Error && ["EngineRecoveryUnconfirmedError", "EngineRecoveryExhaustedError"].includes(error.name)) return "engine-incomplete";
  if (error instanceof Error && error.name === "EngineRecoveryBudgetError") return "engine-quota";
  if (error instanceof EngineIncompleteResponseError) return "engine-incomplete";
  if (isDeepSeekWriterHeld(error) || isKimiPromptNotProcessed(error)) return "engine-busy";
  if (error instanceof EngineConfigError || normalizeErrorText(error).includes(`${ENGINE_CONFIG_ERROR_CODE}:`)) return "engine-settings";
  if (error instanceof FileWorkflowPreparationError) {
    return "file-workflow";
  }

  // Harness rejects the provider's assembled tool arguments at message_stop.
  // Earlier tools may already have run; this is neither a CLI crash nor proof
  // that replay is safe. Do not match arbitrary JSON/config/tool-file failures.
  if (/^(?:DeepSeek Harness agent failed: )?DeepSeek Messages stream: tool input is invalid JSON(?:\r?\n|$)/i.test(error instanceof Error ? error.message : typeof error === "string" ? error : "")) {
    return "engine-tool-input";
  }

  // Claude MCP startup warnings are appended to error text for DISPLAY; their
  // content (frequently "server x: 401 Unauthorized" style) must not steer
  // classification of the underlying failure — a misconfigured MCP server
  // would otherwise turn every failure on the instance into "auth" and
  // trigger a spurious full-turn auth retry (duplicating side effects).
  const rawText = normalizeErrorText(error);
  const mcpWarningIndex = rawText.search(/⚠️ MCP startup warnings?:/u);
  const text = (mcpWarningIndex >= 0 ? rawText.slice(0, mcpWarningIndex) : rawText).toLowerCase();

  // Native Pi labels can contain Unicode or spaces. Recognize that bounded
  // diagnostic as settings, while rendering only the safe identifier above.
  if (deepSeekSelectionFailure(error)) return "engine-settings";
  if (extractModelEffortMismatch(text) || /invalid model selection: [^\r\n]{1,512} has no "(?:off|minimal|low|medium|high|xhigh|max|ultra)" effort \(available: [a-z, ]{1,80}\)/.test(text) || isPiModelUnavailable(text) || isOmpModelUnavailable(text) || /invalid model selection: \S{1,512} does not support effort/.test(text)) return "engine-settings";

  // A Codex thread whose writer lock is held elsewhere. The adapter appends an
  // actionable diagnosis naming the holder; keep it as its own category so the
  // channel renderers show that text instead of a generic "run failed".
  if (text.includes("already has an active writer")) {
    return "engine-thread-locked";
  }

  // This is the adapter's own same-process reservation, not a stale writer
  // lock held by another CLI. The active turn remains healthy and the caller
  // can retry once it settles.
  if (text.includes("already has an in-flight turn") || text.includes("approval mode changed while busy")) {
    return "engine-busy";
  }

  // Some CLIs wrap account quota exhaustion in an authentication-looking 403
  // (Kimi currently prefixes it with "Authentication required"). Detect the
  // actionable quota text first so users are not told to sign in again.
  if (
    text.includes("you've hit your usage limit") ||
    text.includes("you've hit your limit") ||
    text.includes("you've hit your fast limit") ||
    text.includes("you've hit your monthly spend limit") ||
    text.includes("you've hit your channel's monthly spend limit") ||
    text.includes("you've reached your usage limit") ||
    text.includes("you've reached your 5-hour usage limit") ||
    text.includes("quota exceeded") ||
    text.includes("usage limit exceeded") ||
    text.includes("usage limit reached") ||
    text.includes("spend limit reached") ||
    text.includes("usagelimitexceeded") ||
    text.includes("quota will reset when the current") ||
    text.includes("purchase extra usage") ||
    text.includes("insufficient_quota") ||
    text.includes("billing hard limit has been reached") ||
    /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/.test(text) ||
    /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/.test(text) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/.test(text) ||
    (hasNamedEngineSignal(text) && (text.includes("payment required") || /\b402\b/.test(text)))
  ) {
    return "engine-quota";
  }

  const isChannelRateLimit = /\b(?:telegram|lark|feishu)\b/.test(text);
  if (
    !isChannelRateLimit
    && (
      /\bapi(?:_| )error(?:_| )status\s*[:=]\s*429\b/.test(text)
      || /\bapi error\s*:\s*429\b/.test(text)
      || /\brate[\s_-]*limit[\s_-]*(?:exceeded|reached)\b/.test(text)
      || (/\b429\b/.test(text) && /\b(?:rate limit(?:ed|ing)?|too many requests|resource[_ ]exhausted)\b/.test(text))
      || (hasNamedEngineSignal(text) && /\b(?:http\s*)?(?:status(?: code)?\s*[:=]?\s*)?429\b/.test(text))
    )
  ) {
    return "engine-rate-limit";
  }

  // Provider-side safety filters reject the content of a turn, not the engine
  // process. Retrying the same input or restarting the instance cannot help.
  // Keep the exact DeepSeek wording and common structured provider codes here,
  // before the generic "DeepSeek ... failed" engine-cli classification.
  if (
    text.includes("content exists risk")
    || text.includes("responsibleai policy violation")
    || /\b(?:content|safety)[\s_-]*(?:filter|policy)[\s_-]*(?:blocked|violation|rejected|triggered)\b/.test(text)
    || /\b(?:blocked|rejected)\b.{0,48}\b(?:content|safety)[\s_-]*(?:filter|policy)\b/.test(text)
    || (hasNamedEngineSignal(text) && /\b(?:content_filter|policy_violation)\b/.test(text))
  ) {
    return "engine-content-policy";
  }

  if (
    text.includes("not logged in") ||
    text.includes("unauthorized") ||
    text.includes("unauthorised") ||
    text.includes("missing bearer") ||
    text.includes("please run /login") ||
    text.includes("login required") ||
    text.includes("authentication required") ||
    text.includes("authentication failed") ||
    text.includes("not logged into antigravity") ||
    text.includes("failed to authenticate") ||
    text.includes("authentication_error") ||
    text.includes("invalid authentication credentials") ||
    // Digit-bounded: a bare substring match also hit token counts like
    // "84012 tokens" and misclassified unrelated failures as auth.
    /\b401\b/.test(text)
  ) {
    return "auth";
  }

  // A model request Pi reported as failed, with the provider's own status. Quota, rate
  // limits, content policy and sign-in are recognised above from the same text; what is
  // left is the provider refusing this request (4xx) or failing to serve it (5xx, a lost
  // connection). Neither is the engine process failing, and a "permission denied" from a
  // provider is not the disk refusing a write.
  const providerCategory = piProviderFailureCategory(error);
  if (providerCategory) return providerCategory;

  if (
    text.includes("read-only") ||
    text.includes("write access denied") ||
    text.includes("permission denied") ||
    text.includes("write permission") ||
    text.includes("read only")
  ) {
    return "write-permission";
  }

  if (text.includes("409 conflict") || text.includes("telegram conflict") || text.includes("another process is polling")) {
    return "telegram-conflict";
  }

  if (
    text.includes("telegram attachment is too large to download via bot api") ||
    text.includes("telegram api request failed for getfile") ||
    text.includes("telegram api request failed for downloadfile") ||
    // Lark equivalent: an inbound Feishu attachment over the documented
    // download limit. Without this branch it fell through to "unknown" and the
    // user got the generic "failed to prepare the Lark message" instead of a
    // message telling them to compress or split the file.
    text.includes("lark attachment is too large to download")
  ) {
    return "file-workflow";
  }

  // The Codex engine reconnects to its model backend and surfaces
  // "Reconnecting... N/M" on its stderr; when those attempts are exhausted the
  // turn fails. This is a transient backend-connectivity fault (retry usually
  // works), distinct from a process/startup engine-cli failure — so it gets its
  // own category and a clearer "retry" message instead of the generic one.
  if (/reconnecting\D{0,8}\d+\s*\/\s*\d+/.test(text)) {
    return "engine-backend";
  }

  if (
    text.includes("api error: 529") ||
    text.includes("api_error_status=529") ||
    text.includes("selected model is at capacity") ||
    text.includes("no capacity available for model") ||
    (text.includes("overloaded") && (text.includes("api error") || text.includes("claude") || text.includes("codex")))
  ) {
    return "engine-backend";
  }

  // A long turn cut by the single-turn time cap ("... turn timed out after N
  // minutes") is NOT a crash — restarting won't help, it would just time out
  // again. Its own category gets an accurate message pointing at the /timeout
  // toggle that lifts the cap. Checked before the generic engine-cli signal,
  // which "timed out"+"turn" would otherwise match.
  if (/\bturn (?:timed out|became inactive) after \d+\s*minute/.test(text)) {
    return "engine-timeout";
  }

  // The engine is healthy but busy: background tasks from an earlier turn are
  // still running, so a settings change (model/effort/approval/workspace) cannot
  // rebuild the session yet. Restarting the instance is exactly the wrong advice,
  // which is what the engine-cli branch below would have produced ("claude" +
  // "session" matches its signal) — so this is checked first.
  if (text.includes("background task") && text.includes("still running")) {
    return "engine-busy";
  }

  if (hasEngineCliSignal(text)) {
    return "engine-cli";
  }

  if (
    text.includes("senddocument") ||
    text.includes("sendmessage") ||
    text.includes("editmessage") ||
    text.includes("message is too long") ||
    text.includes("telegram api") ||
    text.includes("telegram delivery") ||
    text.includes("message to edit not found") ||
    text.includes("bad request: chat not found")
  ) {
    return "telegram-delivery";
  }

  if (
    text.includes("invalid file workflow state") ||
    text.includes("file workflow state unreadable") ||
    text.includes("usage state is corrupt")
  ) {
    return "workflow-state";
  }

  if (
    text.includes("archive summary") ||
    text.includes("archive extraction") ||
    text.includes("failed to extract archive") ||
    text.includes("attachment download") ||
    text.includes("failed to download attachment") ||
    text.includes("pdf text") ||
    text.includes("file workflow")
  ) {
    return "file-workflow";
  }

  if (
    text.includes("session binding") ||
    text.includes("session-bound") ||
    text.includes("session store") ||
    text.includes("session-state") ||
    text.includes("session state") ||
    text.includes("no conversation found") ||
    text.includes("session id not found") ||
    text.includes("no such session")
  ) {
    return "session-state";
  }

  return "unknown";
}

export function getBusErrorSemantics(failureCategory: FailureCategory): BusErrorSemantics {
  switch (failureCategory) {
    case "auth":
      return { code: "auth", retryable: false };
    case "write-permission":
      return { code: "write_permission", retryable: false };
    case "telegram-conflict":
      return { code: "telegram_conflict", retryable: true };
    case "telegram-delivery":
      return { code: "telegram_delivery", retryable: true };
    case "engine-settings":
      return { code: "engine_settings", retryable: false };
    case "engine-cli":
      return { code: "engine_cli", retryable: true };
    case "engine-incomplete":
      // A previous tool may have had effects; never invite blind replay.
      return { code: "engine_incomplete", retryable: false };
    case "engine-tool-input":
      return { code: "engine_tool_input", retryable: false };
    case "engine-request-rejected":
      // The provider refused this request as it is; repeating it unchanged gets the same answer.
      return { code: "engine_request_rejected", retryable: false };
    case "engine-backend":
      return { code: "engine_backend", retryable: true };
    case "engine-rate-limit":
      return { code: "engine_rate_limit", retryable: true };
    case "engine-quota":
      return { code: "engine_quota", retryable: false };
    case "engine-content-policy":
      // The user may retry after changing the request, but automatically
      // replaying the same turn would only trigger the same policy decision.
      return { code: "engine_content_policy", retryable: false };
    case "engine-timeout":
      // Re-running the same long task as-is just times out again; not auto-retryable.
      return { code: "engine_timeout", retryable: false };
    case "engine-busy":
      // Transient: the same call succeeds once the in-flight background work ends.
      return { code: "engine_busy", retryable: true };
    case "engine-thread-locked":
      // Another writer (often an external app) owns the thread; retrying the
      // same call just fails again until a human frees it or resets the thread.
      return { code: "engine_thread_locked", retryable: false };
    case "file-workflow":
      return { code: "file_workflow", retryable: false };
    case "workflow-state":
      return { code: "workflow_state", retryable: false };
    case "session-state":
      return { code: "session_state", retryable: false };
    case "unknown":
      return { code: "unknown", retryable: true };
  }
}

/**
 * True when the engine failed because a bound session ID points at a file
 * the CLI can't find. This is recoverable by clearing the binding and
 * retrying as a fresh session.
 */
export function isStaleSessionError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name}\n${error.message}`.toLowerCase()
      : String(error).toLowerCase();
  return (
    text.includes("no conversation found") ||
    text.includes("session id not found") ||
    text.includes("no such session")
  );
}
