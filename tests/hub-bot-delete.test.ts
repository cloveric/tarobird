import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BotManager } from "../src/hub/bot-manager.js";
import { HubServer } from "../src/hub/server.js";
import { deleteBotSchema } from "../src/client-protocol/bots.js";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";
import { nativeRun } from "../src/client-protocol/run.js";

let root: string, hub: HubServer, manager: BotManager;
const spec = { requestId: "delete_fixture", name: "研究助手", engine: "codex" as const, model: "", effort: "" as const, workspace: "" };
const until = async (check: () => Promise<boolean>) => { const deadline = Date.now() + 5000; while (!await check()) { if (Date.now() > deadline) throw new Error("timeout"); await new Promise(r => setTimeout(r, 20)); } };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-bot-delete-")); hub = await HubServer.start({ stateDir: root });
  manager = new BotManager(hub.store, root, { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath } }, () => hub.instanceUrl, async () => {});
});
afterEach(async () => { await manager.close(); await hub.close(); await rm(root, { recursive: true, force: true }); });

it("stops the worker, settles tasks, archives direct chats and preserves group peers, history and files", async () => {
  const bot = await manager.create("owner", spec);
  const other = await manager.create("owner", { ...spec, requestId: "other", name: "写作助手" });
  await until(async () => (await hub.store.bots("owner")).every(bot => bot.online === 1));
  const chat = await hub.store.createConversation("owner", [bot.id], "保留对话", "direct");
  const group = await hub.store.createConversation("owner", [bot.id, other.id], "协作群", "group");
  const topic = await hub.store.createConversation("owner", [], "话题", "topic", { parentId: group.id });
  const emptyGroup = await hub.store.createConversation("owner", [bot.id], "只有一个 Bot", "solo", { type: "group" });
  const file = path.join(root, "bots", bot.id, "workspace", "keep.txt"); await writeFile(file, "user content");
  const old = await hub.store.publishBotMessage(bot.id, { conversationId: chat.id, blocks: [{ type: "text", text: "历史回答" }], status: "complete" });
  const queued = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "queued", text: "工作", attachments: [] });
  const run = createRunRecord(); recordRunEvent(run, { type: "tool_use", toolName: "Read", toolInput: { path: "keep.txt" } });
  const active = await hub.store.publishBotMessage(bot.id, { conversationId: chat.id, replyTo: queued.message.id, blocks: [{ type: "card", elements: [], extra: { nativeRun: JSON.parse(JSON.stringify(summarizeRun(run, "running"))) } }], status: "streaming" });
  await hub.store.enqueueAction("owner", "pending_action", {}, bot.id, chat.id, {});
  const changes = await manager.delete("owner", bot.id, bot.name);
  expect(changes.find(c => c.id === chat.id)?.archived).toBe(true);
  expect(changes.find(c => c.id === group.id)?.botIds).toEqual([other.id]);
  expect(changes.find(c => c.id === topic.id)?.botIds).toEqual([other.id]);
  expect(changes.find(c => c.id === emptyGroup.id)?.archived).toBe(true);
  expect(await hub.store.bots("owner")).toHaveLength(1);
  expect((await hub.store.bots("owner", true)).find(b => b.id === bot.id)).toMatchObject({ name: bot.name, online: 0, managed: 0, deletedAt: expect.any(Number) });
  expect(manager.serviceStatus(bot.id).text).not.toContain("PID:");
  expect(manager.serviceStatus(other.id).text).toContain("PID:");
  expect(await readFile(file, "utf8")).toBe("user content");
  const messages = await hub.store.db.all<{ id: string; status: string; blocks_json: string }>("SELECT * FROM messages WHERE conversation_id=?", [chat.id]);
  expect(messages.find(m => m.id === old.id)?.status).toBe("complete");
  const interrupted = messages.find(m => m.id === active.id)!;
  expect(interrupted.status).toBe("error"); expect(nativeRun(JSON.parse(interrupted.blocks_json)[0])?.phase).toBe("interrupted");
  expect(await hub.store.pendingActions(bot.id)).toEqual([]);
  expect(await hub.store.pendingForBot(bot.id)).toEqual([]);
  await expect(hub.store.updateConversation("owner", chat.id, { archived: false })).rejects.toThrow("bot_deleted");
  await expect(hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "late", text: "late", attachments: [] })).rejects.toThrow("conversation_archived");
  await expect(hub.store.publishBotMessage(bot.id, { conversationId: chat.id, blocks: [{ type: "text", text: "late output" }] })).rejects.toThrow("bot_deleted");
  await expect(hub.store.createConversation("owner", [bot.id], "不可复活", "late_chat")).rejects.toThrow("bot_not_found");
  await expect(manager.restart(bot.id)).rejects.toThrow("bot_forbidden");
  await expect(manager.create("owner", spec)).rejects.toThrow("bot_deleted");
  await manager.delete("owner", bot.id, "旧名称");
  const options = manager.options; await manager.close();
  manager = new BotManager(hub.store, root, options, () => hub.instanceUrl, async () => {}); await manager.restore();
  await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
  expect(manager.serviceStatus(bot.id).text).not.toContain("PID:");
}, 20000);

