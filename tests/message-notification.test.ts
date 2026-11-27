import { expect, it, vi } from "vitest";
import type { Message } from "../src/client-protocol/index.js";
import { desktopNotice, shouldNotifyBotMessage } from "../client/src/message-notification.js";
import { notificationPreferencesSchema } from "../src/client-protocol/push.js";
import { translateCard } from "../src/gateway/card-translator.js";
import { renderCoreQueueWaitCard } from "../src/core/card-renderer.js";
const spec = { profile: "gateway" as const, taskId: "task", conversationKey: "lark:chat", waitedMs: 0 };
const base: Message = { id: "same_reply", replyTo: "task", conversationId: "chat", authorId: "bot", authorType: "bot", status: "complete", createdAt: 1, version: 1, blocks: [] };
it.each(["queued", "started", "cancelled", "skipped", "interrupted", "failed", "expired"])("%s queue state does not consume the desktop notification claim", state => {
  const card = translateCard(renderCoreQueueWaitCard(spec));
  card.extra!.appQueue = { ...(card.extra!.appQueue as Record<string, never>), state };
  expect(shouldNotifyBotMessage({ ...base, status: ["failed", "interrupted"].includes(state) ? "error" : "complete", blocks: [card] })).toBe(false);
});
it("ignores legacy queue publication and lets the same ID's actual reply claim exactly once", async () => {
  const queued = translateCard(renderCoreQueueWaitCard(spec)); delete queued.extra!.appQueue;
  const complete: Message = { ...base, blocks: [{ type: "card", elements: [], extra: { nativeRun: { version: 1, id: "run", phase: "done", revision: 1, startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false } } }] };
  const claimed = new Set<string>(), notify = vi.fn(), claim = vi.fn(async (id: string) => { if (claimed.has(id)) return false; claimed.add(id); return true; });
  for (const message of [{ ...base, blocks: [queued] }, complete, complete]) if (shouldNotifyBotMessage(message) && await claim(message.id)) notify(message.id);
  expect(claim).toHaveBeenCalledTimes(2); expect(notify).toHaveBeenCalledExactlyOnceWith(base.id);
});
it.each([
  ["streaming", true, "**正在转写音频…**"],
  ["complete", false, "**音频转写完成**"],
  ["complete", false, "**已停止转写**"],
  ["complete", false, "**转写已中断**"],
] as const)("suppresses desktop notifications for transcription cards (%s active=%s %s)", (status, active, heading) => {
  const prefs = notificationPreferencesSchema.parse({ enabled: true });
  const card: Message = {
    ...base,
    id: "transcribe_card",
    status,
    blocks: [{ type: "card", elements: [{ type: "markdown", text: heading }], extra: { appTranscription: { version: 1, active, at: 1 } } }],
  };
  expect(shouldNotifyBotMessage(card)).toBe(false);
  expect(desktopNotice(card, prefs)).toBeUndefined();
});
