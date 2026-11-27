import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineApprovalRequest, EngineStreamEvent } from "../src/codex/adapter.js";
import {
  AntigravityAcpAdapter,
  type AgyAcpChildProcess,
  type SpawnAgyAcp,
} from "../src/codex/antigravity-acp-adapter.js";
import { antigravityVersionSupportsSwarm, resolveAntigravityExecutable } from "../src/codex/antigravity-acp-support.js";
import {
  extractWorkerAttribution,
  mergeSwarmSnapshots,
  readSwarmBoardFiles,
  renderSwarmBoardSummary,
  swarmMembersToEngineTasks,
} from "../src/codex/antigravity-swarm.js";
import { renderCoreApprovalCard } from "../src/core/card-renderer.js";
import { abortCoreConversation, requestCoreApproval, stopCoreConversation } from "../src/core/card-actions.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { attachGateway } from "../src/gateway/service.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";

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

class FakeSwarmAgyServer {
  readonly clientMessages: JsonRpcMessage[] = [];
  readonly clientResponses = new Map<number | string, JsonRpcMessage>();
  readonly prompts: JsonRpcMessage[] = [];
  readonly pendingPrompts = new Map<number | string, JsonRpcMessage>();
  availableCommands: Array<{ name: string; description: string }> = [
    { name: "compact", description: "Compact conversation" },
    { name: "swarm", description: "Start a multi-agent swarm (Preview & Quota Heavy)" },
  ];
  /** Optional delay (ms) after session/new or session/resume to emit available_commands_update automatically. */
  autoAdvertiseDelayMs?: number;
  private inputBuffer = "";
  private nextRequestId = 1;

  constructor(private readonly stdout: FakeReadable, public sessionId: string, private readonly log: string[]) {}

  receive(chunk: string): void {
    this.inputBuffer += chunk;
    const lines = this.inputBuffer.split("\n");
    this.inputBuffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) this.handle(JSON.parse(line) as JsonRpcMessage);
  }

  sendUpdate(update: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: this.sessionId, update } });
  }

  text(text: string): void {
    this.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  advertiseCommands(): void {
    this.sendUpdate({ sessionUpdate: "available_commands_update", availableCommands: this.availableCommands });
  }

  requestPermission(opts: { toolCallId?: string; command?: string; workerName?: string; _meta?: Record<string, unknown> } = {}): string {
    const id = String(this.nextRequestId++);
    this.send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: this.sessionId,
        ...(opts._meta ? { _meta: opts._meta } : {}),
        toolCall: {
          sessionUpdate: "tool_call",
          toolCallId: opts.toolCallId ?? "call_perm_1",
          name: "run_command",
          status: "pending",
          kind: "execute",
          title: opts.command ?? "npm test",
          rawInput: { CommandLine: opts.command ?? "npm test", ...(opts.workerName ? { workerName: opts.workerName } : {}) },
          ...(opts.workerName ? { _meta: { workerName: opts.workerName } } : {}),
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    return id;
  }

  requestElicitation(opts: {
    workerName?: string;
    message?: string;
    requestedSchema?: Record<string, unknown>;
  } = {}): string {
    const id = String(this.nextRequestId++);
    this.send({
      jsonrpc: "2.0",
      id,
      method: "elicitation/create",
      params: {
        sessionId: this.sessionId,
        mode: "form",
        message: opts.message ?? "Pick a database engine for auth",
        requestedSchema: opts.requestedSchema ?? {
          type: "object",
          required: ["db"],
          properties: {
            db: {
              type: "string",
              title: "Database",
              oneOf: [
                { const: "sqlite", title: "SQLite" },
                { const: "postgres", title: "PostgreSQL" },
              ],
            },
          },
        },
        ...(opts.workerName ? { _meta: { workerName: opts.workerName } } : {}),
      },
    });
    return id;
  }

  respondPrompt(result: Record<string, unknown> = { stopReason: "end_turn" }): void {
    const entry = [...this.pendingPrompts.entries()].at(-1);
    if (!entry) throw new Error("No pending prompt");
    this.pendingPrompts.delete(entry[0]);
    this.send({ jsonrpc: "2.0", id: entry[0], result });
  }

  private handle(message: JsonRpcMessage): void {
    this.clientMessages.push(message);
    if (!message.method) {
      if (message.id !== undefined) this.clientResponses.set(message.id, message);
      return;
    }
    if (message.method === "initialize") {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "Fake Swarm AGY ACP", version: "1.5.17" },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
          },
          authMethods: [],
        },
      });
      return;
    }
    if (message.method === "session/new") {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: this.sessionId, modes: { currentModeId: "default", availableModes: [] }, configOptions: [] },
      });
      if (this.autoAdvertiseDelayMs !== undefined) {
        setTimeout(() => this.advertiseCommands(), this.autoAdvertiseDelayMs);
      }
      return;
    }
    if (message.method === "session/resume") {
      const requested = typeof message.params?.sessionId === "string" ? message.params.sessionId : this.sessionId;
      this.sessionId = requested;
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { modes: { currentModeId: "default", availableModes: [] }, configOptions: [] },
      });
      if (this.autoAdvertiseDelayMs !== undefined) {
        setTimeout(() => this.advertiseCommands(), this.autoAdvertiseDelayMs);
      }
      return;
    }
    if (message.method === "session/prompt") {
      this.prompts.push(message);
      this.pendingPrompts.set(message.id!, message);
      return;
    }
    if (message.method === "session/cancel") {
      this.log.push(`cancel:${String(message.params?.sessionId)}`);
      if (this.pendingPrompts.size) this.respondPrompt({ stopReason: "cancelled" });
      return;
    }
    if (message.method === "session/close") {
      this.log.push(`close:${String(message.params?.sessionId)}`);
      this.send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
  }

  private send(payload: Record<string, unknown>): void {
    this.stdout.emitData(`${JSON.stringify(payload)}\n`);
  }
}

function createSwarmHarness(configure?: (server: FakeSwarmAgyServer) => void) {
  const log: string[] = [];
  const children: Array<{ pid: number; server: FakeSwarmAgyServer }> = [];
  let nextPid = 5000;
  const spawnFn: SpawnAgyAcp = (() => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const child = new EventEmitter() as EventEmitter & AgyAcpChildProcess & { pid: number; killed: boolean; kill: () => boolean };
    child.pid = nextPid++;
    const server = new FakeSwarmAgyServer(stdout, "swarm-sess-1", log);
    configure?.(server);
    const stdin = new FakeWritable((chunk) => server.receive(chunk), () => { log.push(`stdin-end:${child.pid}`); });
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
    children.push({ pid: child.pid, server });
    return child;
  }) as SpawnAgyAcp;
  const killProcessTreeFn = (pid: number | undefined) => {
    log.push(`kill:${pid}`);
    const entry = children.find((c) => c.pid === pid);
    if (entry) {
      // Child close runs via microtask.
    }
  };
  return { log, children, spawnFn, killProcessTreeFn };
}

