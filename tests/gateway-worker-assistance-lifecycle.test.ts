import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { dispatchTicketSchema } from "../src/client-protocol/dispatch.js";

type Turn = Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
const owner = { kind: "owner" as const, userId: "owner" };
let hub: HubServer, root: string;
const channels: GatewayChannel[] = [];
const secret = "scoped-assistance-fixture-".repeat(3);
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "assist-gw-"));
  hub = await HubServer.start({ stateDir: root });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('d','Dispatcher','fixture','codex','dispatcher')");
  await hub.store.createConversation("owner", ["d"], "Home", "home");
  const old = await hub.dispatch.settings("owner", "d");
  await hub.dispatch.updateSettings("owner", "d", { settings: { mode: "auto", maxConcurrent: 1 }, expectedRevision: old.revision });
  hub.dispatch.workers = { catalog: async () => ({ engines: [] }), dispatchWorker: async (_d, engine) => engine === "codex" ? "parent" : "helper", ticketWorkspace: async () => root };
});
afterEach(async () => { for (const c of channels.splice(0)) await c.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); });

async function worker(id: string, engine: "codex" | "claude", execute: (turn: Turn) => Promise<string>) {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES(?,?,?,?,'worker')", [id, id, hashSecret(secret), engine]);
  await hub.store.db.run("INSERT INTO dispatch_workers VALUES('d',?,?)", [engine, id]);
  const state = path.join(root, "bots", id); await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "config.json"), JSON.stringify({ engine, approvalMode: "bypass", locale: "en" }));
  const bridge: CoreBridgeLike = { handleAuthorizedMessage: async turn => ({ text: await execute(turn) }) };
  channels.push(await attachGateway({ stateDir: state, botId: id, secret, engine, url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge }));
  await vi.waitFor(async () => expect((await hub.store.bots("owner")).find(b => b.id === id)?.online).toBe(1));
}

it("runs helper then original-session continuation through actual Gateway delivery with one ticket slot", async () => {
  const parentExit = deferred(), helperExit = deferred();
  const parents: Turn[] = [], helpers: Turn[] = [];
  let requested: { status: number; body: any } | undefined;
  await worker("parent", "codex", async turn => {
    parents.push(turn);
    if (parents.length > 1) { expect(turn.text).toContain("HELPER_RESULT"); return "PARENT_FINAL"; }
    const response = await fetch(hub.instanceUrl + "/api/instance/tickets", {
      method: "POST", headers: { Authorization: `Instance parent:${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "assist", contextMessage: turn.extraEnv?.TAROBOT_MESSAGE_ID, data: { requestId: "helper-request", engine: "claude", model: "claude-opus-5-5", effort: "medium", text: "Independent subtask", note: "Review one boundary" } }),
    });
    requested = { status: response.status, body: await response.json() };
    await parentExit.promise; return "Parent checkpoint";
  });
  await worker("helper", "claude", async turn => { helpers.push(turn); await helperExit.promise; return "HELPER_RESULT"; });
  try {
    const ticket = await hub.dispatch.create(owner, "d", { requestId: "create", title: "Task", request: "Original task" });
    await hub.dispatch.dispatch(owner, "d", { requestId: "dispatch", ticketId: ticket.id, engine: "codex", model: "gpt-6.1-sol", effort: "high", assist: 1 });
    await vi.waitFor(() => expect(requested).toBeDefined());
    expect(requested).toMatchObject({ status: 200, body: { state: "requested", remaining: 0 } });
    await hub.dispatch.sweep(); expect(helpers).toHaveLength(0); // Parent still owns the run.
    parentExit.release();
    await vi.waitFor(() => expect(helpers).toHaveLength(1), { timeout: 15_000 });
    const during = await hub.dispatch.show(owner, ticket.id);
    expect(during.status).toBe("working");
    expect(during.attempts.filter(a => !a.endedAt)).toHaveLength(1);
    expect(during.attempts.at(-1)?.botId).toBe("helper");
    expect(parents).toHaveLength(1);
    const other = await hub.dispatch.create(owner, "d", { requestId: "other", title: "Other", request: "Other" });
    await expect(hub.dispatch.dispatch(owner, "d", { requestId: "other-go", ticketId: other.id, engine: "codex" })).rejects.toThrow("dispatch_concurrency_limit");
    helperExit.release();
    await vi.waitFor(() => expect(parents).toHaveLength(2), { timeout: 15_000 });
    await vi.waitFor(async () => { await hub.dispatch.sweep(); expect((await hub.dispatch.show(owner, ticket.id)).status).toBe("needs_review"); }, { timeout: 15_000 });
    const final = await hub.dispatch.show(owner, ticket.id);
    expect(final.result).toContain("PARENT_FINAL");
    expect(final.attempts.map(a => a.botId)).toEqual(["parent", "helper", "parent"]);
    expect(final.attempts.every(a => a.outcome === "completed")).toBe(true);
    expect(parents[1]!.conversationKey).toBe(parents[0]!.conversationKey);
    expect(parents[1]!.engineOverride).toEqual(parents[0]!.engineOverride);
    expect(parents[1]!.engineOverride).toEqual({ model: "gpt-6.1-sol", effort: "high" });
    expect(helpers[0]!.engineOverride).toEqual({ model: "claude-opus-5-5", effort: "medium" });
    expect(helpers[0]!.workspaceOverride).toBe(parents[0]!.workspaceOverride);
    expect(helpers[0]!.conversationKey).not.toBe(parents[0]!.conversationKey);
    // Old App readers still see only the existing strict ticket/attempt shape.
    expect(dispatchTicketSchema.parse(final)).toEqual(final);
    const notices = await hub.store.db.all<{blocks_json: string}>("SELECT blocks_json FROM messages WHERE conversation_id=?", [final.conversationId]);
    expect(notices.filter(m => m.blocks_json.includes("【工单完成】"))).toHaveLength(1);
    expect(notices.some(m => m.blocks_json.includes("Parent checkpoint"))).toBe(false);
  } finally { parentExit.release(); helperExit.release(); }
}, 60_000);
