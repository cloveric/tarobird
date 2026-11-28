import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, it, expect } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { clientFrameSchema, type Conversation, type GroupReplyGuard } from "../src/client-protocol/index.js";
import type { GroupDiscussionPolicy } from "../src/client-protocol/group-discussion.js";
import { groupMessageRetryAddress, groupReplyWireFrame, LEGACY_GROUP_REPLY_REVISION } from "../client/src/group-reply-guard.js";

let root: string, hub: HubServer, chat: Conversation;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "group-reply-guard-"));
  hub = await HubServer.start({ stateDir: root });
  for (const id of ["a", "b", "c"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, "fixture"]);
  chat = await hub.store.createConversation("owner", ["a", "b"], "Group", "group", { type: "group" });
});
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
const current = () => hub.store.groupSettings("owner", chat.id);
async function change(mode: GroupDiscussionPolicy["mode"], bots?: string[]) {
  const before = await current();
  await hub.store.updateGroup("owner", chat.id, { title: before.group.title, expectedTitle: before.group.title, botIds: bots ?? before.group.botIds, expectedBotIds: before.group.botIds,
    policy: { ...before.policy, mode, botOrder: bots ?? before.policy.botOrder }, expectedRevision: before.revision });
}
const input = (id: string, guard: GroupReplyGuard, extra: object = {}) => ({ v: 1 as const, type: "message.send" as const, conversationId: chat.id, clientMsgId: id, text: id, attachments: [], groupReplyGuard: guard, ...extra });
const recipients = (id: string) => hub.store.db.all<{ bot_id: string }>("SELECT bot_id FROM deliveries WHERE message_id=? ORDER BY bot_id", [id]).then(rows => rows.map(row => row.bot_id));

it.each(["mentions", "parallel"] as const)("delivers guarded %s messages once across a mode change, including topics", async mode => {
  await change(mode);
  const guard = { mode, revision: (await current()).revision };
  const topic = await hub.store.createConversation("owner", [], "Topic", "topic", { parentId: chat.id });
  const frame = input("once", guard, { conversationId: topic.id, ...(mode === "mentions" ? { mentions: ["b"] } : {}) });
  const first = await hub.store.sendMessage("owner", frame);
  expect(await recipients(first.message.id)).toEqual(mode === "mentions" ? ["b"] : ["a", "b"]);
  await change("sequential");
  expect(await hub.store.sendMessage("owner", frame)).toMatchObject({ duplicate: true, message: { id: first.message.id } });
  expect((await hub.store.snapshot("owner", topic.id)).messages).toHaveLength(1);
});

it.each(["mode", "members"] as const)("rejects a stale %s revision before creating any message or delivery", async kind => {
  const guard = { mode: "mentions" as const, revision: (await current()).revision };
  await change(kind === "mode" ? "parallel" : "mentions", kind === "members" ? ["a", "c"] : undefined);
  await expect(hub.store.sendMessage("owner", input("stale", guard, { mentions: ["a"] }))).rejects.toThrow("group_reply_mode_changed");
  expect((await hub.store.snapshot("owner", chat.id)).messages).toEqual([]);
  expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM deliveries")).toEqual({ n: 0 });
});

it("rejects automatic policy, direct messages and local legacy sentinels", async () => {
  await change("sequential");
  await expect(hub.store.sendMessage("owner", input("automatic", { mode: "mentions", revision: (await current()).revision }))).rejects.toThrow("group_reply_mode_changed");
  await change("mentions");
  await expect(hub.store.sendMessage("owner", input("legacy", { mode: "mentions", revision: LEGACY_GROUP_REPLY_REVISION }))).rejects.toThrow("group_reply_mode_changed");
  const direct = await hub.store.createConversation("owner", ["a"], "Direct", "direct");
  await expect(hub.store.sendMessage("owner", input("direct", { mode: "mentions", revision: (await current()).revision }, { conversationId: direct.id }))).rejects.toThrow("group_reply_mode_changed");
});

it("preserves guards in protocol parsing, sends only to capable Hosts and never leaks the legacy local marker", async () => {
  const frame = clientFrameSchema.parse(input("wire", { mode: "mentions", revision: (await current()).revision }));
  expect(groupReplyWireFrame(frame, { groupReplyGuardAvailable: true })).toEqual(frame);
  expect(() => groupReplyWireFrame(frame, { groupDiscussionAvailable: true, groupReplyGuardAvailable: false })).toThrow("无法校验");
  const legacy = clientFrameSchema.parse(input("legacy", { mode: "mentions", revision: LEGACY_GROUP_REPLY_REVISION }));
  expect(groupReplyWireFrame(legacy, { groupDiscussionAvailable: false })).not.toHaveProperty("groupReplyGuard");
  expect(() => groupReplyWireFrame(legacy, { groupDiscussionAvailable: true })).toThrow("已变化");
  expect(() => groupReplyWireFrame(legacy, {})).toThrow("已变化");
  expect(() => clientFrameSchema.parse({ ...frame, groupReplyGuard: { mode: "roundtable", revision: "bad" } })).toThrow();
});


