import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { HubDispatch } from "../src/hub/dispatch.js";
import type { DispatchTicket } from "../src/client-protocol/dispatch.js";

let directory: string, store: HubStore, dispatch: HubDispatch, now: number;
const owner = { kind: "owner" as const, userId: "owner" };
beforeEach(async () => {
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  directory = await mkdtemp(path.join(os.tmpdir(), "dispatch-health-"));
  store = await HubStore.open(directory);
  dispatch = new HubDispatch(store, { source: async () => ({ hostId: "host", hostName: "fixture" }), conversationCreated: () => {}, stop: async () => {} });
  await store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('d','Dispatcher','fixture','codex','dispatcher'),('w','Worker','fixture','codex','worker')");
  await store.createConversation("owner", ["d"], "Dispatcher", "home");
  dispatch.workers = { catalog: async () => ({ engines: [] }), dispatchWorker: async () => "w", ticketWorkspace: async () => directory };
});
afterEach(async () => { await dispatch.stop(); await store.db.close(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
async function start(id: string, force = false) {
  const ticket = await dispatch.create(owner, "d", { requestId: id, title: id, request: "Work" });
  return dispatch.dispatch(owner, "d", { requestId: `go_${id}`, ticketId: ticket.id, engine: "codex", force });
}
async function reply(ticket: DispatchTicket, error = false) {
  const a = ticket.attempts.at(-1)!;
  const run = { version: 1 as const, id: "run", revision: 1, phase: "done" as const, startedAt: a.startedAt, updatedAt: now, count: 0, completed: 0, failed: 0, truncated: false };
  await store.publishBotMessage(a.botId, { conversationId: a.conversationId, replyTo: a.inputMessageId, status: error ? "error" : "complete", blocks: error ? [{ type: "text", text: "usage quota is exhausted" }] : [{ type: "text", text: "done" }, { type: "card", elements: [], extra: { nativeRun: run } }] });
  await store.db.run("UPDATE deliveries SET status='accepted',dispatched=1 WHERE message_id=?", [a.inputMessageId]);
}
it.each(["settle", "pause-before", "pause-after"] as const)("does not clear a newer cooldown when older work completes (%s)", async mode => {
  const older = await start("older"); now += 100;
  const newer = await start("newer"); now += 100;
  if (mode === "pause-after") {
    await store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [older.attempts[0]!.inputMessageId]);
    await dispatch.action("owner", older.id, { requestId: "pause", action: "pause" });
  }
  await reply(newer, true); await dispatch.sweep();
  const health = (await dispatch.list(owner, "d")).engines;
  expect(health).toMatchObject([{ engine: "codex", state: "cooldown" }]); now += 100;
  await reply(older);
  if (mode === "pause-before") await dispatch.action("owner", older.id, { requestId: "pause", action: "pause" });
  else await dispatch.sweep();
  expect((await dispatch.show(owner, older.id)).status).toBe("needs_review");
  expect((await dispatch.list(owner, "d")).engines).toEqual(health);
  await expect(dispatch.dispatch(owner, "d", { requestId: "retry", ticketId: newer.id, engine: "codex" })).rejects.toThrow("engine_unavailable:codex:cooldown");
});
it("lets a successful recovery started after the failure clear the cooldown, and preserves owner reset", async () => {
  const failed = await start("failed"); now += 100;
  await reply(failed, true); await dispatch.sweep(); now += 100;
  const recovery = await start("recovery", true); now += 100;
  await reply(recovery); await dispatch.sweep();
  expect((await dispatch.list(owner, "d")).engines).toEqual([]);
  const failedAgain = await start("failed_again"); now += 100;
  await reply(failedAgain, true); await dispatch.sweep();
  expect((await dispatch.list(owner, "d")).engines).toHaveLength(1);
  expect(await dispatch.resetEngine("owner", "codex")).toEqual([]);
});

it.each(["cooldown", "login_required"] as const)("keeps ambiguous same-millisecond %s evidence", async state => {
  const older = await start("same_ms");
  await store.db.run("INSERT INTO engine_health(engine,state,until,reason,updated_at) VALUES('codex',?,?,?,?)", [state, state === "cooldown" ? now + 60_000 : null, "same millisecond", now]);
  now += 100; await reply(older); await dispatch.sweep();
  expect((await dispatch.list(owner, "d")).engines).toMatchObject([{ engine: "codex", state }]);
});
