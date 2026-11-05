import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gatewaySessionBindingAllowsSteering, prepareGatewaySessionBinding } from "../src/gateway/session-binding.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import { SessionStore } from "../src/state/session-store.js";
import { JsonStore } from "../src/state/json-store.js";
import type { Conversation } from "../src/client-protocol/index.js";

let root: string, sessions: SessionStore;
const conversation: Conversation = { id: "gw_binding", title: "Binding", type: "direct", ownerId: "owner", botIds: ["alpha"], archived: false, createdAt: 1, sessionId: "source", bindingId: "bind_one" };
const key = buildCoreConversationKey(conversation.id);
const file = () => path.join(root, "gateway-bindings", `${createHash("sha256").update(key).digest("hex")}.json`);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "binding-")); sessions = new SessionStore(path.join(root, "session.json"));
  await sessions.upsert({ telegramChatId: 1, conversationKey: "lark:source", codexSessionId: "source", status: "idle", updatedAt: new Date().toISOString(), suspendedPrevious: { sessionId: "someone_else_previous", resume: null } });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("never imports the source conversation's suspended history and never replays after a reset", async () => {
  await prepareGatewaySessionBinding(root, conversation);
  expect((await sessions.findByConversationKey(key))?.suspendedPrevious).toEqual({ sessionId: null, resume: null });
  await sessions.removeByConversationKey(key);
  await prepareGatewaySessionBinding(root, conversation);
  expect(await sessions.findByConversationKey(key)).toBeNull();
  await prepareGatewaySessionBinding(root, { ...conversation, bindingId: "bind_two" });
  expect((await sessions.findByConversationKey(key))?.codexSessionId).toBe("source");
});
it("fails closed after an uncertain write and allows an explicit new selection", async () => {
  await mkdir(path.dirname(file()), { recursive: true }); await writeFile(file(), JSON.stringify({ bindingId: "bind_one", state: "applying" }));
  await expect(prepareGatewaySessionBinding(root, conversation)).rejects.toThrow("session_binding_interrupted");
  expect(await sessions.findByConversationKey(key)).toBeNull();
  await prepareGatewaySessionBinding(root, { ...conversation, bindingId: "bind_two" });
  expect((await sessions.findByConversationKey(key))?.codexSessionId).toBe("source");
  await writeFile(file(), "corrupt");
  await expect(prepareGatewaySessionBinding(root, { ...conversation, bindingId: "bind_three" })).rejects.toThrow();
  expect(await readFile(file(), "utf8")).toBe("corrupt");
});
it("does not resurrect legacy metadata after detach and preserves an existing native binding", async () => {
  const { bindingId: _, ...legacy } = conversation;
  await expect(prepareGatewaySessionBinding(root, legacy)).rejects.toThrow("legacy_session_binding_requires_reselection");
  await sessions.upsert({ telegramChatId: 2, conversationKey: key, codexSessionId: "other", status: "idle", updatedAt: new Date().toISOString() });
  await prepareGatewaySessionBinding(root, legacy);
  expect((await sessions.findByConversationKey(key))?.codexSessionId).toBe("other");
});

it("steers only after the latest selection has a confirmed receipt", async () => {
  expect(await gatewaySessionBindingAllowsSteering(root, conversation)).toBe(false);
  await prepareGatewaySessionBinding(root, conversation);
  expect(await gatewaySessionBindingAllowsSteering(root, conversation)).toBe(true);
  expect(await gatewaySessionBindingAllowsSteering(root, { ...conversation, bindingId: "new_selection" })).toBe(false);
  await writeFile(file(), JSON.stringify({ bindingId: conversation.bindingId, state: "applying" }));
  expect(await gatewaySessionBindingAllowsSteering(root, conversation)).toBe(false);
  await writeFile(file(), "corrupt"); expect(await gatewaySessionBindingAllowsSteering(root, conversation)).toBe(false);
  const { sessionId: _, bindingId: __, ...cleared } = conversation;
  expect(await gatewaySessionBindingAllowsSteering(root, cleared)).toBe(true);
});
it("distinguishes a temporary storage failure from a corrupt receipt without switching sessions", async () => {
  const write = vi.spyOn(JsonStore.prototype, "write").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  try {
    await expect(prepareGatewaySessionBinding(root, conversation)).rejects.toMatchObject({ code: "session_binding_storage_unavailable" });
    expect(await sessions.findByConversationKey(key)).toBeNull();
  } finally { write.mockRestore(); }
  await prepareGatewaySessionBinding(root, conversation);
  expect((await sessions.findByConversationKey(key))?.codexSessionId).toBe("source");
});
