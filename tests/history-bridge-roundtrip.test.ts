import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAdapter, NativeHistoryResult } from "../src/codex/adapter.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import { bootstrapTrusted } from "./helpers/pairing-invite.js";
import type { HistoryAction, HistoryAnchorPage, HistoryOperation, HistorySnapshot } from "../src/client-protocol/conversation-history.js";
import type { Message } from "../src/client-protocol/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("history_roundtrip_condition_timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Only the native provider is scripted. Core admission, Gateway attachment,
 * signed owner routes, Bridge, controller, fsynced receipts and SQLite are real. */
function scriptedNative() {
  const threads = new Map<string, string[]>();
  let sequence = 0, forks = 0;
  const send = vi.fn<NonNullable<CodexAdapter["sendUserMessage"]>>(async (id, input) => {
    const sessionId = id.startsWith("tarobot-") ? `native-source-${threads.size + 1}` : id;
    const turns = threads.get(sessionId) ?? [], inputId = `native-input-${++sequence}`;
    threads.set(sessionId, [...turns, inputId]);
    await input.onEngineEvent?.({ type: "history_anchor", anchor: { sessionId, inputId, rewind: true, fork: true, forkBoundary: "after-turn" } });
    return { sessionId, text: `Fixture reply ${sequence}` };
  });
  const getHistoryState = vi.fn<NonNullable<CodexAdapter["getHistoryState"]>>(async id => {
    const turns = threads.get(id);
    return turns ? { head: turns.at(-1) ?? "empty", fork: { whole: true, anchored: true }, rewind: true } : { head: null, blocked: "source_missing" };
  });
  const forkHistory = vi.fn<NonNullable<CodexAdapter["forkHistory"]>>(async (id, input = {}) => {
    const turns = threads.get(id)!;
    if (input.expectedHead !== (turns.at(-1) ?? "empty")) return { outcome: "rejected", reason: "source_changed" };
    const next = input.anchor ? turns.slice(0, turns.indexOf(input.anchor.inputId) + 1) : [...turns];
    const sessionId = `native-fork-${++forks}`; threads.set(sessionId, next);
    return { outcome: "applied", sessionId, head: next.at(-1) ?? "empty", boundary: input.anchor ? "after-turn" : "whole" };
  });
  const rewindHistory = vi.fn<NonNullable<CodexAdapter["rewindHistory"]>>(async (id, input) => {
    const turns = threads.get(id)!, index = turns.indexOf(input.anchor.inputId);
    if (index < 0) return { outcome: "rejected", reason: "anchor_unavailable" };
    const next = turns.slice(0, index); threads.set(id, next);
    return { outcome: "applied", sessionId: id, head: next.at(-1) ?? "empty", boundary: "before-input", excludedInputIds: turns.slice(index) };
  });
  const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: send, getHistoryState, forkHistory, rewindHistory };
  return { adapter, send, getHistoryState, forkHistory, rewindHistory, threads };
}

