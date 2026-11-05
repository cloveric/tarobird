import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { HubDispatch, parseResetHint } from "../src/hub/dispatch.js";
import { renderedEngineFailure } from "../src/core/errors.js";
import type { DispatchTicket } from "../src/client-protocol/dispatch.js";
import type { Conversation } from "../src/client-protocol/index.js";

let root: string, hub: HubServer, home: Conversation;
const owner = { kind: "owner" as const, userId: "owner" };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-dispatch-"));
  hub = await HubServer.start({ stateDir: root });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('d','Dispatcher','fixture','claude','','','dispatcher')");
  for (const [id, engine] of [["codex1", "codex"], ["kimi1", "kimi"]]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort) VALUES(?,?,?,?,?,?)", [id, id, "fixture", engine!, "", ""]);
  // The Host's hidden engine workers (BotManager creates them in production).
  for (const engine of ["codex", "kimi", "claude"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES(?,?,?,?,?,?,'worker')", [`w_${engine}`, `Dispatcher · ${engine}`, "fixture", engine, "", ""]);
  const engines = ["codex", "claude", "kimi", "deepseek", "antigravity"] as const;
  hub.dispatch.workers = {
    catalog: async () => ({ engines: engines.map(id => ({ id, available: id !== "antigravity", models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" })) }),
    dispatchWorker: async (_dispatcher, engine) => `w_${engine}`,
    ticketWorkspace: async (_dispatcher, ticketId) => path.join(root, "tickets", ticketId),
  };
  home = await hub.store.createConversation("owner", ["d"], "Dispatcher", "home");
});
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

const create = (requestId: string, title = "Write notes") => hub.dispatch.create(owner, "d", { requestId, title, request: `${title} please` });
async function finish(ticket: DispatchTicket, text: string, status: "complete" | "error" = "complete") {
  const attempt = ticket.attempts.at(-1)!;
  await hub.store.publishBotMessage(attempt.botId, { conversationId: attempt.conversationId, blocks: [{ type: "text", text }], replyTo: attempt.inputMessageId, status });
  await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [attempt.inputMessageId, attempt.botId]);
  await hub.dispatch.sweep();
  return hub.dispatch.show(owner, ticket.id);
}
const notices = () => hub.store.db.all<{ blocks_json: string; bot_source_json: string }>("SELECT blocks_json,bot_source_json FROM messages WHERE conversation_id=? ORDER BY created_at,rowid", [home.id]);

it("keeps a dispatcher to one direct conversation and out of groups", async () => {
  await expect(hub.store.createConversation("owner", ["d"], "Second", "second")).rejects.toThrow("dispatcher_single_conversation");
  await expect(hub.store.createConversation("owner", ["d", "codex1"], "Group", "group", { type: "group" })).rejects.toThrow("dispatcher_group_forbidden");
  const group = await hub.store.createConversation("owner", ["codex1", "kimi1"], "Group", "group2", { type: "group" });
  await expect(hub.store.updateGroup("owner", group.id, { title: group.title, expectedTitle: group.title, botIds: [...group.botIds, "d"], expectedBotIds: group.botIds })).rejects.toThrow("dispatcher_group_forbidden");
  expect((await hub.store.bots("owner")).find(bot => bot.id === "d")).toMatchObject({ role: "dispatcher" });
  expect((await hub.store.bots("owner")).find(bot => bot.id === "codex1")).not.toHaveProperty("role");
});

it("keeps engine workers internal to their dispatcher", async () => {
  await expect(hub.store.createConversation("owner", ["w_codex"], "Direct", "direct-worker")).rejects.toThrow("dispatch_worker_internal");
  const group = await hub.store.createConversation("owner", ["codex1", "kimi1"], "Group", "group");
  await expect(hub.store.updateGroup("owner", group.id, { title: group.title, expectedTitle: group.title, botIds: [...group.botIds, "w_codex"], expectedBotIds: group.botIds })).rejects.toThrow("dispatch_worker_internal");
  const { targets } = await hub.dispatch.targets(owner, "d");
  expect(targets.map(t => [t.engine, t.installed, t.allowed])).toEqual([["codex", true, true], ["claude", true, true], ["kimi", true, true], ["deepseek", true, true], ["antigravity", false, true]]);
});

it("dispatches a ticket into a hidden worker conversation with its own model and effort", async () => {
  const ticket = await create("r1");
  expect(ticket).toMatchObject({ status: "queued", paused: false, attempts: [], conversationId: home.id });
  const working = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: ticket.id, engine: "codex", model: "gpt-x", effort: "high" });
  const attempt = working.attempts[0]!;
  expect(working.status).toBe("working");
  expect(attempt).toMatchObject({ botId: "w_codex", engine: "codex", model: "gpt-x", effort: "high" });
  const worker = (await hub.store.conversations("owner")).find(c => c.id === attempt.conversationId)!;
  expect(worker).toMatchObject({ hidden: true, botIds: ["w_codex"], ticket: { id: ticket.id, dispatcherBotId: "d", model: "gpt-x", effort: "high", workspace: path.join(root, "tickets", ticket.id) } });
  expect((await hub.store.conversations("owner", { hidden: false })).some(c => c.id === worker.id)).toBe(false);
  const input = await hub.store.db.get<{ bot_source_json: string }>("SELECT bot_source_json FROM messages WHERE id=?", [attempt.inputMessageId]);
  expect(JSON.parse(input!.bot_source_json)).toMatchObject({ botId: "d", requestId: attempt.id, hops: 1 });
  expect(await hub.store.db.get("SELECT bot_id FROM deliveries WHERE message_id=?", [attempt.inputMessageId])).toEqual({ bot_id: "w_codex" });
  // A replayed request returns the same receipt; a busy ticket is not dispatched twice.
  expect(await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: ticket.id, engine: "codex", model: "gpt-x", effort: "high" })).toEqual(working);
  await expect(hub.dispatch.dispatch(owner, "d", { requestId: "again", ticketId: ticket.id, engine: "codex" })).rejects.toThrow("ticket_already_working");
  const other = await create("r2", "Other");
  await expect(hub.dispatch.dispatch(owner, "d", { requestId: "bad", ticketId: other.id, engine: "claude", effort: "ultra" })).rejects.toThrow("dispatch_effort_incompatible");
  await expect(hub.dispatch.dispatch(owner, "d", { requestId: "flag", ticketId: other.id, engine: "codex", model: "--config=x" })).rejects.toThrow();
});

