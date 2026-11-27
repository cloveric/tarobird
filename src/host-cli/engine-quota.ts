import { ENGINE_QUOTA_CAPABILITY, ENGINE_QUOTA_CURRENCY_CAPABILITY, quotaDirectorySchema, quotaReadingExpired, quotaScopeSchema, type QuotaDirectory, type QuotaEngine, type QuotaReason, type QuotaScope, type QuotaSnapshot, type QuotaState } from "../client-protocol/engine-quota.js";
import type { LocalHostClient } from "./client.js";

export async function engineQuotaCommand(client: Pick<LocalHostClient, "request" | "ready">, flags: { bot?: string; refresh?: boolean; revision?: string }) {
  if (!client.ready.serverCapabilities.includes(ENGINE_QUOTA_CAPABILITY)) throw new Error("请更新主机后查看模型额度 / Update the host to view model quotas.");
  if (flags.refresh && (!flags.bot || !flags.revision) || flags.revision && !flags.refresh) throw new Error("刷新前先读取额度，再使用 engines quota --bot BOT --refresh --revision REV / Read quotas before refreshing a Bot scope.");
  if (flags.bot && !/^[A-Za-z0-9_-]{1,128}$/.test(flags.bot) || flags.revision && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(flags.revision)) throw new Error("Invalid quota scope or revision");
  const params = new URLSearchParams();
  params.set("includeOmp", "1");
  if (flags.refresh) {
    params.set("refresh", "1");
    params.set("revision", flags.revision!);
  }
  if (client.ready.serverCapabilities.includes(ENGINE_QUOTA_CURRENCY_CAPABILITY)) {
    params.set("balances", "currency");
  }
  const query = params.toString();
  const url = `/api/engine-quotas${flags.bot ? `/${encodeURIComponent(flags.bot)}` : ""}${query ? `?${query}` : ""}`;
  return (flags.bot ? quotaScopeSchema : quotaDirectorySchema).parse(await client.request(url));
}

// Same verified sources as the App settings card (client/src/EngineQuota.tsx).
const guidance: Record<NonNullable<QuotaSnapshot["help"]>, string> = {
  codex_usage: "官方查看：在运行主机的 Codex CLI 中以 ChatGPT 登录后输入 /usage / Official view: sign in to Codex CLI with ChatGPT and enter /usage.",
  claude_usage: "官方查看：订阅登录时在 Claude Code 中输入 /usage，或打开 claude.ai/settings/usage / Official view: enter /usage in Claude Code or open claude.ai/settings/usage.",
  antigravity_usage: "官方查看：在 Antigravity CLI 中输入 /usage 或 /quota（AI credits 用 /credits）；GEMINI_API_KEY 请在 Google AI Studio 查看 / Official view: enter /usage or /quota (/credits for AI credits) in Antigravity CLI; check a GEMINI_API_KEY in Google AI Studio.",
  gemini_api_usage: "官方查看：GEMINI_API_KEY 没有账号额度，请在 Google AI Studio 查看 / Official view: a GEMINI_API_KEY has no account quota; check it in Google AI Studio.",
  kimi_usage: "官方查看：在 Kimi Code CLI 交互界面输入 /usage；ACP 会话的 /usage 只显示本会话 token / Official view: enter /usage in the interactive Kimi Code CLI; ACP /usage shows session tokens only.",
  deepseek_balance: "官方查看：DeepSeek 官方 API 在 platform.deepseek.com 查看余额，其他供应商在其控制台查看 / Official view: see the DeepSeek Platform (platform.deepseek.com) balance, or another provider's console.",
};

/** Human hints for standard error only; standard output keeps the strict JSON contract. */
export function engineQuotaGuidance(value: QuotaDirectory | QuotaScope, now = Date.now()): string[] {
  const groups = new Map<NonNullable<QuotaSnapshot["help"]>, string[]>();
  for (const scope of "scopes" in value ? value.scopes : [value]) {
    if (!scope.help || scope.state === "ready" && !quotaReadingExpired(scope, now)) continue;
    groups.set(scope.help, [...groups.get(scope.help) ?? [], scope.label]);
  }
  return [...groups].map(([help, labels]) => `${labels.join(", ")}: ${guidance[help]}`);
}

