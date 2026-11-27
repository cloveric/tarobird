import { hostT } from "../locales/index.js";
import type { Locale } from "./locale.js";

export type RuntimeTimeoutEngine = "codex" | "claude" | "antigravity" | "kimi" | "deepseek" | "pi" | "omp";
export type RuntimeTimeoutAction = "status" | "on" | "off";

export function renderRuntimeTimeoutMessage(
  engine: RuntimeTimeoutEngine | undefined,
  enabled: boolean,
  action: RuntimeTimeoutAction,
  locale: Locale,
): string {
  const message = renderEngineTimeoutMessage(engine, enabled, action, locale);
  if (enabled) return message;
  return message + hostT(locale, " Agent Bus 委托仍受独立的请求时限约束（默认 30 分钟；crew 分阶段设置），此开关不会更改请求时限。");
}

function renderEngineTimeoutMessage(
  engine: RuntimeTimeoutEngine | undefined,
  enabled: boolean,
  action: RuntimeTimeoutAction,
  locale: Locale,
): string {
  const name = engine === "omp" ? "oh-my-pi (omp)" : engine === "pi" ? "Pi" : engine === "deepseek"
    ? "DeepSeek Harness"
    : engine === "claude"
      ? "Claude"
      : engine === "kimi"
        ? "Kimi ACP"
        : engine === "antigravity"
          ? "Antigravity"
          : "Codex";
  const safeguards = engine === "claude" || engine === "pi" || engine === "omp"
    ? hostT(locale, "30 分钟静默看门狗（本身无硬上限）")
    : engine === "deepseek" || engine === "antigravity"
      ? hostT(locale, "6 小时硬上限和 30 分钟静默看门狗")
      : engine === "kimi"
        ? hostT(locale, "60 分钟硬上限和 30 分钟静默看门狗")
        : hostT(locale, "运行时硬上限和 30 分钟静默看门狗");

  if (action === "status") {
    if (!enabled && engine === "antigravity") {
      return hostT(locale, "{0} bridge 运行时保护当前已放开；6 小时硬上限和 30 分钟静默看门狗已关闭，但 agy 仍保留 7 天原生安全上限。用 /timeout on 恢复。", name);
    }
    return enabled
      ? hostT(locale, "{0} 运行时保护当前已启用：{1}。用 /timeout on 或 /timeout off 调整。", name, safeguards)
      : hostT(locale, "{0} 运行时保护当前已放开（硬上限和静默看门狗均已关闭）。用 /timeout on 或 /timeout off 调整。", name);
  }
  if (enabled) {
    return hostT(locale, "已恢复 {0} 运行时保护：{1}。下一轮生效。", name, safeguards);
  }
  if (engine === "claude") {
    return hostT(locale, "已放开 Claude 运行时限制，已关闭 30 分钟静默看门狗（Claude 本身无硬上限）；真卡死的任务不会自动恢复。下一轮生效。");
  }
  if (engine === "antigravity") {
    return hostT(locale, "已关闭 Antigravity 的 6 小时 bridge 硬上限和 30 分钟静默看门狗；agy 仍保留 7 天原生安全上限。下一轮生效。");
  }
  return hostT(locale, "已放开 {0} 运行时限制，已关闭硬上限和静默看门狗；真卡死的任务不会自动恢复。下一轮生效。", name);
}