it("wakes the dispatcher with the result and leaves it for review", async () => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  await hub.dispatch.sweep();
  expect((await hub.dispatch.show(owner, ticket.id)).status).toBe("working");
  const done = await finish(ticket, "Here are the notes.");
  expect(done).toMatchObject({ status: "needs_review", result: "Here are the notes.", attempts: [{ outcome: "completed" }] });
  const [notice] = await notices();
  expect(notice!.blocks_json).toContain("【工单完成】");
  expect(JSON.parse(notice!.bot_source_json)).toMatchObject({ botId: "w_codex" });
  const delivered = await hub.store.db.get("SELECT d.bot_id FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.conversation_id=?", [home.id]);
  expect(delivered).toEqual({ bot_id: "d" });
  // Settling is idempotent.
  await hub.dispatch.sweep(); expect(await notices()).toHaveLength(1);
  expect(await hub.dispatch.action("owner", ticket.id, { requestId: "acc", action: "accept" })).toMatchObject({ status: "done" });
});

it("marks an exhausted engine, preserves owner restrictions in its reassign notice and blocks it until forced", async () => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "kimi" });
  const failed = await finish(ticket, "错误：Kimi 当前 5 小时使用额度已用完。请等待额度窗口重置，或购买额外额度/升级套餐；重新登录或重启都无效。 重置信息：resets in 2h。", "error");
  expect(failed).toMatchObject({ status: "queued", attempts: [{ outcome: "failed", failure: { category: "engine-quota", resetHint: "resets in 2h" } }] });
  const notice = (await notices())[0]!.blocks_json;
  expect(notice).toContain("【需要改派】");
  expect(notice).toContain("若主人限定了引擎或模型");
  expect(notice).toContain("不要擅自替换");
  expect(notice).toContain("原有确认与费用规则");
  expect(notice).toContain("改派给其他合适的可用目标，并保留已有进度");
  expect(notice).not.toContain("不要让工单失败");
  const { engines } = await hub.dispatch.list(owner, "d");
  expect(engines).toMatchObject([{ engine: "kimi", state: "cooldown" }]);
  expect(engines[0]!.until! - Date.now()).toBeGreaterThan(110 * 60_000);
  await expect(hub.dispatch.dispatch(owner, "d", { requestId: "retry", ticketId: ticket.id, engine: "kimi" })).rejects.toThrow("engine_unavailable:kimi:cooldown");
  const moved = await hub.dispatch.dispatch(owner, "d", { requestId: "move", ticketId: ticket.id, engine: "claude" });
  expect(moved.attempts.map(a => a.engine)).toEqual(["kimi", "claude"]);
  expect(moved.attempts[1]!.conversationId).not.toBe(moved.attempts[0]!.conversationId);
  // Another CLI continues in the same ticket directory.
  const markers = await hub.store.db.all<{ ticket_json: string }>("SELECT ticket_json FROM conversations WHERE id IN (?,?)", [moved.attempts[0]!.conversationId, moved.attempts[1]!.conversationId]);
  expect(new Set(markers.map(row => JSON.parse(row.ticket_json).workspace))).toEqual(new Set([path.join(root, "tickets", ticket.id)]));
  await finish(moved, "done");
  await hub.dispatch.resetEngine("owner", "kimi");
  expect((await hub.dispatch.list(owner, "d")).engines).toEqual([]);
});