type Text = readonly [zh: string, en: string];
// Same wording as the App settings card: client/src/EngineQuota.tsx and its locales/en.json entries.
// tests/hub-engine-quota.test.ts keeps every pair identical to the App.
export const QUOTA_STATE_TEXT: Record<QuotaState, Text> = {
  ready: ["已读取", "Read"],
  stale: ["待更新", "Awaiting update"],
  unknown: ["尚无数据", "No data yet"],
  login_required: ["需要登录", "Sign-in required"],
  offline: ["离线", "Offline"],
  unavailable: ["暂不可用", "Unavailable"],
  unsupported: ["暂不支持", "Not supported"],
};
export const QUOTA_REASON_TEXT: Record<QuotaReason, Text> = {
  not_adapted: ["此引擎尚未接入原生额度。", "Native quota support is not yet implemented for this engine."],
  not_loaded: ["尚未读取原生额度，可点击刷新。", "Native quotas have not been read yet. Select Refresh to read them."],
  native_unverified: ["此引擎的原生额度接口尚未验证。", "This engine’s native quota interface has not been verified."],
  mode_not_supported: ["此授权方式不提供可读取的原生额度。", "This authorization mode does not provide readable native quotas."],
  no_passive_event: ["尚未收到原生额度状态，仅在正常使用中被动更新。", "No native quota status has been received. Updates arrive passively during normal use."],
  login_required: ["请先在运行主机上完成引擎登录，再刷新。", "Sign in to the engine on the Host, then refresh."],
  auth_changed: ["授权信息已变化，旧额度已清除。请核对后再次刷新。", "Authorization changed and previous quotas were cleared. Check the authorization, then refresh again."],
  scope_unverifiable: ["无法从运行主机的凭据文件确认当前账号（例如登录保存在系统钥匙串），读数不会保留；刷新时由引擎原生接口当场核对一次，只有原生回包能把当前用户、前后两次的工作区和这次用量对应到同一账号时才展示读数。", "The current account cannot be confirmed from the running Host's credential files (for example, a login stored in the system keychain). Readings are not retained; a refresh checks once through the engine's native interface, and a reading is shown only when the native replies tie the current user, the workspace before and after, and this usage snapshot to the same account."],
  offline: ["Bot 当前离线，连接恢复后重新读取列表。", "This Bot is offline. Reload the list after it reconnects."],
  timeout: ["读取原生额度超时，可稍后再刷新。", "Reading native quotas timed out. Try refreshing later."],
  cancelled: ["本次读取已取消，可重新刷新。", "This read was cancelled. You can refresh again."],
  rate_limited: ["原生服务暂时限制读取，请等待后再刷新。", "The native service is limiting reads. Wait before refreshing again."],
  invalid_response: ["原生额度数据无法确认，未将缺失数据当作零。", "Native quota data could not be verified. Missing values are not treated as zero."],
  cli_unavailable: ["主机上的引擎程序不可用，请检查后再刷新。", "The engine program on the Host is unavailable. Check it, then refresh."],
  native_error: ["暂时无法读取原生额度，可稍后再刷新。", "Native quotas could not be read. Try refreshing later."],
  host_upgrade_required: ["请更新主机与 Bot 运行程序以读取额度。", "Update the Host and Bot runtime to read quotas."],
};
export const QUOTA_CLAUDE_UNVERIFIABLE_TEXT: Text = ["Claude Code 的凭据来源无法由公开接口核实（例如 macOS 钥匙串登录），为避免显示其他账号的额度，不展示被动收到的读数。", "Claude Code's credential source cannot be verified through a public interface (for example, a macOS Keychain login). Passive readings are hidden so another account's quota is never shown."];
export const QUOTA_KIMI_API_KEY_TEXT: Text = ["当前仅配置了 API Key，未登录 Kimi For Coding 套餐账号，无套餐额度可读取。", "Only an API key is configured without a Kimi For Coding subscription login, so no plan quota is available."];
export const QUOTA_KIMI_NOT_CODING_PLAN_TEXT: Text = ["当前账号不是 Kimi For Coding 套餐账号（服务端返回 404），不提供编程套餐额度。", "This account is not a Kimi For Coding subscription account (404), so coding plan quotas are not available."];
export const QUOTA_PI_UNSUPPORTED_TEXT: Text = ["当前供应商不提供可读取的账号额度（Pi 仅统计本会话 token 与费用）。", "This provider does not provide account quotas (Pi only tracks local session tokens and cost)."];
export const QUOTA_EXPIRED_TEXT: Text = ["已过期，需重新读取", "Expired; refresh required"];
const ENGINE_NAMES: Record<QuotaEngine, string> = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity", kimi: "Kimi", deepseek: "DeepSeek", pi: "Pi", omp: "oh-my-pi (omp)" };

/** Human explanation for standard error in normal mode: why each Bot has no current reading, how to
 * refresh it, and where to check officially. Built only from protocol enums, the Bot label and the
 * public scope/revision ids already in the JSON; no native text or account identity is printed. */
export function engineQuotaNotes(value: QuotaDirectory | QuotaScope, now = Date.now()): string[] {
  const lines: string[] = [];
  for (const scope of "scopes" in value ? value.scopes : [value]) {
    const expired = scope.state === "ready" && quotaReadingExpired(scope, now);
    if (scope.state === "ready" && !expired) continue;
    const state = QUOTA_STATE_TEXT[expired ? "stale" : scope.state], code = scope.reason ?? scope.capability.reason;
    const reason = code === "scope_unverifiable" && scope.engine === "claude" ? QUOTA_CLAUDE_UNVERIFIABLE_TEXT
      : code === "mode_not_supported" && scope.engine === "kimi"
        ? (scope.authMode === "api_key" ? QUOTA_KIMI_API_KEY_TEXT : QUOTA_KIMI_NOT_CODING_PLAN_TEXT)
      : code === "mode_not_supported" && scope.engine === "pi" ? QUOTA_PI_UNSUPPORTED_TEXT
      : code ? QUOTA_REASON_TEXT[code] : expired || scope.state === "stale" ? QUOTA_EXPIRED_TEXT : undefined;
    lines.push(`${scope.label}（${ENGINE_NAMES[scope.engine]}）：${state[0]}${reason ? ` — ${reason[0]}` : ""} / ${state[1]}${reason ? ` — ${reason[1]}` : ""}`);
    // Same condition as the App's refresh button for an active (native) reader.
    if (scope.capability.mode === "active" && scope.state !== "offline" && code !== "host_upgrade_required") {
      const cooling = scope.nextRefreshAt && Date.parse(scope.nextRefreshAt) > now ? `（${scope.nextRefreshAt} 后 / after ${scope.nextRefreshAt}）` : "";
      lines.push(`  刷新 / Refresh${cooling}: tarobird engines quota --bot ${scope.id} --refresh --revision ${scope.revision}`);
    }
  }
  return [...lines, ...engineQuotaGuidance(value, now)];
}
