import type { EngineStreamEvent } from "../codex/adapter.js";
import type { Locale } from "../runtime/locale.js";
import { hostT } from "../locales/index.js";
import { channelProfile, type ChannelProfile } from "./channel-profile.js";

type Notification = Extract<EngineStreamEvent, { type: "task_notification" }>;
const NOTE_KEYS: Record<NonNullable<Notification["note"]>, string> = {
  review_timeout: "引擎没有在限定时间内完成对这个后台结果的复核。",
  review_failed: "引擎复核这个后台结果时失败了。",
  review_interrupted: "引擎对这个后台结果的复核被中断了。",
};
export function backgroundTaskBody(event: Notification, locale: Locale): string {
  const note = event.note ? hostT(locale, NOTE_KEYS[event.note]) : undefined;
  // The task's name, when the engine gave one, says which task this is about. A note already says why there
  // is nothing more, so it stands in for the general line.
  if (event.reason === "no_result") return [event.summary?.trim(), note ?? hostT(locale, "引擎没有提供更多结果。")].filter(Boolean).join("\n\n");
  if (event.reason === "engine_exit") return [event.summary?.trim(), hostT(locale, "引擎进程已退出，未收到此任务的完成结果。")].filter(Boolean).join("\n\n");
  return [event.text, note].filter(Boolean).join("\n\n");
}
export function backgroundTaskReplyTo(event: Notification, replyTo?: string, profile: ChannelProfile = channelProfile()): string | undefined {
  // A recovered task may be delivered through the new turn's callback. That
  // callback is not evidence that the new prompt started the old task.
  return profile === "gateway" && event.origin === "unattributed" ? undefined : replyTo;
}
export function backgroundTaskContext(event: Pick<Notification, "origin">, locale: Locale): string | undefined {
  if (!event.origin) return;
  if (event.origin === "unattributed") {
    return hostT(locale, "后台任务结果 · 暂时无法确认关联的原请求。这是独立通知，不是当前提问的回答。");
  }
  return hostT(locale, "后台任务结果 · 这是关联请求的后续通知。");
}
