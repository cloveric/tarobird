import type { EngineStreamEvent } from "../codex/adapter.js";
import type { Locale } from "../runtime/locale.js";
import { backgroundTaskBody, backgroundTaskContext } from "./background-task-notice.js";
import { renderBackgroundTaskHeader } from "../runtime/background-task-header.js";
import { deliverCoreResponse } from "./delivery.js";
import { renderCoreNotificationCard } from "./card-renderer.js";
import { sendCoreCardWithFallback } from "./card-delivery.js";
import { finishScopedRunPresentation } from "./scoped-run-presentation.js";

/** Choice/attachment continuations use the same App report surface as messages.
 * Oversize bodies and file directives keep the established delivery fallback. */
export async function deliverBackgroundTaskResponse(input: Parameters<typeof deliverCoreResponse>[0], event: Extract<EngineStreamEvent, { type: "task_notification" }>, locale: Locale): Promise<void> {
  try {
    if (event.suppressUserDelivery || event.settlesCurrentTurn) {
      if (input.conversationKey) await finishScopedRunPresentation({ channel: input.channel, conversationKey: input.conversationKey, replyTo: input.replyTo }, event);
      return;
    }
    const context = backgroundTaskContext(event, locale);
    const body = backgroundTaskBody(event, locale);
    const card = event.origin && context && input.channel.profile === "gateway"
      ? renderCoreNotificationCard(renderBackgroundTaskHeader(locale, event.status), body, locale, { origin: event.origin, context, status: event.reason === "engine_exit" ? "interrupted" : event.status }, input.channel.profile) : undefined;
    if (!card) {
      const delivery = await deliverCoreResponse(input);
      if (input.conversationKey) await finishScopedRunPresentation({ channel: input.channel, conversationKey: input.conversationKey, replyTo: input.replyTo }, event, delivery.ok);
      return;
    }
    const delivery = await deliverCoreResponse({ ...input, text: body, sendText: false });
    if (input.conversationKey && await finishScopedRunPresentation({ channel: input.channel, conversationKey: input.conversationKey, replyTo: input.replyTo }, event, delivery.ok)) return;
    if (!delivery.ok && card.appBackgroundTask) card.appBackgroundTask = { ...(card.appBackgroundTask as object), delivery: "unconfirmed" };
    await sendCoreCardWithFallback({ channel: input.channel, chatId: input.chatId, card, fallbackText: input.text,
      options: { replyTo: input.replyTo, replyInThread: input.replyInThread }, locale });
  } catch (error) {
    if (input.conversationKey) await finishScopedRunPresentation({ channel: input.channel, conversationKey: input.conversationKey, replyTo: input.replyTo },
      { ...event, suppressUserDelivery: true }, false).catch(() => undefined);
    throw error;
  }
}
