import { ENGINE_CONFIG_ERROR_CODE, EngineConfigError } from "../state/engine-config-error.js";
import { FileWorkflowPreparationError } from "./file-workflow.js";
import { EngineIncompleteResponseError } from "../codex/adapter.js";

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

export function renderMalformedToolInputError(locale: "zh" | "en"): string {
  return locale === "zh"
    ? "模型返回的工具调用参数格式有误，本轮已停止。请先核对已执行操作的结果，再继续未完成的任务；无需重启实例。"
    : "The model response contained malformed tool arguments, so this turn stopped. Review completed operations before continuing the unfinished task. No instance restart is needed.";
}

export function extractModelEffortMismatch(error: unknown): { model: string; effort: string; available: string[] } | undefined {
  const text = normalizeErrorText(error);
  if (!/invalid model selection/i.test(text)) return undefined;
  // A concrete AGY preset encodes its only effort. Capture only the bounded
  // model identifier and known levels; never surface the surrounding stderr.
  const conflict = text.match(/--model ([a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}-(low|medium|high|xhigh|max|ultra)) conflicts with --effort=(low|medium|high|xhigh|max|ultra)\b/i);
  if (conflict) return { model: conflict[1]!, effort: conflict[3]!.toLowerCase(), available: [conflict[2]!.toLowerCase()] };
  const match = text.match(/([a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}) has no "(low|medium|high|xhigh|max|ultra)" effort \(available: ([a-z, ]{1,80})\)/i);
  if (!match) return undefined;
  const available = match[3]!.split(",").map((v) => v.trim().toLowerCase()).filter((v) => /^(low|medium|high|xhigh|max|ultra)$/.test(v));
  return available.length ? { model: match[1]!, effort: match[2]!, available } : undefined;
}
export function renderEngineSettingsError(error: unknown, locale: "zh" | "en"): string {
  if (error instanceof EngineConfigError && error.setting === "budget" || normalizeErrorText(error).includes(`${ENGINE_CONFIG_ERROR_CODE}: Bot budget configuration is invalid`)) return locale === "zh"
    ? "无法确认 Bot 的预算配置，自动恢复已停止。请修复主机上此 Bot 的 config.json 后继续；原会话已保留。"
    : "The Bot budget configuration could not be verified, so automatic recovery stopped. Repair this Bot’s config.json on the host before continuing; the conversation is preserved.";
  if (error instanceof EngineConfigError || normalizeErrorText(error).includes(`${ENGINE_CONFIG_ERROR_CODE}:`)) return locale === "zh"
    ? "无法确认 Bot 的权限配置，本次执行已停止。请修复主机上此 Bot 的 config.json 后重试；不会自动切换为完全访问。"
    : "The Bot permission configuration could not be verified, so this turn was blocked. Repair this Bot’s config.json on the host and retry; full access was not enabled.";
  const mismatch = extractModelEffortMismatch(error);
  if (!mismatch) return locale === "zh" ? "模型与思考强度不兼容，请调整 Bot 的模型或 effort 后重试。" : "The model and effort are incompatible. Change the Bot model or effort and retry.";
  return locale === "zh"
    ? `模型 ${mismatch.model} 不支持 ${mismatch.effort}。可用档位：${mismatch.available.join("、")}。请在 Bot 的思考强度设置中调整，或选择跟随默认；无需重启。`
    : `Model ${mismatch.model} does not support ${mismatch.effort}. Available levels: ${mismatch.available.join(", ")}. Change the Bot effort or follow its default; no restart is needed.`;
}

function isDeepSeekWriterHeld(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "session/writer-held";
}

export function renderEngineBusyError(locale: "zh" | "en", error?: unknown): string {
  // Telegram passes the detail string only after classifying the typed error.
  if (isDeepSeekWriterHeld(error) || typeof error === "string" && error.includes("is already owned by an active write handle")) return locale === "zh"
    ? "DeepSeek 会话仍被占用，暂时无法接收这条消息。请稍后重试，无需清空对话。"
    : "The DeepSeek session is still occupied and could not accept this message. Try again shortly; no conversation reset is needed.";
  return locale === "zh"
    ? "此 Bot 的当前任务或后台工作尚未结束。请等待完成后再重试，无需重启或清空对话。"
    : "This Bot still has active or background work. Wait for it to finish and retry; no restart or conversation reset is needed.";
}

export function extractQuotaResetHint(error: unknown): string | undefined {
  const text = normalizeErrorText(error).replace(/\s+/g, " ").trim();
  const match = text.match(/\b(?:resets?|will reset)\s+(?:in|at|on)\s+([^.;\n]{1,96})/i);
  return match?.[0]?.trim();
}

const NAMED_ENGINE_RE = /(?:^|[^a-z0-9_./-])(?:codex|claude|kimi|deepseek|dsh|antigravity|agy)(?=$|[^a-z0-9_./-])/;
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

  return NAMED_ENGINE_RE.test(text) && (ENGINE_RUNTIME_RE.test(text) || ENGINE_FAILURE_RE.test(text));
}

export function classifyFailure(error: unknown): FailureCategory {
  if (error instanceof Error && ["EngineRecoveryUnconfirmedError", "EngineRecoveryExhaustedError"].includes(error.name)) return "engine-incomplete";
  if (error instanceof Error && error.name === "EngineRecoveryBudgetError") return "engine-quota";
  if (error instanceof EngineIncompleteResponseError) return "engine-incomplete";
  if (isDeepSeekWriterHeld(error)) return "engine-busy";
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

  if (extractModelEffortMismatch(text) || /invalid model selection: \S{1,128} does not support effort/.test(text)) return "engine-settings";

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
    (NAMED_ENGINE_RE.test(text) && (text.includes("payment required") || /\b402\b/.test(text)))
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
      || (NAMED_ENGINE_RE.test(text) && /\b(?:http\s*)?(?:status(?: code)?\s*[:=]?\s*)?429\b/.test(text))
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
    || (NAMED_ENGINE_RE.test(text) && /\b(?:content_filter|policy_violation)\b/.test(text))
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
