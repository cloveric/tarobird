import type { ScannedSession } from "../runtime/session-scanner.js";
import { localeIntlTag, type Locale } from "../runtime/locale.js";
import { hostT } from "../locales/index.js";
import type { UsageRecord } from "../state/usage-store.js";
import { channelProfile } from "./channel-profile.js";

/** Native command results use the same bounded card protocol as Bot replies. */
export function renderCommandResultCard(command: string, markdown: string): Record<string, unknown> {
  return commandCard(command, [{ tag: "markdown", content: markdown }]);
}

export function renderCommandUsageCard(usage: UsageRecord, locale: Locale, note = ""): Record<string, unknown> {
  const unmetered = usage.unmeteredRequestCount ?? 0;
  const number = (value: number) => value.toLocaleString(localeIntlTag(locale));
  const metric = (label: string, value: string) => ({
    tag: "column", width: "weighted", weight: 1, background_style: "grey", padding: "10px", corner_radius: "6px",
    elements: [{ tag: "markdown", content: `${label}\n**${value}**` }],
  });
  const row = (...columns: unknown[]) => ({ tag: "column_set", flex_mode: "flow", columns });
  const elements: unknown[] = [{ tag: "markdown", content: hostT(locale, "当前 Bot · 所有对话累计"), text_size: "notation", text_color: "grey" }];
  if (usage.requestCount === 0 && unmetered === 0) {
    elements.push({ tag: "markdown", content: hostT(locale, "暂无用量数据——处理完一轮请求后再查。") });
  } else {
    elements.push(row(metric(hostT(locale, "可计量请求"), number(usage.requestCount)), metric(hostT(locale, "未返回 token 明细"), number(unmetered))));
    if (usage.requestCount > 0) {
      elements.push(
        row(metric(hostT(locale, "输入 tokens"), number(usage.totalInputTokens)), metric(hostT(locale, "输出 tokens"), number(usage.totalOutputTokens))),
        row(metric(hostT(locale, "缓存 tokens"), number(usage.totalCachedTokens)), metric(hostT(locale, "已记录费用（美元）"), `$${usage.totalCostUsd.toFixed(4)}`)),
      );
    }
    if (unmetered > 0) elements.push({ tag: "markdown", content: hostT(locale, "部分已完成请求没有返回 token 明细，其 token 和费用未知，不能按 0 计算。") });
    if (usage.lastUpdatedAt) {
      const date = new Date(usage.lastUpdatedAt);
      const updated = Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 19).replace("T", " ")} UTC` : usage.lastUpdatedAt;
      elements.push({ tag: "markdown", text_size: "notation", text_color: "grey", content: hostT(locale, "最近更新：{0}", updated) });
    }
  }
  if (note) elements.push({ tag: "hr" }, { tag: "markdown", content: note, text_size: "notation", text_color: "grey" });
  return commandCard(hostT(locale, "/usage · 累计用量"), elements);
}

function commandCard(title: string, elements: unknown[]): Record<string, unknown> {
  return {
    schema: "2.0", config: { summary: { content: title } },
    header: { title: { tag: "plain_text", content: title } },
    body: { direction: "vertical", elements },
  };
}

export function renderCoreStatusCard(input: {
  markdown: string;
  locale: Locale;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  larkChatId: string;
  bridgeChatId: number;
  replyInThread?: boolean;
}): Record<string, unknown> {
  const labels = statusLabels(input.locale);
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: labels.title },
    },
    header: {
      title: { tag: "plain_text", content: labels.title },
      template: "blue",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        { tag: "markdown", content: input.markdown },
        { tag: "hr" },
        {
          tag: "column_set",
          flex_mode: "flow",
          columns: [
            actionColumn(labels.config, {
              cctb_lark: "config",
              action: "refresh",
              value: "now",
              conversationKey: input.conversationKey,
              bridgeChatType: input.bridgeChatType,
              larkChatId: input.larkChatId,
              bridgeChatId: input.bridgeChatId,
              ...(input.replyInThread ? { replyInThread: true } : {}),
            }, "primary"),
            actionColumn(labels.resume, {
              cctb_lark: "resume_scan",
              conversationKey: input.conversationKey,
              bridgeChatType: input.bridgeChatType,
              larkChatId: input.larkChatId,
              bridgeChatId: input.bridgeChatId,
              ...(input.replyInThread ? { replyInThread: true } : {}),
            }),
          ],
        },
      ],
    },
  };
}

export function renderCoreResumeScanCard(input: {
  kind: "claude" | "antigravity" | "kimi" | "deepseek" | "pi" | "omp";
  sessions: ScannedSession[];
  locale: Locale;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  replyInThread?: boolean;
}): Record<string, unknown> {
  const labels = resumeLabels(input.locale, input.kind);
  const elements: unknown[] = [
    {
      tag: "markdown",
      content: input.sessions.length > 0
        ? `**${labels.title}**\n${labels.hint}`
        : `**${labels.title}**\n${labels.empty}`,
    },
  ];

  input.sessions.forEach((session, index) => {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "collapsible_panel",
      expanded: index === 0,
      header: {
        title: {
          tag: "markdown",
          content: `**${optionMarker(index)}. ${session.displayName}** · ${formatTimeAgo(Date.now() - session.modifiedAt.getTime(), input.locale)}`,
        },
        vertical_align: "center",
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
        icon_position: "follow_text",
        icon_expanded_angle: -180,
      },
      border: { color: index === 0 ? "blue" : "grey", corner_radius: "5px" },
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: [
        {
          tag: "markdown",
          content: [
            `session: \`${escapeCode(session.sessionId)}\``,
            session.workspacePath ? `workspace: \`${escapeCode(session.workspacePath)}\`` : `workspace: ${labels.workspaceUnknown}`,
          ].join("\n"),
          text_size: "notation",
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: labels.resumeButton },
          type: "primary",
          width: "fill",
          behaviors: [callbackBehavior({
            cctb_lark: "resume",
            engine: input.kind,
            conversationKey: input.conversationKey,
            bridgeChatType: input.bridgeChatType,
            ...(input.replyInThread ? { replyInThread: true } : {}),
            sessionId: session.sessionId,
            dirName: session.dirName,
            displayName: session.displayName,
            workspacePath: session.workspacePath,
          })],
        },
      ],
    });
  });

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: labels.title },
    },
    header: {
      title: { tag: "plain_text", content: labels.title },
      template: "blue",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

function statusLabels(locale: Locale): { title: string; config: string; resume: string } {
  return {
    title: hostT(locale, channelProfile() === "gateway" ? "/status · 会话状态" : "飞书会话状态"),
    config: hostT(locale, "打开配置"),
    resume: hostT(locale, "恢复会话"),
  };
}

function resumeLabels(locale: Locale, kind: "claude" | "antigravity" | "kimi" | "deepseek" | "pi" | "omp"): {
  title: string;
  hint: string;
  empty: string;
  resumeButton: string;
  workspaceUnknown: string;
} {
  const titleKey = kind === "omp" ? "恢复 oh-my-pi 会话" : kind === "pi" ? "恢复 Pi 会话"
    : kind === "antigravity" ? "最近的 Antigravity conversation"
    : kind === "deepseek" ? "恢复 DeepSeek Harness session"
    : kind === "kimi" ? "恢复 Kimi session"
    : "恢复历史会话";
  const emptyKey = kind === "omp" ? "没有找到 oh-my-pi 会话。" : kind === "pi" ? "没有找到 Pi 会话。"
    : kind === "antigravity" ? "最近 24 小时内没有找到 Antigravity conversation。"
    : kind === "deepseek" ? "没有找到 DeepSeek Harness session。"
    : kind === "kimi" ? "没有找到 Kimi session。"
    : "最近 1 小时内没有找到本地 session。";
  return {
    title: hostT(locale, titleKey),
    hint: hostT(locale, "选择一个历史会话，当前飞书会话会绑定到这段上下文。"),
    empty: hostT(locale, emptyKey),
    resumeButton: hostT(locale, kind === "antigravity" ? "绑定此 conversation" : "恢复此会话"),
    workspaceUnknown: hostT(locale, "未知"),
  };
}

function actionColumn(label: string, value: Record<string, unknown>, type: "primary" | "default" = "default"): Record<string, unknown> {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    elements: [
      {
        tag: "button",
        text: { tag: "plain_text", content: label },
        type,
        width: "fill",
        behaviors: [callbackBehavior(value)],
      },
    ],
  };
}

function callbackBehavior(value: Record<string, unknown>): Record<string, unknown> {
  return { type: "callback", value };
}

function optionMarker(index: number): string {
  if (index >= 0 && index < 26) {
    return String.fromCharCode("A".charCodeAt(0) + index);
  }
  return String(index + 1);
}

function formatTimeAgo(ms: number, locale: Locale): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return hostT(locale, "刚刚");
  if (minutes < 60) return hostT(locale, "{0} 分钟前", minutes);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hostT(locale, "{0} 小时 {1} 分钟前", hours, rest);
}

function escapeCode(value: string): string {
  return value.replace(/`/g, "'");
}
