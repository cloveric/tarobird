import { randomUUID } from "node:crypto";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NATIVE_INPUT_CAPABILITY, type NativeInputProgress } from "../src/client-protocol/native-input.js";
import type { CodexAdapter, EngineStreamEvent } from "../src/codex/adapter.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { gatewaySteering } from "../src/gateway/steering.js";
import { Bridge, type AccessStoreLike, type BridgeAuthorizedMessageInput } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

// Two App conversations may be bound to one native Claude session ("use this
// session"). They then run their turns one after the other on the session's
// turn lock. Only the conversation whose turn holds that lock owns the native
// turn: another conversation waiting for it must queue, never write into it.
const CAPABILITIES = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "interrupt_send_now_v1", "msg_lifecycle_v1", "request_marker_lists_v1"];
const A = "lark:gw_A", B = "lark:gw_B";

class Child extends EventEmitter {
  lines: Array<Record<string, any>> = [];
  stdin = { write: (text: string, done?: (error?: Error | null) => void) => { this.lines.push(JSON.parse(text)); done?.(null); return true; } };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  prompts() { return this.lines.filter((line) => line.type === "user"); }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (condition: () => boolean) => await vi.waitFor(() => expect(condition()).toBe(true), { timeout: 3_000, interval: 5 });
const access: AccessStoreLike = { load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [84], pairedUsers: [], pendingPairs: [] }), issuePairingCode: vi.fn() };
const scope = (conversationKey: string) => ({ chatId: 84, conversationKey });
const queued = { name: "EngineSteeringRejectedError", reason: "queued" };

async function sharedSession(bound: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-shared-session-"));
  const children: Child[] = [];
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn: () => { const child = new Child(); children.push(child); return child as never; } });
  cleanups.push(async () => { await adapter.destroy(); await removeTempRoot(root); });
  const store = new SessionStore(path.join(root, "session.json"));
  // The state the App's "use this session" selection produces: B gets A's ID.
  const bind = async (conversationKey: string, sessionId: string) => await store.upsert({ telegramChatId: 84, conversationKey, codexSessionId: sessionId, status: "idle", updatedAt: new Date().toISOString() } as never);
  for (const [conversationKey, sessionId] of Object.entries(bound)) await bind(conversationKey, sessionId);
  const bridge = new Bridge(access, new SessionManager(store, adapter), adapter);
  const turn = (conversationKey: string, text: string, extra: Partial<BridgeAuthorizedMessageInput> = {}, via: Bridge = bridge) => {
    const pending = via.handleAuthorizedMessage({ chatId: 84, userId: 42, chatType: "private", conversationKey, text, files: [], ...extra });
    pending.catch(() => undefined); // A failed assertion leaves turns for cleanup to reject.
    return pending;
  };
  const child = async () => { await until(() => !!children[0]?.prompts().length); return children[0]!; };
  const emitter = (target: Child, sessionId: string) => (frame: object) => target.stdout.emit("data", JSON.stringify({ session_id: sessionId, ...frame }) + "\n");
  return { root, adapter, bridge, bind, turn, child, emitter, children };
}

