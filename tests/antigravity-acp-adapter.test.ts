import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineApprovalRequest, EngineStreamEvent } from "../src/codex/adapter.js";
import {
  AntigravityAcpAdapter,
  type AgyAcpChildProcess,
  type SpawnAgyAcp,
} from "../src/codex/antigravity-acp-adapter.js";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met in time");
}

async function settleWithin<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("did not settle in time")), ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class FakeReadable extends EventEmitter {
  emitData(chunk: string): void { this.emit("data", chunk); }
  end(): void { this.emit("end"); }
}

class FakeWritable {
  ended = false;
  constructor(private readonly onWrite: (chunk: string) => void, private readonly onEnd: () => void) {}
  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.onWrite(chunk.toString());
    callback?.(null);
    return true;
  }
  end(callback?: () => void): void { this.ended = true; this.onEnd(); callback?.(); }
  destroy(): void {}
}

const MODEL_OPTIONS = [
  { value: "gemini-4-neon", name: "Gemini 4 Neon" },
  { value: "gemini-4-argon", name: "Gemini 4 Argon" },
  { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];
const LEVEL_OPTIONS = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
  { value: "xhigh", name: "Extra" },
];

class FakeAgyServer {
  readonly clientMessages: JsonRpcMessage[] = [];
  readonly clientResponses = new Map<number | string, JsonRpcMessage>();
  readonly prompts: JsonRpcMessage[] = [];
  readonly pendingPrompts = new Map<number | string, JsonRpcMessage>();
  answerClose = true;
  answerInitialize = true;
  autoCancel = true;
  currentModeId = "default";
  configOptions: Array<Record<string, unknown>> = [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-neon", options: MODEL_OPTIONS },
    { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: "high", options: LEVEL_OPTIONS },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  ];
  private inputBuffer = "";
  private nextServerRequestId = 1;

  constructor(private readonly stdout: FakeReadable, public sessionId: string, private readonly log: string[]) {}

  receive(chunk: string): void {
    this.inputBuffer += chunk;
    const lines = this.inputBuffer.split("\n");
    this.inputBuffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) this.handle(JSON.parse(line) as JsonRpcMessage);
  }

  requests(method: string): JsonRpcMessage[] {
    return this.clientMessages.filter((message) => message.method === method);
  }

  sendUpdate(update: Record<string, unknown>, sessionId = this.sessionId): void {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }

  text(text: string): void { this.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }); }

  requestPermission(
    toolCallId = "call_1",
    toolInput: Record<string, unknown> = { CommandLine: "touch x" },
    toolCallOverrides?: Record<string, unknown>,
  ): string {
    const id = String(this.nextServerRequestId++);
    this.send({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
      sessionId: this.sessionId,
      toolCall: {
        sessionUpdate: "tool_call",
        toolCallId,
        name: "run_command",
        status: "pending",
        kind: "execute",
        title: String(toolInput.CommandLine ?? toolCallId),
        rawInput: toolInput,
        ...toolCallOverrides,
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
    } });
    return id;
  }

  /** Answer one outstanding prompt; the newest by default. */
  respondPrompt(result: Record<string, unknown> = { stopReason: "end_turn" }, which: "newest" | "oldest" = "newest"): void {
    const entries = [...this.pendingPrompts.entries()];
    const entry = which === "newest" ? entries.at(-1) : entries[0];
    if (!entry) throw new Error("No pending prompt");
    this.pendingPrompts.delete(entry[0]);
    this.send({ jsonrpc: "2.0", id: entry[0], result });
  }

  failPrompt(error: { code: number; message: string }, which: "newest" | "oldest" = "newest"): void {
    const entries = [...this.pendingPrompts.entries()];
    const entry = which === "newest" ? entries.at(-1) : entries[0];
    if (!entry) throw new Error("No pending prompt");
    this.pendingPrompts.delete(entry[0]);
    this.send({ jsonrpc: "2.0", id: entry[0], error });
  }

  private sessionResult(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      modes: { currentModeId: this.currentModeId, availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
      configOptions: this.configOptions,
    };
  }

  private handle(message: JsonRpcMessage): void {
    this.clientMessages.push(message);
    if (!message.method) {
      if (message.id !== undefined) this.clientResponses.set(message.id, message);
      return;
    }
    if (message.method === "initialize") {
      if (!this.answerInitialize) return;
      this.respond(message, {
        protocolVersion: 1,
        agentInfo: { name: "Fake Antigravity ACP Server", version: "test" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
        },
        authMethods: [],
      });
      return;
    }
    if (message.method === "session/new") { this.respond(message, this.sessionResult()); return; }
    if (message.method === "session/resume") {
      this.sessionId = String(message.params?.sessionId);
      this.respond(message, { ...this.sessionResult(), sessionId: undefined });
      return;
    }
    if (message.method === "session/load") {
      this.text("replayed history must never be shown");
      this.respond(message, this.sessionResult());
      return;
    }
    if (message.method === "session/set_config_option") {
      const configId = String(message.params?.configId);
      const value = String(message.params?.value);
      this.configOptions = this.configOptions.map((option) => option.id === configId ? { ...option, currentValue: value } : option);
      // agy 1.5.14 drops thought_level for a model without thinking levels (gpt-oss-120b-medium).
      if (configId === "model") this.configOptions = value === "gpt-oss-120b-medium"
        ? this.configOptions.filter((option) => option.id !== "thought_level")
        : this.configOptions.some((option) => option.id === "thought_level") ? this.configOptions
          : [...this.configOptions, { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: "high", options: LEVEL_OPTIONS }];
      this.respond(message, { configOptions: this.configOptions });
      return;
    }
    if (message.method === "session/set_mode") {
      this.currentModeId = String(message.params?.modeId);
      this.respond(message, {});
      return;
    }
    if (message.method === "session/prompt") {
      this.prompts.push(message);
      this.pendingPrompts.set(message.id!, message);
      return;
    }
    if (message.method === "session/cancel") {
      this.log.push(`cancel:${String(message.params?.sessionId)}`);
      if (this.autoCancel && this.pendingPrompts.size) this.respondPrompt({ stopReason: "cancelled" });
      return;
    }
    if (message.method === "session/close") {
      this.log.push(`close:${String(message.params?.sessionId)}`);
      if (this.answerClose) this.respond(message, {});
      return;
    }
    if (message.id !== undefined) this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }

  private respond(request: JsonRpcMessage, result: unknown): void {
    this.send({ jsonrpc: "2.0", id: request.id, result });
  }

  private send(message: JsonRpcMessage): void {
    queueMicrotask(() => this.stdout.emitData(`${JSON.stringify(message)}\n`));
  }
}

class FakeAgyChild extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin: FakeWritable;
  readonly server: FakeAgyServer;
  constructor(readonly pid: number, sessionId: string, log: string[]) {
    super();
    this.server = new FakeAgyServer(this.stdout, sessionId, log);
    this.stdin = new FakeWritable((chunk) => this.server.receive(chunk), () => log.push(`stdin-end:${pid}`));
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.emit("close", code, signal);
  }
}

const SESSION_A = "3dc54fa6-0000-4000-8000-00000000000a";
const SESSION_B = "3dc54fa6-0000-4000-8000-00000000000b";

