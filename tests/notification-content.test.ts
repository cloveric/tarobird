import { expect, test } from "vitest";
import type { Message } from "../src/client-protocol/index.js";
import { classifyNotification, decodeNotificationClass, encodeNotificationClass, genericNotificationBody, notificationPreview } from "../src/client-protocol/notification-content.js";
import { notificationAllowed, notificationPreferencesSchema } from "../src/client-protocol/push.js";
import { desktopNotice } from "../client/src/message-notification.js";

const base: Message = { id: "reply", conversationId: "chat", authorId: "alpha", authorType: "bot", status: "complete", createdAt: 1, version: 1, blocks: [] };
const file = { type: "file" as const, attachmentId: "att", name: "contract.pdf", mime: "application/pdf", size: 1 };
const run = (phase: string) => ({ type: "card" as const, elements: [{ type: "markdown" as const, text: "Result text" }], extra: { nativeRun: { version: 1, id: "run", phase, revision: 1, startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false } } });

test("answers split into reply/file topics while approval and failure are attention only", () => {
  expect(classifyNotification({ ...base, blocks: [{ type: "text", text: "done" }] })).toMatchObject({ kind: "answer", generic: "reply", topics: ["replyCompleted"] });
  expect(classifyNotification({ ...base, blocks: [file] })).toMatchObject({ kind: "answer", generic: "files", topics: ["filesReceived"] });
  expect(classifyNotification({ ...base, blocks: [{ type: "text", text: "see attached" }, file] })).toMatchObject({ generic: "reply", topics: ["replyCompleted", "filesReceived"] });
  expect(classifyNotification({ ...base, blocks: [] })).toMatchObject({ generic: "reply", topics: ["replyCompleted"] });
  expect(classifyNotification({ ...base, blocks: [{ type: "card", elements: [{ type: "button", text: "Approve", actionId: "ok" }] }, file] })).toMatchObject({ kind: "action", topics: ["needsAttention"] });
  expect(classifyNotification({ ...base, status: "error", blocks: [file] })).toMatchObject({ kind: "error", topics: ["needsAttention"] });
  expect(classifyNotification({ ...base, blocks: [run("interrupted")] })).toMatchObject({ kind: "error", incomplete: true, topics: ["needsAttention"] });
  expect(classifyNotification({ ...base, blocks: [run("working")] })).toBeUndefined();
  expect(classifyNotification({ ...base, authorType: "user" })).toBeUndefined();
});

test("a mixed reply is admitted when either applicable topic is on", () => {
  const mixed = classifyNotification({ ...base, blocks: [{ type: "text", text: "see attached" }, file] })!;
  const prefs = (value: object) => notificationPreferencesSchema.parse({ enabled: true, ...value });
  expect(notificationAllowed(prefs({ filesReceived: false }), mixed.topics)).toBe(true);
  expect(notificationAllowed(prefs({ replyCompleted: false }), mixed.topics)).toBe(true);
  expect(notificationAllowed(prefs({ replyCompleted: false, filesReceived: false }), mixed.topics)).toBe(false);
  expect(notificationAllowed(prefs({ replyCompleted: false, filesReceived: false }), ["needsAttention"])).toBe(true);
});

test("queued classes round-trip and malformed or missing classes fall back to the wire kind", () => {
  const value = { generic: "files" as const, topics: ["filesReceived" as const] };
  expect(decodeNotificationClass(encodeNotificationClass(value), "answer")).toEqual(value);
  expect(decodeNotificationClass(null, "answer")).toEqual({ generic: "message", topics: ["replyCompleted", "filesReceived"] });
  expect(decodeNotificationClass("files:secret,needsAttention", "error")).toEqual({ generic: "error", topics: ["needsAttention"] });
  expect(decodeNotificationClass("bogus:replyCompleted", "action")).toEqual({ generic: "action", topics: ["needsAttention"] });
});

test("Chinese Hub previews are unchanged and the English desktop preview mirrors their structure", () => {
  const message: Message = { ...base, blocks: [{ type: "text", text: "**Fixed** the sidebar" }, file] };
  expect(notificationPreview(message, "发布准备", "CC1", "answer", false)).toBe("「发布准备」 · CC1\n收到文件：contract.pdf · Fixed the sidebar");
  expect(notificationPreview(message, "Release", "CC1", "answer", false, false, "en")).toBe("“Release” · CC1\nReceived File: contract.pdf · Fixed the sidebar");
  expect(genericNotificationBody("files", "en")).toBe("A Bot sent files. Tap to view.");
});

test("desktop notices follow topic and preview preferences without reading the title when hidden", () => {
  const message: Message = { ...base, blocks: [{ type: "text", text: "Confidential terms" }, file] };
  const hidden = desktopNotice(message, notificationPreferencesSchema.parse({ enabled: true, showPreview: false }))!;
  expect(hidden.preview).toBe(false);
  const body = hidden.body({ title: "Private plan", botName: "Alpha", locale: "zh" });
  expect(body).toBe("Bot 已完成回复，点按查看。");
  const shown = desktopNotice(message, notificationPreferencesSchema.parse({ enabled: true }))!;
  expect(shown.body({ title: "Private plan", botName: "Alpha", locale: "zh" })).toBe("「Private plan」 · Alpha\n收到文件：contract.pdf · Confidential terms");
  expect(desktopNotice({ ...base, blocks: [file] }, notificationPreferencesSchema.parse({ enabled: true, filesReceived: false }))).toBeUndefined();
  expect(desktopNotice({ ...base, status: "error" }, notificationPreferencesSchema.parse({ enabled: true, needsAttention: false }))).toBeUndefined();
  expect(desktopNotice({ ...base, status: "error" }, notificationPreferencesSchema.parse({ enabled: true, replyCompleted: false, filesReceived: false }))?.kind).toBe("error");
});