it("treats a sign-in failure as login required and an ordinary failure as blocked", async () => {
  const one = await hub.dispatch.dispatch(owner, "d", { requestId: "a", ticketId: (await create("r1", "One")).id, engine: "claude" });
  expect(await finish(one, "错误：Claude Code 尚未登录或登录已过期。请在运行此 Bot 的主机上执行 `claude auth login`，完成登录后重试。聊天记录会保留。", "error")).toMatchObject({ status: "queued" });
  expect((await hub.dispatch.list(owner, "d")).engines).toMatchObject([{ engine: "claude", state: "login_required" }]);
  const two = await hub.dispatch.dispatch(owner, "d", { requestId: "b", ticketId: (await create("r2", "Two")).id, engine: "codex" });
  expect(await finish(two, "The test suite fails on line 3.", "error")).toMatchObject({ status: "blocked", attempts: [{ failure: { category: "task" } }] });
  expect((await notices()).at(-1)!.blocks_json).toContain("【工单卡住】");
});

it("enforces settings: allowed engines, concurrency and revision checks", async () => {
  const settings = await hub.dispatch.settings("owner", "d");
  expect(settings.settings).toEqual({ mode: "ask", maxConcurrent: 2 });
  await expect(hub.dispatch.updateSettings("owner", "d", { settings: { mode: "auto", maxConcurrent: 1, allowedEngines: ["codex"] }, expectedRevision: "stale" })).rejects.toThrow("dispatcher_settings_conflict");
  await expect(hub.dispatch.updateSettings("owner", "d", { settings: { mode: "auto", maxConcurrent: 1, allowedEngines: ["vim"] }, expectedRevision: settings.revision })).rejects.toThrow();
  const saved = await hub.dispatch.updateSettings("owner", "d", { settings: { mode: "auto", maxConcurrent: 1, allowedEngines: ["codex"] }, expectedRevision: settings.revision });
  expect((await hub.dispatch.targets(owner, "d")).targets.filter(t => t.allowed).map(t => t.engine)).toEqual(["codex"]);
  const [a, b] = [await create("r1", "A"), await create("r2", "B")];
  await expect(hub.dispatch.dispatch(owner, "d", { requestId: "x", ticketId: a.id, engine: "kimi" })).rejects.toThrow("dispatch_engine_not_allowed");
  await hub.dispatch.dispatch(owner, "d", { requestId: "z", ticketId: a.id, engine: "codex" });
  await expect(hub.dispatch.dispatch(owner, "d", { requestId: "w", ticketId: b.id, engine: "codex" })).rejects.toThrow("dispatch_concurrency_limit");
  expect(saved.revision).not.toBe(settings.revision);
});

it("refuses queue pauses for a real ticket input so its concurrency slot can finish", async () => {
  const settings = await hub.dispatch.settings("owner", "d");
  await hub.dispatch.updateSettings("owner", "d", { settings: { mode: "auto", maxConcurrent: 1 }, expectedRevision: settings.revision });
  const first = await hub.dispatch.dispatch(owner, "d", { requestId: "queue-first", ticketId: (await create("first")).id, engine: "codex" });
  const second = await create("second"), attempt = first.attempts[0]!, queue = new HubPromptQueue(hub.store);
  await queue.registerWorker(attempt.botId, true);
  const snapshot = await queue.read("owner", attempt.botId, attempt.conversationId);
  expect(snapshot.items[0].message.botSource).toBeDefined();
  await expect(queue.mutate("owner", attempt.conversationId, { requestId: "pause-ticket-input", botId: attempt.botId, revision: snapshot.revision, action: { type: "pause", messageId: attempt.inputMessageId } })).rejects.toThrow("queue_item_unsupported");
  expect((await queue.read("owner", attempt.botId, attempt.conversationId)).items[0]).toMatchObject({ canPause: false, canCancel: true, paused: false });
  expect((await queue.claim(attempt.botId, true, false)).map(message => message.id)).toEqual([attempt.inputMessageId]);
  await finish(first, "First ticket complete");
  expect((await hub.dispatch.dispatch(owner, "d", { requestId: "queue-second", ticketId: second.id, engine: "codex" })).status).toBe("working");
});

it.each(["resume", "cancel"] as const)("recovers a ticket input paused by an older Host through queue %s", async action => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "legacy-paused", ticketId: (await create("legacy")).id, engine: "codex" });
  const attempt = ticket.attempts[0]!, queue = new HubPromptQueue(hub.store);
  await queue.registerWorker(attempt.botId, true);
  await hub.store.db.run("UPDATE deliveries SET queue_paused=1 WHERE message_id=? AND bot_id=?", [attempt.inputMessageId, attempt.botId]);
  const snapshot = await queue.read("owner", attempt.botId, attempt.conversationId);
  expect(snapshot.items[0]).toMatchObject({ paused: true, canPause: false, canResume: true, canCancel: true });
  await queue.mutate("owner", attempt.conversationId, { requestId: "recover-legacy", botId: attempt.botId, revision: snapshot.revision, action: { type: action, messageId: attempt.inputMessageId } });
  if (action === "resume") {
    expect((await queue.claim(attempt.botId, true, false)).map(message => message.id)).toEqual([attempt.inputMessageId]);
    expect((await finish(ticket, "Recovered")).status).toBe("needs_review");
  } else {
    await hub.dispatch.sweep();
    expect(await hub.dispatch.show(owner, ticket.id)).toMatchObject({ status: "queued", attempts: [{ outcome: "cancelled", endedAt: expect.any(Number) }] });
  }
});