function createHarness(configure?: (server: FakeAgyServer, index: number) => void) {
  const log: string[] = [];
  const children: FakeAgyChild[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  const spawnFn: SpawnAgyAcp = (command, args, options) => {
    const index = children.length;
    const child = new FakeAgyChild(900 + index, index === 0 ? SESSION_A : SESSION_B, log);
    configure?.(child.server, index);
    children.push(child);
    spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
    return child as unknown as AgyAcpChildProcess;
  };
  const killProcessTreeFn = (pid: number | undefined) => {
    log.push(`kill:${pid}`);
    const child = children.find((candidate) => candidate.pid === pid);
    queueMicrotask(() => child?.exit(null, "SIGTERM"));
  };
  return { log, children, spawnCalls, spawnFn, killProcessTreeFn };
}

const tempRoots: string[] = [];
async function configFile(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-acp-test-"));
  tempRoots.push(root);
  const file = path.join(root, "config.json");
  await writeFile(file, JSON.stringify({ engine: "antigravity", ...config }));
  return file;
}

async function adapterFor(harness: ReturnType<typeof createHarness>, config: Record<string, unknown> = { approvalMode: "bypass" }, extra: Record<string, unknown> = {}) {
  return new AntigravityAcpAdapter("agy", {
    childEnv: { PATH: process.env.PATH },
    configPath: await configFile(config),
    workspacePath: "/tmp/agy-workspace",
    spawnFn: harness.spawnFn,
    killProcessTreeFn: harness.killProcessTreeFn,
    idleSweepIntervalMs: 0,
    closeTimeoutMs: 50,
    cancelGraceMs: 50,
    wakeQuietMs: 20,
    turnTimeoutMs: null,
    inactivityTimeoutMs: null,
    ...extra,
  });
}

const adapters: AntigravityAcpAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.destroy()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function track(adapter: AntigravityAcpAdapter): AntigravityAcpAdapter {
  adapters.push(adapter);
  return adapter;
}

function promptBlocks(server: FakeAgyServer, index = 0): Array<Record<string, unknown>> {
  return server.prompts[index]!.params!.prompt as Array<Record<string, unknown>>;
}

describe("AntigravityAcpAdapter core", () => {
  it("starts agy acp with the approval flags and workspace, then streams one turn", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "full-auto" }));
    const events: EngineStreamEvent[] = [];
    const progress: string[] = [];
    const reply = adapter.sendUserMessage("tarobot-1", { text: "hello", files: [], onEngineEvent: (event) => { events.push(event); }, onProgress: (text) => progress.push(text) });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    expect(harness.spawnCalls[0]).toMatchObject({ command: "agy", cwd: "/tmp/agy-workspace" });
    expect(harness.spawnCalls[0]!.args).toEqual(["acp", "--dangerously-skip-permissions", "--sandbox", "--add-dir", "/tmp/agy-workspace"]);
    expect(harness.spawnCalls[0]!.env?.AGY_CLI_HIDE_ACCOUNT_INFO).toBe("1");
    expect(server.requests("session/new")[0]!.params).toMatchObject({ cwd: "/tmp/agy-workspace", mcpServers: [] });
    expect(server.requests("session/load")).toHaveLength(0);
    expect(JSON.stringify(promptBlocks(server))).toContain("<user_message>\\nhello\\n</user_message>");

    server.sendUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_7", name: "run_command", kind: "execute", title: "ls", status: "in_progress", rawInput: { CommandLine: "ls" } });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_7", status: "completed", rawOutput: { output: "a.txt\n", exit_code: 0 } });
    server.text("Hel");
    server.text("lo!");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 1200, size: 1_048_576 });
    await waitFor(() => events.some((event) => event.type === "assistant_text" && event.text === "lo!"));
    server.respondPrompt({ stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 30, thoughtTokens: 5, totalTokens: 155 } });

    await expect(settleWithin(reply)).resolves.toEqual({ text: "Hello!", sessionId: SESSION_A, usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 } });
    expect(events).toEqual(expect.arrayContaining([
      { type: "session", sessionId: SESSION_A },
      { type: "thinking", text: "thinking", sessionId: SESSION_A },
      { type: "tool_use", toolName: "run_command", toolInput: { CommandLine: "ls" }, toolUseId: "call_7", sessionId: SESSION_A },
      { type: "tool_result", toolName: "run_command", toolUseId: "call_7", output: "a.txt\n", exitCode: 0, isError: false, sessionId: SESSION_A },
      { type: "assistant_text", text: "Hel", delta: true, sessionId: SESSION_A },
    ]));
    expect(progress.at(-1)).toBe("Hello!");
    await expect(adapter.getContextUsage(SESSION_A)).resolves.toEqual({ pressureTokens: 1200, contextWindow: 1_048_576 });
  });

  it("uses bypass flags only for bypass and no permission flags for normal approval", async () => {
    const bypass = createHarness();
    const bypassAdapter = track(await adapterFor(bypass, { approvalMode: "bypass" }));
    void bypassAdapter.sendUserMessage("tarobot-1", { text: "x", files: [] }).catch(() => undefined);
    await waitFor(() => bypass.spawnCalls.length === 1);
    expect(bypass.spawnCalls[0]!.args).toEqual(["acp", "--dangerously-skip-permissions", "--add-dir", "/tmp/agy-workspace"]);

    const normal = createHarness();
    const normalAdapter = track(await adapterFor(normal, { approvalMode: "normal" }));
    void normalAdapter.sendUserMessage("tarobot-1", { text: "x", files: [], onApprovalRequest: async () => ({ behavior: "deny" }) }).catch(() => undefined);
    await waitFor(() => normal.spawnCalls.length === 1);
    expect(normal.spawnCalls[0]!.args).toEqual(["acp", "--add-dir", "/tmp/agy-workspace"]);
    await expect(normalAdapter.sendUserMessage("tarobot-2", { text: "x", files: [] })).rejects.toThrow(/approval handler/);
  });

  it("resumes a saved conversation with session/resume and never replays it with session/load", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const events: EngineStreamEvent[] = [];
    const reply = adapter.sendUserMessage(SESSION_A, { text: "again", files: [], onEngineEvent: (event) => { events.push(event); } });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    expect(server.requests("session/resume")[0]!.params).toMatchObject({ sessionId: SESSION_A, cwd: "/tmp/agy-workspace" });
    expect(server.requests("session/load")).toHaveLength(0);
    expect(server.requests("session/new")).toHaveLength(0);
    server.text("resumed");
    server.respondPrompt();
    await expect(settleWithin(reply)).resolves.toMatchObject({ text: "resumed", sessionId: SESSION_A });
  });

  it("maps a concrete model preset onto the model and thought_level options and resets a non-default mode", async () => {
    const harness = createHarness((server) => { server.currentModeId = "plan"; });
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass", model: "gemini-4-argon-medium" }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    expect(server.requests("session/set_config_option").map((message) => message.params)).toEqual([
      { sessionId: SESSION_A, configId: "model", value: "gemini-4-argon" },
      { sessionId: SESSION_A, configId: "thought_level", value: "medium" },
    ]);
    expect(server.requests("session/set_mode")[0]!.params).toEqual({ sessionId: SESSION_A, modeId: "default" });
    server.text("ok");
    server.respondPrompt();
    await settleWithin(reply);

    // An exact option id is used as-is; an explicit effort is applied separately.
    const exact = createHarness();
    const exactAdapter = track(await adapterFor(exact, { approvalMode: "bypass", model: "gemini-4-neon", effort: "low" }));
    void exactAdapter.sendUserMessage("tarobot-1", { text: "x", files: [] }).catch(() => undefined);
    await waitFor(() => exact.children[0]?.server.prompts.length === 1);
    expect(exact.children[0]!.server.requests("session/set_config_option").map((message) => message.params)).toEqual([
      { sessionId: SESSION_A, configId: "thought_level", value: "low" },
    ]);
    expect(exact.children[0]!.server.requests("session/set_mode")).toHaveLength(0);
  });

  it("applies a model that has no thinking levels and skips the saved effort", async () => {
    // The App saves the preset's own effort with gpt-oss-120b-medium; agy then offers no thought_level.
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass", model: "gpt-oss-120b-medium", effort: "medium" }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    expect(server.requests("session/set_config_option").map((message) => message.params)).toEqual([
      { sessionId: SESSION_A, configId: "model", value: "gpt-oss-120b-medium" },
    ]);
    server.text("OK");
    server.respondPrompt();
    await expect(settleWithin(reply)).resolves.toMatchObject({ text: "OK" });
  });

  it("refuses an effort the CLI does not offer before sending the prompt", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass", model: "gemini-4-argon", effort: "max" }));
    await expect(adapter.sendUserMessage("tarobot-1", { text: "x", files: [] })).rejects.toThrow(
      'Invalid model selection: gemini-4-argon has no "max" effort (available: low, medium, high, xhigh)',
    );
    expect(harness.children[0]!.server.prompts).toHaveLength(0);
  });

  it("bridges session/request_permission to the turn's approval handler with allow_once and reject_once only", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "normal" }));
    const requests: EngineApprovalRequest[] = [];
    const decisions: Array<"allow" | "deny"> = ["allow", "deny"];
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [], onApprovalRequest: async (request) => {
      requests.push(request);
      const behavior = decisions.shift()!;
      return behavior === "allow" ? { behavior, scope: "once" } : { behavior };
    } });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const first = server.requestPermission("call_1", { CommandLine: "touch a" });
    await waitFor(() => server.clientResponses.has(first));
    const second = server.requestPermission("call_2", { CommandLine: "touch b" });
    await waitFor(() => server.clientResponses.has(second));
    expect(server.clientResponses.get(first)!.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(server.clientResponses.get(second)!.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(requests[0]).toMatchObject({ engine: "antigravity", toolName: "run_command", toolInput: { CommandLine: "touch a" }, sessionId: SESSION_A, approvalScopes: { once: "once" } });
    server.text("done");
    server.respondPrompt();
    await settleWithin(reply);
  });

  for (const locale of [undefined, "zh"] as const) it(`ends a turn normally when the user declined an action and agy stopped without text · ${locale ?? "default"}`, async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "normal" }));
    const events: EngineStreamEvent[] = [];
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [], ...(locale ? { locale } : {}), onEngineEvent: (event) => { events.push(event); }, onApprovalRequest: async () => ({ behavior: "deny" }) });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const permission = server.requestPermission();
    await waitFor(() => server.clientResponses.has(permission));
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "failed", rawOutput: { output: "" } });
    server.respondPrompt({ stopReason: "end_turn" });
    const text = locale === "zh" ? "已拒绝执行该操作，Antigravity 已停止本轮。" : "The action was declined, so Antigravity stopped this turn.";
    await expect(settleWithin(reply)).resolves.toEqual({ text, sessionId: SESSION_A });
    expect(events.filter((event) => event.type === "result")).toEqual([{ type: "result", text, sessionId: SESSION_A }]);
  });

  it("adds the declined note after text the model wrote before the declined action", async () => {
    for (const after of ["", "I will not run it then."]) {
      const harness = createHarness();
      const adapter = track(await adapterFor(harness, { approvalMode: "normal" }));
      const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [], locale: "zh", onApprovalRequest: async () => ({ behavior: "deny" }) });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      const server = harness.children[0]!.server;
      server.text("好的，我现在执行命令。");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const permission = server.requestPermission();
      await waitFor(() => server.clientResponses.has(permission));
      server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "failed", rawOutput: { output: "" } });
      if (after) server.text(after);
      server.respondPrompt({ stopReason: "end_turn" });
      await expect(settleWithin(reply)).resolves.toMatchObject({ text: after
        // Text after the decline means the model already answered it: the reply is left as is.
        ? `好的，我现在执行命令。${after}`
        : "好的，我现在执行命令。\n\n已拒绝执行该操作，Antigravity 已停止本轮。" });
    }
  });

  it("keeps the empty-reply error when an action was allowed, not declined", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "normal" }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [], onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }) });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const permission = server.requestPermission();
    await waitFor(() => server.clientResponses.has(permission));
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", rawOutput: { output: "" } });
    server.respondPrompt({ stopReason: "end_turn" });
    await expect(settleWithin(reply)).rejects.toThrow("Antigravity completed without returning a response");
  });

  it("sends images and text files natively and binary files only as paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agy-acp-files-"));
    tempRoots.push(root);
    const image = path.join(root, "red.png");
    const notes = path.join(root, "notes.txt");
    const binary = path.join(root, "data.bin");
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    await writeFile(notes, "CODEWORD=VIOLET");
    await writeFile(binary, Buffer.from([0, 1, 2, 3, 0, 255]));
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "look", files: [image, notes, binary] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const blocks = promptBlocks(harness.children[0]!.server);
    expect(blocks).toContainEqual({ type: "image", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64"), uri: expect.stringContaining("red.png") });
    expect(blocks).toContainEqual({ type: "resource", resource: { uri: expect.stringContaining("notes.txt"), mimeType: "text/plain", text: "CODEWORD=VIOLET" } });
    expect(JSON.stringify(blocks)).not.toContain("blob");
    expect(JSON.stringify(blocks)).toContain(`Attachment: ${binary}`);
    harness.children[0]!.server.text("seen");
    harness.children[0]!.server.respondPrompt();
    await settleWithin(reply);
  });

  it("sends a native slash command as the first block, outside the user message wrapper", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    void adapter.sendUserMessage("tarobot-1", { text: "/compact now", files: [], instructions: "private rules" }).catch(() => undefined);
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const blocks = promptBlocks(harness.children[0]!.server);
    expect(blocks[0]).toEqual({ type: "text", text: "/compact now" });
    expect(JSON.stringify(blocks)).not.toContain("<user_message>");
    expect(JSON.stringify(blocks)).toContain("private rules");
  });

  it("ends a native /compact normally when agy compacts without any text", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "/compact", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.server.sendUpdate({ sessionUpdate: "usage_update", used: 900, size: 1_048_576 });
    harness.children[0]!.server.respondPrompt({ stopReason: "end_turn" });
    await expect(settleWithin(reply)).resolves.toEqual({ text: "", sessionId: SESSION_A });
    // Any other prompt that ends without text keeps the empty-reply error.
    const other = adapter.sendUserMessage(SESSION_A, { text: "/compact now", files: [] });
    await waitFor(() => harness.children[0]!.server.prompts.length === 2);
    harness.children[0]!.server.respondPrompt({ stopReason: "end_turn" });
    await expect(settleWithin(other)).rejects.toThrow("Antigravity completed without returning a response");
  });

  it("runs a native /compact in normal approval without an approval handler, declining anything it asks for", async () => {
    // The Host's compact command passes no approval handler.
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "normal" }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "/compact", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const requestId = server.requestPermission();
    await waitFor(() => server.clientResponses.has(requestId));
    expect(JSON.stringify(server.clientResponses.get(requestId))).not.toContain("allow");
    server.respondPrompt({ stopReason: "end_turn" });
    await settleWithin(reply).catch(() => undefined);
    // An ordinary message still needs the handler.
    await expect(adapter.sendUserMessage(SESSION_A, { text: "do it", files: [] })).rejects.toThrow("requires an approval handler");
  });

  it("stops with session/cancel and keeps the live session for the next turn", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const controller = new AbortController();
    const reply = adapter.sendUserMessage("tarobot-1", { text: "long", files: [], abortSignal: controller.signal });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    controller.abort();
    await expect(settleWithin(reply)).rejects.toThrow("Task was stopped by user");
    expect(harness.log).toEqual([`cancel:${SESSION_A}`]);
    const next = adapter.sendUserMessage(SESSION_A, { text: "next", files: [] });
    await waitFor(() => harness.children[0]!.server.prompts.length === 2);
    harness.children[0]!.server.text("fine");
    harness.children[0]!.server.respondPrompt();
    await expect(settleWithin(next)).resolves.toMatchObject({ text: "fine" });
    expect(harness.spawnCalls).toHaveLength(1);
  });

  it("closes the session before killing the process when a stop is not confirmed", async () => {
    const harness = createHarness((server) => { server.autoCancel = false; });
    const adapter = track(await adapterFor(harness));
    const controller = new AbortController();
    const reply = adapter.sendUserMessage("tarobot-1", { text: "long", files: [], abortSignal: controller.signal });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    controller.abort();
    await expect(settleWithin(reply)).rejects.toThrow("Task was stopped by user");
    expect(harness.log).toEqual([`cancel:${SESSION_A}`, `close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
  });

  it("reports a turn that ended without any answer as an error", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.server.respondPrompt({ stopReason: "end_turn" });
    await expect(settleWithin(reply)).rejects.toThrow("Antigravity completed without returning a response");
  });
});

describe("AntigravityAcpAdapter cleanup", () => {
  it("destroy closes every active session before ending stdin and killing the process tree", async () => {
    const harness = createHarness();
    const adapter = await adapterFor(harness);
    const first = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.server.text("a");
    harness.children[0]!.server.respondPrompt();
    await settleWithin(first);
    const second = adapter.sendUserMessage("tarobot-2", { text: "b", files: [] }).catch((error: Error) => error);
    await waitFor(() => harness.children[1]?.server.prompts.length === 1);

    await adapter.destroy();
    expect(harness.log.filter((entry) => entry.startsWith("close:")).sort()).toEqual([`close:${SESSION_A}`, `close:${SESSION_B}`]);
    for (const pid of [900, 901]) {
      const sessionId = pid === 900 ? SESSION_A : SESSION_B;
      expect(harness.log.indexOf(`close:${sessionId}`)).toBeLessThan(harness.log.indexOf(`kill:${pid}`));
      expect(harness.log.indexOf(`stdin-end:${pid}`)).toBeLessThan(harness.log.indexOf(`kill:${pid}`));
    }
    await expect(second).resolves.toBeInstanceOf(Error);
  });

  it("restartSession closes only that session's process, and the next turn resumes the same session in a new one", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    await expect(adapter.restartSession(SESSION_A)).resolves.toEqual({ outcome: "not_running" });
    const first = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.server.text("a");
    harness.children[0]!.server.respondPrompt();
    await settleWithin(first);
    const closing = adapter.restartSession(SESSION_A);
    await waitFor(() => harness.log.includes("kill:900"));
    expect(harness.log).toEqual([`close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
    await expect(closing).resolves.toEqual({ outcome: "closed" });
    expect(harness.children).toHaveLength(1);
    await expect(adapter.restartSession(SESSION_A)).resolves.toEqual({ outcome: "not_running" });
    const next = adapter.sendUserMessage(SESSION_A, { text: "b", files: [] });
    await waitFor(() => harness.children[1]?.server.prompts.length === 1);
    expect(harness.children[1]!.server.requests("session/resume")[0]!.params).toMatchObject({ sessionId: SESSION_A });
    harness.children[1]!.server.text("b");
    harness.children[1]!.server.respondPrompt();
    await settleWithin(next);
  });

  it("still kills the process after a short timeout when session/close never answers", async () => {
    const harness = createHarness((server) => { server.answerClose = false; });
    const adapter = await adapterFor(harness);
    const reply = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.server.text("a");
    harness.children[0]!.server.respondPrompt();
    await settleWithin(reply);
    await settleWithin(adapter.destroy());
    expect(harness.log).toEqual([`close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
  });

  it("recycles an idle session by closing it before the kill", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    try {
      const harness = createHarness();
      const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, { idleWorkerTtlMs: 1_000, idleSweepIntervalMs: 500 }));
      const reply = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      harness.children[0]!.server.text("a");
      harness.children[0]!.server.respondPrompt();
      await settleWithin(reply);
      vi.advanceTimersByTime(1_600);
      await waitFor(() => harness.log.includes("kill:900"));
      expect(harness.log).toEqual([`close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts for new launch flags only after closing the old session, then resumes it", async () => {
    const harness = createHarness();
    const configPath = await configFile({ approvalMode: "bypass" });
    const adapter = track(new AntigravityAcpAdapter("agy", {
      childEnv: {}, configPath, workspacePath: "/tmp/agy-workspace", spawnFn: harness.spawnFn, killProcessTreeFn: harness.killProcessTreeFn,
      idleSweepIntervalMs: 0, closeTimeoutMs: 50, cancelGraceMs: 50, wakeQuietMs: 20, turnTimeoutMs: null, inactivityTimeoutMs: null,
    }));
    const first = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.server.text("a");
    harness.children[0]!.server.respondPrompt();
    await settleWithin(first);

    await writeFile(configPath, JSON.stringify({ engine: "antigravity", approvalMode: "full-auto" }));
    const second = adapter.sendUserMessage(SESSION_A, { text: "b", files: [] });
    await waitFor(() => harness.children[1]?.server.prompts.length === 1);
    expect(harness.log.slice(0, 3)).toEqual([`close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
    expect(harness.spawnCalls[1]!.args).toContain("--sandbox");
    expect(harness.children[1]!.server.requests("session/resume")[0]!.params).toMatchObject({ sessionId: SESSION_A });
    harness.children[1]!.server.text("b");
    harness.children[1]!.server.respondPrompt();
    await settleWithin(second);
  });

  it("fails the turn without throwing from the output stream when agy acp cannot start", async () => {
    // A missing executable, a missing workspace or a binary that exits at once: the first write fails,
    // the protocol reader is cancelled, and Node then emits "end" on stdout from the event loop.
    const harness = createHarness();
    const stdout = new FakeReadable();
    const spawnFn: SpawnAgyAcp = () => {
      const child = new EventEmitter();
      const broken = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      const stdin = { write: (_chunk: string, callback?: (error?: Error | null) => void) => { queueMicrotask(() => callback?.(broken)); return false; }, end: () => undefined, destroy: () => undefined };
      return Object.assign(child, { pid: undefined, stdout, stderr: new FakeReadable(), stdin }) as unknown as AgyAcpChildProcess;
    };
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, { spawnFn }));
    await expect(settleWithin(adapter.sendUserMessage("tarobot-1", { text: "a", files: [] }))).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // In production this listener runs with no caller above it: a throw here ends the Bot process.
    expect(() => stdout.end()).not.toThrow();
    expect(() => stdout.emitData("late\n")).not.toThrow();
  });

  it("ends the worker when the protocol stream breaks, and starts a new process for the next message", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.stdout.emitData("this is not JSON\n");
    await expect(settleWithin(reply)).rejects.toThrow(/invalid JSON/);
    expect(harness.log).toContain("kill:900");
    expect(adapter.supportsSessionSteering(SESSION_A)).toBe(false);
    const next = adapter.sendUserMessage(SESSION_A, { text: "b", files: [] });
    await waitFor(() => harness.children[1]?.server.prompts.length === 1);
    harness.children[1]!.server.text("ok");
    harness.children[1]!.server.respondPrompt();
    await expect(settleWithin(next)).resolves.toMatchObject({ text: "ok" });
  });

  it("stops a message whose agy acp is still starting, and ends that process", async () => {
    const harness = createHarness((server) => { server.answerInitialize = false; });
    const adapter = track(await adapterFor(harness));
    const stop = new AbortController();
    const reply = adapter.sendUserMessage("tarobot-1", { text: "a", files: [], abortSignal: stop.signal });
    await waitFor(() => harness.children[0]?.server.requests("initialize").length === 1);
    stop.abort();
    await expect(settleWithin(reply)).rejects.toThrow("Task was stopped by user");
    await waitFor(() => harness.log.includes("kill:900"));
  });

  it("destroy does not wait for an agy acp that never finishes starting", async () => {
    const harness = createHarness((server) => { server.answerInitialize = false; });
    const adapter = await adapterFor(harness);
    const reply = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    reply.catch(() => undefined);
    await waitFor(() => harness.children[0]?.server.requests("initialize").length === 1);
    await settleWithin(adapter.destroy());
    await expect(settleWithin(reply)).rejects.toThrow();
    expect(harness.log).toContain("kill:900");
  });

  it("fails the turn when agy acp exits unexpectedly", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.stderr.emitData("fatal: boom\n");
    harness.children[0]!.exit(2);
    await expect(settleWithin(reply)).rejects.toThrow(/exited with code 2/);
  });
});

describe("AntigravityAcpAdapter steering", () => {
  async function runningTurn(config: Record<string, unknown> = { approvalMode: "bypass" }, extra: Record<string, unknown> = {}) {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, config, extra));
    const events: EngineStreamEvent[] = [];
    let settled = false;
    const reply = adapter.sendUserMessage("tarobot-1", {
      text: "write the report", files: [], onEngineEvent: (event) => { events.push(event); },
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    void reply.then(() => { settled = true; }, () => { settled = true; });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    return { harness, adapter, events, reply, server: harness.children[0]!.server, isSettled: () => settled };
  }

  it("offers steering for a live session and refuses it without a running turn", async () => {
    const { adapter, server, reply } = await runningTurn();
    expect(adapter.inFlightSendBehavior).toBe("steer");
    expect(adapter.supportsSessionSteering(SESSION_A)).toBe(true);
    expect(adapter.supportsSessionSteering("tarobot-9")).toBe(false);
    server.text("done");
    server.respondPrompt();
    await settleWithin(reply);
    await expect(adapter.steerActiveTurn(SESSION_A, { text: "late" })).resolves.toBe(false);
    await expect(adapter.steerActiveTurn(SESSION_A, { text: "late", throwOnError: true })).rejects.toMatchObject({ name: "EngineSteeringRejectedError", reason: "stale" });
    expect(server.prompts).toHaveLength(1);
  });

  it("sends a second session/prompt and keeps the turn open past the first prompt's early end_turn", async () => {
    const { adapter, server, reply, events, isSettled } = await runningTurn();
    server.text("Part one. ");
    await waitFor(() => events.some((event) => event.type === "assistant_text"));
    const steer = adapter.steerActiveTurn(SESSION_A, { text: "  also cover costs  ", throwOnError: true });
    await waitFor(() => server.prompts.length === 2);
    expect(server.prompts[1]!.params).toEqual({ sessionId: SESSION_A, prompt: [{ type: "text", text: "also cover costs" }] });
    // agy hands the run over: the earlier prompt returns end_turn at once.
    server.respondPrompt({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1, cachedReadTokens: 2 } }, "oldest");
    await expect(settleWithin(steer)).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isSettled()).toBe(false);
    server.text("Part two with costs.");
    server.respondPrompt({ stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 7, cachedReadTokens: 3 } });
    await expect(settleWithin(reply)).resolves.toEqual({ text: "Part one. Part two with costs.", sessionId: SESSION_A, usage: { inputTokens: 15, outputTokens: 8, cachedTokens: 5 } });
    expect(events.filter((event) => event.type === "result")).toEqual([{ type: "result", text: "Part one. Part two with costs.", sessionId: SESSION_A }]);
  });

  it("chains two steers; only the newest prompt settles the turn", async () => {
    const { adapter, server, reply, isSettled } = await runningTurn();
    const first = adapter.steerActiveTurn(SESSION_A, { text: "alpha" });
    await waitFor(() => server.prompts.length === 2);
    server.respondPrompt({ stopReason: "end_turn" }, "oldest");
    await expect(settleWithin(first)).resolves.toBe(true);
    const second = adapter.steerActiveTurn(SESSION_A, { text: "beta" });
    await waitFor(() => server.prompts.length === 3);
    server.respondPrompt({ stopReason: "end_turn" }, "oldest");
    await expect(settleWithin(second)).resolves.toBe(true);
    expect(isSettled()).toBe(false);
    server.text("alpha and beta");
    server.respondPrompt();
    await expect(settleWithin(reply)).resolves.toMatchObject({ text: "alpha and beta" });
  });

  it("refuses to steer while an approval is unanswered instead of queueing it", async () => {
    let answer!: (decision: { behavior: "allow"; scope: "once" }) => void;
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "normal" }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [], onApprovalRequest: () => new Promise((resolve) => { answer = resolve; }) });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const permission = server.requestPermission();
    await waitFor(() => Boolean(answer));
    await expect(adapter.steerActiveTurn(SESSION_A, { text: "hurry", throwOnError: true })).rejects.toMatchObject({ reason: "not_ready" });
    await expect(adapter.steerActiveTurn(SESSION_A, { text: "hurry" })).resolves.toBe(false);
    expect(server.prompts).toHaveLength(1);
    answer({ behavior: "allow", scope: "once" });
    await waitFor(() => server.clientResponses.has(permission));
    server.text("ok");
    server.respondPrompt();
    await expect(settleWithin(reply)).resolves.toMatchObject({ text: "ok" });
  });

  it("reports agy's -32603 refusal truthfully and lets the earlier prompt finish the turn", async () => {
    const { adapter, server, reply } = await runningTurn();
    const steer = adapter.steerActiveTurn(SESSION_A, { text: "extra", throwOnError: true });
    await waitFor(() => server.prompts.length === 2);
    server.failPrompt({ code: -32603, message: "Can't add this prompt to session: the running prompt is waiting for a permission or question answer" });
    await expect(settleWithin(steer)).rejects.toMatchObject({ name: "EngineSteeringRejectedError", reason: "not_ready" });
    server.text("original answer");
    server.respondPrompt();
    await expect(settleWithin(reply)).resolves.toMatchObject({ text: "original answer" });
  });

  it("fails the turn with the steer's error when agy took the steer and it then failed", async () => {
    const { adapter, server, reply } = await runningTurn();
    server.text("Part one.");
    const steer = adapter.steerActiveTurn(SESSION_A, { text: "extra", throwOnError: true });
    await waitFor(() => server.prompts.length === 2);
    server.respondPrompt({ stopReason: "end_turn" }, "oldest");   // handed over: the steer now owns the run
    await expect(settleWithin(steer)).resolves.toBe(true);
    server.failPrompt({ code: -32000, message: "quota exceeded" });
    await expect(settleWithin(reply)).rejects.toThrow(/quota exceeded/);
  });

  it("drops a steer that agy refuses after the admission wait ended, so the turn still completes", async () => {
    const { adapter, server, reply } = await runningTurn({ approvalMode: "bypass" }, { steerAdmissionTimeoutMs: 20 });
    await expect(adapter.steerActiveTurn(SESSION_A, { text: "extra", throwOnError: true })).rejects.toThrow("did not confirm");
    server.failPrompt({ code: -32603, message: "Can't add this prompt to session: the running prompt is waiting for a permission or question answer" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    server.text("original answer");
    server.respondPrompt();
    await expect(settleWithin(reply)).resolves.toMatchObject({ text: "original answer" });
  });

  it("stops a steered turn with session/cancel", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const controller = new AbortController();
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [], abortSignal: controller.signal });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const steer = adapter.steerActiveTurn(SESSION_A, { text: "more" });
    await waitFor(() => server.prompts.length === 2);
    server.respondPrompt({ stopReason: "end_turn" }, "oldest");
    await settleWithin(steer);
    controller.abort();
    await expect(settleWithin(reply)).rejects.toThrow("Task was stopped by user");
    expect(harness.log).toEqual([`cancel:${SESSION_A}`]);
  });
});

describe("AntigravityAcpAdapter idle wake-up", () => {
  async function finishedTurn(prepare: (server: FakeAgyServer) => void = () => undefined, extra: Record<string, unknown> = {}) {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, extra));
    const events: EngineStreamEvent[] = [];
    const reply = adapter.sendUserMessage("tarobot-1", { text: "start it", files: [], onEngineEvent: (event) => { events.push(event); } });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    prepare(server);
    server.text("STARTED");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 100, size: 1000 });
    server.respondPrompt();
    await settleWithin(reply);
    return { harness, adapter, events, server };
  }
  const backgroundCommand = (server: FakeAgyServer) => {
    server.sendUpdate({ sessionUpdate: "usage_update", used: 90, size: 1000 });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_bg", name: "run_command", kind: "execute", title: "sleep 10 && echo BG_OK", status: "in_progress", rawInput: { CommandLine: "sleep 10 && echo BG_OK", WaitMsBeforeAsync: 500 } });
  };
  const notifications = (events: EngineStreamEvent[]) => events.filter((event) => event.type === "task_notification");

  it("delivers output pushed to an idle session after a background command as a follow-up of the turn that started it", async () => {
    const { events, server } = await finishedTurn(backgroundCommand);
    const before = events.length;
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_bg", status: "completed", rawOutput: { output: "BG_OK\n", exit_code: 0 } });
    server.text("\n\nThe background command finished: ");
    server.text("BG_OK");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 140, size: 1000 });
    await waitFor(() => notifications(events).length === 1);
    expect(notifications(events)).toEqual([{ type: "task_notification", text: "The background command finished: BG_OK", sessionId: SESSION_A, status: "completed", origin: "bound" }]);
    // Wake-up output is a separate follow-up, never more text of the finished reply.
    expect(events.slice(before).filter((event) => event.type !== "task_notification")).toEqual([]);
  });

  it("waits while a tool the wake-up started is still running", async () => {
    const { events, server } = await finishedTurn();
    server.text("Checking the result");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 120, size: 1000 });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_w", name: "run_command", kind: "execute", title: "cat out.txt", status: "in_progress", rawInput: { CommandLine: "cat out.txt" } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(notifications(events)).toHaveLength(0);
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_w", status: "completed", rawOutput: { output: "ok" } });
    server.text(" - all good.");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 130, size: 1000 });
    await waitFor(() => notifications(events).length === 1);
    expect(notifications(events)[0]).toMatchObject({ text: "Checking the result - all good.", origin: "unattributed" });
  });

  it("marks a wake-up it cannot tie to a request, such as a finished subagent, as unattributed", async () => {
    const { events, server } = await finishedTurn((s) => {
      s.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_sub", name: "invoke_subagent", kind: "other", title: "Run invoke_subagent", status: "in_progress", rawInput: { TypeName: "research" } });
      s.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_sub", status: "completed" });
    });
    server.text("The research subagent reported back.");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 150, size: 1000 });
    await waitFor(() => notifications(events).length === 1);
    expect(notifications(events)[0]).toEqual({ type: "task_notification", text: "The research subagent reported back.", sessionId: SESSION_A, status: "completed", origin: "unattributed" });
  });

  it("hands what already arrived to the App before a new message takes the session over", async () => {
    const { adapter, events, server } = await finishedTurn(backgroundCommand);
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_bg", status: "completed", rawOutput: { output: "BG_OK" } });
    server.text("Partial wake-up text");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const nextEvents: EngineStreamEvent[] = [];
    const next = adapter.sendUserMessage(SESSION_A, { text: "new question", files: [], onEngineEvent: (event) => { nextEvents.push(event); } });
    await waitFor(() => server.prompts.length === 2);
    expect(notifications(events)).toEqual([expect.objectContaining({ text: "Partial wake-up text", origin: "bound" })]);
    server.text("Answer to the new question");
    server.respondPrompt();
    await expect(settleWithin(next)).resolves.toMatchObject({ text: "Answer to the new question" });
    expect(notifications(nextEvents)).toHaveLength(0);
  });

  it("delivers an open wake-up before destroy closes the session", async () => {
    const { adapter, events, server, harness } = await finishedTurn(undefined, { wakeQuietMs: 10_000 });
    server.text("Late report");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 160, size: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await adapter.destroy();
    expect(notifications(events)).toEqual([expect.objectContaining({ text: "Late report" })]);
    expect(harness.log).toEqual([`close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
  });

  it("delivers an open wake-up when the process exits by itself", async () => {
    const { events, server, harness } = await finishedTurn(undefined, { wakeQuietMs: 10_000 });
    server.text("Late report");
    await new Promise((resolve) => setTimeout(resolve, 5));
    harness.children[0]!.exit(1);
    await waitFor(() => notifications(events).length === 1);
    expect(notifications(events)).toEqual([expect.objectContaining({ text: "Late report" })]);
  });

  it("does not recycle an idle session whose background command is still running", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    try {
      const { harness } = await finishedTurn(backgroundCommand, { idleWorkerTtlMs: 1_000, idleSweepIntervalMs: 500 });
      vi.advanceTimersByTime(5_000);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(harness.log).toEqual([]);
      harness.children[0]!.server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_bg", status: "completed" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      vi.advanceTimersByTime(5_000);
      await waitFor(() => harness.log.includes("kill:900"));
      expect(harness.log).toEqual([`close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AntigravityAcpAdapter tasks and native commands", () => {
  it("lists background commands still running as shell tasks that cannot be stopped one by one", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    await expect(adapter.listTasks("tarobot-1")).resolves.toEqual({ supported: true, tasks: [] });
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_fg", name: "run_command", kind: "execute", title: "sleep 2", status: "in_progress", rawInput: { CommandLine: "sleep 2" } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A command the model is still waiting for is part of the reply, not a background task.
    await expect(adapter.listTasks(SESSION_A)).resolves.toEqual({ supported: true, tasks: [] });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_fg", status: "completed" });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_bg", name: "run_command", kind: "execute", title: "npm run build", status: "in_progress", rawInput: { CommandLine: "npm run build", WaitMsBeforeAsync: 500 } });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_sub", name: "invoke_subagent", kind: "other", title: "Run invoke_subagent", status: "in_progress" });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_sub", status: "completed" });
    server.sendUpdate({ sessionUpdate: "usage_update", used: 10, size: 100 });
    server.text("started");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const running = await adapter.listTasks(SESSION_A);
    expect(running.tasks).toEqual([{
      id: expect.stringMatching(/^[A-Za-z0-9_-]+$/), label: "npm run build", kind: "shell", mode: "background", status: "running",
      canStop: false, startedAt: expect.any(Number), updatedAt: expect.any(Number), owner: "bound",
    }]);
    expect(running.tasks[0]!.id).not.toContain("call_bg");
    expect(adapter.stopTask).toBeUndefined();
    server.respondPrompt();
    await settleWithin(reply);
    expect((await adapter.listTasks(SESSION_A)).tasks.map((task) => task.label)).toEqual(["npm run build"]);
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_bg", status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(adapter.listTasks(SESSION_A)).resolves.toEqual({ supported: true, tasks: [] });
  });

  it("keeps the latest native command list from available_commands_update", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    expect(adapter.advertisedCommands()).toEqual([]);
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.sendUpdate({ sessionUpdate: "available_commands_update", availableCommands: [
      { name: "goal", description: "Run until the specified goal is completely finished." },
      { name: "grill-me", description: "Interview me to align on a plan." },
      { name: "bad name!", description: "ignored" },
      { name: "pr2-echo", description: "x".repeat(400) },
    ] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(adapter.advertisedCommands()).toEqual([
      { name: "goal", description: "Run until the specified goal is completely finished." },
      { name: "grill-me", description: "Interview me to align on a plan." },
      { name: "pr2-echo", description: "x".repeat(300) },
    ]);
    server.text("ok");
    server.respondPrompt();
    await settleWithin(reply);
  });
});

describe("AntigravityAcpAdapter launch flags under concurrent starts", () => {
  async function adapterWithConfig(harness: ReturnType<typeof createHarness>, approvalMode: string) {
    const configPath = await configFile({ approvalMode });
    const adapter = track(await adapterFor(harness, { approvalMode }, { configPath }));
    const setMode = (mode: string) => writeFile(configPath, JSON.stringify({ engine: "antigravity", approvalMode: mode }));
    return { adapter, setMode };
  }
  const deny = async () => ({ behavior: "deny" as const });

  it("never runs a normal-approval message on a process another message started with --dangerously-skip-permissions", async () => {
    const harness = createHarness((server, index) => {
      if (index === 0) server.answerClose = false;
      if (index === 1) server.answerInitialize = false;
    });
    const { adapter, setMode } = await adapterWithConfig(harness, "full-auto");
    const first = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.server.text("a");
    harness.children[0]!.server.respondPrompt();
    await settleWithin(first);

    // The owner switches to normal: this message closes the full-auto session (session/close is slow).
    await setMode("normal");
    const normal = adapter.sendUserMessage(SESSION_A, { text: "normal", files: [], onApprovalRequest: deny });
    normal.catch(() => undefined);
    await waitFor(() => harness.log.includes(`close:${SESSION_A}`));
    // Then to bypass before that close finished: another message starts a bypass process.
    await setMode("bypass");
    // A stop signal (never used) adds a step to that message's wait, so the normal one reaches the worker first.
    const bypass = adapter.sendUserMessage(SESSION_A, { text: "bypass", files: [], abortSignal: new AbortController().signal });
    bypass.catch(() => undefined);
    await waitFor(() => harness.spawnCalls.length === 2);
    expect(harness.spawnCalls[1]!.args).toContain("--dangerously-skip-permissions");
    // The bypass process is still starting when the slow close ends.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const starting = harness.children[1]!.server;
    starting.answerInitialize = true;
    const init = starting.requests("initialize")[0]!;
    (starting as unknown as { respond(request: unknown, result: unknown): void }).respond(init, {
      protocolVersion: 1, agentInfo: { name: "Fake", version: "test" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } }, authMethods: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(settleWithin(normal)).rejects.toThrow(/changed while agy acp was starting/);

    for (const [index, child] of harness.children.entries()) {
      const flags = harness.spawnCalls[index]!.args;
      for (const prompt of child.server.prompts) {
        if (JSON.stringify(prompt.params).includes("<user_message>\\nnormal\\n")) expect(flags).not.toContain("--dangerously-skip-permissions");
      }
    }
  });

  it("does not hand a still-starting bypass process to a message sent after the switch to normal", async () => {
    const harness = createHarness((server, index) => { if (index === 0) server.answerInitialize = false; });
    const { adapter, setMode } = await adapterWithConfig(harness, "bypass");
    const bypass = adapter.sendUserMessage(SESSION_A, { text: "bypass", files: [] });
    bypass.catch(() => undefined);
    await waitFor(() => harness.children[0]?.server.requests("initialize").length === 1);
    await setMode("normal");
    const normal = adapter.sendUserMessage(SESSION_A, { text: "normal", files: [], onApprovalRequest: deny });
    normal.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 120));
    // The starting bypass process is closed instead of shared.
    expect(harness.log).toContain("kill:900");
    for (const [index, child] of harness.children.entries()) {
      for (const prompt of child.server.prompts) {
        if (JSON.stringify(prompt.params).includes("<user_message>\\nnormal\\n")) expect(harness.spawnCalls[index]!.args).not.toContain("--dangerously-skip-permissions");
      }
    }
  });
});

describe("AntigravityAcpAdapter session config failures", () => {
  it("ends the new agy acp process when a new conversation's session config fails, so retries do not pile up processes", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass", model: "gemini-0-removed" }));
    await expect(adapter.sendUserMessage("tarobot-1", { text: "x", files: [] })).rejects.toThrow(/not available in this CLI/);
    await expect(adapter.sendUserMessage("tarobot-1", { text: "x", files: [] })).rejects.toThrow(/not available in this CLI/);
    expect(harness.spawnCalls).toHaveLength(2);
    // Nobody learned these native sessions, so nothing could reach either process again.
    await waitFor(() => harness.log.includes("kill:900") && harness.log.includes("kill:901"));
    expect(harness.log.indexOf(`close:${SESSION_A}`)).toBeLessThan(harness.log.indexOf("kill:900"));
  });

  it("keeps a resumed conversation's process when its config is refused before any write", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass", model: "gemini-0-removed" }));
    await expect(adapter.sendUserMessage(SESSION_A, { text: "x", files: [] })).rejects.toThrow(/not available in this CLI/);
    expect(harness.log).not.toContain("kill:900");
    expect(adapter.supportsSessionSteering(SESSION_A)).toBe(true);
  });

  it("ends the process when a config write times out, so a late write cannot change the next message's model", async () => {
    // agy takes the model write but answers (and applies it) only later.
    const late: Array<() => void> = [];
    const harness = createHarness((server, index) => {
      if (index !== 0) return;
      const target = server as unknown as { handle(message: JsonRpcMessage): void };
      const handle = target.handle.bind(server);
      target.handle = (message) => {
        if (message.method === "session/set_config_option" && message.params?.value === "gemini-4-argon") { late.push(() => handle(message)); return; }
        handle(message);
      };
    });
    const configPath = await configFile({ approvalMode: "bypass", model: "gemini-4-argon" });
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, { configPath, initializeTimeoutMs: 40 }));
    const first = adapter.sendUserMessage(SESSION_A, { text: "a", files: [] });
    await expect(settleWithin(first)).rejects.toThrow(/set_config_option timed out/);

    await writeFile(configPath, JSON.stringify({ engine: "antigravity", approvalMode: "bypass", model: "gemini-4-neon" }));
    const second = adapter.sendUserMessage(SESSION_A, { text: "b", files: [] });
    await waitFor(() => harness.children.some((child) => child.server.prompts.length === 1));
    // The late write lands now, while the next message runs.
    late[0]?.();
    const running = harness.children.find((child) => child.server.prompts.length === 1)!.server;
    const model = running.configOptions.find((option) => option.id === "model")?.currentValue;
    expect(model).toBe("gemini-4-neon");
    running.text("b");
    running.respondPrompt();
    await settleWithin(second);
  });

  it("surfaces brain/<sessionId>/task.md edits as TodoWrite plans without emitting raw task artifact tool noise", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }));
    const events: EngineStreamEvent[] = [];
    const reply = adapter.sendUserMessage(SESSION_A, {
      text: "Run a multi-step plan",
      files: [],
      onEngineEvent: (event) => { events.push(event); },
    });
    await waitFor(() => harness.children.length === 1 && harness.children[0]!.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const taskPath = `/srv/state/.gemini/antigravity-cli/brain/${SESSION_A}/task.md`;
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_task_1",
      kind: "edit",
      status: "completed",
      name: "write_file",
      title: `File .../brain/${SESSION_A}/task.md`,
      content: [{ type: "diff", path: taskPath, newText: "# Plan\n- [ ] Read files\n- [ ] Write summary\n" }],
      rawInput: { ArtifactMetadata: { UserFacing: true, RequestFeedback: false, Summary: "Plan" }, Path: taskPath },
    });
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_task_2",
      kind: "edit",
      status: "completed",
      name: "edit_file",
      title: `File .../brain/${SESSION_A}/task.md`,
      content: [{ type: "diff", path: taskPath, oldText: "- [ ] Read files\n- [ ] Write summary\n", newText: "- [x] Read files\n- [/] Write summary\n" }],
      rawInput: { ArtifactMetadata: { UserFacing: true, RequestFeedback: false, Summary: "Progress" }, Path: taskPath },
    });
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_normal_1",
      kind: "edit",
      status: "completed",
      name: "write_file",
      title: "File /srv/workspace/result.md",
      content: [{ type: "diff", path: "/srv/workspace/result.md", newText: "- [ ] Not an internal task artifact\n" }],
      rawInput: { Path: "/srv/workspace/result.md", Content: "- [ ] Not an internal task artifact\n" },
    });
    server.text("All done.");
    server.respondPrompt();
    await settleWithin(reply);

    const todoEvents = events.filter((event) => event.type === "tool_use" && event.toolName === "TodoWrite");
    expect(todoEvents).toHaveLength(2);
    expect(todoEvents[0]).toMatchObject({
      type: "tool_use",
      toolName: "TodoWrite",
      toolInput: { todos: [{ content: "Read files", status: "pending" }, { content: "Write summary", status: "pending" }] },
    });
    expect(todoEvents[1]).toMatchObject({
      type: "tool_use",
      toolName: "TodoWrite",
      toolInput: { todos: [{ content: "Read files", status: "completed" }, { content: "Write summary", status: "in_progress" }] },
    });
    // Internal task.md writes do not leak as raw write_file/edit_file events, while normal workspace writes still appear.
    const rawFileWrites = events.filter((event) => event.type === "tool_use" && (event.toolName === "write_file" || event.toolName === "edit_file"));
    expect(rawFileWrites).toHaveLength(1);
    expect(rawFileWrites[0]).toMatchObject({ toolUseId: "call_normal_1", toolName: "write_file" });
  });

  it("never suppresses run_command or workspace /brain/.../task.md edits, and settles task.md calls across permission, pathless, diff-only, failed, and repeated rawInput updates", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "normal" }));
    const record = createRunRecord();
    const events: EngineStreamEvent[] = [];
    const approvals: EngineApprovalRequest[] = [];
    const reply = adapter.sendUserMessage(SESSION_A, {
      text: "Verify all task.md edge cases",
      files: [],
      onApprovalRequest: async (request) => {
        approvals.push(request);
        return { behavior: "allow" };
      },
      onEngineEvent: (event) => {
        events.push(event);
        recordRunEvent(record, event);
      },
    });
    await waitFor(() => harness.children.length === 1 && harness.children[0]!.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const taskPath = `/srv/state/.gemini/antigravity-cli/brain/${SESSION_A}/task.md`;

    // 1. Arbitrary run_command referencing /workspace/brain/task.md must emit both tool_use and tool_result.
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_rm",
      kind: "execute",
      status: "in_progress",
      name: "run_command",
      title: "rm -f /workspace/brain/task.md",
      rawInput: { CommandLine: "rm -f /workspace/brain/task.md" },
    });
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_rm",
      status: "completed",
      rawOutput: { output: "", exit_code: 0 },
    });

    // 2. Normal workspace edit to /workspace/packages/brain/task.md (no ArtifactMetadata, different session) must NOT be suppressed.
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_ws_brain",
      kind: "edit",
      status: "completed",
      name: "write_file",
      title: "File /workspace/packages/brain/task.md",
      content: [{ type: "diff", path: "/workspace/packages/brain/task.md", newText: "- [ ] Workspace task\n" }],
      rawInput: { Path: "/workspace/packages/brain/task.md", Content: "- [ ] Workspace task\n" },
    });

    // 3. Normal approval mode: permission_request for task.md followed by completed tool_call_update must settle waiting entry & phase.
    const permReqId = server.requestPermission(
      "call_perm_task",
      { Path: taskPath, Content: "- [ ] Step 1\n", ArtifactMetadata: { UserFacing: true, RequestFeedback: false, Summary: "Plan" } },
      { name: "write_file", kind: "edit", title: `File .../brain/${SESSION_A}/task.md` },
    );
    await waitFor(() => server.clientResponses.has(permReqId));
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_perm_task",
      status: "completed",
      content: [{ type: "diff", path: taskPath, newText: "- [ ] Step 1\n" }],
    });
    await waitFor(() => record.entries.some((e) => e.callId === "call_perm_task" && e.status === "done"));
    expect(summarizeRun(record, "running").phase).toBe("working");
    expect(record.entries.find((e) => e.callId === "call_perm_task")?.status).toBe("done");

    // 4. Pathless initial tool_call (emits tool_use) followed by task.md tool_call_update must also emit matching tool_result.
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_pathless",
      kind: "edit",
      status: "in_progress",
      name: "edit_file",
      title: "edit_file",
    });
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_pathless",
      status: "completed",
      content: [{ type: "diff", path: taskPath, newText: "- [x] Step 1\n- [ ] Step 2\n" }],
    });
    await waitFor(() => record.entries.some((e) => e.callId === "call_pathless" && e.status === "done"));
    expect(summarizeRun(record, "running").current).toBeUndefined();

    // 5. Path-known tool_call (no markdown yet) followed by diff-only tool_call_update (omitting full path/rawInput/title/kind/name) must still extract & emit updated todos.
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_diff_only",
      kind: "edit",
      status: "in_progress",
      name: "edit_file",
      title: `File .../brain/${SESSION_A}/task.md`,
    });
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_diff_only",
      status: "completed",
      content: [{ type: "diff", path: "task.md", newText: "- [x] Step 1\n- [/] Step 2\n" }],
    });

    // 6. Failed task.md update must NOT overwrite lastTaskMarkdown or emit unapplied progress.
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_failed_task",
      kind: "edit",
      status: "failed",
      name: "write_file",
      content: [{ type: "diff", path: taskPath, newText: "- [x] Failed ghost step\n" }],
      rawInput: { Path: taskPath, Content: "- [x] Failed ghost step\n" },
    });

    // 7. Repeated rawInput { Target, Replacement } across tool_call + tool_call_update (where Replacement contains Target) applies only once.
    const repeatInput = {
      Path: taskPath,
      Target: "- [/] Step 2",
      Replacement: "- [/] Step 2\n  - [ ] Subtask A",
    };
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_repeat_edit",
      kind: "edit",
      status: "in_progress",
      name: "edit_file",
      title: "edit_file",
      rawInput: repeatInput,
    });
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_repeat_edit",
      status: "completed",
      rawInput: repeatInput,
    });

    server.text("Done.");
    server.respondPrompt();
    await settleWithin(reply);

    expect(approvals).toHaveLength(1);
    expect(events.some((e) => e.type === "tool_use" && e.toolUseId === "call_rm")).toBe(true);
    expect(events.some((e) => e.type === "tool_result" && e.toolUseId === "call_rm")).toBe(true);
    expect(events.some((e) => e.type === "tool_use" && e.toolUseId === "call_ws_brain")).toBe(true);
    expect(events.some((e) => e.type === "tool_result" && e.toolUseId === "call_ws_brain")).toBe(true);
    // Diff-only and repeated-edit calls never emitted raw tool_use, so they must remain suppressed.
    expect(events.some((e) => e.type === "tool_use" && e.toolUseId === "call_diff_only")).toBe(false);
    expect(events.some((e) => e.type === "tool_use" && e.toolUseId === "call_repeat_edit")).toBe(false);

    const todoEvents = events.filter((e): e is Extract<EngineStreamEvent, { type: "tool_use" }> => e.type === "tool_use" && e.toolName === "TodoWrite");
    expect(todoEvents.map((e) => e.toolInput)).toEqual([
      { todos: [{ content: "Step 1", status: "pending" }] },
      { todos: [{ content: "Step 1", status: "completed" }, { content: "Step 2", status: "pending" }] },
      { todos: [{ content: "Step 1", status: "completed" }, { content: "Step 2", status: "in_progress" }] },
      { todos: [{ content: "Step 1", status: "completed" }, { content: "Step 2", status: "in_progress" }, { content: "Subtask A", status: "pending" }] },
    ]);
  });
});

describe("AntigravityAcpAdapter inactivity watchdog", () => {
  it("still times out a stalled foreground turn or wedged foreground command", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, { inactivityTimeoutMs: 70 }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "hang", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_fg", name: "run_command", kind: "execute", title: "sleep 9999", status: "in_progress", rawInput: { CommandLine: "sleep 9999" } });
    await expect(settleWithin(reply, 1_500)).rejects.toThrow(/Antigravity ACP turn became inactive/);
    expect(harness.log).toContain("kill:900");
  });

  it("pauses inactivity timeout while a background workflow or subagent from this turn runs, and re-arms once it completes", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, { inactivityTimeoutMs: 80 }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "run workflow", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_wf", name: "run_workflow", kind: "other", title: "Audit PRs", status: "in_progress", rawInput: { Description: "Audit PRs" } });
    server.sendUpdate({ sessionUpdate: "usage_update", used: 100, size: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Still alive past 2.5x inactivityTimeoutMs, and visible in listTasks as a background subagent task.
    expect(harness.log).toEqual([]);
    const tasks = await adapter.listTasks(SESSION_A);
    expect(tasks.tasks).toEqual([expect.objectContaining({ label: "Audit PRs", kind: "subagent", mode: "background", status: "running", canStop: false, owner: "bound" })]);
    // Once the workflow finishes, if the model stalls afterwards the inactivity watchdog fires.
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_wf", status: "completed", rawOutput: { output: "done" } });
    await expect(settleWithin(reply, 1_500)).rejects.toThrow(/Antigravity ACP turn became inactive/);
    expect(harness.log).toContain("kill:900");
  });

  it("pauses inactivity timeout while an async background run_command from this turn runs, and finishes normally when it returns", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, { inactivityTimeoutMs: 80 }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "run bg", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_bg", name: "run_command", kind: "execute", title: "npm test", status: "in_progress", rawInput: { CommandLine: "npm test", WaitMsBeforeAsync: 500 } });
    server.sendUpdate({ sessionUpdate: "usage_update", used: 100, size: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.log).toEqual([]);
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_bg", status: "completed", rawOutput: { output: "ok", exit_code: 0 } });
    server.text("all tests passed");
    server.respondPrompt();
    await expect(settleWithin(reply)).resolves.toMatchObject({ text: "all tests passed", sessionId: SESSION_A });
  });

  it("pauses inactivity timeout while waiting for a user permission approval and re-arms after the decision", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "normal" }, { inactivityTimeoutMs: 80 }));
    let resolveApproval!: (decision: { behavior: "allow"; scope: "once" }) => void;
    const approvalSeen = new Promise<void>((resolve) => {
      const reply = adapter.sendUserMessage("tarobot-1", {
        text: "run cmd",
        files: [],
        onApprovalRequest: () => {
          resolve();
          return new Promise((done) => { resolveApproval = done; });
        },
      });
      // Attach reply via harness reference below
      (harness as unknown as { activeReply: Promise<unknown> }).activeReply = reply;
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const permId = server.requestPermission("call_perm", { CommandLine: "rm -f tmp.txt" });
    await approvalSeen;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.log).toEqual([]);
    resolveApproval({ behavior: "allow", scope: "once" });
    await waitFor(() => server.clientResponses.has(permId));
    // After approval resolves with no further progress, the inactivity watchdog re-arms and fires.
    const reply = (harness as unknown as { activeReply: Promise<unknown> }).activeReply;
    await expect(settleWithin(reply, 1_500)).rejects.toThrow(/Antigravity ACP turn became inactive/);
    expect(harness.log).toContain("kill:900");
  });

  it("still enforces the hard turnTimeoutMs ceiling while a background workflow runs", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, { inactivityTimeoutMs: 60, turnTimeoutMs: 180 }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "wf ceiling", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_wf", name: "run_workflow", kind: "other", title: "Long workflow", status: "in_progress" });
    await expect(settleWithin(reply, 1_500)).rejects.toThrow(/Antigravity ACP turn timed out/);
    expect(harness.log).toContain("kill:900");
  });

  it("does not let an earlier turn's background command suppress the inactivity timeout of a new turn", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, { inactivityTimeoutMs: 80 }));
    const first = adapter.sendUserMessage("tarobot-1", { text: "start daemon", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_daemon", name: "run_command", kind: "execute", title: "npm run dev", status: "in_progress", rawInput: { CommandLine: "npm run dev" } });
    server.sendUpdate({ sessionUpdate: "usage_update", used: 90, size: 1000 });
    server.text("started");
    server.respondPrompt();
    await settleWithin(first);

    // A new turn starts while call_daemon from turn 1 is still open; if turn 2 stalls, it still times out.
    const second = adapter.sendUserMessage(SESSION_A, { text: "stalled follow-up", files: [] });
    await waitFor(() => server.prompts.length === 2);
    await expect(settleWithin(second, 1_500)).rejects.toThrow(/Antigravity ACP turn became inactive/);
    expect(harness.log).toContain("kill:900");
  });

  it("pauses inactivity timeout during reactive wait after invoke_subagent completes on spawn, and re-arms if a subsequent foreground step stalls", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, { inactivityTimeoutMs: 80 }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "delegate to subagent", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    // agy completes invoke_subagent immediately when spawning and then holds session/prompt open waiting for the child.
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_sub", name: "invoke_subagent", kind: "other", title: "invoke_subagent", status: "in_progress", rawInput: { TypeName: "self", Role: "Fix PR" } });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_sub", status: "completed", rawOutput: { output: "{\"conversationId\":\"sub-1\"}" } });
    server.text("Subagent launched, waiting for result.");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 120, size: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.log).toEqual([]);

    // Subagent wakes the parent, which runs a foreground tool and then stalls before the next usage_update.
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_read", name: "read_file", kind: "read", title: "read_file", status: "in_progress" });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_read", status: "completed", rawOutput: { output: "ok" } });
    await expect(settleWithin(reply, 1_500)).rejects.toThrow(/Antigravity ACP turn became inactive/);
    expect(harness.log).toContain("kill:900");
  });

  it("does not pause inactivity timeout for read-only swarm status calls, only swarm add reactive waits", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, { inactivityTimeoutMs: 70 }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "check swarm", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_sw", name: "swarm", kind: "other", title: "swarm", status: "in_progress", rawInput: { action: "status" } });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_sw", status: "completed" });
    server.sendUpdate({ sessionUpdate: "usage_update", used: 100, size: 1000 });
    await expect(settleWithin(reply, 1_500)).rejects.toThrow(/Antigravity ACP turn became inactive/);
    expect(harness.log).toContain("kill:900");
  });

  it("preserves user-initiated /plan mode across follow-up clarifications until agy returns to default", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }));

    const first = adapter.sendUserMessage("tarobot-1", { text: "/plan refactor auth", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    expect(promptBlocks(server, 0)[0]).toEqual({ type: "text", text: "/plan refactor auth" });
    server.sendUpdate({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    server.text("Question 1: OAuth or JWT?");
    server.respondPrompt();
    await settleWithin(first);

    // Follow-up reply during active /plan must NOT reset mode back to default prematurely.
    const second = adapter.sendUserMessage(SESSION_A, { text: "Use JWT", files: [] });
    await waitFor(() => server.prompts.length === 2);
    expect(server.requests("session/set_mode")).toHaveLength(0);
    server.sendUpdate({ sessionUpdate: "current_mode_update", currentModeId: "default" });
    server.text("Plan approved and executed.");
    server.respondPrompt();
    await settleWithin(second);

    // Once agy returned to default, an unexpected non-default mode on a later turn is reset again.
    server.sendUpdate({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    const third = adapter.sendUserMessage(SESSION_A, { text: "ordinary follow-up", files: [] });
    await waitFor(() => server.prompts.length === 3);
    expect(server.requests("session/set_mode").map((m) => m.params)).toEqual([{ sessionId: SESSION_A, modeId: "default" }]);
    server.text("done");
    server.respondPrompt();
    await settleWithin(third);
  });
});
