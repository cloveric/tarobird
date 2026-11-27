import type { Locale } from "../../runtime/message-renderer.js";
import { isChineseLocale } from "../../runtime/locale.js";

export type AntigravitySlashCommandAction =
  | { kind: "automation"; request: string };

/**
 * Recognizes Antigravity slash commands that are Antigravity Desktop App-only
 * and therefore cannot run natively over headless ACP/print:
 * - `/automation` (Antigravity Desktop App-only sidecar scheduler; maps to TaroBird `/cron`)
 *
 * `/swarm` and `/swarm board` are handled directly by the Antigravity ACP runtime
 * and TaroBird's in-App Swarm Board, so they are NOT intercepted here.
 */
export function parseAntigravityLocalCommand(text: string): AntigravitySlashCommandAction | null {
  const trimmed = text.trim();
  const automation = trimmed.match(/^\/automation(?:@[a-z0-9_.-]+)?(?:\s+([\s\S]*))?$/i);
  if (automation) {
    return { kind: "automation", request: (automation[1] ?? "").trim() };
  }
  return null;
}

export async function renderAntigravityLocalCommandReply(
  action: AntigravitySlashCommandAction,
  locale: Locale,
): Promise<{ commandLabel: string; markdown: string }> {
  const english = !isChineseLocale(locale);
  const samplePrompt = action.request || (english ? "Summarize unread updates" : "汇总今日待办与进展");
  return {
    commandLabel: "/automation",
    markdown: english
      ? [
          "**Scheduled Automations (`/automation`)**",
          "",
          "Antigravity's built-in `/automation` sidecar runs only inside the Antigravity desktop app and is not exposed over ACP.",
          "",
          "In TaroBird, use native durable schedules instead (each run executes automatically on the Host without keeping a chat open):",
          `- **TaroBird recurring schedule**: send \`/cron add 0 9 * * * ${samplePrompt}\` (or \`/cron list\` to view existing jobs), or open the App's **Schedules** panel.`,
          `- **In-session Antigravity timer**: send \`/schedule ${samplePrompt}\` for a timer inside this active session.`,
        ].join("\n")
      : [
          "**定时自动化（`/automation`）**",
          "",
          "Antigravity 内置的 `/automation` 侧车调度仅在 Antigravity 桌面端应用中运行，ACP 协议未对外开放该命令。",
          "",
          "在 TaroBird 中可直接使用原生持久化定时任务（由 Host 自动按时执行，无需保持对话打开）：",
          `- **TaroBird 定时任务（推荐）**：发送 \`/cron add 0 9 * * * ${samplePrompt}\`（查看现有任务用 \`/cron list\`），或直接在 App 的「定时任务」面板创建与启停。`,
          `- **当前会话内定时**：发送 \`/schedule ${samplePrompt}\` 使用 Antigravity 原生会话内定时器。`,
        ].join("\n"),
  };
}
