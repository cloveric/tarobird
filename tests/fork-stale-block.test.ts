import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import type { CodexAdapter, EngineSideSession, EngineStreamEvent } from "../src/codex/adapter.js";
import { CoreSideSessions } from "../src/core/side-sessions.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../src/core/message-normalizer.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { gatewayConversationHistory } from "../src/gateway/conversation-history.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import {
  CONVERSATION_HISTORY_CAPABILITY,
  historyClientOperationSchema,
  historyClientSnapshotSchema,
} from "../src/client-protocol/conversation-history.js";
import { historyReason } from "../client/src/conversation-history-state.js";
import { bootstrapTrusted } from "./helpers/pairing-invite.js";
import * as processTree from "../src/codex/process-tree.js";

const REVIEW_CAPS = ["msg_lifecycle_v1", "request_marker_lists_v1", "interrupt_receipt_v1", "interrupt_send_now_v1"];

function fakeClaudeProcess() {
  const lines: Array<Record<string, unknown>> = [];
  const proc = new EventEmitter() as EventEmitter & {
    lines: Array<Record<string, unknown>>;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    killed: boolean;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
    frame: (value: object) => void;
  };
  proc.lines = lines;
  proc.stdin = new PassThrough();
  proc.stdin.on("data", (chunk: Buffer) => {
    for (const raw of chunk.toString("utf8").split("\n").filter(Boolean)) {
      lines.push(JSON.parse(raw) as Record<string, unknown>);
    }
  });
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = 424242;
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = vi.fn(() => { proc.killed = true; return true; });
  proc.frame = (value: object) => { proc.stdout.write(`${JSON.stringify(value)}\n`); };
  return proc;
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition_timeout");
    await tick(5);
  }
}