it("adds removal capability only to explicitly requested owner overview snapshots", async () => {
  expect(await hub.dispatch.overview(owner, "d")).not.toHaveProperty("capabilities");
  expect(await hub.dispatch.list(owner, "d")).not.toHaveProperty("capabilities");
  expect(await hub.dispatch.overview(owner, "d", { capabilities: true })).toMatchObject({ capabilities: { remove: true } });
});

it("lets the owner pause, resume and cancel; a paused ticket is not dispatched", async () => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  const paused = await hub.dispatch.action("owner", ticket.id, { requestId: "p", action: "pause" });
  expect(paused).toMatchObject({ paused: true, status: "queued", attempts: [{ outcome: "cancelled" }] });
  await expect(hub.dispatch.dispatch(owner, "d", { requestId: "again", ticketId: ticket.id, engine: "codex" })).rejects.toThrow("ticket_paused");
  expect(await hub.dispatch.action("owner", ticket.id, { requestId: "r", action: "resume" })).toMatchObject({ paused: false });
  expect((await notices()).at(-1)!.blocks_json).toContain("【工单恢复】");
  expect(await hub.dispatch.action("owner", ticket.id, { requestId: "c", action: "cancel" })).toMatchObject({ status: "cancelled" });
  await expect(hub.dispatch.action("owner", ticket.id, { requestId: "c2", action: "accept" })).rejects.toThrow("ticket_closed");
});

it("accepts dispatcher writes only during its own active turn", async () => {
  const context = await hub.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "turn", text: "plan", attachments: [] });
  const bot = { kind: "bot" as const, botId: "d", contextMessage: context.message.id };
  await expect(hub.dispatch.create(bot, "d", { requestId: "r1", title: "T", request: "R" })).rejects.toThrow("dispatch_context_not_active");
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [context.message.id]);
  const ticket = await hub.dispatch.create(bot, "d", { requestId: "r1", title: "T", request: "R" });
  await expect(hub.dispatch.create({ kind: "bot", botId: "codex1", contextMessage: context.message.id }, "d", { requestId: "r2", title: "T", request: "R" })).rejects.toThrow("dispatcher_forbidden");
  expect((await hub.dispatch.list({ kind: "bot", botId: "d" }, "d")).tickets.map(t => t.id)).toEqual([ticket.id]);
});

it.each(["pause", "cancel"] as const)("%s cancels the undispatched input before a worker can claim it", async action => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  const attempt = ticket.attempts[0]!;
  const stop = vi.spyOn(hub.dispatch.options, "stop");
  await hub.dispatch.action("owner", ticket.id, { requestId: "stop", action });
  expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [attempt.inputMessageId])).toEqual({ status: "cancelled" });
  expect(stop).not.toHaveBeenCalled();
  expect(await new HubPromptQueue(hub.store).claim(attempt.botId, true, true)).toEqual([]);
});

it("keeps an unconfirmed stop active, retries its exact input and fences a later attempt", async () => {
  const settings = await hub.dispatch.settings("owner", "d");
  await hub.dispatch.updateSettings("owner", "d", { settings: { maxConcurrent: 1 }, expectedRevision: settings.revision });
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  const attempt = ticket.attempts[0]!;
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [attempt.inputMessageId]);
  const stop = vi.spyOn(hub.dispatch.options, "stop").mockRejectedValue(new Error("bot_offline"));
  const pending = await hub.dispatch.action("owner", ticket.id, { requestId: "p", action: "pause" });
  expect(pending).toMatchObject({ status: "working", paused: true, attempts: [{ stopRequested: "pause" }] });
  expect(pending.attempts[0]).not.toHaveProperty("endedAt");
  expect(stop).toHaveBeenCalledWith(attempt.botId, attempt.conversationId, "owner", attempt.inputMessageId);
  await expect(hub.dispatch.action("owner", ticket.id, { requestId: "resume", action: "resume" })).rejects.toThrow("ticket_stop_pending");
  const other = await create("r2");
  await expect(hub.dispatch.dispatch(owner, "d", { requestId: "second", ticketId: other.id, engine: "codex" })).rejects.toThrow("dispatch_concurrency_limit");
  stop.mockResolvedValue({ stopped: true });
  await hub.dispatch.sweep();
  expect((await hub.dispatch.show(owner, ticket.id)).status).toBe("working");
  await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [attempt.inputMessageId]);
  await hub.dispatch.sweep();
  expect(await hub.dispatch.show(owner, ticket.id)).toMatchObject({ status: "queued", paused: true, attempts: [{ outcome: "cancelled" }] });
  expect(await notices()).toEqual([]); // Owner pause must not wake the planner to retry.
  await hub.dispatch.action("owner", ticket.id, { requestId: "resume2", action: "resume" });
  const restarted = await hub.dispatch.dispatch(owner, "d", { requestId: "go2", ticketId: ticket.id, engine: "codex" });
  stop.mockClear();
  await hub.dispatch.action("owner", ticket.id, { requestId: "p", action: "pause" });
  expect(stop).not.toHaveBeenCalled();
  expect((await hub.dispatch.show(owner, ticket.id)).attempts.at(-1)?.id).toBe(restarted.attempts.at(-1)?.id);
  expect((await hub.dispatch.show(owner, ticket.id)).paused).toBe(false);
});

