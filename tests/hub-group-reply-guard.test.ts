import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, it, expect } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { clientFrameSchema, type Conversation, type GroupReplyGuard } from "../src/client-protocol/index.js";
import type { GroupDiscussionPolicy } from "../src/client-protocol/group-discussion.js";
import { groupReplyWireFrame, LEGACY_GROUP_REPLY_REVISION } from "../client/src/group-reply-guard.js";

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
