import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreBridgeLike } from "../src/core/types.js";

type Turn = Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
async function until(check: () => Promise<boolean>, milliseconds = 20_000): Promise<void> {
  const end = Date.now() + milliseconds;
  while (!await check()) { if (Date.now() > end) throw new Error("condition_timeout"); await new Promise(resolve => setTimeout(resolve, 25)); }
}

let root: string, hub: HubServer;
const channels: GatewayChannel[] = [], calls = new Map<string, Turn[]>(), replies = new Map<string, (turn: Turn) => string | Promise<string>>();
const bots = { planner: { engine: "claude", role: "dispatcher" }, coder: { engine: "codex", role: "worker" } } as const;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-dispatch-"));
  hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  calls.clear(); replies.clear();
  for (const [id, bot] of Object.entries(bots)) {
    const secret = randomBytes(32).toString("base64url"), dir = path.join(root, "bots", id);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES(?,?,?,?,?)", [id, id, hashSecret(secret), bot.engine, bot.role]);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ engine: bot.engine, locale: "zh", approvalMode: "bypass", ...(bot.role === "dispatcher" ? { role: bot.role } : {}) }));
    const handleAuthorizedMessage = vi.fn(async (input: Turn) => { calls.set(id, [...calls.get(id) ?? [], input]); return { text: await replies.get(id)?.(input) ?? "ok" }; }) as unknown as CoreBridgeLike["handleAuthorizedMessage"];
    channels.push(await attachGateway({ stateDir: dir, botId: id, secret, engine: bot.engine, url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage } }));
  }
  await until(async () => (await hub.store.bots("owner")).every(bot => bot.online === 1));
  // BotManager creates the codex worker in production; here it is pre-attached.
  hub.dispatch.workers = { catalog: async () => ({ engines: [] }), dispatchWorker: async () => "coder", ticketWorkspace: async (_dispatcher, ticketId) => { const dir = path.join(root, "tickets", ticketId); await mkdir(dir, { recursive: true }); return dir; } };
});
afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.disconnect();
  await hub.close(); await rm(root, { recursive: true, force: true });
});

it("runs a ticket on the worker with its own settings and wakes the dispatcher with the result", async () => {
  const home = await hub.store.createConversation("owner", ["planner"], "Planner", "home");
  await hub.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "ask", text: "整理一下笔记", attachments: [] });
  await until(async () => calls.get("planner")?.length === 1);
  expect(calls.get("planner")![0]!.turnInstructions).toContain("Dispatcher role (host-owned)");
  expect(calls.get("planner")![0]!.appPlatformTools?.executionInstructions).toContain("--context-message");
  replies.set("coder", () => "NOTES DONE");
  const owner = { kind: "owner" as const, userId: "owner" };
  const ticket = await hub.dispatch.create(owner, "planner", { requestId: "t1", title: "笔记", request: "Summarize the notes" });
  await hub.dispatch.dispatch(owner, "planner", { requestId: "d1", ticketId: ticket.id, engine: "codex", model: "gpt-6-luna", effort: "low" });
  await until(async () => calls.get("coder")?.length === 1);
  const work = calls.get("coder")![0]!;
  expect(work.text).toContain("Summarize the notes");
  expect(work.turnInstructions).toContain("Cross-Bot request for THIS turn");
  expect(work.turnInstructions).not.toContain("Dispatcher role");
  expect(work.appPlatformTools?.executionInstructions).toContain("Worker assistance (host-owned)");
  expect(work.engineOverride).toEqual({ model: "gpt-6-luna", effort: "low" });
  expect(work.workspaceOverride).toBe(path.join(root, "tickets", ticket.id));
  await until(async () => { await hub.dispatch.sweep(); return (await hub.dispatch.show(owner, ticket.id)).status === "needs_review"; });
  await until(async () => calls.get("planner")?.length === 2);
  const wake = calls.get("planner")![1]!;
  expect(wake.text).toContain("【工单完成】");
  expect(wake.text).toContain("NOTES DONE");
  // The worker conversation stays out of ordinary listings.
  const worker = (await hub.dispatch.show(owner, ticket.id)).attempts[0]!.conversationId;
  expect((await hub.store.conversations("owner", { hidden: false })).map(c => c.id)).not.toContain(worker);
  // Selecting another model within the SAME engine must reach that worker's
  // next ticket, without inheriting the first ticket's lightweight override.
  const botSettings = await hub.store.db.all("SELECT id,model,effort FROM bots ORDER BY id");
  const second = await hub.dispatch.create(owner, "planner", { requestId: "t2", title: "Audit", request: "Review a cross-module concurrency defect" });
  await hub.dispatch.dispatch(owner, "planner", { requestId: "d2", ticketId: second.id, engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  await until(async () => calls.get("coder")?.length === 2);
  expect(calls.get("coder")![1]!.engineOverride).toEqual({ model: "gpt-6.1-sol", effort: "high" });
  const secondTicket = await hub.dispatch.show(owner, second.id);
  expect(secondTicket.attempts[0]).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  expect(secondTicket.attempts[0]!.conversationId).not.toBe(worker);
  expect(await hub.store.db.all("SELECT id,model,effort FROM bots ORDER BY id")).toEqual(botSettings);
}, 60_000);

