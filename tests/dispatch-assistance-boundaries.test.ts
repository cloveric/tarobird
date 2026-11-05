import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";

let hub: HubServer, root: string;
const owner = { kind: "owner" as const, userId: "owner" }, secret = "assistance-boundary-".repeat(4);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "assist-boundary-")); hub = await HubServer.start({ stateDir: root });
  await hub.dispatch.stop(); // The test controls each terminal transition.
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('d','Dispatcher','fixture','codex','dispatcher'),('w','Worker',?,'codex','worker')", [hashSecret(secret)]);
  await hub.store.db.run("INSERT INTO dispatch_workers VALUES('d','codex','w')");
  await hub.store.createConversation("owner", ["d"], "Home", "home");
  const read = await hub.dispatch.settings("owner", "d");
  await hub.dispatch.updateSettings("owner", "d", { expectedRevision: read.revision, settings: { mode: "auto", maxConcurrent: 3 } });
  hub.dispatch.workers = { catalog: async () => ({ engines: [] }), dispatchWorker: async () => "w", ticketWorkspace: async () => root };
});
afterEach(async () => { vi.restoreAllMocks(); await hub.close(); await rm(root, { recursive: true, force: true }); });
async function active(id: string) {
  const ticket = await hub.dispatch.create(owner, "d", { requestId: "create-" + id, title: id, request: id });
  const running = await hub.dispatch.dispatch(owner, "d", { requestId: "dispatch-" + id, ticketId: ticket.id, engine: "codex", assist: 1 });
  const context = running.attempts[0]!.inputMessageId;
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [context]);
  return { ticketId: ticket.id, context };
}
const data = { requestId: "stable-request", engine: "claude", text: "Check a boundary", note: "Independent review" };
async function assist(context: string, value: unknown = data) {
  const response = await fetch(hub.instanceUrl + "/api/instance/tickets", { method: "POST", headers: { Authorization: `Instance w:${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation: "assist", contextMessage: context, data: value }) });
  return { status: response.status, body: await response.json() };
}
it("does not reuse a receipt from another active ticket on the same worker", async () => {
  const one = await active("one"), two = await active("two");
  const first = await assist(one.context); expect(first.status).toBe(200);
  const retry = await assist(one.context); expect(retry).toMatchObject({ status: 200, body: { assistId: first.body.assistId, duplicate: true, remaining: 0 } });
  expect((await assist(two.context)).status).toBe(409);
  expect(await hub.store.db.all("SELECT ticket_id FROM dispatch_assists")).toEqual([{ ticket_id: one.ticketId }]);
});
it("does not acknowledge a different helper task as the already pending one", async () => {
  const one = await active("one"); expect((await assist(one.context)).status).toBe(200);
  expect((await assist(one.context, { ...data, requestId: "new-request", engine: "deepseek", text: "A different task" })).status).toBe(409);
  expect((await hub.store.db.all("SELECT id FROM dispatch_assists"))).toHaveLength(1);
});
it("does not grant an old schema-23 dispatch assistance merely because settings are now auto", async () => {
  const one = await active("old-dispatch");
  await hub.store.db.run("DELETE FROM dispatch_assist_windows WHERE ticket_id=?", [one.ticketId]);
  expect((await assist(one.context)).status).toBe(409);
  expect((await hub.store.db.all("SELECT id FROM dispatch_assists"))).toHaveLength(0);
});

it("keeps the latest assistance visible when an old ticket exceeds the bounded history window", async () => {
  const one = await active("history"); await assist(one.context);
  await hub.store.db.transaction(async () => {
    for (let i = 0; i < 65; i++) await hub.store.db.run(`INSERT INTO dispatch_assists(id,ticket_id,worker_bot_id,request_id,payload_hash,parent_attempt_id,parent_json,engine,model,effort,text,note,state,created_at,updated_at)
      SELECT ?,ticket_id,worker_bot_id,?,payload_hash,parent_attempt_id,parent_json,engine,model,effort,text,note,'returned',?,? FROM dispatch_assists WHERE request_id='stable-request'`, ["history_" + i, "history-request-" + i, Date.now() + i, Date.now() + i]);
  });
  const read = await hub.dispatch.assists(owner, one.ticketId);
  expect(read.assists).toHaveLength(64);
  expect(read.assists.at(-1)?.id).toBe("history_64");
  expect(read).toMatchObject({ truncated: true });
});

it("blocks rather than endlessly retrying when the owner archives the parent conversation during help", async () => {
  const one = await active("archived-parent");
  await assist(one.context, { ...data, engine: "codex" });
  const parent = (await hub.dispatch.show(owner, one.ticketId)).attempts[0]!;
  await hub.store.publishBotMessage("w", { conversationId: parent.conversationId, replyTo: parent.inputMessageId, status: "complete", blocks: [{ type: "text", text: "Checkpoint" }] });
  await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [parent.inputMessageId]);
  await hub.dispatch.sweep();
  await vi.waitFor(async () => expect((await hub.dispatch.show(owner, one.ticketId)).attempts).toHaveLength(2));
  const helper = (await hub.dispatch.show(owner, one.ticketId)).attempts[1]!;
  // Public owner operation, not a corrupt/missing-row fixture.
  await hub.store.updateConversation("owner", parent.conversationId, { archived: true });
  await hub.store.publishBotMessage("w", { conversationId: helper.conversationId, replyTo: helper.inputMessageId, status: "complete", blocks: [{ type: "text", text: "Helper result" }] });
  await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [helper.inputMessageId]);
  await hub.dispatch.sweep();
  const read = await hub.dispatch.show(owner, one.ticketId);
  expect(read.status).toBe("blocked");
  expect(read.attempts).toHaveLength(2);
  expect(read.attempts.at(-1)?.endedAt).toBeDefined();
  expect((await hub.dispatch.assists(owner, one.ticketId)).assists[0]).toMatchObject({ state: "returned", outcome: "completed" });
  expect(await hub.store.db.get("SELECT archived FROM conversations WHERE id=?", [parent.conversationId])).toEqual({ archived: 1 });
});

it("does not start a helper when its initial async lookup returns after scheduler stop", async () => {
  const one = await active("stop-lookup"); await assist(one.context);
  const ticket = await hub.dispatch.show(owner, one.ticketId), parent = ticket.attempts[0]!;
  await hub.store.publishBotMessage("w", { conversationId: parent.conversationId, replyTo: parent.inputMessageId, status: "complete", blocks: [{ type: "text", text: "Checkpoint" }] });
  await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [one.context]);
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const get = hub.store.db.get.bind(hub.store.db);
  vi.spyOn(hub.store.db, "get").mockImplementation(async (sql, params) => {
    if (sql.includes("SELECT a.*,t.dispatcher_bot_id")) { entered(); await held; }
    return get(sql, params) as never;
  });
  const prepare = vi.fn(async () => "w"); hub.dispatch.workers!.dispatchWorker = prepare;
  let sweep: Promise<void> | undefined;
  try {
    sweep = hub.dispatch.sweep(); await began;
    // stop must invalidate the start even though it is not in the in-flight
    // map yet; resolving this lookup must not create a new worker process.
    const stop = hub.dispatch.stop(); release(); await stop; await sweep;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(prepare).not.toHaveBeenCalled();
  } finally { release(); await sweep; }
}, 20_000);

it("rolls back a helper input when stop arrives during its admission transaction", async () => {
  const one = await active("stop-admission"); await assist(one.context);
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('h','Helper','fixture','claude','worker')");
  hub.dispatch.workers!.dispatchWorker = async () => "h";
  const parent = (await hub.dispatch.show(owner, one.ticketId)).attempts[0]!;
  await hub.store.publishBotMessage("w", { conversationId: parent.conversationId, replyTo: parent.inputMessageId, status: "complete", blocks: [{ type: "text", text: "Checkpoint" }] });
  await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [one.context]);
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const get = hub.store.db.get.bind(hub.store.db);
  vi.spyOn(hub.store.db, "get").mockImplementation(async (sql, params) => {
    if (sql.includes("SELECT id,name,engine,model,effort,online,role") && params?.[0] === "h") { entered(); await held; }
    return get(sql, params) as never;
  });
  try {
    await hub.dispatch.sweep(); await began;
    const stop = hub.dispatch.stop();
    await new Promise(resolve => setTimeout(resolve, 30)); release(); await stop;
    await hub.store.db.serial(async () => {});
    const after = await hub.dispatch.show(owner, one.ticketId);
    expect(after.attempts).toHaveLength(1);
    expect(await hub.store.db.get("SELECT child_attempt_id FROM dispatch_assists WHERE ticket_id=?", [one.ticketId])).toEqual({ child_attempt_id: null });
  } finally { release(); }
});