it("recovers engine failure categories and reset times from rendered replies", () => {
  expect(renderedEngineFailure("Error: the engine usage quota is exhausted. Wait for the quota window to reset or increase the account quota; signing in again or restarting will not help. Reset information: resets at 5pm.")).toEqual({ category: "engine-quota", resetHint: "resets at 5pm" });
  expect(renderedEngineFailure("错误：模型服务当前触发限流。请稍等后重试；重置聊天或重启实例都无效。")).toEqual({ category: "engine-rate-limit" });
  expect(renderedEngineFailure("The test failed.")).toBeUndefined();
  const now = new Date(2026, 10, 1, 12, 0).getTime();
  expect(parseResetHint("resets in 2h 30m", now)).toBe(now + 150 * 60_000);
  expect(parseResetHint("resets at 5pm", now)).toBe(new Date(2026, 10, 1, 17, 0).getTime());
  expect(parseResetHint("resets at 9am", now)).toBe(new Date(2026, 10, 2, 9, 0).getTime());
  expect(parseResetHint("soon", now)).toBeUndefined();
});

it("retains cancel intent across service reconstruction and waits for the last live reply", async () => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  const attempt = ticket.attempts[0]!;
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [attempt.inputMessageId]);
  const reply = await hub.store.publishBotMessage(attempt.botId, { conversationId: attempt.conversationId, replyTo: attempt.inputMessageId, blocks: [{ type: "text", text: "running" }], status: "streaming" });
  const stop = vi.spyOn(hub.dispatch.options, "stop").mockRejectedValue(new Error("offline"));
  expect(await hub.dispatch.action("owner", ticket.id, { requestId: "c", action: "cancel" })).toMatchObject({ status: "working", attempts: [{ stopRequested: "cancel" }] });
  const restored = new HubDispatch(hub.store, hub.dispatch.options);
  await hub.store.db.run("UPDATE deliveries SET status='failed' WHERE message_id=?", [attempt.inputMessageId]);
  await restored.sweep();
  expect((await restored.show(owner, ticket.id)).status).toBe("working");
  await hub.store.db.run("UPDATE messages SET status='error' WHERE id=?", [reply.id]);
  await restored.sweep();
  expect(await restored.show(owner, ticket.id)).toMatchObject({ status: "cancelled", attempts: [{ outcome: "cancelled", stopRequested: "cancel" }] });
  expect(stop).toHaveBeenCalledWith(attempt.botId, attempt.conversationId, "owner", attempt.inputMessageId);
  expect(await notices()).toEqual([]);
});

it("rotates bounded settlement batches so old running tickets cannot starve later results", async () => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  // 64 older attempts with no delivery yet fill the first bounded sweep.
  for (let i = 0; i < 64; i++) await hub.store.db.run("INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,attempts_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'working',?,0,0)",
    [`a_${String(i).padStart(3, "0")}`, "d", home.id, `r_old_${i}`, "Old", "Old", JSON.stringify([{ ...ticket.attempts[0], id: `a_${i}`, inputMessageId: `missing_${i}` }])]);
  const attempt = ticket.attempts[0]!;
  await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [attempt.inputMessageId]);
  await hub.dispatch.sweep(); await hub.dispatch.sweep();
  expect((await hub.dispatch.show(owner, ticket.id)).status).toBe("needs_review");
});

it("keeps an old open ticket visible ahead of recent completed history", async () => {
  const old = await create("old");
  for (let i = 0; i < 200; i++) await hub.store.db.run("INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'done',?,?)",
    [`done_${i}`, "d", home.id, `r_done_${i}`, "Done", "Done", old.createdAt + i + 1, old.updatedAt + i + 1]);
  expect((await hub.dispatch.list(owner, "d")).tickets.map(t => t.id)).toContain(old.id);
});

