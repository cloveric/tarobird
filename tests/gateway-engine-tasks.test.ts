import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayEngineTasks } from "../src/gateway/engine-tasks.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";

describe("native task scope and stop receipts", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "engine-tasks-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const input = { conversationId: "chat", userId: "owner", taskId: "opaque_task", requestId: "request" };
  function fixture() {
    const bridge = { handleAuthorizedMessage: vi.fn(), listTasks: vi.fn(async () => ({ supported: true, tasks: [] })), recoverSession: vi.fn(async () => ({ outcome: "accepted" as const })), stopTask: vi.fn(async () => ({ outcome: "accepted" as const })) };
    const channel = { canSteerConversation: vi.fn(async () => true) };
    const create = () => gatewayEngineTasks(bridge, channel as unknown as GatewayChannel, root);
    return { bridge, channel, run: create(), create };
  }
  it("lists only the bound conversation and never starts a foreground turn", async () => {
    const f = fixture();
    expect(await f.run("tasks.list", { conversationId: "chat" })).toEqual({ supported: true, tasks: [] });
    expect(f.bridge.listTasks).toHaveBeenCalledWith(expect.objectContaining({ conversationKey: "lark:chat" }));
    expect(f.bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    f.channel.canSteerConversation.mockResolvedValue(false);
    expect(await f.run("tasks.list", { conversationId: "chat" })).toEqual({ supported: true, tasks: [] });
    expect(f.bridge.listTasks).toHaveBeenCalledTimes(1);
  });
  it("discards task details if the binding changes during the asynchronous list", async () => {
    const f = fixture();
    f.channel.canSteerConversation.mockResolvedValueOnce(true).mockResolvedValue(false);
    f.bridge.listTasks.mockResolvedValue({ supported: false, tasks: [] });
    expect(await f.run("tasks.list", { conversationId: "chat" })).toEqual({ supported: true, tasks: [] });
  });
  it("enables default steering only after the bound native worker advertises it", async () => {
    let supported = false;
    const sessions = { getOrCreateSession: vi.fn(), bindSession: vi.fn(), getExistingSession: vi.fn(async () => ({ sessionId: "existing" })) };
    const adapter = { createSession: vi.fn(), sendUserMessage: vi.fn(), steerActiveTurn: vi.fn(), inFlightSendBehavior: "steer" as const, supportsSessionSteering: vi.fn(() => supported) };
    const bridge = new Bridge({ load: vi.fn(), issuePairingCode: vi.fn() } as AccessStoreLike, sessions, adapter);
    const scope = { chatId: 1, conversationKey: "lark:chat" };
    expect(await bridge.inFlightSendBehavior(scope)).toBeUndefined();
    supported = true; expect(await bridge.inFlightSendBehavior(scope)).toBe("steer");
    expect(adapter.supportsSessionSteering).toHaveBeenCalledWith("existing");
    expect(sessions.getOrCreateSession).not.toHaveBeenCalled();
  });
  it("keeps durable queue claims behind the exact bound native stop fence", async () => {
    let blocked = true, changed = false, reads = 0;
    const sessions = { getOrCreateSession: vi.fn(), bindSession: vi.fn(), getExistingSession: vi.fn(async () => ({ sessionId: changed && ++reads > 1 ? "next" : "current" })) };
    const adapter = { createSession: vi.fn(), sendUserMessage: vi.fn(), isSessionInputBlocked: vi.fn(() => blocked) };
    const bridge = new Bridge({ load: vi.fn(), issuePairingCode: vi.fn() } as AccessStoreLike, sessions, adapter), scope = { chatId: 1, conversationKey: "lark:chat" };
    expect(await bridge.canStartQueuedTurn(scope)).toBe(false);
    blocked = false; expect(await bridge.canStartQueuedTurn(scope)).toBe(true);
    changed = true; expect(await bridge.canStartQueuedTurn(scope)).toBe(false);
    expect(sessions.getOrCreateSession).not.toHaveBeenCalled();
  });
  it("deduplicates stop across devices, concurrent callers and Gateway recreation", async () => {
    const f = fixture();
    expect(await Promise.all([f.run("tasks.stop", input), f.run("tasks.stop", input)])).toEqual([{ outcome: "accepted" }, { outcome: "accepted" }]);
    expect(await f.create()("tasks.stop", input)).toEqual({ outcome: "accepted" });
    expect(f.bridge.stopTask).toHaveBeenCalledTimes(1);
    expect(f.bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  });
  it("changed task/conversation for the same receipt never stops a second task", async () => {
    const f = fixture(); await f.run("tasks.stop", input);
    expect(await f.run("tasks.stop", { ...input, taskId: "other" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(await f.run("tasks.stop", { ...input, conversationId: "other" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.bridge.stopTask).toHaveBeenCalledTimes(1);
  });
  it("uncertain transport results remain uncertain on retry and do not invoke stop again", async () => {
    const f = fixture(); f.bridge.stopTask.mockRejectedValue(new Error("lost receipt"));
    expect(await f.run("tasks.stop", input)).toEqual({ outcome: "unknown", reason: "uncertain" });
    expect(await f.create()("tasks.stop", input)).toEqual({ outcome: "unknown", reason: "uncertain" });
    expect(f.bridge.stopTask).toHaveBeenCalledTimes(1);
  });
  it("does not control tasks when binding changed or the adapter has no capability", async () => {
    const f = fixture(); f.channel.canSteerConversation.mockResolvedValue(false);
    expect(await f.run("tasks.stop", input)).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.bridge.stopTask).not.toHaveBeenCalled();
    const unsupported = gatewayEngineTasks({ handleAuthorizedMessage: vi.fn() }, f.channel as unknown as GatewayChannel, root);
    expect(await unsupported("tasks.list", { conversationId: "chat" })).toEqual({ supported: false, tasks: [] });
    expect(await unsupported("tasks.stop", { ...input, requestId: "new" })).toEqual({ outcome: "rejected", reason: "unsupported" });
  });
  it("Bridge rechecks native binding after the asynchronous control guard", async () => {
    let sessionId = "native-original";
    const sessions = { getOrCreateSession: vi.fn(), bindSession: vi.fn(), getExistingSession: vi.fn(async () => ({ sessionId })) };
    const adapter = { createSession: vi.fn(), sendUserMessage: vi.fn(), listTasks: vi.fn(async () => ({ supported: true, tasks: [] })), recoverSession: vi.fn(async () => ({ outcome: "accepted" as const })), stopTask: vi.fn(async () => ({ outcome: "accepted" as const })) };
    const bridge = new Bridge({ load: vi.fn(), issuePairingCode: vi.fn() } as AccessStoreLike, sessions, adapter);
    expect(await bridge.stopTask({ chatId: 1, conversationKey: "lark:chat", taskId: "task", isCurrentSession: async () => { sessionId = "native-new"; return true; } })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(adapter.stopTask).not.toHaveBeenCalled();
    expect(await bridge.recoverSession({ chatId: 1, conversationKey: "lark:chat", token: "fence", isCurrentSession: async () => { sessionId = "third"; return true; } })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(adapter.recoverSession).not.toHaveBeenCalled();
    expect(sessions.getOrCreateSession).not.toHaveBeenCalled();
  });
  it("explicit recovery is at most once and cannot retarget another fence", async () => {
    const f = fixture(), recovery = { conversationId: "chat", userId: "owner", token: "fence", requestId: "recover" };
    expect(await f.run("tasks.recover", recovery)).toEqual({ outcome: "accepted" });
    expect(await f.create()("tasks.recover", recovery)).toEqual({ outcome: "accepted" });
    expect(await f.run("tasks.recover", { ...recovery, token: "new_fence" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.bridge.recoverSession).toHaveBeenCalledTimes(1);
    f.channel.canSteerConversation.mockResolvedValue(false);
    expect(await f.run("tasks.recover", { ...recovery, requestId: "new" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.bridge.recoverSession).toHaveBeenCalledTimes(1);
  });
});