it("checks owner and fresh device trust inside admission; stale confirmations and unmanaged Bots cannot delete", async () => {
  const bot = await manager.create("owner", spec);
  await hub.store.db.run("INSERT INTO users VALUES('member','Guest','member')");
  await expect(manager.delete("member", bot.id, bot.name)).rejects.toThrow("owner_required");
  await expect(manager.delete("owner", bot.id, bot.name, async () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
  await hub.store.renameBot("owner", bot.id, { name: "新名称", expectedName: bot.name });
  await expect(manager.delete("owner", bot.id, bot.name)).rejects.toThrow("bot_name_conflict");
  expect(await hub.store.bots("owner")).toHaveLength(1);
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('external','External','fixture')");
  await expect(manager.delete("owner", "external", "External")).rejects.toThrow("bot_delete_unmanaged");
  for (const value of [{ expectedName: bot.name }, { expectedName: bot.name, confirm: false }, { expectedName: bot.name, confirm: true, wipeFiles: true }]) expect(deleteBotSchema.safeParse(value).success).toBe(false);
});

it("serializes create, restart and duplicate delete without resurrecting a worker", async () => {
  const bot = await manager.create("owner", spec);
  const results = await Promise.allSettled([manager.restart(bot.id), manager.delete("owner", bot.id, bot.name), manager.create("owner", spec), manager.delete("owner", bot.id, bot.name)]);
  expect(results[1]!.status).toBe("fulfilled"); expect(results[3]!.status).toBe("fulfilled");
  expect(results[2]).toMatchObject({ status: "rejected", reason: { code: "bot_deleted" } });
  await new Promise(r => setTimeout(r, 1200));
  expect(await hub.store.bots("owner")).toEqual([]); expect(manager.serviceStatus(bot.id).text).not.toContain("PID:");
});

it("retains completed interactive history and settles deletion without issuing error notifications", async () => {
  const bot = await manager.create("owner", spec);
  const chat = await hub.store.createConversation("owner", [bot.id], "交互历史", "retire-history");
  const run = createRunRecord();
  const messages = await Promise.all([false, true].map(disabled => hub.store.publishBotMessage(bot.id, {
    conversationId: chat.id, status: "complete", blocks: [{ type: "card", title: "已保存的配置", elements: [
      { type: "form", actionId: "form", children: [{ type: "input", actionId: "answer", value: "回调数据", extra: { default_value: "用户保留的答案" }, disabled }, { type: "button", text: "确认", actionId: "confirm", disabled }] },
    ] }],
  })));
  const done = await hub.store.publishBotMessage(bot.id, { conversationId: chat.id, status: "complete", blocks: [{ type: "card", title: "已完成的任务", elements: [], extra: { nativeRun: JSON.parse(JSON.stringify(summarizeRun(run, "done"))) } }] });
  const terminalWithActions = await hub.store.publishBotMessage(bot.id, { conversationId: chat.id, status: "complete", blocks: [{ type: "card", title: "已完成，可查看来源", elements: [
    { type: "button", text: "再运行", actionId: "again" },
    { type: "button", text: "查看来源", actionId: "source", url: "https://example.com/source", confirm: { title: "打开来源", text: "将打开外部网页" } },
    { type: "button", text: "原先不可用", actionId: "unavailable", url: "https://example.com/unavailable", disabled: true },
    { type: "button", text: "非网页动作", actionId: "local", url: "file:///not-a-web-link" },
  ], extra: { nativeRun: JSON.parse(JSON.stringify(summarizeRun(run, "done"))) } }] });
  const active = await hub.store.publishBotMessage(bot.id, { conversationId: chat.id, status: "streaming", blocks: [{ type: "card", title: "进行中的任务", elements: [], extra: { nativeRun: JSON.parse(JSON.stringify(summarizeRun(createRunRecord(), "running"))) } }] });
  // Register a background recipient only after the original messages are stored.
  await hub.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,revoked,created_at,last_seen,push_json) VALUES('retire_phone','owner','Phone','android','fixture',0,1,1,?)", [JSON.stringify({ provider: "fcm", token: "test_registration_token_" + "x".repeat(40) })]);
  await hub.store.db.run("INSERT INTO device_preferences VALUES('retire_phone',?)", [JSON.stringify({ enabled: true, quietStart: "", quietEnd: "", timeZone: "UTC" })]);
  await manager.delete("owner", bot.id, bot.name);
  for (const old of messages) {
    const current = await hub.store.messageForUser("owner", old.id);
    expect(current.status).toBe("complete");
    expect(current.blocks[0]).toMatchObject({ title: "已保存的配置", elements: [{ children: [{ value: "回调数据", extra: { default_value: "用户保留的答案" }, disabled: true }, { disabled: true }] }] });
    expect(JSON.stringify(current.blocks)).not.toContain("actionId");
    expect(JSON.stringify(current.blocks)).not.toContain("处理已中断");
  }
  expect(await hub.store.messageForUser("owner", done.id)).toEqual(done);
  const retired = await hub.store.messageForUser("owner", terminalWithActions.id);
  expect(retired.status).toBe("complete");
  expect(retired.blocks[0]).toMatchObject({ title: "已完成，可查看来源", extra: terminalWithActions.blocks[0]!.type === "card" ? terminalWithActions.blocks[0].extra : {}, elements: [
    { disabled: true }, { url: "https://example.com/source", confirm: { title: "打开来源" } }, { disabled: true }, { disabled: true },
  ] });
  if (retired.blocks[0]?.type === "card") expect(retired.blocks[0].elements[1]!.disabled).not.toBe(true);
  expect(JSON.stringify(retired.blocks)).not.toContain("actionId");
  expect((await hub.store.messageForUser("owner", active.id)).status).toBe("error");
  expect(await hub.store.db.all("SELECT * FROM push_outbox WHERE conversation_id=?", [chat.id])).toEqual([]);
});
