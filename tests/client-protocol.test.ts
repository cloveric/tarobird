import { notificationLink, pushPayloadSchema } from "../src/client-protocol/push.js";
import { CONVERSATION_PINS_CAPABILITY } from "../src/client-protocol/conversation-pins.js";
import { CROSS_HOST_FOLDER_ORDER_CAPABILITY, crossHostFolderOrderSchema, isCanonicalCrossHostFolderKey } from "../src/client-protocol/cross-host-folder-order.js";
import { describe, expect, it } from "vitest";
import { blocksText, CAPABILITIES, SERVER_CAPABILITIES, MAX_FRAME_BYTES, parseClientFrame, textSchema, uploadSchema } from "../src/client-protocol/index.js";
import { ATTACHMENT_ADMIN_CAPABILITY } from "../src/client-protocol/attachment-admin.js";
import { CROSS_HOST_GROUPS_CAPABILITY } from "../src/client-protocol/group-members.js";
import { SNAPSHOT_ACTIVITY_CAPABILITY } from "../src/client-protocol/snapshot.js";

describe("client protocol v1 boundaries", () => {
  it("advertises Pi controls from the host without overflowing legacy client hello limits", () => {
    const capabilities = [...CAPABILITIES, SNAPSHOT_ACTIVITY_CAPABILITY];
    expect(capabilities.length).toBeLessThanOrEqual(64);
    expect(CAPABILITIES).toContain(CROSS_HOST_GROUPS_CAPABILITY);
    expect(SERVER_CAPABILITIES).toContain(CROSS_HOST_GROUPS_CAPABILITY);
    expect(SERVER_CAPABILITIES).toContain(ATTACHMENT_ADMIN_CAPABILITY);
    expect(SERVER_CAPABILITIES).toContain("pi.session.v1");
    expect(CAPABILITIES).not.toContain("pi.session.v1");
    expect(SERVER_CAPABILITIES).toContain("conversations.tasks.swarm.v1");
    expect(CAPABILITIES).not.toContain("conversations.tasks.swarm.v1");
    expect(SERVER_CAPABILITIES).toContain(CONVERSATION_PINS_CAPABILITY);
    expect(CAPABILITIES).not.toContain(CONVERSATION_PINS_CAPABILITY);
    expect(SERVER_CAPABILITIES).toContain(CROSS_HOST_FOLDER_ORDER_CAPABILITY);
    expect(CAPABILITIES).not.toContain(CROSS_HOST_FOLDER_ORDER_CAPABILITY);
    expect(isCanonicalCrossHostFolderKey(JSON.stringify(["hubA", "work"]))).toBe(true);
    expect(isCanonicalCrossHostFolderKey(JSON.stringify(["hubA", null]))).toBe(true);
    expect(isCanonicalCrossHostFolderKey('["hubA", "work"]')).toBe(false);
    expect(crossHostFolderOrderSchema.safeParse({ version: 1, revision: 1, updatedAt: 1000, pinned: [], ordinary: [JSON.stringify(["hubA", null])] }).success).toBe(true);
    expect(parseClientFrame(JSON.stringify({ v: 1, type: "hello", deviceId: "device", protocolVersions: [1], capabilities, cursors: {}, nonce: "a".repeat(32) }))).toHaveProperty("frame.type", "hello");
  });
  it("keeps queue cancellation status out of copied and indexed prompt text", () => {
    expect(blocksText([
      { type: "text", text: "Original prompt\nSecond line" },
      { type: "card", elements: [{ type: "markdown", text: "已取消排队，未发送给 Bot。" }], extra: { promptQueue: { state: "cancelled", botId: "bot" } } },
    ])).toBe("Original prompt\nSecond line");
    expect(blocksText([{ type: "card", title: "Result", elements: [{ type: "markdown", text: "Ordinary card text" }] }])).toBe("Result\nOrdinary card text");
  });
  it("ignores unknown types but rejects malformed known messages and versions", () => {
    expect(parseClientFrame('{"v":1,"type":"future.feature","opaque":true}')).toEqual({ ignored: "future.feature" });
    expect(() => parseClientFrame('{"v":1,"type":"message.send"}')).toThrow();
    expect(() => parseClientFrame('{"v":2,"type":"ping"}')).toThrow();
    expect(() => parseClientFrame("x".repeat(MAX_FRAME_BYTES + 1))).toThrow("frame_too_large");
  });
  it("counts UTF-8 bytes, not code units, and rejects traversal filenames", () => {
    expect(textSchema.safeParse("中".repeat(70_000)).success).toBe(false);
    for (const name of ["../secret", "a\\secret", "..", "bad\u0000name"]) expect(uploadSchema.safeParse({ conversationId: "conversation", name, size: 1, mime: "text/plain", sha256: "a".repeat(64) }).success).toBe(false);
  });
  it("accepts optional link styles from old and new clients but rejects unknown values", () => {
    const frame = { v: 1, type: "message.send", clientMsgId: "send", conversationId: "conversation", text: "https://example.org" };
    for (const previewStyle of [undefined, "card", "inline"]) expect(parseClientFrame(JSON.stringify({ ...frame, previewStyle }))).toMatchObject({ frame: { ...frame, ...(previewStyle ? { previewStyle } : {}) } });
    for (const previewStyle of [null, "iframe", "", 1, {}]) expect(() => parseClientFrame(JSON.stringify({ ...frame, previewStyle }))).toThrow();
  });
});

it("notification links retain a validated host identity while legacy links remain unscoped", () => {
  const payload = { id: "push_one", title: "TaroCub", body: "New message", conversationId: "same_conversation", messageId: "same_message", kind: "answer", at: 1 };
  const hostId = `hub_${"a".repeat(64)}`;
  const scoped = new URL(notificationLink(pushPayloadSchema.parse({ ...payload, hostId })));
  expect(scoped.searchParams.get("host")).toBe(hostId);
  expect(scoped.hostname).toBe("conversation");
  expect(scoped.pathname).toBe(`/${payload.conversationId}`);
  expect(scoped.searchParams.get("message")).toBe(payload.messageId);
  expect(new URL(notificationLink(pushPayloadSchema.parse(payload))).searchParams.has("host")).toBe(false);
  for (const invalid of ["hub_short", "https://other-host", `hub_${"g".repeat(64)}`, ""]) expect(pushPayloadSchema.safeParse({ ...payload, hostId: invalid }).success).toBe(false);
});
