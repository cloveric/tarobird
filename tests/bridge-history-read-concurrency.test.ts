import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { KimiAcpAdapter, type KimiChildProcess } from "../src/codex/kimi-acp-adapter.js";
import { spawnClaudeHistoryHelper } from "../src/codex/claude-history.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../src/core/message-normalizer.js";
import { attachGateway } from "../src/gateway/service.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import { bootstrapTrusted } from "./helpers/pairing-invite.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const until = async (check: () => boolean | Promise<boolean>) => {
  await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 5_000, interval: 5 });
};
const access: AccessStoreLike = {
  load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [84], pairedUsers: [], pendingPairs: [] }),
  issuePairingCode: vi.fn(),
};

/** Real ACP adapter/Bridge; only the child transport and provider replies are scripted. */
async function nativeFixture(timeoutMs = 2_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-history-read-"));
  vi.spyOn(os, "homedir").mockReturnValue(directory);
  const sessionId = `history-read-${randomUUID()}`;
  const requests: Array<{ method: string; params: any }> = [];
  const transcript: unknown[] = [];
  const children: Child[] = [];
  const held: Array<() => void> = [];
  let holdLoads = false;
  class Child extends EventEmitter {
    pid = children.length + 50_000;
    stdout = new PassThrough(); stderr = new PassThrough(); dead = false;
    stdin = new Writable({ write: (chunk, _encoding, callback) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const input = JSON.parse(line); if (!input.method) continue;
        requests.push({ method: input.method, params: input.params });
        const reply = (result: unknown) => queueMicrotask(() => {
          if (!this.dead) this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }) + "\n");
        });
        if (input.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {}, fork: {} } }, authMethods: [] });
        else if (input.method === "session/list") reply({ sessions: [{ sessionId, cwd: directory }], nextCursor: null });
        else if (input.method === "session/load") {
          const complete = () => { for (const update of transcript) this.update(update); reply({ configOptions: [] }); };
          if (holdLoads) held.push(complete); else complete();
        } else if (input.method === "session/prompt") {
          const text = input.params.prompt.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("\n");
          transcript.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
          this.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Received: ${text}` } });
          reply({ stopReason: "end_turn" });
        } else reply({});
      }
      callback();
    } });
    update(update: unknown) { queueMicrotask(() => {
      if (!this.dead) this.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }) + "\n");
    }); }
    close() { if (this.dead) return; this.dead = true; this.stdout.end(); this.stderr.end(); this.emit("close", 0); }
  }
  const adapter = new KimiAcpAdapter("fixture", {
    workspacePath: directory, childEnv: { HOME: directory }, hookRelayEnabled: false, initializeTimeoutMs: timeoutMs,
    idleWorkerTtlMs: 0, syncWorkspaceInstructionsFn: async (_workspace, text) => text ?? "",
    spawnFn: () => { const child = new Child(); children.push(child); return child as unknown as KimiChildProcess; },
    killProcessTreeFn: pid => { children.find(child => child.pid === pid)?.close(); },
  });
  const release = () => { holdLoads = false; held.splice(0).forEach(complete => complete()); };
  cleanups.push(async () => { release(); await adapter.destroy(); await removeTempRoot(directory); });
  const prompts = () => requests.filter(request => request.method === "session/prompt");
  const bind = (store: SessionStore, chatId: number, conversationKey: string) => store.upsert({
    telegramChatId: chatId, conversationKey, codexSessionId: sessionId, status: "idle", updatedAt: new Date().toISOString(),
  });
  return { directory, adapter, sessionId, requests, prompts, bind, release, held, hold: () => { holdLoads = true; } };
}

async function bridgeFixture(timeoutMs?: number) {
  const f = await nativeFixture(timeoutMs), scope = { chatId: 84, conversationKey: "lark:history-read" };
  const store = new SessionStore(path.join(f.directory, "session.json"));
  await f.bind(store, scope.chatId, scope.conversationKey);
  const bridge = new Bridge(access, new SessionManager(store, f.adapter), f.adapter);
  const turn = (text: string, onWait?: () => void) => {
    const pending = bridge.handleAuthorizedMessage({ ...scope, userId: 42, chatType: "private", text, files: [], turnLockWaitNotifyAfterMs: 0, onTurnLockWait: onWait });
    void pending.catch(() => undefined);
    return pending;
  };
  await turn("warm source");
  return { ...f, scope, bridge, turn };
}

it("preempts a Claude history snapshot and lets the next turn through only after the helper closes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-claude-history-"));
  const sessionId = randomUUID(), scope = { chatId: 84, conversationKey: "fixture:claude-history" };
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  let readerClosed = false;
  const closeReader = () => { readerClosed = true; child.emit("close", null, "SIGKILL"); };
  const spawnReader = vi.fn(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  });
  const adapter = new ClaudeStreamAdapter("fixture", {
    workspacePath: directory, childEnv: { HOME: directory }, idleWorkerTtlMs: 0,
    historyHelper: spawnClaudeHistoryHelper("fixture", { spawnFn: spawnReader }),
  });
  const turn = vi.spyOn(adapter, "sendUserMessage").mockImplementation(async id => {
    expect(readerClosed).toBe(true);
    return { sessionId: id, text: "Normal turn reached Claude" };
  });
  const store = new SessionStore(path.join(directory, "session.json"));
  await store.upsert({ telegramChatId: scope.chatId, conversationKey: scope.conversationKey, codexSessionId: sessionId, status: "idle", updatedAt: new Date().toISOString() });
  const bridge = new Bridge(access, new SessionManager(store, adapter), adapter);
  let pending: Promise<unknown> | undefined;
  const snapshot = bridge.getConversationHistory(scope);
  try {
    await until(() => spawnReader.mock.calls.length === 1);
    pending = bridge.handleAuthorizedMessage({ ...scope, userId: 42, chatType: "private", text: "Continue", files: [] });
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL"), { timeout: 750, interval: 5 });
    expect(turn).not.toHaveBeenCalled();

    closeReader();
    await expect(snapshot).resolves.toMatchObject({ supported: true, blocked: "busy", sourceSessionId: sessionId });
    await expect(pending).resolves.toMatchObject({ sessionId, text: "Normal turn reached Claude" });
    expect(turn).toHaveBeenCalledTimes(1);
    const pendingOnFirstRead = await bridge.getConversationHistory(scope, { turnPending: true });
    expect(pendingOnFirstRead).toMatchObject({ blocked: "busy", cachedWhilePending: true });
    expect(spawnReader).toHaveBeenCalledTimes(1);
  } finally {
    if (!readerClosed) closeReader();
    await Promise.allSettled([snapshot, pending]);
    await bridge.destroy();
    await removeTempRoot(directory);
  }
});

it("queues a normal Bridge turn behind a held Kimi history replay and sends it once after release", async () => {
  const f = await bridgeFixture(); f.hold();
  const snapshot = f.bridge.getConversationHistory(f.scope);
  await until(() => f.held.length === 1);
  const waited = vi.fn(), events: unknown[] = [];
  const next = f.turn("queued after read", waited);
  void next.then(value => events.push(value), error => events.push(error));
  await until(() => waited.mock.calls.length > 0);
  expect(events).toEqual([]); expect(f.prompts()).toHaveLength(1);
  f.release();
  expect(await snapshot).toMatchObject({ supported: true, capabilities: { fork: true, anchoredFork: false, rewind: false } });
  expect((await next).text).toContain("queued after read");
  expect(f.prompts()).toHaveLength(2);
});

it("keeps a queued Bridge turn alive when the Kimi history read times out before late replay drains", async () => {
  const f = await bridgeFixture(100); f.hold();
  const snapshot = f.bridge.getConversationHistory(f.scope);
  await until(() => f.held.length === 1);
  const waited = vi.fn(), settled: unknown[] = [];
  const next = f.turn("queued through read timeout", waited);
  void next.then(value => settled.push(value), error => settled.push(error));
  await until(() => waited.mock.calls.length > 0);
  expect(await snapshot).toMatchObject({ supported: true, blocked: "not_ready" });
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(f.prompts()).toHaveLength(1);
  // A read must not turn an already accepted normal input into a busy failure.
  expect(settled).toEqual([]);
  f.release();
  expect((await next).text).toContain("queued through read timeout");
  expect(f.prompts()).toHaveLength(2);
});

it.each([false, true])("queues a signed App message behind a held HTTP history read through Hub, Gateway and Core (timeout: %s)", async timedOut => {
  const f = await nativeFixture(timedOut ? 300 : 5_000);
  const stateDir = path.join(f.directory, "worker"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "kimi", locale: "en", workspacePath: f.directory }));
  const hub = await HubServer.start({ stateDir: path.join(f.directory, "hub") });
  cleanups.push(() => hub.close());
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Fixture',?,'kimi')", [hashSecret(secret)]);
  const source = await hub.store.createConversation("owner", ["bot"], "Source", "create_source");
  const key = buildCoreConversationKey(source.id), store = new SessionStore(path.join(stateDir, "session.json"));
  await f.bind(store, stableCoreNumericId(key), key);
  const bridge = new Bridge(access, new SessionManager(store, f.adapter), f.adapter);
  const runtime = createCoreServiceRuntime();
  const channel = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "bot", secret, engine: "kimi", bridge, runtime, recoverDeliveries: false });
  cleanups.push(async () => {
    f.release();
    await channel.disconnect();
    // Gateway's pull is an outer Core queue job. Its final binding reads can
    // outlive channel processing; drain that job before removing its store.
    await until(() => !runtime.chatQueue.isBusy(key) && !runtime.activeRuns.has(key));
  });
  await until(async () => (await hub.store.bots("owner"))[0]?.online === 1 && !channel.isBusy());
  const keys = generateKeyPairSync("ed25519");
  await bootstrapTrusted(hub.auth, { deviceId: "device", name: "Fixture", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") });
  const socket = new WebSocket(hub.url.replace("http", "ws") + "/ws");
  cleanups.push(async () => { socket.terminate(); });
  const frames: Array<Record<string, any>> = [];
  const send = (frame: object) => socket.send(JSON.stringify({ v: 1, ...frame }));
  socket.on("message", data => { const frame = JSON.parse(data.toString()); frames.push(frame); if (frame.type === "snapshot.message") send({ type: "snapshot.ack", id: frame.id, count: frame.index + 1 }); });
  const next = async (type: string) => { await until(() => frames.some(frame => frame.type === type)); return frames.splice(frames.findIndex(frame => frame.type === type), 1)[0]!; };
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const nonce = randomBytes(32).toString("base64url");
  send({ type: "hello", deviceId: "device", nonce, protocolVersions: [1], capabilities: [], cursors: {} });
  const challenge = await next("challenge");
  send({ type: "auth", signature: sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64") });
  const ready = await next("ready"); await next("sync.complete");
  const appSend = async (clientMsgId: string, text: string) => {
    send({ type: "message.send", conversationId: source.id, clientMsgId, text, attachments: [] });
    return next("message.ack");
  };
  await appSend("warm", "warm source");
  await until(() => f.prompts().length === 1 && !channel.isBusy() && !runtime.chatQueue.isBusy(key));
  f.hold();
  const snapshot = fetch(`${hub.url}/api/conversations/${source.id}/history?botId=bot`, { headers: { Authorization: `Bearer ${ready.sessionToken}` } });
  await until(() => f.held.length === 1);
  const ack = await appSend("queued", "App input during history read");
  await until(() => channel.isBusy());
  expect(f.prompts()).toHaveLength(1);
  if (timedOut) {
    expect((await snapshot).ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(f.adapter.hasPendingNativeWork()).toBe(true);
    expect(channel.isBusy()).toBe(true);
    expect(f.prompts()).toHaveLength(1);
  }
  f.release();
  expect((await snapshot).ok).toBe(true);
  await until(() => f.prompts().length === 2 && !channel.isBusy() && !runtime.chatQueue.isBusy(key));
  const replies = await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE reply_to=? AND author_type='bot'", [ack.messageId]);
  expect(replies.some(reply => reply.blocks_json.includes("App input during history read"))).toBe(true);
  expect(f.prompts()).toHaveLength(2);
}, 20_000);

it("reports when a queued Bridge turn finally holds the conversation lock, with how long it waited", async () => {
  const f = await bridgeFixture(); f.hold();
  const snapshot = f.bridge.getConversationHistory(f.scope);
  await until(() => f.held.length === 1);
  const acquired = vi.fn();
  const next = f.bridge.handleAuthorizedMessage({ ...f.scope, userId: 42, chatType: "private", text: "after a slow read", files: [], onTurnLockAcquired: acquired });
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(acquired).not.toHaveBeenCalled();
  f.release();
  await snapshot; await next;
  expect(acquired).toHaveBeenCalledOnce();
  expect(acquired.mock.calls[0]![0].waitedMs).toBeGreaterThanOrEqual(50);
});
