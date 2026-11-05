import type { EngineStreamEvent } from "../codex/adapter.js";
import type { Locale } from "../runtime/locale.js";
import { channelProfile, type ChannelProfile } from "./channel-profile.js";

type Notification = Extract<EngineStreamEvent, { type: "task_notification" }>;
export function backgroundTaskBody(event: Notification, locale: Locale): string {
  if (event.reason === "no_result") return locale === "en" ? "The engine provided no further result." : "引擎没有提供更多结果。";
  if (event.reason === "engine_exit") return [event.summary?.trim(), locale === "en" ? "The Claude process exited before this task completed." : "Claude 进程已退出，未收到此任务的完成结果。"].filter(Boolean).join("\n\n");
  return event.text;
}
export function backgroundTaskReplyTo(event: Notification, replyTo?: string, profile: ChannelProfile = channelProfile()): string | undefined {
  // A recovered task may be delivered through the new turn's callback. That
  // callback is not evidence that the new prompt started the old task.
  return profile === "gateway" && event.origin === "unattributed" ? undefined : replyTo;
}
export function backgroundTaskContext(event: Pick<Notification, "origin">, locale: Locale): string | undefined {
  if (!event.origin) return;
  if (event.origin === "unattributed") return locale === "en"
    ? "Background task report · The original request could not be confirmed. This is separate from the current reply."
    : "后台任务结果 · 暂时无法确认关联的原请求。这是独立通知，不是当前提问的回答。";
  return locale === "en" ? "Background task report · A follow-up to the linked request." : "后台任务结果 · 这是关联请求的后续通知。";
}
