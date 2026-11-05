import { expect, it } from "vitest";
import { renderCommandResultCard, renderCommandUsageCard, renderCoreStatusCard } from "../src/core/command-cards.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { translateCard } from "../src/gateway/card-translator.js";
import { blocksText } from "../src/client-protocol/index.js";
import type { UsageRecord } from "../src/state/usage-store.js";

const empty = { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0, totalCostUsd: 0, lastUpdatedAt: "" };
const translated = (usage: UsageRecord = empty, locale: "zh" | "en" = "zh", note = "") => translateCard(renderCommandUsageCard(usage, locale, note));

it("shows unmetered requests separately without inventing zero tokens or dollars", () => {
  const card = translated({ ...empty, unmeteredRequestCount: 5, lastUpdatedAt: "2026-10-11T13:08:36.723Z" }, "zh", "Kimi 不上报 token 明细。");
  expect(card.title).toBe("/usage · 累计用量");
  const text = blocksText([card]);
  expect(text).toContain("可计量请求"); expect(text).toContain("**5**");
  expect(text).toContain("不能按 0 计算"); expect(text).toContain("Kimi 不上报 token 明细");
  expect(text).not.toContain("$0"); expect(text).not.toContain("输入 tokens");
  expect(text).toContain("2026-10-11 13:08:36 UTC");
});

it("keeps measured totals and limitations in distinct sections in both languages", () => {
  for (const locale of ["zh", "en"] as const) {
    const card = translated({ ...empty, requestCount: 2, unmeteredRequestCount: 3, totalInputTokens: 12345, totalOutputTokens: 678, totalCachedTokens: 90, totalCostUsd: 0.125 }, locale, "LIMITATION");
    const text = blocksText([card]);
    expect(text).toContain("12,345"); expect(text).toContain("678"); expect(text).toContain("90"); expect(text).toContain("$0.1250");
    expect(text).toContain("**2**"); expect(text).toContain("**3**");
    expect(card.elements.some(e => e.type === "divider")).toBe(true);
    expect(card.elements.at(-1)?.text).toBe("LIMITATION");
  }
});

it("keeps empty usage informative and does not show fictitious totals", () => {
  expect(blocksText([translated()])).toContain("暂无用量数据");
  expect(blocksText([translated(empty, "en")])).toContain("No usage data yet");
  expect(blocksText([translated()])).not.toContain("$0");
});

it("wraps command Markdown without changing lists, code, or newlines", () => {
  const text = "**标题**\n状态：正常\n\n- 第一项\n- 第二项\n\n```text\nline 1\nline 2\n```";
  const card = translateCard(renderCommandResultCard("/help", text));
  expect(card.title).toBe("/help"); expect(card.elements).toMatchObject([{ type: "markdown", text }]);
});

it("uses a native status title while preserving the Feishu title and actions", () => {
  const input = { markdown: "状态", locale: "zh" as const, conversationKey: "key", bridgeChatType: "private" as const, larkChatId: "chat", bridgeChatId: 123 };
  const native = translateCard(withChannelProfile("gateway", () => renderCoreStatusCard(input)));
  expect(native.title).toBe("/status · 会话状态");
  expect(blocksText([native])).toContain("打开配置");
  expect(translateCard(renderCoreStatusCard(input)).title).toBe("飞书会话状态");
});