it("pauses one ticket through the real Gateway and waits for its terminal receipt", async () => {
  await hub.store.createConversation("owner", ["planner"], "Planner", "home");
  const owner = { kind: "owner" as const, userId: "owner" };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  replies.set("coder", async input => {
    await held;
    input.abortSignal?.throwIfAborted();
    return "done";
  });
  try {
    const first = await hub.dispatch.create(owner, "planner", { requestId: "t1", title: "One", request: "One" });
    await hub.dispatch.dispatch(owner, "planner", { requestId: "d1", ticketId: first.id, engine: "codex" });
    await until(async () => calls.get("coder")?.length === 1);
    const second = await hub.dispatch.create(owner, "planner", { requestId: "t2", title: "Two", request: "Two" });
    await hub.dispatch.dispatch(owner, "planner", { requestId: "d2", ticketId: second.id, engine: "codex" });
    await until(async () => calls.get("coder")?.length === 2);
    await hub.dispatch.action("owner", first.id, { requestId: "pause", action: "pause" });
    expect(calls.get("coder")![0]!.abortSignal?.aborted).toBe(true);
    expect(calls.get("coder")![1]!.abortSignal?.aborted).toBe(false);
    expect((await hub.dispatch.show(owner, first.id)).status).toBe("working");
    release();
    await until(async () => { await hub.dispatch.sweep(); return (await hub.dispatch.show(owner, first.id)).status === "queued"; });
    expect(await hub.dispatch.show(owner, first.id)).toMatchObject({ paused: true, attempts: [{ outcome: "cancelled" }] });
    await until(async () => { await hub.dispatch.sweep(); return (await hub.dispatch.show(owner, second.id)).status === "needs_review"; });
    expect(calls.get("planner")?.some(input => input.text.includes("【工单中止】"))).toBeFalsy();
  } finally { release(); }
}, 60_000);


it.each([["Quota exceeded", "engine-quota", "queued"], ["not logged in", "auth", "queued"], ["file not found", "task", "blocked"]] as const)("settles a real Gateway worker error card (%s)", async (error, category, status) => {
  await hub.store.createConversation("owner", ["planner"], "Planner", "home");
  replies.set("coder", () => { throw new Error(error); });
  const owner = { kind: "owner" as const, userId: "owner" };
  const created = await hub.dispatch.create(owner, "planner", { requestId: "quota-ticket", title: "Quota", request: "Work" });
  const ticket = await hub.dispatch.dispatch(owner, "planner", { requestId: "quota-go", ticketId: created.id, engine: "codex" });
  await until(async () => calls.get("coder")?.length === 1);
  await until(async () => { await hub.dispatch.sweep(); return (await hub.dispatch.show(owner, ticket.id)).status !== "working"; });
  const settled = await hub.dispatch.show(owner, ticket.id);
  expect(settled.status).toBe(status);
  expect(settled.attempts.at(-1)).toMatchObject({ outcome: "failed", failure: { category } });
  const rows = await hub.store.db.all<{status: string; blocks_json: string}>("SELECT status,blocks_json FROM messages WHERE reply_to=? AND author_type='bot'", [ticket.attempts[0]!.inputMessageId]);
  expect(rows.some(row => row.status === "complete" && JSON.parse(row.blocks_json).some((block: {extra?: {nativeRun?: {phase: string}}}) => block.extra?.nativeRun?.phase === "error"))).toBe(true);
}, 60_000);
