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

type Turn = Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
let root: string, hub: HubServer, channel: GatewayChannel | undefined;
const secret = "worker-context-fixture-".repeat(3);
const owner = { kind: "owner" as const, userId: "owner" };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "worker-context-"));
  hub = await HubServer.start({ stateDir: root });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('d','Planner','fixture','codex','dispatcher')");
  await hub.store.createConversation("owner", ["d"], "Planner", "home");
});
afterEach(async () => { await channel?.disconnect(); channel = undefined; await hub.close(); await rm(root, { recursive: true, force: true }); });

it.each(["codex", "claude", "deepseek", "kimi", "antigravity"] as const)("delivers a fresh bounded assistance contract through the real %s worker Gateway entry", async engine => {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('w','Worker',?,?,'worker')", [hashSecret(secret), engine]);
  await hub.store.db.run("INSERT INTO dispatch_workers VALUES('d',?,'w')", [engine]);
  const state = path.join(root, "bots", "w"); await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "config.json"), JSON.stringify({ engine, role: "worker", approvalMode: "bypass", locale: "en" }));
  hub.dispatch.workers = { catalog: async () => ({ engines: [] }), dispatchWorker: async () => "w", ticketWorkspace: async () => root };
  const seen: Turn[] = [];
  const bridge: CoreBridgeLike = { handleAuthorizedMessage: async turn => { seen.push(turn); return { text: "Fixture result" }; } };
  channel = await attachGateway({ stateDir: state, botId: "w", secret, engine, url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge });
  await vi.waitFor(async () => expect((await hub.store.bots("owner")).find(b => b.id === "w")?.online).toBe(1));
  const ticket = await hub.dispatch.create(owner, "d", { requestId: "new", title: "Task", request: "Collaborate with another Bot to review the task if needed" });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const running = await hub.dispatch.dispatch(owner, "d", { requestId: `run_${i}`, ticketId: ticket.id, engine });
    const input = running.attempts.at(-1)!.inputMessageId; ids.push(input);
    await vi.waitFor(() => expect(seen).toHaveLength(i + 1));
    const contract = seen[i]!.appPlatformTools?.executionInstructions ?? "";
    expect(contract).toContain("Worker assistance (host-owned)");
    expect(contract).toContain(`--context-message ${input}`);
    expect(contract).toContain("tickets assist");
    expect(contract).toContain("tickets targets");
    expect(contract).toContain("owner");
    expect(`<tarobot.execution>${contract}</tarobot.execution>`.length).toBeLessThan(3000);
    expect(seen[i]!.turnInstructions).toContain(contract);
    expect(seen[i]!.turnInstructions).not.toContain("Authorized Bot collaboration:");
    expect(seen[i]!.turnInstructions).not.toContain("Cross-Bot CLI context for THIS turn");
    if (i) expect(contract).not.toContain(ids[0]);
    await vi.waitFor(async () => expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [input])).toEqual({ status: "accepted" }));
    await hub.dispatch.sweep();
  }
  // The same worker identity alone never grants a ticket context to an
  // ordinary conversation, even after earlier turns carried the marker.
  const ordinary = await hub.store.db.transaction(() => hub.store.createConversationInTransaction("owner", ["w"], "Ordinary fixture", "ordinary", { dispatchWorker: true }));
  await hub.store.sendMessage("owner", { conversationId: ordinary.id, clientMsgId: "ordinary", text: "Say hello", attachments: [] });
  await vi.waitFor(() => expect(seen).toHaveLength(3));
  expect(seen[2]!.appPlatformTools?.executionInstructions).toBeUndefined();
  expect(seen[2]!.turnInstructions).not.toContain("Worker assistance (host-owned)");
  expect(seen[2]!.engineOverride).toBeUndefined();
}, 30_000);
