import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineSteeringRejectedError, type EngineStreamEvent } from "../src/codex/adapter.js";
import { OmpRpcAdapter } from "../src/codex/omp-rpc-adapter.js";
import activateExtension, { OMP_BRIDGE_GLOBAL_KEY } from "../src/codex/omp-bridge-extension.js";
import { openOmpBridgeEndpoint } from "../src/codex/omp-bridge-host.js";
import { parseOmpFormRequest } from "../src/codex/omp-form.js";
import { OmpRpcCommandError } from "../src/codex/omp-rpc-client.js";
import { OmpFrameError, OmpProtocolVersionError } from "../src/codex/omp-rpc-protocol.js";
import { OmpSessionStore } from "../src/codex/omp-session-store.js";
import { resolveOmpExecutable } from "../src/runtime/omp-executable.js";
import type { SteeringApplication } from "../src/client-protocol/steering-outcome.js";
import { Bridge } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";

class FakeOmpProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 51515;
  killed = false;
  exitCode: number | null = null;
  readonly received: Array<Record<string, unknown>> = [];
  private buffer = "";

  constructor(private readonly onCommand: (cmd: Record<string, unknown>, proc: FakeOmpProcess) => void) {
    super();
    this.stdin.on("end", () => {
      if (!this.killed) this.kill();
    });
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        this.received.push(parsed);
        this.onCommand(parsed, this);
      }
    });
  }

  send(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  sendChunked(frame: Record<string, unknown>, chunkSize = 32, chunkId = "rpc-1"): void {
    const raw = Buffer.from(JSON.stringify(frame), "utf8");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < raw.length; offset += chunkSize) {
      chunks.push(raw.subarray(offset, offset + chunkSize));
    }
    chunks.forEach((part, index) => {
      this.send({
        type: "rpc_chunk",
        chunkId,
        index,
        count: chunks.length,
        byteLength: raw.length,
        data: part.toString("base64"),
      });
    });
  }

  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, signal ?? null);
    this.emit("close", 0, signal ?? null);
    return true;
  });
}