describe("Issue #131: Fork stays disabled when Claude Bot has nothing running", () => {
  const dirs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length) await cleanups.pop()!();
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  it("does not leave Claude historyBlock stuck after an expired queued task notification or idle init frame", async () => {
    vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve());
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-131-"));
    dirs.push(dir);
    const proc = fakeClaudeProcess();
    const adapter = new ClaudeStreamAdapter("claude", {
      workspacePath: dir,
      taskNotificationStartGraceMs: 25,
      spawnFn: () => proc as never,
    });
    cleanups.push(() => adapter.destroy());
    const sessionId = "11111111-1111-4111-8111-111111111111";

    const turnPromise = adapter.sendUserMessage(sessionId, {
      inputOwnerKey: "gw:conv1",
      text: "hello",
      files: [],
      onEngineEvent: () => undefined,
    });
    await until(() => proc.lines.some(line => line.type === "user"));
    proc.frame({ type: "system", subtype: "init", session_id: sessionId });
    proc.frame({ type: "assistant", session_id: sessionId, message: { id: "m1", content: [{ type: "text", text: "ok" }] } });
    proc.frame({ type: "result", session_id: sessionId, result: "ok" });
    await turnPromise;

    // A review turn runs for task A while tasks B and C finish and get queued as reviewTurn: false.
    proc.frame({ type: "system", subtype: "task_started", session_id: sessionId, task_id: "taskA", description: "bg A" });
    proc.frame({ type: "system", subtype: "task_started", session_id: sessionId, task_id: "taskB", description: "bg B" });
    proc.frame({ type: "system", subtype: "task_started", session_id: sessionId, task_id: "taskC", description: "bg C" });
    await tick(10);
    expect((adapter as unknown as { historyBlock(id: string): string | undefined }).historyBlock(sessionId)).toBe("background_work");

    proc.frame({ type: "user", origin: { kind: "task-notification" }, session_id: sessionId, message: { role: "user", content: "<task-notification><task-id>taskA</task-id><status>completed</status><summary>A done</summary></task-notification>" } });
    proc.frame({ type: "system", subtype: "task_notification", session_id: sessionId, task_id: "taskB", status: "completed", summary: "B done" });
    proc.frame({ type: "system", subtype: "task_notification", session_id: sessionId, task_id: "taskC", status: "completed", summary: "C done" });
    // Task A's review finishes; B and C both anchor to Task A's end time.
    proc.frame({ type: "result", session_id: sessionId, task_id: "taskA", result: "Reviewed A" });

    // Wait past the grace window from Task A's end: both B and C expire without lazily granting C a new grace window.
    await tick(60);

    // A stray idle system/init frame must NOT re-stick nativeTurnOpen.
    proc.frame({ type: "system", subtype: "init", session_id: sessionId });
    await tick(10);

    const blocked = (adapter as unknown as { historyBlock(id: string): string | undefined }).historyBlock(sessionId);
    expect(blocked).toBeUndefined();
    expect(adapter.hasPendingNativeWork()).toBe(false);
  });

  it("anchors queued reviewTurn:false grace to when the blocking review ends so real follow-up reviews are not dropped", async () => {
    vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve());
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-131-grace-"));
    dirs.push(dir);
    const proc = fakeClaudeProcess();
    const eventsP: EngineStreamEvent[] = [];
    const eventsT: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      workspacePath: dir,
      taskNotificationStartGraceMs: 1_000,
      spawnFn: () => proc as never,
    });
    cleanups.push(() => adapter.destroy());
    const sessionId = "22222222-2222-4222-8222-222222222222";

    const turn1 = adapter.sendUserMessage(sessionId, {
      inputOwnerKey: "gw:conv1",
      text: "run P",
      files: [],
      onEngineEvent: e => { eventsP.push(e); },
    });
    await until(() => proc.lines.filter(l => l.type === "user").length === 1);
    proc.frame({ type: "system", subtype: "init", session_id: sessionId });
    proc.frame({ type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id: "toolu-P", name: "Bash", input: { command: "p", run_in_background: true } }] } });
    proc.frame({ type: "system", subtype: "task_started", session_id: sessionId, task_id: "task-P", tool_use_id: "toolu-P" });
    proc.frame({ type: "result", session_id: sessionId, result: "started P" });
    await turn1;

    const turn2 = adapter.sendUserMessage(sessionId, {
      inputOwnerKey: "gw:conv1",
      text: "run T",
      files: [],
      onEngineEvent: e => { eventsT.push(e); },
    });
    await until(() => proc.lines.filter(l => l.type === "user").length === 2);
    proc.frame({ type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id: "toolu-T", name: "Bash", input: { command: "t", run_in_background: true } }] } });
    proc.frame({ type: "system", subtype: "task_started", session_id: sessionId, task_id: "task-T", tool_use_id: "toolu-T" });
    proc.frame({ type: "result", session_id: sessionId, result: "started T" });
    await turn2;

    // Task P's review begins and Task T completes mid-review (system/task_notification -> queued reviewTurn: false).
    proc.frame({ type: "user", origin: { kind: "task-notification" }, session_id: sessionId, message: { role: "user", content: "<task-notification><task-id>task-P</task-id><tool-use-id>toolu-P</tool-use-id><status>completed</status><summary>P done</summary></task-notification>" } });
    proc.frame({ type: "system", subtype: "task_notification", session_id: sessionId, task_id: "task-T", tool_use_id: "toolu-T", status: "completed", summary: "T done" });

    // Task P's review runs longer than the 1000ms grace window.
    now += 2_000;
    proc.frame({ type: "result", session_id: sessionId, result: "Verdict P" });
    await until(() => eventsP.some(e => e.type === "task_notification" && e.text.includes("Verdict P")));

    // 50ms after P ends, Task T's real review starts and finishes — it MUST NOT have expired with 0ms grace.
    now += 50;
    proc.frame({ type: "user", origin: { kind: "task-notification" }, session_id: sessionId, message: { role: "user", content: "<task-notification><task-id>task-T</task-id><tool-use-id>toolu-T</tool-use-id><status>completed</status><summary>T done</summary></task-notification>" } });
    proc.frame({ type: "result", session_id: sessionId, result: "Verdict T" });
    await until(() => eventsT.some(e => e.type === "task_notification" && !e.suppressUserDelivery));

    expect(eventsT.filter(e => e.type === "task_notification")).toEqual([
      expect.objectContaining({ taskId: "task-T", text: "Verdict T" }),
    ]);
    await until(() => (adapter as unknown as { historyBlock(id: string): string | undefined }).historyBlock(sessionId) === undefined);
    expect(adapter.hasPendingNativeWork()).toBe(false);
  });

  it("does not mark preinstalled queued reviews as nativeTurnOpen so adoptReviewForTurn preserves later real reviews", async () => {
    vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve());
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-131-preinstalled-"));
    dirs.push(dir);
    const proc = fakeClaudeProcess();
    const bgEvents: EngineStreamEvent[] = [];
    const humanEvents: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      workspacePath: dir,
      taskNotificationStartGraceMs: 1_000,
      spawnFn: () => proc as never,
    });
    cleanups.push(() => adapter.destroy());
    const sessionId = "33333333-3333-4333-8333-333333333333";

    const first = adapter.sendUserMessage(sessionId, {
      inputOwnerKey: "gw:conv1",
      text: "launch two bg",
      files: [],
      onEngineEvent: e => { bgEvents.push(e); },
    });
    await until(() => proc.lines.filter(l => l.type === "user").length === 1);
    const p1 = proc.lines.find(l => l.type === "user")!.uuid as string;
    proc.frame({ type: "system", subtype: "init", session_id: sessionId, capabilities: REVIEW_CAPS });
    proc.frame({ type: "command_lifecycle", session_id: sessionId, command_uuid: p1, state: "started" });
    proc.frame({ type: "assistant", session_id: sessionId, message: { content: [
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "bg1", run_in_background: true } },
      { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "bg2", run_in_background: true } },
    ] } });
    proc.frame({ type: "system", subtype: "task_started", session_id: sessionId, task_id: "bg-1", tool_use_id: "tool-1" });
    proc.frame({ type: "system", subtype: "task_started", session_id: sessionId, task_id: "bg-2", tool_use_id: "tool-2" });
    proc.frame({ type: "result", session_id: sessionId, result: "launched", user_message_uuid: p1, user_message_uuids: [p1] });
    proc.frame({ type: "command_lifecycle", session_id: sessionId, command_uuid: p1, state: "completed" });
    await first;

    // bg-1 review starts; bg-2 user notification arrives mid-review and queues with reviewTurn: true.
    proc.frame({ type: "user", origin: { kind: "task-notification" }, session_id: sessionId, message: { role: "user", content: "<task-notification><task-id>bg-1</task-id><tool-use-id>tool-1</tool-use-id><status>completed</status></task-notification>" } });
    proc.frame({ type: "user", origin: { kind: "task-notification" }, session_id: sessionId, message: { role: "user", content: "<task-notification><task-id>bg-2</task-id><tool-use-id>tool-2</tool-use-id><status>completed</status></task-notification>" } });
    proc.frame({ type: "result", session_id: sessionId, result: "BG 1 review", origin: { kind: "task-notification" } });
    await until(() => bgEvents.some(e => e.type === "task_notification" && e.taskId === "bg-1"));

    // bg-2 is preinstalled, NOT yet started natively.
    const worker = (adapter as unknown as { workers: Map<string, { nativeTurnOpen: boolean; taskNotificationTurnActive: boolean; pendingTurn: { absorbedReview?: boolean } | null; backgroundTasks: Map<string, unknown>; queuedTaskNotifications: unknown[] }> }).workers.get(sessionId)!;
    expect(worker.taskNotificationTurnActive).toBe(true);
    expect(worker.nativeTurnOpen).toBe(false);

    // Human prompt starts before bg-2's native review begins.
    const human = adapter.sendUserMessage(sessionId, {
      inputOwnerKey: "gw:conv1",
      reviewAdmission: "native",
      nativeInput: { id: "in-1", onProgress: () => undefined },
      text: "human first",
      files: [],
      onEngineEvent: e => { humanEvents.push(e); },
    });
    await until(() => proc.lines.filter(l => l.type === "user").length === 2);
    const p2 = proc.lines.filter(l => l.type === "user")[1]!.uuid as string;
    proc.frame({ type: "command_lifecycle", session_id: sessionId, command_uuid: p2, state: "started" });
    await tick(10);

    expect(worker.pendingTurn?.absorbedReview).toBeUndefined();
    expect(worker.backgroundTasks.has("bg-2")).toBe(true);
    expect(worker.queuedTaskNotifications).toHaveLength(1);

    // Even if the human turn runs longer than the 1000ms grace window, bg-2 gets a fresh grace window after it finishes.
    now += 2_000;
    proc.frame({ type: "result", session_id: sessionId, result: "human answer", user_message_uuid: p2, user_message_uuids: [p2] });
    proc.frame({ type: "command_lifecycle", session_id: sessionId, command_uuid: p2, state: "completed" });
    await expect(human).resolves.toMatchObject({ text: "human answer" });

    // bg-2's real review runs 50ms afterwards and MUST be delivered.
    now += 50;
    proc.frame({ type: "system", subtype: "init", session_id: sessionId, capabilities: REVIEW_CAPS });
    proc.frame({ type: "result", session_id: sessionId, result: "BG 2 real review", origin: { kind: "task-notification" } });
    await until(() => bgEvents.some(e => e.type === "task_notification" && e.taskId === "bg-2" && !e.suppressUserDelivery));

    expect(bgEvents).toContainEqual(expect.objectContaining({ taskId: "bg-2", text: "BG 2 real review" }));
    await until(() => (adapter as unknown as { historyBlock(id: string): string | undefined }).historyBlock(sessionId) === undefined);
    expect(adapter.hasPendingNativeWork()).toBe(false);
  });

  it.each(["native", "ordinary"] as const)("marks nativeTurnOpen=true when system/init starts a review turn so adoption succeeds before assistant frames (%s)", async mode => {
    vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve());
    const dir = await mkdtemp(path.join(os.tmpdir(), `claude-131-init-${mode}-`));
    dirs.push(dir);
    const proc = fakeClaudeProcess();
    const adapter = new ClaudeStreamAdapter("claude", {
      workspacePath: dir,
      taskNotificationStartGraceMs: 10_000,
      spawnFn: () => proc as never,
    });
    cleanups.push(() => adapter.destroy());
    const sessionId = `44444444-4444-4444-8444-44444444444${mode === "native" ? "1" : "2"}`;

    const first = adapter.sendUserMessage(sessionId, {
      inputOwnerKey: "gw:conv1",
      text: "launch bg",
      files: [],
      onEngineEvent: () => undefined,
    });
    await until(() => proc.lines.filter(l => l.type === "user").length === 1);
    const p1 = proc.lines.find(l => l.type === "user")!.uuid as string;
    proc.frame({ type: "system", subtype: "init", session_id: sessionId, capabilities: REVIEW_CAPS });
    proc.frame({ type: "command_lifecycle", session_id: sessionId, command_uuid: p1, state: "started" });
    proc.frame({ type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "bg", run_in_background: true } }] } });
    proc.frame({ type: "system", subtype: "task_started", session_id: sessionId, task_id: "bg-1", tool_use_id: "tool-1" });
    proc.frame({ type: "result", session_id: sessionId, result: "launched", user_message_uuid: p1, user_message_uuids: [p1] });
    proc.frame({ type: "command_lifecycle", session_id: sessionId, command_uuid: p1, state: "completed" });
    await first;

    let human!: Promise<{ text: string }>;
    if (mode === "ordinary") {
      // Prompt written before stdout announces the review; Claude starts the review first via system/task_notification + system/init.
      human = adapter.sendUserMessage(sessionId, { inputOwnerKey: "gw:conv1", text: "ordinary follow-up", files: [], onEngineEvent: () => undefined });
      await until(() => proc.lines.filter(l => l.type === "user").length === 2);
      const p2 = proc.lines.filter(l => l.type === "user")[1]!.uuid as string;
      proc.frame({ type: "command_lifecycle", session_id: sessionId, command_uuid: p2, state: "queued" });
      proc.frame({ type: "system", subtype: "task_notification", session_id: sessionId, task_id: "bg-1", tool_use_id: "tool-1", status: "completed" });
      // For ordinary prompts, activePendingTurn is non-null once written, so test the no-pending-turn init start under native mode;
      // here we simulate a review already started via init before the ordinary prompt gets written (e.g. different inputOwnerKey).
      proc.frame({ type: "user", origin: { kind: "task-notification" }, session_id: sessionId, message: { role: "user", content: "<task-notification><task-id>bg-1</task-id><tool-use-id>tool-1</tool-use-id><status>completed</status></task-notification>" } });
      await tick(10);
      proc.frame({ type: "command_lifecycle", session_id: sessionId, command_uuid: p2, state: "started" });
      proc.frame({ type: "result", session_id: sessionId, result: "adopted reply", user_message_uuid: p2, user_message_uuids: [p2], origin: { kind: "task-notification" } });
      proc.frame({ type: "command_lifecycle", session_id: sessionId, command_uuid: p2, state: "completed" });
      await expect(human).resolves.toMatchObject({ text: "adopted reply" });
    } else {
      // Review starts from system/task_notification + system/init with NO pendingTurn and NO assistant frame yet.
      proc.frame({ type: "system", subtype: "task_notification", session_id: sessionId, task_id: "bg-1", tool_use_id: "tool-1", status: "completed" });
      proc.frame({ type: "system", subtype: "init", session_id: sessionId, capabilities: REVIEW_CAPS });
      await tick(10);

      const worker = (adapter as unknown as { workers: Map<string, { nativeTurnOpen: boolean; taskNotificationTurnActive: boolean; queuedTaskNotifications: unknown[]; pendingTurn: { absorbedReview?: boolean } | null }> }).workers.get(sessionId)!;
      expect(worker.taskNotificationTurnActive).toBe(true);
      expect(worker.nativeTurnOpen).toBe(true);

      human = adapter.sendUserMessage(sessionId, {
        inputOwnerKey: "gw:conv1",
        reviewAdmission: "native",
        nativeInput: { id: "in-init", onProgress: () => undefined },
        text: "adopt init review",
        files: [],
        onEngineEvent: () => undefined,
      });
      await until(() => proc.lines.filter(l => l.type === "user").length === 2);
      const p2 = proc.lines.filter(l => l.type === "user")[1]!.uuid as string;
      proc.frame({ type: "command_lifecycle", session_id: sessionId, command_uuid: p2, state: "started" });
      await tick(10);

      expect(worker.pendingTurn?.absorbedReview).toBe(true);
      expect(worker.queuedTaskNotifications).toHaveLength(0);

      proc.frame({ type: "result", session_id: sessionId, result: "adopted init reply", user_message_uuid: p2, user_message_uuids: [p2], origin: { kind: "task-notification" } });
      proc.frame({ type: "command_lifecycle", session_id: sessionId, command_uuid: p2, state: "completed" });
      await expect(human).resolves.toMatchObject({ text: "adopted init reply" });
    }

    expect((adapter as unknown as { historyBlock(id: string): string | undefined }).historyBlock(sessionId)).toBeUndefined();
    expect(adapter.hasPendingNativeWork()).toBe(false);
  });

  it("clears nativeTurnOpen when pruneExpiredBackgroundTasks settles a wedged review turn", async () => {
    vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve());
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-131-prune-"));
    dirs.push(dir);
    const proc = fakeClaudeProcess();
    const adapter = new ClaudeStreamAdapter("claude", {
      workspacePath: dir,
      taskNotificationStartGraceMs: 10_000,
      backgroundTaskMaxAgeMs: 50,
      spawnFn: () => proc as never,
    });
    cleanups.push(() => adapter.destroy());
    const sessionId = "55555555-5555-4555-8555-555555555555";

    const first = adapter.sendUserMessage(sessionId, { inputOwnerKey: "gw:conv1", text: "hi", files: [], onEngineEvent: () => undefined });
    await until(() => proc.lines.some(l => l.type === "user"));
    proc.frame({ type: "system", subtype: "init", session_id: sessionId });
    proc.frame({ type: "system", subtype: "task_started", session_id: sessionId, task_id: "wedged" });
    proc.frame({ type: "result", session_id: sessionId, result: "ok" });
    await first;

    proc.frame({ type: "system", subtype: "task_notification", session_id: sessionId, task_id: "wedged", status: "completed" });
    proc.frame({ type: "system", subtype: "init", session_id: sessionId });
    await tick(10);
    expect((adapter as unknown as { historyBlock(id: string): string | undefined }).historyBlock(sessionId)).toBe("busy");

    const worker = (adapter as unknown as { workers: Map<string, { nativeTurnOpen: boolean }> }).workers.get(sessionId)!;
    (adapter as unknown as { pruneExpiredBackgroundTasks(w: unknown, now: number): void }).pruneExpiredBackgroundTasks(worker, Date.now() + 100);
    expect(worker.nativeTurnOpen).toBe(false);
    expect((adapter as unknown as { historyBlock(id: string): string | undefined }).historyBlock(sessionId)).toBeUndefined();
  });

  it("reports side_session for preparing, idle, and closing side sessions on Bridge and Gateway without blocking other chats", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "side-131-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh", approvalMode: "bypass" }));

    const convAKey = buildCoreConversationKey("convA");
    const convBKey = buildCoreConversationKey("convB");
    const store = new SessionStore(path.join(dir, "session.json"));
    await store.upsert({ telegramChatId: stableCoreNumericId(convAKey), conversationKey: convAKey, codexSessionId: "native-A", status: "idle", updatedAt: "2026-01-01T00:00:00.000Z" });
    await store.upsert({ telegramChatId: stableCoreNumericId(convBKey), conversationKey: convBKey, codexSessionId: "native-B", status: "idle", updatedAt: "2026-01-01T00:00:00.000Z" });

    let releaseOpen!: () => void;
    let releaseDispose!: () => void;
    const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
    const disposeGate = new Promise<void>(resolve => { releaseDispose = resolve; });
    let failNextOpen = false;

    const fakeAdapter: CodexAdapter = {
      createSession: vi.fn(),
      sendUserMessage: vi.fn(),
      getHistoryState: vi.fn(async () => ({ head: "head-1", fork: { whole: true, anchored: true }, rewind: false })),
      forkHistory: vi.fn(async () => ({ outcome: "applied" as const, sessionId: "native-fork", head: "head-1", boundary: "whole" as const })),
      openSideSession: vi.fn(async (): Promise<EngineSideSession> => {
        if (failNextOpen) throw new Error("no_main_session");
        await openGate;
        return {
          nativeId: "side-1",
          send: async () => ({ text: "ok" }),
          dispose: async () => { await disposeGate; },
        };
      }),
    };
    const access: AccessStoreLike = {
      load: vi.fn(async () => ({ multiChat: false, policy: "allowlist" as const, allowlist: [], pairedUsers: [], pendingPairs: [] })),
      issuePairingCode: vi.fn(),
    };
    const bridge = new Bridge(access, new SessionManager(store, fakeAdapter), fakeAdapter);
    const surface = bridge.createAuthenticatedSurface();

    const side = new CoreSideSessions({
      open: async (scope, abortSignal) => {
        const key = buildCoreConversationKey(scope.conversationId);
        return surface.openSideSession({ chatId: stableCoreNumericId(key), conversationKey: key, userId: 1, chatType: "bus", abortSignal });
      },
      beforeAsk: async () => undefined,
      record: async () => undefined,
    });
    cleanups.push(() => side.closeAll());

    const channel = {
      transport: {
        capabilities: [CONVERSATION_HISTORY_CAPABILITY],
        requestLive: async () => ({ allowed: true }),
        enqueue: () => ({ persisted: Promise.resolve(), response: Promise.resolve() }),
      },
      isConversationProcessing: () => false,
      canSteerConversation: async () => true,
    };
    const runtime = createCoreServiceRuntime();
    const handler = gatewayConversationHistory(bridge, channel as never, runtime, dir, "bot1", (convId) => side.hasOpenSession(convId));

    // 1) Preparing side session on convA: blocks convA with side_session, never blocks convB.
    const opened = side.open({ userId: "owner", deviceId: "dev1", conversationId: "convA" }, "req1", { supported: true, concurrent: true, liveContext: false, tools: "none" });
    expect(opened.ok).toBe(true);
    const sideId = opened.ok ? opened.view!.id : "";
    expect(side.activeCount("convA")).toBe(1);
    expect(side.hasOpenSession("convA")).toBe(true);
    expect(side.hasOpenSession("convB")).toBe(false);

    expect(await handler("history.snapshot", { userId: "owner", botId: "bot1", conversationId: "convB" })).not.toHaveProperty("blocked");
    expect(await handler("history.snapshot", { userId: "owner", botId: "bot1", conversationId: "convA" })).toMatchObject({ blocked: "side_session" });

    // 2) Once preparation finishes, phase becomes "idle" (activeCount === 0), yet Bridge & Gateway MUST STILL report side_session (NOT "busy"!).
    releaseOpen();
    await until(() => side.activeCount("convA") === 0);
    expect(side.hasOpenSession("convA")).toBe(true);

    // Direct Bridge check (even without gateway sideBusy override) reports side_session rather than busy.
    expect(await bridge.getConversationHistory({ chatId: stableCoreNumericId(convAKey), conversationKey: convAKey })).toMatchObject({ blocked: "side_session" });
    expect(await bridge.applyConversationHistory({
      chatId: stableCoreNumericId(convAKey),
      conversationKey: convAKey,
      operationId: "op-direct",
      expectedRevision: "rev",
      action: { kind: "fork", scope: "whole" },
    })).toEqual({ outcome: "rejected", reason: "side_session" });

    // Gateway snapshot & apply also report side_session on idle side session.
    expect(await handler("history.snapshot", { userId: "owner", botId: "bot1", conversationId: "convA" })).toMatchObject({ blocked: "side_session" });
    expect(await handler("history.apply", {
      userId: "owner",
      botId: "bot1",
      conversationId: "convA",
      operationId: "op-idle",
      expectedRevision: "rev1",
      action: { kind: "fork", scope: "whole" },
    })).toEqual({ outcome: "rejected", reason: "side_session" });

    // 3) While close() is disposing on the Host, both Bridge and CoreSideSessions still report side_session.
    const closing = side.close({ userId: "owner", deviceId: "dev1", conversationId: "convA" }, sideId);
    await tick(10);
    expect(side.hasOpenSession("convA")).toBe(true);
    expect(await handler("history.snapshot", { userId: "owner", botId: "bot1", conversationId: "convA" })).toMatchObject({ blocked: "side_session" });

    // 4) Once disposal finishes, convA is unblocked.
    releaseDispose();
    await closing;
    expect(side.hasOpenSession("convA")).toBe(false);
    expect(await handler("history.snapshot", { userId: "owner", botId: "bot1", conversationId: "convA" })).not.toHaveProperty("blocked");

    // 5) A failed open (phase: "error") has no native reader and must NOT block Fork.
    failNextOpen = true;
    const failed = side.open({ userId: "owner", deviceId: "dev1", conversationId: "convA" }, "req2", { supported: true, concurrent: true, liveContext: false, tools: "none" });
    expect(failed.ok).toBe(true);
    await until(() => side.activeCount("convA") === 0);
    expect(side.hasOpenSession("convA")).toBe(false);
    expect(await handler("history.snapshot", { userId: "owner", botId: "bot1", conversationId: "convA" })).not.toHaveProperty("blocked");
  });

  it("gates side_session on HTTP behind ?sideReason=1 so shipped v1.6.0 clients parse snapshot/start/status/reconcile cleanly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "history-compat-131-"));
    dirs.push(dir);
    const hub = await HubServer.start({ stateDir: path.join(dir, "hub") });
    let socket: WebSocket | undefined;
    let channel: GatewayChannel | undefined;
    cleanups.push(async () => {
      socket?.terminate();
      await channel?.disconnect();
      await hub.close();
    });

    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Fixture',?,'claude')", [hashSecret(secret)]);
    const conversationId = (await hub.store.createConversation("owner", ["bot"], "Source", "create")).id;
    const keys = generateKeyPairSync("ed25519");
    await bootstrapTrusted(hub.auth, {
      deviceId: "device",
      name: "Fixture",
      platform: "web",
      publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    });
    socket = new WebSocket(hub.url.replace("http", "ws") + "/ws");
    const frames: Array<Record<string, unknown>> = [];
    socket.on("message", data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "snapshot.message") {
        socket!.send(JSON.stringify({ v: 1, type: "snapshot.ack", id: frame.id, count: (frame.index as number) + 1 }));
      }
    });
    const next = async (type: string) => {
      await until(() => frames.some(f => f.type === type));
      return frames.splice(frames.findIndex(f => f.type === type), 1)[0]!;
    };
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    const nonce = randomBytes(32).toString("base64url");
    socket.send(JSON.stringify({ v: 1, type: "hello", deviceId: "device", nonce, protocolVersions: [1], capabilities: [], cursors: {} }));
    const challenge = await next("challenge");
    socket.send(JSON.stringify({ v: 1, type: "auth", signature: sign(null, deviceProof("device", challenge.nonce as string, nonce), keys.privateKey).toString("base64") }));
    const ready = await next("ready");
    await next("sync.complete");

    const workerDir = path.join(dir, "worker");
    await mkdir(workerDir, { recursive: true });
    await writeFile(path.join(workerDir, "config.json"), "{}");
    const transport = new GatewayTransport({
      stateDir: workerDir,
      url: hub.instanceUrl.replace("http", "ws") + "/instance",
      botId: "bot",
      secret,
      engine: "claude",
    });
    channel = new GatewayChannel(transport);
    channel.canSteerConversation = async () => true;
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })),
      getConversationHistory: vi.fn(async () => ({
        supported: true,
        revision: "revision_a",
        sourceSessionId: "native",
        bindingGeneration: "gen_1",
        capabilities: { rewind: false, fork: true, anchoredFork: false },
      })),
      applyConversationHistory: vi.fn(),
      finalizeConversationHistory: vi.fn(async () => ({ revision: "revision_a" })),
    };
    channel.onCall = gatewayConversationHistory(bridge, channel, createCoreServiceRuntime(), workerDir, "bot", () => true);
    let attached!: () => void;
    const attachedPromise = new Promise<void>(resolve => { attached = resolve; });
    transport.onBoot = async () => attached();
    await channel.connect();
    await attachedPromise;

    const headers = { Authorization: `Bearer ${ready.sessionToken as string}` };
    const base = `${hub.url}/api/conversations/${conversationId}/history`;
    // Strict v1.6.0 enum (no "side_session").
    const v160ReasonSchema = z.enum([
      "unsupported", "wrong_scope", "not_ready", "busy", "queued", "goal_active",
      "background_work", "shared_session", "binding_pending", "outcome_unknown",
      "source_changed", "source_missing", "anchor_unavailable", "request_conflict", "storage_unavailable",
      "uncertain", "cancelled",
    ]);

    // Legacy v1.6.0 client (no ?sideReason=1) gets "background_work" across snapshot, start, status, and reconcile.
    const legacySnapshot = await (await fetch(`${base}?botId=bot`, { headers })).json() as { blocked?: string };
    expect(legacySnapshot.blocked).toBe("background_work");
    expect(() => v160ReasonSchema.parse(legacySnapshot.blocked)).not.toThrow();

    const change = { botId: "bot", requestId: "req_side_1", expectedRevision: "revision_a", action: { kind: "fork", scope: "whole" } };
    const legacyStart = await (await fetch(`${base}/operations`, { method: "POST", headers, body: JSON.stringify(change) })).json() as { state: string; reason?: string };
    expect(legacyStart).toMatchObject({ state: "rejected", reason: "background_work" });
    expect(() => v160ReasonSchema.parse(legacyStart.reason)).not.toThrow();

    const legacyStatus = await (await fetch(`${base}/operations/req_side_1?botId=bot`, { headers })).json() as { state: string; reason?: string };
    expect(legacyStatus).toMatchObject({ state: "rejected", reason: "background_work" });

    const legacyReconcile = await (await fetch(`${base}/operations/req_side_1/reconcile`, { method: "POST", headers, body: JSON.stringify(change) })).json() as { state: string; reason?: string };
    expect(legacyReconcile).toMatchObject({ state: "rejected", reason: "background_work" });

    // Opted-in client (?sideReason=1) receives exact "side_session" across all 4 endpoints.
    expect(await (await fetch(`${base}?botId=bot&sideReason=1`, { headers })).json()).toMatchObject({ blocked: "side_session" });
    expect(await (await fetch(`${base}/operations?sideReason=1`, { method: "POST", headers, body: JSON.stringify(change) })).json()).toMatchObject({ state: "rejected", reason: "side_session" });
    expect(await (await fetch(`${base}/operations/req_side_1?botId=bot&sideReason=1`, { headers })).json()).toMatchObject({ state: "rejected", reason: "side_session" });
    expect(await (await fetch(`${base}/operations/req_side_1/reconcile?sideReason=1`, { method: "POST", headers, body: JSON.stringify(change) })).json()).toMatchObject({ state: "rejected", reason: "side_session" });

    // Newer client schemas tolerate unknown future reason codes safely without throwing.
    expect(historyClientSnapshotSchema.parse({ supported: true, blocked: "future_reason_v2" }).blocked).toBe("future_reason_v2");
    expect(historyClientOperationSchema.parse({ requestId: "r1", operationId: "op1", state: "rejected", reason: "future_reason_v2", sourceRevision: "rev1" }).reason).toBe("future_reason_v2");
  });

  it("renders distinct user-facing messages for busy, background_work, side_session, and unknown future reasons", () => {
    const busyText = historyReason("busy");
    const bgText = historyReason("background_work");
    const sideText = historyReason("side_session");
    const futureText = historyReason("future_reason_v2");
    expect(busyText).not.toBe(bgText);
    expect(bgText).not.toBe(sideText);
    expect(busyText).not.toBe(sideText);
    expect(sideText).toContain("关闭");
    expect(futureText).toBe("请刷新会话状态后重试。");
  });
});
