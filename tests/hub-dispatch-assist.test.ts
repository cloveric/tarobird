import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { HubError } from "../src/hub/errors.js";
import { hashSecret } from "../src/hub/auth.js";
import type { DispatchWorkers } from "../src/hub/dispatch.js";
import { dispatchTicketSchema, type DispatchTicket, type TicketAttempt } from "../src/client-protocol/dispatch.js";
import type { Conversation } from "../src/client-protocol/index.js";

let root: string, hub: HubServer, home: Conversation;
const owner = { kind: "owner" as const, userId: "owner" };
const secret = "assist-worker-secret-".repeat(3);
const engines = ["codex", "claude", "kimi", "deepseek", "antigravity"] as const;
const workers = (dispatchWorker: DispatchWorkers["dispatchWorker"] = async (_dispatcher, engine) => `w_${engine}`): DispatchWorkers => ({
  catalog: async () => ({ engines: engines.map(id => ({ id, available: true, models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" })) }),
  dispatchWorker, ticketWorkspace: async (_dispatcher, ticketId) => path.join(root, "tickets", ticketId),
});
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-dispatch-assist-"));
  hub = await HubServer.start({ stateDir: root });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('d','Dispatcher','fixture','claude','','','dispatcher')");
  for (const engine of ["codex", "claude", "kimi"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES(?,?,?,?,?,?,'worker')", [`w_${engine}`, `Dispatcher · ${engine}`, hashSecret(secret), engine, "", ""]);
  hub.dispatch.workers = workers();
  home = await hub.store.createConversation("owner", ["d"], "Dispatcher", "home");
  await settings({ mode: "auto", maxConcurrent: 1 });
});
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

async function settings(next: Record<string, unknown>) {
  const old = await hub.dispatch.settings("owner", "d");
  await hub.dispatch.updateSettings("owner", "d", { settings: next, expectedRevision: old.revision });
}
async function dispatch(requestId: string, options: Record<string, unknown> = {}) {
  const ticket = await hub.dispatch.create(owner, "d", { requestId: `c_${requestId}`, title: `Task ${requestId}`, request: "Write the report" });
  return hub.dispatch.dispatch(owner, "d", { requestId, ticketId: ticket.id, engine: "codex", model: "gpt-x", effort: "high", ...options });
}
/** The worker took the input: its turn is active. */
const take = (attempt: TicketAttempt) => hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [attempt.inputMessageId, attempt.botId]);
const as = (attempt: TicketAttempt) => ({ kind: "bot" as const, botId: attempt.botId, contextMessage: attempt.inputMessageId });
const ask = (attempt: TicketAttempt, data: Record<string, unknown> = {}) => hub.dispatch.requestAssist(as(attempt), { requestId: "help", engine: "claude", model: "opus", effort: "medium", text: "Review section 2", note: "Independent review", ...data });
async function finish(attempt: TicketAttempt, text: string, status: "complete" | "error" = "complete") {
  await hub.store.publishBotMessage(attempt.botId, { conversationId: attempt.conversationId, blocks: [{ type: "text", text }], replyTo: attempt.inputMessageId, status });
  await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [attempt.inputMessageId, attempt.botId]);
  await hub.dispatch.sweep();
}
const show = (ticket: DispatchTicket) => hub.dispatch.show(owner, ticket.id);
const notices = async () => (await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? ORDER BY created_at,rowid", [home.id])).map(row => row.blocks_json);
const input = (attempt: TicketAttempt) => hub.store.db.get<{ blocks_json: string; bot_source_json: string }>("SELECT blocks_json,bot_source_json FROM messages WHERE id=?", [attempt.inputMessageId]);
const ledger = (ticket: DispatchTicket) => hub.dispatch.assists(owner, ticket.id);
/** Helper launches run outside settlement. */
const until = (ticket: DispatchTicket, attempts: number) => vi.waitFor(async () => expect((await show(ticket)).attempts).toHaveLength(attempts));
const gate = () => { let release!: () => void; const opened = new Promise<void>(resolve => { release = resolve; }); return { opened, release }; };

it("accepts a request only from the worker's exact active ticket turn", async () => {
  await settings({ mode: "auto", maxConcurrent: 2, allowedEngines: ["codex", "claude"] });
  const ticket = await dispatch("go"), parent = ticket.attempts[0]!;
  await expect(hub.dispatch.requestAssist({ kind: "bot", botId: "d", contextMessage: parent.inputMessageId }, {})).rejects.toThrow();
  await expect(ask({ ...parent, botId: "d" })).rejects.toThrow("dispatch_worker_required");
  await expect(hub.dispatch.requestAssist({ kind: "bot", botId: "w_codex" }, { requestId: "x", engine: "claude", text: "t", note: "n" })).rejects.toThrow("dispatch_context_not_active");
  await expect(ask(parent)).rejects.toThrow("dispatch_context_not_active"); // Not yet taken by the worker.
  await take(parent);
  await expect(ask({ ...parent, botId: "w_kimi" })).rejects.toThrow("dispatch_context_not_active");
  // One worker Bot serves every ticket: another ticket's turn never reaches this one.
  const other = await dispatch("other"); await take(other.attempts[0]!);
  const otherReceipt = await ask(other.attempts[0]!, { requestId: "other-help" });
  expect(otherReceipt.ticketId).toBe(other.id);
  await expect(ask(parent, { effort: "max" })).rejects.toThrow("dispatch_assist_effort_requires_owner");
  await expect(ask(parent, { effort: "ultra" })).rejects.toThrow("dispatch_assist_effort_requires_owner");
  await expect(ask(parent, { engine: "kimi", model: undefined, effort: undefined })).rejects.toThrow("dispatch_engine_not_allowed");
  await hub.store.db.run("INSERT INTO engine_health VALUES('claude','cooldown',?,?,?)", [Date.now() + 60_000, "engine-quota", Date.now()]);
  await expect(ask(parent)).rejects.toThrow("engine_unavailable:claude:cooldown");
  await hub.dispatch.resetEngine("owner", "claude");
  const receipt = await ask(parent);
  expect(receipt).toMatchObject({ ticketId: ticket.id, state: "requested", remaining: 0, duplicate: false });
  expect(receipt.next).toContain("结束本轮");
  // Same request ID: the same receipt; another ID in the same turn: the recorded request.
  expect(await ask(parent)).toMatchObject({ assistId: receipt.assistId, duplicate: true });
  expect(await ask(parent, { requestId: "again" })).toMatchObject({ assistId: receipt.assistId, duplicate: true });
  // A different task is never acknowledged as the pending one.
  await expect(ask(parent, { requestId: "different", text: "Other text" })).rejects.toThrow("dispatch_assist_pending");
  await expect(ask(parent, { text: "Changed" })).rejects.toThrow("idempotency_conflict");
  expect(await hub.dispatch.assistStatus(as(parent))).toMatchObject({ ticketId: ticket.id, remaining: 0, helper: false, request: { id: receipt.assistId, state: "requested", engine: "claude" } });
  expect((await hub.dispatch.workerTargets(as(parent))).targets.map(t => [t.engine, t.allowed])).toContainEqual(["kimi", false]);
  await expect(hub.dispatch.workerTargets({ ...as(parent), botId: "w_claude" })).rejects.toThrow("dispatch_context_not_active");
  // The same request ID in another ticket's turn is a conflict, never that ticket's receipt.
  await expect(ask(other.attempts[0]!)).rejects.toThrow("idempotency_conflict");
  // A paused ticket's turn can no longer request or read.
  await hub.dispatch.action("owner", ticket.id, { requestId: "pause", action: "pause" });
  await expect(ask(parent, { requestId: "late" })).rejects.toThrow("dispatch_assist_stale");
  expect((await ledger(ticket)).assists).toMatchObject([{ id: receipt.assistId, state: "cancelled" }]);
});

it("defaults to one helper in auto mode and none in ask mode unless the dispatch states an allowance", async () => {
  const auto = await dispatch("auto"); await take(auto.attempts[0]!);
  expect(await ask(auto.attempts[0]!)).toMatchObject({ remaining: 0 });
  await settings({ mode: "ask", maxConcurrent: 3 });
  const none = await dispatch("ask"); await take(none.attempts[0]!);
  await expect(ask(none.attempts[0]!, { requestId: "ask-help" })).rejects.toThrow("dispatch_assist_limit");
  const confirmed = await dispatch("ask2", { assist: 2 }); await take(confirmed.attempts[0]!);
  // The owner confirmed this allowance with the plan; no second approval mechanism.
  expect(await ask(confirmed.attempts[0]!, { requestId: "ask2-help" })).toMatchObject({ state: "requested", remaining: 1 });
  expect(await hub.dispatch.assists(owner, confirmed.id)).toMatchObject({ remaining: 1 });
  // A ticket dispatched before schema 24 was never granted help; auto mode now does not grant it.
  await settings({ mode: "auto", maxConcurrent: 3 });
  await hub.store.db.run("DELETE FROM dispatch_assist_windows WHERE ticket_id=?", [none.id]);
  await expect(ask(none.attempts[0]!, { requestId: "late-grant" })).rejects.toThrow("dispatch_assist_limit");
  expect(await hub.dispatch.assistStatus(as(none.attempts[0]!))).toMatchObject({ remaining: 0 });
});

it("runs the helper in the parent's slot and returns its answer to the parent's own session", async () => {
  const ticket = await dispatch("go", { assist: 2 }), parent = ticket.attempts[0]!;
  await take(parent);
  const receipt = await ask(parent);
  await hub.dispatch.sweep();
  expect((await show(ticket)).attempts).toHaveLength(1); // The parent still owns its turn.
  await finish(parent, "Checkpoint: waiting for review."); await until(ticket, 2);
  let current = await show(ticket);
  const helper = current.attempts[1]!;
  expect(current).toMatchObject({ status: "working", attempts: [{ id: parent.id, outcome: "completed" }, { botId: "w_claude", engine: "claude", model: "opus", effort: "medium" }] });
  expect(helper.conversationId).not.toBe(parent.conversationId);
  const marker = (await hub.store.conversations("owner")).find(c => c.id === helper.conversationId)!;
  expect(marker).toMatchObject({ hidden: true, ticket: { id: ticket.id, model: "opus", effort: "medium", workspace: path.join(root, "tickets", ticket.id) } });
  const sent = (await input(helper))!;
  expect(sent.blocks_json).toContain("【协助请求】");
  expect(sent.blocks_json).toContain("Review section 2");
  expect(JSON.parse(sent.bot_source_json)).toMatchObject({ botId: "w_codex", requestId: helper.id, hops: 2 });
  expect(await notices()).toEqual([]); // The dispatcher is not woken for routine help.
  // One slot: the helper does not take another, and nothing bypasses the limit.
  await expect(dispatch("other")).rejects.toThrow("dispatch_concurrency_limit");
  // A helper never requests help itself.
  await take(helper);
  await expect(hub.dispatch.requestAssist(as(helper), { requestId: "nested", engine: "kimi", text: "t", note: "n" })).rejects.toThrow("dispatch_assist_nested");
  expect(await hub.dispatch.assistStatus(as(helper))).toMatchObject({ helper: true, remaining: 0 });
  await finish(helper, "HELPER: section 2 is fine.");
  current = await show(ticket);
  const continuation = current.attempts[2]!;
  expect(current.status).toBe("working");
  expect(continuation).toMatchObject({ botId: "w_codex", engine: "codex", model: "gpt-x", effort: "high", conversationId: parent.conversationId });
  expect((await input(continuation))!.blocks_json).toContain("【协助结果】");
  expect((await input(continuation))!.blocks_json).toContain("HELPER: section 2 is fine.");
  expect(current.result).toBeUndefined();
  expect(await notices()).toEqual([]);
  expect((await ledger(ticket)).assists).toMatchObject([{ id: receipt.assistId, state: "returned", outcome: "completed", childAttemptId: helper.id, continuationAttemptId: continuation.id }]);
  await finish(continuation, "FINAL report.");
  current = await show(ticket);
  expect(current).toMatchObject({ status: "needs_review", result: "FINAL report." });
  expect(dispatchTicketSchema.parse(current)).toEqual(current); // Attempts keep their strict shape.
  const [done] = await notices();
  expect(done).toContain("【工单完成】");
  expect(done).toContain("执行中协助：Claude（opus · medium）已完成");
  // A later dispatch with the parent's settings continues its session, never the helper's.
  const again = await hub.dispatch.dispatch(owner, "d", { requestId: "again", ticketId: ticket.id, engine: "codex", model: "gpt-x", effort: "high" });
  expect(again.attempts.at(-1)!.conversationId).toBe(parent.conversationId);
});

it("does not start a helper after the parent is paused, and resumes the parent's session", async () => {
  const ticket = await dispatch("go"), parent = ticket.attempts[0]!;
  await take(parent); await ask(parent);
  expect(await hub.dispatch.action("owner", ticket.id, { requestId: "pause", action: "pause" })).toMatchObject({ status: "working", paused: true });
  await finish(parent, "Checkpoint");
  const paused = await show(ticket);
  // Without completed-run evidence a stopped turn records cancelled (existing rule).
  expect(paused).toMatchObject({ status: "queued", paused: true, attempts: [{ stopRequested: "pause" }] });
  expect(await notices()).toEqual([]); // Not reported as completed.
  expect((await ledger(ticket)).assists).toMatchObject([{ state: "cancelled" }]);
  await hub.dispatch.sweep(); expect((await show(ticket)).attempts).toHaveLength(1);
  await hub.dispatch.action("owner", ticket.id, { requestId: "resume", action: "resume" });
  const resumed = await hub.dispatch.dispatch(owner, "d", { requestId: "redo", ticketId: ticket.id, engine: "codex", model: "gpt-x", effort: "high" });
  expect(resumed.attempts.at(-1)!.conversationId).toBe(parent.conversationId);
});

it.each(["pause", "cancel"] as const)("a %s during the helper ends it without a continuation or a reported result", async action => {
  const ticket = await dispatch("go"), parent = ticket.attempts[0]!;
  await take(parent); await ask(parent); await finish(parent, "Checkpoint"); await until(ticket, 2);
  const helper = (await show(ticket)).attempts[1]!;
  await take(helper);
  const stopping = await hub.dispatch.action("owner", ticket.id, { requestId: action, action });
  expect(stopping.attempts.at(-1)).toMatchObject({ id: helper.id, stopRequested: action });
  await finish(helper, "HELPER partial answer");
  const settled = await show(ticket);
  expect(settled).toMatchObject({ status: action === "cancel" ? "cancelled" : "queued", paused: action === "pause" });
  expect(settled.attempts).toHaveLength(2);
  expect(settled.result ?? "").not.toContain("HELPER");
  expect((await ledger(ticket)).assists).toMatchObject([{ state: "cancelled" }]);
  expect(await notices()).toEqual([]);
  if (action === "pause") {
    await hub.dispatch.action("owner", ticket.id, { requestId: "resume", action: "resume" });
    const resumed = await hub.dispatch.dispatch(owner, "d", { requestId: "redo", ticketId: ticket.id, engine: "codex", model: "gpt-x", effort: "high" });
    expect(resumed.attempts.at(-1)!.conversationId).toBe(parent.conversationId);
  }
});

it("retries a helper start interrupted between the parent's yield and a Host restart, exactly once", async () => {
  hub.dispatch.workers = workers(async (_d, engine) => { if (engine === "claude") throw new HubError("hub_draining", 503); return `w_${engine}`; });
  const ticket = await dispatch("go"), parent = ticket.attempts[0]!;
  await take(parent); await ask(parent); await finish(parent, "Checkpoint");
  expect(await show(ticket)).toMatchObject({ status: "working", attempts: [{ outcome: "completed" }] });
  expect((await ledger(ticket)).assists).toMatchObject([{ state: "starting" }]);
  await hub.close();
  hub = await HubServer.start({ stateDir: root });
  hub.dispatch.workers = workers();
  await hub.dispatch.sweep(); await until(ticket, 2); await hub.dispatch.sweep(); await hub.dispatch.stop();
  const current = await show(ticket);
  expect(current.attempts.map(a => a.botId)).toEqual(["w_codex", "w_claude"]);
  expect((await ledger(ticket)).assists).toMatchObject([{ state: "running", childAttemptId: current.attempts[1]!.id }]);
  expect(await hub.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE json_extract(ticket_json,'$.id')=?", [ticket.id])).toEqual({ n: 2 });
});

it("returns an unavailable helper target to the parent instead of failing the ticket", async () => {
  hub.dispatch.workers = workers(async (_d, engine) => { if (engine === "claude") throw new HubError("bot_engine_unavailable", 409); return `w_${engine}`; });
  const ticket = await dispatch("go"), parent = ticket.attempts[0]!;
  await take(parent); await ask(parent); await finish(parent, "Checkpoint"); await until(ticket, 2);
  const current = await show(ticket);
  expect(current).toMatchObject({ status: "working", attempts: [{ outcome: "completed" }, { botId: "w_codex", conversationId: parent.conversationId }] });
  expect((await input(current.attempts[1]!))!.blocks_json).toContain("未能启动：bot_engine_unavailable");
  expect((await input(current.attempts[1]!))!.blocks_json).toContain("协助次数已用完");
  expect((await input(current.attempts[1]!))!.blocks_json).not.toContain("可在剩余次数内");
  expect((await ledger(ticket)).assists).toMatchObject([{ state: "returned", outcome: "unstarted" }]);
  expect(await notices()).toEqual([]);
});

it("settles a parent that failed after requesting help without starting it", async () => {
  const ticket = await dispatch("go"), parent = ticket.attempts[0]!;
  await take(parent); await ask(parent); await finish(parent, "Crashed", "error");
  expect(await show(ticket)).toMatchObject({ status: "blocked", attempts: [{ outcome: "failed" }] });
  expect((await ledger(ticket)).assists).toMatchObject([{ state: "cancelled" }]);
  expect((await notices())[0]).toContain("执行者请求的协助未执行");
});

it("reports a helper's engine failure to the parent and marks the engine, without a reassignment notice", async () => {
  await settings({ mode: "auto", maxConcurrent: 1 });
  const ticket = await dispatch("go"), parent = ticket.attempts[0]!;
  await take(parent); await ask(parent, { engine: "kimi", model: undefined, effort: undefined }); await finish(parent, "Checkpoint"); await until(ticket, 2);
  const helper = (await show(ticket)).attempts[1]!;
  await finish(helper, "错误：Kimi 当前 5 小时使用额度已用完。请等待额度窗口重置，或购买额外额度/升级套餐；重新登录或重启都无效。 重置信息：resets in 2h。", "error");
  const current = await show(ticket);
  expect(current).toMatchObject({ status: "working", attempts: [{}, { outcome: "failed", failure: { category: "engine-quota" } }, { botId: "w_codex" }] });
  expect((await input(current.attempts[2]!))!.blocks_json).toContain("没有完成");
  expect((await hub.dispatch.list(owner, "d")).engines).toMatchObject([{ engine: "kimi", state: "cooldown" }]);
  expect(await notices()).toEqual([]);
});

it("limits a worker's instance route to its own turn's targets, capabilities and assistance", async () => {
  const ticket = await dispatch("go"), parent = ticket.attempts[0]!;
  await take(parent);
  const call = async (operation: string, data: Record<string, unknown> = {}, botId = "w_codex") => {
    const response = await fetch(hub.instanceUrl + "/api/instance/tickets", { method: "POST", headers: { Authorization: `Instance ${botId}:${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation, contextMessage: parent.inputMessageId, data }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  for (const operation of ["list", "show", "create", "dispatch", "update", "assists"]) expect(await call(operation, { ticketId: ticket.id })).toMatchObject({ status: 403, body: { error: "dispatch_worker_forbidden" } });
  expect(await call("targets")).toMatchObject({ status: 200 });
  expect(await call("assist-status")).toMatchObject({ status: 200, body: { ticketId: ticket.id, remaining: 1, helper: false } });
  expect(await call("assist", { requestId: "help", engine: "claude", text: "Review", note: "Second view" })).toMatchObject({ status: 200, body: { state: "requested", remaining: 0 } });
  expect(await call("assist-status", {}, "w_claude")).toMatchObject({ status: 403, body: { error: "dispatch_context_not_active" } });
});

it("a slow helper launch neither holds other tickets' settlement nor queues after a stop", async () => {
  await settings({ mode: "auto", maxConcurrent: 2 });
  const launch = gate();
  hub.dispatch.workers = workers(async (_d, engine) => { if (engine === "claude") await launch.opened; return `w_${engine}`; });
  const slow = await dispatch("slow"), parent = slow.attempts[0]!, other = await dispatch("other");
  await take(parent); await ask(parent); await finish(parent, "Checkpoint");
  await finish(other.attempts[0]!, "Other done.");
  expect(await show(other)).toMatchObject({ status: "needs_review" });
  expect((await show(slow)).attempts).toHaveLength(1);
  // The launch returns only after the stop began: it queues nothing.
  const stopping = hub.dispatch.stop(); launch.release(); await stopping;
  expect((await show(slow)).attempts).toHaveLength(1);
  expect((await ledger(slow)).assists).toMatchObject([{ state: "starting" }]);
  await hub.close();
  hub = await HubServer.start({ stateDir: root });
  hub.dispatch.workers = workers();
  await hub.dispatch.sweep(); await until(slow, 2);
  expect((await show(slow)).attempts.map(a => a.botId)).toEqual(["w_codex", "w_claude"]);
});

it("never launches a helper for a dispatcher deleted while it was starting", async () => {
  await hub.store.db.run("INSERT INTO managed_bots VALUES('d','owner','create-d','{}')");
  hub.dispatch.workers = workers(async (_d, engine) => {
    // The owner's real delete path (managed Bot tombstone) while the helper's Bot launches.
    if (engine === "claude") await hub.store.deleteBot("owner", "d", "Dispatcher");
    return `w_${engine}`;
  });
  const ticket = await dispatch("go"), parent = ticket.attempts[0]!;
  await take(parent); await ask(parent); await finish(parent, "Checkpoint");
  // Owner reads reject a deleted dispatcher; inspect the ledger rows.
  const row = () => hub.store.db.get<{ status: string; attempts_json: string }>("SELECT status,attempts_json FROM dispatch_tickets WHERE id=?", [ticket.id]);
  await vi.waitFor(async () => { await hub.dispatch.sweep(); expect((await row())!.status).toBe("cancelled"); });
  await hub.dispatch.stop();
  expect(JSON.parse((await row())!.attempts_json)).toHaveLength(1);
  expect(await hub.store.db.all("SELECT state FROM dispatch_assists WHERE ticket_id=?", [ticket.id])).toEqual([{ state: "cancelled" }]);
  expect(await hub.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE json_extract(ticket_json,'$.id')=?", [ticket.id])).toEqual({ n: 1 });
});

it("an owner cancel during a slow helper launch leaves no helper and frees the slot", async () => {
  const launch = gate();
  hub.dispatch.workers = workers(async (_d, engine) => { if (engine === "claude") await launch.opened; return `w_${engine}`; });
  const ticket = await dispatch("go"), parent = ticket.attempts[0]!;
  await take(parent); await ask(parent); await finish(parent, "Checkpoint");
  expect(await hub.dispatch.action("owner", ticket.id, { requestId: "cancel", action: "cancel" })).toMatchObject({ status: "cancelled" });
  launch.release();
  await hub.dispatch.sweep(); await hub.dispatch.stop();
  expect((await show(ticket)).attempts).toHaveLength(1);
  expect((await ledger(ticket)).assists).toMatchObject([{ state: "cancelled" }]);
  expect((await dispatch("next")).status).toBe("working"); // The slot is free again.
});

it("never reports a help-requesting parent's checkpoint as reviewable when a pause lands after its turn finished", async () => {
  const ticket = await dispatch("go"), parent = ticket.attempts[0]!;
  await take(parent); await ask(parent);
  await hub.dispatch.action("owner", ticket.id, { requestId: "pause", action: "pause" });
  // The engine had already finished (completed-run evidence), so the stop did not interrupt it.
  const run = { version: 1, id: "run", revision: 1, phase: "done", startedAt: 1, updatedAt: 1, count: 0, completed: 0, failed: 0, truncated: false };
  await hub.store.publishBotMessage(parent.botId, { conversationId: parent.conversationId, replyTo: parent.inputMessageId, status: "complete", blocks: [{ type: "text", text: "Checkpoint: waiting for help." }, { type: "card", elements: [], extra: { nativeRun: run } }] });
  await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [parent.inputMessageId, parent.botId]);
  await hub.dispatch.sweep();
  const paused = await show(ticket);
  expect(paused).toMatchObject({ status: "queued", paused: true, attempts: [{ outcome: "completed" }] });
  expect(paused.result ?? "").not.toContain("Checkpoint");
  expect((await ledger(ticket)).assists).toMatchObject([{ state: "cancelled" }]);
  expect(await notices()).toEqual([]);
});