function defaultState() {
  return {
    model: { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16384 },
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    isSettled: true,
    hasPendingAsyncWork: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    interruptMode: "immediate",
    sessionId: "omp-sess-1",
    sessionFile: "/tmp/omp-sess-1.jsonl",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}

describe("Issue #83: oh-my-pi (omp) RPC engine integration", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    const store = globalThis as unknown as Record<symbol, { socket?: { destroy?: () => void } } | undefined>;
    const key = Symbol.for(OMP_BRIDGE_GLOBAL_KEY);
    store[key]?.socket?.destroy?.();
    delete store[key];
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  it("negotiates v2, reassembles chunked frames, and ends a turn on prompt_result + session_settled (ignoring yielded:false)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-test-"));
    dirs.push(dir);
    let negotiated = false;
    let proc!: FakeOmpProcess;
    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol") {
            negotiated = cmd.protocolVersion === 2;
            p.send({ id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
            return;
          }
          if (cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") {
            p.sendChunked({ id, type: "response", command: "get_state", success: true, data: defaultState() });
            return;
          }
          if (cmd.type === "open_session") {
            p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-sess-1", sessionFile: path.join(dir, "omp-sess-1.jsonl") } });
            return;
          }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            // Simulate a non-terminal agent_end (yielded: false) which MUST NOT end the turn!
            p.send({ type: "agent_start" });
            p.send({ type: "message_update", messageId: "m1", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Planning..." }, message: { role: "assistant", content: [] } });
            p.send({ type: "agent_end", messages: [], isTerminal: false, yielded: false });
            // Now emit the actual text delta + terminal agent_end + prompt_result (sessionSettled: false) + session_settled.
            p.send({ type: "message_update", messageId: "m1", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello from omp!" }, message: { role: "assistant", content: [] } });
            p.send({ type: "message_end", messageId: "m1", message: { role: "assistant", content: [{ type: "thinking", thinking: "Planning..." }, { type: "text", text: "Hello from omp!" }], stopReason: "stop" } });
            p.send({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
            p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: false });
            setTimeout(() => p.send({ type: "session_settled" }), 20);
          }
        });
        queueMicrotask(() => {
          proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864, supportsBashExcludeFromContext: true });
        });
        return proc as never;
      },
    });

    const events: EngineStreamEvent[] = [];
    const result = await adapter.sendUserMessage("conv-1", {
      text: "Say hi",
      files: [],
      onEngineEvent: (ev) => { events.push(ev); },
    });

    expect(negotiated).toBe(true);
    expect(result.text).toBe("Hello from omp!");
    expect(events.some(e => e.type === "thinking")).toBe(true);
    expect(events.some(e => e.type === "assistant_text")).toBe(true);
    await adapter.destroy();
  });

  it("aborts a running turn cleanly via omp abort command", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-stop-"));
    dirs.push(dir);
    let activePromptId: string | undefined;
    let abortedCmd = false;
    let proc!: FakeOmpProcess;
    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-sess-stop" } }); return; }
          if (cmd.type === "prompt") {
            activePromptId = id;
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "agent_start" });
            return;
          }
          if (cmd.type === "abort_and_restore_queue" || cmd.type === "abort") {
            abortedCmd = cmd.type === "abort_and_restore_queue";
            p.send({ id, type: "response", command: cmd.type, success: true, data: { steering: [], followUp: [] } });
            p.send({ type: "prompt_result", id: activePromptId, agentInvoked: true, status: "aborted", sessionSettled: true });
            p.send({ type: "session_settled" });
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }));
        return proc as never;
      },
    });

    const controller = new AbortController();
    const turnPromise = adapter.sendUserMessage("conv-stop", {
      text: "Long task",
      files: [],
      abortSignal: controller.signal,
      onEngineEvent: () => undefined,
    });
    await vi.waitFor(() => expect(activePromptId).toBeDefined());
    controller.abort("user_stop");
    await expect(turnPromise).rejects.toThrow(/aborted|stopped/i);
    expect(abortedCmd).toBe(true);
    await adapter.destroy();
  });

  it("supports omp's three queues: steer, follow_up, and aside (btw)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-queues-"));
    dirs.push(dir);
    let activePromptId: string | undefined;
    let proc!: FakeOmpProcess;
    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-sess-q" } }); return; }
          if (cmd.type === "prompt") {
            activePromptId = id;
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "agent_start" });
            return;
          }
          if (cmd.type === "steer") {
            p.send({ id, type: "response", command: "steer", success: true });
            p.send({ type: "queue_update", steering: [cmd.message], followUp: [] });
            return;
          }
          if (cmd.type === "follow_up") {
            p.send({ id, type: "response", command: "follow_up", success: true });
            p.send({ type: "queue_update", steering: [], followUp: [cmd.message] });
            return;
          }
          if (cmd.type === "btw") {
            p.send({ type: "btw_record", record: { id: "btw-1", question: cmd.question, answer: "", status: "running", leafId: null, createdAt: 1, updatedAt: 1 } });
            p.send({ id, type: "response", command: "btw", success: true, data: { record: { id: "btw-1", question: cmd.question, answer: "", status: "running", leafId: null, createdAt: 1, updatedAt: 1 } } });
            p.send({ type: "btw_delta", recordId: "btw-1", delta: "Side answer." });
            p.send({ type: "btw_record", record: { id: "btw-1", question: cmd.question, answer: "Side answer.", status: "complete", leafId: null, createdAt: 1, updatedAt: 2 } });
            // Finish main prompt after btw completes
            setTimeout(() => {
              p.send({ type: "message_end", messageId: "m-q", message: { role: "assistant", content: [{ type: "text", text: "Steered done." }], stopReason: "stop" } });
              p.send({ type: "prompt_result", id: activePromptId, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
            }, 10);
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }));
        return proc as never;
      },
    });

    const turnPromise = adapter.sendUserMessage("conv-q", {
      text: "Start work",
      files: [],
      onEngineEvent: () => undefined,
    });
    await vi.waitFor(() => expect(activePromptId).toBeDefined());

    await adapter.steerSession("conv-q", "Change focus");
    await adapter.followUpSession("conv-q", "Also add tests");
    const aside = await adapter.askAside("conv-q", "Why this lock?");
    expect(aside.answer).toBe("Side answer.");

    const final = await turnPromise;
    expect(final.text).toBe("Steered done.");
    expect(proc.received.some(c => c.type === "steer" && c.message === "Change focus")).toBe(true);
    expect(proc.received.some(c => c.type === "follow_up" && c.message === "Also add tests")).toBe(true);
    expect(proc.received.some(c => c.type === "btw" && c.question === "Why this lock?")).toBe(true);
    await adapter.destroy();
  });

  it("maps omp subagents (task) into scoped events, listTasks, and cancel_subagent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-subagent-"));
    dirs.push(dir);
    let cancelledId: string | undefined;
    let finishSubagent!: () => void;
    const subagentGate = new Promise<void>(r => { finishSubagent = r; });
    let proc!: FakeOmpProcess;
    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-sess-sub" } }); return; }
          if (cmd.type === "cancel_subagent") {
            cancelledId = cmd.subagentId as string;
            p.send({ id, type: "response", command: "cancel_subagent", success: true, data: { cancelled: true } });
            p.send({ type: "subagent_lifecycle", payload: { id: cancelledId, index: 0, agent: "explore", description: "Explore codebase", status: "aborted" } });
            return;
          }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "agent_start" });
            p.send({ type: "subagent_lifecycle", payload: { id: "sub-1", index: 0, agent: "explore", description: "Explore codebase", status: "started" } });
            p.send({ type: "subagent_progress", payload: { index: 0, agent: "explore", status: "running", currentTool: "grep", currentToolArgs: "src/" } });
            void subagentGate.then(() => {
              p.send({ type: "subagent_lifecycle", payload: { id: "sub-1", index: 0, agent: "explore", description: "Explore codebase", status: "completed" } });
              p.send({ type: "message_end", messageId: "m-s", message: { role: "assistant", content: [{ type: "text", text: "Subagent finished." }], stopReason: "stop" } });
              p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
            });
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }));
        return proc as never;
      },
    });

    const events: EngineStreamEvent[] = [];
    const turnPromise = adapter.sendUserMessage("conv-sub", {
      text: "Run subagent",
      files: [],
      onEngineEvent: (ev) => { events.push(ev); },
    });
    let liveTasks = await adapter.listTasks("conv-sub");
    await vi.waitFor(async () => {
      liveTasks = await adapter.listTasks("conv-sub");
      expect(liveTasks.tasks.some(t => t.kind === "subagent" && t.label === "Explore codebase" && t.status === "running")).toBe(true);
    });
    const stopResult = await adapter.stopTask("conv-sub", { taskId: liveTasks.tasks[0]!.id });
    expect(stopResult.outcome).toBe("accepted");
    expect(cancelledId).toBe("sub-1");
    finishSubagent();

    await turnPromise;
    expect(events.some(e => e.type === "scoped" && e.scope.kind === "subagent")).toBe(true);
    await adapter.destroy();
  });

  it("reports explicit errors on unsupported protocol version (no silent downgrade) and prompt_result error frames", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-err-"));
    dirs.push(dir);
    // 1. Unsupported protocol version 99 -> MUST throw OmpProtocolVersionError, never silently downgrade!
    const badVersionAdapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        const proc = new FakeOmpProcess(() => undefined);
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 99, supportedProtocolVersions: [99], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });
    await expect(badVersionAdapter.sendUserMessage("conv-v99", {
      text: "hi",
      files: [],
      onEngineEvent: () => undefined,
    })).rejects.toThrow(OmpProtocolVersionError);
    await badVersionAdapter.destroy();

    // 2. prompt_result with status: "error" -> surfaces provider error cleanly!
    const errAdapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-sess-err" } }); return; }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "prompt_result", id, agentInvoked: true, status: "error", error: { message: "Session cost cap exceeded", code: "cost_cap", retryable: false }, sessionSettled: true });
            p.send({ type: "session_settled" });
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });
    await expect(errAdapter.sendUserMessage("conv-err", {
      text: "hi",
      files: [],
      onEngineEvent: () => undefined,
    })).rejects.toThrow(/cost cap/i);
    await errAdapter.destroy();
  });

  it("discovers omp executable from explicit override, PATH, install script, Homebrew, and bun", () => {
    expect(resolveOmpExecutable({ OMP_EXECUTABLE: "/custom/bin/omp" }, "darwin")).toBe("/custom/bin/omp");
    expect(resolveOmpExecutable({ PATH: "", HOME: "/nonexistent-home-123" }, "darwin")).toBe("omp");
  });

  it("aligns with Codex/Claude: steerActiveTurn, host tools (set_host_tools), history fork/rewind, native goal, images, usage, and ask dialogs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-parity-"));
    dirs.push(dir);
    const pngPath = path.join(dir, "sample.png");
    await writeFile(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));

    let activeSessionFile = path.join(dir, "sess-main.jsonl");
    const forkedSessionFile = path.join(dir, "sess-fork.jsonl");
    const entries: Array<{ id: string; parentId: string | null; type: string; message?: { role: string; content: unknown; timestamp?: number } }> = [];
    let leafId: string | null = null;
    let currentGoal: { objective: string; status: string; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number } | null = null;
    let receivedImagesCount = 0;
    let hostToolsRegistered: string[] = [];
    let hostToolResultReceived: unknown;
    let askResponseReceived: unknown;
    let steeredText: string | undefined;
    let forkedAt: unknown;
    let publishUserEvent = true;
    const mainScope = { chatId: 7, userId: 42, chatType: "private", conversationKey: "lark:main" };
    const otherScope = { ...mainScope, chatId: 8, conversationKey: "lark:other" };
    let resolvePromptReady!: () => void;
    const promptReady = new Promise<void>(r => { resolvePromptReady = r; });
    let finishPrompt!: () => void;
    const promptGate = new Promise<void>(r => { finishPrompt = r; });

    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_available_commands") {
            p.send({ id, type: "response", command: "get_available_commands", success: true, data: { commands: [{ name: "compact", source: "builtin", description: "Compact context" }] } });
            return;
          }
          if (cmd.type === "get_state") {
            p.send({
              id,
              type: "response",
              command: "get_state",
              success: true,
              data: {
                ...defaultState(),
                model: { ...defaultState().model, input: ["text", "image"] },
                sessionFile: activeSessionFile,
                contextUsage: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
                goal: currentGoal,
              },
            });
            return;
          }
          if (cmd.type === "open_session") {
            p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-main", sessionFile: activeSessionFile } });
            return;
          }
          if (cmd.type === "switch_session") {
            activeSessionFile = cmd.sessionPath as string;
            p.send({ id, type: "response", command: "switch_session", success: true, data: { cancelled: false } });
            return;
          }
          if (cmd.type === "set_host_tools") {
            hostToolsRegistered = ((cmd.tools as Array<{ name: string }>) ?? []).map(t => t.name);
            p.send({ id, type: "response", command: "set_host_tools", success: true, data: { toolNames: hostToolsRegistered } });
            return;
          }
          if (cmd.type === "host_tool_result") {
            hostToolResultReceived = cmd;
            return;
          }
          if (cmd.type === "extension_ui_response") {
            askResponseReceived = cmd;
            return;
          }
          if (cmd.type === "btw_cancel") {
            p.send({ id, type: "response", command: "btw_cancel", success: true, data: {} });
            return;
          }
          if (cmd.type === "btw") {
            p.send({ id, type: "response", command: "btw", success: true, data: { record: {
              id: "side-1", question: cmd.question, answer: "Main context.", status: "complete", leafId, createdAt: 1, updatedAt: 2,
            } } });
            return;
          }
          if (cmd.type === "steer") {
            steeredText = cmd.message as string;
            entries.push({ id: "u_steer", parentId: leafId, type: "message", message: { role: "user", content: steeredText, timestamp: 2000 } });
            entries.push({ id: "a_steer", parentId: "u_steer", type: "message", message: { role: "assistant", content: "Aligned reply." } });
            leafId = "a_steer";
            p.send({ type: "message_start", messageId: "stream_steer", message: { role: "user", content: steeredText, timestamp: 2000 } });
            p.send({ id, type: "response", command: "steer", success: true });
            return;
          }
          if (cmd.type === "get_entries") {
            p.send({ id, type: "response", command: "get_entries", success: true, data: { entries, leafId } });
            return;
          }
          if (cmd.type === "fork") {
            forkedAt = cmd.entryId;
            activeSessionFile = forkedSessionFile;
            p.send({ id, type: "response", command: "fork", success: true, data: { cancelled: false } });
            return;
          }
          if (cmd.type === "navigate_tree") {
            const target = cmd.entryId as string;
            const idx = entries.findIndex(e => e.id === target);
            leafId = idx > 0 ? entries[idx - 1]!.id : null;
            p.send({ id, type: "response", command: "navigate_tree", success: true, data: { cancelled: false } });
            return;
          }
          if (cmd.type === "goal") {
            if (cmd.op === "create") {
              currentGoal = { objective: cmd.objective as string, status: "active", tokenBudget: (cmd.token_budget as number) ?? null, tokensUsed: 0, timeUsedSeconds: 0 };
            } else if (cmd.op === "pause" && currentGoal) {
              currentGoal = { ...currentGoal, status: "paused" };
            } else if (cmd.op === "drop") {
              currentGoal = null;
            }
            p.send({ id, type: "response", command: "goal", success: true, data: { goal: currentGoal } });
            return;
          }
          if (cmd.type === "prompt") {
            receivedImagesCount = Array.isArray(cmd.images) ? cmd.images.length : 0;
            const userId = `u_${entries.length + 1}`;
            const asstId = `a_${entries.length + 2}`;
            entries.push({ id: userId, parentId: leafId, type: "message", message: { role: "user", content: cmd.message, timestamp: 1000 } });
            leafId = userId;
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "agent_start" });
            if (publishUserEvent) {
              p.send({ type: "message_start", messageId: "stream_main", message: { role: "user", content: cmd.message, timestamp: 1000 } });
            }
            p.send({ type: "auto_retry_start", attempt: 1, delayMs: 250, errorMessage: "HTTP 429 rate limit" });
            p.send({ type: "auto_retry_end", success: true, attempt: 1 });
            p.send({ type: "host_tool_call", id: "ht_1", toolCallId: "tc_1", toolName: "send_file", arguments: { path: "out.txt" } });
            p.send({
              type: "extension_ui_request",
              id: "ui_ask_1",
              method: "ask",
              questions: [{ id: "db", question: "Pick DB", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
            });
            resolvePromptReady();
            void promptGate.then(() => {
              entries.push({ id: asstId, parentId: leafId, type: "message", message: { role: "assistant", content: [{ type: "text", text: "Aligned reply." }] } });
              leafId = asstId;
              p.send({
                type: "message_end",
                messageId: "m-p",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Aligned reply." }],
                  stopReason: "stop",
                  usage: { input: 500, output: 120, cacheRead: 80, cost: { total: 0.0125 } },
                },
              });
              p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
            });
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }));
        return proc as never;
      },
    });

    await expect(adapter.openSideSession({ sourceSessionId: "missing-native-session" })).rejects.toThrow("no_main_session");
    const events: EngineStreamEvent[] = [];
    const access = { load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [7, 8], pairedUsers: [], pendingPairs: [] }), issuePairingCode: vi.fn() };
    const sessions = new SessionManager(new SessionStore(path.join(dir, "session.json")), adapter);
    const bridge = new Bridge(access, sessions, adapter);
    const onHistoryAnchor = vi.fn();
    const turnPromise = bridge.handleAuthorizedMessage({
      ...mainScope,
      historyInputMessageId: "app-main",
      onHistoryAnchor,
      text: "Check image and call host tool",
      files: [pngPath],
      appPlatformTools: {
        definitions: [{ name: "send_file", description: "Deliver a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
        instructions: "Use send_file to deliver outputs.",
        isRegistered: async () => false,
        register: async () => undefined,
        call: async ({ name, arguments: args }) => ({ text: `delivered:${name}:${JSON.stringify(args)}` }),
      },
      onApprovalRequest: async (req) => {
        expect(req.engine).toBe("omp");
        expect(req.toolName).toBe("AskUserQuestion");
        return { behavior: "allow", updatedInput: { answers: { "Pick DB": "Postgres" } } };
      },
      onEngineEvent: (ev) => { events.push(ev); },
    });

    let sessionId: string;
    try {
      await promptReady;
      await expect.poll(() => bridge.inFlightSendBehavior(mainScope)).toBe("steer");
      sessionId = (await sessions.getExistingSession(mainScope))!.sessionId;
      expect(await bridge.inFlightSendBehavior(otherScope)).toBeUndefined();
      expect(await bridge.steerActiveTurn({ ...otherScope, text: "Wrong turn" })).toBe(false);
      await expect(bridge.openSideSession(otherScope)).rejects.toThrow("no_main_session");
      const runningSide = await bridge.openSideSession(mainScope);
      try {
        expect(await runningSide.send({ text: "What is the topic?", files: [], onEngineEvent: vi.fn() })).toEqual({ text: "Main context." });
      } finally { await runningSide.dispose(); }
      expect(await bridge.steerActiveTurn({ ...mainScope, text: "Keep it concise" })).toBe(true);
      expect(steeredText).toBe("Keep it concise");
    } finally {
      finishPrompt();
      await turnPromise;
    }
    const response = await turnPromise;
    expect(response.text).toBe("Aligned reply.");
    expect(response.usage).toEqual({ inputTokens: 500, outputTokens: 120, cachedTokens: 80, costUsd: 0.0125 });
    expect(receivedImagesCount).toBe(1);
    expect(hostToolsRegistered).toEqual(["send_file"]);
    expect((hostToolResultReceived as { result?: { content?: Array<{ text?: string }> } })?.result?.content?.[0]?.text).toContain("delivered:send_file");
    expect((askResponseReceived as { answers?: Array<{ id: string; selectedOptions: string[] }> })?.answers).toEqual([{ id: "db", selectedOptions: ["Postgres"] }]);
    expect(events.some(e => e.type === "engine_retry" && e.status === "waiting" && e.reason === "rate-limit")).toBe(true);
    expect(onHistoryAnchor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      messageId: "app-main", sessionId,
      nativeAnchor: expect.objectContaining({ inputId: "u_1", fork: true, rewind: true, data: { forkLeafId: "a_2" } }),
    }));
    expect(adapter.advertisedCommands()).toEqual([{ name: "compact", description: "Compact context" }]);

    const idleSide = await bridge.openSideSession(mainScope);
    expect(await idleSide.send({ text: "What is the topic?", files: [], onEngineEvent: vi.fn() })).toEqual({ text: "Main context." });
    await idleSide.dispose();

    // Passive context usage reads cached state without extra RPC
    const ctxUsage = await adapter.getContextUsage(sessionId, { passive: true });
    expect(ctxUsage).toEqual({ pressureTokens: 1200, contextWindow: 200000 });

    // History state, non-destructive fork, and rewind
    const hist = await adapter.getHistoryState(sessionId);
    expect(hist.fork).toEqual({ whole: true, anchored: true });
    expect(hist.rewind).toBe(true);
    const anchor = onHistoryAnchor.mock.calls[0]![0].nativeAnchor;
    const forked = await adapter.forkHistory(sessionId, { anchor, expectedHead: hist.head });
    expect(forked.outcome).toBe("applied");
    expect(forkedAt).toBe("a_2");
    // Source worker was restored to original session file!
    expect(activeSessionFile).toBe(path.join(dir, "sess-main.jsonl"));

    const rewound = await adapter.rewindHistory(sessionId, { anchor, expectedHead: hist.head });
    expect(rewound.outcome).toBe("applied");
    publishUserEvent = false;
    const unmappedHistory = vi.fn();
    await bridge.handleAuthorizedMessage({
      ...mainScope, text: "An unattributed input", files: [],
      historyInputMessageId: "app-unmapped", onHistoryAnchor: unmappedHistory,
    });
    expect(unmappedHistory).not.toHaveBeenCalled();

    // Native goal lifecycle
    const createdGoal = await adapter.setThreadGoal(sessionId, { objective: "Ship omp parity", tokenBudget: 50000 });
    expect(createdGoal.goal?.objective).toBe("Ship omp parity");
    expect(createdGoal.goal?.status).toBe("active");
    const pausedGoal = await adapter.updateThreadGoal(sessionId, { status: "paused" });
    expect(pausedGoal.goal?.status).toBe("paused");
    const cleared = await adapter.clearThreadGoal(sessionId);
    expect(cleared.cleared).toBe(true);

    await adapter.destroy();
  });

  it("Bug #1: enforces approvalMode normal (fail-closed without bridge, real gating via bridge) vs bypass", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-approval-"));
    dirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ engine: "omp", approvalMode: "normal" }));

    // 1. Fail-closed when normal mode has no bridge connected
    let promptSent = false;
    const noBridgeAdapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      configPath,
      bridgeExtensionPath: null,
      spawnFn: () => {
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "s-nobridge" } }); return; }
          if (cmd.type === "prompt") { promptSent = true; }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });
    await expect(noBridgeAdapter.sendUserMessage("conv-nb", { text: "run bash", files: [] })).rejects.toThrow(/approval bridge/i);
    expect(promptSent).toBe(false);
    await noBridgeAdapter.destroy();

    // 2. Real Unix socket bridge roundtrip: read auto-allowed, bash denied/allowed/session-granted, bypass skips gate
    const approvals: string[] = [];
    const decisions: Array<{ behavior: "allow" | "deny"; scope?: "once" | "session" }> = [
      { behavior: "deny" },
      { behavior: "allow", scope: "once" },
      { behavior: "allow", scope: "session" },
    ];
    let extHandler: ((ev: { toolName: string; input?: unknown }) => Promise<{ block?: boolean; reason?: string } | undefined>) | undefined;
    let closeBridgeExt: (() => void) | undefined;
    let bridgeEnv: Record<string, string> = {};

    const gatedAdapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      configPath,
      bridgeExtensionPath: "/synthetic/omp-bridge-extension.js",
      openBridgeFn: async (opts) => {
        const ep = await openOmpBridgeEndpoint(opts);
        bridgeEnv = ep.env;
        // Simulate omp loading our extension inside the child process over the real socket
        const prevEp = process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT;
        const prevTok = process.env.TAROBIRD_OMP_BRIDGE_TOKEN;
        process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT = ep.env.TAROBIRD_OMP_BRIDGE_ENDPOINT;
        process.env.TAROBIRD_OMP_BRIDGE_TOKEN = ep.env.TAROBIRD_OMP_BRIDGE_TOKEN;
        activateExtension({
          on: (event: string, handler: (...args: any[]) => unknown) => {
            if (event === "tool_call") extHandler = handler as typeof extHandler;
            if (event === "session_shutdown") closeBridgeExt = handler as () => void;
          },
          getAllTools: () => [
            { name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
            { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } },
          ],
        });
        if (prevEp === undefined) delete process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT; else process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT = prevEp;
        if (prevTok === undefined) delete process.env.TAROBIRD_OMP_BRIDGE_TOKEN; else process.env.TAROBIRD_OMP_BRIDGE_TOKEN = prevTok;
        return ep;
      },
      spawnFn: (_cmd, args) => {
        expect(args).toContain("--extension");
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "s-gated" } }); return; }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            void (async () => {
              const readRes = await extHandler!({ toolName: "read", input: { path: "a.txt" } });
              const denyRes = await extHandler!({ toolName: "bash", input: { command: "rm -rf /tmp/x" } });
              const onceRes = await extHandler!({ toolName: "bash", input: { command: "echo 1" } });
              const sessRes1 = await extHandler!({ toolName: "bash", input: { command: "echo 2" } });
              const sessRes2 = await extHandler!({ toolName: "bash", input: { command: "echo 3" } });
              const summary = JSON.stringify({
                readBlocked: !!readRes?.block,
                denyBlocked: !!denyRes?.block,
                onceBlocked: !!onceRes?.block,
                sess1Blocked: !!sessRes1?.block,
                sess2Blocked: !!sessRes2?.block,
              });
              p.send({ type: "message_end", messageId: "m-g", message: { role: "assistant", content: [{ type: "text", text: summary }], stopReason: "stop" } });
              p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
            })();
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });

    const gatedRes = await gatedAdapter.sendUserMessage("conv-gated", {
      text: "run tools",
      files: [],
      onApprovalRequest: async (req) => {
        approvals.push(req.toolName);
        return decisions.shift() ?? { behavior: "deny" };
      },
    });
    expect(bridgeEnv.TAROBIRD_OMP_BRIDGE_TOKEN).toBeTruthy();
    expect(JSON.parse(gatedRes.text)).toEqual({
      readBlocked: false,
      denyBlocked: true,
      onceBlocked: false,
      sess1Blocked: false,
      sess2Blocked: false,
    });
    // Prompted 3 times (deny, once, session), NOT for read, NOT for 4th bash after session grant!
    expect(approvals).toEqual(["bash", "bash", "bash"]);
    closeBridgeExt?.();
    await gatedAdapter.destroy();
  });

  it("Bugs #3 & #11: anchored after-turn fork preserves assistant reply, relocates file, and survives restart + native session discovery", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-fork-persist-"));
    dirs.push(dir);
    const nativeHome = path.join(dir, "native-home");
    const nativeSessions = path.join(nativeHome, ".omp", "agent", "sessions", "proj");
    await mkdir(nativeSessions, { recursive: true });
    await writeFile(
      path.join(nativeSessions, "2026-01-01_native-1.jsonl"),
      `${JSON.stringify({ type: "session", id: "native-1", cwd: dir })}\n${JSON.stringify({ type: "session_info", name: "Native Omp Chat" })}\n`,
    );

    const srcDir = path.join(dir, "omp", "sessions", "conv-src");
    await mkdir(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, "main.jsonl");
    const rawForkFile = path.join(srcDir, "fork-created-in-src.jsonl");
    await writeFile(srcFile, `${JSON.stringify({ type: "session", id: "src-1", cwd: dir })}\n`);

    let forkCalledWithEntryId: string | undefined;
    const openedPaths: string[] = [];
    const entries = [
      { id: "u_1", parentId: null, type: "message", message: { role: "user", content: "First" } },
      { id: "a_1", parentId: "u_1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Reply 1" }] } },
      { id: "u_2", parentId: "a_1", type: "message", message: { role: "user", content: "Second" } },
      { id: "a_2", parentId: "u_2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Reply 2" }] } },
    ];

    const makeAdapter = () => new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: { HOME: nativeHome },
      spawnFn: () => {
        let activeFile = srcFile;
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "open_session") {
            openedPaths.push(String(cmd.sessionPath ?? cmd.sessionDir ?? ""));
            if (typeof cmd.sessionPath === "string") activeFile = cmd.sessionPath;
            p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: true, sessionId: "s", sessionFile: activeFile } });
            return;
          }
          if (cmd.type === "switch_session") {
            activeFile = cmd.sessionPath as string;
            openedPaths.push(activeFile);
            p.send({ id, type: "response", command: "switch_session", success: true, data: { cancelled: false } });
            return;
          }
          if (cmd.type === "get_state") {
            p.send({ id, type: "response", command: "get_state", success: true, data: { ...defaultState(), sessionFile: activeFile } });
            return;
          }
          if (cmd.type === "get_entries") {
            p.send({ id, type: "response", command: "get_entries", success: true, data: { entries, leafId: "a_2" } });
            return;
          }
          if (cmd.type === "get_session_stats") {
            p.send({ id, type: "response", command: "get_session_stats", success: true, data: { contextUsage: { tokens: 2400, contextWindow: 200000, percent: 1.2 } } });
            return;
          }
          if (cmd.type === "fork") {
            forkCalledWithEntryId = cmd.entryId as string | undefined;
            void writeFile(rawForkFile, `${JSON.stringify({ type: "session", id: "fork-1", cwd: dir })}\n`).then(() => {
              activeFile = rawForkFile;
              p.send({ id, type: "response", command: "fork", success: true, data: { cancelled: false } });
            });
            return;
          }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "message_end", messageId: "m1", message: { role: "assistant", content: [{ type: "text", text: "Reply 2" }], stopReason: "stop" } });
            p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
            p.send({ type: "session_settled" });
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });

    const adapter1 = makeAdapter();
    await adapter1.sendUserMessage("conv-src", { text: "Second", files: [] });
    const forkRes = await adapter1.forkHistory("conv-src", {
      anchor: { sessionId: "conv-src", inputId: "u_1", rewind: true, fork: true, forkBoundary: "after-turn" },
    });
    expect(forkRes.outcome).toBe("applied");
    // Anchored after-turn fork passed assistant leaf a_1 (NOT u_1)!
    expect(forkCalledWithEntryId).toBe("a_1");
    await adapter1.destroy();

    // Fresh adapter instance after "restart": passive context stays non-spawning (null),
    // active context & getHistoryState reattach using persisted session paths!
    const adapter2 = makeAdapter();
    expect(await adapter2.getContextUsage("conv-src", { passive: true })).toBeNull();
    const forkSessionId = forkRes.outcome === "applied" ? forkRes.sessionId : "";
    const restoredHist = await adapter2.getHistoryState(forkSessionId);
    expect(restoredHist.head).toBe("a_2");
    expect(openedPaths.some(p => p.includes(forkSessionId) && !p.includes("conv-src"))).toBe(true);
    const activeCtx = await adapter2.getContextUsage("conv-src");
    expect(activeCtx).toEqual({ pressureTokens: 2400, contextWindow: 200000 });

    // listExternalSessions discovers native ~/.omp/agent/sessions too
    const extSessions = await adapter2.listExternalSessions();
    expect(extSessions.some(s => s.sessionId === "native-1" && s.title === "Native Omp Chat")).toBe(true);
    await adapter2.destroy();
  });

  it("Bugs #5, #6, #7, #8, #10, #12, #13, #15, #16, #18: steering receipts, goal schema, forms/cancel, slash cmds, config sync, busy/compaction/images", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-hardening-"));
    dirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ engine: "omp", model: "anthropic/claude-sonnet-4-6", approvalMode: "bypass" }));
    const pngPath = path.join(dir, "img.png");
    await writeFile(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));

    // Bug #8: HTML form parser for omp built-in `ask` tool
    const parsedForm = parseOmpFormRequest({
      type: "extension_ui_request",
      id: "form-1",
      method: "form",
      title: "Deploy config",
      html: `<form><label>Target</label><input type="radio" name="env" value="staging">Staging<input type="radio" name="env" value="prod">Prod<label>Notes</label><textarea name="notes"></textarea></form>`,
    });
    expect(parsedForm).toHaveLength(2);
    expect(parsedForm[0]).toMatchObject({ name: "env", kind: "radio" });
    expect(parsedForm[0]!.options.map(o => o.value)).toEqual(["staging", "prod"]);

    let promptMessages: Array<{ message: string; images?: unknown[] }> = [];
    let compactCalls = 0;
    let setModelCalls: Array<{ provider: string; modelId: string }> = [];
    let setThinkingCalls: string[] = [];
    let setHostToolsCalls: number[] = [];
    let uiResponses: Array<Record<string, unknown>> = [];
    let mockQueuedCount = 0;
    let mockThinkingLevel = "medium";
    let goalStateResponse: Record<string, unknown> = {
      state: { enabled: true, mode: "active", goal: { objective: "Finish", status: "budget-limited", tokenBudget: 5000, tokensUsed: 5000, timeUsedSeconds: 10 } },
    };

    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      configPath,
      spawnFn: () => {
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_available_commands") {
            p.send({ id, type: "response", command: "get_available_commands", success: true, data: { commands: [{ name: "review", source: "skill", description: "Code review" }] } });
            return;
          }
          if (cmd.type === "open_session") {
            p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "s-hard" } });
            return;
          }
          if (cmd.type === "get_state") {
            p.send({
              id,
              type: "response",
              command: "get_state",
              success: true,
              data: { ...defaultState(), thinkingLevel: mockThinkingLevel, queuedMessageCount: mockQueuedCount },
            });
            return;
          }
          if (cmd.type === "get_entries") {
            p.send({ id, type: "response", command: "get_entries", success: true, data: { entries: [{ id: "u1", parentId: null, type: "message", message: { role: "user", content: "hi" } }], leafId: "u1" } });
            return;
          }
          if (cmd.type === "set_model") {
            setModelCalls.push({ provider: String(cmd.provider), modelId: String(cmd.modelId) });
            p.send({ id, type: "response", command: "set_model", success: true, data: { ...defaultState().model, provider: cmd.provider, id: cmd.modelId } });
            return;
          }
          if (cmd.type === "set_thinking_level") {
            mockThinkingLevel = String(cmd.level);
            setThinkingCalls.push(mockThinkingLevel);
            p.send({ id, type: "response", command: "set_thinking_level", success: true });
            return;
          }
          if (cmd.type === "set_host_tools") {
            setHostToolsCalls.push(Array.isArray(cmd.tools) ? cmd.tools.length : 0);
            p.send({ id, type: "response", command: "set_host_tools", success: true, data: { toolNames: [] } });
            return;
          }
          if (cmd.type === "compact") {
            compactCalls++;
            p.send({ type: "manual_compaction_start" });
            p.send({ type: "manual_compaction_end", aborted: false });
            p.send({ id, type: "response", command: "compact", success: true, data: { summary: "Compacted summary" } });
            return;
          }
          if (cmd.type === "extension_ui_response") {
            uiResponses.push(cmd);
            return;
          }
          if (cmd.type === "steer") {
            p.send({ id, type: "response", command: "steer", success: true });
            p.send({ type: "message_start", message: { role: "user", content: cmd.message } });
            return;
          }
          if (cmd.type === "goal") {
            p.send({ id, type: "response", command: "goal", success: true, data: goalStateResponse });
            return;
          }
          if (cmd.type === "btw") {
            // Bug #13: emit btw_delta BEFORE the btw response arrives!
            p.send({ type: "btw_delta", recordId: "btw-early", delta: "Early " });
            p.send({ id, type: "response", command: "btw", success: true, data: { record: { id: "btw-early", question: cmd.question, answer: "", status: "running", leafId: null, createdAt: 1, updatedAt: 1 } } });
            p.send({ type: "btw_delta", recordId: "btw-early", delta: "chunk!" });
            p.send({ type: "btw_record", record: { id: "btw-early", question: cmd.question, answer: "", status: "complete", leafId: null, createdAt: 1, updatedAt: 2 } });
            return;
          }
          if (cmd.type === "prompt") {
            promptMessages.push({ message: String(cmd.message), images: cmd.images as unknown[] | undefined });
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "agent_start" });
            // Test Bug #16 command_output fallback + Bug #8 cancel & positional selections with comma
            if (String(cmd.message).includes("CMD_OUT_ONLY")) {
              p.send({ type: "command_output", text: "Native command output" });
              p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
              return;
            }
            if (String(cmd.message).includes("ASK_COMMA")) {
              p.send({
                type: "extension_ui_request",
                id: "ui_comma",
                method: "ask",
                questions: [{ id: "q1", question: "Choose", options: [{ label: "Alpha, Beta" }, { label: "Gamma" }] }],
              });
              p.send({ type: "extension_ui_request", id: "ui_cancel_me", method: "input", title: "Will cancel" });
              setTimeout(() => p.send({ type: "extension_ui_request", id: "cancel_1", method: "cancel", targetId: "ui_cancel_me" }), 10);
              setTimeout(() => {
                p.send({ type: "message_end", messageId: "m-c", message: { role: "assistant", content: [{ type: "text", text: "Done ask" }], stopReason: "stop" } });
                p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
                p.send({ type: "session_settled" });
              }, 35);
              return;
            }
            setTimeout(() => {
              p.send({ type: "message_end", messageId: "m-ok", message: { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" } });
              p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
            }, 25);
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });

    // Bug #13: pre-aborted signal rejects immediately without spawning
    const preAborted = new AbortController();
    preAborted.abort("cancel");
    await expect(adapter.sendUserMessage("conv-preabort", { text: "hi", files: [], abortSignal: preAborted.signal })).rejects.toThrow(/aborted/i);

    // Bug #5: idle steerActiveTurn with throwOnError throws EngineSteeringRejectedError("stale")
    await expect(adapter.steerActiveTurn("conv-hard", { text: "steer", throwOnError: true })).rejects.toThrow(EngineSteeringRejectedError);

    // Bug #10 + #16: /compact runs native RPC directly with matching compaction IDs
    const compactEvents: EngineStreamEvent[] = [];
    const compactRes = await adapter.sendUserMessage("conv-hard", {
      text: "/compact focus on APIs",
      authoredText: "/compact focus on APIs",
      files: [],
      onEngineEvent: (ev) => { compactEvents.push(ev); },
    });
    expect(compactCalls).toBe(1);
    expect(compactRes.text).toBe("Compacted summary");
    const compStart = compactEvents.find(e => e.type === "context_compaction" && e.status === "started");
    const compEnd = compactEvents.find(e => e.type === "context_compaction" && e.status === "completed");
    expect(compStart && compEnd && compStart.type === "context_compaction" && compEnd.type === "context_compaction" && compStart.id === compEnd.id).toBe(true);

    // Bug #10: advertised command sent bare; bare /etc/hosts prose escaped with leading newline
    await adapter.sendUserMessage("conv-hard", { text: "[private]\n/review pr", authoredText: "/review pr", files: [] });
    expect(promptMessages.at(-1)!.message).toBe("/review pr");
    await adapter.sendUserMessage("conv-hard", { text: "/etc/hosts is missing", authoredText: "/etc/hosts is missing", files: [] });
    expect(promptMessages.at(-1)!.message.startsWith("\n/etc/hosts")).toBe(true);

    // Bug #18: text-only model skips base64 images and appends notice
    await adapter.sendUserMessage("conv-hard", { text: "describe image", files: [pngPath] });
    expect(promptMessages.at(-1)!.images).toBeUndefined();
    expect(promptMessages.at(-1)!.message).toMatch(/img\.png/);

    // Bug #16: command_output fallback when textChunks empty
    const cmdOutRes = await adapter.sendUserMessage("conv-hard", { text: "CMD_OUT_ONLY", files: [] });
    expect(cmdOutRes.text).toBe("Native command output");

    // Bug #12: partial engineOverride preserves config.json model, and clearing effort restores initial thinkingLevel
    await adapter.sendUserMessage("conv-hard", { text: "override effort", files: [], engineOverride: { effort: "high" } });
    expect(setThinkingCalls).toContain("high");
    await adapter.sendUserMessage("conv-hard", { text: "clear override", files: [] });
    expect(setThinkingCalls.at(-1)).toBe("medium");

    // Bug #13: stale host tools cleared when omitted on subsequent turn
    await adapter.sendUserMessage("conv-hard", {
      text: "with tool",
      files: [],
      appPlatformTools: {
        definitions: [{ name: "t1", description: "d", inputSchema: { type: "object" } }],
        instructions: "",
        isRegistered: async () => true,
        register: async () => undefined,
        call: async () => ({ text: "ok" }),
      },
    });
    await adapter.sendUserMessage("conv-hard", { text: "without tool", files: [] });
    expect(setHostToolsCalls).toEqual([1, 0]);

    // Bug #5 + #13: delayed steer outcome applied + concurrent turn rejection
    const steerOutcomes: SteeringApplication[] = [];
    const activeTurn = adapter.sendUserMessage("conv-hard", { text: "work", files: [] });
    await new Promise(r => setTimeout(r, 5));
    await expect(adapter.sendUserMessage("conv-hard", { text: "concurrent", files: [] })).rejects.toThrow(/in-flight turn/);
    const accepted = await adapter.steerActiveTurn("conv-hard", { text: "add detail", onOutcome: o => steerOutcomes.push(o) });
    expect(accepted).toBe(true);
    await activeTurn;
    expect(steerOutcomes).toEqual([{ status: "applied", via: "fold" }]);

    // Bug #8: positional selections handle comma labels & cancel aborts pending input UI
    let cancelAborted = false;
    await adapter.sendUserMessage("conv-hard", {
      text: "ASK_COMMA",
      files: [],
      onApprovalRequest: async (req) => {
        if (req.toolInput && JSON.stringify(req.toolInput).includes("Will cancel")) {
          return await new Promise((resolve) => {
            req.abortSignal?.addEventListener("abort", () => {
              cancelAborted = true;
              resolve({ behavior: "deny" });
            });
          });
        }
        return {
          behavior: "allow",
          updatedInput: { answers: { Choose: "Alpha, Beta" }, selections: [{ options: [0] }] },
        };
      },
    });
    expect(cancelAborted).toBe(true);
    expect(uiResponses.some(r => r.id === "ui_comma" && JSON.stringify(r.answers).includes("Alpha, Beta"))).toBe(true);

    // Bug #13: early btw_delta buffered before btw response
    const btwDeltas: string[] = [];
    const btw = await adapter.askAside("conv-hard", "quick q", { onDelta: d => btwDeltas.push(d) });
    expect(btwDeltas.join("")).toBe("Early chunk!");
    expect(btw.answer).toBe("Early chunk!");

    // Bug #7: GoalModeState wrapper, budget-limited mapping, dropped -> null, enabled: false error
    const limitedGoal = await adapter.getThreadGoal("conv-hard");
    expect(limitedGoal.goal?.status).toBe("budgetLimited");
    goalStateResponse = { state: { enabled: true, mode: "dropped", goal: { objective: "X", status: "dropped", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } } };
    expect((await adapter.getThreadGoal("conv-hard")).goal).toBeNull();
    goalStateResponse = { state: { enabled: false, mode: "disabled", reason: "rpc not in continuationModes", goal: { objective: "Run", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } } };
    await expect(adapter.watchThreadGoal("conv-hard", { objective: "Run" })).rejects.toMatchObject({ code: "goal_continuation_disabled" });

    // Bug #15: get_state busy check honors queuedMessageCount > 0
    mockQueuedCount = 2;
    const busyHist = await adapter.getHistoryState("conv-hard");
    expect(busyHist.blocked).toBe("busy");
    expect(await adapter.forkHistory("conv-hard")).toMatchObject({ outcome: "rejected", reason: "busy" });
    mockQueuedCount = 0;

    await adapter.destroy();
  });

  it("Bug #13: fatal OmpFrameError rejects pending commands immediately instead of swallowing as expected exit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-frame-err-"));
    dirs.push(dir);
    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "s-frame" } }); return; }
          if (cmd.type === "prompt") {
            // Emit malformed rpc_chunk frame (unexpected start index 1) to trigger fatal OmpFrameError
            p.send({ type: "rpc_chunk", chunkId: "bad-chunk", index: 1, count: 2, byteLength: 10, data: "YWJj" });
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });
    await expect(adapter.sendUserMessage("conv-frame", { text: "boom", files: [] })).rejects.toThrow(OmpFrameError);
    await adapter.destroy();
  });

  it("Fable 5 #2: destroy() aborts and awaits in-flight startup (getState, ready, and openBridge) with zero process/socket leak", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-destroy-race-"));
    dirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ engine: "omp", approvalMode: "bypass" }));

    // Case A: destroy() while client.getState() is pending after ready
    let spawnedProc!: FakeOmpProcess;
    let promptCalled = false;
    let bridgeDisposed = false;
    let resolveGetStateSeen!: () => void;
    const getStateSeen = new Promise<void>(r => { resolveGetStateSeen = r; });

    const adapterA = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      configPath,
      bridgeExtensionPath: "/synthetic/omp-bridge-extension.js",
      openBridgeFn: async () => ({
        env: { TAROBIRD_OMP_BRIDGE_ENDPOINT: "/synthetic/s", TAROBIRD_OMP_BRIDGE_TOKEN: "tok" },
        connection: new Promise(() => {}),
        dispose: () => { bridgeDisposed = true; },
      }),
      spawnFn: () => {
        spawnedProc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol") {
            p.send({ id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
            return;
          }
          if (cmd.type === "get_state") {
            // Hold get_state open so destroy() races mid-startup!
            resolveGetStateSeen();
            return;
          }
          if (cmd.type === "prompt") {
            promptCalled = true;
          }
        });
        queueMicrotask(() => spawnedProc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return spawnedProc as never;
      },
    });

    const turnA = adapterA.sendUserMessage("conv-destroy-a", { text: "hello", files: [] });
    await getStateSeen;
    await adapterA.destroy();
    await expect(turnA).rejects.toThrow(/destroyed/i);
    expect(spawnedProc.killed).toBe(true);
    expect(bridgeDisposed).toBe(true);
    expect(promptCalled).toBe(false);
    expect(adapterA.hasPendingNativeWork()).toBe(false);
    await expect(adapterA.sendUserMessage("conv-destroy-a", { text: "after destroy", files: [] })).rejects.toThrow(/destroyed/i);

    // Case B: destroy() while OmpRpcClient.start is waiting for ready
    let procB!: FakeOmpProcess;
    let disposedB = false;
    let resolveSpawnedB!: () => void;
    const spawnedB = new Promise<void>(r => { resolveSpawnedB = r; });
    const adapterB = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      configPath,
      bridgeExtensionPath: "/synthetic/omp-bridge-extension.js",
      openBridgeFn: async () => ({
        env: { TAROBIRD_OMP_BRIDGE_ENDPOINT: "/synthetic/s2", TAROBIRD_OMP_BRIDGE_TOKEN: "tok2" },
        connection: new Promise(() => {}),
        dispose: () => { disposedB = true; },
      }),
      spawnFn: () => {
        procB = new FakeOmpProcess(() => {});
        resolveSpawnedB();
        return procB as never;
      },
    });
    const turnB = adapterB.sendUserMessage("conv-destroy-b", { text: "hello", files: [] });
    await spawnedB;
    await adapterB.destroy();
    await expect(turnB).rejects.toThrow(/destroyed/i);
    expect(procB.killed).toBe(true);
    expect(disposedB).toBe(true);

    // Case C: destroy() while openBridgeFn is still pending; late-resolving endpoint is disposed immediately
    let lateDisposed = false;
    let spawnCalledC = false;
    let resolveLateBridge!: (ep: { env: Record<string, string>; connection: Promise<never>; dispose: () => void }) => void;
    const adapterC = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      configPath,
      bridgeExtensionPath: "/synthetic/omp-bridge-extension.js",
      openBridgeFn: () => new Promise(resolve => { resolveLateBridge = resolve as never; }),
      spawnFn: () => {
        spawnCalledC = true;
        return new FakeOmpProcess(() => {}) as never;
      },
    });
    const turnC = adapterC.sendUserMessage("conv-destroy-c", { text: "hello", files: [] });
    await vi.waitFor(() => expect(resolveLateBridge).toBeDefined());
    await adapterC.destroy();
    await expect(turnC).rejects.toThrow(/destroyed/i);
    resolveLateBridge({
      env: {},
      connection: new Promise(() => {}),
      dispose: () => { lateDisposed = true; },
    });
    await vi.waitFor(() => expect(lateDisposed).toBe(true));
    expect(spawnCalledC).toBe(false);
  });

  it("Fable 5 #3: cleans up spawned process and bridge socket when getState() or resolvePersistedSessionFile() fails during startup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-startup-leak-"));
    dirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ engine: "omp", approvalMode: "bypass" }));

    // Case A: client.getState() rejects immediately after spawn
    let procA!: FakeOmpProcess;
    let disposedA = false;
    const adapterA = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      configPath,
      bridgeExtensionPath: "/synthetic/omp-bridge-extension.js",
      openBridgeFn: async () => ({
        env: { TAROBIRD_OMP_BRIDGE_ENDPOINT: "/synthetic/s-a", TAROBIRD_OMP_BRIDGE_TOKEN: "tok-a" },
        connection: new Promise(() => {}),
        dispose: () => { disposedA = true; },
      }),
      spawnFn: () => {
        procA = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol") {
            p.send({ id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
            return;
          }
          if (cmd.type === "get_state") {
            p.send({ id, type: "response", command: "get_state", success: false, error: "get_state exploded", code: "internal_error" });
          }
        });
        queueMicrotask(() => procA.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return procA as never;
      },
    });
    await expect(adapterA.sendUserMessage("conv-leak-a", { text: "hi", files: [] })).rejects.toThrow(/get_state exploded/i);
    expect(procA.killed).toBe(true);
    expect(disposedA).toBe(true);
    expect(adapterA.hasPendingNativeWork()).toBe(false);
    await adapterA.destroy();

    // Case B: store.resolvePersistedSessionFile() rejects right after spawn + getState
    let procB!: FakeOmpProcess;
    let disposedB = false;
    const resolveSpy = vi.spyOn(OmpSessionStore.prototype, "resolvePersistedSessionFile").mockRejectedValueOnce(new Error("corrupt omp state store"));
    try {
      const adapterB = new OmpRpcAdapter({
        launch: { command: "omp", args: [] },
        workspacePath: dir,
        stateDir: dir,
        childEnv: {},
        configPath,
        bridgeExtensionPath: "/synthetic/omp-bridge-extension.js",
        openBridgeFn: async () => ({
          env: { TAROBIRD_OMP_BRIDGE_ENDPOINT: "/synthetic/s-b", TAROBIRD_OMP_BRIDGE_TOKEN: "tok-b" },
          connection: new Promise(() => {}),
          dispose: () => { disposedB = true; },
        }),
        spawnFn: () => {
          procB = new FakeOmpProcess((cmd, p) => {
            const id = cmd.id as string | undefined;
            if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
              p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
              return;
            }
            if (cmd.type === "get_state") {
              p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() });
            }
          });
          queueMicrotask(() => procB.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
          return procB as never;
        },
      });
      await expect(adapterB.sendUserMessage("conv-leak-b", { text: "hi", files: [] })).rejects.toThrow(/corrupt omp state store/i);
      expect(procB.killed).toBe(true);
      expect(disposedB).toBe(true);
      expect(adapterB.hasPendingNativeWork()).toBe(false);
      await adapterB.destroy();
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("Fable 5 #5a: requires verified built-in tool provenance for auto-approval and scopes session grants by origin", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-origin-"));
    dirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ engine: "omp", approvalMode: "normal" }));

    let toolRegistry: Array<{ name: string; sourceInfo?: { path?: unknown; source?: unknown } }> = [
      { name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
      { name: "grep", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
      { name: "find", sourceInfo: { path: "builtin:find", source: "builtin" } },
      { name: "find", sourceInfo: { path: "builtin:find", source: "builtin" } }, // duplicate -> fail closed
      { name: "ls" }, // missing sourceInfo -> fail closed
      { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } },
    ];
    let throwOnGetAllTools = false;
    let extHandler: ((ev: { toolName: string; input?: unknown }) => Promise<{ block?: boolean; reason?: string } | undefined>) | undefined;
    const prompted: string[] = [];

    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      configPath,
      bridgeExtensionPath: "/synthetic/omp-bridge-extension.js",
      openBridgeFn: async (opts) => {
        const ep = await openOmpBridgeEndpoint(opts);
        const prevEp = process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT;
        const prevTok = process.env.TAROBIRD_OMP_BRIDGE_TOKEN;
        process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT = ep.env.TAROBIRD_OMP_BRIDGE_ENDPOINT;
        process.env.TAROBIRD_OMP_BRIDGE_TOKEN = ep.env.TAROBIRD_OMP_BRIDGE_TOKEN;
        await activateExtension({
          on: (event: string, handler: (...args: any[]) => unknown) => {
            if (event === "tool_call") extHandler = handler as typeof extHandler;
          },
          getAllTools: () => {
            if (throwOnGetAllTools) throw new Error("registry unavailable");
            return toolRegistry;
          },
        });
        if (prevEp === undefined) delete process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT; else process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT = prevEp;
        if (prevTok === undefined) delete process.env.TAROBIRD_OMP_BRIDGE_TOKEN; else process.env.TAROBIRD_OMP_BRIDGE_TOKEN = prevTok;
        return ep;
      },
      spawnFn: () => {
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "s-orig" } }); return; }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            void (async () => {
              // 1. Genuine built-in `read` -> auto-allowed (no prompt)
              const builtinRead = await extHandler!({ toolName: "read", input: { path: "a.txt" } });
              // 2. MCP tool named `grep` (path: builtin:mcp) -> NOT auto-allowed -> prompts & denied
              const mcpGrep = await extHandler!({ toolName: "grep", input: { pattern: "x" } });
              // 3. Duplicate `find` entry -> fail closed -> prompts & denied
              const dupFind = await extHandler!({ toolName: "find", input: {} });
              // 4. Missing sourceInfo on `ls` -> fail closed -> prompts & denied
              const noSourceLs = await extHandler!({ toolName: "ls", input: {} });
              // 5. Extension overrides `read` -> NOT auto-allowed -> prompts & denied
              toolRegistry = [
                { name: "read", sourceInfo: { path: "/srv/ext/override-read.ts", source: "extension" } },
                { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } },
              ];
              const overriddenRead = await extHandler!({ toolName: "read", input: { path: "secret.txt" } });
              // 6. getAllTools throws -> fail closed -> prompts & denied
              throwOnGetAllTools = true;
              const threwRead = await extHandler!({ toolName: "read", input: { path: "x.txt" } });
              throwOnGetAllTools = false;
              // 7. Grant session scope to built-in `bash`: second built-in `bash` passes unasked,
              //    but an extension-overridden `bash` (origin: "other") MUST prompt again!
              const builtinBash1 = await extHandler!({ toolName: "bash", input: { command: "echo 1" } });
              const builtinBash2 = await extHandler!({ toolName: "bash", input: { command: "echo 2" } });
              toolRegistry = [{ name: "bash", sourceInfo: { path: "/srv/ext/override-bash.ts", source: "extension" } }];
              const overriddenBash = await extHandler!({ toolName: "bash", input: { command: "echo 3" } });

              const summary = JSON.stringify({
                builtinReadBlocked: !!builtinRead?.block,
                mcpGrepBlocked: !!mcpGrep?.block,
                dupFindBlocked: !!dupFind?.block,
                noSourceLsBlocked: !!noSourceLs?.block,
                overriddenReadBlocked: !!overriddenRead?.block,
                threwReadBlocked: !!threwRead?.block,
                builtinBash1Blocked: !!builtinBash1?.block,
                builtinBash2Blocked: !!builtinBash2?.block,
                overriddenBashBlocked: !!overriddenBash?.block,
              });
              p.send({ type: "message_end", messageId: "m-o", message: { role: "assistant", content: [{ type: "text", text: summary }], stopReason: "stop" } });
              p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
            })();
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });

    const res = await adapter.sendUserMessage("conv-origin", {
      text: "check origins",
      files: [],
      onApprovalRequest: async (req) => {
        prompted.push(req.toolName);
        if (req.toolName === "bash" && prompted.filter(n => n === "bash").length === 1) {
          return { behavior: "allow", scope: "session" };
        }
        return { behavior: "deny" };
      },
    });
    expect(JSON.parse(res.text)).toEqual({
      builtinReadBlocked: false,
      mcpGrepBlocked: true,
      dupFindBlocked: true,
      noSourceLsBlocked: true,
      overriddenReadBlocked: true,
      threwReadBlocked: true,
      builtinBash1Blocked: false,
      builtinBash2Blocked: false,
      overriddenBashBlocked: true,
    });
    // Genuine built-in read and 2nd built-in bash never prompted; every non-builtin/override did!
    expect(prompted).toEqual(["grep", "find", "ls", "read", "read", "bash", "bash"]);
    await adapter.destroy();
  });

  it("Fable 5 #5b: forkHistory surfaces switch-back failure cleanly and evicts the worker instead of silently corrupting the source session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-fork-restore-"));
    dirs.push(dir);
    const srcDir = path.join(dir, "omp", "sessions", "conv-fork-fail");
    await mkdir(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, "main.jsonl");
    const forkFile = path.join(srcDir, "fork-1.jsonl");
    await writeFile(srcFile, `${JSON.stringify({ type: "session", id: "src", cwd: dir })}\n`);

    type SwitchMode = "reject" | "cancel" | "mismatch" | "ok";
    let switchMode: SwitchMode = "reject";
    let spawnCount = 0;
    const spawnedProcs: FakeOmpProcess[] = [];
    const switchedTargets: string[] = [];

    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        spawnCount++;
        let activeFile = srcFile;
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "open_session") {
            p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: true, sessionId: "src", sessionFile: activeFile } });
            return;
          }
          if (cmd.type === "switch_session") {
            const target = String(cmd.sessionPath);
            switchedTargets.push(target);
            if (switchMode === "reject") {
              p.send({ id, type: "response", command: "switch_session", success: false, error: "source session file locked", code: "io_error" });
              return;
            }
            if (switchMode === "cancel") {
              p.send({ id, type: "response", command: "switch_session", success: true, data: { cancelled: true } });
              return;
            }
            if (switchMode === "mismatch") {
              // Claims success without changing activeFile away from forkFile!
              p.send({ id, type: "response", command: "switch_session", success: true, data: { cancelled: false } });
              return;
            }
            activeFile = target;
            p.send({ id, type: "response", command: "switch_session", success: true, data: { cancelled: false } });
            return;
          }
          if (cmd.type === "get_state") {
            p.send({ id, type: "response", command: "get_state", success: true, data: { ...defaultState(), sessionFile: activeFile } });
            return;
          }
          if (cmd.type === "get_entries") {
            p.send({
              id,
              type: "response",
              command: "get_entries",
              success: true,
              data: { entries: [{ id: "u1", parentId: null, type: "message", message: { role: "user", content: "hi" } }], leafId: "u1" },
            });
            return;
          }
          if (cmd.type === "fork") {
            void writeFile(forkFile, `${JSON.stringify({ type: "session", id: "fork", cwd: dir })}\n`).then(() => {
              activeFile = forkFile;
              p.send({ id, type: "response", command: "fork", success: true, data: { cancelled: false } });
            });
            return;
          }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "message_end", messageId: "m1", message: { role: "assistant", content: [{ type: "text", text: `active:${path.basename(activeFile)}` }], stopReason: "stop" } });
            p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
            p.send({ type: "session_settled" });
          }
        });
        spawnedProcs.push(proc);
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });

    // Establish initial live worker on main.jsonl
    switchMode = "ok";
    const firstTurn = await adapter.sendUserMessage("conv-fork-fail", { text: "turn 1", files: [] });
    expect(firstTurn.text).toBe("active:main.jsonl");
    expect(spawnCount).toBe(1);

    // 1. switch_session rejects during fork restore -> outcome: "unknown" + worker evicted/closed
    switchMode = "reject";
    const fail1 = await adapter.forkHistory("conv-fork-fail");
    expect(fail1).toMatchObject({
      outcome: "unknown",
      detail: expect.stringMatching(/source session file locked/i),
      candidateSessionId: expect.stringMatching(/^omp_/),
    });
    expect(spawnedProcs[0]!.killed).toBe(true);

    // Next turn on source conversation spawns a fresh worker bound to main.jsonl (NOT fork-1.jsonl!)
    switchMode = "ok";
    const afterFail1 = await adapter.sendUserMessage("conv-fork-fail", { text: "turn 2", files: [] });
    expect(spawnCount).toBe(2);
    expect(afterFail1.text).toBe("active:main.jsonl");
    expect(switchedTargets.at(-1)).toBe(srcFile);

    // 2. switch_session returns { cancelled: true } -> outcome: "unknown" + worker evicted
    switchMode = "cancel";
    const fail2 = await adapter.forkHistory("conv-fork-fail");
    expect(fail2).toMatchObject({
      outcome: "unknown",
      detail: expect.stringMatching(/cancelled switching back/i),
    });
    expect(spawnedProcs[1]!.killed).toBe(true);

    // 3. switch_session succeeds but getState still reports fork file -> outcome: "unknown" + worker evicted
    switchMode = "ok";
    await adapter.sendUserMessage("conv-fork-fail", { text: "turn 3", files: [] });
    expect(spawnCount).toBe(3);
    switchMode = "mismatch";
    const fail3 = await adapter.forkHistory("conv-fork-fail");
    expect(fail3).toMatchObject({
      outcome: "unknown",
      detail: expect.stringMatching(/remained on the forked session/i),
    });
    expect(spawnedProcs[2]!.killed).toBe(true);

    await adapter.destroy();
  });
});
