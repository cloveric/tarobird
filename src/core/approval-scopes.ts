import type { EngineApprovalScopes } from "../codex/adapter.js";
import type { Locale } from "../runtime/locale.js";
import { hostT } from "../locales/index.js";

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
  if (!scope) return "";
  const keys = completed
    ? { once: "已允许一次。", turn: "已允许本轮。", session: "已允许本会话。", always: "已按引擎的持续授权选项允许后续调用。", deny: "已拒绝。" }
    : { once: "允许一次", turn: "本轮允许", session: "本会话允许", always: "允许后续调用", deny: "拒绝" };
  return hostT(locale, keys[scope]);
}

export function unsupportedApprovalScope(locale: Locale): string {
  return hostT(locale, "该请求不支持此授权范围。请选择卡片上的可用按钮，或拒绝请求。");
}