it("settles a deleted dispatcher's stopped worker without trying to wake the deleted planner", async () => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  await hub.store.db.run("UPDATE bots SET deleted_at=? WHERE id IN ('d','w_codex')", [Date.now()]);
  await hub.dispatch.sweep();
  expect(await hub.store.db.get("SELECT status FROM dispatch_tickets WHERE id=?", [ticket.id])).toEqual({ status: "cancelled" });
  expect(await notices()).toEqual([]);
});

it.each(["waiting_answer", "waiting_approval"] as const)("surfaces %s once without releasing the worker slot", async phase => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  const attempt = ticket.attempts[0]!;
  const card = { type: "card" as const, elements: [], extra: { nativeRun: { version: 1, id: "run", revision: 1, phase, startedAt: 1, updatedAt: 1, count: 0, completed: 0, failed: 0, truncated: false } } };
  const reply = await hub.store.publishBotMessage(attempt.botId, { conversationId: attempt.conversationId, blocks: [card], replyTo: attempt.inputMessageId, status: "streaming" });
  await hub.dispatch.sweep(); await hub.dispatch.sweep();
  expect(await hub.dispatch.show(owner, ticket.id)).toMatchObject({ status: "working", attempts: [{ waitingFor: { kind: phase === "waiting_answer" ? "answer" : "approval", messageId: reply.id } }] });
  expect(await notices()).toHaveLength(1);
  expect((await notices())[0]!.blocks_json).toContain("【工单需要处理】");
  // Resolving the question continues this attempt; it does not start another.
  await hub.store.db.run("UPDATE messages SET blocks_json=? WHERE id=?", [JSON.stringify([{ ...card, extra: { nativeRun: { ...card.extra.nativeRun, phase: "working" } } }]), reply.id]);
  await hub.dispatch.sweep();
  expect((await hub.dispatch.show(owner, ticket.id)).attempts[0]).not.toHaveProperty("waitingFor");
  expect((await hub.dispatch.show(owner, ticket.id)).status).toBe("working");
});

it("does not replay a stopped dispatched input after the worker reconnects", async () => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  const attempt = ticket.attempts[0]!;
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [attempt.inputMessageId]);
  await hub.dispatch.action("owner", ticket.id, { requestId: "pause", action: "pause" });
  const queue = new HubPromptQueue(hub.store);
  expect(await queue.claim(attempt.botId, true, true)).toEqual([]);
  await hub.dispatch.sweep();
  expect((await hub.dispatch.show(owner, ticket.id)).status).toBe("working");
  // A reconnect is not proof of a stopped old process. Settle only after the
  // worker's durable terminal receipt (or managed worker deletion) arrives.
  await hub.store.db.run("UPDATE deliveries SET status='cancelled' WHERE message_id=?", [attempt.inputMessageId]);
  await hub.dispatch.sweep();
  expect(await hub.dispatch.show(owner, ticket.id)).toMatchObject({ status: "queued", paused: true });
});

it("returns durable stop intent without waiting for a stalled RPC and preserves an already delivered result", async () => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  const attempt = ticket.attempts[0]!;
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [attempt.inputMessageId]);
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const stop = vi.spyOn(hub.dispatch.options, "stop").mockReturnValue(held);
  try {
    const result = await hub.dispatch.action("owner", ticket.id, { requestId: "pause", action: "pause" });
    expect(result.attempts[0]).toMatchObject({ stopRequested: "pause" });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await hub.dispatch.sweep(); await hub.dispatch.sweep();
    expect(stop).toHaveBeenCalledOnce();
    await hub.store.publishBotMessage(attempt.botId, { conversationId: attempt.conversationId, blocks: [{ type: "text", text: "Useful result sent just before the stop" }], replyTo: attempt.inputMessageId, status: "complete" });
    await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [attempt.inputMessageId]);
    await hub.dispatch.sweep();
    expect(await hub.dispatch.show(owner, ticket.id)).toMatchObject({ paused: true, result: "Useful result sent just before the stop" });
  } finally { release(); }
});

it("replays a dispatch receipt without preparing another worker", async () => {
  const input = { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" as const };
  const ticket = await hub.dispatch.dispatch(owner, "d", input);
  const prepare = vi.spyOn(hub.dispatch.workers!, "dispatchWorker").mockRejectedValue(new Error("worker_unavailable"));
  expect(await hub.dispatch.dispatch(owner, "d", input)).toEqual(ticket);
  expect(prepare).not.toHaveBeenCalled();
  await expect(hub.dispatch.dispatch(owner, "d", { requestId: "invalid", ticketId: (await create("r2")).id, engine: "claude", effort: "ultra" })).rejects.toThrow("dispatch_effort_incompatible");
  expect(prepare).not.toHaveBeenCalled();
});

it("does not settle a failed delivery while its reply is still live", async () => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  const attempt = ticket.attempts[0]!;
  const reply = await hub.store.publishBotMessage(attempt.botId, { conversationId: attempt.conversationId, blocks: [{ type: "text", text: "Still executing" }], replyTo: attempt.inputMessageId, status: "streaming" });
  await hub.store.db.run("UPDATE deliveries SET status='failed',dispatched=1 WHERE message_id=?", [attempt.inputMessageId]);
  await hub.dispatch.sweep();
  expect((await hub.dispatch.show(owner, ticket.id)).status).toBe("working");
  await hub.store.db.run("UPDATE messages SET status='error' WHERE id=?", [reply.id]);
  await hub.dispatch.sweep();
  expect((await hub.dispatch.show(owner, ticket.id)).status).toBe("blocked");
});