const tempRoots: string[] = [];
const adapters: AntigravityAcpAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.destroy()));
  await Promise.all(tempRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function setupEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-swarm-test-"));
  tempRoots.push(root);
  const configPath = path.join(root, "config.json");
  const brainDir = path.join(root, "brain");
  const workspacePath = path.join(root, "workspace");
  await mkdir(brainDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(configPath, JSON.stringify({ engine: "antigravity", approvalMode: "normal", antigravityRuntime: "acp" }));
  return { root, configPath, brainDir, workspacePath };
}

async function writeSwarmFiles(brainDir: string, sessionId: string, opts: { members?: unknown; boardLines?: string[] }) {
  const dir = path.join(brainDir, sessionId, ".system_generated", "swarm");
  await mkdir(dir, { recursive: true });
  if (opts.members !== undefined) {
    await writeFile(path.join(dir, "members.json"), typeof opts.members === "string" ? opts.members : JSON.stringify(opts.members));
  }
  if (opts.boardLines !== undefined) {
    await writeFile(path.join(dir, "board.jsonl"), opts.boardLines.join("\n"));
  }
}

describe("antigravity swarm parser & helpers", () => {
  it("checks antigravity CLI swarm support version threshold (>= 1.5.5)", () => {
    expect(antigravityVersionSupportsSwarm("antigravity 1.5.4")).toBe(false);
    expect(antigravityVersionSupportsSwarm("antigravity 1.5.5")).toBe(true);
    expect(antigravityVersionSupportsSwarm("antigravity 1.5.17")).toBe(true);
    expect(antigravityVersionSupportsSwarm("invalid output")).toBe(false);
  });

  it("parses members.json + board.jsonl, groups monitor/narrator helpers, and flags unknown formats", async () => {
    const { brainDir } = await setupEnv();
    await writeSwarmFiles(brainDir, "sess-board", {
      members: {
        title: "Refactor auth & tests",
        members: [
          { name: "auth-fix", role: "worker", state: "working", model: "gemini-4-neon", latestActivity: "Fixing token verification" },
          { name: "ui-check", role: "worker", state: "waiting", model: "gemini-4-argon" },
          { name: "monitor", role: "monitor", state: "working", model: "gemini-4-flash", latestActivity: "Watching test board" },
          { name: "narrator", role: "narrator", state: "waiting", latestActivity: "Summarizing progress" },
        ],
      },
      boardLines: [
        JSON.stringify({ id: "p1", author: "auth-fix", content: "Found bug in JWT check. @ui-check please verify login redirect.", createdAt: 1700000001000 }),
        JSON.stringify({ id: "p2", author: "ui-check", title: "Redirect check", content: "Verified login redirect flow.", createdAt: 1700000002000 }),
      ],
    });

    const parsed = await readSwarmBoardFiles(brainDir, "sess-board");
    expect(parsed.found).toBe(true);
    expect(parsed.active).toBe(true);
    expect(parsed.formatUnknown).toBe(false);
    expect(parsed.title).toBe("Refactor auth & tests");
    expect(parsed.members).toHaveLength(4);
    expect(parsed.members.find((m) => m.name === "ui-check")?.latestActivity).toContain("Redirect check");
    expect(parsed.posts[0]?.mentions).toEqual(["ui-check"]);

    const snapshot = mergeSwarmSnapshots(undefined, parsed, { sessionId: "sess-board" })!;
    const tasks = swarmMembersToEngineTasks("sess-board", snapshot);
    expect(tasks.find((t) => t.label === "auth-fix")).toMatchObject({ swarmState: "working", model: "gemini-4-neon" });
    expect(tasks.find((t) => t.label === "auth-fix")?.helper).toBeUndefined();
    expect(tasks.find((t) => t.label === "monitor")).toMatchObject({ helper: true, role: "monitor", swarmState: "working" });
    expect(tasks.find((t) => t.label === "narrator")).toMatchObject({ helper: true, role: "narrator", swarmState: "waiting" });

    expect(renderSwarmBoardSummary(snapshot, "en")).toContain("Refactor auth & tests");

    // Malformed / unknown format degrades safely.
    await writeSwarmFiles(brainDir, "sess-bad", {
      members: "{bad json",
      boardLines: ["not json line"],
    });
    const bad = await readSwarmBoardFiles(brainDir, "sess-bad");
    expect(bad.found).toBe(true);
    expect(bad.formatUnknown).toBe(true);
    expect(bad.members).toEqual([]);
  });

  it("extracts worker attribution from ACP metadata, rawInput, and prefixed titles", () => {
    expect(extractWorkerAttribution({ _meta: { workerName: "auth-fix" } })).toBe("auth-fix");
    expect(extractWorkerAttribution({ toolCall: { rawInput: { memberName: "@ui-check" } } })).toBe("ui-check");
    expect(extractWorkerAttribution({ toolCall: { title: "[reviewer] npm test" } })).toBe("reviewer");
    expect(extractWorkerAttribution({ _meta: { sender: "system" } })).toBeUndefined();
  });
});

describe("AntigravityAcpAdapter /swarm lifecycle", () => {
  it("rejects /swarm when agy version < 1.5.5 or ACP session omits /swarm without sending prompt", async () => {
    const env = await setupEnv();
    const oldHarness = createSwarmHarness();
    const oldAdapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: oldHarness.spawnFn,
      killProcessTreeFn: oldHarness.killProcessTreeFn,
      supportsSwarmFn: async () => false,
    });
    adapters.push(oldAdapter);

    const oldReply = await oldAdapter.sendUserMessage("tarobot-1", { text: "/swarm audit code", files: [], locale: "en", onApprovalRequest: async () => ({ behavior: "deny" }) });
    expect(oldReply.text).toContain("1.5.5");
    expect(oldHarness.children).toHaveLength(0);

    const unadvertisedHarness = createSwarmHarness((server) => {
      server.availableCommands = [{ name: "compact", description: "Compact" }];
    });
    const adapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: unadvertisedHarness.spawnFn,
      killProcessTreeFn: unadvertisedHarness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
    });
    adapters.push(adapter);

    const first = adapter.sendUserMessage("tarobot-1", { text: "hello", files: [], onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }) });
    await waitFor(() => unadvertisedHarness.children[0]?.server.prompts.length === 1);
    const server = unadvertisedHarness.children[0]!.server;
    server.advertiseCommands();
    server.text("hi");
    server.respondPrompt();
    await first;

    const blocked = await adapter.sendUserMessage("swarm-sess-1", { text: "/swarm parallel check", files: [], locale: "zh", onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }) });
    expect(blocked.text).toContain("未开放 `/swarm`");
    expect(server.prompts).toHaveLength(1);
  });

  it("pauses inactivity & idle reaper within hard cap while swarm works, attributes active-turn approvals/elicitation, rejects orphan post-turn approvals, and stops cleanly", async () => {
    const env = await setupEnv();
    const harness = createSwarmHarness();
    const adapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: harness.spawnFn,
      killProcessTreeFn: harness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
      idleWorkerTtlMs: 30,
      idleSweepIntervalMs: 10,
      inactivityTimeoutMs: 40,
      turnTimeoutMs: 2_000,
      swarmMaxDurationMs: 2_000,
      wakeQuietMs: 10,
      closeTimeoutMs: 50,
      cancelGraceMs: 50,
    });
    adapters.push(adapter);

    const events: EngineStreamEvent[] = [];
    const approvals: EngineApprovalRequest[] = [];
    const pendingQuestions: Array<{ req: EngineApprovalRequest; resolve: (d: { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny" }) => void }> = [];

    const turnReply = adapter.sendUserMessage("tarobot-1", {
      text: "/swarm parallel audit",
      files: [],
      locale: "en",
      onEngineEvent: (ev) => { events.push(ev); },
      onApprovalRequest: async (req) => {
        approvals.push(req);
        if (req.toolName === "AskUserQuestion") {
          return await new Promise((resolve) => { pendingQuestions.push({ req, resolve }); });
        }
        return { behavior: "allow", scope: "once" };
      },
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.advertiseCommands();
    await writeSwarmFiles(env.brainDir, "swarm-sess-1", {
      members: {
        title: "Parallel security audit",
        members: [
          { name: "auth-audit", role: "worker", state: "working", model: "gemini-4-neon", latestActivity: "Inspecting JWT middleware" },
          { name: "monitor", role: "monitor", state: "waiting", model: "gemini-4-flash" },
        ],
      },
      boardLines: [
        JSON.stringify({ id: "b1", author: "auth-audit", content: "Checking routes", createdAt: Date.now() }),
      ],
    });

    // Wait longer than inactivityTimeoutMs (40ms) while within hard total cap (2000ms) and swarm worker is actively working: turn stays open.
    await new Promise((r) => setTimeout(r, 100));
    server.text("Coordinator kicked off workers.");
    server.respondPrompt();
    await expect(turnReply).resolves.toMatchObject({ text: "Coordinator kicked off workers.", sessionId: "swarm-sess-1" });

    // Wait longer than idleWorkerTtlMs (30ms) + idleSweepIntervalMs (10ms) while within swarmMaxDurationMs: idle reaper MUST NOT close ACP session while workers actively work!
    await new Promise((r) => setTimeout(r, 80));
    expect(harness.log.some((entry) => entry.startsWith("close:"))).toBe(false);
    expect(adapter.hasPendingNativeWork()).toBe(true);

    // /swarm board stays local and returns a read-only summary without calling session/prompt.
    const boardReply = await adapter.sendUserMessage("swarm-sess-1", {
      text: "/swarm board",
      files: [],
      locale: "en",
      onApprovalRequest: async () => ({ behavior: "deny" }),
    });
    expect(boardReply.text).toContain("Parallel security audit");
    expect(boardReply.text).toContain("@auth-audit");
    expect(server.prompts).toHaveLength(1);

    // @worker message is sent unwrapped ahead of private context; active-turn worker approval & elicitation are bridged with workerName attribution.
    const directMention = adapter.sendUserMessage("swarm-sess-1", {
      text: "@auth-audit prioritize OAuth callback",
      files: [],
      instructions: "Platform rules",
      onApprovalRequest: async (req) => {
        approvals.push(req);
        if (req.toolName === "AskUserQuestion") {
          return await new Promise((resolve) => { pendingQuestions.push({ req, resolve }); });
        }
        return { behavior: "allow", scope: "once" };
      },
    });
    await waitFor(() => server.prompts.length === 2);
    const mentionBlocks = server.prompts[1]!.params!.prompt as Array<{ text: string }>;
    expect(mentionBlocks[0]!.text).toBe("@auth-audit prioritize OAuth callback");

    const permId = server.requestPermission({ workerName: "auth-audit", command: "npx vitest auth" });
    await waitFor(() => server.clientResponses.has(permId));
    expect(approvals.at(-1)?.workerName).toBe("auth-audit");
    expect(server.clientResponses.get(permId)?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });

    const elicitId = server.requestElicitation({ workerName: "auth-audit" });
    await waitFor(() => pendingQuestions.length === 1);
    expect(pendingQuestions[0]!.req.workerName).toBe("auth-audit");
    pendingQuestions[0]!.resolve({ behavior: "allow", updatedInput: { answers: { "Pick a database engine for auth": "PostgreSQL" } } });
    await waitFor(() => server.clientResponses.has(elicitId));
    expect(server.clientResponses.get(elicitId)?.result).toEqual({ action: "accept", content: { db: "postgres" } });

    server.text("Noted for @auth-audit.");
    server.respondPrompt();
    await directMention;

    // Orphan approval & elicitation requests arriving AFTER no turn owns the session MUST be rejected/declined cleanly (never borrow a previous turn's handler!).
    const approvalCountBeforeOrphan = approvals.length;
    const orphanPermId = server.requestPermission({ workerName: "auth-audit", command: "rm -rf /tmp/never" });
    await waitFor(() => server.clientResponses.has(orphanPermId));
    expect(server.clientResponses.get(orphanPermId)?.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(approvals).toHaveLength(approvalCountBeforeOrphan);

    const orphanElicitId = server.requestElicitation({ workerName: "auth-audit" });
    await waitFor(() => server.clientResponses.has(orphanElicitId));
    expect(server.clientResponses.get(orphanElicitId)?.result).toEqual({ action: "decline" });
    expect(approvals).toHaveLength(approvalCountBeforeOrphan);

    // Card renderer shows @worker attribution clearly.
    const card = renderCoreApprovalCard({ requestId: "r1", toolName: "run_command", workerName: "auth-audit", locale: "en" });
    expect(JSON.stringify(card)).toContain("@auth-audit");

    // listTasks merges members + board posts.
    const snap = await adapter.listTasks("swarm-sess-1");
    expect(snap.swarm?.active).toBe(true);
    expect(snap.tasks.find((t) => t.label === "auth-audit")?.swarmState).toBe("working");
    expect(snap.tasks.find((t) => t.label === "monitor")?.helper).toBe(true);

    // Post-coordinator wake-up output reaches conversation.
    server.text("Worker auth-audit finished checking JWT.");
    await waitFor(() => events.some((ev) => ev.type === "task_notification" && ev.origin === "bound" && ev.text.includes("finished checking JWT")));

    // Stop Swarm cancels via session/close and ends background work cleanly.
    const stopped = await adapter.stopBackgroundWork("swarm-sess-1", { locale: "en" });
    expect(stopped.stopped).toBe(true);
    expect(stopped.summary).toContain("Stopped the active swarm");
    expect(harness.log).toContain("close:swarm-sess-1");
    expect(adapter.hasPendingNativeWork()).toBe(false);
    const afterStop = await adapter.listTasks("swarm-sess-1");
    expect(afterStop.swarm?.active).toBe(false);
    expect(afterStop.swarm?.members.find((m) => m.name === "auth-audit")?.state).toBe("killed");
  });

  it("/restart stops an active swarm through the /stop path before it closes the process, and reports closed only after the exit", async () => {
    const env = await setupEnv();
    const harness = createSwarmHarness();
    const spawned: Array<EventEmitter> = [];
    const order: string[] = [];
    const adapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: ((...args: Parameters<SpawnAgyAcp>) => { const child = harness.spawnFn(...args); spawned.push(child as never); return child; }) as SpawnAgyAcp,
      killProcessTreeFn: (pid) => { order.push("kill"); harness.killProcessTreeFn(pid); },
      supportsSwarmFn: async () => true,
      idleSweepIntervalMs: 0,
      turnTimeoutMs: 2_000,
      swarmMaxDurationMs: 5_000,
      closeTimeoutMs: 50,
      cancelGraceMs: 50,
    });
    adapters.push(adapter);
    const turn = adapter.sendUserMessage("tarobot-1", { text: "/swarm parallel audit", files: [], locale: "en", onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }) });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.advertiseCommands();
    await writeSwarmFiles(env.brainDir, "swarm-sess-1", {
      members: { title: "Parallel security audit", members: [{ name: "auth-audit", role: "worker", state: "working" }] },
      boardLines: [],
    });
    server.text("Coordinator kicked off workers.");
    server.respondPrompt();
    await turn;
    expect((await adapter.listTasks("swarm-sess-1")).swarm?.active).toBe(true);

    const runtime = createCoreServiceRuntime();
    const bridge = { stopBackgroundWork: vi.fn(async (input: { locale?: "en" | "zh"; scope?: "swarm" | "all" }) => {
      const result = await adapter.stopBackgroundWork("swarm-sess-1", input);
      order.push(`swarm:${result.stopped}`);
      return result;
    }) };
    let settled = false;
    const closing = adapter.restartSession("swarm-sess-1", {
      beforeStop: () => abortCoreConversation(runtime, "lark:c1", bridge, "en").backgroundStop,
    }).finally(() => { settled = true; });
    await waitFor(() => order.length === 3);
    // The swarm stop ran first with the worker alive (it closes that worker itself);
    // the restart signals the same process only after the swarm stop finished.
    expect(order).toEqual(["kill", "swarm:true", "kill"]);
    expect(harness.log).toContain("close:swarm-sess-1");
    expect(bridge.stopBackgroundWork).toHaveBeenCalledWith(expect.objectContaining({ scope: "swarm", locale: "en" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    spawned[0]!.emit("close", null, "SIGKILL");
    await expect(closing).resolves.toEqual({ outcome: "closed" });
    // Same recorded state as after /stop.
    const afterRestart = await adapter.listTasks("swarm-sess-1");
    expect(afterRestart.swarm?.active).toBe(false);
    expect(afterRestart.swarm?.members.find((m) => m.name === "auth-audit")?.state).toBe("killed");
  });

  it("enforces hard total turn timeout and background swarm ceiling even while swarm workers stay working", async () => {
    const env = await setupEnv();

    // 1. Active turn with working swarm: inactivity timeout is paused, BUT hard total turnTimeoutMs ALWAYS fires.
    const turnHarness = createSwarmHarness();
    const turnAdapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: turnHarness.spawnFn,
      killProcessTreeFn: turnHarness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
      inactivityTimeoutMs: 35,
      turnTimeoutMs: 120,
      swarmMaxDurationMs: 500,
      idleSweepIntervalMs: 0,
      closeTimeoutMs: 50,
    });
    adapters.push(turnAdapter);

    const activeTurn = turnAdapter.sendUserMessage("tarobot-1", {
      text: "/swarm hard total cap test",
      files: [],
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => turnHarness.children[0]?.server.prompts.length === 1);
    turnHarness.children[0]!.server.advertiseCommands();
    await writeSwarmFiles(env.brainDir, "swarm-sess-1", {
      members: { title: "Long swarm", members: [{ name: "builder", role: "worker", state: "working" }] },
    });

    await expect(activeTurn).rejects.toThrow(/timed out/i);
    expect(turnHarness.log).toContain("close:swarm-sess-1");
    const afterTurnTimeout = await turnAdapter.listTasks("swarm-sess-1");
    expect(afterTurnTimeout.swarm?.active).toBe(false);
    expect(afterTurnTimeout.swarm?.statusText).toBe("Swarm timed out");

    // 2. Post-turn background swarm: hard swarmMaxDurationMs ceiling closes worker even when workers keep working and emit activity.
    const bgEnv = await setupEnv();
    const bgHarness = createSwarmHarness();
    const bgAdapter = new AntigravityAcpAdapter("agy", {
      ...bgEnv,
      spawnFn: bgHarness.spawnFn,
      killProcessTreeFn: bgHarness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
      idleWorkerTtlMs: 2_000,
      idleSweepIntervalMs: 25,
      inactivityTimeoutMs: 500,
      turnTimeoutMs: 2_000,
      swarmMaxDurationMs: 130,
      closeTimeoutMs: 50,
    });
    adapters.push(bgAdapter);

    const launch = bgAdapter.sendUserMessage("tarobot-2", {
      text: "/swarm background cap test",
      files: [],
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => bgHarness.children[0]?.server.prompts.length === 1);
    const bgServer = bgHarness.children[0]!.server;
    bgServer.advertiseCommands();
    await writeSwarmFiles(bgEnv.brainDir, "swarm-sess-1", {
      members: { title: "Background swarm", members: [{ name: "runner", role: "worker", state: "working" }] },
    });
    bgServer.text("Dispatched.");
    bgServer.respondPrompt();
    await launch;
    expect(bgAdapter.hasPendingNativeWork()).toBe(true);

    // Keep emitting heartbeats so lastActivityAt stays fresh — swarmMaxDurationMs MUST still close the session!
    const pulse = setInterval(() => {
      bgServer.sendUpdate({ sessionUpdate: "usage_update", used: 100, size: 10_000 });
    }, 30);
    try {
      await waitFor(() => bgHarness.log.includes("close:swarm-sess-1"), 1_500);
    } finally {
      clearInterval(pulse);
    }
    expect(bgAdapter.hasPendingNativeWork()).toBe(false);
    const afterBgCap = await bgAdapter.listTasks("swarm-sess-1");
    expect(afterBgCap.swarm?.active).toBe(false);
    expect(afterBgCap.swarm?.statusText).toBe("Swarm timed out");
  });

  it.each(["paused", "waiting"] as const)("does not grant infinite lifetime to %s-only idle swarms (inactivity, idle reaper, drain)", async (idleState) => {
    // 1. Active turn with paused/waiting-only swarm: inactivityTimeoutMs fires normally (does NOT wait for 6h total cap).
    const turnEnv = await setupEnv();
    const turnHarness = createSwarmHarness();
    const turnAdapter = new AntigravityAcpAdapter("agy", {
      ...turnEnv,
      spawnFn: turnHarness.spawnFn,
      killProcessTreeFn: turnHarness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
      inactivityTimeoutMs: 50,
      turnTimeoutMs: 5_000,
      swarmMaxDurationMs: 5_000,
      idleSweepIntervalMs: 0,
      closeTimeoutMs: 50,
    });
    adapters.push(turnAdapter);

    const turnPromise = turnAdapter.sendUserMessage("tarobot-1", {
      text: "/swarm quota pause test",
      files: [],
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => turnHarness.children[0]?.server.prompts.length === 1);
    turnHarness.children[0]!.server.advertiseCommands();
    await writeSwarmFiles(turnEnv.brainDir, "swarm-sess-1", {
      members: {
        title: "Idle swarm",
        members: [
          { name: "worker-a", role: "worker", state: idleState },
          { name: "monitor", role: "monitor", state: idleState === "paused" ? "working" : "waiting" },
        ],
      },
    });
    await expect(turnPromise).rejects.toThrow(/inactive/i);
    expect(turnHarness.log).toContain("close:swarm-sess-1");

    // 2. Post-turn idle worker with paused/waiting-only swarm: does NOT block drain and IS reaped after idleWorkerTtlMs.
    const idleEnv = await setupEnv();
    const idleHarness = createSwarmHarness();
    const idleAdapter = new AntigravityAcpAdapter("agy", {
      ...idleEnv,
      spawnFn: idleHarness.spawnFn,
      killProcessTreeFn: idleHarness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
      idleWorkerTtlMs: 40,
      idleSweepIntervalMs: 15,
      inactivityTimeoutMs: 5_000,
      turnTimeoutMs: 5_000,
      swarmMaxDurationMs: 5_000,
      closeTimeoutMs: 50,
    });
    adapters.push(idleAdapter);

    const launch = idleAdapter.sendUserMessage("tarobot-2", {
      text: "/swarm idle reap test",
      files: [],
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => idleHarness.children[0]?.server.prompts.length === 1);
    const server = idleHarness.children[0]!.server;
    server.advertiseCommands();
    await writeSwarmFiles(idleEnv.brainDir, "swarm-sess-1", {
      members: {
        title: "Idle post-turn swarm",
        members: [{ name: "worker-a", role: "worker", state: idleState }],
      },
    });
    server.text("Launched.");
    server.respondPrompt();
    await launch;

    expect(idleAdapter.hasPendingNativeWork()).toBe(false);
    await waitFor(() => idleHarness.log.includes("close:swarm-sess-1"), 1_500);
    expect(idleHarness.log).toContain("close:swarm-sess-1");
  });

  it("supports Antigravity AskUserQuestion approval cards with workerName attribution and Gateway tasks.stop swarm", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agy-swarm-gw-"));
    tempRoots.push(root);
    const stateDir = path.join(root, "bot");
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "antigravity", antigravityRuntime: "acp", locale: "en" }));

    // Test AskUserQuestion support for antigravity + workerName in core card-actions.
    const runtime = createCoreServiceRuntime();
    const sent: Array<{ card?: Record<string, unknown>; text?: string }> = [];
    const fakeChannel = {
      send: vi.fn(async (_to: string, payload: { card?: Record<string, unknown>; text?: string }) => {
        sent.push(payload);
        return { messageId: `m_${sent.length}` };
      }),
      stream: vi.fn(),
      downloadResource: vi.fn(),
    } as never;
    const ac = new AbortController();
    const decisionPromise = requestCoreApproval({
      channel: fakeChannel,
      runtime,
      chatId: "conv-1",
      conversationKey: "lark:conv-1",
      locale: "en",
      abortSignal: ac.signal,
      request: {
        engine: "antigravity",
        toolName: "AskUserQuestion",
        workerName: "schema-migrator",
        toolInput: { questions: [{ question: "Apply migration?", header: "Migration", options: [{ label: "Yes" }, { label: "No" }] }] },
      },
    });
    await waitFor(() => sent.length === 1);
    expect(JSON.stringify(sent[0])).toContain("@schema-migrator");
    expect(JSON.stringify(sent[0])).toContain("Apply migration?");
    ac.abort();
    await expect(decisionPromise).resolves.toEqual({ behavior: "deny" });

    // Test gateway tasks.stop with taskId: "swarm".
    const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('agy-bot','AGY Bot',?)", [hashSecret(secret)]);
    const stopBackgroundWork = vi.fn(async () => ({ stopped: true, summary: "Stopped the active swarm and ended all running workers." }));
    const channel = await attachGateway({
      stateDir,
      url: hub.url.replace("http", "ws") + "/instance",
      botId: "agy-bot",
      secret,
      engine: "antigravity",
      bridge: {
        handleAuthorizedMessage: vi.fn(async () => ({ text: "ok" })),
        stopBackgroundWork,
      },
      runtime: createCoreServiceRuntime(),
    });
    try {
      const conv = await hub.store.createConversation("owner", ["agy-bot"], "Swarm Stop", "create");
      const stopResult = await channel.onCall!("tasks.stop", {
        conversationId: conv.id,
        userId: "owner",
        taskId: "swarm",
        requestId: "req-stop-swarm-1",
      });
      expect(stopResult).toEqual({ outcome: "accepted" });
      expect(stopBackgroundWork).toHaveBeenCalledTimes(1);
      const snap = await hub.store.snapshot("owner", conv.id);
      expect(snap.messages.some((m) => JSON.stringify(m.blocks).includes("Stopped the active swarm"))).toBe(true);
    } finally {
      await channel.disconnect();
      await hub.close();
    }
  }, 20_000);

  it("preserves ordinary ACP sessions and background shell commands on /stop and never poisons stoppedSwarmSessions (Bug 1)", async () => {
    const env = await setupEnv();
    const harness = createSwarmHarness();
    const adapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: harness.spawnFn,
      killProcessTreeFn: harness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
      cancelGraceMs: 200,
    });
    adapters.push(adapter);

    // First turn starts a background shell command and finishes.
    const first = adapter.sendUserMessage("tarobot-1", {
      text: "start watcher",
      files: [],
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "shell_bg_1",
      name: "run_command",
      kind: "execute",
      status: "in_progress",
      title: "npm run dev",
      rawInput: { CommandLine: "npm run dev" },
    });
    server.sendUpdate({ sessionUpdate: "usage_update", used: 100, size: 10_000 });
    server.text("Watcher started.");
    server.respondPrompt();
    await first;

    // Default swarm-scoped stopBackgroundWork must NOT kill a non-swarm session with a background shell command.
    const noopStop = await adapter.stopBackgroundWork("swarm-sess-1", { locale: "en" });
    expect(noopStop.stopped).toBe(false);
    expect(harness.log.some((entry) => entry.startsWith("close:"))).toBe(false);

    // Ordinary foreground turn awaiting approval: stopCoreConversation must cancel via session/cancel, NOT call stopBackgroundWork or kill worker.
    const runtime = createCoreServiceRuntime();
    const ac = new AbortController();
    runtime.activeRuns.set("lark:c1", { abortController: ac, hasRunCard: false } as never);
    const stopBgSpy = vi.fn(async () => adapter.stopBackgroundWork("swarm-sess-1", { locale: "en", scope: "swarm" }));

    let releasePerm!: () => void;
    const second = adapter.sendUserMessage("swarm-sess-1", {
      text: "run check",
      files: [],
      abortSignal: ac.signal,
      onApprovalRequest: async (req) => {
        await new Promise<void>((resolve) => {
          releasePerm = resolve;
          req.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { behavior: "deny" };
      },
    });
    await waitFor(() => server.prompts.length === 2);
    server.requestPermission({ toolCallId: "perm_fg", command: "npm test" });
    await waitFor(() => releasePerm !== undefined);

    const stopRes = await stopCoreConversation(runtime, "lark:c1", undefined, { stopBackgroundWork: stopBgSpy }, "en");
    expect(stopRes.active).toBeDefined();
    expect(stopRes.backgroundStopped).toBe(false);
    expect(stopBgSpy).not.toHaveBeenCalled();
    await expect(second).rejects.toThrow("Task was stopped by user");
    // Session stayed alive (only session/cancel, never session/close or kill).
    expect(harness.log).toEqual(["cancel:swarm-sess-1"]);
    expect(harness.children).toHaveLength(1);

    // Follow-up turn still reuses the exact same live ACP worker!
    const third = adapter.sendUserMessage("swarm-sess-1", {
      text: "still alive?",
      files: [],
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => server.prompts.length === 3);
    server.text("yes");
    server.respondPrompt();
    await expect(third).resolves.toMatchObject({ text: "yes" });
    expect(harness.children).toHaveLength(1);
  });

  it("ignores non-swarm board/prefixed/subagent tool updates so ordinary conversations keep timeouts, reaping, and drain (Bug 2)", async () => {
    const env = await setupEnv();
    const harness = createSwarmHarness();
    const adapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: harness.spawnFn,
      killProcessTreeFn: harness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
      idleWorkerTtlMs: 30,
      idleSweepIntervalMs: 10,
      inactivityTimeoutMs: 60,
      cancelGraceMs: 200,
    });
    adapters.push(adapter);

    const reply = adapter.sendUserMessage("tarobot-1", {
      text: "update whiteboard and check git",
      files: [],
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;

    // Emit updates that previously triggered false-positive swarm activation.
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", name: "whiteboard_draw", status: "in_progress", title: "Draw box" });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", name: "whiteboard_draw", status: "completed" });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "t2", name: "clipboard_read", status: "in_progress", title: "[git] status" });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t2", name: "clipboard_read", status: "completed" });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "t3", name: "dashboard_query", status: "in_progress", _meta: { agentName: "helper-bot", subagentName: "sub1" }, title: "@scope: query" });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t3", name: "dashboard_query", status: "completed" });
    server.text("Done.");
    server.respondPrompt();
    await reply;

    const snap = await adapter.listTasks("swarm-sess-1");
    expect(snap.swarm).toBeUndefined();
    expect(adapter.hasPendingNativeWork()).toBe(false);

    // Idle reaper must still reap this ordinary idle worker!
    await waitFor(() => harness.log.includes("close:swarm-sess-1"), 1_500);
    expect(harness.log).toContain("close:swarm-sess-1");
  });

  it("synchronizes worker.swarm.active across natural completion, second /swarm over stale files, and resumed file-only swarms (Bug 3)", async () => {
    const env = await setupEnv();
    const harness = createSwarmHarness();
    const adapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: harness.spawnFn,
      killProcessTreeFn: harness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
      commandsAdvertiseTimeoutMs: 20,
      cancelGraceMs: 200,
    });
    adapters.push(adapter);

    // 1. Start first /swarm.
    const firstSwarm = adapter.sendUserMessage("tarobot-1", {
      text: "/swarm first audit",
      files: [],
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.advertiseCommands();
    await writeSwarmFiles(env.brainDir, "swarm-sess-1", {
      members: { title: "First", members: [{ name: "w1", state: "working" }] },
    });
    server.text("Started swarm 1.");
    server.respondPrompt();
    await firstSwarm;
    expect(adapter.hasPendingNativeWork()).toBe(true);

    // 2. Swarm 1 finishes naturally in members.json.
    const finishedAt = Date.now() + 10;
    await writeSwarmFiles(env.brainDir, "swarm-sess-1", {
      members: { title: "First", members: [{ name: "w1", state: "done", updatedAt: finishedAt }] },
    });
    // hasPendingNativeWork must immediately see completion without waiting for idle reaper!
    expect(adapter.hasPendingNativeWork()).toBe(false);
    const afterDoneSnap = await adapter.listTasks("swarm-sess-1");
    expect(afterDoneSnap.swarm?.active).toBe(false);

    // Ordinary turn + /stop after completion must NOT kill the live ACP worker.
    const ac = new AbortController();
    const ordinary = adapter.sendUserMessage("swarm-sess-1", {
      text: "@someone ordinary message",
      files: [],
      instructions: "Platform rules",
      abortSignal: ac.signal,
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => server.prompts.length === 2);
    // After swarm ended, @someone must stay wrapped inside <user_message>, not unwrapped!
    const ordinaryBlocks = server.prompts[1]!.params!.prompt as Array<{ text: string }>;
    expect(ordinaryBlocks[0]!.text).toContain("<private_bridge_instructions>");
    expect(ordinaryBlocks[1]!.text).toBe("<user_message>\n@someone ordinary message\n</user_message>");
    ac.abort();
    await expect(ordinary).rejects.toThrow("Task was stopped by user");
    expect(harness.log).toEqual(["cancel:swarm-sess-1"]);

    // 3. Backdate old members.json slightly and start a SECOND /swarm in the same session.
    const oldTime = new Date(Date.now() - 5_000);
    const membersPath = path.join(env.brainDir, "swarm-sess-1", ".system_generated", "swarm", "members.json");
    await utimes(membersPath, oldTime, oldTime);

    const secondSwarm = adapter.sendUserMessage("swarm-sess-1", {
      text: "/swarm second audit",
      files: [],
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => server.prompts.length === 3);
    server.text("Started swarm 2.");
    server.respondPrompt();
    await secondSwarm;

    // Stale finished members.json from swarm 1 MUST NOT deactivate swarm 2!
    expect(adapter.hasPendingNativeWork()).toBe(true);
    const secondSnap = await adapter.listTasks("swarm-sess-1");
    expect(secondSnap.swarm?.active).toBe(true);

    // 4. Resumed session with file-only active swarm protects Gateway drain immediately.
    await writeSwarmFiles(env.brainDir, "resumed-file-swarm", {
      members: { title: "Resumed swarm", members: [{ name: "worker-a", state: "working" }] },
    });
    const resumedTurn = adapter.sendUserMessage("resumed-file-swarm", {
      text: "check status",
      files: [],
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => harness.children[1]?.server.prompts.length === 1);
    const resumedServer = harness.children[1]!.server;
    resumedServer.text("Still running.");
    resumedServer.respondPrompt();
    await resumedTurn;
    expect(adapter.hasPendingNativeWork()).toBe(true);
  });

  it("blocks first-turn /swarm when available_commands_update arrives asynchronously without swarm (Bug 5)", async () => {
    const env = await setupEnv();
    const unadvertisedHarness = createSwarmHarness((server) => {
      server.availableCommands = [{ name: "compact", description: "Compact" }];
      server.autoAdvertiseDelayMs = 25;
    });
    const adapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: unadvertisedHarness.spawnFn,
      killProcessTreeFn: unadvertisedHarness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
      commandsAdvertiseTimeoutMs: 500,
    });
    adapters.push(adapter);

    // Send /swarm as the VERY FIRST message on a fresh Bot.
    const reply = await adapter.sendUserMessage("tarobot-1", {
      text: "/swarm parallel check",
      files: [],
      locale: "zh",
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    expect(reply.text).toContain("未开放 `/swarm`");
    expect(unadvertisedHarness.children[0]!.server.prompts).toHaveLength(0);
  });

  it("unwraps @worker when worker.swarm.members has partial ACP membership while target exists only in members.json (Bug 6)", async () => {
    const env = await setupEnv();
    const harness = createSwarmHarness((server) => { server.autoAdvertiseDelayMs = 5; });
    const adapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: harness.spawnFn,
      killProcessTreeFn: harness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
    });
    adapters.push(adapter);

    const start = adapter.sendUserMessage("tarobot-1", {
      text: "/swarm fix auth and verify",
      files: [],
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    // ACP update populates only auth-fix, while members.json has both auth-fix and verifier.
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "sw_add_1",
      name: "swarm",
      title: "swarm add auth-fix",
      status: "completed",
      rawInput: { action: "add", name: "auth-fix", brief: "Fix auth" },
    });
    await waitFor(() => true);
    // Tool-derived worker updates inside an existing swarm cleanly transition out of "working" on completion.
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "worker_cmd_1",
      name: "run_command",
      title: "npm test",
      status: "in_progress",
      _meta: { workerName: "temp-runner" },
    });
    const midSnap = await adapter.listTasks("swarm-sess-1");
    expect(midSnap.swarm?.members.find((m) => m.name === "temp-runner")?.state).toBe("working");
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "worker_cmd_1",
      name: "run_command",
      title: "npm test",
      status: "completed",
      _meta: { workerName: "temp-runner" },
    });
    const afterToolSnap = await adapter.listTasks("swarm-sess-1");
    expect(afterToolSnap.swarm?.members.find((m) => m.name === "temp-runner")?.state).toBe("done");

    await writeSwarmFiles(env.brainDir, "swarm-sess-1", {
      members: {
        members: [
          { name: "auth-fix", state: "working" },
          { name: "verifier", state: "waiting" },
        ],
      },
    });
    server.text("Swarm launched.");
    server.respondPrompt();
    await start;

    const mention = adapter.sendUserMessage("swarm-sess-1", {
      text: "@verifier run the full auth suite",
      files: [],
      instructions: "Platform rules",
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    await waitFor(() => server.prompts.length === 2);
    const blocks = server.prompts[1]!.params!.prompt as Array<{ text: string }>;
    expect(blocks[0]!.text).toBe("@verifier run the full auth suite");
    server.text("Routed to verifier.");
    server.respondPrompt();
    await mention;
  });

  it("coerces boolean/number/integer elicitation fields, deduplicates duplicate question keys, and declines invalid values (Bug 7)", async () => {
    const env = await setupEnv();
    const harness = createSwarmHarness();
    const adapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: harness.spawnFn,
      killProcessTreeFn: harness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
    });
    adapters.push(adapter);

    const seen: EngineApprovalRequest[] = [];
    let nextAnswers: Record<string, unknown> = {};
    const turn = adapter.sendUserMessage("tarobot-1", {
      text: "configure",
      files: [],
      locale: "en",
      onApprovalRequest: async (req) => {
        seen.push(req);
        return { behavior: "allow", updatedInput: { answers: nextAnswers } };
      },
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;

    // Duplicate fallback titles/descriptions (both omit title/description while requestedSchema.title is shared) + boolean/number/integer.
    nextAnswers = {
      "Deploy Options": "Yes",
      "Deploy Options (2)": "4",
      "Threshold": "0.75",
    };
    const elicitOk = server.requestElicitation({
      message: "Configure rollout",
      requestedSchema: {
        type: "object",
        title: "Deploy Options",
        required: ["confirm", "replicas", "threshold"],
        properties: {
          confirm: { type: "boolean" },
          replicas: { type: "integer", minimum: 1, maximum: 10 },
          threshold: { type: "number", title: "Threshold" },
        },
      },
    });
    await waitFor(() => server.clientResponses.has(elicitOk));
    const askQuestions = (seen.at(-1)?.toolInput as { questions: Array<{ question: string; options: Array<{ label: string }> }> }).questions;
    expect(askQuestions.map((q) => q.question)).toEqual(["Deploy Options", "Deploy Options (2)", "Threshold"]);
    expect(askQuestions[0]!.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(server.clientResponses.get(elicitOk)?.result).toEqual({
      action: "accept",
      content: { confirm: true, replicas: 4, threshold: 0.75 },
    });

    // Non-integer value for integer field must decline rather than send a corrupt string.
    nextAnswers = { "Replicas": "3.5" };
    const elicitBad = server.requestElicitation({
      requestedSchema: {
        type: "object",
        required: ["replicas"],
        properties: {
          replicas: { type: "integer", title: "Replicas" },
        },
      },
    });
    await waitFor(() => server.clientResponses.has(elicitBad));
    expect(server.clientResponses.get(elicitBad)?.result).toEqual({ action: "decline" });

    server.text("Configured.");
    server.respondPrompt();
    await turn;
  });

  it("rejects unrelated nested objects and unrecognized container schemas in members.json (Bug 8)", async () => {
    const { brainDir } = await setupEnv();
    await writeSwarmFiles(brainDir, "sess-meta", {
      members: { version: 2, metadata: { owner: "agy" }, settings: { max: 4 } },
    });
    const metaParsed = await readSwarmBoardFiles(brainDir, "sess-meta");
    expect(metaParsed.found).toBe(true);
    expect(metaParsed.members).toEqual([]);
    expect(metaParsed.formatUnknown).toBe(true);

    await writeSwarmFiles(brainDir, "sess-entries", {
      members: { entries: [{ name: "a", state: "working" }] },
    });
    const entriesParsed = await readSwarmBoardFiles(brainDir, "sess-entries");
    expect(entriesParsed.found).toBe(true);
    expect(entriesParsed.members).toEqual([]);
    expect(entriesParsed.formatUnknown).toBe(true);

    await writeSwarmFiles(brainDir, "sess-map", {
      members: { "auth-fix": { state: "working", model: "gemini-4-neon" } },
    });
    const mapParsed = await readSwarmBoardFiles(brainDir, "sess-map");
    expect(mapParsed.formatUnknown).toBe(false);
    expect(mapParsed.members).toHaveLength(1);
    expect(mapParsed.members[0]?.name).toBe("auth-fix");

    await writeSwarmFiles(brainDir, "sess-empty-roster", {
      members: { members: [] },
    });
    const emptyRoster = await readSwarmBoardFiles(brainDir, "sess-empty-roster");
    expect(emptyRoster.formatUnknown).toBe(false);
    expect(emptyRoster.members).toEqual([]);
  });

  it("uses ANTIGRAVITY_EXECUTABLE and keeps gateway commands RPC non-blocking with negative TTL cache (Bug 4)", async () => {
    expect(resolveAntigravityExecutable({ ANTIGRAVITY_EXECUTABLE: "\"/custom/bin/agy\"", ANTIGRAVITY_CMD: "/wrong/agy" })).toBe("/custom/bin/agy");

    const root = await mkdtemp(path.join(os.tmpdir(), "agy-gw-cmd-"));
    tempRoots.push(root);
    const stateDir = path.join(root, "bot");
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "antigravity", antigravityRuntime: "acp", locale: "en" }));

    const fakeAgy = path.join(root, "fake-agy.sh");
    await writeFile(fakeAgy, "#!/bin/sh\necho 'antigravity 1.5.17'\n");
    await chmod(fakeAgy, 0o755);

    const prevExec = process.env.ANTIGRAVITY_EXECUTABLE;
    const prevCmd = process.env.ANTIGRAVITY_CMD;
    process.env.ANTIGRAVITY_EXECUTABLE = fakeAgy;
    process.env.ANTIGRAVITY_CMD = "/nonexistent/agy-cmd";

    const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('agy-cmd-bot','AGY Cmd Bot',?)", [hashSecret(secret)]);
    const channel = await attachGateway({
      stateDir,
      url: hub.url.replace("http", "ws") + "/instance",
      botId: "agy-cmd-bot",
      secret,
      engine: "antigravity",
      bridge: {
        handleAuthorizedMessage: vi.fn(async () => ({ text: "ok" })),
        advertisedCommands: () => [],
        hasReceivedAdvertisedCommands: () => false,
      },
      runtime: createCoreServiceRuntime(),
    });
    try {
      // Wait for the eager background probe (or bounded race) to settle and include /swarm from ANTIGRAVITY_EXECUTABLE.
      let foundSwarm = false;
      const deadline = Date.now() + 2_500;
      while (Date.now() < deadline && !foundSwarm) {
        const commands = await channel.onCall!("commands", { query: "sw" }) as Array<{ command: string }>;
        if (commands.some((c) => c.command === "swarm")) {
          foundSwarm = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      expect(foundSwarm).toBe(true);

      // Slow executable must NOT block commands RPC beyond ~250ms race budget.
      const slowAgy = path.join(root, "slow-agy.sh");
      await writeFile(slowAgy, "#!/bin/sh\nsleep 2\necho 'antigravity 1.5.17'\n");
      await chmod(slowAgy, 0o755);
      process.env.ANTIGRAVITY_EXECUTABLE = slowAgy;

      const t0 = Date.now();
      const fastResult = await channel.onCall!("commands", { query: "" }) as Array<{ command: string }>;
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(800);
      expect(fastResult.length).toBeGreaterThan(0);

      // Failing probe caches negative result (bounded TTL) instead of re-spawning on every keystroke.
      const countFile = path.join(root, "fail-count.txt");
      const failAgy = path.join(root, "fail-agy.sh");
      await writeFile(failAgy, `#!/bin/sh\necho x >> "${countFile}"\nexit 1\n`);
      await chmod(failAgy, 0o755);
      process.env.ANTIGRAVITY_EXECUTABLE = failAgy;

      await channel.onCall!("commands", { query: "s" });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await channel.onCall!("commands", { query: "sw" });
      await channel.onCall!("commands", { query: "swa" });
      const { readFile: readFileAsync } = await import("node:fs/promises");
      const spawns = (await readFileAsync(countFile, "utf8")).trim().split("\n").filter(Boolean);
      expect(spawns).toHaveLength(1);
    } finally {
      if (prevExec === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE;
      else process.env.ANTIGRAVITY_EXECUTABLE = prevExec;
      if (prevCmd === undefined) delete process.env.ANTIGRAVITY_CMD;
      else process.env.ANTIGRAVITY_CMD = prevCmd;
      await channel.disconnect();
      await hub.close();
    }
  }, 20_000);
});