it("retains a scoped send in the outbox if the connected Host lacks recipient-key support", () => {
  const frame = { v: 1, type: "message.send", conversationId: "example_group", clientMsgId: "example_msg", text: "Example", attachments: [], mentions: ["remote:example_peer:example_bot"] } as const;
  const send = { ...frame, mentions: [...frame.mentions], attachments: [] };
  expect(groupReplyWireFrame(send, { groupRecipientKeysAvailable: true })).toEqual(send);
  expect(() => groupReplyWireFrame(send, { groupDiscussionAvailable: true, groupReplyGuardAvailable: true })).toThrow("不支持此回复选择");
});


it("pins a replay to its source and never lets an older Host drop the retry source", async () => {
  const original = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "legacy", text: "Example", attachments: [], mentions: ["a"] });
  const { groupRecipientKeys: _missingReceipt, ...historical } = original.message;
  const current = { groupRecipientKeysAvailable: true, groupRecipientRetryAvailable: true };
  const previous = { groupRecipientKeysAvailable: true, groupRecipientRetryAvailable: false };
  expect(groupMessageRetryAddress(historical, undefined, current)).toEqual({ retryOf: original.message.id });
  expect(groupMessageRetryAddress(historical, "a", current)).toEqual({ retryOf: original.message.id, mentions: ["local:a"] });
  expect(() => groupMessageRetryAddress(historical, undefined, previous)).toThrow("不支持此回复选择");
  expect(groupMessageRetryAddress(original.message, undefined, previous)).toEqual({ mentions: ["local:a"] });
  const singleHost = { groupRecipientRetryAvailable: false, crossHostGroupsAvailable: false };
  const legacyBotReply = groupMessageRetryAddress(historical, "a", singleHost);
  const queuedBotReply = clientFrameSchema.parse({ v: 1, type: "message.send", conversationId: chat.id, clientMsgId: "retry_local_bot", text: "Example", ...legacyBotReply });
  expect(groupReplyWireFrame(queuedBotReply, singleHost)).toMatchObject({ mentions: ["a"] });
  const frame = clientFrameSchema.parse({ v: 1, type: "message.send", conversationId: chat.id, clientMsgId: "retry", text: "Example", attachments: [], ...groupMessageRetryAddress(historical, undefined, {}) });
  expect(groupReplyWireFrame(frame, current)).toEqual(frame);
  expect(() => groupReplyWireFrame(frame, previous)).toThrow("不支持此回复选择");
});

it("keeps a recorded transcript-only retry from acquiring a newer default recipient", async () => {
  const first = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "transcript", text: "Example", attachments: [] });
  expect(first.message.groupRecipientKeys).toEqual([]);
  await change("parallel");
  const replay = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "replay", text: "Example", attachments: [], retryOf: first.message.id });
  expect(await recipients(replay.message.id)).toEqual([]);
  expect(replay.message.groupRecipientKeys).toEqual([]);
});

it("resends explicit historical local recipients on a confirmed single-host Hub", async () => {
  const original = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "old_local", text: "Example", attachments: [], mentions: ["a"] });
  const { groupRecipientKeys: _missingReceipt, ...historical } = original.message;
  const legacy = { crossHostGroupsAvailable: false, groupRecipientRetryAvailable: false, groupRecipientKeysAvailable: false, groupDiscussionAvailable: true };
  const send = { v: 1, type: "message.send", conversationId: chat.id, clientMsgId: "legacy_replay", text: "Example", attachments: [] } as const;
  const queued = clientFrameSchema.parse({ ...send, ...groupMessageRetryAddress(historical, undefined, legacy) });
  const wire = groupReplyWireFrame(queued, legacy);
  expect(wire).toEqual({ ...send, mentions: ["a"] });
  if (wire.type !== "message.send") throw new Error("Expected a message send");
  const { message } = await hub.store.sendMessage("owner", wire);
  expect(await recipients(message.id)).toEqual(["a"]);

  for (const crossHostGroupsAvailable of [true, undefined]) {
    const other = { ...legacy, crossHostGroupsAvailable };
    expect(() => groupMessageRetryAddress(historical, undefined, other)).toThrow("不支持此回复选择");
    expect(() => groupReplyWireFrame(queued, other)).toThrow("不支持此回复选择");
  }
  expect(() => groupMessageRetryAddress({ ...historical, groupRecipientKeys: ["remote:example_peer:a"] }, undefined, legacy)).toThrow("不支持此回复选择");
  expect(() => groupMessageRetryAddress({ ...historical, mentions: undefined }, undefined, legacy)).toThrow("不支持此回复选择");
});
