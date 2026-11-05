import type { EngineApprovalScopes } from "../codex/adapter.js";
import type { Locale } from "../runtime/locale.js";

export type ApprovalChoice = "once" | "session" | "deny";

// Legacy integrations retain their original once/turn behavior. Production
// native adapters declare their actual lifetime instead of inferring it from
// the transport decision's historical name "session".
export function approvalScope(scopes: EngineApprovalScopes | undefined, choice: ApprovalChoice) {
  if (choice === "deny") return "deny";
  return scopes === undefined ? (choice === "once" ? "once" : "turn") : scopes[choice];
}

export function approvalScopeLabel(scopes: EngineApprovalScopes | undefined, choice: ApprovalChoice, locale: Locale, completed = false): string {
  const scope = approvalScope(scopes, choice);
  const labels = locale === "en"
    ? completed
      ? { once: "Allowed once.", turn: "Allowed for this turn.", session: "Allowed for this session.", always: "Allowed subsequent calls using the engine's persistent option.", deny: "Denied." }
      : { once: "Allow once", turn: "Allow for this turn", session: "Allow for this session", always: "Allow subsequent calls", deny: "Deny" }
    : completed
      ? { once: "已允许一次。", turn: "已允许本轮。", session: "已允许本会话。", always: "已按引擎的持续授权选项允许后续调用。", deny: "已拒绝。" }
      : { once: "允许一次", turn: "本轮允许", session: "本会话允许", always: "允许后续调用", deny: "拒绝" };
  return scope ? labels[scope] : "";
}

export function unsupportedApprovalScope(locale: Locale): string {
  return locale === "en" ? "This request does not offer that approval scope. Choose an available button or deny it." : "该请求不支持此授权范围。请选择卡片上的可用按钮，或拒绝请求。";
}
