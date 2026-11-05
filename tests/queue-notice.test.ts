import { expect, it } from "vitest";
import { queueNotice } from "../src/client-protocol/queue-notice.js";
import { renderCoreQueueWaitCard, renderCoreQueueCancelledCard, renderCoreQueueLifecycleCard } from "../src/core/card-renderer.js";
import { translateCard } from "../src/gateway/card-translator.js";
import { forwardedBlocks } from "../src/client-protocol/forwarding.js";
const message = { authorType: "bot" as const, conversationId: "chat", replyTo: "task", createdAt: 1 };
const input = { profile: "gateway" as const, conversationKey: "lark:chat", taskId: "task", waitedMs: 10 };
it.each(["zh", "en"] as const)("recognizes structured and existing %s queue notices without relying on prose", locale => {
  const card = translateCard(renderCoreQueueWaitCard({ ...input, locale }));
  expect(queueNotice(card, message)).toMatchObject({ state: "queued", taskId: "task", cancel: { type: "button" } });
  delete card.extra!.appQueue; card.elements[0]!.text = "Changed prose";
  expect(queueNotice(card, message)?.state).toBe("queued");
  expect(queueNotice({ ...card, layout: undefined }, message)).toBeUndefined();
});
it("requires source and conversation binding, never reinterprets native runs, future versions or ordinary stop cards", () => {
  const card = translateCard(renderCoreQueueWaitCard(input));
  for (const other of [{ ...message, authorType: "user" as const }, { ...message, replyTo: "other" }, { ...message, conversationId: "other" }, { ...message, replyTo: undefined }]) expect(queueNotice(card, other)).toBeUndefined();
  for (const extra of [{ ...card.extra, nativeRun: {} }, { ...card.extra, scopedRun: {} }, { ...card.extra, appQueue: { version: 2 } }, { ...card.extra, appQueue: null }]) expect(queueNotice({ ...card, extra }, message)).toBeUndefined();
  delete card.extra!.appQueue; card.title = "Approval";
  expect(queueNotice(card, message)).toBeUndefined();
});
it("keeps cancellation terminal and strips queue identity and controls when forwarding", () => {
  const card = translateCard(renderCoreQueueCancelledCard("zh", input));
  expect(queueNotice(card, message)).toMatchObject({ state: "cancelled", taskId: "task" });
  expect(queueNotice(card, message)?.cancel).toBeUndefined();
  const forwarded = forwardedBlocks([translateCard(renderCoreQueueWaitCard(input))], new Map())[0]!;
  expect(forwarded.type === "card" && forwarded.extra?.appQueue).toBeUndefined();
  expect(forwarded.type === "card" && queueNotice(forwarded, message)).toBeUndefined();
});
it.each(["started", "skipped"] as const)("presents %s without either a queue cancel or a conversation stop", state => {
  const card = translateCard(renderCoreQueueLifecycleCard(input, state, "Preparation detail"));
  expect(queueNotice(card, message)).toMatchObject({ state, taskId: "task" });
  expect(queueNotice(card, message)?.cancel).toBeUndefined();
  expect(card.elements.some(e => e.type === "button")).toBe(false);
  expect(card.extra?.nativeRun).toBeUndefined();
});
