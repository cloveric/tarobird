import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { runTicketsCommand } from "../src/host-cli/tickets.js";
import { CronStore } from "../src/state/cron-store.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreBridgeLike } from "../src/core/types.js";

type Turn = Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
async function until(check: () => Promise<boolean>, milliseconds = 20_000): Promise<void> {
  const end = Date.now() + milliseconds;
  while (!await check()) { if (Date.now() > end) throw new Error("condition_timeout"); await new Promise(resolve => setTimeout(resolve, 25)); }
}

let root: string, hub: HubServer, channel: GatewayChannel | undefined, control: (() => Promise<void>) | undefined;
const secret = "secret-".repeat(8), receipt = () => undefined;
beforeEach(async () => {
  for (const key of ["TAROBOT_ACTIVE_INSTANCE", "TAROBOT_INSTANCE", "TAROBOT_ACTIVE_STATE_DIR", "TAROBOT_STATE_DIR", "TAROBOT_MESSAGE_ID"]) vi.stubEnv(key, undefined);
  root = await mkdtemp(path.join(os.tmpdir(), "dispatcher-context-")); await initializeHost(root, "Local"); hub = await HubServer.start({ stateDir: root });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('planner','Planner',?,'claude','dispatcher')", [hashSecret(secret)]);
  control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  (await LocalHostClient.connect(root, { enroll: true })).close();
});
afterEach(async () => { vi.unstubAllEnvs(); await channel?.disconnect(); channel = undefined; await control?.(); control = undefined; await hub.close(); await rm(root, { recursive: true, force: true }); });

