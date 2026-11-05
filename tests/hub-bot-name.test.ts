import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { renameBotSchema } from "../src/client-protocol/bots.js";

let root: string, store: HubStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bot-name-")); store = await HubStore.open(root);
  await store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort) VALUES('alpha','Alpha','fixture','codex','gpt-6-astra','high')");
});
afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });

it("renames an offline Bot durably without changing its identity, chats, avatar or queued work", async () => {
  const chat = await store.createConversation("owner", ["alpha"], "My conversation", "chat");
  await store.updateConversation("owner", chat.id, { sessionId: "keep-session" });
  await store.db.run("INSERT INTO profile_avatars(kind,target_id,revision,png) VALUES('bot','alpha',7,?)", [Buffer.from("fixture")]);
  await store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "queued", text: "hello", attachments: [] });
  const tables = ["conversations", "conversation_members", "profile_avatars", "messages", "deliveries"];
  const before = await Promise.all(tables.map(table => store.db.all(`SELECT * FROM ${table}`)));
  const botBefore = (await store.bots("owner"))[0]!;
  expect(await store.renameBot("owner", "alpha", { name: "  研究助手  ", expectedName: "Alpha" })).toEqual({ name: "研究助手" });
  await store.botStatus("alpha", { online: 1 }); await store.botStatus("alpha", { online: 0 });
  await store.db.close(); store = await HubStore.open(root);
  expect((await store.bots("owner"))[0]).toEqual({ ...botBefore, name: "研究助手" });
  expect(await store.botName("owner", "alpha")).toEqual({ name: "研究助手" });
  expect(await Promise.all(tables.map(table => store.db.all(`SELECT * FROM ${table}`)))).toEqual(before);
  expect(await store.db.get("SELECT secret_hash FROM bots WHERE id='alpha'")).toEqual({ secret_hash: "fixture" });
});

it("rejects concurrent stale edits while allowing a retry of the same saved name", async () => {
  const results = await Promise.allSettled(["First", "Second"].map(name => store.renameBot("owner", "alpha", { name, expectedName: "Alpha" })));
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(results[1]).toMatchObject({ reason: { message: "bot_name_conflict", status: 409 } });
  expect(await store.renameBot("owner", "alpha", { name: "First", expectedName: "Alpha" })).toEqual({ name: "First" });
  await expect(store.renameBot("owner", "alpha", { name: "Third", expectedName: "Alpha" })).rejects.toThrow("bot_name_conflict");
  expect(await store.renameBot("owner", "alpha", { name: "Third", expectedName: "First" })).toEqual({ name: "Third" });
});

it("can replace a legacy CLI name that predates current creation limits", async () => {
  const legacy = `  ${"Old".repeat(40)}  `;
  await store.db.run("UPDATE bots SET name=? WHERE id='alpha'", [legacy]);
  expect(await store.botName("owner", "alpha")).toEqual({ name: legacy });
  expect(await store.renameBot("owner", "alpha", { name: " Short name ", expectedName: legacy })).toEqual({ name: "Short name" });
});

it("requires owner authority inside the write transaction and validates the complete request", async () => {
  await store.db.run("INSERT INTO users VALUES('member','Member','member')");
  await store.db.run("INSERT INTO bot_grants VALUES('member','alpha')");
  await expect(store.botName("member", "alpha")).rejects.toThrow("owner_required");
  await expect(store.renameBot("member", "alpha", { name: "New", expectedName: "Alpha" })).rejects.toThrow("owner_required");
  await expect(store.renameBot("owner", "alpha", { name: "New", expectedName: "Alpha" }, async () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
  for (const input of [{ name: " ", expectedName: "Alpha" }, { name: "a".repeat(101), expectedName: "Alpha" }, { name: "New" }, { name: "New", expectedName: "Alpha", id: "beta" }]) expect(renameBotSchema.safeParse(input).success).toBe(false);
  await expect(store.botName("owner", "missing")).rejects.toThrow("bot_not_found");
  await expect(store.renameBot("owner", "missing", { name: "New", expectedName: "Alpha" })).rejects.toThrow("bot_not_found");
  expect(await store.botName("owner", "alpha")).toEqual({ name: "Alpha" });
});