describe("Bridge native turn ownership for a shared session", () => {
  it("queues the waiting conversation's input and keeps the running conversation's native input", async () => {
    const SESSION = `shared-${randomUUID()}`;
    const f = await sharedSession({ [A]: SESSION, [B]: SESSION });
    const aText: string[] = [];
    const turnA = f.turn(A, "A long task", { onEngineEvent: (event) => { if (event.type === "assistant_text") aText.push(event.text); } });
    const child = await f.child(), emit = f.emitter(child, SESSION), promptA = child.prompts()[0]!.uuid;
    emit({ type: "system", subtype: "init", capabilities: CAPABILITIES });
    emit({ type: "command_lifecycle", command_uuid: promptA, state: "queued" });
    emit({ type: "command_lifecycle", command_uuid: promptA, state: "started" });

    // B's first message waits for the session's turn lock.
    let bSettled = false;
    const turnB = f.turn(B, "B first");
    void turnB.finally(() => { bSettled = true; }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bSettled).toBe(false);
    expect(child.prompts()).toHaveLength(1);

    // B is not offered in-flight sending; ordinary sends use its normal queue.
    expect(await f.bridge.inFlightSendBehavior(scope(B))).toBeUndefined();
    expect(await f.bridge.nativeInputCapability(scope(B))).toBeUndefined();
    const progressB: NativeInputProgress[] = [];
    await expect(f.bridge.steerActiveTurn({ ...scope(B), text: "B-only follow-up", throwOnError: true, nativeInput: { id: "b-input", onProgress: (progress) => progressB.push(progress) } }))
      .rejects.toMatchObject(queued);
    await expect(f.bridge.steerActiveTurn({ ...scope(B), text: "B explicit steer", throwOnError: true })).rejects.toMatchObject(queued);
    expect(await f.bridge.steerActiveTurn({ ...scope(B), text: "B quiet steer" })).toBe(false);
    expect(await f.bridge.controlNativeInput({ ...scope(B), inputId: "b-input", action: "send-now" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(progressB).toEqual([]);
    expect(child.prompts()).toHaveLength(1);

    // A still owns its running turn: capability and native input are unchanged.
    expect(await f.bridge.inFlightSendBehavior(scope(A))).toBe("steer");
    expect(await f.bridge.nativeInputCapability(scope(A))).toEqual({ sendNow: true, cancel: true, modelReceipt: true });
    const progressA: string[] = [];
    const admittedA = f.bridge.steerActiveTurn({ ...scope(A), text: "A follow-up", throwOnError: true, nativeInput: { id: "a-input", onProgress: (progress) => progressA.push(progress.state) } });
    await until(() => child.prompts().length === 2);
    const steerA = child.prompts()[1]!;
    expect(steerA.message.content[0].text).toBe("A follow-up");
    expect(steerA.origin).toEqual({ kind: "human" });
    emit({ type: "command_lifecycle", command_uuid: steerA.uuid, state: "queued" });
    expect(await admittedA).toBe(true);
    expect(progressA).toContain("queued");

    emit({ type: "command_lifecycle", command_uuid: steerA.uuid, state: "started" });
    emit({ type: "assistant", message: { id: "m1", model: "claude", content: [{ type: "text", text: "Answering A's follow-up" }] } });
    emit({ type: "command_lifecycle", command_uuid: steerA.uuid, state: "completed" });
    emit({ type: "result", subtype: "success", result: "A done", user_message_uuid: promptA, user_message_uuids: [promptA, steerA.uuid] });
    emit({ type: "command_lifecycle", command_uuid: promptA, state: "completed" });
    expect((await turnA).text).toContain("A done");
    expect(aText.join("")).toContain("Answering A's follow-up");

    // B's queued turn now runs and owns the session; the roles are reversed.
    await until(() => child.prompts().length === 3);
    const promptB = child.prompts()[2]!;
    expect(promptB.message.content.some((item: { text?: string }) => item.text?.includes("B first"))).toBe(true);
    emit({ type: "command_lifecycle", command_uuid: promptB.uuid, state: "started" });
    expect(await f.bridge.inFlightSendBehavior(scope(B))).toBe("steer");
    expect(await f.bridge.inFlightSendBehavior(scope(A))).toBeUndefined();
    await expect(f.bridge.steerActiveTurn({ ...scope(A), text: "A late", throwOnError: true })).rejects.toMatchObject(queued);
    const admittedB = f.bridge.steerActiveTurn({ ...scope(B), text: "B follow-up", throwOnError: true, nativeInput: { id: "b-input-2", onProgress: () => undefined } });
    await until(() => child.prompts().length === 4);
    const steerB = child.prompts()[3]!;
    expect(steerB.message.content[0].text).toBe("B follow-up");
    emit({ type: "command_lifecycle", command_uuid: steerB.uuid, state: "queued" });
    expect(await admittedB).toBe(true);
    emit({ type: "command_lifecycle", command_uuid: steerB.uuid, state: "started" });
    emit({ type: "command_lifecycle", command_uuid: steerB.uuid, state: "completed" });
    emit({ type: "result", subtype: "success", result: "B done", user_message_uuid: promptB.uuid, user_message_uuids: [promptB.uuid, steerB.uuid] });
    emit({ type: "command_lifecycle", command_uuid: promptB.uuid, state: "completed" });
    expect((await turnB).text).toContain("B done");
    // Nothing remains owned once both turns released the lock.
    expect(await f.bridge.inFlightSendBehavior(scope(A))).toBe("steer");
    expect(await f.bridge.inFlightSendBehavior(scope(B))).toBe("steer");
    expect(child.prompts().map((line) => line.message.content.map((item: { text?: string }) => item.text ?? "").join(""))
      .filter((text) => /B-only|B explicit|B quiet|A late/.test(text))).toEqual([]);
  });

  it("offers the App's Gateway steering only to the conversation holding the turn", async () => {
    const SESSION = `shared-${randomUUID()}`;
    const f = await sharedSession({ [A]: SESSION, [B]: SESSION });
    const runtime = createCoreServiceRuntime();
    const turnA = f.turn(A, "A long task");
    runtime.activeRuns.set(A, { abortController: new AbortController(), startedAt: Date.now() });
    const child = await f.child(), emit = f.emitter(child, SESSION), promptA = child.prompts()[0]!.uuid;
    emit({ type: "system", subtype: "init", capabilities: CAPABILITIES });
    emit({ type: "command_lifecycle", command_uuid: promptA, state: "started" });
    // Core claimed B's run slot; its Bridge turn waits for the session lock.
    runtime.activeRuns.set(B, { abortController: new AbortController(), startedAt: Date.now() });
    const turnB = f.turn(B, "B first");
    const progress: unknown[] = [];
    const channel = { canSteerConversation: async () => true, transport: { capabilities: [NATIVE_INPUT_CAPABILITY], request: async (_method: string, payload: unknown) => { progress.push(payload); return null; }, options: {} } };
    // The Gateway steers through its authenticated surface; it shares turn ownership.
    const steering = gatewaySteering(f.bridge.createAuthenticatedSurface(), runtime, channel as unknown as GatewayChannel, f.root);

    const statusB = await steering("steer.status", { conversationId: "gw_B" }) as { targetId?: string; sendBehavior?: string; nativeInput?: unknown };
    expect(statusB.targetId).toBeTruthy();
    expect(statusB).not.toHaveProperty("sendBehavior");
    expect(statusB).not.toHaveProperty("nativeInput");
    expect(await steering("steer", { conversationId: "gw_B", userId: "owner", requestId: "b-message", targetId: statusB.targetId, text: "B-only via gateway", mode: "message" }))
      .toEqual({ outcome: "rejected", reason: "unsupported" });
    expect(await steering("steer", { conversationId: "gw_B", userId: "owner", requestId: "b-steer", targetId: statusB.targetId, text: "B steer via gateway" }))
      .toEqual({ outcome: "rejected", reason: "queued" });
    expect(child.prompts()).toHaveLength(1);
    expect(progress).toEqual([]);

    const statusA = await steering("steer.status", { conversationId: "gw_A" }) as { targetId?: string; sendBehavior?: string; nativeInput?: unknown };
    expect(statusA).toMatchObject({ sendBehavior: "steer", nativeInput: { sendNow: true, cancel: true, modelReceipt: true } });
    const sending = steering("steer", { conversationId: "gw_A", userId: "owner", requestId: "a-message", targetId: statusA.targetId, text: "A via gateway", mode: "message" });
    await until(() => child.prompts().length === 2);
    const steerA = child.prompts()[1]!;
    emit({ type: "command_lifecycle", command_uuid: steerA.uuid, state: "queued" });
    expect(await sending).toEqual({ outcome: "accepted" });
    expect(steerA.message.content[0].text).toBe("A via gateway");

    emit({ type: "command_lifecycle", command_uuid: steerA.uuid, state: "started" });
    emit({ type: "command_lifecycle", command_uuid: steerA.uuid, state: "completed" });
    emit({ type: "result", subtype: "success", result: "A done", user_message_uuid: promptA });
    emit({ type: "command_lifecycle", command_uuid: promptA, state: "completed" });
    await turnA;
    runtime.activeRuns.delete(A);
    await until(() => child.prompts().length === 3);
    const promptB = child.prompts()[2]!.uuid;
    emit({ type: "command_lifecycle", command_uuid: promptB, state: "started" });
    expect(await steering("steer.status", { conversationId: "gw_B" })).toMatchObject({ sendBehavior: "steer", nativeInput: { sendNow: true } });
    emit({ type: "result", subtype: "success", result: "B done", user_message_uuid: promptB });
    await turnB;
  });

  // A's first turn holds the lock of its provisional ID while Claude confirms the
  // native ID it is bound to. B, bound to that native ID, holds a different lock.
  async function provisionalFirstTurn() {
    const NATIVE = randomUUID();
    const f = await sharedSession({});
    const turnA = f.turn(A, "A first turn");
    const child = await f.child(), emit = f.emitter(child, NATIVE), promptA = child.prompts()[0]!.uuid;
    emit({ type: "system", subtype: "init", capabilities: CAPABILITIES });
    emit({ type: "command_lifecycle", command_uuid: promptA, state: "started" });
    await vi.waitFor(async () => expect((await new SessionManager(new SessionStore(path.join(f.root, "session.json")), f.adapter).getExistingSession(scope(A)))?.sessionId).toBe(NATIVE));
    await f.bind(B, NATIVE);
    const finishA = async () => {
      emit({ type: "result", subtype: "success", result: "A done", user_message_uuid: promptA });
      emit({ type: "command_lifecycle", command_uuid: promptA, state: "completed" });
      expect((await turnA).text).toContain("A done");
    };
    const steerA = async (text: string) => {
      const admitted = f.bridge.steerActiveTurn({ ...scope(A), text, throwOnError: true, nativeInput: { id: randomUUID(), onProgress: () => undefined } });
      const count = child.prompts().length;
      await until(() => child.prompts().length === count + 1);
      const written = child.prompts()[count]!;
      expect(written.message.content[0].text).toBe(text);
      emit({ type: "command_lifecycle", command_uuid: written.uuid, state: "queued" });
      expect(await admitted).toBe(true);
      emit({ type: "command_lifecycle", command_uuid: written.uuid, state: "started" });
      emit({ type: "command_lifecycle", command_uuid: written.uuid, state: "completed" });
    };
    const bPrompts = () => child.prompts().filter((line) => JSON.stringify(line.message.content).includes("B first message"));
    return { ...f, NATIVE, child, emit, finishA, steerA, bPrompts };
  }

  it("runs another conversation's first message on the confirmed native session after the provisional turn", async () => {
    const f = await provisionalFirstTurn();
    expect(await f.bridge.nativeInputCapability(scope(A))).toBeDefined();
    expect(await f.bridge.inFlightSendBehavior(scope(B))).toBeUndefined();
    await expect(f.bridge.steerActiveTurn({ ...scope(B), text: "B into A's first turn", throwOnError: true, nativeInput: { id: "b", onProgress: () => undefined } }))
      .rejects.toMatchObject(queued);

    // B's real first message, through the Gateway's surface, waits for A's turn.
    const waits: Array<{ sessionId: string; reason: string }> = [];
    let bSettled = false;
    const surface = f.bridge.createAuthenticatedSurface(), signalB = new AbortController().signal;
    const turnB = f.turn(B, "B first message", { abortSignal: signalB, turnLockWaitNotifyAfterMs: 0, onTurnLockWait: (event) => { waits.push(event); } }, surface);
    void turnB.finally(() => { bSettled = true; }).catch(() => undefined);
    await until(() => waits.length === 1);
    expect(waits[0]).toMatchObject({ sessionId: f.NATIVE, reason: "in_process_queue" });
    expect(bSettled).toBe(false);
    expect(f.bPrompts()).toEqual([]);
    // The running native turn still belongs to A.
    await f.steerA("A follow-up");
    expect(await f.bridge.inFlightSendBehavior(scope(B))).toBeUndefined();

    await f.finishA();
    await until(() => f.bPrompts().length === 1);
    const promptB = f.bPrompts()[0]!.uuid;
    f.emit({ type: "command_lifecycle", command_uuid: promptB, state: "started" });
    // After the wait, B claims the native session on both Bridge facades.
    expect(await surface.inFlightSendBehavior(scope(B))).toBe("steer");
    expect(await f.bridge.inFlightSendBehavior(scope(B))).toBe("steer");
    expect(await f.bridge.inFlightSendBehavior(scope(A))).toBeUndefined();
    const admittedB = surface.steerActiveTurn({ ...scope(B), text: "B follow-up", throwOnError: true, nativeInput: { id: "b-after-wait", onProgress: () => undefined } });
    await until(() => f.child.prompts().some((line) => line.message.content[0]?.text === "B follow-up"));
    const steerB = f.child.prompts().find((line) => line.message.content[0]?.text === "B follow-up")!;
    f.emit({ type: "command_lifecycle", command_uuid: steerB.uuid, state: "queued" });
    expect(await admittedB).toBe(true);
    f.emit({ type: "command_lifecycle", command_uuid: steerB.uuid, state: "started" });
    f.emit({ type: "command_lifecycle", command_uuid: steerB.uuid, state: "completed" });
    f.emit({ type: "result", subtype: "success", result: "B done", user_message_uuid: promptB, user_message_uuids: [promptB, steerB.uuid] });
    f.emit({ type: "command_lifecycle", command_uuid: promptB, state: "completed" });
    expect((await turnB).text).toContain("B done");
    expect(f.bPrompts()).toHaveLength(1);
    expect(f.children).toHaveLength(1);
    expect(await f.bridge.inFlightSendBehavior(scope(A))).toBe("steer");
    expect(getEventListeners(signalB, "abort")).toHaveLength(0);
  });

  it("keeps both turns intact when the wait notice throws synchronously", async () => {
    const f = await provisionalFirstTurn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    cleanups.push(async () => { logged.mockRestore(); });
    const turnB = f.turn(B, "B first message", { turnLockWaitNotifyAfterMs: 0, onTurnLockWait: () => { throw new Error("notice failed"); } });
    await until(() => logged.mock.calls.some(([message]) => message === "Failed to notify session turn wait:"));
    expect(logged).toHaveBeenCalledWith("Failed to notify session turn wait:", "notice failed");
    expect(f.bPrompts()).toEqual([]);
    await f.steerA("A follow-up");
    await f.finishA();
    await until(() => f.bPrompts().length === 1);
    const promptB = f.bPrompts()[0]!.uuid;
    f.emit({ type: "command_lifecycle", command_uuid: promptB, state: "started" });
    f.emit({ type: "result", subtype: "success", result: "B done", user_message_uuid: promptB });
    expect((await turnB).text).toContain("B done");
    expect(f.bPrompts()).toHaveLength(1);
  });

  it("cancels a message waiting for the provisional turn without touching that turn", async () => {
    const f = await provisionalFirstTurn();
    const stop = new AbortController(), waits: unknown[] = [];
    const turnB = f.turn(B, "B first message", { abortSignal: stop.signal, turnLockWaitNotifyAfterMs: 0, onTurnLockWait: (event) => { waits.push(event); } });
    await until(() => waits.length === 1);
    stop.abort(new Error("B stopped"));
    await expect(turnB).rejects.toThrow("B stopped");
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
    // A's turn, its native input and its result are unaffected.
    await f.steerA("A follow-up");
    await f.finishA();
    expect(f.bPrompts()).toEqual([]);
    // Nothing of B's cancelled wait remains: B's next message runs at once.
    const again = f.turn(B, "B first message, again");
    await until(() => f.bPrompts().length === 1);
    const promptB = f.bPrompts()[0]!.uuid;
    f.emit({ type: "command_lifecycle", command_uuid: promptB, state: "started" });
    f.emit({ type: "result", subtype: "success", result: "B done", user_message_uuid: promptB });
    expect((await again).text).toContain("B done");
  });

  it("ignores session events delivered after the turn released the lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-shared-late-"));
    cleanups.push(async () => await removeTempRoot(root));
    const store = new SessionStore(path.join(root, "session.json"));
    const FIRST = `first-${randomUUID()}`, LATE = `late-${randomUUID()}`;
    await store.upsert({ telegramChatId: 84, conversationKey: A, codexSessionId: FIRST, status: "idle", updatedAt: new Date().toISOString() } as never);
    await store.upsert({ telegramChatId: 84, conversationKey: B, codexSessionId: LATE, status: "idle", updatedAt: new Date().toISOString() } as never);
    let late: ((event: EngineStreamEvent) => void | Promise<void>) | undefined;
    const steerActiveTurn = vi.fn(async () => true);
    const adapter: CodexAdapter = { createSession: vi.fn(), steerActiveTurn, sendUserMessage: vi.fn(async (_sessionId, input) => { late = input.onEngineEvent; return { text: "done" }; }) };
    const bridge = new Bridge(access, new SessionManager(store, adapter), adapter);
    await bridge.handleAuthorizedMessage({ chatId: 84, userId: 42, chatType: "private", conversationKey: A, text: "A", files: [] });
    // A background task bound to A's finished turn reports a session later.
    await late?.({ type: "session", sessionId: LATE });
    expect(await bridge.steerActiveTurn({ ...scope(B), text: "B", throwOnError: true })).toBe(true);
    expect(steerActiveTurn).toHaveBeenCalledWith(LATE, expect.objectContaining({ text: "B" }));
  });

  it("controls a native input only from the conversation holding the turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-shared-control-"));
    cleanups.push(async () => await removeTempRoot(root));
    const store = new SessionStore(path.join(root, "session.json"));
    const SESSION = `shared-${randomUUID()}`;
    for (const conversationKey of [A, B]) await store.upsert({ telegramChatId: 84, conversationKey, codexSessionId: SESSION, status: "idle", updatedAt: new Date().toISOString() } as never);
    let started = false, release!: () => void;
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const controlNativeInput = vi.fn(async () => ({ outcome: "accepted" as const, result: "cancelled" as const }));
    const adapter: CodexAdapter = { createSession: vi.fn(), controlNativeInput, sendUserMessage: vi.fn(async () => { started = true; await finish; return { text: "done" }; }) };
    const bridge = new Bridge(access, new SessionManager(store, adapter), adapter);
    const turnA = bridge.handleAuthorizedMessage({ chatId: 84, userId: 42, chatType: "private", conversationKey: A, text: "A", files: [] });
    await until(() => started);
    expect(await bridge.controlNativeInput({ ...scope(B), inputId: "b", action: "cancel" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(controlNativeInput).not.toHaveBeenCalled();
    expect(await bridge.controlNativeInput({ ...scope(A), inputId: "a", action: "cancel" })).toEqual({ outcome: "accepted", result: "cancelled" });
    expect(controlNativeInput).toHaveBeenCalledWith(SESSION, { inputId: "a", action: "cancel" });
    release();
    await turnA;
    expect(await bridge.controlNativeInput({ ...scope(B), inputId: "b", action: "cancel" })).toEqual({ outcome: "accepted", result: "cancelled" });
  });
});

