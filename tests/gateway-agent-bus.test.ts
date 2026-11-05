import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_BUS_RECORD_PROMPT_CHARS, agentBusIsActive, type AgentBusConfig, type AgentBusDetail } from "../src/client-protocol/agent-bus.js";
import { blocksText, type Message } from "../src/client-protocol/index.js";
import { startGatewayBus } from "../src/gateway/bus.js";
import { GatewayAgentBusRuns, observeAgentBusRun } from "../src/gateway/agent-bus.js";
import { attachGateway } from "../src/gateway/service.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { createCoreServiceRuntime, type CoreServiceRuntime } from "../src/core/runtime.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { UsageStore } from "../src/state/usage-store.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { HubStore } from "../src/hub/store.js";
import { HubAgentBuses } from "../src/hub/agent-bus.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { CrewRunStore } from "../src/state/crew-run-store.js";
import { parseTimelineEvents, summarizeTimelineEvents } from "../src/state/timeline-log.js";
import { delegateToInstance } from "../src/bus/bus-client.js";
import { BusProtocolError } from "../src/bus/bus-protocol.js";

type Turn = Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
type Engine = (input: Turn) => Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number; costUsd?: number } }>;
const ids = ["alpha", "beta", "gamma", "delta", "epsilon"] as const;
async function until(check: () => Promise<boolean>, milliseconds = 20_000): Promise<void> {
  const end = Date.now() + milliseconds;
  while (!await check()) { if (Date.now() > end) throw new Error("condition_timeout"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
const firstLine = (text: string) => text.split("\n").find(Boolean) ?? "";

describe("Gateway Agent Bus observer", () => {
  it("keeps Unicode intact at the record excerpt boundary without truncating the actual task", async () => {
    const prompt = "a".repeat(AGENT_BUS_RECORD_PROMPT_CHARS - 1) + "🧪 this still reaches the member";
    const reports: { type?: string; prompt?: string }[] = [];
    const delegate = vi.fn(async (_args: Parameters<typeof delegateToInstance>[0]) => ({ success: true, text: "ok", fromInstance: "beta" }));
    const runtime = Object.assign(createCoreServiceRuntime(), { busRuntime: { delegateToInstance: delegate } });
    const observed = observeAgentBusRun({ transport: { enqueue: (_method, params) => { reports.push(params as typeof reports[number]); return { persisted: Promise.resolve(), response: Promise.resolve(null) }; } },
      runs: new GatewayAgentBusRuns(), botId: "alpha", messageId: "msg_unicode",
      dispatch: { runId: "abr_unicode", workspaceId: "ab_unicode", mode: "ask", members: ["beta"], maxResearchQuestions: 5, maxRevisionRounds: 1 }, runtime, bridge: { handleAuthorizedMessage: vi.fn() } });
    await observed.runtime.busRuntime!.delegateToInstance!({ fromInstance: "alpha", targetInstance: "beta", prompt, depth: 0, stateDir: "/unused" });
    await observed.finish();
    expect(delegate.mock.calls[0]?.[0]).toMatchObject({ prompt });
    const excerpt = reports.find(report => report.type === "stage.started")!.prompt!;
    expect(Buffer.from(excerpt, "utf8").toString("utf8")).toBe(excerpt);
    expect(excerpt).toBe("a".repeat(AGENT_BUS_RECORD_PROMPT_CHARS - 1) + "\n\n…（已截断）");
  });
  it("waits for earlier reports to persist before publishing the terminal report", async () => {
    let persist!: () => void;
    const pending = new Promise<void>(resolve => { persist = resolve; });
    const reports: unknown[] = [];
    const observed = observeAgentBusRun({ transport: { enqueue: (_method, params) => { reports.push(params); return { persisted: pending, response: new Promise(() => {}) }; } },
      runs: new GatewayAgentBusRuns(), botId: "alpha", messageId: "msg_run",
      dispatch: { runId: "abr_run", workspaceId: "ab_ws", mode: "ask", members: ["beta"], maxResearchQuestions: 5, maxRevisionRounds: 1 },
      runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: vi.fn() } });
    observed.runtime.busRuntime!.agentBusRun!.started();
    observed.runtime.busRuntime!.agentBusRun!.outcome("success");
    const finished = observed.finish();
    await Promise.resolve();
    expect(reports).toHaveLength(1);
    persist(); await finished;
    expect(reports).toEqual([
      { type: "run.started", runId: "abr_run", messageId: "msg_run" },
      { type: "run.finished", status: "completed", runId: "abr_run", messageId: "msg_run" },
    ]);
  });
  it("applies an early, replayed or live stop to exactly one run", () => {
    const runs = new GatewayAgentBusRuns();
    expect(runs.stop("abr_early")).toBe(false);
    expect(runs.open("abr_early", false).signal.aborted).toBe(true);
    expect(runs.open("abr_flagged", true).signal.aborted).toBe(true);
    const live = runs.open("abr_live", false), other = runs.open("abr_other", false);
    expect(runs.stop("abr_live")).toBe(true);
    expect([live.signal.aborted, other.signal.aborted]).toEqual([true, false]);
    runs.close("abr_other", other);
    expect(runs.stop("abr_other")).toBe(false);
    expect(other.signal.aborted).toBe(false);
    expect(runs.stop("abr_expired", true)).toBe(false);
    expect(runs.open("abr_expired", false).signal.aborted).toBe(false);
  });
  it("never executes a target outside the Hub snapshot and reports only real outcomes", async () => {
    const reports: unknown[] = [], delegate = vi.fn(async () => ({ success: true, text: "ok", fromInstance: "beta" }));
    const runtime = Object.assign(createCoreServiceRuntime(), { busRuntime: { delegateToInstance: delegate } });
    const observed = observeAgentBusRun({ transport: { enqueue: (_method, params) => { reports.push(params); return { persisted: Promise.resolve(), response: Promise.resolve(null) }; } }, runs: new GatewayAgentBusRuns(), botId: "alpha", messageId: "msg_run",
      dispatch: { runId: "abr_run", workspaceId: "ab_ws", mode: "ask", members: ["beta"], maxResearchQuestions: 5, maxRevisionRounds: 1 }, runtime, bridge: { handleAuthorizedMessage: vi.fn() } });
    const wrapped = observed.runtime.busRuntime!.delegateToInstance!;
    await expect(wrapped({ fromInstance: "alpha", targetInstance: "gamma", prompt: "x", depth: 0, stateDir: "/unused" })).rejects.toThrow("agent_bus_target_not_in_run");
    expect(delegate).not.toHaveBeenCalled();
    await wrapped({ fromInstance: "alpha", targetInstance: "beta", prompt: "task", depth: 0, stateDir: "/unused" });
    await observed.finish();
    // No handled outcome was observed, so a completed stage alone is not success.
    expect(reports).toEqual([
      { type: "stage.started", stageId: "s1", botId: "beta", prompt: "task", runId: "abr_run", messageId: "msg_run" },
      { type: "stage.finished", stageId: "s1", botId: "beta", status: "completed", text: "ok", runId: "abr_run", messageId: "msg_run" },
      { type: "run.finished", status: "failed", error: "agent_bus_not_executed", runId: "abr_run", messageId: "msg_run" },
    ]);
  });
  it.each(["run", "turn"] as const)("does not allocate a stage for an already stopped %s", async source => {
    const reports: unknown[] = [], delegate = vi.fn(), coordinator = vi.fn(), runs = new GatewayAgentBusRuns();
    const signal = new AbortController();
    const observed = observeAgentBusRun({ transport: { enqueue: (_method, params) => { reports.push(params); return { persisted: Promise.resolve(), response: Promise.resolve(null) }; } },
      runs, botId: "alpha", messageId: "msg_run", dispatch: { runId: "abr_run", workspaceId: "ab_ws", mode: "fan", members: ["beta"], maxResearchQuestions: 5, maxRevisionRounds: 1 },
      runtime: Object.assign(createCoreServiceRuntime(), { busRuntime: { delegateToInstance: delegate } }), bridge: { handleAuthorizedMessage: coordinator } });
    if (source === "run") runs.stop("abr_run"); else signal.abort(new Error("turn_stopped"));
    await expect(observed.runtime.busRuntime!.delegateToInstance!({ fromInstance: "alpha", targetInstance: "beta", prompt: "not started", depth: 0, stateDir: "/unused", abortSignal: signal.signal })).rejects.toThrow();
    await expect(observed.bridge.handleAuthorizedMessage({ chatId: 1, userId: 1, chatType: "bus", locale: "en", text: "not started", files: [], abortSignal: signal.signal })).rejects.toThrow();
    expect(delegate).not.toHaveBeenCalled();
    expect(coordinator).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
    await observed.finish();
    expect(reports).toEqual([{ type: "run.finished", status: "cancelled", runId: "abr_run", messageId: "msg_run" }]);
  });
  it("retains a core stopped outcome when no stage or Bus controller was cancelled", async () => {
    const reports: unknown[] = [];
    const observed = observeAgentBusRun({ transport: { enqueue: (_method, params) => { reports.push(params); return { persisted: Promise.resolve(), response: Promise.resolve(null) }; } },
      runs: new GatewayAgentBusRuns(), botId: "alpha", messageId: "msg_run", dispatch: { runId: "abr_run", workspaceId: "ab_ws", mode: "crew", members: ["beta", "gamma", "delta", "epsilon"], maxResearchQuestions: 5, maxRevisionRounds: 1 },
      runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: vi.fn() } });
    observed.runtime.busRuntime!.agentBusRun!.outcome("stopped", "Stopped between stages");
    expect(observed.runtime.busRuntime!.agentBusRun!.signal.aborted).toBe(false);
    await observed.finish();
    expect(reports).toEqual([{ type: "run.finished", status: "cancelled", runId: "abr_run", messageId: "msg_run" }]);
  });

  it("rejects wrong slots and cancels queued repeated members without executing or publishing them", async () => {
    const reports: any[] = [], runs = new GatewayAgentBusRuns();
    const delegate = vi.fn(async (args: Parameters<typeof delegateToInstance>[0]) => new Promise<never>((_, reject) => {
      args.abortSignal!.addEventListener("abort", () => reject(new BusProtocolError({ message: "stopped", code: "cancelled", retryable: false })), { once: true });
    }));
    const observed = observeAgentBusRun({ transport: { enqueue: (_method, params) => { reports.push(params); return { persisted: Promise.resolve(), response: Promise.resolve(null) }; } }, runs, botId: "alpha", messageId: "msg_run",
      dispatch: { runId: "abr_run", workspaceId: "ab_ws", mode: "fan", coordinatorConversationId: "source", conversations: Array.from({ length: 6 }, (_, i) => `chat_${i}`), members: Array(6).fill("beta"), maxResearchQuestions: 5, maxRevisionRounds: 1 },
      runtime: Object.assign(createCoreServiceRuntime(), { busRuntime: { delegateToInstance: delegate } }), bridge: { handleAuthorizedMessage: vi.fn() } });
    const wrapped = observed.runtime.busRuntime!.delegateToInstance!, args = { fromInstance: "alpha", targetInstance: "beta", prompt: "task", depth: 0, stateDir: "/unused" };
    for (const index of [undefined, -1, 6]) await expect(wrapped({ ...args, agentBusMemberIndex: index })).rejects.toThrow("agent_bus_target_not_in_run");
    expect(delegate).not.toHaveBeenCalled();
    const calls = Array.from({ length: 6 }, (_, i) => wrapped({ ...args, agentBusMemberIndex: i }));
    expect(delegate).toHaveBeenCalledTimes(4);
    runs.stop("abr_run");
    expect((await Promise.allSettled(calls)).every(result => result.status === "rejected")).toBe(true);
    await observed.finish();
    expect(delegate).toHaveBeenCalledTimes(4);
    expect(reports.filter(report => report.type === "stage.started").map(report => report.conversationId)).toEqual(["chat_0", "chat_1", "chat_2", "chat_3"]);
    expect(reports.at(-1)).toMatchObject({ type: "run.finished", status: "cancelled" });
  });
});

describe("Agent Bus reports through the durable Gateway outbox", () => {
  it.each([
    ["persist", "run.started"], ["persist", "stage.started"], ["persist", "stage.finished"], ["persist", "run.finished"],
    ["enqueue", "run.started"], ["enqueue", "stage.started"], ["enqueue", "stage.finished"], ["enqueue", "run.finished"],
  ] as const)("fences %s failure for %s as unconfirmed and never re-executes the model", async (failure, eventType) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-report-failure-"));
    const worker = path.join(root, "worker"), store = await HubStore.open(path.join(root, "hub"));
    const transport = new GatewayTransport({ stateDir: worker, botId: "alpha", secret: "fixture-secret", url: "ws://127.0.0.1:9/instance" });
    const channels: GatewayChannel[] = [];
    type Entry = { id: string; method: string; params: { type?: string; messageId: string; reason?: "failed" | "interrupted" } };
    const entries = async (): Promise<Entry[]> => JSON.parse(await readFile(path.join(worker, "gateway-outbox.json"), "utf8")).requests;
    try {
      for (const id of ["alpha", "beta"]) { await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, "fixture"]); await store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]); }
      const buses = new HubAgentBuses(store, { workerCapable: () => true, stop: async () => null, conversationsCreated: () => {} });
      const bus = await buses.create("owner", { requestId: "create", config: { name: "failure", mode: "ask", coordinator: { botId: "alpha" }, members: [{ botId: "beta" }] } });
      const run = await buses.start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "task" });
      const [message] = await new HubPromptQueue(store).claim("alpha", true, false);
      const conversation = await store.conversationForBot("alpha", bus.coordinator.conversationId), dispatch = (await buses.dispatch("alpha", run.messageId))!;
      let injected = false, acked = 0;
      const runs = new GatewayAgentBusRuns(), warning = vi.fn(), model = vi.fn(async () => ({ success: true, text: "real output", fromInstance: "beta" }));
      if (failure === "persist") {
        // Fail one real JsonStore write. Later writes remain available, so an
        // incorrectly published run.finished could otherwise claim success.
        const state = (transport as unknown as { state: { write: (value: { requests: Entry[] }) => Promise<void> } }).state;
        const write = state.write.bind(state);
        vi.spyOn(state, "write").mockImplementation(async value => {
          if (!injected && value.requests.at(-1)?.params.type === eventType) { injected = true; throw new Error("injected_outbox_write_failure"); }
          return write(value);
        });
      } else {
        const enqueue = transport.enqueue.bind(transport);
        vi.spyOn(transport, "enqueue").mockImplementation((method, params) => {
          if (!injected && method === "agentBus.event" && (params as { type?: string }).type === eventType) { injected = true; throw new Error("injected_enqueue_failure"); }
          return enqueue(method, params);
        });
      }
      const applied = new Set<string>();
      // Only replace the response side of the fixture's Hub connection. Both
      // the observer and GatewayChannel still write the real durable outbox.
      vi.spyOn(transport, "request").mockImplementation(async (method, params) => {
        const queued = transport.enqueue(method, params); void queued.response.catch(() => undefined); await queued.persisted;
        for (const entry of await entries()) {
          if (applied.has(entry.id)) continue;
          if (entry.method === "agentBus.event") await buses.event("alpha", entry.params);
          else if (entry.method === "delivery.fail") { await store.failDelivery("alpha", entry.params.messageId, entry.params.reason!); await buses.settleDelivery("alpha", entry.params.messageId); }
          else if (entry.method === "ack") { await store.acknowledgeDelivery("alpha", entry.params.messageId); await buses.settleDelivery("alpha", entry.params.messageId); }
          else throw new Error(`unexpected_request:${entry.method}`);
          applied.add(entry.id);
        }
        if (method === "ack") acked++;
        return null;
      });
      const attach = () => {
        const channel = new GatewayChannel(transport); channels.push(channel); channel.on("error", () => {});
        channel.on("message", async normalized => {
          const observed = observeAgentBusRun({ transport, runs, botId: "alpha", messageId: normalized.messageId, dispatch: normalized.agentBus!,
            runtime: Object.assign(createCoreServiceRuntime(), { busRuntime: { delegateToInstance: model } }), bridge: { handleAuthorizedMessage: vi.fn() }, onWarning: warning });
          observed.runtime.busRuntime!.agentBusRun!.started();
          await observed.runtime.busRuntime!.delegateToInstance!({ fromInstance: "alpha", targetInstance: "beta", prompt: "task", depth: 0, stateDir: root, agentBusMemberIndex: 0 });
          observed.runtime.busRuntime!.agentBusRun!.outcome("success");
          await observed.finish();
        });
      };
      attach(); await transport.onMessage!(message!, conversation, dispatch); await until(async () => acked === 1);
      expect(injected).toBe(true);
      expect(warning).toHaveBeenCalledWith("agent_bus_event_unpersisted");
      expect(model).toHaveBeenCalledTimes(1);
      expect(runs.stop(run.id)).toBe(false);
      expect((await buses.detail("owner", bus.id)).runs[0]).toMatchObject({ status: "interrupted", error: "agent_bus_delivery_failed" });
      const journal = await entries();
      expect(journal.some(entry => entry.params.type === "run.finished")).toBe(false);
      expect(journal.slice(-2).map(entry => entry.method)).toEqual(["delivery.fail", "ack"]);
      const replay = vi.fn(async () => null);
      expect(await new GatewayReceipts(worker).run(`message:${run.messageId}`, replay)).toEqual({ ok: false, error: "operation_failed" });
      expect(replay).not.toHaveBeenCalled();
      // A fresh channel reads the on-disk receipt for the replayed input.
      attach(); await transport.onMessage!(message!, conversation, dispatch); await until(async () => acked === 2);
      expect(model).toHaveBeenCalledTimes(1);
      expect((await buses.detail("owner", bus.id)).runs[0]!.status).toBe("interrupted");
    } finally {
      for (const channel of channels.reverse()) await channel.disconnect();
      await transport.disconnect(); await store.db.close(); await rm(root, { recursive: true, force: true });
    }
  });
  it("journals every report before the input's ack, without waiting for slow Hub responses", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-outbox-"));
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
    const received: { id: string; method: string; params: { type?: string } }[] = [];
    // Accept the connection, then withhold every response like a stalled Hub.
    server.on("connection", ws => ws.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "instance.hello") ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [] }));
      else if (frame.type === "instance.request") received.push(frame);
    }));
    const transport = new GatewayTransport({ stateDir: path.join(root, "worker"), botId: "alpha", secret: "fixture-secret-fixture-secret-0000", url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
    let booted = false; transport.onBoot = async () => { booted = true; };
    const store = await HubStore.open(path.join(root, "hub"));
    try {
      for (const id of ["alpha", "beta"]) { await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, "fixture"]); await store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]); }
      const buses = new HubAgentBuses(store, { workerCapable: () => true, stop: async () => null, conversationsCreated: () => {} });
      const bus = await buses.create("owner", { requestId: "create", config: { name: "reports", mode: "ask", coordinator: { botId: "alpha" }, members: [{ botId: "beta" }] } });
      const run = await buses.start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "task" });
      await new HubPromptQueue(store).claim("alpha", true, false);
      await transport.connect(); await vi.waitFor(() => expect(booted).toBe(true));
      const observed = observeAgentBusRun({ transport, runs: new GatewayAgentBusRuns(), botId: "alpha", messageId: run.messageId, dispatch: (await buses.dispatch("alpha", run.messageId))!,
        runtime: Object.assign(createCoreServiceRuntime(), { busRuntime: { delegateToInstance: async () => ({ success: true, text: "finished task", fromInstance: "beta" }) } }), bridge: { handleAuthorizedMessage: vi.fn() } });
      observed.runtime.busRuntime!.agentBusRun!.started();
      await observed.runtime.busRuntime!.delegateToInstance!({ fromInstance: "alpha", targetInstance: "beta", prompt: "task", depth: 0, stateDir: root, agentBusMemberIndex: 0 });
      observed.runtime.busRuntime!.agentBusRun!.outcome("success");
      const started = Date.now();
      await observed.finish();
      expect(Date.now() - started).toBeLessThan(2_000);
      const ack = transport.request("ack", { messageId: run.messageId }); void ack.catch(() => undefined);
      const label = (method: string, params: { type?: string }) => method === "agentBus.event" ? params.type : method;
      const order = ["run.started", "stage.started", "stage.finished", "run.finished", "ack"];
      await vi.waitFor(async () => expect(JSON.parse(await readFile(path.join(root, "worker", "gateway-outbox.json"), "utf8")).requests.map((r: { method: string; params: { type?: string } }) => label(r.method, r.params))).toEqual(order));
      await vi.waitFor(() => expect(received.map(r => label(r.method, r.params))).toEqual(order));
      // The Hub handles one socket's requests in arrival order.
      for (const frame of received) {
        if (frame.method === "ack") { await store.acknowledgeDelivery("alpha", run.messageId); await buses.settleDelivery("alpha", run.messageId); }
        else await buses.event("alpha", frame.params);
      }
      expect((await buses.detail("owner", bus.id)).runs[0]).toMatchObject({ status: "completed", stages: [expect.objectContaining({ botId: "beta", status: "completed" })] });
    } finally {
      await transport.disconnect(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));
      await store.db.close(); await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Agent Bus runs through the real Gateway and local Bus", () => {
  let root: string, hub: HubServer, channel: GatewayChannel | undefined, runtime: CoreServiceRuntime;
  const secrets = new Map<string, string>(), engines = new Map<string, Engine>(), calls = new Map<string, Turn[]>();
  const listeners: { stop: () => Promise<void> }[] = [];
  const dir = (id: string) => path.join(root, "bots", id);
  const engine = (id: string): CoreBridgeLike["handleAuthorizedMessage"] => vi.fn(async (input: Turn) => {
    calls.set(id, [...calls.get(id) ?? [], input]);
    return engines.get(id)!(input);
  }) as unknown as CoreBridgeLike["handleAuthorizedMessage"];
  const attach = async () => {
    channel = await attachGateway({ stateDir: dir("alpha"), botId: "alpha", secret: secrets.get("alpha")!, engine: "codex",
      url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime, bridge: { handleAuthorizedMessage: engine("alpha") } });
    await until(async () => (await hub.store.bots("owner")).find(bot => bot.id === "alpha")?.online === 1);
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "gateway-agent-bus-"));
    hub = await HubServer.start({ stateDir: path.join(root, "hub") });
    runtime = createCoreServiceRuntime();
    calls.clear();
    for (const id of ids) {
      secrets.set(id, randomBytes(32).toString("base64url"));
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id[0]!.toUpperCase() + id.slice(1), hashSecret(secrets.get(id)!)]);
      await hub.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]);
      await mkdir(dir(id), { recursive: true });
      await writeFile(path.join(dir(id), "config.json"), JSON.stringify({ engine: "codex", locale: "en", approvalMode: "bypass", bus: { peers: ids.filter(peer => peer !== id), secret: randomBytes(32).toString("hex") } }));
      engines.set(id, async input => ({ text: `${id} says: ${firstLine(input.text)}`, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } }));
      if (id !== "alpha") listeners.push((await startGatewayBus(dir(id), id, { handleAuthorizedMessage: engine(id) }))!);
    }
    engines.set("alpha", async input => input.sessionIdOverride?.startsWith("tarobot-crew-")
      ? { text: "Question one\nQuestion two" } : { text: `alpha own answer: ${firstLine(input.text)}`, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.02 } });
    engines.set("epsilon", async () => ({ text: "VERDICT: PASS\nISSUES: none" }));
    await attach();
  });
  afterEach(async () => {
    await channel?.disconnect(); channel = undefined;
    for (const listener of listeners.splice(0)) await listener.stop();
    await hub.close(); await rm(root, { recursive: true, force: true });
  });

  const messages = async (conversationId: string): Promise<Message[]> => (await hub.store.listMessages("owner", conversationId)).messages;
  const transcript = async (conversationId: string) => (await messages(conversationId)).filter(m => m.authorType === "bot").map(m => blocksText(m.blocks)).join("\n");
  const detail = (id: string): Promise<AgentBusDetail> => hub.agentBuses.detail("owner", id);
  async function start(mode: AgentBusConfig["mode"], members: string[], text: string, tag: string = mode, maxResearchQuestions = 2) {
    const bus = await hub.agentBuses.create("owner", { requestId: `create-${tag}`, config: { name: `Bus ${tag}`, mode, coordinator: { botId: "alpha" }, members: members.map(botId => ({ botId })), maxResearchQuestions, maxRevisionRounds: 1 } });
    const run = await hub.agentBuses.start("owner", bus.id, { requestId: `run-${tag}`, revision: bus.revision, text });
    return { bus, run };
  }
  async function finished(busId: string) {
    await until(async () => { const run = (await detail(busId)).runs[0]; return !!run && !agentBusIsActive(run.status); });
    // The input is acknowledged after the terminal report.
    await until(async () => (await hub.store.pendingForBot("alpha")).length === 0 && !channel!.isBusy());
    return (await detail(busId)).runs[0]!;
  }
  async function expectRecord(conversationId: string, botId: string, content: string, status: Message["status"] = "complete") {
    const records = await messages(conversationId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ authorType: "bot", authorId: botId, status });
    expect(blocksText(records[0]!.blocks)).toContain(content);
  }

  it("rejects a v2 worker before it receives any v3 task or loops on a strict frame parser", async () => {
    await channel!.disconnect(); channel = undefined;
    await until(async () => (await hub.store.bots("owner")).find(bot => bot.id === "alpha")?.online === 0);
    const bus = await hub.agentBuses.create("owner", { requestId: "v3-create", config: {
      name: "New task on old worker", mode: "ask", coordinator: { botId: "alpha" }, members: [{ botId: "beta", instruction: "Research task" }],
    } });
    const queued = await hub.agentBuses.start("owner", bus.id, { requestId: "v3-run", revision: bus.revision, text: "shared goal" });
    const frames: any[] = [], old = new WebSocket(hub.instanceUrl.replace("http", "ws") + "/instance");
    old.on("message", data => frames.push(JSON.parse(data.toString())));
    try {
      await once(old, "open");
      old.send(JSON.stringify({ v: 1, type: "instance.hello", botId: "alpha", secret: secrets.get("alpha"), engine: "codex", model: "test", effort: "high", capabilities: ["agent-bus.runs.v2"] }));
      await until(async () => (await detail(bus.id)).runs[0]?.status === "failed");
      expect((await detail(bus.id)).runs[0]).toMatchObject({ id: queued.id, error: "agent_bus_worker_update_required" });
      expect(frames.filter(frame => frame.type === "instance.message")).toHaveLength(0);
      expect(old.readyState).toBe(WebSocket.OPEN);
      await expect(hub.agentBuses.start("owner", bus.id, { requestId: "v3-new", revision: bus.revision, text: "shared goal" })).rejects.toThrow("agent_bus_worker_update_required");
      expect(calls.size).toBe(0);
    } finally { old.close(); await once(old, "close"); }
  });

  it.each(["ask", "verify", "chain", "fan"] as const)("%s: supports coordinator Bot in separate conversation slots without self grants", async mode => {
    // No network collaboration is enabled at all: these are owner-authorized
    // local roles, not self delegation through the Bus listener.
    const saved = JSON.parse(await readFile(path.join(dir("alpha"), "config.json"), "utf8"));
    await writeFile(path.join(dir("alpha"), "config.json"), JSON.stringify({ ...saved, bus: false }));
    const members = mode === "ask" || mode === "verify" ? ["alpha"] : ["alpha", "alpha"];
    const { bus } = await start(mode, members, "local role task", `local-${mode}`);
    const run = await finished(bus.id);
    expect(run.status).toBe("completed");
    for (const member of bus.members) {
      await expectRecord(member.conversationId, "alpha", "alpha own answer");
      expect(run.stages.filter(stage => stage.conversationId === member.conversationId)).toHaveLength(1);
    }
    const turns = calls.get("alpha")!;
    expect(turns).toHaveLength(members.length + (mode === "fan" || mode === "verify" ? 1 : 0));
    expect(new Set(turns.map(turn => turn.sessionIdOverride)).size).toBe(turns.length);
    expect(new Set(turns.map(turn => turn.conversationKey)).size).toBe(turns.length);
    for (const turn of turns.filter(turn => turn.chatType === "bus")) expect(turn.conversationKey).toMatch(/^agent-bus-local:/);
    expect((await new UsageStore(dir("alpha")).load()).totalCostUsd).toBeCloseTo(0.02 * turns.length);
  });

  it("fan: eleven slots on one Bot respect its Bus admission capacity", async () => {
    let active = 0, maximum = 0;
    engines.set("beta", async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 30)); active--; return { text: "bounded result" }; });
    const { bus } = await start("fan", Array(11).fill("beta"), "full fan", "repeat-full-fan");
    const run = await finished(bus.id);
    expect(run.status).toBe("completed"); expect(calls.get("beta")).toHaveLength(11);
    expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThanOrEqual(4);
    for (const member of bus.members) await expectRecord(member.conversationId, "beta", "bounded result");
  });

  it("fan: repeated remote Bot replies finishing in reverse order stay in their own chats", async () => {
    let release!: () => void; const first = new Promise<void>(resolve => { release = resolve; });
    // Socket arrival order is not workflow order. Mark the outgoing prompt at
    // the delegate boundary while keeping the real Bus transport and handler.
    runtime.busRuntime = { delegateToInstance: args => delegateToInstance({ ...args, prompt: `${args.prompt}\nslot:${args.agentBusMemberIndex}` }) };
    engines.set("beta", async input => { const slot = Number(/slot:(\d+)/.exec(input.text)![1]); if (slot === 0) await first; else release(); return { text: `slot result ${slot}` }; });
    const { bus } = await start("fan", ["beta", "beta"], "parallel repeat", "repeat-fan");
    const run = await finished(bus.id);
    expect(run.status).toBe("completed");
    await expectRecord(bus.members[0]!.conversationId, "beta", "slot result 0");
    await expectRecord(bus.members[1]!.conversationId, "beta", "slot result 1");
    expect(calls.get("beta")).toHaveLength(2);
    expect(new Set(calls.get("beta")!.map(turn => turn.sessionIdOverride)).size).toBe(2);
  });

  it("crew: one Bot fills all four roles with separate records across revision rounds", async () => {
    let reviews = 0;
    engines.set("beta", async input => ({ text: input.text.includes("VERDICT") ? (++reviews === 1 ? "VERDICT: REVISE\nISSUES: improve draft" : "VERDICT: PASS\nISSUES: none") : "Role output" }));
    const { bus } = await start("crew", ["beta", "beta", "beta", "beta"], "Repeated research team", "repeat-crew");
    const run = await finished(bus.id);
    expect(run.status).toBe("completed");
    for (const member of bus.members) expect((await messages(member.conversationId)).length).toBeGreaterThan(0);
    expect(run.stages.filter(stage => stage.conversationId === bus.members[0]!.conversationId)).toHaveLength(2);
    expect(run.stages.filter(stage => stage.conversationId === bus.members[1]!.conversationId)).toHaveLength(1);
    expect(run.stages.filter(stage => stage.conversationId === bus.members[2]!.conversationId)).toHaveLength(2);
    expect(run.stages.filter(stage => stage.conversationId === bus.members[3]!.conversationId)).toHaveLength(2);
  });

  it("ask: delegates to one member and records only that member's real output", async () => {
    const { bus } = await start("ask", ["beta"], "Summarise the release notes");
    const run = await finished(bus.id);
    expect(run.status).toBe("completed");
    expect(run.stages.map(stage => [stage.botId, stage.status])).toEqual([["beta", "completed"]]);
    expect(calls.get("beta")?.[0]).toMatchObject({ chatType: "bus", text: "Summarise the release notes" });
    expect(calls.get("beta")?.[0]?.sessionIdOverride).toMatch(/^tarobot-bus-/);
    await expectRecord(bus.members[0]!.conversationId, "beta", "beta says: Summarise the release notes");
    expect(run.stages[0]!.messageId).toBe((await messages(bus.members[0]!.conversationId))[0]!.id);
    expect(await transcript(bus.coordinator.conversationId)).toContain("beta says: Summarise the release notes");
  });

  it("fan: runs the coordinator and every member, each output in its own chat", async () => {
    const { bus } = await start("fan", ["beta", "gamma"], "Pick a database");
    const run = await finished(bus.id);
    expect(run.status).toBe("completed");
    expect(run.stages.map(stage => stage.botId).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(run.stages.every(stage => stage.status === "completed")).toBe(true);
    expect(run.stages.find(stage => stage.botId === "alpha")).toMatchObject({ conversationId: bus.coordinator.conversationId });
    expect(run.stages.find(stage => stage.botId === "alpha")!.messageId).toBeUndefined();
    // Every step of a Bus run, including the coordinator's own answer, uses an
    // independent temporary session rather than the coordinator chat's history.
    expect(calls.get("alpha")).toHaveLength(1);
    expect(calls.get("alpha")![0]!.sessionIdOverride).toMatch(/^tarobot-bus-/);
    expect(run.snapshot.members.map(member => member.botId)).toEqual(["beta", "gamma"]);
    await expectRecord(bus.members[0]!.conversationId, "beta", "beta says: Pick a database");
    await expectRecord(bus.members[1]!.conversationId, "gamma", "gamma says: Pick a database");
    const coordinator = await transcript(bus.coordinator.conversationId);
    for (const part of ["alpha own answer: Pick a database", "beta says", "gamma says"]) expect(coordinator).toContain(part);
    // Each Bot's Bus turn and the coordinator's own answer are billed once, by their owner.
    expect((await new UsageStore(dir("beta")).load()).totalCostUsd).toBeCloseTo(0.01);
    expect((await new UsageStore(dir("gamma")).load()).totalCostUsd).toBeCloseTo(0.01);
    expect((await new UsageStore(dir("alpha")).load()).totalCostUsd).toBeCloseTo(0.02);
  });

  it("chain: passes each real stage output to the next member in order", async () => {
    const { bus } = await start("chain", ["beta", "gamma"], "Draft a migration plan");
    const run = await finished(bus.id);
    expect(run.status).toBe("completed");
    expect(run.stages.map(stage => [stage.id, stage.botId, stage.status])).toEqual([["s1", "beta", "completed"], ["s2", "gamma", "completed"]]);
    expect(calls.get("gamma")?.[0]?.text).toContain("beta says: Draft a migration plan");
    await expectRecord(bus.members[1]!.conversationId, "gamma", "gamma says: Original prompt: Draft a migration plan");
    expect(JSON.stringify((await messages(bus.members[1]!.conversationId))[0]!.blocks)).toContain("beta says: Draft a migration plan");
  });

  it.each(["ask", "fan", "chain", "verify", "crew"] as const)("%s: failed artifact delivery fails the run without retrying completed work or delivered files", async mode => {
    const author = mode === "crew" ? "delta" : "beta";
    const file = path.join(dir(author), "workspace", "valuation.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "completed valuation artifact");
    engines.set(author, async () => ({ text: `Completed valuation.\n[send-file:${file}]\n[send-file:${file}.missing]` }));
    const members = mode === "crew" ? ["beta", "gamma", "delta", "epsilon"] : ["beta"];
    const { bus } = await start(mode, members, "Create and deliver the valuation file", `delivery-${mode}`, 1);
    const run = await finished(bus.id);
    expect(run).toMatchObject({ status: "failed", error: "agent_bus_output_not_delivered" });
    // Execution completed; a later delivery failure must not rewrite its evidence.
    expect(run.stages.length).toBeGreaterThan(0);
    expect(run.stages.every(stage => stage.status === "completed")).toBe(true);
    for (const member of members) expect(calls.get(member)).toHaveLength(1);
    const replies = await messages(bus.coordinator.conversationId);
    const files = replies.flatMap(message => message.blocks.filter(block => block.type === "file"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "valuation.txt", size: 28 });
    expect(await transcript(bus.coordinator.conversationId)).toContain("File was not sent: the file does not exist");
  });

  it("chain: keeps a fully delivered artifact successful", async () => {
    const file = path.join(dir("beta"), "workspace", "valuation.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "completed valuation artifact");
    engines.set("beta", async () => ({ text: `Completed valuation. [send-file:${file}]` }));
    const { bus } = await start("chain", ["beta"], "Deliver the valuation file", "delivery-success");
    expect((await finished(bus.id)).status).toBe("completed");
    expect((await messages(bus.coordinator.conversationId)).flatMap(message => message.blocks.filter(block => block.type === "file"))).toHaveLength(1);
    expect(calls.get("beta")).toHaveLength(1);
  });

  it("chain: a member artifact outside coordinator permissions fails delivery without widening access", async () => {
    const config = JSON.parse(await readFile(path.join(dir("alpha"), "config.json"), "utf8"));
    config.approvalMode = "normal";
    await writeFile(path.join(dir("alpha"), "config.json"), JSON.stringify(config));
    const file = path.join(dir("beta"), "workspace", "private-valuation.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "member artifact");
    engines.set("beta", async () => ({ text: `Completed valuation. [send-file:${file}]` }));
    const { bus } = await start("chain", ["beta"], "Deliver the valuation file", "delivery-permission");
    const run = await finished(bus.id);
    expect(run).toMatchObject({ status: "failed", error: "agent_bus_output_not_delivered" });
    expect(run.stages).toEqual([expect.objectContaining({ botId: "beta", status: "completed" })]);
    expect((await messages(bus.coordinator.conversationId)).flatMap(message => message.blocks.filter(block => block.type === "file"))).toEqual([]);
    expect(await transcript(bus.coordinator.conversationId)).toContain("outside the allowed directories");
    expect(calls.get("beta")).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(dir("alpha"), "config.json"), "utf8")).approvalMode).toBe("normal");
  });

  it("chain: a coordinator Bot research slot runs before a different Bot valuation slot", async () => {
    engines.set("alpha", async input => {
      expect(input.text).toContain("Research only; gather sources");
      expect(input.text).not.toContain("Build the valuation model");
      return { text: "RESEARCH_DELIVERABLE: verified figures and sources" };
    });
    engines.set("beta", async input => {
      expect(input.text).toContain("Build the valuation model");
      expect(input.text).toContain("RESEARCH_DELIVERABLE: verified figures and sources");
      return { text: "VALUATION_DELIVERABLE" };
    });
    const bus = await hub.agentBuses.create("owner", { requestId: "create-step-tasks", config: {
      name: "Research then valuation", mode: "chain", coordinator: { botId: "alpha" },
      members: [{ botId: "alpha", instruction: "Research only; gather sources" }, { botId: "beta", instruction: "Build the valuation model" }],
    } });
    await hub.agentBuses.start("owner", bus.id, { requestId: "run-step-tasks", revision: bus.revision, text: "Research Sample Company and value it" });
    const run = await finished(bus.id);
    expect(run.status).toBe("completed");
    expect(run.stages.map(stage => [stage.botId, stage.conversationId, stage.status])).toEqual(bus.members.map(member => [member.botId, member.conversationId, "completed"]));
    expect(calls.get("alpha")).toHaveLength(1); expect(calls.get("beta")).toHaveLength(1);
    await expectRecord(bus.members[0]!.conversationId, "alpha", "RESEARCH_DELIVERABLE");
    await expectRecord(bus.members[1]!.conversationId, "beta", "VALUATION_DELIVERABLE");
    const card = (await messages(bus.members[1]!.conversationId))[0]!.blocks[0]!;
    expect(card.type === "card" && card.elements).toContainEqual({ type: "collapsible", text: "本环节任务", open: true, children: [{ type: "markdown", text: "Build the valuation model" }] });
    expect(await transcript(bus.coordinator.conversationId)).toContain("VALUATION_DELIVERABLE");
  });

  it("verify: keeps the coordinator answer and the reviewer's real verdict", async () => {
    const { bus } = await start("verify", ["beta"], "Is 97 prime?");
    const run = await finished(bus.id);
    expect(run.status).toBe("completed");
    expect(run.stages.map(stage => [stage.botId, stage.status])).toEqual([["alpha", "completed"], ["beta", "completed"]]);
    expect(calls.get("beta")?.[0]?.text).toContain("alpha own answer: Is 97 prime?");
    expect(calls.get("alpha")?.[0]?.sessionIdOverride).toMatch(/^tarobot-bus-/);
    await expectRecord(bus.members[0]!.conversationId, "beta", "beta says: Please verify");
    const coordinator = await transcript(bus.coordinator.conversationId);
    expect(coordinator).toContain("alpha own answer: Is 97 prime?");
    expect(coordinator).toContain("Verification by beta");
  });

  it.each(["fan", "verify", "crew"] as const)("%s: executes coordinator and repeated-Bot role instructions through the real Gateway", async mode => {
    const instructions = (mode === "crew" ? ["research", "analysis", "writing", "review"] : mode === "fan" ? ["first", "second"] : ["review"])
      .map(role => `TASK_${role}`);
    let reviews = 0;
    engines.set("alpha", async input => {
      expect(input.text.split("\n")[1]).toBe("TASK_coordinator");
      return { text: mode === "crew" ? "Question one\nQuestion two" : "COORDINATOR_RESULT" };
    });
    engines.set("beta", async input => {
      const task = input.text.split("\n")[1];
      expect(instructions).toContain(task);
      if (task === "TASK_review") return { text: mode === "crew" && ++reviews === 1 ? "VERDICT: REVISE\nISSUES: clarify" : "VERDICT: PASS\nISSUES: none" };
      return { text: "STAGE_RESULT" };
    });
    const bus = await hub.agentBuses.create("owner", { requestId: "create-role-tasks", config: {
      name: "Role task routing", mode, coordinator: { botId: "alpha", instruction: "TASK_coordinator" },
      members: instructions.map(instruction => ({ botId: "beta", instruction })), maxResearchQuestions: 2, maxRevisionRounds: 1,
    } });
    await hub.agentBuses.start("owner", bus.id, { requestId: "run-role-tasks", revision: bus.revision, text: "SHARED_GOAL" });
    const run = await finished(bus.id);
    expect(run.status).toBe("completed");
    expect(calls.get("alpha")).toHaveLength(1);
    for (const member of bus.members) {
      const records = await messages(member.conversationId);
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        const card = record.blocks[0]!;
        expect(card.type === "card" && card.elements).toContainEqual({ type: "collapsible", text: "本环节任务", open: true, children: [{ type: "markdown", text: member.instruction }] });
      }
    }
    if (mode === "crew") {
      expect(calls.get("beta")!.map(turn => turn.text.split("\n")[1]).sort()).toEqual([
        "TASK_research", "TASK_research", "TASK_analysis", "TASK_writing", "TASK_writing", "TASK_review", "TASK_review",
      ].sort());
    } else expect(calls.get("beta")!.map(turn => turn.text.split("\n")[1]).sort()).toEqual([...instructions].sort());
  });

  it("crew: runs a task-local research crew without enabling or changing the Bot's saved crew", async () => {
    const before = await readFile(path.join(dir("alpha"), "config.json"), "utf8");
    const { bus } = await start("crew", ["beta", "gamma", "delta", "epsilon"], "Research solid-state batteries");
    const run = await finished(bus.id);
    expect(run.status).toBe("completed");
    const roles = run.stages.map(stage => stage.botId);
    expect(roles.filter(id => id === "beta")).toHaveLength(2);
    for (const id of ["alpha", "gamma", "delta", "epsilon"]) expect(roles).toContain(id);
    expect(run.stages.every(stage => stage.status === "completed")).toBe(true);
    expect(await readFile(path.join(dir("alpha"), "config.json"), "utf8")).toBe(before);
    expect(await messages(bus.members[0]!.conversationId)).toHaveLength(2);
    await expectRecord(bus.members[3]!.conversationId, "epsilon", "VERDICT: PASS");
    // An ordinary message to the coordinator is still an ordinary chat turn.
    const chat = await hub.store.createConversation("owner", ["alpha"], "Plain", "plain-chat");
    const turns = calls.get("alpha")!.length;
    await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "plain", text: "Research solid-state batteries", attachments: [] });
    await until(async () => calls.get("alpha")!.length === turns + 1 && (await hub.store.pendingForBot("alpha")).length === 0);
    expect(calls.get("alpha")!.at(-1)?.sessionIdOverride).toBeUndefined();
    expect(await transcript(chat.id)).not.toContain("research-report");
  });

  it("records an explicitly stopped research crew as cancelled rather than a team failure", async () => {
    engines.set("beta", input => new Promise((_, reject) => {
      if (input.abortSignal?.aborted) reject(new Error("aborted"));
      else input.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const { bus, run: queued } = await start("crew", ["beta", "gamma", "delta", "epsilon"], "Stop this research", "crew-stop");
    await until(async () => (await detail(bus.id)).runs[0]!.stages.some(stage => stage.botId === "beta" && stage.status === "running"));
    await hub.agentBuses.stop("owner", bus.id, queued.id, { requestId: "stop-crew" });
    expect((await finished(bus.id)).status).toBe("cancelled");
    const text = await transcript(bus.coordinator.conversationId);
    expect(text).toContain("Research crew stopped.");
    expect(text).not.toContain("Crew execution failed");
    expect(calls.get("gamma")).toBeUndefined();
    const saved = await new CrewRunStore(dir("alpha")).inspectLatest();
    expect(saved.run?.status).toBe("cancelled");
    expect(Object.values(saved.run?.stages ?? {}).some(stage => stage?.status === "cancelled")).toBe(true);
    const timeline = parseTimelineEvents(await readFile(path.join(dir("alpha"), "timeline.log.jsonl"), "utf8"));
    expect(timeline.some(event => event.type === "crew.run.cancelled" && event.outcome === "stopped")).toBe(true);
    expect(summarizeTimelineEvents(timeline).crewRunsFailedCount).toBe(0);
  });

  it.each([[8, false, false], [10, false, false], [10, true, false], [8, false, true]] as const)("stops a %s-question crew without inventing stages; partial findings=%s, delayed cancellation=%s", async (questionCount, partial, delayed) => {
    engines.set("alpha", async () => ({ text: Array.from({ length: questionCount }, (_, i) => `Question ${i + 1}`).join("\n") }));
    const pending: (() => void)[] = [];
    engines.set("beta", input => new Promise((resolve, reject) => {
      pending.push(() => resolve({ text: "KEPT_RESEARCH_FINDING" }));
      if (input.abortSignal?.aborted) reject(new Error("aborted"));
      else input.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    let release!: () => void, cancelling = 0;
    const drain = new Promise<void>(resolve => { release = resolve; });
    if (delayed) runtime.busRuntime = { delegateToInstance: async args => {
      try { return await delegateToInstance(args); }
      catch (error) {
        // Keep three admitted delegate promises pending after the first rejects.
        // The workflow must drain them before it persists its terminal state.
        if (++cancelling > 1) await drain;
        throw error;
      }
    } };
    try {
      const { bus, run: queued } = await start("crew", ["beta", "gamma", "delta", "epsilon"], "Bounded stopped research", "bounded-stop", questionCount);
      await until(async () => calls.get("beta")?.length === 4);
      if (partial) {
        pending[0]!();
        // One result is already recorded and its worker admits one replacement
        // before Stop. All five admitted stages are real and must be retained.
        await until(async () => calls.get("beta")?.length === 5 && (await detail(bus.id)).runs[0]!.stages.some(stage => stage.botId === "beta" && stage.status === "completed"));
      }
      await hub.agentBuses.stop("owner", bus.id, queued.id, { requestId: "stop-bounded" });
      if (delayed) {
        await until(async () => cancelling === 4 && (await detail(bus.id)).runs[0]!.stages.some(stage => stage.botId === "beta" && stage.status === "cancelled"));
        expect((await detail(bus.id)).runs[0]!.status).toBe("stopping");
        expect(channel!.isBusy()).toBe(true);
        expect((await new CrewRunStore(dir("alpha")).inspectLatest()).run!.status).toBe("running");
        release();
      }
      const run = await finished(bus.id), admitted = partial ? 5 : 4;
      expect(run.status).toBe("cancelled");
      expect(calls.get("beta")).toHaveLength(admitted);
      expect.soft(run.stages.filter(stage => stage.botId === "beta")).toHaveLength(admitted);
      expect.soft(await messages(bus.members[0]!.conversationId)).toHaveLength(admitted);
      for (const member of bus.members.slice(1)) {
        expect(calls.get(member.botId)).toBeUndefined();
        expect.soft(run.stages.some(stage => stage.botId === member.botId)).toBe(false);
        expect.soft(await messages(member.conversationId)).toEqual([]);
      }
      const saved = (await new CrewRunStore(dir("alpha")).inspectLatest()).run!;
      expect.soft(saved).toMatchObject({ status: "cancelled", currentStage: "research", stages: { research: { status: "cancelled", findings: partial ? ["KEPT_RESEARCH_FINDING"] : [], failedQuestions: [] } } });
      expect.soft(saved.stages.analysis).toBeUndefined();
      expect(run.stages.filter(stage => stage.botId === "beta" && stage.status === "completed")).toHaveLength(partial ? 1 : 0);
      const timeline = parseTimelineEvents(await readFile(path.join(dir("alpha"), "timeline.log.jsonl"), "utf8"));
      expect.soft(timeline.some(event => event.type === "crew.stage.completed" && event.metadata?.stage === "research")).toBe(false);
      expect.soft(timeline.some(event => event.type === "crew.stage.started" && event.metadata?.stage === "analysis")).toBe(false);
      const text = await transcript(bus.coordinator.conversationId);
      expect(text).toContain("Research crew stopped.");
      expect.soft(text).not.toContain("Research stage completed");
      expect.soft(text).not.toContain("Analysis stage...");
    } finally { release(); }
  }, 20_000);

  it.each([
    ["decomposition", 0, "beta", 0, "Research stage:"],
    ["analysis", 0, "delta", 0, "Writing stage..."],
    ["writing", 0, "epsilon", 0, "Review stage..."],
    ["review", 0, "delta", 1, "Reviewer flagged issues"],
    ["writing", 1, "epsilon", 1, ""],
  ] as const)("stops after the %s result (revision %s) before announcing or starting the next stage", async (stage, revision, nextBot, nextCalls, nextNotice) => {
    engines.set("epsilon", async () => ({ text: "VERDICT: REVISE\nISSUES: clarify the draft" }));
    let active: Awaited<ReturnType<typeof start>> | undefined, stopped = false;
    const update = CrewRunStore.prototype.update;
    const spy = vi.spyOn(CrewRunStore.prototype, "update").mockImplementation(async function(this: CrewRunStore, runId, mutate) {
      const saved = await update.call(this, runId, mutate);
      if (!stopped && saved?.currentStage === stage && saved.stages[stage]?.status === "completed" && (stage !== "writing" || saved.stages.writing?.revisionCount === revision)) {
        stopped = true;
        expect(active).toBeDefined();
        await hub.agentBuses.stop("owner", active!.bus.id, active!.run.id, { requestId: "stop-at-boundary" });
        // Deliver the same live stop handler before this awaited store update
        // returns to the workflow, making the inter-stage race deterministic.
        channel!.onAgentBusStopRequested!(active!.run.id);
      }
      return saved;
    });
    try {
      active = await start("crew", ["beta", "gamma", "delta", "epsilon"], "Stop at the stage boundary", "boundary-stop");
      expect((await finished(active.bus.id)).status).toBe("cancelled");
      expect(stopped).toBe(true);
      expect(calls.get(nextBot) ?? []).toHaveLength(nextCalls);
      const text = await transcript(active.bus.coordinator.conversationId);
      if (nextNotice) expect(text).not.toContain(nextNotice);
      expect((await new CrewRunStore(dir("alpha")).inspectLatest()).run).toMatchObject({ status: "cancelled", currentStage: stage, stages: { [stage]: { status: "completed" } } });
    } finally { spy.mockRestore(); }
  }, 20_000);

  it("records a composer Stop between Crew stages as cancelled without a cancelled stage", async () => {
    let active: Awaited<ReturnType<typeof start>> | undefined, stopped = false;
    const update = CrewRunStore.prototype.update;
    const spy = vi.spyOn(CrewRunStore.prototype, "update").mockImplementation(async function(this: CrewRunStore, runId, mutate) {
      const saved = await update.call(this, runId, mutate);
      if (!stopped && saved?.currentStage === "decomposition" && saved.stages.decomposition?.status === "completed") {
        stopped = true;
        expect(active).toBeDefined();
        const live = runtime.activeRuns.get(buildCoreConversationKey(active!.bus.coordinator.conversationId));
        expect(live).toBeDefined();
        // This is the Gateway RPC used by the chat composer, not agentBus.stop.
        expect(await channel!.onCall!("stop", { conversationId: active!.bus.coordinator.conversationId, userId: "owner" })).toEqual({ stopped: true });
        expect(live!.abortController.signal.aborted).toBe(true);
      }
      return saved;
    });
    try {
      active = await start("crew", ["beta", "gamma", "delta", "epsilon"], "Stop from the originating chat", "composer-boundary-stop");
      const run = await finished(active.bus.id);
      expect(stopped).toBe(true);
      expect(run.stages).toEqual([expect.objectContaining({ botId: "alpha", status: "completed" })]);
      expect(calls.get("beta")).toBeUndefined();
      expect(await hub.store.db.get("SELECT stop_requested FROM agent_bus_runs WHERE id=?", [run.id])).toEqual({ stop_requested: 0 });
      expect(await transcript(active.bus.coordinator.conversationId)).toContain("Research crew stopped.");
      expect((await new CrewRunStore(dir("alpha")).inspectLatest()).run).toMatchObject({ status: "cancelled", currentStage: "decomposition", stages: { decomposition: { status: "completed" } } });
      expect(run.status).toBe("cancelled");
      expect(run.error).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it("stops one dispatched run through its own controller and never starts later stages", async () => {
    engines.set("beta", input => new Promise((_, reject) => input.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const { bus, run: queued } = await start("chain", ["beta", "gamma"], "Long chain", "stop");
    await until(async () => (await detail(bus.id)).runs[0]!.stages.some(stage => stage.botId === "beta" && stage.status === "running"));
    // The real run belongs to the coordinator's chat. The member's record chat
    // holds only a streaming record whose stage extra says "running".
    const live = (conversationId: string) => runtime.activeRuns.has(buildCoreConversationKey(conversationId)) || runtime.concurrentRuns.has(buildCoreConversationKey(conversationId));
    expect(live(bus.coordinator.conversationId)).toBe(true);
    expect(live(bus.members[0]!.conversationId)).toBe(false);
    const running = await messages(bus.members[0]!.conversationId);
    expect(running.map(m => m.status)).toEqual(["streaming"]);
    expect(JSON.stringify(running[0]!.blocks)).toContain('"status":"running"');
    expect(await hub.agentBuses.stop("owner", bus.id, queued.id, { requestId: "stop" })).toMatchObject({ status: "stopping" });
    const run = await finished(bus.id);
    expect(run).toMatchObject({ status: "cancelled" });
    expect(run.stages).toEqual([expect.objectContaining({ botId: "beta", status: "cancelled" })]);
    expect(calls.get("gamma")).toBeUndefined();
    await expectRecord(bus.members[0]!.conversationId, "beta", "已停止", "complete");
    expect(await transcript(bus.coordinator.conversationId)).toContain("Chain stopped.");
  });

  it("replays an abandoned stop after reconnect only to the exact still-processing run", async () => {
    let aborted = 0;
    engines.set("beta", input => new Promise((_, reject) => input.abortSignal?.addEventListener("abort", () => { aborted++; reject(new Error("aborted")); }, { once: true })));
    const { bus, run } = await start("chain", ["beta", "gamma"], "Disconnected chain", "abandon-reconnect");
    await until(async () => (await detail(bus.id)).runs[0]!.stages.some(stage => stage.botId === "beta" && stage.status === "running"));
    // Even a valid run ID cannot stop a different message owner, nor can a
    // valid input ID stop a different run.
    expect(await channel!.onCall!("agentBus.stop", { runId: run.id, messageId: "msg_wrong", onlyIfProcessing: true })).toEqual({ ok: true, live: false });
    expect(await channel!.onCall!("agentBus.stop", { runId: "abr_wrong", messageId: run.messageId, onlyIfProcessing: true })).toEqual({ ok: true, live: false });
    expect(aborted).toBe(0);
    const transport = channel!.transport as unknown as { ws: WebSocket; open(): void };
    // Keep the real Gateway process and its active delegate alive while its
    // socket is down; unlike channel.disconnect(), this is not a worker stop.
    const paused = vi.spyOn(transport, "open").mockImplementation(() => {});
    const onCall = vi.spyOn(channel!, "onCall");
    try {
      transport.ws.terminate();
      await until(async () => (await hub.store.bots("owner")).find(bot => bot.id === "alpha")?.online === 0 && paused.mock.calls.length === 1);
      await hub.agentBuses.stop("owner", bus.id, run.id, { requestId: "stop-offline" });
      expect(await hub.agentBuses.stop("owner", bus.id, run.id, { requestId: "abandon-offline", abandon: true })).toMatchObject({ status: "interrupted", error: "agent_bus_wait_abandoned" });
      expect(aborted).toBe(0);
      expect(await hub.store.db.get("SELECT status,dispatched FROM deliveries WHERE message_id=?", [run.messageId])).toEqual({ status: "failed", dispatched: 1 });
      paused.mockRestore(); transport.open();
      await until(async () => aborted === 1, 3_000);
      await until(async () => !channel!.isBusy());
      expect(onCall.mock.calls.filter(([method]) => method === "agentBus.stop")).toEqual([["agentBus.stop", { runId: run.id, messageId: run.messageId, onlyIfProcessing: true }]]);
      expect(calls.get("beta")).toHaveLength(1);
      expect(calls.get("gamma")).toBeUndefined();
      expect((await detail(bus.id)).runs[0]).toMatchObject({ status: "interrupted", error: "agent_bus_wait_abandoned" });
      // A second reconnect may resubmit the fence, but a completed input must
      // not create an early stop or cancel a different/current task.
      transport.ws.terminate();
      await until(async () => onCall.mock.calls.filter(([method]) => method === "agentBus.stop").length === 2);
      expect(await onCall.mock.results.filter((_, i) => onCall.mock.calls[i]![0] === "agentBus.stop")[1]!.value).toEqual({ ok: true, live: false });
      expect(aborted).toBe(1);
    } finally { paused.mockRestore(); }
  });

  it("never executes an abandoned input held before Channel admission on reconnect", async () => {
    const bus = await hub.agentBuses.create("owner", { requestId: "create-admission", config: { name: "admission", mode: "ask", coordinator: { botId: "alpha" }, members: [{ botId: "beta" }] } });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    // Hold only the admission barrier a previous input leaves, before the
    // real message listener has opened its AgentBus observer/controller.
    (channel as unknown as { admissions: Map<string, Promise<void>> }).admissions.set(bus.coordinator.conversationId, blocked);
    let failure: unknown;
    const receiptRun = GatewayReceipts.prototype.run;
    const receiptSpy = vi.spyOn(GatewayReceipts.prototype, "run").mockImplementation(function(this: GatewayReceipts, key, operation, ...rest) {
      return receiptRun.call(this, key, async () => { try { return await operation(); } catch (error) { failure = String(error); throw error; } }, ...rest);
    });
    const run = await hub.agentBuses.start("owner", bus.id, { requestId: "run-admission", revision: bus.revision, text: "must not execute" });
    const transport = channel!.transport as unknown as { ws: WebSocket; open(): void };
    const paused = vi.spyOn(transport, "open").mockImplementation(() => {});
    const onCall = vi.spyOn(channel!, "onCall");
    try {
      await until(async () => channel!.isProcessingAgentBus(run.id, run.messageId));
      expect(calls.get("beta")).toBeUndefined();
      transport.ws.terminate();
      await until(async () => (await hub.store.bots("owner")).find(bot => bot.id === "alpha")?.online === 0 && paused.mock.calls.length === 1);
      await hub.agentBuses.stop("owner", bus.id, run.id, { requestId: "stop-admission" });
      await hub.agentBuses.stop("owner", bus.id, run.id, { requestId: "abandon-admission", abandon: true });
      paused.mockRestore(); transport.open();
      await until(async () => onCall.mock.calls.some(([method]) => method === "agentBus.stop"));
      const observedStop = await onCall.mock.results.at(-1)!.value;
      release(); await until(async () => !channel!.isBusy());
      // No controller existed at reconnect. The durable delivery fence still
      // rejects the input before any delegation, so no early-stop is needed.
      expect(observedStop).toEqual({ ok: true, live: false });
      expect(failure).toBe("Error: delivery_already_failed");
      expect(calls.get("beta")).toBeUndefined();
      expect((await detail(bus.id)).runs[0]).toMatchObject({ status: "interrupted", error: "agent_bus_wait_abandoned" });
      expect(await channel!.onCall!("agentBus.stop", { runId: run.id, messageId: run.messageId, onlyIfProcessing: true })).toEqual({ ok: true, live: false });
    } finally { release(); paused.mockRestore(); receiptSpy.mockRestore(); }
  });

  it("reports partial fan failure and Bus permission refusal as failed, never as success", async () => {
    engines.set("gamma", async () => { throw new Error("gamma exploded"); });
    const { bus } = await start("fan", ["beta", "gamma"], "Compare", "partial");
    const run = await finished(bus.id);
    expect(run.status).toBe("failed");
    expect(run.error).toBeTruthy();
    expect(run.stages.find(stage => stage.botId === "beta")?.status).toBe("completed");
    expect(run.stages.find(stage => stage.botId === "gamma")).toMatchObject({ status: "failed", error: expect.stringContaining("gamma exploded") });
    await expectRecord(bus.members[1]!.conversationId, "gamma", "未完成", "error");

    const delta = JSON.parse(await readFile(path.join(dir("delta"), "config.json"), "utf8"));
    await writeFile(path.join(dir("delta"), "config.json"), JSON.stringify({ ...delta, bus: { ...delta.bus, peers: ["beta"] } }));
    const denied = await start("ask", ["delta"], "Not allowed", "denied");
    const refused = await finished(denied.bus.id);
    expect(refused.status).toBe("failed");
    expect(refused.stages[0]).toMatchObject({ botId: "delta", status: "failed" });
    expect(calls.get("delta")).toBeUndefined();
  });

  it("executes the saved command even when the text looks like an approval answer", async () => {
    const resolve = vi.fn(), reject = vi.fn(), timer = setTimeout(() => {}, 60_000);
    const { bus, run: queued } = await start("ask", ["beta"], "/approve req_pending", "approval");
    runtime.pendingApprovals.set("req_pending", { requestId: "req_pending", chatId: bus.coordinator.conversationId, conversationKey: buildCoreConversationKey(bus.coordinator.conversationId), resolve, reject, timer } as never);
    try {
      const run = await finished(bus.id);
      expect(run.id).toBe(queued.id);
      expect(run.status).toBe("completed");
      expect(calls.get("beta")?.[0]?.text).toMatch(/\n\/approve req_pending$/);
      expect(calls.get("beta")?.[0]?.text.startsWith("/")).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
      // Control: the same text as an ordinary owner message is an approval answer.
      await hub.store.sendMessage("owner", { conversationId: bus.coordinator.conversationId, clientMsgId: "control", text: "/approve req_pending", attachments: [] });
      await until(async () => resolve.mock.calls.length === 1);
    } finally { clearTimeout(timer); runtime.pendingApprovals.clear(); }
  });

  it("marks a run interrupted after a worker restart without executing it again", async () => {
    engines.set("beta", input => new Promise((_, reject) => input.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const { bus } = await start("chain", ["beta", "gamma"], "Survive restart", "restart");
    await until(async () => (await detail(bus.id)).runs[0]!.stages.some(stage => stage.status === "running"));
    await channel!.disconnect(); channel = undefined;
    expect(agentBusIsActive((await detail(bus.id)).runs[0]!.status)).toBe(true);
    engines.set("beta", async input => ({ text: `beta says: ${firstLine(input.text)}` }));
    await attach();
    const run = await finished(bus.id);
    expect(run.status).toBe("interrupted");
    expect(calls.get("beta")).toHaveLength(1);
    expect(calls.get("gamma")).toBeUndefined();
    expect(run.stages.every(stage => stage.status !== "running")).toBe(true);
  });
});