it("does not treat a routine claim as confirmation that a dispatched stop finished", async () => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  const attempt = ticket.attempts[0]!;
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [attempt.inputMessageId]);
  await hub.dispatch.action("owner", ticket.id, { requestId: "pause", action: "pause" });
  await new HubPromptQueue(hub.store).claim(attempt.botId, true, false);
  await hub.dispatch.sweep();
  expect((await hub.dispatch.show(owner, ticket.id)).status).toBe("working");
  expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [attempt.inputMessageId])).toEqual({ status: "pending" });
});

it("keeps a result completed before pause in review instead of re-queuing its work", async () => {
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex" });
  const attempt = ticket.attempts[0]!;
  await hub.store.publishBotMessage(attempt.botId, { conversationId: attempt.conversationId, blocks: [{ type: "text", text: "FULL RESULT" }], replyTo: attempt.inputMessageId, status: "complete" });
  await hub.store.db.run("UPDATE deliveries SET status='accepted',dispatched=1 WHERE message_id=?", [attempt.inputMessageId]);
  await hub.dispatch.action("owner", ticket.id, { requestId: "pause", action: "pause" });
  await hub.dispatch.sweep();
  expect(await hub.dispatch.show(owner, ticket.id)).toMatchObject({ status: "needs_review", paused: true, result: "FULL RESULT", attempts: [{ outcome: "completed" }] });
});

it.each(["before", "after"] as const)("clears stale engine health when a completed run settles %s pause", async timing => {
  await hub.dispatch.stop(); // Keep the completion/pause ordering deterministic.
  // This is a genuinely older failure; a later failure must survive this run.
  await hub.store.db.run("INSERT INTO engine_health(engine,state,until,reason,updated_at) VALUES('codex','cooldown',?,'previous failure',?)", [Date.now() + 60_000, Date.now() - 100]);
  const ticket = await hub.dispatch.dispatch(owner, "d", { requestId: "go", ticketId: (await create("r1")).id, engine: "codex", force: true });
  const attempt = ticket.attempts[0]!;
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [attempt.inputMessageId]);
  vi.spyOn(hub.dispatch.options, "stop").mockResolvedValue(undefined);
  if (timing === "after") await hub.dispatch.action("owner", ticket.id, { requestId: "pause", action: "pause" });
  const card = { type: "card" as const, elements: [], extra: { nativeRun: { version: 1, id: "done", revision: 1, phase: "done", startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false } } };
  await hub.store.publishBotMessage(attempt.botId, { conversationId: attempt.conversationId, replyTo: attempt.inputMessageId, status: "complete", blocks: [{ type: "text", text: "COMPLETED" }, card] });
  await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [attempt.inputMessageId]);
  if (timing === "before") await hub.dispatch.action("owner", ticket.id, { requestId: "pause", action: "pause" });
  await hub.dispatch.sweep();
  expect(await hub.dispatch.show(owner, ticket.id)).toMatchObject({ status: "needs_review", paused: true, attempts: [{ outcome: "completed" }] });
  expect((await hub.dispatch.list(owner, "d")).engines).toEqual([]);
  expect(await notices()).toEqual([]);
});


it("removes ended tickets from lists without erasing execution, files or idempotency", async () => {
  const created = await create("remove-create");
  const running = await hub.dispatch.dispatch(owner, "d", { requestId: "remove-dispatch", ticketId: created.id, engine: "codex" });
  await finish(running, "The retained result");
  const done = await hub.dispatch.action("owner", created.id, { requestId: "remove-accept", action: "accept" });
  const directory = path.join(root, "tickets", created.id); await mkdir(directory, { recursive: true });
  const file = path.join(directory, "result.md"); await writeFile(file, "The retained file");
  const beforeNotices = await notices();
  const input = { requestId: "remove-done", action: "remove" };
  expect(await hub.dispatch.action("owner", done.id, input)).toEqual(done);
  expect(await hub.dispatch.action("owner", done.id, input)).toEqual(done);
  expect(await hub.dispatch.action("owner", done.id, { ...input, requestId: "remove-again" })).toEqual(done);
  expect((await hub.dispatch.list(owner, "d")).tickets).toEqual([]);
  expect((await hub.dispatch.overview(owner, "d")).tickets).toEqual([]);
  expect((await hub.dispatch.list({ kind: "bot", botId: "d" }, "d")).tickets).toEqual([]);
  expect(await hub.dispatch.show(owner, done.id)).toEqual(done);
  expect(await create("remove-create")).toEqual(done);
  expect(await notices()).toEqual(beforeNotices);
  expect(await readFile(file, "utf8")).toBe("The retained file");
  expect(await hub.store.db.get("SELECT 1 FROM messages WHERE conversation_id=? AND blocks_json LIKE '%retained result%'", [running.attempts[0]!.conversationId])).toBeDefined();
  expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM dispatch_ticket_removals WHERE ticket_id=?", [done.id])).toEqual({ n: 1 });
  await expect(hub.dispatch.action("owner", done.id, { ...input, action: "cancel" })).rejects.toThrow("idempotency_conflict");
  await hub.close(); hub = await HubServer.start({ stateDir: root });
  expect((await hub.dispatch.overview(owner, "d")).tickets).toEqual([]);
  expect(await hub.dispatch.action("owner", done.id, input)).toEqual(done);
  expect(await hub.dispatch.show(owner, done.id)).toEqual(done);
});

