import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";

let root: string, store: HubStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "group-settings-")); store = await HubStore.open(root);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture'),('beta','Beta','fixture'),('gamma','Gamma','fixture')");
  await store.db.run("INSERT INTO users VALUES('member','Member','member')");
});
afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
const change = (title = "Renamed", botIds = ["alpha", "beta"], expectedTitle = "Group", expectedBotIds = ["alpha"]) => ({ title, botIds, expectedTitle, expectedBotIds });

it("updates inherited members atomically without losing topic titles, history, sessions or notification settings", async () => {
  const group = await store.createConversation("owner", ["alpha"], "Group", "group", { type: "group" });
  const topic = await store.createConversation("owner", [], "Topic", "topic", { parentId: group.id });
  await store.updateConversation("owner", topic.id, { sessionId: "keep_session", archived: true });
  await store.db.run("UPDATE conversation_members SET muted=1 WHERE conversation_id=? AND member_type='user'", [topic.id]);
  await store.publishBotMessage("alpha", { conversationId: group.id, blocks: [{ type: "text", text: "history" }] });
  const updated = await store.updateGroup("owner", group.id, change());
  expect(updated.find(c => c.id === group.id)).toMatchObject({ title: "Renamed", botIds: ["alpha", "beta"] });
  expect(updated.find(c => c.id === topic.id)).toMatchObject({ title: "Topic", botIds: ["alpha", "beta"], sessionId: "keep_session", archived: true, parentId: group.id });
  expect(await store.db.get("SELECT muted FROM conversation_members WHERE conversation_id=? AND member_type='user'", [topic.id])).toEqual({ muted: 1 });
  expect((await store.snapshot("owner", group.id)).messages[0]!.blocks).toEqual([{ type: "text", text: "history" }]);
  expect(await store.updateGroup("owner", group.id, change())).toEqual(updated);
  await expect(store.updateGroup("owner", group.id, change("Stale", ["gamma"]))).rejects.toThrow("group_settings_conflict");
  const later = await store.createConversation("owner", [], "Later", "later", { parentId: group.id });
  expect(later.botIds).toEqual(["alpha", "beta"]);
  await store.updateGroup("owner", group.id, change("Renamed", ["beta"], "Renamed", ["alpha", "beta"]));
  await expect(store.conversationForBot("alpha", topic.id)).rejects.toThrow("bot_forbidden");
  await store.db.close(); store = await HubStore.open(root);
  expect((await store.conversations("owner")).every(c => JSON.stringify(c.botIds) === '["beta"]')).toBe(true);
});

it("enforces creator ownership, grants, valid membership and transaction-time authorization", async () => {
  await store.db.run("INSERT INTO bot_grants VALUES('member','alpha')");
  const group = await store.createConversation("member", ["alpha"], "Group", "group", { type: "group" });
  await store.db.run("INSERT INTO conversation_members VALUES(?,'user','owner',0)", [group.id]);
  await expect(store.updateGroup("owner", group.id, change())).rejects.toThrow("conversation_owner_required");
  await expect(store.updateGroup("member", group.id, change())).rejects.toThrow("bot_forbidden");
  await expect(store.updateGroup("member", group.id, change("X", []))).rejects.toThrow();
  await expect(store.updateGroup("member", group.id, change("X", ["alpha", "alpha"]))).rejects.toThrow();
  await expect(store.updateGroup("member", group.id, change("X", ["missing"]))).rejects.toThrow("bot_not_found");
  await expect(store.updateGroup("member", group.id, change("X", ["alpha"]), async () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
  expect((await store.conversations("member"))[0]!.title).toBe("Group");
  const topic = await store.createConversation("member", [], "Topic", "topic", { parentId: group.id });
  await expect(store.updateGroup("member", topic.id, change())).rejects.toThrow("group_required");
  await store.updateConversation("member", group.id, { archived: true });
  await expect(store.updateGroup("member", group.id, change())).rejects.toThrow("conversation_archived");
  const direct = await store.createConversation("owner", ["alpha"], "Group", "direct");
  await expect(store.updateGroup("owner", direct.id, change())).rejects.toThrow("group_required");
});

it("blocks removal across topics while delivery, streaming or an action is outstanding", async () => {
  const group = await store.createConversation("owner", ["alpha"], "Group", "group", { type: "group" });
  const topic = await store.createConversation("owner", [], "Topic", "topic", { parentId: group.id });
  const input = await store.sendMessage("owner", { conversationId: topic.id, clientMsgId: "input", text: "hello", attachments: [], mentions: ["alpha"] });
  await expect(store.updateGroup("owner", group.id, change("Changed", ["beta"]))).rejects.toThrow("group_bot_busy");
  expect((await store.conversations("owner"))[0]!.title).toBe("Group");
  await store.acknowledgeDelivery("alpha", input.message.id);
  const output = await store.publishBotMessage("alpha", { conversationId: topic.id, blocks: [], status: "streaming" });
  await expect(store.updateGroup("owner", group.id, change("Changed", ["beta"]))).rejects.toThrow("group_bot_busy");
  await store.publishBotMessage("alpha", { id: output.id, conversationId: topic.id, blocks: [], status: "complete" });
  await store.db.run("INSERT INTO actions VALUES('owner','action','{}')");
  await store.db.run("INSERT INTO action_deliveries(id,user_id,client_action_id,bot_id,conversation_id,params_json,created_at) VALUES('action','owner','action','alpha',?,'{}',1)", [topic.id]);
  await expect(store.updateGroup("owner", group.id, change("Changed", ["beta"]))).rejects.toThrow("group_bot_busy");
  await store.finishAction("action", {});
  await store.updateGroup("owner", group.id, change("Changed", ["beta"]));
  await expect(store.sendMessage("owner", { conversationId: topic.id, clientMsgId: "removed", text: "hello", attachments: [], mentions: ["alpha"] })).rejects.toThrow("mention_forbidden");
  const sent = await store.sendMessage("owner", { conversationId: topic.id, clientMsgId: "added", text: "hello", attachments: [], mentions: ["beta"] });
  expect((await store.pendingForBot("beta"))[0]!.id).toBe(sent.message.id);
});