async function fixture(adapter: CodexAdapter) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "history-bridge-roundtrip-"));
  const stateDir = path.join(directory, "worker"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
  const hub = await HubServer.start({ stateDir: path.join(directory, "hub") });
  let currentAdapter = adapter;
  let channel: GatewayChannel | undefined, socket: WebSocket | undefined;
  cleanups.push(async () => {
    socket?.terminate(); await channel?.disconnect(); await hub.close(); await currentAdapter.destroy?.();
    // Closing the transport can finish an already accepted read/status callback
    // as the fixture is removed. Tolerate only filesystem teardown contention;
    // no product request or native history operation is retried here.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Fixture',?,'codex')", [hashSecret(secret)]);
  const source = await hub.store.createConversation("owner", ["bot"], "Source", "create_source");
  const keys = generateKeyPairSync("ed25519");
  await bootstrapTrusted(hub.auth, { deviceId: "device", name: "Fixture", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") });
  socket = new WebSocket(hub.url.replace("http", "ws") + "/ws");
  const frames: Array<Record<string, any>> = [];
  socket.on("message", data => { const frame = JSON.parse(data.toString()); frames.push(frame); if (frame.type === "snapshot.message") socket!.send(JSON.stringify({ v: 1, type: "snapshot.ack", id: frame.id, count: frame.index + 1 })); });
  const next = async (type: string) => { await until(async () => frames.some(frame => frame.type === type)); return frames.splice(frames.findIndex(frame => frame.type === type), 1)[0]!; };
  await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
  const nonce = randomBytes(32).toString("base64url");
  socket.send(JSON.stringify({ v: 1, type: "hello", deviceId: "device", nonce, protocolVersions: [1], capabilities: [], cursors: {} }));
  const challenge = await next("challenge");
  socket.send(JSON.stringify({ v: 1, type: "auth", signature: sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64") }));
  const ready = await next("ready"); await next("sync.complete");
  const sessions = new SessionStore(path.join(stateDir, "session.json"));
  const warnings: string[] = [];
  const restart = async (replacement?: CodexAdapter) => {
    await channel?.disconnect();
    if (replacement) { await currentAdapter.destroy?.(); currentAdapter = replacement; }
    const access: AccessStoreLike = { load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [], pairedUsers: [], pendingPairs: [] }), issuePairingCode: vi.fn() };
    const bridge = new Bridge(access, new SessionManager(new SessionStore(sessions.filePath), currentAdapter), currentAdapter);
    channel = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "bot", secret, engine: "codex", bridge,
      runtime: createCoreServiceRuntime(), recoverDeliveries: false, onWarning: warning => warnings.push(warning) });
    await until(async () => (await hub.store.bots("owner"))[0]?.online === 1 && !channel!.isBusy());
    return bridge;
  };
  await restart();
  const api = async <T>(route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${hub.url}${route}`, {
      headers: { Authorization: `Bearer ${ready.sessionToken}` }, ...(body !== undefined ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`history_http_${response.status}:${JSON.stringify(value)}`);
    return value as T;
  };
  const request = <T>(conversationId: string, suffix: string, body?: unknown): Promise<T> => api(`/api/conversations/${conversationId}/history${suffix}`, body);
  let sent = 0;
  const send = async (conversationId: string, text: string) => {
    const { message } = await hub.store.sendMessage("owner", { conversationId, clientMsgId: `input_${++sent}`, text, attachments: [] });
    await until(async () => (await hub.store.pendingForBot("bot")).length === 0 && !channel!.isBusy());
    await until(async () => !!await hub.store.db.get("SELECT 1 FROM history_anchors WHERE message_id=?", [message.id]));
    return message;
  };
  const snapshot = (conversationId = source.id) => request<HistorySnapshot>(conversationId, "?botId=bot");
  const anchors = (messageId: string) => request<HistoryAnchorPage>(source.id, `/anchors?botId=bot&messageId=${messageId}`);
  // While the Gateway still counts the last turn as running, a snapshot answers
  // busy without a native read and so without a revision; wait for an idle one.
  const idleRevision = async () => { let revision: string | undefined; await until(async () => !!(revision = (await snapshot()).revision)); return revision!; };
  const operation = async (requestId: string, action: HistoryAction, revision?: string) => {
    const change = { botId: "bot", requestId, action, expectedRevision: revision ?? await idleRevision() };
    return { change, result: await request<HistoryOperation>(source.id, "/operations", change) };
  };
  return { directory, stateDir, hub, source, sessions, warnings, send, snapshot, anchors, operation, request, api, restart };
}

it("runs actual Gateway/Core/Bridge anchors, persistent forks and rewind projections end to end", async () => {
  const native = scriptedNative(), f = await fixture(native.adapter);
  const one = await f.send(f.source.id, "first input"), two = await f.send(f.source.id, "second input"), three = await f.send(f.source.id, "third input");
  const sourceBinding = (await f.sessions.findByConversationKey(buildCoreConversationKey(f.source.id)))!;
  const sourceId = sourceBinding.codexSessionId, sourceTurns = [...native.threads.get(sourceId)!];
  expect((await f.anchors(two.id)).anchors).toMatchObject([{ messageId: two.id, rewind: true, fork: true, forkBoundary: "after-turn" }]);
  const point = (await f.anchors(two.id)).anchors[0]!;
  const whole = await f.operation("whole", { kind: "fork", scope: "whole" });
  expect(whole.result.state).toBe("applied");
  const branch = await f.operation("point", { kind: "fork", scope: "anchor", anchorId: point.id });
  expect(branch.result.state).toBe("applied");
  const destination = branch.result.destinationConversationId!, destinationKey = buildCoreConversationKey(destination);
  const forkBinding = (await f.sessions.findByConversationKey(destinationKey))!;
  expect(forkBinding.codexSessionId).not.toBe(sourceId);
  expect(native.threads.get(forkBinding.codexSessionId)).toEqual(sourceTurns.slice(0, 2));
  expect(await f.hub.store.db.get("SELECT 1 FROM messages WHERE conversation_id=?", [destination])).toBeUndefined();
  await f.send(destination, "new branch input");
  expect(native.send.mock.calls.at(-1)![0]).toBe(forkBinding.codexSessionId);
  expect(native.threads.get(sourceId)).toEqual(sourceTurns);
  const rewind = await f.operation("rewind", { kind: "rewind", anchorId: point.id });
  expect(rewind.result).toMatchObject({ state: "applied", sourceEventSeq: expect.any(Number) });
  expect(native.threads.get(sourceId)).toEqual(sourceTurns.slice(0, 1));
  expect((await f.hub.store.messageForBot("bot", one.id)).historyContext).toBeUndefined();
  for (const id of [two.id, three.id]) expect((await f.hub.store.messageForBot("bot", id)).historyContext?.excludedBy).toBe(rewind.result.operationId);
  const replies = await f.hub.store.db.all<{ history_json: string | null }>("SELECT history_json FROM messages WHERE reply_to=? AND author_type='bot'", [two.id]);
  expect(replies.length).toBeGreaterThan(0); expect(replies.every(reply => reply.history_json?.includes(rewind.result.operationId))).toBe(true);
  expect((await f.sessions.findByConversationKey(buildCoreConversationKey(f.source.id)))?.historyFence).toBeUndefined();
  expect(await f.request(f.source.id, "/operations", rewind.change)).toEqual(rewind.result);
  expect(native.rewindHistory).toHaveBeenCalledOnce();
  await f.restart();
  await f.send(f.source.id, "new source input after rewind");
  expect(native.send.mock.calls.at(-1)![0]).toBe(sourceId);
  expect(f.warnings).not.toContain("history_anchor_rejected");
}, 30_000);

it("projects an actual accepted steer from its durable Gateway run relation after rewind", async () => {
  const native = scriptedNative();
  native.adapter.steerActiveTurn = vi.fn(async () => true);
  const send = native.send.getMockImplementation()!;
  let entered!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  native.send.mockImplementationOnce(async (...input) => { const result = await send(...input); entered(); await held; return result; });
  const f = await fixture(native.adapter);
  const turn = f.send(f.source.id, "source with live steer");
  let steering!: Message;
  try {
    await admitted;
    const status = await f.api<{ targetId: string }>(`/api/conversations/${f.source.id}/steer?botId=bot`);
    steering = await f.api<Message>(`/api/conversations/${f.source.id}/steer`, { botId: "bot", requestId: "accepted_steer", targetId: status.targetId, text: "follow this correction" });
    expect(steering.blocks).toContainEqual(expect.objectContaining({ type: "steering", outcome: "accepted" }));
  } finally { release(); }
  const source = await turn;
  expect((await f.hub.store.runInputs(source.id)).inputs.map(input => input.id)).toContain(steering.id);
  const anchor = (await f.anchors(source.id)).anchors[0]!;
  const rewind = await f.operation("steer_rewind", { kind: "rewind", anchorId: anchor.id });
  expect(rewind.result.state).toBe("applied");
  expect((await f.hub.store.messageForBot("bot", steering.id)).historyContext?.excludedBy).toBe(rewind.result.operationId);
}, 30_000);

it("keeps an uncertain native operation fenced through actual Gateway replacement and reconciliation", async () => {
  const native = scriptedNative(), f = await fixture(native.adapter);
  await f.send(f.source.id, "source input");
  native.forkHistory.mockResolvedValueOnce({ outcome: "unknown" } as NativeHistoryResult);
  const pending = await f.operation("uncertain", { kind: "fork", scope: "whole" });
  expect(pending.result.state).toBe("unknown");
  expect((await f.sessions.findByConversationKey(buildCoreConversationKey(f.source.id)))?.historyFence?.operationId).toBe(pending.result.operationId);
  await f.restart();
  expect(await f.snapshot()).toMatchObject({ blocked: "outcome_unknown", pendingOperation: "uncertain" });
  expect(await f.request(f.source.id, "/operations/uncertain/reconcile", pending.change)).toMatchObject({ state: "unknown" });
  expect(native.forkHistory).toHaveBeenCalledOnce();
  await expect(f.hub.store.sendMessage("owner", { conversationId: f.source.id, clientMsgId: "blocked", text: "later", attachments: [] })).rejects.toThrow("history_operation_pending");
  await expect(f.sessions.removeByConversationKey(buildCoreConversationKey(f.source.id))).rejects.toThrow("history_outcome_pending");
}, 30_000);

// Explicit local acceptance only. No credentials or ordinary engine state are
// inherited; all Responses requests terminate at the loopback fixture below.
it.skipIf(!process.env.TAROBIRD_HISTORY_REAL_CODEX)("roundtrips real Codex history through Hub, Gateway and Bridge with an isolated loopback provider", async () => {
  const probe = await mkdtemp(path.join(os.tmpdir(), "history-real-codex-"));
  const engineHome = path.join(probe, "codex"), fakeHome = path.join(probe, "home"), workspace = path.join(probe, "workspace");
  await Promise.all([engineHome, fakeHome, workspace].map(directory => mkdir(directory)));
  let responses = 0;
  const providerInputs: Array<{ input?: Array<{ type?: string; call_id?: string; output?: unknown }> }> = [];
  const provider = http.createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404); response.end("{}"); return; }
      providerInputs.push(JSON.parse(body));
      const n = ++responses, id = `response_${n}`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const event = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("response.created", { response: { id } });
      if (n === 4) event("response.output_item.done", { item: { type: "function_call", id: "fixture_app_call", call_id: "fixture_app_call", name: "app_capability", arguments: JSON.stringify({ topic: "files" }) } });
      else event("response.output_item.done", { item: { type: "message", role: "assistant", id: `reply_${n}`, content: [{ type: "output_text", text: `Fixture response ${n}` }] } });
      event("response.completed", { response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
      response.end();
    });
  });
  cleanups.push(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await rm(probe, { recursive: true, force: true }); });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  await writeFile(path.join(engineHome, "config.toml"), [
    'model = "fixture"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
    "[model_providers.fixture]", 'name = "Isolated loopback"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"',
    "request_max_retries = 0", "stream_max_retries = 0", "",
  ].join("\n"));
  const makeAdapter = () => new CodexAppServerAdapter(process.env.TAROBIRD_HISTORY_REAL_CODEX!, workspace, {
    PATH: process.env.PATH, HOME: fakeHome, CODEX_HOME: engineHome, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), LANG: "en_US.UTF-8",
  });
  const f = await fixture(makeAdapter());
  const one = await f.send(f.source.id, "fixture first"), two = await f.send(f.source.id, "fixture second"), three = await f.send(f.source.id, "fixture third");
  expect(responses).toBe(3);
  const sourceKey = buildCoreConversationKey(f.source.id), sourceId = (await f.sessions.findByConversationKey(sourceKey))!.codexSessionId;
  const before = await f.snapshot(), point = (await f.anchors(two.id)).anchors[0]!;
  expect(point).toMatchObject({ rewind: true, fork: true, forkBoundary: "after-turn" });
  const branch = await f.operation("real_point_fork", { kind: "fork", scope: "anchor", anchorId: point.id }, before.revision);
  expect(branch.result.state).toBe("applied");
  const whole = await f.operation("real_whole_fork", { kind: "fork", scope: "whole" });
  expect(whole.result.state).toBe("applied");
  expect((await f.snapshot()).revision).toBe(before.revision);
  expect(responses).toBe(3);
  await f.send(branch.result.destinationConversationId!, "fixture on fork");
  expect(responses).toBe(5);
  const toolResult = providerInputs.at(-1)?.input?.find(item => item.type === "function_call_output" && item.call_id === "fixture_app_call");
  expect(toolResult).toBeDefined();
  expect(JSON.stringify(toolResult!.output)).toContain("app_send_file");
  expect(JSON.stringify(toolResult!.output)).not.toMatch(/not available|unknown_tool|unsupported_tool/);
  expect((await f.snapshot()).revision).toBe(before.revision);
  const rewind = await f.operation("real_rewind", { kind: "rewind", anchorId: point.id });
  expect(rewind.result).toMatchObject({ state: "applied", sourceEventSeq: expect.any(Number) });
  expect(responses).toBe(5);
  expect((await f.hub.store.messageForBot("bot", one.id)).historyContext).toBeUndefined();
  for (const id of [two.id, three.id]) expect((await f.hub.store.messageForBot("bot", id)).historyContext?.excludedBy).toBe(rewind.result.operationId);
  expect((await f.sessions.findByConversationKey(sourceKey))?.codexSessionId).toBe(sourceId);
  const forkBeforeRestart = await f.snapshot(branch.result.destinationConversationId!);
  await f.restart(makeAdapter());
  expect((await f.snapshot(branch.result.destinationConversationId!)).revision).toBe(forkBeforeRestart.revision);
  expect(responses).toBe(5);
  await f.send(f.source.id, "fixture source after rewind");
  expect(responses).toBe(6);
  expect((await f.sessions.findByConversationKey(sourceKey))?.codexSessionId).toBe(sourceId);
  expect(f.warnings).not.toContain("history_anchor_rejected");
}, 60_000);
