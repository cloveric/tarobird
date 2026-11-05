import { channelProfile } from "./channel-profile.js";
import type { Locale } from "../runtime/locale.js";
import { normalizeCoreMarkdown, renderCoreContinuationCard } from "./card-renderer.js";
import { redactCoreErrorDetail } from "./redaction.js";
import type { CoreChannelLike, CoreSendOptions } from "./types.js";

export async function sendCoreCardWithFallback(input: {
  channel: Pick<CoreChannelLike, "send">;
  chatId: string;
  card: object;
  fallbackText: string;
  options?: CoreSendOptions;
  locale: Locale;
}): Promise<{ messageId: string; fallback: boolean }> {
  try {
    const sent = await input.channel.send(input.chatId, { card: input.card }, input.options);
    return { messageId: sent.messageId, fallback: false };
  } catch (error) {
    const sent = await input.channel.send(input.chatId, {
      text: renderCoreCardFallbackText(input.fallbackText, input.locale, error),
    }, input.options);
    return { messageId: sent.messageId, fallback: true };
  }
}

/** Deliver chunks 2..N after a run card has already rendered chunk 1. */
export async function deliverCoreContinuationCards(input: {
  channel: Pick<CoreChannelLike, "send">;
  chatId: string;
  chunks: string[];
  replyOptions: CoreSendOptions | undefined;
  locale: Locale;
}): Promise<void> {
  const total = input.chunks.length;
  for (let index = 1; index < total; index++) {
    const chunk = input.chunks[index]!;
    await sendCoreCardWithFallback({
      channel: input.channel,
      chatId: input.chatId,
      card: renderCoreContinuationCard(chunk, index + 1, total, input.locale),
      fallbackText: chunk,
      options: input.replyOptions,
      locale: input.locale,
    });
  }
}

export function renderCoreCardFallbackText(fallbackText: string, locale: Locale, error: unknown): string {
  const errorText = error instanceof Error ? error.message.toLowerCase() : "";
  const tableLimit = errorText.includes("card table number over limit")
    || (errorText.includes("errorvalue") && errorText.includes("table"));
  const capacityLimit = tableLimit
    || errorText.includes("element exceeds the limit")
    || errorText.includes("card content exceeds limit");
  const hint = channelProfile() === "gateway"
    ? (locale === "en" ? "Card display failed; the reply is shown as plain text. Check the host runtime status for details." : "卡片显示异常，回复已改用纯文本显示。可在主机运行状态中查看详情。")
    : tableLimit
    ? locale === "en"
      ? "The interactive card exceeded Lark's per-card table limit, so it was sent as plain text instead. No content was lost."
      : "交互卡片超过飞书单卡表格上限，已自动改用纯文本发送，内容未丢失。"
    : capacityLimit
      ? locale === "en"
        ? "The interactive card exceeded Lark's card capacity, so it was sent as plain text instead. No content was lost."
        : "交互卡片超过飞书卡片容量上限，已自动改用纯文本发送，内容未丢失。"
      : locale === "en"
        ? "Interactive card delivery failed, so this was sent as plain text. Run `node dist/src/index.js lark doctor` to check card permissions/callbacks."
        : "交互卡片发送失败，已降级为纯文本。请运行 `node dist/src/index.js lark doctor` 检查卡片权限和回调订阅。";
  const detail = error instanceof Error && error.message
    ? locale === "en" ? `\n\nDetail: ${redactCoreErrorDetail(error)}` : `\n\n详情：${redactCoreErrorDetail(error)}`
    : "";
  return [normalizeCoreMarkdown(fallbackText).trim(), hint].filter(Boolean).join("\n\n") + detail;
}