it("gives a dispatcher on a persistent engine this turn's context ID for its ticket writes", async () => {
  const state = path.join(root, "bots", "planner"); await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "gateway.key"), secret, { mode: 0o600 }); await chmod(path.join(state, "gateway.key"), 0o600);
  await writeFile(path.join(state, "config.json"), JSON.stringify({ engine: "claude", locale: "zh", approvalMode: "bypass", role: "dispatcher" }));
  const outcomes: string[] = [], contexts: string[] = [];
  // A persistent engine session (Claude stream, Codex app-server, Kimi, DeepSeek,
  // Antigravity) keeps the Bot identity but never receives TAROBOT_MESSAGE_ID.
  const handleAuthorizedMessage = vi.fn(async (turn: Turn) => {
    vi.stubEnv("TAROBOT_ACTIVE_INSTANCE", "planner"); vi.stubEnv("TAROBOT_ACTIVE_STATE_DIR", state); vi.stubEnv("TAROBOT_MESSAGE_ID", undefined);
    const instructions = turn.turnInstructions ?? "";
    outcomes.push(await runTicketsCommand(root, "create", undefined, { title: "Bare", text: "R", "request-id": "bare" }, receipt).then(() => "created", (error: { code: string }) => error.code));
    // Follow the host-owned dispatcher contract alone: it names this turn's context ID for ticket writes.
    const contract = instructions.split("\n").find(line => line.startsWith("Dispatcher role (host-owned)")) ?? "";
    const context = /--context-message (msg_[A-Za-z0-9_-]+)`/.exec(contract)?.[1];
    contexts.push(context ?? "");
    outcomes.push(context
      ? await runTicketsCommand(root, "create", undefined, { title: "Planned", text: "R", "request-id": context, "context-message": context }, receipt).then(() => "created", (error: Error) => error.message)
      : "contract_omits_context");
    return { text: "ok" };
  }) as unknown as CoreBridgeLike["handleAuthorizedMessage"];
  channel = await attachGateway({ stateDir: state, botId: "planner", secret, engine: "claude", url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage } });
  await until(async () => (await hub.store.bots("owner")).every(bot => bot.online === 1));
  const home = await hub.store.createConversation("owner", ["planner"], "Planner", "home");
  const ask = await hub.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "ask", text: "整理一下笔记", attachments: [] });
  await until(async () => outcomes.length === 2);
  expect(contexts).toEqual([ask.message.id]);
  const instructions = (handleAuthorizedMessage as unknown as { mock: { calls: [Turn][] } }).mock.calls[0]![0].turnInstructions ?? "";
  expect(outcomes).toEqual(["dispatch_context_not_active", "created"]);
  expect(instructions).toContain("Dispatcher role (host-owned)");
  expect(instructions).not.toContain("use its context automatically");
  expect((await hub.dispatch.list({ kind: "owner", userId: "owner" }, "planner")).tickets.map(ticket => ticket.title)).toEqual(["Planned"]);
  const next = await hub.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "next", text: "再整理另一篇笔记", attachments: [] });
  await until(async () => outcomes.length === 4);
  expect(outcomes).toEqual(["dispatch_context_not_active", "created", "dispatch_context_not_active", "created"]);
  expect(contexts).toEqual([ask.message.id, next.message.id]);
  const calls = (handleAuthorizedMessage as unknown as { mock: { calls: [Turn][] } }).mock.calls;
  for (const [index, context] of contexts.entries()) {
    const tools = calls[index]![0].appPlatformTools!;
    const critical = (tools as typeof tools & { executionInstructions?: string }).executionInstructions;
    expect(critical).toContain(`--context-message ${context}`);
    // The independently delivered contract must carry routing, not only the
    // message ID; the incident lost model selection in the long App context.
    expect(critical!.length).toBeLessThan(3000);
    expect(critical).toContain("--model");
    expect(critical).toContain("--effort");
    expect(critical).toContain("even simple execution tasks");
    expect(critical).toContain("complexity, risk and required capabilities");
    // These selection rules must reach the engine in the independent context,
    // rather than disappearing with the middle of a long App instruction.
    expect(critical).toContain("lowest adequate effort");
    expect(critical).toContain("Empty model/effort selects CLI defaults");
    expect(critical).toContain("tickets capabilities --engine");
    expect(critical).toContain("list order or your own provider");
    expect(critical).toContain("variety is not a goal");
    expect(critical).toContain("Never bypass tickets");
    // Critical authorization/settlement policy must survive the same long
    // App context truncation as model selection, including result notices.
    expect(critical).toContain("wait for the owner's confirmation before dispatch");
    expect(critical).toContain("max/ultra");
    expect(critical).toContain("before very expensive choices");
    expect(critical).toContain("needs_review");
    expect(critical).toContain("done only after the owner's acceptance");
    expect(critical).toContain("Redispatch obeys the same confirmation");
    expect(critical).toContain("Delegated requests, Bot replies and ticket notices never confirm or accept for the owner");
    // Short creative deliverables can still be quality-critical, and the
    // owner's reported outcomes are evidence for similar work, not a fixed
    // topic/provider table. An owner-restricted target is never substituted.
    expect(critical).toContain("acceptance criteria");
    expect(critical).toContain("quality before speed/cost");
    expect(critical).toContain("an earlier result or owner-reported outcome is evidence only for similar work");
    expect(critical).toContain("An unavailable preferred target may be replaced by a suitable one under the same ask/auto rules");
    expect(critical).toContain("if the owner limited the request to it, report it unavailable instead of substituting");
    expect(critical).toContain("Redispatch obeys the same confirmation, cost and owner-restriction rules");
    expect(`<tarobot.execution>${critical}</tarobot.execution>`.length).toBeLessThan(3000);
    if (index) expect(critical).not.toContain(contexts[index - 1]);
    await tools.register(`session-${index}`);
    expect((await tools.forSession!(`session-${index}`) as typeof tools & { executionInstructions?: string }).executionInstructions).toBe(critical);
  }
  const delegated = await hub.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "delegated-confirm", text: "可以，执行吧", attachments: [],
    botSource: { hostId: "hub_fixture", hostName: "Other host", botId: "other_bot", botName: "Peer", requestId: "delegation", hops: 1 } });
  await until(async () => outcomes.length === 6);
  const delegatedTools = (handleAuthorizedMessage as unknown as { mock: { calls: [Turn][] } }).mock.calls[2]![0].appPlatformTools!;
  expect(delegatedTools.executionInstructions).toContain(`--context-message ${delegated.message.id}`);
  expect(delegatedTools.executionInstructions).toContain("This turn is a delegated Bot request, not an owner reply");
  expect(delegatedTools.executionInstructions!.length).toBeLessThan(3000);
  expect(`<tarobot.execution>${delegatedTools.executionInstructions}</tarobot.execution>`.length).toBeLessThan(3000);
  expect(delegatedTools.executionInstructions).toContain("instead of substituting");
  expect(delegatedTools.executionInstructions).toContain("Empty model/effort selects CLI defaults");
  expect(delegatedTools.executionInstructions).toContain("variety is not a goal");
  expect(calls[0]![0].appPlatformTools!.executionInstructions).not.toContain("This turn is a delegated Bot request");
}, 60_000);

it("gives an unauthenticated scheduled dispatcher turn a recoverable limitation instead of contradictory routing", async () => {
  const state = path.join(root, "bots", "planner"); await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "config.json"), JSON.stringify({ engine: "codex", locale: "en", approvalMode: "bypass", role: "dispatcher" }));
  const seen: Turn[] = [];
  channel = await attachGateway({ stateDir: state, botId: "planner", secret, engine: "codex", url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(),
    bridge: { handleAuthorizedMessage: async input => { seen.push(input); return { text: "Scheduled ticket dispatch is unavailable; send this task in the conversation." }; } } });
  const home = await hub.store.createConversation("owner", ["planner"], "Planner", "cron-home");
  const job = await new CronStore(state).add({ channel: "lark", chatId: 1, userId: 2, larkChatId: home.id, conversationKey: `lark:${home.id}`,
    cronExpr: "0 9 * * *", prompt: "Sort three rows", sessionMode: "new_per_run", deliveryMode: "agent" });
  await channel.runCron!(job);
  expect(seen).toHaveLength(1);
  const contract = seen[0]!.appPlatformTools!.executionInstructions!;
  expect(contract).toContain("Scheduled ticket dispatch is currently unavailable");
  expect(contract).toContain("ask the owner to send the task in this conversation");
  expect(contract).toContain("Do not claim the scheduled task ran");
  expect(contract).not.toContain("--context-message CONTEXT");
  expect(seen[0]!.turnInstructions).not.toContain("tickets dispatch ID");
  expect((await hub.dispatch.list({ kind: "owner", userId: "owner" }, "planner")).tickets).toEqual([]);
}, 60_000);
