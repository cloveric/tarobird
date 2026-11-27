import type { Message } from "../../src/client-protocol/index.js";
import { notificationAllowed, notificationShowsPreview, type NotificationPreferences, type PushPayload } from "../../src/client-protocol/push.js";
import { classifyNotification, genericNotificationBody, notificationPreview, type NotificationLocale } from "../../src/client-protocol/notification-content.js";
import { normalizeLocale, type SupportedLocale } from "../../src/runtime/locale.js";

/** Resolve `<html lang>` (including BCP-47 tags like `ja-JP`) for desktop notifications. */
export function desktopNotificationLocale(lang: string | null | undefined, fallback: SupportedLocale = "en"): SupportedLocale {
  const trimmed = lang?.trim();
  return trimmed ? normalizeLocale(trimmed, "en") : fallback;
}

/** Decide before claiming the message ID: a queue notice and its eventual
 * reply share that ID, and only the reply may consume the notification claim.
 * Uses the same classifier as Hub push admission. */
export function shouldNotifyBotMessage(message: Message): boolean {
  return !!classifyNotification(message);
}

/** The local desktop notice, or undefined when this device's topic preferences
 * exclude it. Hidden previews never include the conversation, Bot, file names
 * or excerpt, so callers need not read the conversation title for them. */
export function desktopNotice(message: Message, preferences: NotificationPreferences): { kind: PushPayload["kind"]; preview: boolean; body: (context: { title?: string; botName?: string; locale: NotificationLocale }) => string } | undefined {
  const notice = classifyNotification(message);
  if (!notice || !notificationAllowed(preferences, notice.topics)) return;
  const preview = notificationShowsPreview(preferences);
  return { kind: notice.kind, preview, body: ({ title, botName, locale }) => preview
    ? notificationPreview(message, title ?? "", botName ?? "", notice.kind, notice.incomplete, notice.uncertainBackground, locale)
    : genericNotificationBody(notice.generic, locale) };
}