describe("Bridge wait for another conversation's turn", () => {
  type Hold = { scopeLockId: string; lockedSessionId: string; released: Promise<void>; ended?: true };
  type WaitOptions = { signal?: AbortSignal; waitNotifyAfterMs?: number; onWait?: (event: unknown) => void };
  const internals = (bridge: Bridge) => bridge as unknown as { sessionTurnOwners: Map<string, Hold>; waitForSessionTurn(sessionId: string, scopeLockId: string, options: WaitOptions): Promise<void> };
  const bridgeWith = (owner: Hold) => {
    const bridge = new Bridge(access, { getOrCreateSession: vi.fn(), bindSession: vi.fn() }, { createSession: vi.fn(), sendUserMessage: vi.fn() });
    internals(bridge).sessionTurnOwners.set("N", owner);
    return bridge;
  };
  const turnOf = (scopeLockId: string) => {
    let release!: () => void;
    const hold: Hold = { scopeLockId, lockedSessionId: "P", released: new Promise<void>((resolve) => { release = resolve; }) };
    return { hold, end: () => { hold.ended = true; release(); } };
  };
  const settledSoon = async (promise: Promise<unknown>) => await Promise.race([promise.then(() => "settled", () => "rejected"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 20))]);

  it("removes its abort listener and notice timer when cancelled", async () => {
    const other = turnOf("other"), bridge = bridgeWith(other.hold);
    const stop = new AbortController(), onWait = vi.fn();
    const waiting = internals(bridge).waitForSessionTurn("N", "mine", { signal: stop.signal, waitNotifyAfterMs: 40, onWait });
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(1);
    stop.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(onWait).not.toHaveBeenCalled();
    other.end();
  });

  it("removes its abort listener when the other turn ends and never spins on an ended claim", async () => {
    const other = turnOf("other"), bridge = bridgeWith(other.hold);
    const stop = new AbortController(), onWait = vi.fn();
    const waiting = internals(bridge).waitForSessionTurn("N", "mine", { signal: stop.signal, waitNotifyAfterMs: 40, onWait });
    expect(await settledSoon(waiting)).toBe("waiting");
    other.end(); // its claim of N is deliberately left behind
    await waiting;
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(onWait).not.toHaveBeenCalled();
    expect(await settledSoon(internals(bridge).waitForSessionTurn("N", "mine", { signal: stop.signal }))).toBe("settled");
  });

  it("never waits for a turn of its own conversation", async () => {
    const own = turnOf("mine"), bridge = bridgeWith(own.hold);
    expect(await settledSoon(internals(bridge).waitForSessionTurn("N", "mine", {}))).toBe("settled");
    own.end();
  });
});