it("removes only ended tickets and preserves cancellation until execution has stopped", async () => {
  const queued = await create("keep-queued");
  await expect(hub.dispatch.action("owner", queued.id, { requestId: "no-queued", action: "remove" })).rejects.toThrow("ticket_not_finished");
  const running = await hub.dispatch.dispatch(owner, "d", { requestId: "keep-running", ticketId: queued.id, engine: "codex" });
  await expect(hub.dispatch.action("owner", queued.id, { requestId: "no-running", action: "remove" })).rejects.toThrow("ticket_not_finished");
  await finish(running, "Ready for review");
  await expect(hub.dispatch.action("owner", queued.id, { requestId: "no-review", action: "remove" })).rejects.toThrow("ticket_not_finished");
  const cancelled = await hub.dispatch.action("owner", queued.id, { requestId: "cancel-finished", action: "cancel" });
  // Defensive fence for inconsistent/old records: terminal status is not alone proof that every attempt stopped.
  await hub.store.db.run("UPDATE dispatch_tickets SET attempts_json=? WHERE id=?", [JSON.stringify(cancelled.attempts.map(({ endedAt, ...attempt }) => attempt)), queued.id]);
  await expect(hub.dispatch.action("owner", queued.id, { requestId: "no-live-attempt", action: "remove" })).rejects.toThrow("ticket_stop_pending");
  await hub.store.db.run("UPDATE dispatch_tickets SET attempts_json=? WHERE id=?", [JSON.stringify(cancelled.attempts), queued.id]);
  await hub.dispatch.action("owner", queued.id, { requestId: "remove-cancelled", action: "remove" });
  const other = await create("untouched");
  const neverRun = await create("never-run");
  await hub.dispatch.action("owner", neverRun.id, { requestId: "cancel-never-run", action: "cancel" });
  await hub.dispatch.action("owner", neverRun.id, { requestId: "remove-never-run", action: "remove" });
  expect((await hub.dispatch.list(owner, "d")).tickets.map(ticket => ticket.id)).toEqual([other.id]);
  expect((await hub.dispatch.list(owner, "d", { open: true })).tickets.map(ticket => ticket.id)).toEqual([other.id]);
});

it("rechecks owner authority and the transaction guard before any removal or replay", async () => {
  const queued = await create("remove-auth");
  await hub.dispatch.action("owner", queued.id, { requestId: "remove-auth-cancel", action: "cancel" });
  const input = { requestId: "remove-auth-request", action: "remove" };
  await expect(hub.dispatch.action("stranger", queued.id, input)).rejects.toThrow();
  const deny = async () => { throw new Error("revoked_session"); };
  await expect(hub.dispatch.action("owner", queued.id, input, deny)).rejects.toThrow("revoked_session");
  expect((await hub.dispatch.list(owner, "d")).tickets).toHaveLength(1);
  await hub.dispatch.action("owner", queued.id, input);
  await expect(hub.dispatch.action("owner", queued.id, input, deny)).rejects.toThrow("revoked_session");
});


it("adds removal visibility to an existing schema 24 database without changing tickets", async () => {
  const ticket = await create("before-removal-upgrade");
  const schema = await hub.store.db.get("SELECT value FROM meta WHERE key='schema_version'");
  await hub.store.db.exec("DROP TABLE dispatch_ticket_removals");
  await hub.close(); hub = await HubServer.start({ stateDir: root });
  expect(await hub.store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual(schema);
  expect(await hub.dispatch.show(owner, ticket.id)).toEqual(ticket);
  expect((await hub.dispatch.list(owner, "d")).tickets).toEqual([ticket]);
  await hub.dispatch.action("owner", ticket.id, { requestId: "after-upgrade-cancel", action: "cancel" });
  await hub.dispatch.action("owner", ticket.id, { requestId: "after-upgrade-remove", action: "remove" });
  expect((await hub.dispatch.overview(owner, "d")).tickets).toEqual([]);
});
