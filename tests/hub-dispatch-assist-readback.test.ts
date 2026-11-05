import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import type { DispatchWorkers } from "../src/hub/dispatch.js";
import type { DispatchTicket, TicketAttempt } from "../src/client-protocol/dispatch.js";

let root: string, hub: HubServer;
const owner = { kind: "owner" as const, userId: "owner" };
const engines = ["codex", "claude", "kimi", "deepseek", "antigravity"] as const;
const workers: DispatchWorkers = {
  catalog: async () => ({ engines: engines.map(id => ({ id, available: true, models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" })) }),
  dispatchWorker: async (_d, engine) => `w_${engine}`, ticketWorkspace: async (_d, ticketId) => path.join(root, "tickets", ticketId),
};
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-assist-readback-"));
  hub = await HubServer.start({ stateDir: root });
  await hub.dispatch.stop(); // Each case drives settlement explicitly.
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('d','Dispatcher','fixture','claude','','','dispatcher'),('d2','Other','fixture','claude','','','dispatcher')");
  for (const engine of ["codex", "claude"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES(?,?,?,?,?,?,'worker')", [`w_${engine}`, `w ${engine}`, "fixture", engine, "", ""]);
  hub.dispatch.workers = workers;
  await hub.store.createConversation("owner", ["d"], "Dispatcher", "home");
  await hub.store.createConversation("owner", ["d2"], "Other", "home2");
  const old = await hub.dispatch.settings("owner", "d");
  await hub.dispatch.updateSettings("owner", "d", { settings: { mode: "auto", maxConcurrent: 1 }, expectedRevision: old.revision });
});
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

const run = { version: 1, id: "run", revision: 1, phase: "done", startedAt: 1, updatedAt: 1, count: 0, completed: 0, failed: 0, truncated: false };
async function dispatch(requestId: string) {
  const ticket = await hub.dispatch.create(owner, "d", { requestId: `c_${requestId}`, title: requestId, request: "Original request" });
  return hub.dispatch.dispatch(owner, "d", { requestId, ticketId: ticket.id, engine: "codex", model: "gpt-x", effort: "high", assist: 2 });
}
const take = (a: TicketAttempt) => hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [a.inputMessageId, a.botId]);
const ask = (a: TicketAttempt) => hub.dispatch.requestAssist({ kind: "bot", botId: a.botId, contextMessage: a.inputMessageId }, { requestId: `help_${a.id}`, engine: "claude", text: "Review it", note: "Second view" });
async function complete(a: TicketAttempt, text: string, sweep = true) {
  await hub.store.publishBotMessage(a.botId, { conversationId: a.conversationId, replyTo: a.inputMessageId, status: "complete", blocks: [{ type: "text", text }, { type: "card", elements: [], extra: { nativeRun: run } }] });
  await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [a.inputMessageId, a.botId]);
  if (sweep) await hub.dispatch.sweep();
}
const show = (t: DispatchTicket) => hub.dispatch.show(owner, t.id);
const until = (t: DispatchTicket, n: number) => vi.waitFor(async () => expect((await show(t)).attempts).toHaveLength(n));
const readback = async (t: DispatchTicket) => (await hub.dispatch.assists(owner, t.id)).assists;
/** Parent requests help and yields; the helper is the ticket's current attempt. */
async function helperRunning(id: string) {
  const ticket = await dispatch(id), parent = ticket.attempts[0]!;
  await take(parent); await ask(parent); await complete(parent, "Checkpoint"); await until(ticket, 2);
  return { ticket, parent, helper: (await show(ticket)).attempts[1]! };
}

it("shows a completed helper's bounded answer even when a late pause recorded the request cancelled", async () => {
  const { ticket, helper } = await helperRunning("f2");
  expect((await readback(ticket))[0]).toMatchObject({ helper: { attemptId: helper.id, state: "running" } });
  await take(helper); await complete(helper, "HELPER ANSWER", false);
  await hub.dispatch.action("owner", ticket.id, { requestId: "pause", action: "pause" });
  const [row] = await readback(ticket);
  expect(row).toMatchObject({ state: "cancelled", helper: { attemptId: helper.id, state: "completed", result: expect.stringContaining("HELPER ANSWER"), resultTruncated: false } });
  expect(row).not.toHaveProperty("continuation");
});

it("reports a continuation the Hub queued, cancelled undelivered, or saw accepted, without claiming the parent used it", async () => {
  // The first ticket keeps its slot while its stop is pending.
  const old = await hub.dispatch.settings("owner", "d");
  await hub.dispatch.updateSettings("owner", "d", { settings: { mode: "auto", maxConcurrent: 2 }, expectedRevision: old.revision });
  const { ticket, helper } = await helperRunning("f3");
  await take(helper); await complete(helper, "HELPER ANSWER");
  const continuation = (await show(ticket)).attempts[2]!;
  expect((await readback(ticket))[0]).toMatchObject({ state: "returned", helper: { state: "completed" }, continuation: { attemptId: continuation.id, delivery: "queued" } });
  await take(continuation);
  expect((await readback(ticket))[0]).toMatchObject({ continuation: { delivery: "in_progress" } });
  await hub.dispatch.action("owner", ticket.id, { requestId: "pause", action: "pause" });
  // The live turn keeps its delivery until execution settles; a still-queued one is cancelled.
  expect((await readback(ticket))[0]).toMatchObject({ continuation: { delivery: "in_progress" } });
  const other = await helperRunning("f3b");
  await take(other.helper); await complete(other.helper, "OTHER ANSWER");
  await hub.dispatch.action("owner", other.ticket.id, { requestId: "pause-other", action: "pause" });
  expect((await readback(other.ticket))[0]).toMatchObject({ state: "returned", continuation: { delivery: "cancelled", outcome: "cancelled" } });
});

it("marks an accepted continuation only as accepted, with the parent's settled outcome", async () => {
  const { ticket, helper } = await helperRunning("ok");
  await take(helper); await complete(helper, "HELPER ANSWER");
  const continuation = (await show(ticket)).attempts[2]!;
  await take(continuation); await complete(continuation, "FINAL");
  expect((await readback(ticket))[0]).toMatchObject({ continuation: { attemptId: continuation.id, delivery: "accepted", outcome: "completed" } });
});

it("bounds helper results to the newest rows and characters, and stays far below the CLI reply limit", async () => {
  const { ticket, helper } = await helperRunning("bounds");
  await take(helper); await complete(helper, `${"前".repeat(5000)}END`);
  const base = (await hub.store.db.get<Record<string, unknown>>("SELECT * FROM dispatch_assists WHERE ticket_id=?", [ticket.id]))!;
  await hub.store.db.transaction(async () => {
    for (let i = 0; i < 70; i++) await hub.store.db.run(`INSERT INTO dispatch_assists(id,ticket_id,worker_bot_id,request_id,payload_hash,parent_attempt_id,parent_json,engine,model,effort,text,note,state,child_attempt_id,outcome,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'returned',?,'completed',?,?)`, [`as_extra_${String(i).padStart(2, "0")}`, ticket.id, base.worker_bot_id, `r${i}`, "h", base.parent_attempt_id, base.parent_json, "claude", "", "",
      "长".repeat(12_000), "因".repeat(600), helper.id, Number(base.created_at) + 1 + i, Number(base.created_at) + 1 + i]);
  });
  const read = await hub.dispatch.assists(owner, ticket.id);
  expect(read).toMatchObject({ truncated: true });
  expect(read.assists).toHaveLength(64);
  const withResult = read.assists.filter(row => row.helper?.result !== undefined);
  expect(withResult.map(row => row.id)).toEqual(read.assists.slice(-8).map(row => row.id)); // newest eight only
  for (const row of withResult) expect(row.helper).toMatchObject({ resultTruncated: true, result: expect.stringMatching(/END$/) });
  expect(Math.max(...withResult.map(row => row.helper!.result!.length))).toBeLessThanOrEqual(800);
  expect(read.assists.every(row => row.helper?.state === "completed")).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThan(4 * 1024 * 1024); // CLI reply cap is 8 MiB
});

it("keeps the readback private and honest about trimmed history", async () => {
  const { ticket } = await helperRunning("scope");
  await expect(hub.dispatch.assists({ kind: "bot", botId: "d2" }, ticket.id)).rejects.toThrow("dispatcher_forbidden");
  await hub.store.db.run("UPDATE dispatch_assists SET child_attempt_id='ta_trimmed',continuation_attempt_id='ta_gone' WHERE ticket_id=?", [ticket.id]);
  expect((await readback(ticket))[0]).toMatchObject({ helper: { attemptId: "ta_trimmed", state: "unavailable" }, continuation: { attemptId: "ta_gone", delivery: "unavailable" } });
});
