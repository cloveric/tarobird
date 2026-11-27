import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EngineIncompleteResponseError, EngineSteeringRejectedError, failedTurnUsage,
  type AppPlatformTools, type CodexUserMessageInput, type EngineApprovalDecision, type EngineApprovalRequest, type EngineStreamEvent,
} from "../src/codex/adapter.js";
import type { PiBridgeConnection, PiBridgeControl, PiBridgeEndpoint, PiBridgeEvent, PiBridgeHandler } from "../src/codex/pi-bridge-host.js";
import { PiNativeBridgeUnavailableError, PiNativeBusyError, PiNativeRejectedError, PiNativeUncertainError, type PiNativeEvent } from "../src/codex/pi-native-types.js";
import { PiRpcAdapter, getPiNativeControls, type PiRpcAdapterOptions } from "../src/codex/pi-rpc-adapter.js";
import { PiRpcCommandError, PiStartupError } from "../src/codex/pi-rpc-client.js";
import { classifyFailure } from "../src/runtime/error-classification.js";
import { PiSessionStore, piBotDefaultFingerprint } from "../src/codex/pi-session-store.js";
import { MANAGED_SEARCH_MCP_NAME, type NativeSearchMcpPlan } from "../src/runtime/native-search-mcp.js";
import { FakePiProcess, fakePiModel, fakePiSpawner, type FakePiOptions, type FakePiRun } from "./helpers/pi-fake-rpc.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Condition was not met in time");
}

class FakeBridge {
  handler!: PiBridgeHandler;
  readonly gates: boolean[] = [];
  readonly installed: Array<Array<{ name: string }>> = [];
  readonly controls: PiBridgeControl[] = [];
  readonly labels: Array<{ entryId: string; label: string | null }> = [];
  readonly mcpServers: Array<Array<{ name: string; config: Record<string, unknown> }>> = [];
  controlResult: { cancelled?: boolean } = {};
  /** Awaited before the search server registration is answered. */
  searchRegistration?: () => Promise<void>;
  skipInstall = false;
  open = true;
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  readonly connection: PiBridgeConnection;

  constructor() {
    const bridge = this;
    this.connection = {
      setGate: async gate => { bridge.gates.push(gate); },
      installTools: async definitions => {
        bridge.installed.push(definitions);
        return bridge.skipInstall ? { installed: [], skipped: definitions.map(item => item.name) } : { installed: definitions.map(item => item.name), skipped: [] };
      },
      listTools: async () => [{ name: "read", active: true, exposure: "direct", origin: "builtin" as const }],
      setActiveTools: async names => names.map(name => ({ name, active: true, origin: "other" as const })),
      setMcpServers: async servers => { bridge.mcpServers.push(servers); await bridge.searchRegistration?.(); return servers.map(server => server.name); },
      setLabel: async (entryId, label) => { bridge.labels.push({ entryId, label }); },
      readSettings: async () => ({}),
      control: async (request, options) => {
        bridge.controls.push(request);
        await options.trigger("/tarobird-bridge 00000000-0000-4000-8000-000000000000");
        return bridge.controlResult;
      },
      closed: bridge.closed,
      get isOpen() { return bridge.open; },
      close: () => { bridge.drop(); },
    };
  }
  drop(): void { if (this.open) { this.open = false; this.resolveClosed(); } }
}

interface Rig {
  adapter: PiRpcAdapter;
  spawner: ReturnType<typeof fakePiSpawner>;
  bridges: FakeBridge[];
  bridge(): FakeBridge;
  root: string; stateDir: string; workspace: string; configPath: string;
  writeConfig(config: Record<string, unknown>): Promise<void>;
  catalogCalls: number;
  startupApprovals: Array<{ allow: boolean; reason?: string }>;
}

async function rig(input: {
  pi?: FakePiOptions | ((index: number, args: string[]) => FakePiOptions);
  bridge?: boolean;
  bridgeConnects?: boolean;
  config?: Record<string, unknown> | null;
  options?: Partial<PiRpcAdapterOptions>;
  nativeDefault?: { provider: string; modelId: string; thinkingLevel: string } | null;
  /** Bridge events that arrive while Pi is still starting, before the adapter has a worker for the process. */
  startupEvents?: PiBridgeEvent[];
  /** Holds the answer to the search server registration, the last wait before a started process is handed out. */
  searchRegistration?: () => Promise<void>;
} = {}): Promise<Rig> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-"));
  const stateDir = path.join(root, "state"), workspace = path.join(root, "ws"), configPath = path.join(stateDir, "config.json");
  await mkdir(stateDir, { recursive: true }); await mkdir(workspace, { recursive: true });
  const writeConfig = (config: Record<string, unknown>) => writeFile(configPath, JSON.stringify({ engine: "pi", ...config }));
  if (input.config !== null) await writeConfig(input.config ?? { approvalMode: "bypass" });
  const bridges: FakeBridge[] = [];
  const startupApprovals: Array<{ allow: boolean; reason?: string }> = [];
  const userCommand = typeof input.pi === "function" ? undefined : input.pi?.onCommand;
  const withBridgeCommand = (options: FakePiOptions): FakePiOptions => ({
    ...options,
    onCommand: (command, process) => {
      if (command.type === "prompt" && String(command.message).startsWith("/tarobird-bridge ")) { process.respond(command, { disposition: "handled" }); return true; }
      return (options.onCommand ?? userCommand)?.(command, process);
    },
  });
  const spawner = fakePiSpawner((index, args) => withBridgeCommand(typeof input.pi === "function" ? input.pi(index, args) : input.pi ?? {}));
  const result = { catalogCalls: 0 } as Rig;
  const adapter = new PiRpcAdapter({
    launch: { command: "pi", args: [] }, workspacePath: workspace, stateDir, childEnv: { PI_CODING_AGENT_DIR: path.join(root, "agent") },
    ...(input.config !== null ? { configPath } : {}),
    bridgeExtensionPath: input.bridge === false ? null : "/synthetic/dist/pi-bridge-extension.js",
    spawnFn: spawner.spawn, killProcessTreeFn: pid => { for (const process of spawner.processes) if (process.pid === pid) process.exit(null, "SIGKILL"); },
    openBridgeFn: async ({ handler }) => {
      const bridge = new FakeBridge(); bridge.handler = handler; bridges.push(bridge);
      if (input.searchRegistration) bridge.searchRegistration = input.searchRegistration;
      for (const event of input.startupEvents ?? []) handler.onEvent(event);
      startupApprovals.push(await handler.approve({ toolName: "bash", toolCallId: "early", origin: "builtin", input: {} }, new AbortController().signal));
      const endpoint: PiBridgeEndpoint = {
        env: { TAROBIRD_PI_BRIDGE_ENDPOINT: "/synthetic/socket", TAROBIRD_PI_BRIDGE_TOKEN: "token" },
        connection: input.bridgeConnects === false ? Promise.reject(new Error("no connection")) : Promise.resolve(bridge.connection),
        dispose: () => { bridge.drop(); },
      };
      endpoint.connection.catch(() => {});
      return endpoint;
    },
    queryCatalogFn: async () => { result.catalogCalls++; return { models: [], ...(input.nativeDefault === null ? {} : { current: input.nativeDefault ?? { provider: "fakeprov", modelId: "dup-model", thinkingLevel: "medium" } }) }; },
    idleSweepIntervalMs: 0, cancelGraceMs: 80, startupTimeoutMs: 500, turnTimeoutMs: null, inactivityTimeoutMs: null,
    ...input.options,
  });
  cleanups.push(async () => { await adapter.destroy(); await rm(root, { recursive: true, force: true }); });
  return Object.assign(result, { adapter, spawner, bridges, bridge: () => bridges[bridges.length - 1]!, root, stateDir, workspace, configPath, writeConfig, startupApprovals });
}

function message(text: string, extra: Partial<CodexUserMessageInput> = {}): CodexUserMessageInput & { events: EngineStreamEvent[] } {
  const events: EngineStreamEvent[] = [];
  // `authoredText`: these are the owner's own messages, typed as given. Tests of other sources override it.
  return { text, authoredText: text, files: [], locale: "en", onEngineEvent: event => { events.push(event); }, events, ...extra } as CodexUserMessageInput & { events: EngineStreamEvent[] };
}
const commands = (process: FakePiProcess, type?: string) => process.received.filter(command => !type || command.type === type);
const kinds = (events: EngineStreamEvent[]) => events.map(event => event.type);

describe("Pi extension error visibility", () => {
  it("retains startup errors and exposes running errors without replaying them next turn", async () => {
    let startupReported = false, turnReported = false;
    const r = await rig({ pi: {
      onCommand: (command, process) => {
        if (command.type === "get_state" && !startupReported) {
          startupReported = true;
          process.send({ type: "extension_error", extensionPath: "/synthetic/extensions/broken.ts", event: "session_start", error: "STARTUP_EXTENSION_FAILURE" });
        }
      },
      onPrompt: run => {
        if (!turnReported) {
          turnReported = true;
          run.emit({ type: "extension_error", extensionPath: "/synthetic/extensions/broken.ts", event: "before_agent_start", error: "RUNNING_EXTENSION_FAILURE" });
        }
        run.reply("The model still answered."); run.finish();
      },
    } });
    const { sessionId } = await r.adapter.createSession(1);
    const native: PiNativeEvent[] = [];
    r.adapter.piNative.subscribe(sessionId, event => native.push(event));
    const input = message("check extensions");
    const result = await r.adapter.sendUserMessage(sessionId, input);
    const text = input.events.filter(event => event.type === "assistant_text").map(event => event.text).join("\n");
    expect(text).toContain("STARTUP_EXTENSION_FAILURE");
    expect(text).toContain("RUNNING_EXTENSION_FAILURE");
    expect(text).not.toContain("/synthetic/extensions/");
    expect(result.text).toContain("2 extension errors");
    expect(result.text).toContain("The model still answered.");
    expect(native.filter(event => event.type === "extension_error")).toHaveLength(2);
    const next = message("unrelated next turn");
    expect((await r.adapter.sendUserMessage(sessionId, next)).text).toBe("The model still answered.");
    expect(JSON.stringify(next.events)).not.toContain("EXTENSION_FAILURE");
  });

  it("keeps error details and delivery-looking text out of the final reply", async () => {
    const detail = "Cannot load resource [send-file:/synthetic/private.txt]";
    const r = await rig({ pi: { onPrompt: run => {
      run.emit({ type: "extension_error", extensionPath: "/synthetic/extensions/broken.ts", event: "tool_call", error: detail });
      run.reply("正文"); run.finish();
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("check", { locale: "zh" });
    const result = await r.adapter.sendUserMessage(sessionId, input);
    expect(result.text).toContain("1 个扩展错误");
    expect(result.text).not.toContain("send-file");
    expect(result.text).not.toContain("Cannot load resource");
    expect(input.events).toContainEqual({ type: "result", text: result.text, sessionId });
    expect(input.events.some(event => event.type === "assistant_text" && event.text.includes("Cannot load resource"))).toBe(true);
  });

  it("bounds noisy extension diagnostics while retaining the full turn error count", async () => {
    const r = await rig({ pi: { onPrompt: run => {
      for (let index = 0; index < 37; index++) run.emit({ type: "extension_error", extensionPath: "/synthetic/broken.ts", event: "tool_call", error: `Repeated failure ${index}` });
      run.reply("Completed."); run.finish();
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("check");
    const result = await r.adapter.sendUserMessage(sessionId, input);
    expect(result.text).toContain("37 extension errors");
    expect(input.events.filter(event => event.type === "assistant_text" && event.text.includes("Repeated failure"))).toHaveLength(20);
  });

  it("also surfaces startup diagnostics when the turn runs a built-in command", async () => {
    let reported = false;
    const r = await rig({ pi: { onCommand: (command, process) => {
      if (command.type === "get_state" && !reported) {
        reported = true;
        process.send({ type: "extension_error", extensionPath: "/synthetic/broken.ts", event: "session_start", error: "RESOURCE_FAILED" });
      }
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("/session");
    const result = await r.adapter.sendUserMessage(sessionId, input);
    expect(result.text).toContain("1 extension error occurred");
    expect(result.text).not.toContain("RESOURCE_FAILED");
    expect(commands(r.spawner.last(), "prompt")).toEqual([]);
    expect(input.events).toContainEqual({ type: "result", text: result.text, sessionId });
  });
});
const allow = (scope?: "once" | "session"): EngineApprovalDecision => ({ behavior: "allow", ...(scope ? { scope } : {}) });
const failure = (promise: Promise<unknown>): Promise<Error> => promise.then(() => { throw new Error("Expected a rejection"); }, error => error as Error);

describe("PiRpcAdapter sessions and process lifecycle", () => {
  it("creates a real session id without starting Pi, then starts it with native flags only", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.spawner.processes).toHaveLength(0);
    const input = message("hello");
    const response = await r.adapter.sendUserMessage(sessionId, input);
    const args = r.spawner.last().args;
    expect(args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(args).toEqual(expect.arrayContaining(["--session-dir", path.join(r.stateDir, "pi", "sessions"), "--session-id", sessionId, "-e", "/synthetic/dist/pi-bridge-extension.js"]));
    // --model/--thinking would be re-applied on every fork and override a resumed session's own model.
    expect(args).not.toContain("--model"); expect(args).not.toContain("--thinking"); expect(args).not.toContain("--session");
    expect(r.spawner.last().spawnArgs.options.env).toMatchObject({ TAROBIRD_PI_BRIDGE_TOKEN: "token", PI_CODING_AGENT_DIR: path.join(r.root, "agent") });
    expect(response).toMatchObject({ text: "ok", sessionId, usage: { inputTokens: 80, outputTokens: 20, cachedTokens: 40, costUsd: 0.001 } });
    expect(kinds(input.events)).toEqual(["session", "assistant_text", "assistant_text", "result"]);
    expect(input.events[1]).not.toHaveProperty("delta");
    expect(input.events[2]).toMatchObject({ delta: true });
  });

  it("restartSession ends only that session's Pi process, and the next turn starts a new one on the same session", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await expect(r.adapter.restartSession(sessionId)).resolves.toEqual({ outcome: "not_running" });
    await r.adapter.sendUserMessage(sessionId, message("hello"));
    expect(r.spawner.processes).toHaveLength(1);
    await expect(r.adapter.restartSession(sessionId)).resolves.toEqual({ outcome: "closed" });
    await expect(r.adapter.restartSession(sessionId)).resolves.toEqual({ outcome: "not_running" });
    const response = await r.adapter.sendUserMessage(sessionId, message("again"));
    expect(response).toMatchObject({ text: "ok", sessionId });
    expect(r.spawner.processes).toHaveLength(2);
    expect(r.spawner.last().args.join(" ")).toContain(sessionId);
  });

  it("retires a process still opening the same Pi session without letting it take the first prompt", async () => {
    let stuck = false;
    const r = await rig({ pi: { onCommand: command => {
      if (command.type !== "get_state" || stuck) return false;
      stuck = true;
      return true;
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const first = failure(r.adapter.sendUserMessage(sessionId, message("first")));
    await waitFor(() => stuck);
    const original = r.spawner.last();
    await expect(r.adapter.restartSession(sessionId)).resolves.toEqual({ outcome: "closed" });
    expect(await first).toMatchObject({ name: "AbortError" });
    expect(commands(original, "prompt")).toHaveLength(0);
    await expect(r.adapter.sendUserMessage(sessionId, message("next"))).resolves.toMatchObject({ sessionId });
    expect(r.spawner.processes).toHaveLength(2);
  });

  it("resumes an existing session file by absolute path and refuses one from another workspace", async () => {
    const r = await rig();
    const dir = path.join(r.stateDir, "pi", "sessions"); await mkdir(dir, { recursive: true });
    const here = path.join(dir, "2026-01-01T00-00-00-000Z_resume-here.jsonl"), elsewhere = path.join(dir, "2026-01-01T00-00-00-000Z_resume-else.jsonl");
    await writeFile(here, `${JSON.stringify({ type: "session", version: 3, id: "resume-here", timestamp: "2026-01-01T00:00:00.000Z", cwd: r.workspace })}\n`);
    await writeFile(elsewhere, `${JSON.stringify({ type: "session", version: 3, id: "resume-else", timestamp: "2026-01-01T00:00:00.000Z", cwd: path.join(r.root, "other") })}\n`);
    await r.adapter.sendUserMessage("resume-here", message("hi"));
    expect(r.spawner.last().args).toEqual(expect.arrayContaining(["--session", here]));
    expect(r.spawner.last().args).not.toContain("--session-id");
    // By id from another directory Pi asks [y/N] on the terminal and reads the first command as the answer.
    await expect(r.adapter.sendUserMessage("resume-else", message("hi"))).rejects.toThrow(/another workspace/);
    expect(r.spawner.processes).toHaveLength(1);
    await expect(r.adapter.sendUserMessage("../escape", message("hi"))).rejects.toThrow(/Invalid Pi session id/);
  });

  it("restores a session through a linked workspace after an idle close and still rejects another workspace", async () => {
    const r = await rig({ options: { idleWorkerTtlMs: 0 } });
    const link = path.join(r.root, "workspace-link");
    await symlink(r.workspace, link, process.platform === "win32" ? "junction" : "dir");
    const dir = path.join(r.stateDir, "pi", "sessions");
    await mkdir(dir, { recursive: true });
    const sessionId = "linked-workspace";
    await writeFile(path.join(dir, `2026-01-01_${sessionId}.jsonl`), JSON.stringify({ type: "session", id: sessionId, cwd: r.workspace }) + "\n");
    expect(await r.adapter.validateExternalSession(sessionId, { workspaceOverride: link })).toMatchObject({ sessionId });
    await r.adapter.sendUserMessage(sessionId, message("first", { workspaceOverride: link }));
    await (r.adapter as unknown as { sweepIdleWorkers(): Promise<void> }).sweepIdleWorkers();
    await r.adapter.sendUserMessage(sessionId, message("again", { workspaceOverride: link }));
    expect(r.spawner.processes).toHaveLength(2);
    await expect(r.adapter.validateExternalSession(sessionId, { workspaceOverride: path.join(r.root, "other") })).rejects.toThrow(/another workspace/);
  });

  it("does not reuse a pending worker for the same id in another workspace", async () => {
    let ready: (() => void) | undefined;
    let held = false;
    const r = await rig({ pi: { onCommand(command, process) {
      if (command.type !== "get_state" || held) return false;
      held = true;
      ready = () => process.respond(command, process.state);
      return true;
    } } });
    const first = r.adapter.getContextUsage("pending-workspace");
    await waitFor(() => Boolean(ready));
    const second = r.adapter.getContextUsage("pending-workspace", { workspaceOverride: path.join(r.root, "other") });
    const rejected = expect(second).rejects.toThrow(/another workspace/);
    ready!();
    await first;
    await rejected;
    expect(r.spawner.processes).toHaveLength(1);
  });

  it("answers a passive context reading only from a process that is already running, and starts none", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    expect(await r.adapter.getContextUsage(sessionId, { passive: true })).toBeNull();
    expect(r.spawner.processes).toHaveLength(0);
    const live = (await r.adapter.sendUserMessage(sessionId, message("hello"))).sessionId ?? sessionId;
    const asked = commands(r.spawner.last(), "get_session_stats").length;
    expect(await r.adapter.getContextUsage(live, { passive: true })).toEqual({ pressureTokens: 266, contextWindow: 32000 });
    expect(commands(r.spawner.last(), "get_session_stats")).toHaveLength(asked + 1);
    r.spawner.last().exit(0, null);
    await waitFor(async () => await r.adapter.getContextUsage(live, { passive: true }) === null);
    expect(r.spawner.processes).toHaveLength(1);
  });

  it("uses the current configured workspace for session listing, resume validation and context controls", async () => {
    const r = await rig();
    const custom = path.join(r.root, "custom-workspace");
    await mkdir(custom, { recursive: true });
    await r.writeConfig({ approvalMode: "bypass", workspacePath: custom });
    const dir = path.join(r.stateDir, "pi", "sessions");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "2026-01-01_custom-workspace.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", id: "custom-workspace", cwd: custom }) + "\n");
    expect((await r.adapter.listExternalSessions()).map(row => row.sessionId)).toEqual(["custom-workspace"]);
    expect(await r.adapter.validateExternalSession("custom-workspace")).toMatchObject({ cwd: custom });
    await r.adapter.getContextUsage("custom-workspace");
    expect(r.spawner.last().spawnArgs.options.cwd).toBe(custom);
    await r.writeConfig({ approvalMode: "bypass", workspacePath: r.workspace });
    await expect(r.adapter.getContextUsage("custom-workspace")).rejects.toThrow(/another workspace/);
    // An explicit conversation binding still wins over the Bot's current default workspace.
    await r.adapter.getContextUsage("custom-workspace", { workspaceOverride: custom });
  });

  it("reports startup failures without leaking native paths", async () => {
    const r = await rig({ pi: { exitAtStart: { code: 1, stderr: "Error: bad flag\n  /synthetic/accounts/someone/pi/docs/cli.md\n" } } });
    const { sessionId } = await r.adapter.createSession(1);
    const error = await failure(r.adapter.sendUserMessage(sessionId, message("hi")));
    expect(error.message).toMatch(/Pi exited during startup: Error: bad flag/);
    expect(error.message).not.toMatch(/someone/);
  });

  it("fails an interrupted turn and starts a fresh process for the next message", async () => {
    let runs = 0;
    const r = await rig({ pi: { onPrompt: run => { if (++runs === 1) run.process.exit(1); else { run.reply("back"); run.finish(); } } } });
    const { sessionId } = await r.adapter.createSession(1);
    const error = await failure(r.adapter.sendUserMessage(sessionId, message("die")));
    expect(error).toBeInstanceOf(EngineIncompleteResponseError);
    expect((error as EngineIncompleteResponseError).reason).toBe("interrupted");
    expect((await r.adapter.sendUserMessage(sessionId, message("again"))).text).toBe("back");
    expect(r.spawner.processes).toHaveLength(2);
  });

  it("asks Pi instead of trusting a cached run flag before keeping an expired idle worker", async () => {
    // A cached isStreaming left at true made the sweep skip the worker before ever asking Pi again.
    const lines: string[] = [];
    const r = await rig({ options: { idleWorkerTtlMs: 0, log: line => { lines.push(line); } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const process = r.spawner.last();
    const worker = (r.adapter as unknown as { workers: Map<string, { state: { isStreaming: boolean } }> }).workers.get(sessionId)!;
    worker.state = { ...worker.state, isStreaming: true };
    await (r.adapter as unknown as { sweepIdleWorkers(): Promise<void> }).sweepIdleWorkers();
    await waitFor(() => process.exitCode === 0);
    expect(lines.some(line => line.includes(sessionId.slice(0, 8)) && /closed/.test(line))).toBe(true);
  });

  it("says once why an expired idle worker is kept, and again only when the reason changes", async () => {
    const lines: string[] = [];
    const r = await rig({ options: { idleWorkerTtlMs: 0, log: line => { lines.push(line); } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const process = r.spawner.last();
    const sweep = () => (r.adapter as unknown as { sweepIdleWorkers(): Promise<void> }).sweepIdleWorkers();
    process.queue.followUp.push("parked");
    await sweep(); await sweep();
    expect(lines.filter(line => /kept/.test(line))).toHaveLength(1);
    expect(lines[0]).toMatch(/pending messages: 1/);
    expect(lines[0]).not.toContain("parked");
    process.queue.followUp.length = 0;
    await sweep();
    await waitFor(() => process.exitCode === 0);
    expect(lines.at(-1)).toMatch(/closed/);
  });

  it("names what keeps an idle worker fresh after its last turn", async () => {
    const lines: string[] = [];
    const r = await rig({ options: { idleWorkerTtlMs: 40, log: line => { lines.push(line); } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const sweep = () => (r.adapter as unknown as { sweepIdleWorkers(): Promise<void> }).sweepIdleWorkers();
    await new Promise(resolve => setTimeout(resolve, 60));
    await r.adapter.getHistoryState(sessionId);
    await sweep();
    expect(lines.at(-1)).toMatch(/kept fresh by a conversation history read; last turn \d+ s ago/);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await r.adapter.getHistoryState(sessionId); await sweep();
    expect(lines.filter(line => /kept fresh/.test(line))).toHaveLength(1);
    expect(r.spawner.last().exitCode).toBeNull();
  });

  it("does not let a state reply read before a run settled overwrite the settle that followed it", async () => {
    // 尼奥's hypothesis, checked here: Pi writes a get_state reply (still streaming) and then agent_settled
    // into one stdout chunk; the reply's await resumes after the event and wrote isStreaming back to true.
    let racing = false;
    const r = await rig({ pi: { onCommand: (command, process) => {
      if (command.type !== "get_state" || !racing) return;
      racing = false;
      const state = { ...process.state, isStreaming: true, messageCount: 0, pendingMessageCount: 0 };
      process.sendRaw(`${JSON.stringify({ id: command.id, type: "response", command: "get_state", success: true, data: state })}\n${JSON.stringify({ type: "agent_settled", aborted: false })}\n`);
      return true;
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    expect(r.adapter.hasPendingNativeWork()).toBe(false);
    racing = true;
    await r.adapter.piNative.getState(sessionId);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(r.adapter.hasPendingNativeWork()).toBe(false);
  });

  it("closes idle workers only after Pi itself reports nothing pending", async () => {
    const r = await rig({ options: { idleWorkerTtlMs: 0 } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const process = r.spawner.last();
    process.queue.followUp.push("parked");
    await (r.adapter as unknown as { sweepIdleWorkers(): Promise<void> }).sweepIdleWorkers();
    expect(process.exitCode).toBeNull();
    process.queue.followUp.length = 0;
    await (r.adapter as unknown as { sweepIdleWorkers(): Promise<void> }).sweepIdleWorkers();
    await waitFor(() => process.exitCode === 0);
    expect(r.adapter.hasPendingNativeWork()).toBe(false);
  });

  it("lists and validates sessions of this workspace", async () => {
    const r = await rig();
    const dir = path.join(r.stateDir, "pi", "sessions"); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "2026-01-01T00-00-00-000Z_listed.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "listed", timestamp: "2026-01-01T00:00:00.000Z", cwd: r.workspace }),
      JSON.stringify({ type: "session_info", id: "a", parentId: null, name: "named session" }), "",
    ].join("\n"));
    expect(await r.adapter.listExternalSessions({ cwd: r.workspace })).toEqual([expect.objectContaining({ sessionId: "listed", title: "named session", cwd: r.workspace })]);
    expect(await r.adapter.validateExternalSession("listed")).toMatchObject({ sessionId: "listed", title: "named session" });
    await expect(r.adapter.validateExternalSession("missing")).rejects.toThrow(/not found/);
    expect(await r.adapter.getContextUsage("listed")).toEqual({ pressureTokens: 266, contextWindow: 32000 });
  });

  it("exposes native controls by capability, not by class", async () => {
    const r = await rig();
    expect(getPiNativeControls(r.adapter)).toBe(r.adapter.piNative);
    expect(getPiNativeControls({} as never)).toBeUndefined();
    expect(getPiNativeControls(undefined)).toBeUndefined();
  });
});

describe("PiRpcAdapter model and thinking scope", () => {
  const setModels = (process: FakePiProcess) => commands(process, "set_model").map(command => `${String(command.provider)}/${String(command.modelId)}`);

  it("applies the Bot default once, keeps a choice made in the conversation, and re-applies only when the Bot default changes", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov2/dup-model", effort: "low" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("one"));
    const process = r.spawner.last();
    expect(setModels(process)).toEqual(["fakeprov2/dup-model"]);
    expect(commands(process, "set_thinking_level").map(command => command.level)).toEqual(["low"]);
    expect((await r.adapter.piNative.getState(sessionId)).modelSource).toBe("bot-default");

    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov", modelId: "plain-model" });
    await r.adapter.sendUserMessage(sessionId, message("two"));
    expect(setModels(process)).toEqual(["fakeprov2/dup-model", "fakeprov/plain-model"]);
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ modelSource: "session", model: { provider: "fakeprov", modelId: "plain-model" }, thinkingLevel: "off" });

    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov/dup-model" });
    await r.adapter.sendUserMessage(sessionId, message("three"));
    expect(setModels(process).at(-1)).toBe("fakeprov/dup-model");
    expect((await r.adapter.piNative.getState(sessionId)).modelSource).toBe("bot-default");
  });

  it("changing only Bot thinking preserves the conversation model, and changing only Bot model preserves its thinking", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov2/dup-model", effort: "low" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("one"));
    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov", modelId: "dup-model" });
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov2/dup-model", effort: "high" });
    await r.adapter.sendUserMessage(sessionId, message("two"));
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ modelSource: "session", model: { provider: "fakeprov", modelId: "dup-model" }, thinkingLevel: "high" });
    await r.adapter.piNative.setThinkingLevel(sessionId, "low");
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" });
    await r.adapter.sendUserMessage(sessionId, message("three"));
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ modelSource: "bot-default", model: { provider: "fakeprov", modelId: "dup-model" }, thinkingLevel: "low" });
    await r.writeConfig({ approvalMode: "bypass", effort: "high" });
    await r.adapter.sendUserMessage(sessionId, message("clear model default"));
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ modelSource: "native", thinkingLevel: "low" });
  });

  it("retains Bot thinking when a model switch applies Pi's own different thinking default", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" }, pi: {
      // Native Pi's set_model consults per-model/defaultThinkingLevel before clamping.
      onCommand: (command, process) => { if (command.type === "set_model") process.state.thinkingLevel = "low"; },
    } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("one"));
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov2/dup-model", effort: "high" });
    await r.adapter.sendUserMessage(sessionId, message("change only model"));
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ model: { provider: "fakeprov2" }, thinkingLevel: "high" });
    await r.writeConfig({ approvalMode: "bypass", effort: "high" });
    await r.adapter.sendUserMessage(sessionId, message("clear only model"));
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ modelSource: "native", thinkingLevel: "high" });
  });

  it("retains a supported conversation thinking choice across Bot model switches and reports native clamping", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" }, pi: {
      onCommand: (command, process) => { if (command.type === "set_model") process.state.thinkingLevel = "low"; },
    } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("one"));
    await r.adapter.piNative.setThinkingLevel(sessionId, "medium");
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov2/dup-model", effort: "high" });
    await r.adapter.sendUserMessage(sessionId, message("change only model"));
    expect((await r.adapter.piNative.getState(sessionId)).thinkingLevel).toBe("medium");
    const notices: PiNativeEvent[] = [];
    r.adapter.piNative.subscribe(sessionId, event => { if (event.type === "notify") notices.push(event); });
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov/plain-model", effort: "high" });
    await r.adapter.sendUserMessage(sessionId, message("model without reasoning"));
    expect((await r.adapter.piNative.getState(sessionId)).thinkingLevel).toBe("off");
    expect(notices).toEqual([expect.objectContaining({ level: "warning", text: expect.stringContaining("medium") })]);
  });

  it("keeps rejecting an unsupported retained Bot thinking default until the owner corrects it", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("one"));
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov/plain-model", effort: "high" });
    await expect(r.adapter.sendUserMessage(sessionId, message("unsupported"))).rejects.toMatchObject({ reason: "thinking-unsupported" });
    const stored = JSON.parse(await readFile(path.join(r.stateDir, "pi", "state.json"), "utf8")).sessions[sessionId];
    expect(stored).toMatchObject({ appliedBotModelDefault: piBotDefaultFingerprint("fakeprov/dup-model", undefined), botDefaultThinking: "high", thinkingBeforeBotDefault: "medium" });
    expect(commands(r.spawner.last(), "set_model")).toHaveLength(0); // Reject before any model mutation.
    expect((await r.adapter.piNative.getState(sessionId)).model).toMatchObject({ provider: "fakeprov", modelId: "dup-model" });
    await expect(r.adapter.sendUserMessage(sessionId, message("still unsupported"))).rejects.toMatchObject({ reason: "thinking-unsupported" });
    expect(commands(r.spawner.last(), "prompt")).toHaveLength(1);
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov/plain-model", effort: "off" });
    await r.adapter.sendUserMessage(sessionId, message("corrected"));
    expect((await r.adapter.piNative.getState(sessionId)).thinkingLevel).toBe("off");
  });

  it("reapplies retained Bot thinking after an uncertain model write already landed in the resumed process", async () => {
    let failRead = false;
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" }, pi: index => index > 0
      ? { model: fakePiModel("fakeprov2", "dup-model"), thinkingLevel: "low" }
      : { onCommand: (command, process) => {
        if (command.type === "set_model" && command.provider === "fakeprov2") {
          process.state.model = process.models.find(model => model.provider === "fakeprov2")!;
          process.state.thinkingLevel = "low"; process.respond(command, process.state.model); failRead = true; return true;
        }
        if (command.type === "get_state" && failRead) { failRead = false; process.fail(command, "State read failed"); return true; }
      } },
    });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("one"));
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov2/dup-model", effort: "high" });
    await expect(r.adapter.sendUserMessage(sessionId, message("uncertain"))).rejects.toBeInstanceOf(PiNativeUncertainError);
    await r.adapter.piNative.setProjectTrust(sessionId, "no"); // Replace the fenced process; its native session already has the new model.
    await r.adapter.sendUserMessage(sessionId, message("recovered"));
    expect(commands(r.spawner.last(), "set_model")).toHaveLength(0);
    expect((await r.adapter.piNative.getState(sessionId)).thinkingLevel).toBe("high");
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov2/dup-model" });
    await r.adapter.sendUserMessage(sessionId, message("clear effort"));
    expect((await r.adapter.piNative.getState(sessionId)).thinkingLevel).toBe("medium");
  });

  it("rejects an incompatible Pi default before clearing the Bot model", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov2/dup-model", effort: "high" }, nativeDefault: { provider: "fakeprov", modelId: "plain-model", thinkingLevel: "off" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("one"));
    await r.writeConfig({ approvalMode: "bypass", effort: "high" });
    await expect(r.adapter.sendUserMessage(sessionId, message("clear model"))).rejects.toMatchObject({ reason: "thinking-unsupported" });
    expect(setModels(r.spawner.last())).toEqual(["fakeprov2/dup-model"]);
    expect((await r.adapter.piNative.getState(sessionId)).thinkingLevel).toBe("high");
    await expect(r.adapter.sendUserMessage(sessionId, message("retry"))).rejects.toMatchObject({ reason: "thinking-unsupported" });
  });

  it("clears a Bot model default without imposing thinking on a conversation-owned model", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("one"));
    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov", modelId: "plain-model" });
    await r.writeConfig({ approvalMode: "bypass", effort: "high" });
    await r.adapter.sendUserMessage(sessionId, message("clear unrelated default"));
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ modelSource: "session", model: { provider: "fakeprov", modelId: "plain-model" }, thinkingLevel: "off" });
    await r.adapter.sendUserMessage(sessionId, message("next turn"));
    expect(setModels(r.spawner.last())).toEqual(["fakeprov/plain-model"]);
  });

  it("migrates unchanged legacy default fingerprints without replaying over conversation choices", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov2/dup-model", effort: "low" } });
    const { sessionId } = await r.adapter.createSession(1);
    const store = new PiSessionStore({ stateDir: r.stateDir, childEnv: {} });
    await store.updateRecord(sessionId, { appliedBotDefault: piBotDefaultFingerprint("fakeprov2/dup-model", "low"), modelSource: "session" });
    await r.adapter.sendUserMessage(sessionId, message("legacy"));
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ modelSource: "session", model: { provider: "fakeprov", modelId: "dup-model" }, thinkingLevel: "medium" });
    // After reading the legacy record, future changes have independent ownership.
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov2/dup-model", effort: "high" });
    await r.adapter.sendUserMessage(sessionId, message("change just thinking"));
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ modelSource: "session", model: { provider: "fakeprov", modelId: "dup-model" }, thinkingLevel: "high" });
  });

  it("returns to Pi's own default when the Bot default is cleared, but leaves a conversation's own choice alone", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov2/dup-model" }, nativeDefault: { provider: "fakeprov", modelId: "plain-model", thinkingLevel: "off" } });
    const first = (await r.adapter.createSession(1)).sessionId, second = (await r.adapter.createSession(2)).sessionId;
    await r.adapter.sendUserMessage(first, message("a"));
    await r.adapter.sendUserMessage(second, message("b"));
    await r.adapter.piNative.setModel(second, { provider: "fakeprov", modelId: "dup-model" });
    await r.writeConfig({ approvalMode: "bypass" });
    await r.adapter.sendUserMessage(first, message("a2"));
    await r.adapter.sendUserMessage(second, message("b2"));
    expect(await r.adapter.piNative.getState(first)).toMatchObject({ modelSource: "native", model: { provider: "fakeprov", modelId: "plain-model" } });
    expect(await r.adapter.piNative.getState(second)).toMatchObject({ modelSource: "session", model: { provider: "fakeprov", modelId: "dup-model" } });
    expect(r.catalogCalls).toBe(1);
  });

  it("keeps the current model and says so when Pi's default is unavailable", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov2/dup-model" }, nativeDefault: null });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("a"));
    const notices: PiNativeEvent[] = [];
    r.adapter.piNative.subscribe(sessionId, event => { if (event.type === "notify") notices.push(event); });
    await r.writeConfig({ approvalMode: "bypass" });
    await r.adapter.sendUserMessage(sessionId, message("b"));
    expect((await r.adapter.piNative.getState(sessionId)).model).toMatchObject({ provider: "fakeprov2", modelId: "dup-model" });
    expect(notices).toEqual([expect.objectContaining({ level: "warning" })]);
  });

  it("applies a ticket override on every turn without disturbing the Bot default bookkeeping", async () => {
    const r = await rig({ config: { approvalMode: "bypass" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("x", { engineOverride: { model: "fakeprov2/dup-model", effort: "high" } }));
    const process = r.spawner.last();
    expect(setModels(process)).toEqual(["fakeprov2/dup-model"]);
    expect(commands(process, "set_thinking_level").at(-1)?.level).toBe("high");
    expect((await r.adapter.piNative.getState(sessionId)).modelSource).toBe("ticket");
    const state = JSON.parse(await readFile(path.join(r.stateDir, "pi", "state.json"), "utf8"));
    expect(state.sessions[sessionId].appliedBotDefault).toBeUndefined();
  });

  it("rejects an unavailable model and an unsupported thinking level instead of letting Pi substitute", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "anthropic/not-signed-in" } });
    const { sessionId } = await r.adapter.createSession(1);
    const unavailable = await failure(r.adapter.sendUserMessage(sessionId, message("x")));
    expect(unavailable.message).toMatch(/Invalid model selection: anthropic\/not-signed-in is not available in Pi/);
    expect(commands(r.spawner.last(), "prompt")).toHaveLength(0);

    await r.writeConfig({ approvalMode: "bypass", model: "not-a-reference" });
    await expect(r.adapter.sendUserMessage(sessionId, message("x"))).rejects.toThrow(/not a Pi provider\/model reference/);

    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov/plain-model", effort: "high" });
    const unsupported = await failure(r.adapter.sendUserMessage(sessionId, message("x")));
    expect(unsupported.message).toMatch(/fakeprov\/plain-model has no "high" effort \(available: off\)/);
    // Pi would have clamped silently and answered success.
    expect(commands(r.spawner.last(), "set_thinking_level")).toHaveLength(0);
    await expect(r.adapter.piNative.setThinkingLevel(sessionId, "max")).rejects.toBeInstanceOf(PiNativeRejectedError);
  });

  it("does not re-send a model the session already runs", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("x"));
    // Every set_model appends a model_change entry to the transcript.
    expect(commands(r.spawner.last(), "set_model")).toHaveLength(0);
    const state = JSON.parse(await readFile(path.join(r.stateDir, "pi", "state.json"), "utf8"));
    expect(state.sessions[sessionId].appliedBotDefault).toBe(piBotDefaultFingerprint("fakeprov/dup-model", undefined));
  });

  it("explains a missing sign-in in host terms", async () => {
    const r = await rig({ pi: { models: [], model: undefined } });
    const { sessionId } = await r.adapter.createSession(1);
    const error = await failure(r.adapter.sendUserMessage(sessionId, message("hi")));
    expect(error.message).toMatch(/Pi has no usable model/);
    expect(error.message).not.toMatch(/synthetic|\/login /);
    expect((await r.adapter.piNative.getState(sessionId)).model).toBeUndefined();
  });
});

describe("PiRpcAdapter approvals and bridge", () => {
  const normal = { approvalMode: "normal" };

  it("refuses to run a gated turn without the bridge, and falls back to in-message instructions in full access", async () => {
    const gated = await rig({ config: normal, bridgeConnects: false });
    const { sessionId } = await gated.adapter.createSession(1);
    await expect(gated.adapter.sendUserMessage(sessionId, message("hi"))).rejects.toThrow(/tool approval is unavailable/);
    expect(commands(gated.spawner.last(), "prompt")).toHaveLength(0);

    const open = await rig({ bridge: false });
    const session = (await open.adapter.createSession(1)).sessionId;
    await open.adapter.sendUserMessage(session, message("hi", { instructions: "stable rule", turnInstructions: "turn rule" }));
    expect(open.spawner.last().args).not.toContain("-e");
    const prompt = String(commands(open.spawner.last(), "prompt")[0]!.message);
    expect(prompt).toContain("<private_bridge_instructions>"); expect(prompt).toContain("stable rule"); expect(prompt).toContain("turn rule");
    expect((await open.adapter.piNative.getState(session)).bridge).toBe("unavailable");
  });

  it("keeps stable instructions out of the transcript when the bridge carries them", async () => {
    let seen: string | undefined;
    const r = await rig({ pi: { onPrompt: async run => { seen = await r.bridge().handler.instructions(); run.reply("ok"); run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi", { instructions: "stable rule", turnInstructions: "turn rule" }));
    const prompt = String(commands(r.spawner.last(), "prompt")[0]!.message);
    expect(seen).toBe("stable rule");
    expect(prompt).not.toContain("stable rule");
    expect(prompt).toContain("<private_bridge_turn_instructions>");
    expect(await r.bridge().handler.instructions()).toBeUndefined();
  });

  async function approvalRig(decide: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision> | EngineApprovalDecision) {
    const asked: EngineApprovalRequest[] = [];
    const outcomes: Array<{ allow: boolean; reason?: string }> = [];
    let calls: Array<{ toolName: string; origin?: "builtin" | "bridge" | "other" }> = [];
    const r = await rig({
      config: normal,
      pi: { onPrompt: async run => {
        for (const [index, call] of calls.entries()) {
          outcomes.push(await r.bridge().handler.approve({ toolName: call.toolName, toolCallId: `call-${index}`, input: { command: "x" }, ...(call.origin ? { origin: call.origin } : {}) } as never, new AbortController().signal));
        }
        run.reply("done"); run.finish();
      } },
    });
    const { sessionId } = await r.adapter.createSession(1);
    const run = async (next: typeof calls, withApprover = true) => {
      calls = next; outcomes.length = 0;
      const input = message("go", withApprover ? { onApprovalRequest: async request => { asked.push(request); return decide(request); } } : {});
      await r.adapter.sendUserMessage(sessionId, input);
      return { outcomes: [...outcomes], events: input.events };
    };
    return { r, sessionId, asked, run };
  }

  it("asks per tool call in normal mode and lets only genuine read-only built-ins through unasked", async () => {
    const t = await approvalRig(() => allow());
    const result = await t.run([
      { toolName: "read", origin: "builtin" }, { toolName: "grep", origin: "builtin" },
      // An extension can register its own tool under a read-only name.
      { toolName: "read", origin: "other" }, { toolName: "read" },
      { toolName: "bash", origin: "builtin" }, { toolName: "mcp__server__tool", origin: "other" },
    ]);
    expect(result.outcomes.every(outcome => outcome.allow)).toBe(true);
    expect(t.asked.map(request => request.toolName)).toEqual(["read", "read", "bash", "mcp__server__tool"]);
    expect(t.asked[2]).toMatchObject({ engine: "pi", sessionId: t.sessionId, approvalScopes: { once: "once", session: "session" }, toolInput: { command: "x" } });
    expect(t.r.bridge().gates).toEqual([true]);
    expect(result.events.filter(event => event.type === "permission_request")).toHaveLength(4);
  });

  it("denies when refused, when nobody can be asked, and when the approver throws", async () => {
    const refused = await approvalRig(() => ({ behavior: "deny" }));
    expect((await refused.run([{ toolName: "bash", origin: "builtin" }])).outcomes).toEqual([{ allow: false, reason: "Denied by the owner" }]);
    expect((await refused.run([{ toolName: "bash", origin: "builtin" }], false)).outcomes).toEqual([{ allow: false, reason: expect.stringMatching(/No one is available/) }]);
    const throwing = await approvalRig(() => { throw new Error("card failed"); });
    expect((await throwing.run([{ toolName: "edit", origin: "builtin" }])).outcomes[0]!.allow).toBe(false);
  });

  it("remembers a session grant for that tool from that source only", async () => {
    const t = await approvalRig(() => allow("session"));
    await t.run([{ toolName: "bash", origin: "builtin" }]);
    await t.run([{ toolName: "bash", origin: "builtin" }, { toolName: "bash", origin: "other" }, { toolName: "write", origin: "builtin" }]);
    expect(t.asked.map(request => request.toolName)).toEqual(["bash", "bash", "write"]);
  });

  it("does not gate anything in full access", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    // The extension starts gated, so full access has to be said out loud once.
    expect(r.bridge().gates).toEqual([false]);
    await r.adapter.sendUserMessage(sessionId, message("again"));
    expect(r.bridge().gates).toEqual([false]);
    expect(await r.bridge().handler.approve({ toolName: "bash", toolCallId: "c", origin: "builtin", input: {} }, new AbortController().signal)).toEqual({ allow: true });
  });

  it("routes App tools to the active turn only and switches to their instructions", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools: AppPlatformTools = {
      definitions: [{ name: "app_send_file", description: "Send a file", inputSchema: { type: "object" } }],
      instructions: "app tool rules", turnInstructions: "app turn rules",
      isRegistered: async () => true, register: async () => {},
      call: async call => { calls.push(call as unknown as Record<string, unknown>); return { text: "delivered" }; },
    };
    let during: unknown, instructions: string | undefined, unknown: unknown;
    const r = await rig({ pi: { onPrompt: async run => {
      instructions = await r.bridge().handler.instructions();
      during = await r.bridge().handler.callTool({ name: "app_send_file", callId: "c1", arguments: { path: "x" } }, new AbortController().signal);
      unknown = await r.bridge().handler.callTool({ name: "app_other", callId: "c2", arguments: {} }, new AbortController().signal);
      run.reply("ok"); run.finish();
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("send", { appPlatformTools: tools, instructions: "generic rules" }));
    expect(r.bridge().installed).toEqual([tools.definitions]);
    expect(instructions).toBe("app tool rules");
    expect(String(commands(r.spawner.last(), "prompt")[0]!.message)).toContain("app turn rules");
    expect(during).toEqual({ text: "delivered" });
    expect(calls[0]).toMatchObject({ name: "app_send_file", callId: "c1", sessionId, arguments: { path: "x" } });
    expect(unknown).toMatchObject({ isError: true });
    expect(await r.bridge().handler.callTool({ name: "app_send_file", callId: "c3", arguments: {} }, new AbortController().signal)).toMatchObject({ isError: true });
    expect(calls).toHaveLength(1);
  });

  it("says so and keeps compatible delivery when App tools cannot be installed", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("warm up"));
    r.bridge().skipInstall = true;
    const input = message("send", { instructions: "generic rules", appPlatformTools: { definitions: [{ name: "app_send_file", description: "d", inputSchema: {} }], instructions: "app tool rules", isRegistered: async () => true, register: async () => {}, call: async () => ({ text: "x" }) } });
    await r.adapter.sendUserMessage(sessionId, input);
    expect(input.events.some(event => event.type === "assistant_text" && /compatible delivery/.test(event.text))).toBe(true);
    expect(await r.bridge().handler.instructions()).toBeUndefined();
  });

  it("asks once about project-local Pi files, remembers the answer, and restarts only for yes", async () => {
    const r = await rig({ config: normal });
    await mkdir(path.join(r.workspace, ".pi", "extensions"), { recursive: true });
    const { sessionId } = await r.adapter.createSession(1);
    const startUntrusted = async () => { await waitFor(() => r.bridges.length > 0 && r.spawner.processes.length === r.bridges.length); r.bridge().handler.onEvent({ type: "session_start", reason: "startup", trusted: false }); };
    const questions: string[] = [];
    const answer = (label: RegExp) => async (request: EngineApprovalRequest): Promise<EngineApprovalDecision> => {
      const question = (request.toolInput as { questions: Array<{ question: string; options: Array<{ label: string }> }> }).questions[0]!;
      questions.push(question.question);
      return { behavior: "allow", updatedInput: { answers: { [question.question]: question.options.find(option => label.test(option.label))!.label } } };
    };
    expect(await (async () => { const pending = r.adapter.sendUserMessage(sessionId, message("warm", { onApprovalRequest: answer(/Do not/) })); return (await pending).text; })()).toBe("ok");
    // The first turn could not know yet: the bridge reports trust after startup.
    await startUntrusted();
    await r.adapter.sendUserMessage(sessionId, message("ask", { onApprovalRequest: answer(/Trust/) }));
    // Asked once, and the card text itself carries the warning about what loading means.
    expect(questions).toEqual([expect.stringMatching(/^Load this project's own Pi files\?\n\n[\s\S]*run code on your computer\.$/)]);
    expect(r.spawner.processes).toHaveLength(2);
    expect(await r.bridge().handler.trust({ cwd: r.workspace })).toBe("yes");
    r.bridge().handler.onEvent({ type: "session_start", reason: "startup", trusted: false });
    await r.adapter.sendUserMessage(sessionId, message("again", { onApprovalRequest: answer(/Trust/) }));
    expect(questions).toHaveLength(1);
    expect(r.spawner.processes).toHaveLength(2);
  });
});

describe("PiRpcAdapter turns", () => {
  it("maps tools, thinking and a nested call, and reports the final answer", async () => {
    const r = await rig({ pi: { onPrompt: run => {
      run.emit({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
      run.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } } });
      run.tool({ id: "t1", name: "bash", args: { command: "ls" }, output: "a\n" });
      run.tool({ id: "t1/1", name: "read", args: { path: "a" }, parentToolCallId: "t1" });
      run.reply("final answer", { thinking: "hmm" }); run.finish();
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const progress: string[] = [];
    const input = message("go", { onProgress: partial => { progress.push(partial); } });
    const response = await r.adapter.sendUserMessage(sessionId, input);
    expect(response.text).toBe("final answer");
    expect(response.usage).toMatchObject({ inputTokens: 90, outputTokens: 25 });
    expect(kinds(input.events)).toEqual(["session", "tool_use", "tool_result", "tool_progress", "thinking", "assistant_text", "assistant_text", "result"]);
    expect(input.events[1]).toMatchObject({ toolName: "bash", toolUseId: "t1", toolInput: { command: "ls" } });
    expect(input.events[2]).toMatchObject({ toolUseId: "t1", output: "a\n", isError: false, exitCode: 0, durationMs: 5 });
    expect(input.events[3]).toMatchObject({ toolUseId: "t1" });
    expect(progress.at(-1)).toBe("final answer");
  });

  it("carries the usage already billed in a turn whose process dies, and in a stopped turn", async () => {
    const r = await rig({ pi: { onPrompt: run => { run.reply("", { stopReason: "toolUse" }); run.tool({ id: "t1", name: "bash", args: { command: "sleep 70" } }); queueMicrotask(() => run.process.exit(null, "SIGKILL")); } } });
    const { sessionId } = await r.adapter.createSession(1);
    const died = await failure(r.adapter.sendUserMessage(sessionId, message("x")));
    expect(died).toBeInstanceOf(EngineIncompleteResponseError);
    expect(failedTurnUsage(died)).toEqual({ inputTokens: 80, outputTokens: 20, cachedTokens: 40, costUsd: 0.001 });

    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const s = await rig({ pi: { onPrompt: run => { run.reply("", { stopReason: "toolUse" }); started(); } } });
    const stop = new AbortController();
    const turn = failure(s.adapter.sendUserMessage((await s.adapter.createSession(1)).sessionId, message("y", { abortSignal: stop.signal })));
    await running; stop.abort();
    expect(failedTurnUsage(await turn)).toMatchObject({ inputTokens: 80, outputTokens: 20 });
  });

  it("surfaces a provider failure as the turn's error, not as an answer", async () => {
    const r = await rig({ pi: { onPrompt: run => { run.reply("", { stopReason: "error", errorMessage: "401: {\"message\":\"invalid api key\"}" }); run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    await expect(r.adapter.sendUserMessage(sessionId, message("x"))).rejects.toThrow(/401: \{"message":"invalid api key"\}/);
  });

  it("steers only a live run", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ pi: { onPrompt: async run => { await gate; run.reply("steered"); run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "x" })).toBe(false);
    await expect(r.adapter.steerActiveTurn(sessionId, { text: "x", throwOnError: true })).rejects.toBeInstanceOf(EngineSteeringRejectedError);
    const turn = r.adapter.sendUserMessage(sessionId, message("long"));
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    expect(r.adapter.supportsSessionSteering(sessionId)).toBe(true);
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "change course" })).toBe(true);
    expect(commands(r.spawner.last(), "steer").map(command => command.message)).toEqual(["change course"]);
    expect(r.adapter.hasPendingNativeWork()).toBe(true);
    release(); await turn;
    // Idle Pi would only park the message in its queue.
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "late" })).toBe(false);
    expect(commands(r.spawner.last(), "steer")).toHaveLength(1);
  });

  it("stops like the native Esc: queue first, then abort", async () => {
    const r = await rig({ pi: { onPrompt: run => { if (run.command.message !== "long") { run.reply("ok"); run.finish(); } /* "long" never finishes on its own */ } } });
    const { sessionId } = await r.adapter.createSession(1);
    const controller = new AbortController();
    const turn = r.adapter.sendUserMessage(sessionId, message("long", { abortSignal: controller.signal }));
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    const order = commands(r.spawner.last()).map(command => command.type).filter(type => type === "clear_queue" || type === "abort");
    // Queue first, then abort; once the run has settled the queue is cleared again for input that arrived late.
    expect(order).toEqual(["clear_queue", "abort", "clear_queue"]);
    expect(r.spawner.last().exitCode).toBeNull();
    expect((await r.adapter.sendUserMessage(sessionId, message("after"))).sessionId).toBe(sessionId);
  });

  it("ends the process when Pi does not settle after a stop", async () => {
    const r = await rig({ pi: { onPrompt: () => {}, onCommand: (command, process) => { if (command.type === "abort") { process.respond(command); return true; } return false; } } });
    const { sessionId } = await r.adapter.createSession(1);
    const controller = new AbortController();
    const turn = r.adapter.sendUserMessage(sessionId, message("stuck", { abortSignal: controller.signal }));
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => r.spawner.last().signalCode === "SIGKILL");
  });

  it("times out a silent turn but not one waiting for the owner", async () => {
    const silent = await rig({ pi: { onPrompt: () => {} }, options: { inactivityTimeoutMs: 40 } });
    const first = (await silent.adapter.createSession(1)).sessionId;
    await expect(silent.adapter.sendUserMessage(first, message("x"))).rejects.toThrow(/became inactive after/);

    let answer!: (decision: EngineApprovalDecision) => void;
    const waiting = await rig({ options: { inactivityTimeoutMs: 40 }, pi: { onPrompt: run => { run.process.ui({ id: "d1", method: "confirm", title: "Proceed?", message: "" }); run.process.once("ui-response", () => { run.reply("after dialog"); run.finish(); }); } } });
    const second = (await waiting.adapter.createSession(1)).sessionId;
    const turn = waiting.adapter.sendUserMessage(second, message("x", { onApprovalRequest: () => new Promise<EngineApprovalDecision>(resolve => { answer = resolve; }) }));
    await waitFor(() => Boolean(answer));
    await new Promise(resolve => setTimeout(resolve, 120));
    answer({ behavior: "allow", updatedInput: { answers: { "Proceed?": "Yes" } } });
    expect((await turn).text).toBe("after dialog");
    expect(waiting.spawner.last().uiResponses).toEqual([{ type: "extension_ui_response", id: "d1", confirmed: true }]);
  });

  it("maps every extension dialog to the question form and back", async () => {
    const requests: EngineApprovalRequest[] = [];
    const r = await rig({ pi: { onPrompt: run => {
      const process = run.process;
      process.ui({ id: "s", method: "select", title: "Pick", options: ["A", "B"] });
      process.ui({ id: "c", method: "confirm", title: "Sure?", message: "detail" });
      process.ui({ id: "i", method: "input", title: "Name", placeholder: "type" });
      process.ui({ id: "e", method: "editor", title: "Edit", prefill: "old" });
      process.ui({ id: "n", method: "notify", message: "heads up", notifyType: "warning" });
      const done = () => { if (process.uiResponses.length === 4) { run.reply("ok"); run.finish(); } };
      process.on("ui-response", done);
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const native: PiNativeEvent[] = [];
    r.adapter.piNative.subscribe(sessionId, event => { native.push(event); });
    const answers: Record<string, string> = { Pick: "B", "Sure?\n\ndetail": "No", Name: "typed", Edit: "" };
    await r.adapter.sendUserMessage(sessionId, message("go", { onApprovalRequest: async request => {
      requests.push(request);
      const question = (request.toolInput as { questions: Array<{ question: string }> }).questions[0]!;
      return { behavior: "allow", updatedInput: { answers: { [question.question]: answers[question.question] } } };
    } }));
    expect(requests.every(request => request.toolName === "AskUserQuestion" && request.engine === "pi")).toBe(true);
    const forms = requests.map(request => (request.toolInput as { questions: unknown[] }).questions[0]);
    // A choice must say it takes no free text: the shared card shows a text box by default, and typing there would cancel the dialog.
    expect(forms[0]).toMatchObject({ question: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false, allowFreeText: false });
    expect(forms[1]).toMatchObject({ question: "Sure?\n\ndetail", options: [{ label: "Yes" }, { label: "No" }], allowFreeText: false });
    expect(forms[2]).toMatchObject({ question: "Name", options: [], allowFreeText: true, required: false, input: { kind: "text", placeholder: "type" } });
    expect(forms[3]).toMatchObject({ question: "Edit", options: [], allowFreeText: true, required: false, input: { kind: "multiline", prefill: "old" } });
    expect(r.spawner.last().uiResponses.sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([
      { type: "extension_ui_response", id: "c", confirmed: false },
      { type: "extension_ui_response", id: "e", value: "" },
      { type: "extension_ui_response", id: "i", value: "typed" },
      { type: "extension_ui_response", id: "s", value: "B" },
    ]);
    expect(native).toContainEqual({ type: "notify", level: "warning", text: "heads up" });
  });

  it("cancels a dialog nobody can answer, a timed dialog at its deadline, and open dialogs at a stop", async () => {
    const unattended = await rig({ pi: { onPrompt: run => { run.process.ui({ id: "x", method: "select", title: "Pick", options: ["A"] }); run.process.once("ui-response", () => { run.reply("ok"); run.finish(); }); } } });
    const first = (await unattended.adapter.createSession(1)).sessionId;
    await unattended.adapter.sendUserMessage(first, message("go"));
    expect(unattended.spawner.last().uiResponses).toEqual([{ type: "extension_ui_response", id: "x", cancelled: true }]);

    let signal: AbortSignal | undefined;
    const timed = await rig({ pi: { onPrompt: run => { run.process.ui({ id: "t", method: "confirm", title: "Quick?", message: "", timeout: 30 }); run.process.once("ui-response", () => { run.reply("ok"); run.finish(); }); } } });
    const second = (await timed.adapter.createSession(1)).sessionId;
    await timed.adapter.sendUserMessage(second, message("go", { onApprovalRequest: request => new Promise<EngineApprovalDecision>(resolve => { signal = request.abortSignal; request.abortSignal!.addEventListener("abort", () => resolve({ behavior: "deny" })); }) }));
    expect(signal?.aborted).toBe(true);
    expect(timed.spawner.last().uiResponses).toEqual([{ type: "extension_ui_response", id: "t", cancelled: true }]);

    const stopped = await rig({ pi: { onPrompt: run => { run.process.ui({ id: "o", method: "input", title: "Wait" }); } } });
    const third = (await stopped.adapter.createSession(1)).sessionId;
    const controller = new AbortController();
    const turn = stopped.adapter.sendUserMessage(third, message("go", { abortSignal: controller.signal, onApprovalRequest: () => new Promise<EngineApprovalDecision>(() => {}) }));
    await waitFor(() => stopped.spawner.processes[0]?.received.some(command => command.type === "prompt") === true);
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(stopped.spawner.last().uiResponses).toContainEqual({ type: "extension_ui_response", id: "o", cancelled: true });
  });

  it("returns what an extension command said when it starts no run", async () => {
    const r = await rig({ pi: { commands: [{ name: "mcp", source: "extension" }], onCommand: (command, process) => {
      if (command.type !== "prompt" || command.message !== "/mcp") return false;
      process.ui({ id: "n1", method: "notify", message: "2 servers connected" });
      process.respond(command, { disposition: "handled" });
      return true;
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const response = await r.adapter.sendUserMessage(sessionId, message("/mcp", { turnInstructions: "turn rule" }));
    expect(response.text).toBe("Pi extension notices are available in this turn's run details.");
    // A session command must keep its leading slash.
    expect(commands(r.spawner.last(), "prompt")[0]!.message).toBe("/mcp");
  });

  it("does not turn extension-only notices into final delivery directives", async () => {
    const detail = "External notice [send-file:/synthetic/private.txt]";
    const r = await rig({ pi: { commands: [{ name: "notice", source: "extension" }], onCommand: (command, process) => {
      if (command.type !== "prompt" || command.message !== "/notice") return false;
      process.ui({ id: "n", method: "notify", message: detail });
      process.respond(command, { disposition: "handled" }); return true;
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("/notice");
    const response = await r.adapter.sendUserMessage(sessionId, input);
    expect(response.text).toBe("Pi extension notices are available in this turn's run details.");
    expect(response.text).not.toContain("send-file");
    expect(input.events.some(event => event.type === "assistant_text" && event.text.includes("External notice"))).toBe(true);
  });

  it("keeps a confirmed model write followed by a failed read uncertain, including when clearing a default", async () => {
    let failState = false;
    const r = await rig({ config: { approvalMode: "bypass" }, pi: { onCommand: (command, process) => {
      if (command.type === "get_state" && failState) { process.fail(command, "Model not found: fakeprov2/dup-model"); return true; }
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("start"));
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov2/dup-model" });
    failState = true;
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    await expect(live.setModel(null, { isCurrent: async () => true })).rejects.toBeInstanceOf(PiNativeUncertainError);
    expect(r.spawner.last().state.model).toMatchObject({ provider: "fakeprov2" });
    await expect(live.setModel({ provider: "fakeprov", modelId: "dup-model" }, { isCurrent: async () => true })).rejects.toBeInstanceOf(PiNativeUncertainError);
  });

  it("withholds images from a text-only model and says why", async () => {
    const r = await rig({ pi: { model: fakePiModel("fakeprov", "plain-model", { reasoning: false, input: ["text"] }) } });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const file = path.join(r.root, "pixel.png"); await writeFile(file, png);
    const { sessionId } = await r.adapter.createSession(1);
    const notes: PiNativeEvent[] = [];
    r.adapter.piNative.subscribe(sessionId, event => { if (event.type === "notify") notes.push(event); });
    await r.adapter.sendUserMessage(sessionId, message("look", { files: [file] }));
    const prompt = commands(r.spawner.last(), "prompt")[0]!;
    expect(prompt.images).toBeUndefined();
    expect(String(prompt.message)).toContain(`Attachment: ${file}`);
    expect(notes).toHaveLength(1);

    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov", modelId: "dup-model" });
    await r.adapter.sendUserMessage(sessionId, message("look again", { files: [file] }));
    expect(commands(r.spawner.last(), "prompt")[1]!.images).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  });

  it("sends a BMP for Pi to convert and says which images went by path only", async () => {
    const r = await rig();
    const bmp = Buffer.alloc(70);
    bmp.write("BM", 0, "latin1"); bmp.writeUInt32LE(70, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(2, 18); bmp.writeInt32LE(2, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
    const scan = path.join(r.root, "scan.bmp"); await writeFile(scan, bmp);
    // Over the per-message budget by size alone, so it is never read: a sparse file is enough.
    const huge = path.join(r.root, "huge.png");
    await writeFile(huge, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ", "base64"));
    await truncate(huge, 65 * 1024 * 1024);
    const { sessionId } = await r.adapter.createSession(1);
    const notes: PiNativeEvent[] = [];
    r.adapter.piNative.subscribe(sessionId, event => { if (event.type === "notify") notes.push(event); });
    const turn = message("look", { files: [scan, huge], locale: "zh" });
    await r.adapter.sendUserMessage(sessionId, turn);
    const prompt = commands(r.spawner.last(), "prompt")[0]!;
    expect(prompt.images).toEqual([{ type: "image", data: bmp.toString("base64"), mimeType: "image/bmp" }]);
    expect(String(prompt.message)).toContain(`Attachment: ${huge}`);
    expect(notes).toEqual([{ type: "notify", level: "warning", text: "以下图片没有直接发给模型，只以文件路径提供：huge.png（单张超过 64 MiB）。" }]);
    expect(turn.events.some(event => event.type === "assistant_text" && event.text === "[Pi] 以下图片没有直接发给模型，只以文件路径提供：huge.png（单张超过 64 MiB）。")).toBe(true);

    expect(await r.adapter.piNative.followUp(sessionId, { text: "later", files: [huge] })).toBe("queued");
    expect(commands(r.spawner.last(), "follow_up").at(-1)!.images).toBeUndefined();
    expect(notes.at(-1)).toEqual({ type: "notify", level: "warning", text: "Sent as file paths only, not as images: huge.png (over 64 MiB)." });
  });
});

describe("PiRpcAdapter native commands and controls", () => {
  it("answers terminal built-ins itself and forwards session commands to Pi", async () => {
    const r = await rig({ pi: { commands: [{ name: "skill:review", source: "skill" }] } });
    const { sessionId } = await r.adapter.createSession(1);
    const model = await r.adapter.sendUserMessage(sessionId, message("/model fakeprov/plain-model"));
    expect(model.text).toMatch(/plain-model/);
    const login = await r.adapter.sendUserMessage(sessionId, message("/login"));
    expect(login.text).toMatch(/pi auth login/);
    const process = r.spawner.last();
    expect(commands(process, "prompt")).toHaveLength(0);
    expect(commands(process, "set_model")).toHaveLength(1);
    await r.adapter.sendUserMessage(sessionId, message("/skill:review src"));
    expect(commands(process, "prompt").map(command => command.message)).toEqual(["/skill:review src"]);
  });

  it("asks before a user shell command in normal mode and runs it directly in full access", async () => {
    const gated = await rig({ config: { approvalMode: "normal" } });
    const first = (await gated.adapter.createSession(1)).sessionId;
    const asked: string[] = [];
    const reply = await gated.adapter.sendUserMessage(first, message("!ls -la", { onApprovalRequest: async request => { asked.push(request.toolName); return allow(); } }));
    expect(asked).toEqual(["bash"]);
    expect(commands(gated.spawner.last(), "bash").map(command => command.command)).toEqual(["ls -la"]);
    expect(reply.text).toContain("out");
    await gated.adapter.sendUserMessage(first, message("!rm x"));
    expect(commands(gated.spawner.last(), "bash")).toHaveLength(1);

    const open = await rig();
    const second = (await open.adapter.createSession(1)).sessionId;
    await open.adapter.sendUserMessage(second, message("!!pwd"));
    expect(commands(open.spawner.last(), "bash")[0]).toMatchObject({ command: "pwd", excludeFromContext: true });
  });

  it("re-keys the live process when a fork replaces the session and carries the applied default along", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov2/dup-model" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("first"));
    const process = r.spawner.last();
    const events: PiNativeEvent[] = [];
    r.adapter.piNative.subscribe(sessionId, event => { events.push(event); });
    const entryId = (await r.adapter.piNative.listForkPoints(sessionId))[0]!.entryId;
    const forked = await r.adapter.piNative.fork(sessionId, { entryId });
    expect(forked).toMatchObject({ cancelled: false, text: "first" });
    expect(forked.sessionId).not.toBe(sessionId);
    expect(events).toContainEqual({ type: "session_replaced", previousSessionId: sessionId, sessionId: forked.sessionId, reason: "fork" });
    const response = await r.adapter.sendUserMessage(forked.sessionId, message("on the fork"));
    expect(response.sessionId).toBe(forked.sessionId);
    expect(r.spawner.processes).toHaveLength(1);
    // The fork inherits the applied Bot default, so the model is not forced again.
    expect(commands(process, "set_model")).toHaveLength(1);
    await r.adapter.sendUserMessage(sessionId, message("original again"));
    expect(r.spawner.processes).toHaveLength(2);

    const cloned = await r.adapter.piNative.clone(forked.sessionId);
    const fresh = await r.adapter.piNative.newSession(cloned.sessionId);
    expect(new Set([sessionId, forked.sessionId, cloned.sessionId, fresh.sessionId]).size).toBe(4);
    await expect(r.adapter.piNative.fork(fresh.sessionId, { entryId: "missing" })).rejects.toThrow(/Invalid entry ID/);
  });

  it("reports the replaced session id through a typed /fork", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("first"));
    const input = message("/fork 1");
    const response = await r.adapter.sendUserMessage(sessionId, input);
    expect(response.sessionId).not.toBe(sessionId);
    expect(input.events.filter(event => event.type === "session").map(event => event.sessionId)).toEqual([sessionId, response.sessionId]);
  });

  it("navigates the tree in place through the bridge and hands back the user text", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("first question"));
    const tree = await r.adapter.piNative.getTree(sessionId);
    const user = tree.nodes.find(node => node.role === "user")!;
    expect(user).toMatchObject({ preview: "first question", type: "message" });
    const result = await r.adapter.piNative.navigateTree(sessionId, { targetId: user.id, summarize: true, label: "here" });
    expect(result).toMatchObject({ cancelled: false, editorText: "first question" });
    expect(r.bridge().controls).toEqual([{ op: "navigate", targetId: user.id, summarize: true, label: "here" }]);
    expect(commands(r.spawner.last(), "prompt").at(-1)!.message).toMatch(/^\/tarobird-bridge /);
    await expect(r.adapter.piNative.navigateTree(sessionId, { targetId: "not-an-entry" })).rejects.toBeInstanceOf(PiNativeRejectedError);
    await r.adapter.piNative.reload(sessionId);
    await r.adapter.piNative.setLabel(sessionId, { entryId: user.id, label: null });
    expect(r.bridge().controls.at(-1)).toEqual({ op: "reload" });
    expect(r.bridge().labels).toEqual([{ entryId: user.id, label: null }]);
  });

  it("refuses bridge-only and idle-only controls honestly", async () => {
    const bare = await rig({ bridge: false });
    const first = (await bare.adapter.createSession(1)).sessionId;
    await bare.adapter.sendUserMessage(first, message("x"));
    await expect(bare.adapter.piNative.reload(first)).rejects.toBeInstanceOf(PiNativeBridgeUnavailableError);
    await expect(bare.adapter.piNative.listTools(first)).rejects.toBeInstanceOf(PiNativeBridgeUnavailableError);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const busy = await rig({ pi: { onPrompt: async run => { await gate; run.reply("ok"); run.finish(); } } });
    const second = (await busy.adapter.createSession(1)).sessionId;
    const turn = busy.adapter.sendUserMessage(second, message("long"));
    await waitFor(() => Boolean(busy.spawner.processes[0]?.activeRun));
    await expect(busy.adapter.piNative.clone(second)).rejects.toBeInstanceOf(PiNativeBusyError);
    await expect(busy.adapter.piNative.compact(second)).rejects.toBeInstanceOf(PiNativeBusyError);
    // Switching the model mid-run is native: it applies from the next model call.
    await expect(busy.adapter.piNative.setModel(second, { provider: "fakeprov2", modelId: "dup-model" })).resolves.toMatchObject({ model: { provider: "fakeprov2" } });
    expect(await busy.adapter.piNative.followUp(second, { text: "afterwards" })).toBe("queued");
    expect((await busy.adapter.piNative.getState(second)).pending.followUp).toEqual(["afterwards"]);
    expect(await busy.adapter.piNative.clearQueue(second)).toEqual({ steering: [], followUp: ["afterwards"] });
    release(); await turn;
  });

  it("lists session commands without the bridge's own, and passes global settings through", async () => {
    const r = await rig({ pi: { commands: [{ name: "tarobird-bridge", source: "extension" }, { name: "mcp", description: "Manage MCP", source: "extension" }, { name: "fix", source: "prompt" }, { name: "skill:x", source: "skill" }] } });
    const { sessionId } = await r.adapter.createSession(1);
    expect((await r.adapter.piNative.listCommands(sessionId)).map(command => `${command.source}:${command.name}`)).toEqual(["extension:mcp", "prompt:fix", "skill:skill:x"]);
    await r.adapter.piNative.setNativeGlobalSetting(sessionId, { key: "autoRetry", value: false });
    await r.adapter.piNative.setNativeGlobalSetting(sessionId, { key: "steeringMode", value: "all" });
    expect(commands(r.spawner.last(), "set_auto_retry")[0]).toMatchObject({ enabled: false });
    expect((await r.adapter.piNative.getState(sessionId)).steeringMode).toBe("all");
    await expect(r.adapter.piNative.setSessionName(sessionId, "  ")).rejects.toBeInstanceOf(PiNativeRejectedError);
    expect(await r.adapter.piNative.getStats(sessionId)).toMatchObject({ costUsd: 0.001, context: { contextWindow: 32000 } });
    expect((await readdir(path.join(r.stateDir, "pi"))).sort()).toContain("sessions");
  });
});

describe("PiRpcAdapter lifecycle regressions", () => {
  const normal = { approvalMode: "normal" };
  const trustAnswer = (label: RegExp, seen: string[] = []) => async (request: EngineApprovalRequest): Promise<EngineApprovalDecision> => {
    const question = (request.toolInput as { questions: Array<{ question: string; options: Array<{ label: string }> }> }).questions[0]!;
    seen.push(question.question);
    return { behavior: "allow", updatedInput: { answers: { [question.question]: question.options.find(option => label.test(option.label))!.label } } };
  };

  it("keeps the trust report Pi sends while starting, and approves nothing before the session exists", async () => {
    const r = await rig({ config: normal, startupEvents: [{ type: "session_start", reason: "startup", trusted: false }] });
    await mkdir(path.join(r.workspace, ".pi", "prompts"), { recursive: true });
    const { sessionId } = await r.adapter.createSession(1);
    const seen: string[] = [];
    await r.adapter.sendUserMessage(sessionId, message("first", { onApprovalRequest: trustAnswer(/Do not/, seen) }));
    // Pi reports session_start before it reads its first command; losing it would skip the question forever.
    expect(seen).toEqual([expect.stringMatching(/^Load this project's own Pi files\?\n\n[\s\S]*run code on your computer\.$/)]);
    expect(r.startupApprovals).toEqual([{ allow: false, reason: expect.stringMatching(/still starting/) }]);
    expect(r.spawner.processes).toHaveLength(1);
  });

  it("stops the process that replaced the first one after a trust restart", async () => {
    const r = await rig({ config: normal, startupEvents: [{ type: "session_start", reason: "startup", trusted: false }], pi: { onPrompt: () => { /* runs until stopped */ } } });
    await mkdir(path.join(r.workspace, ".pi", "extensions"), { recursive: true });
    const { sessionId } = await r.adapter.createSession(1);
    const controller = new AbortController();
    const turn = r.adapter.sendUserMessage(sessionId, message("go", { abortSignal: controller.signal, onApprovalRequest: trustAnswer(/Trust/) }));
    await waitFor(() => r.spawner.processes.length === 2 && Boolean(r.spawner.processes[1]!.activeRun));
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    const second = r.spawner.processes[1]!;
    expect(commands(second).map(command => command.type).filter(type => type === "clear_queue" || type === "abort")).toEqual(["clear_queue", "abort", "clear_queue"]);
    expect(second.activeRun).toBeUndefined();
    expect(commands(r.spawner.processes[0]!, "abort")).toHaveLength(0);
  });

  it("does not leave a process behind when it is destroyed during startup", async () => {
    let answer!: () => void;
    const r = await rig({ pi: { onCommand: (command, process) => {
      if (command.type !== "get_state" || process.received.filter(item => item.type === "get_state").length > 1) return false;
      answer = () => process.respond(command, { ...process.state, messageCount: 0, pendingMessageCount: 0 });
      return true;
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const turn = failure(r.adapter.sendUserMessage(sessionId, message("hi")));
    await waitFor(() => Boolean(answer));
    const destroying = r.adapter.destroy();
    answer();
    await destroying;
    expect((await turn).message).toMatch(/destroyed/);
    await waitFor(() => r.spawner.last().exitCode !== null || r.spawner.last().signalCode !== null);
    expect(r.adapter.hasPendingNativeWork()).toBe(false);
  });

  // A stop can arrive after `sendUserMessage` was called and before its turn exists: while the Bot
  // configuration is read, while a start another caller began is awaited, or while the search server is
  // registered. An abort listener attached afterwards is never called, so such a turn must not begin.
  describe("a message stopped before its turn exists", () => {
    const plan: NativeSearchMcpPlan = { name: MANAGED_SEARCH_MCP_NAME, command: "/synthetic/node", args: ["/synthetic/search-mcp.js"], envKeys: [], processEnv: {} };
    const sentToPi = (r: Rig) => r.spawner.processes.flatMap(process => commands(process).map(command => command.type))
      .filter(type => type === "prompt" || type === "abort" || type === "clear_queue");

    it("sends nothing to a live process when the stop comes in the same tick as the message", async () => {
      const r = await rig();
      const { sessionId } = await r.adapter.createSession(1);
      await r.adapter.sendUserMessage(sessionId, message("warm", { workspaceOverride: r.workspace }));
      // Without an override the workspace is read from the Bot configuration first, which takes a file read.
      for (const extra of [{ workspaceOverride: r.workspace }, {}]) {
        const controller = new AbortController();
        const turn = r.adapter.sendUserMessage(sessionId, message("stopped", { abortSignal: controller.signal, ...extra }));
        controller.abort();
        await expect(turn).rejects.toMatchObject({ name: "AbortError" });
      }
      expect(sentToPi(r)).toEqual(["prompt"]);
      // The process was left alone and has no turn: the next message runs on it.
      expect((await r.adapter.sendUserMessage(sessionId, message("next"))).text).toBe("ok");
      expect(r.spawner.processes).toHaveLength(1);
    });

    it("sends nothing when the stop comes while the search server is being registered, and keeps the process", async () => {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const r = await rig({ options: { nativeSearchMcp: () => plan }, searchRegistration: () => held });
      const { sessionId } = await r.adapter.createSession(1);
      const controller = new AbortController();
      const turn = r.adapter.sendUserMessage(sessionId, message("stopped", { abortSignal: controller.signal }));
      await waitFor(() => r.bridges.length === 1 && r.bridge().mcpServers.length === 1);
      controller.abort();
      release();
      await expect(turn).rejects.toMatchObject({ name: "AbortError" });
      expect(sentToPi(r)).toEqual([]);
      expect((await r.adapter.sendUserMessage(sessionId, message("next"))).text).toBe("ok");
      expect(r.spawner.processes).toHaveLength(1);
    });

    it("sends nothing for a stopped message that joined another caller's start, and does not end that process", async () => {
      let answer: (() => void) | undefined;
      const r = await rig({ pi: { onCommand: (command, process) => {
        if (command.type !== "get_state" || process.received.filter(item => item.type === "get_state").length > 1) return false;
        answer = () => process.respond(command, { ...process.state, messageCount: 0, pendingMessageCount: 0 });
        return true;
      } } });
      const { sessionId } = await r.adapter.createSession(1);
      const usage = r.adapter.getContextUsage(sessionId, { workspaceOverride: r.workspace });
      await waitFor(() => Boolean(answer));
      const controller = new AbortController();
      const turn = r.adapter.sendUserMessage(sessionId, message("stopped", { abortSignal: controller.signal, workspaceOverride: r.workspace }));
      // The message is now waiting for the start the usage read began.
      await new Promise(resolve => setImmediate(resolve));
      controller.abort();
      answer!();
      await expect(turn).rejects.toMatchObject({ name: "AbortError" });
      expect(await usage).toMatchObject({ contextWindow: 32000 });
      expect(sentToPi(r)).toEqual([]);
      expect(r.spawner.last().exitCode).toBeNull();
      expect((await r.adapter.sendUserMessage(sessionId, message("next"))).text).toBe("ok");
      expect(r.spawner.processes).toHaveLength(1);
    });

    it("stops a turn at once when it is begun for a request that is already stopped", async () => {
      const r = await rig({ pi: { onPrompt: () => { /* runs until stopped */ } } });
      const { sessionId } = await r.adapter.createSession(1);
      const internals = r.adapter as unknown as {
        ensureWorker(sessionId: string, cwd: string): Promise<unknown>;
        beginTurn(worker: unknown, input: CodexUserMessageInput): { stopRequested: boolean; stopping?: Promise<void> };
        endTurn(turn: unknown): void;
      };
      const worker = await internals.ensureWorker(sessionId, r.workspace);
      const controller = new AbortController();
      controller.abort();
      const turn = internals.beginTurn(worker, message("late", { abortSignal: controller.signal }));
      expect(turn.stopRequested).toBe(true);
      await turn.stopping;
      internals.endTurn(turn);
      expect(sentToPi(r)).toEqual(["clear_queue", "abort", "clear_queue"]);
      expect(r.adapter.hasPendingNativeWork()).toBe(false);
    });
  });

  it("does not hand out a process when the adapter is destroyed, or Pi exits, while the search server is being registered", async () => {
    const plan: NativeSearchMcpPlan = { name: MANAGED_SEARCH_MCP_NAME, command: "/synthetic/node", args: ["/synthetic/search-mcp.js"], envKeys: [], processEnv: {} };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const retired = await rig({ options: { nativeSearchMcp: () => plan }, searchRegistration: () => held });
    const retiredId = (await retired.adapter.createSession(1)).sessionId;
    const turn = failure(retired.adapter.sendUserMessage(retiredId, message("hi")));
    await waitFor(() => retired.bridges.length === 1 && retired.bridge().mcpServers.length === 1);
    // A second caller waiting for the same start gets no process either.
    const usage = failure(retired.adapter.getContextUsage(retiredId, { workspaceOverride: retired.workspace }));
    await new Promise(resolve => setImmediate(resolve));
    const destroying = retired.adapter.destroy();
    release();
    await destroying;
    expect((await turn).message).toMatch(/destroyed/);
    expect((await usage).message).toMatch(/destroyed/);
    expect(commands(retired.spawner.last()).map(command => command.type).filter(type => type === "prompt" || type === "get_session_stats")).toEqual([]);
    await waitFor(() => retired.spawner.last().exitCode !== null || retired.spawner.last().signalCode !== null);
    expect(retired.adapter.hasPendingNativeWork()).toBe(false);

    let exits = 0;
    const gone = await rig({ options: { nativeSearchMcp: () => plan }, searchRegistration: async () => {
      if (exits++) return;
      // Pi ends while the registration is still unanswered; answer only after the exit has been seen.
      const process = gone.spawner.last();
      const closed = new Promise<void>(resolve => { process.once("close", () => resolve()); });
      process.exit(1);
      await closed;
      await new Promise(resolve => setImmediate(resolve));
    } });
    const { sessionId } = await gone.adapter.createSession(1);
    const error = await failure(gone.adapter.sendUserMessage(sessionId, message("hi")));
    expect(error).toBeInstanceOf(PiStartupError);
    expect((error as PiStartupError).reason).toBe("exit");
    // The ended process was not filed as this session's live one: the next message gets a process of its own.
    expect(gone.adapter.supportsSessionSteering(sessionId)).toBe(false);
    expect((await gone.adapter.sendUserMessage(sessionId, message("again"))).text).toBe("ok");
    expect(gone.spawner.processes).toHaveLength(2);
  });

  it("fails the turn whose process the adapter ends when it is destroyed, instead of returning the partial reply", async () => {
    let streamed = false;
    const r = await rig({ pi: { onPrompt: run => { run.reply("first half of the answer"); streamed = true; /* the run goes on */ } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("long task");
    const turn = failure(r.adapter.sendUserMessage(sessionId, input));
    await waitFor(() => streamed && input.events.some(event => event.type === "assistant_text"));
    await r.adapter.destroy();
    const error = await turn;
    expect(error).toBeInstanceOf(EngineIncompleteResponseError);
    expect((error as EngineIncompleteResponseError).reason).toBe("interrupted");
    expect(error.message).toMatch(/destroyed/);
    // What had been streamed is not presented as the finished answer.
    expect(kinds(input.events)).not.toContain("result");
  });

  it("fails a command turn the same way when the adapter is destroyed while its command is running", async () => {
    let asked = false;
    const r = await rig({ pi: { onCommand: command => { if (command.type !== "get_session_stats") return false; asked = true; return true; /* never answered */ } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("/session");
    const turn = failure(r.adapter.sendUserMessage(sessionId, input));
    await waitFor(() => asked);
    await r.adapter.destroy();
    const error = await turn;
    expect(error).toBeInstanceOf(EngineIncompleteResponseError);
    expect((error as EngineIncompleteResponseError).reason).toBe("interrupted");
    expect(error.message).toMatch(/destroyed/);
    // The command layer turns the lost process into reply text; that text is not this turn's result.
    expect(kinds(input.events)).not.toContain("result");
  });

  it("puts the thinking level back when the Bot effort is cleared, unless the conversation chose its own", async () => {
    const r = await rig({ config: { approvalMode: "bypass", effort: "high" } });
    const imposed = (await r.adapter.createSession(1)).sessionId, chosen = (await r.adapter.createSession(2)).sessionId;
    await r.adapter.sendUserMessage(imposed, message("a"));
    await r.adapter.sendUserMessage(chosen, message("b"));
    expect((await r.adapter.piNative.getState(imposed)).thinkingLevel).toBe("high");
    await r.adapter.piNative.setThinkingLevel(chosen, "low");
    await r.writeConfig({ approvalMode: "bypass" });
    await r.adapter.sendUserMessage(imposed, message("a2"));
    await r.adapter.sendUserMessage(chosen, message("b2"));
    // "medium" is what the session had before the Bot effort was applied.
    expect((await r.adapter.piNative.getState(imposed)).thinkingLevel).toBe("medium");
    expect((await r.adapter.piNative.getState(chosen)).thinkingLevel).toBe("low");
    const state = JSON.parse(await readFile(path.join(r.stateDir, "pi", "state.json"), "utf8"));
    expect(state.sessions[imposed].botDefaultThinking).toBeUndefined();
  });

  it("follows a session replacement an extension command made on its own", async () => {
    const outside = path.resolve("/synthetic/elsewhere/2026-01-01T00-00-02-000Z_ext-made.jsonl");
    const r = await rig({ pi: { commands: [{ name: "handoff", source: "extension" }], onCommand: (command, process) => {
      if (command.type !== "prompt" || command.message !== "/handoff") return false;
      process.state.sessionId = "ext-made"; process.state.sessionFile = outside;
      process.respond(command, { disposition: "handled" });
      return true;
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hello"));
    const events: PiNativeEvent[] = [];
    r.adapter.piNative.subscribe(sessionId, event => { events.push(event); });
    const input = message("/handoff");
    const response = await r.adapter.sendUserMessage(sessionId, input);
    expect(response.sessionId).toBe("ext-made");
    expect(input.events.filter(event => event.type === "session").map(event => event.sessionId)).toEqual([sessionId, "ext-made"]);
    expect(events).toContainEqual({ type: "session_replaced", previousSessionId: sessionId, sessionId: "ext-made", reason: "native" });
    const state = JSON.parse(await readFile(path.join(r.stateDir, "pi", "state.json"), "utf8"));
    expect(state.sessions["ext-made"].externalPath).toBe(outside);
    // The same process keeps serving the new session; the old id starts a process of its own.
    await r.adapter.sendUserMessage("ext-made", message("still here"));
    expect(r.spawner.processes).toHaveLength(1);
  });

  it("notices a replacement made between turns and never keeps two processes on one session", async () => {
    const r = await rig();
    const first = (await r.adapter.createSession(1)).sessionId, second = (await r.adapter.createSession(2)).sessionId;
    await r.adapter.sendUserMessage(first, message("a"));
    await r.adapter.sendUserMessage(second, message("b"));
    const [one, two] = r.spawner.processes as [FakePiProcess, FakePiProcess];
    one.state.sessionId = second;
    const response = await r.adapter.sendUserMessage(first, message("after the switch"));
    expect(response.sessionId).toBe(second);
    await waitFor(() => two.exitCode === 0);
    await r.adapter.sendUserMessage(second, message("same process"));
    expect(r.spawner.processes).toHaveLength(2);
    expect(commands(one, "prompt")).toHaveLength(3);
  });

  it("gives up on a prompt stuck in extension preflight and ends that process", async () => {
    // Only the first process swallows the prompt; its replacement behaves.
    const r = await rig({ pi: index => (index === 0 ? { onCommand: command => command.type === "prompt" } : {}) });
    const { sessionId } = await r.adapter.createSession(1);
    const controller = new AbortController();
    const turn = r.adapter.sendUserMessage(sessionId, message("never acknowledged", { abortSignal: controller.signal }));
    await waitFor(() => r.spawner.processes[0]?.received.some(command => command.type === "prompt") === true);
    const started = Date.now();
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1_500);
    // `abort` cannot reach an extension handler, so the stop is only certain once the process is gone.
    await waitFor(() => r.spawner.processes[0]!.signalCode === "SIGKILL");
    expect((await r.adapter.sendUserMessage(sessionId, message("fresh process"))).text).toBe("ok");
    expect(r.spawner.processes).toHaveLength(2);
  });

  it("aborts again when a prompt leaves preflight after the stop", async () => {
    let release!: () => void;
    const r = await rig({ options: { cancelGraceMs: 400 }, pi: { onPrompt: () => {}, onCommand: (command, process) => {
      if (command.type !== "prompt") return false;
      release = () => { (process as unknown as { handle(command: unknown): void }).handle(command); };
      return true;
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const controller = new AbortController();
    const turn = r.adapter.sendUserMessage(sessionId, message("late start", { abortSignal: controller.signal }));
    await waitFor(() => Boolean(release));
    controller.abort();
    await waitFor(() => commands(r.spawner.last(), "abort").length === 1);
    release();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(commands(r.spawner.last(), "abort")).toHaveLength(2);
    expect(r.spawner.last().activeRun).toBeUndefined();
    expect(r.spawner.last().exitCode).toBeNull();
  });

  it("has no inactivity deadline when the Host disabled runtime limits", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ options: { inactivityTimeoutMs: 30, turnTimeoutMs: 30 }, pi: { onPrompt: async run => { await gate; run.reply("late but fine"); run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    const turn = r.adapter.sendUserMessage(sessionId, message("slow", { disableRuntimeTimeout: true }));
    await new Promise(resolve => setTimeout(resolve, 120));
    release();
    expect((await turn).text).toBe("late but fine");
  });

  it("shows extension notices to the owner and keeps status, widgets and title as state", async () => {
    const r = await rig({ pi: { onPrompt: run => {
      run.process.ui({ id: "n", method: "notify", message: "indexing done", notifyType: "info" });
      run.process.ui({ id: "s", method: "setStatus", statusKey: "git", statusText: "\x1b[38;5;5mmain ✓\x1b[0m\x07" });
      run.process.ui({ id: "w", method: "setWidget", widgetKey: "todo", widgetLines: ["\x1b[31mone\x1b[0m", "two\u202e"], widgetPlacement: "belowEditor" });
      run.process.ui({ id: "t", method: "setTitle", title: "pi - project\x00" });
      run.process.ui({ id: "e", method: "set_editor_text", text: "\x1b[36mtry this next\x1b[0m" });
      run.reply("answer"); run.finish();
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("go");
    const response = await r.adapter.sendUserMessage(sessionId, input);
    const texts = input.events.filter(event => event.type === "assistant_text").map(event => event.text);
    // Marked, so it cannot be read as something the model wrote.
    expect(texts).toContain("[Pi extension] indexing done");
    expect(texts).toContain("[Pi extension] Suggested input:\ntry this next");
    expect(response.text).toBe("answer");
    expect((await r.adapter.piNative.getState(sessionId)).ui).toEqual({
      status: { git: "main ✓" }, widgets: { todo: { lines: ["one", "two"], placement: "belowEditor" } }, title: "pi - project",
      // A proposal for the composer; the revision lets a UI tell a new proposal from one it already offered.
      editorText: { text: "try this next", revision: 1 },
    });

    r.spawner.last().ui({ id: "n2", method: "notify", message: "background job finished" });
    r.spawner.last().ui({ id: "s2", method: "setStatus", statusKey: "git" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await r.adapter.piNative.getState(sessionId)).ui.status).toEqual({});
    const next = message("next");
    await r.adapter.sendUserMessage(sessionId, next);
    // Said while no turn was running: delivered at the start of the next one, once.
    expect(next.events.filter(event => event.type === "assistant_text").map(event => event.text)[0]).toBe("[Pi extension] background job finished");
    const third = message("third");
    await r.adapter.sendUserMessage(sessionId, third);
    expect(third.events.filter(event => event.type === "assistant_text").map(event => event.text)).not.toContain("[Pi extension] background job finished");
  });

  it.each(["/model fakeprov2/dup-model", "  /model fakeprov2/dup-model  "])("carries out the live native command %s instead of steering the model with it", async text => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ pi: { onPrompt: async run => { await gate; run.reply("done"); run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("long");
    const turn = r.adapter.sendUserMessage(sessionId, input);
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    expect(await r.adapter.steerActiveTurn(sessionId, { text })).toBe(true);
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "/tree" })).toBe(true);
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "/login" })).toBe(true);
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "actually, use tabs" })).toBe(true);
    const process = r.spawner.last();
    expect(commands(process, "set_model").map(command => `${String(command.provider)}/${String(command.modelId)}`)).toEqual(["fakeprov2/dup-model"]);
    expect(commands(process, "steer").map(command => command.message)).toEqual(["actually, use tabs"]);
    release(); await turn;
    const texts = input.events.filter(event => event.type === "assistant_text").map(event => event.text);
    expect(texts.some(text => /fakeprov2\/dup-model/.test(text))).toBe(true);
    expect(texts).toContain("/tree can run once the current reply has finished.");
    expect(texts.some(text => /pi auth login/.test(text))).toBe(true);
  });

  it("registers the Host search server for the process only, with credentials for the server alone", async () => {
    const plan: NativeSearchMcpPlan = { name: MANAGED_SEARCH_MCP_NAME, command: "/synthetic/node", args: ["/synthetic/search-mcp.js"], envKeys: ["BRAVE_API_KEY", "MISSING_KEY"], processEnv: { BRAVE_API_KEY: "s3cr$t!" } };
    let outcome: unknown, shadow: unknown;
    const r = await rig({ config: normal, options: { nativeSearchMcp: () => plan }, pi: { onPrompt: async run => {
      outcome = await r.bridge().handler.approve({ toolName: `mcp__${MANAGED_SEARCH_MCP_NAME}__web_search`, toolCallId: "s1", origin: "other", input: {} }, new AbortController().signal);
      shadow = await r.bridge().handler.approve({ toolName: "mcp__other__web_search", toolCallId: "s2", origin: "other", input: {} }, new AbortController().signal);
      run.reply("ok"); run.finish();
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("search"));
    expect(r.bridge().mcpServers).toEqual([[{ name: MANAGED_SEARCH_MCP_NAME, config: expect.objectContaining({ command: "/synthetic/node", args: ["/synthetic/search-mcp.js"], exposure: "direct", env: { BRAVE_API_KEY: "s3cr$$t!" } }) }]]);
    // The key reaches the MCP child through the bridge; it is not in Pi's own environment or arguments.
    const spawned = r.spawner.last().spawnArgs;
    expect(JSON.stringify([spawned.args, spawned.options.env])).not.toContain("s3cr");
    expect(outcome).toEqual({ allow: true });
    expect(shadow).toMatchObject({ allow: false });

    const owned = await rig({ config: normal, options: { nativeSearchMcp: () => plan } });
    await mkdir(path.join(owned.root, "agent"), { recursive: true });
    await writeFile(path.join(owned.root, "agent", "mcp.json"), JSON.stringify({ mcpServers: { "brave-search": { command: "npx", args: ["server-brave-search"], enabled: false } } }));
    await owned.adapter.sendUserMessage((await owned.adapter.createSession(1)).sessionId, message("search"));
    // The owner has a search server of their own, here deliberately disabled: that decision stands.
    expect(owned.bridge().mcpServers).toEqual([]);
  });

  it("keeps both records when two sessions are first written at the same time", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-store-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const store = new PiSessionStore({ stateDir: root, childEnv: {} });
    await Promise.all([store.updateRecord("session-one", { modelSource: "session" }), store.updateRecord("session-two", { modelSource: "native" }), store.setTrustDecision("/synthetic/ws", "yes")]);
    const reread = new PiSessionStore({ stateDir: root, childEnv: {} });
    expect(await reread.record("session-one")).toMatchObject({ modelSource: "session" });
    expect(await reread.record("session-two")).toMatchObject({ modelSource: "native" });
    expect(await reread.trustDecision("/synthetic/ws")).toBe("yes");
  });
});

describe("PiRpcAdapter live session handle", () => {
  const yes = { isCurrent: async () => true };

  it("exists only for a process that is alive now and never starts one", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    expect(r.adapter.piNative.getLiveSession!(sessionId)).toBeUndefined();
    expect(r.spawner.processes).toHaveLength(0);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    expect(live.isCurrent()).toBe(true);
    expect(live.token).not.toBe(sessionId);
    expect(live.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await live.getState()).toMatchObject({ sessionId, model: { provider: "fakeprov", modelId: "dup-model" } });
    expect(await live.listModels()).toHaveLength(3);
    await r.adapter.destroy();
    expect(live.isCurrent()).toBe(false);
    await expect(live.getState()).rejects.toBeInstanceOf(PiNativeRejectedError);
    expect(r.spawner.processes).toHaveLength(1);
  });

  it("writes only while the caller's own check still holds, and applies mid-run", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ pi: { onPrompt: async run => { await gate; run.reply("ok"); run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    const turn = r.adapter.sendUserMessage(sessionId, message("long"));
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    const refused = await failure(live.setModel({ provider: "fakeprov2", modelId: "dup-model" }, { isCurrent: async () => false }));
    expect(refused).toBeInstanceOf(PiNativeRejectedError);
    expect((refused as PiNativeRejectedError).reason).toBe("not-found");
    expect(commands(r.spawner.last(), "set_model")).toHaveLength(0);
    expect(await live.setModel({ provider: "fakeprov2", modelId: "dup-model" }, yes)).toMatchObject({ model: { provider: "fakeprov2" }, modelSource: "session", isStreaming: true });
    expect(await live.setThinkingLevel("low", yes)).toMatchObject({ thinkingLevel: "low" });
    await expect(live.setThinkingLevel("max", yes)).rejects.toMatchObject({ reason: "thinking-unsupported" });
    release(); await turn;
  });

  it("is invalidated by a fork and never touches the session that replaced it", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("first"));
    const before = r.adapter.piNative.getLiveSession!(sessionId)!;
    const forked = await r.adapter.piNative.fork(sessionId, { entryId: (await r.adapter.piNative.listForkPoints(sessionId))[0]!.entryId });
    expect(before.isCurrent()).toBe(false);
    await expect(before.setModel({ provider: "fakeprov", modelId: "plain-model" }, yes)).rejects.toMatchObject({ reason: "not-found" });
    expect(commands(r.spawner.last(), "set_model")).toHaveLength(0);
    expect(r.adapter.piNative.getLiveSession!(sessionId)).toBeUndefined();
    const after = r.adapter.piNative.getLiveSession!(forked.sessionId)!;
    expect(after.token).not.toBe(before.token);
    expect(await after.getState()).toMatchObject({ sessionId: forked.sessionId });
  });

  it("does not write when the process is replaced while the caller's check is pending", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("first"));
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    const attempt = failure(live.setModel({ provider: "fakeprov2", modelId: "dup-model" }, { isCurrent: async () => { await r.adapter.piNative.clone(sessionId); return true; } }));
    expect((await attempt as PiNativeRejectedError).reason).toBe("not-found");
    expect(commands(r.spawner.last(), "set_model")).toHaveLength(0);
  });

  it("drops the conversation's own model at once: Bot default if there is one, otherwise Pi's default", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov2/dup-model" }, nativeDefault: { provider: "fakeprov", modelId: "dup-model", thinkingLevel: "medium" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("a"));
    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov", modelId: "plain-model" });
    expect(await r.adapter.piNative.setModel(sessionId, null)).toMatchObject({ modelSource: "bot-default", model: { provider: "fakeprov2", modelId: "dup-model" } });

    await r.writeConfig({ approvalMode: "bypass" });
    await r.adapter.sendUserMessage(sessionId, message("b"));
    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov", modelId: "plain-model" });
    // No Bot default any more: dropping the choice must not leave the session claiming a default it does not run.
    expect(await r.adapter.piNative.setModel(sessionId, null)).toMatchObject({ modelSource: "native", model: { provider: "fakeprov", modelId: "dup-model" } });
  });
});

describe("PiRpcAdapter trust, session files and model scope", () => {
  it("re-decides project trust for this workspace only and restarts so it takes effect", async () => {
    const r = await rig();
    await mkdir(path.join(r.workspace, ".pi", "skills"), { recursive: true });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    expect(await r.adapter.piNative.getProjectTrust(sessionId)).toEqual({ hasProjectFiles: true });
    expect(await r.bridge().handler.trust({ cwd: r.workspace })).toBe("undecided");
    expect(await r.adapter.piNative.setProjectTrust(sessionId, "yes")).toMatchObject({ hasProjectFiles: true, decision: "yes" });
    expect(r.spawner.processes).toHaveLength(2);
    await waitFor(() => r.spawner.processes[0]!.exitCode === 0);
    expect(await r.bridge().handler.trust({ cwd: r.workspace })).toBe("yes");
    expect((await r.adapter.piNative.setProjectTrust(sessionId, "no")).decision).toBe("no");
    expect(await r.bridge().handler.trust({ cwd: r.workspace })).toBe("no");
    // Pi's own trust list, which the terminal uses, is not this Bot's to edit.
    expect(await readdir(path.join(r.root, "agent")).catch(() => [])).not.toContain("trust.json");
    expect((await r.adapter.sendUserMessage(sessionId, message("still works"))).sessionId).toBe(sessionId);
  });

  it("exports the active branch as a native session file", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("first"));
    await r.adapter.sendUserMessage(sessionId, message("second"));
    const target = path.join(r.root, "out", "nested", "branch.jsonl");
    const result = await r.adapter.piNative.exportJsonl(sessionId, { outputPath: target });
    expect(result).toEqual({ path: target, entries: 4 });
    const lines = (await readFile(target, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: "session", version: 3, id: sessionId, cwd: r.workspace });
    expect(lines.slice(1).map(line => (line.message as { role: string }).role)).toEqual(["user", "assistant", "user", "assistant"]);
    // Re-linked as one chain, as Pi writes it.
    expect(lines[1]!.parentId).toBeNull();
    expect(lines.slice(2).map(line => line.parentId)).toEqual(lines.slice(1, -1).map(line => line.id));
  });

  it("imports a local session file of this workspace and rebinds the conversation to it", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const header = (id: string, cwd: string) => `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`;
    const mine = path.join(r.root, "2026-01-01T00-00-00-000Z_imported-one.jsonl"), foreign = path.join(r.root, "2026-01-01T00-00-00-000Z_foreign.jsonl"), notes = path.join(r.root, "notes.jsonl");
    await writeFile(mine, header("imported-one", r.workspace)); await writeFile(foreign, header("foreign", path.join(r.root, "elsewhere"))); await writeFile(notes, "{\"hello\":1}\n");

    expect(await r.adapter.piNative.inspectImport(sessionId, { path: notes })).toBeUndefined();
    expect(await r.adapter.piNative.inspectImport(sessionId, { path: path.join(r.root, "missing.jsonl") })).toBeUndefined();
    expect(await r.adapter.piNative.inspectImport(sessionId, { path: foreign })).toEqual({ sessionId: "foreign", sameWorkspace: false, alreadyPresent: false });
    // Pi runs a session's tools in the directory the session records.
    await expect(r.adapter.piNative.importSession(sessionId, { path: foreign })).rejects.toThrow(/another workspace/);
    await expect(r.adapter.piNative.importSession(sessionId, { path: notes })).rejects.toBeInstanceOf(PiNativeRejectedError);

    const imported = await r.adapter.piNative.importSession(sessionId, { path: mine });
    expect(imported).toEqual({ sessionId: "imported-one", cancelled: false });
    const copy = path.join(r.stateDir, "pi", "sessions", path.basename(mine));
    expect(await readFile(copy, "utf8")).toBe(header("imported-one", r.workspace));
    expect(await readFile(mine, "utf8")).toBe(header("imported-one", r.workspace));
    expect(commands(r.spawner.last(), "switch_session").map(command => command.sessionPath)).toEqual([copy]);
    expect(r.spawner.processes).toHaveLength(1);
    expect((await r.adapter.sendUserMessage("imported-one", message("continue"))).sessionId).toBe("imported-one");
    expect(await r.adapter.piNative.inspectImport("imported-one", { path: mine })).toMatchObject({ alreadyPresent: true });
    await expect(r.adapter.piNative.importSession("imported-one", { path: mine })).rejects.toThrow(/already among/);
  });

  it("still finds an imported session once its process is gone, whatever its source file was called", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    // What `/export backup.jsonl` hands over: a name the owner chose, with the session id only in the header.
    const exported = path.join(r.root, "backup.jsonl");
    await writeFile(exported, `${JSON.stringify({ type: "session", version: 3, id: "exported-one", timestamp: "2026-01-01T00:00:00.000Z", cwd: r.workspace })}\n`);
    expect(await r.adapter.piNative.importSession(sessionId, { path: exported })).toEqual({ sessionId: "exported-one", cancelled: false });
    const copy = String(commands(r.spawner.last(), "switch_session")[0]!.sessionPath);
    expect(copy).toBe(path.join(r.stateDir, "pi", "sessions", "backup_exported-one.jsonl"));
    expect(await readFile(copy, "utf8")).toBe(await readFile(exported, "utf8"));

    // The Pi process ends (idle sweep, Host restart). The Host has to find the file by itself from here on.
    r.spawner.last().exit(0);
    await waitFor(() => !r.adapter.supportsSessionSteering("exported-one"));
    // `/resume` lists the session, so choosing it there must work.
    expect((await r.adapter.listExternalSessions({ cwd: r.workspace })).map(session => session.sessionId)).toContain("exported-one");
    expect(await r.adapter.validateExternalSession("exported-one")).toMatchObject({ sessionId: "exported-one", cwd: r.workspace });
    // It is reopened from its own file, which is also what the other-workspace check reads.
    expect((await r.adapter.sendUserMessage("exported-one", message("continue"))).sessionId).toBe("exported-one");
    const args = r.spawner.last().args;
    expect(args[args.indexOf("--session") + 1]).toBe(copy);
    expect(args).not.toContain("--session-id");
  });

  it("refuses to import the same owner-named file a second time next to its first copy", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const exported = path.join(r.root, "backup.jsonl");
    await writeFile(exported, `${JSON.stringify({ type: "session", version: 3, id: "exported-one", timestamp: "2026-01-01T00:00:00.000Z", cwd: r.workspace })}\n`);
    await r.adapter.piNative.importSession(sessionId, { path: exported });
    r.spawner.last().exit(0);
    await waitFor(() => !r.adapter.supportsSessionSteering("exported-one"));

    const other = (await r.adapter.createSession(2)).sessionId;
    await r.adapter.sendUserMessage(other, message("hi"));
    expect(await r.adapter.piNative.inspectImport(other, { path: exported })).toEqual({ sessionId: "exported-one", sameWorkspace: true, alreadyPresent: true });
    await expect(r.adapter.piNative.importSession(other, { path: exported })).rejects.toThrow(/already among/);
    // One session id, one file: a second copy would leave two transcripts under the same id.
    const sessions = path.join(r.stateDir, "pi", "sessions");
    const holders = [];
    for (const name of await readdir(sessions)) if ((await readFile(path.join(sessions, name), "utf8")).includes('"id":"exported-one"')) holders.push(name);
    expect(holders).toHaveLength(1);
  });

  it("serves a session an earlier build imported under the owner's file name", async () => {
    const r = await rig();
    const sessions = path.join(r.stateDir, "pi", "sessions"), kept = path.join(sessions, "backup.jsonl");
    const header = `${JSON.stringify({ type: "session", version: 3, id: "kept-one", timestamp: "2026-01-01T00:00:00.000Z", cwd: r.workspace })}\n`;
    await mkdir(sessions, { recursive: true }); await writeFile(kept, header);
    const elsewhere = path.join(r.root, "elsewhere"); await mkdir(elsewhere);

    expect(await r.adapter.validateExternalSession("kept-one")).toMatchObject({ sessionId: "kept-one", cwd: r.workspace });
    // The check that keeps Pi from asking [y/N] on a terminal nobody sees needs the file's own header.
    await expect(r.adapter.validateExternalSession("kept-one", { workspaceOverride: elsewhere })).rejects.toThrow(/another workspace/);
    await expect(r.adapter.sendUserMessage("kept-one", message("hi", { workspaceOverride: elsewhere }))).rejects.toThrow(/another workspace/);
    expect(r.spawner.processes).toHaveLength(0);

    expect((await r.adapter.sendUserMessage("kept-one", message("continue"))).sessionId).toBe("kept-one");
    const args = r.spawner.last().args;
    expect(args[args.indexOf("--session") + 1]).toBe(kept);
    expect(args).not.toContain("--session-id");

    // The same export offered again, from another conversation while this one has no live process.
    r.spawner.last().exit(0);
    await waitFor(() => !r.adapter.supportsSessionSteering("kept-one"));
    const exported = path.join(r.root, "backup.jsonl"); await writeFile(exported, header);
    const other = (await r.adapter.createSession(2)).sessionId;
    await r.adapter.sendUserMessage(other, message("hi"));
    expect(await r.adapter.piNative.inspectImport(other, { path: exported })).toMatchObject({ alreadyPresent: true });
    await expect(r.adapter.piNative.importSession(other, { path: exported })).rejects.toThrow(/already among/);
    expect((await readdir(sessions)).filter(name => name.startsWith("backup"))).toEqual(["backup.jsonl"]);
  });

  it("leaves nothing behind when an extension vetoes the import", async () => {
    const r = await rig({ pi: { cancelSwitch: true } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const file = path.join(r.root, "2026-01-01T00-00-00-000Z_vetoed.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "vetoed", timestamp: "2026-01-01T00:00:00.000Z", cwd: r.workspace })}\n`);
    expect(await r.adapter.piNative.importSession(sessionId, { path: file })).toEqual({ sessionId, cancelled: true });
    expect((await readdir(path.join(r.stateDir, "pi", "sessions"))).filter(name => name.includes("vetoed"))).toEqual([]);
  });

  it("scopes models per Bot with --models and never writes Pi's global settings", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    expect(r.spawner.last().args).not.toContain("--models");
    expect(await r.adapter.piNative.getModelScope(sessionId)).toEqual({ scope: [], nativePatterns: [] });
    await expect(r.adapter.piNative.setModelScope(sessionId, [{ provider: "anthropic", modelId: "not-signed-in" }])).rejects.toMatchObject({ reason: "model-unavailable" });
    const scoped = await r.adapter.piNative.setModelScope(sessionId, [{ provider: "fakeprov2", modelId: "dup-model" }, { provider: "fakeprov", modelId: "plain-model" }]);
    expect(scoped.scope).toEqual([{ provider: "fakeprov2", modelId: "dup-model" }, { provider: "fakeprov", modelId: "plain-model" }]);
    expect(r.spawner.processes).toHaveLength(2);
    const args = r.spawner.last().args;
    expect(args[args.indexOf("--models") + 1]).toBe("fakeprov2/dup-model,fakeprov/plain-model");
    expect(args).not.toContain("--model");
    expect(JSON.parse(await readFile(path.join(r.stateDir, "pi", "state.json"), "utf8")).scopedModels).toEqual(["fakeprov2/dup-model", "fakeprov/plain-model"]);
    expect(await readdir(path.join(r.root, "agent")).catch(() => [])).not.toContain("settings.json");
    expect((await r.adapter.piNative.setModelScope(sessionId, null)).scope).toEqual([]);
    expect(r.spawner.last().args).not.toContain("--models");
  });

  it("refuses trust, import and scope changes while the model is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ pi: { onPrompt: async run => { await gate; run.reply("ok"); run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    const turn = r.adapter.sendUserMessage(sessionId, message("long"));
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    await expect(r.adapter.piNative.setProjectTrust(sessionId, "yes")).rejects.toBeInstanceOf(PiNativeBusyError);
    await expect(r.adapter.piNative.setModelScope(sessionId, null)).rejects.toBeInstanceOf(PiNativeBusyError);
    await expect(r.adapter.piNative.importSession(sessionId, { path: "/synthetic/x.jsonl" })).rejects.toBeInstanceOf(PiNativeBusyError);
    expect(r.spawner.processes).toHaveLength(1);
    release(); await turn;
  });
});

describe("PiRpcAdapter independent model and thinking resets", () => {
  const yes = { isCurrent: async () => true };

  it("resets only the thinking level and keeps the model the conversation chose", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("a"));
    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov2", modelId: "dup-model" });
    await r.adapter.piNative.setThinkingLevel(sessionId, "low");
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    // Back to the Bot effort, on the model the conversation still runs.
    expect(await live.setThinkingLevel(null, yes)).toMatchObject({ thinkingLevel: "high", model: { provider: "fakeprov2", modelId: "dup-model" }, modelSource: "session" });
    expect(commands(r.spawner.last(), "set_model").map(command => `${String(command.provider)}/${String(command.modelId)}`)).toEqual(["fakeprov2/dup-model"]);
    await r.adapter.sendUserMessage(sessionId, message("b"));
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ thinkingLevel: "high", model: { provider: "fakeprov2" } });
  });

  it("refuses a Bot effort the current model does not have instead of switching models", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("a"));
    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov", modelId: "plain-model" });
    const rejected = await failure(r.adapter.piNative.setThinkingLevel(sessionId, null));
    expect(rejected).toMatchObject({ reason: "thinking-unsupported" });
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ thinkingLevel: "off", model: { provider: "fakeprov", modelId: "plain-model" } });
  });

  it("resets only the model and leaves a level change to Pi", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("a"));
    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov2", modelId: "dup-model" });
    await r.adapter.piNative.setThinkingLevel(sessionId, "low");
    expect(await r.adapter.piNative.setModel(sessionId, null)).toMatchObject({ model: { provider: "fakeprov", modelId: "dup-model" }, modelSource: "bot-default", thinkingLevel: "low" });
    expect(commands(r.spawner.last(), "set_thinking_level").map(command => command.level)).toEqual(["high", "low"]);
  });

  it("returns a Bot-owned thinking level together with the model when the model is reset", async () => {
    // P-test 2026-11-21: a conversation model Pi clamped to "off", then "default" restored only the model.
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model", effort: "medium" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("a"));
    expect(await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov", modelId: "plain-model" })).toMatchObject({ thinkingLevel: "off" });
    expect(await r.adapter.piNative.setModel(sessionId, null)).toMatchObject({ model: { provider: "fakeprov", modelId: "dup-model" }, modelSource: "bot-default", thinkingLevel: "medium" });
    // The next turn finds nothing to correct, and the level is still the Bot's to change.
    await r.adapter.sendUserMessage(sessionId, message("b"));
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ thinkingLevel: "medium" });
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" });
    await r.adapter.sendUserMessage(sessionId, message("c"));
    expect(await r.adapter.piNative.getState(sessionId)).toMatchObject({ thinkingLevel: "high", modelSource: "bot-default" });
  });

  it("records a completed model reset even when putting the Bot's level back then fails", async () => {
    // Independent review 9: a throw after set_model left the reset unrecorded and the caller saw "uncertain".
    let dropThinking = false;
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model", effort: "medium" }, options: { settingsWriteTimeoutMs: 50 },
      pi: { onCommand: command => command.type === "set_thinking_level" && dropThinking ? true : undefined } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("a"));
    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov", modelId: "plain-model" });
    dropThinking = true;
    const notices: PiNativeEvent[] = [];
    r.adapter.piNative.subscribe(sessionId, event => notices.push(event));
    expect(await r.adapter.piNative.setModel(sessionId, null)).toMatchObject({ model: { provider: "fakeprov", modelId: "dup-model" }, modelSource: "bot-default" });
    const record = JSON.parse(await readFile(path.join(r.stateDir, "pi", "state.json"), "utf8")).sessions[sessionId];
    expect(record).toMatchObject({ modelSource: "bot-default", botDefaultModel: { provider: "fakeprov", modelId: "dup-model" } });
    expect(notices.some(event => event.type === "notify" && /thinking level/i.test(event.text))).toBe(true);
  });

  it("returns a Bot-owned level when the model falls back to Pi's default", async () => {
    const r = await rig({ config: { approvalMode: "bypass", effort: "medium" }, nativeDefault: { provider: "fakeprov", modelId: "dup-model", thinkingLevel: "low" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("a"));
    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov", modelId: "plain-model" });
    expect(await r.adapter.piNative.setModel(sessionId, null)).toMatchObject({ model: { provider: "fakeprov", modelId: "dup-model" }, modelSource: "native", thinkingLevel: "medium" });
  });

  it("keeps the level when there is no Bot effort, and says so by not writing", async () => {
    const r = await rig({ config: { approvalMode: "bypass" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("a"));
    await r.adapter.piNative.setThinkingLevel(sessionId, "low");
    const before = commands(r.spawner.last(), "set_thinking_level").length;
    expect(await r.adapter.piNative.setThinkingLevel(sessionId, null)).toMatchObject({ thinkingLevel: "low" });
    expect(commands(r.spawner.last(), "set_thinking_level")).toHaveLength(before);
    expect(commands(r.spawner.last(), "set_model")).toHaveLength(0);
  });
});

describe("PiRpcAdapter visible replies and cost split", () => {
  it("answers an extension command that printed nothing with a visible line", async () => {
    const r = await rig({ pi: { commands: [{ name: "silent", source: "extension" }], onCommand: (command, process) => {
      if (command.type !== "prompt" || command.message !== "/silent") return false;
      process.respond(command, { disposition: "handled" });
      return true;
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    // An empty reply would read as a failed turn.
    expect((await r.adapter.sendUserMessage(sessionId, message("/silent"))).text).toBe("The command ran and produced no output.");
    expect((await r.adapter.sendUserMessage(sessionId, message("/silent", { locale: "zh" }))).text).toBe("命令已执行，没有输出。");
    // A model run that ends without text is not papered over with that line.
    const quiet = await rig({ pi: { onPrompt: run => { run.reply(""); run.finish(); } } });
    expect((await quiet.adapter.sendUserMessage((await quiet.adapter.createSession(1)).sessionId, message("hi"))).text).toBe("");
  });

  it("reports cost per model from the session entries", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("one"));
    await r.adapter.piNative.setModel(sessionId, { provider: "fakeprov2", modelId: "dup-model" });
    await r.adapter.sendUserMessage(sessionId, message("two"));
    const stats = await r.adapter.piNative.getStats(sessionId);
    expect(stats.costByModel).toEqual([
      { key: "fakeprov/dup-model", costUsd: 0.001, tokens: 140 },
      { key: "fakeprov2/dup-model", costUsd: 0.001, tokens: 140 },
    ]);
  });
});

describe("PiRpcAdapter model-write fence", () => {
  const yes = { isCurrent: async () => true };
  const writes = (process: FakePiProcess) => commands(process).filter(command => command.type === "set_model" || command.type === "set_thinking_level");
  /** A fake whose first `set_model` to fakeprov2 is held, as Pi holds it while it checks the provider's credentials. */
  const holding = () => {
    const held: { release?: () => void } = {};
    const pi: FakePiOptions = { onCommand: (command, process) => {
      if (command.type !== "set_model" || command.provider !== "fakeprov2" || held.release) return false;
      held.release = () => { process.state.model = process.models.find(model => model.provider === "fakeprov2")!; process.respond(command, process.state.model); };
      return true;
    } };
    return { held, pi };
  };

  it("sends no second write to a process whose first write was never confirmed, even after that write lands late", async () => {
    const { held, pi } = holding();
    const r = await rig({ options: { settingsWriteTimeoutMs: 40 }, pi });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const process = r.spawner.last();
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;

    expect(await failure(live.setModel({ provider: "fakeprov2", modelId: "dup-model" }, yes))).toBeInstanceOf(PiNativeUncertainError);
    expect(writes(process)).toHaveLength(1);
    // A fresh request (another device), a thinking change, the non-live control and the typed command: none may write.
    expect(await failure(live.setModel({ provider: "fakeprov", modelId: "plain-model" }, yes))).toBeInstanceOf(PiNativeUncertainError);
    expect(await failure(live.setThinkingLevel("low", yes))).toBeInstanceOf(PiNativeUncertainError);
    expect(await failure(r.adapter.piNative.setModel(sessionId, { provider: "fakeprov", modelId: "plain-model" }))).toBeInstanceOf(PiNativeUncertainError);
    expect((await r.adapter.sendUserMessage(sessionId, message("/model fakeprov/plain-model"))).text).toMatch(/got no confirmed answer and may still take effect, so \/model was not attempted/);
    expect(writes(process)).toHaveLength(1);
    // Nobody is recorded as having chosen a model that may or may not be in place.
    expect((await live.getState()).modelSource).toBe("native");

    held.release!();
    await waitFor(() => (process.state.model as { provider: string }).provider === "fakeprov2");
    // Reads keep working and tell the truth; the handle is the same process, still uncertain.
    expect(await live.getState()).toMatchObject({ model: { provider: "fakeprov2", modelId: "dup-model" } });
    expect(live.isCurrent()).toBe(true);
    expect(await failure(live.setModel({ provider: "fakeprov", modelId: "plain-model" }, yes))).toBeInstanceOf(PiNativeUncertainError);
    expect(writes(process)).toHaveLength(1);
    // A fork is still this process, so the late write could land on the new session too.
    const cloned = await r.adapter.piNative.clone(sessionId);
    expect(await failure(r.adapter.piNative.setThinkingLevel(cloned.sessionId, "low"))).toBeInstanceOf(PiNativeUncertainError);
    expect(writes(process)).toHaveLength(1);
  });

  it("still runs turns that need no model write, and fails one that would need it", async () => {
    const { pi } = holding();
    const r = await rig({ options: { settingsWriteTimeoutMs: 40 }, pi });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    await failure(r.adapter.piNative.setModel(sessionId, { provider: "fakeprov2", modelId: "dup-model" }));
    expect((await r.adapter.sendUserMessage(sessionId, message("still talking"))).text).toBe("ok");
    // The Bot default changed: applying it would be a second write to the uncertain process.
    await r.writeConfig({ approvalMode: "bypass", model: "fakeprov/plain-model" });
    const refused = await failure(r.adapter.sendUserMessage(sessionId, message("with a new default")));
    expect(refused.message).toMatch(/no confirmed result and may still take effect/);
    expect(writes(r.spawner.last())).toHaveLength(1);
    expect(commands(r.spawner.last(), "prompt")).toHaveLength(2);
    const state = JSON.parse(await readFile(path.join(r.stateDir, "pi", "state.json"), "utf8"));
    expect(state.sessions[sessionId].appliedBotDefault).toBe(piBotDefaultFingerprint(undefined, undefined));
  });

  it("is cleared only by a new process", async () => {
    const { pi } = holding();
    const r = await rig({ options: { settingsWriteTimeoutMs: 40 }, pi: index => (index === 0 ? pi : {}) });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const before = r.adapter.piNative.getLiveSession!(sessionId)!;
    await failure(before.setModel({ provider: "fakeprov2", modelId: "dup-model" }, yes));
    // Changing project trust restarts the process for this session, as a Bot restart would.
    await r.adapter.piNative.setProjectTrust(sessionId, "no");
    const after = r.adapter.piNative.getLiveSession!(sessionId)!;
    expect(after.token).not.toBe(before.token);
    expect(await after.setModel({ provider: "fakeprov", modelId: "plain-model" }, yes)).toMatchObject({ model: { provider: "fakeprov", modelId: "plain-model" } });
    expect(await failure(before.setModel({ provider: "fakeprov", modelId: "plain-model" }, yes))).toMatchObject({ reason: "not-found" });
  });

  it("runs model and thinking changes to one process strictly one after another", async () => {
    const seenByGuard: string[] = [];
    const r = await rig({ pi: { onCommand: (command, process) => {
      if (command.type !== "set_model") return false;
      setTimeout(() => (process as unknown as { handle(command: unknown): void }).handle(command), 25);
      return true;
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const process = r.spawner.last();
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    const current = () => `${(process.state.model as { provider: string; id: string }).provider}/${(process.state.model as { id: string }).id}`;
    const first = live.setModel({ provider: "fakeprov2", modelId: "dup-model" }, yes);
    const second = live.setModel({ provider: "fakeprov", modelId: "plain-model" }, { isCurrent: async () => { seenByGuard.push(current()); return true; } });
    const third = r.adapter.piNative.setModel(sessionId, { provider: "fakeprov2", modelId: "dup-model" });
    await Promise.all([first, second, third]);
    // The second choice was only checked once the first had fully landed.
    expect(seenByGuard[0]).toBe("fakeprov2/dup-model");
    expect(commands(process, "set_model").map(command => `${String(command.provider)}/${String(command.modelId)}`)).toEqual(["fakeprov2/dup-model", "fakeprov/plain-model", "fakeprov2/dup-model"]);
    expect(current()).toBe("fakeprov2/dup-model");
  });

  it("asks the caller's check before recording a choice that needs no native write", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    const before = writes(r.spawner.last()).length;
    let asked = 0;
    const refused = await failure(live.setModel({ provider: "fakeprov", modelId: "dup-model" }, { isCurrent: async () => { asked++; return false; } }));
    expect(refused).toMatchObject({ reason: "not-found" });
    expect(asked).toBeGreaterThan(0);
    // Same model as now: no native write either way, and a refused request must not change who chose it.
    expect((await live.getState()).modelSource).toBe("bot-default");
    expect(await failure(live.setThinkingLevel("high", { isCurrent: async () => false }))).toMatchObject({ reason: "not-found" });
    expect(await live.setModel({ provider: "fakeprov", modelId: "dup-model" }, yes)).toMatchObject({ modelSource: "session" });
    expect(writes(r.spawner.last())).toHaveLength(before);
  });

  it("reports an unconfirmed return to Pi's default as uncertain, not as an unavailable model", async () => {
    const r = await rig({
      options: { settingsWriteTimeoutMs: 40 }, config: { approvalMode: "bypass", model: "fakeprov2/dup-model" },
      // Hold only the write that would restore the native default.
      pi: { onCommand: command => command.type === "set_model" && command.provider === "fakeprov" },
    });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("a"));
    const notices: PiNativeEvent[] = [];
    r.adapter.piNative.subscribe(sessionId, event => { if (event.type === "notify") notices.push(event); });
    await r.writeConfig({ approvalMode: "bypass" });
    const refused = await failure(r.adapter.sendUserMessage(sessionId, message("b")));
    expect(refused.message).toMatch(/no confirmed result/);
    // Not the "default is unavailable, keeping the current model" path: that would hide a write that may still land.
    expect(notices).toEqual([]);
    const state = JSON.parse(await readFile(path.join(r.stateDir, "pi", "state.json"), "utf8"));
    expect(state.sessions[sessionId].appliedBotDefault).toBe(piBotDefaultFingerprint("fakeprov2/dup-model", undefined));
    expect(await failure(r.adapter.piNative.setModel(sessionId, null))).toBeInstanceOf(PiNativeUncertainError);
  });

  /** Per-session bookkeeping as written to disk; empty while nothing was recorded yet. */
  const records = async (r: Rig): Promise<Record<string, Record<string, unknown> | undefined>> => {
    try { return (JSON.parse(await readFile(path.join(r.stateDir, "pi", "state.json"), "utf8")) as { sessions?: Record<string, Record<string, unknown>> }).sessions ?? {}; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  };

  it.each([["the live handle", true], ["the control without a handle", false]] as const)(
    "does not record a choice made through %s for the session that replaced the one it was made for",
    async (_label, viaHandle) => {
      const { held, pi } = holding();
      const r = await rig({ pi });
      const { sessionId } = await r.adapter.createSession(1);
      await r.adapter.sendUserMessage(sessionId, message("hi"));
      const process = r.spawner.last();
      const choice = { provider: "fakeprov2", modelId: "dup-model" };
      const attempt = failure(viaHandle ? r.adapter.piNative.getLiveSession!(sessionId)!.setModel(choice, yes) : r.adapter.piNative.setModel(sessionId, choice));
      await waitFor(() => Boolean(held.release));
      // Pi is still checking the provider's credentials when the conversation moves to a new session.
      const replacement = await r.adapter.piNative.newSession(sessionId);
      expect(replacement.sessionId).not.toBe(sessionId);
      held.release!();
      const outcome = await attempt.catch(error => error as Error);
      const sessions = await records(r);
      expect(sessions[replacement.sessionId]?.modelSource).toBeUndefined();
      expect(sessions[sessionId]?.modelSource).toBeUndefined();
      expect((await r.adapter.piNative.getState(replacement.sessionId)).modelSource).toBe("native");
      expect(writes(process)).toHaveLength(1);
      expect(outcome).toBeInstanceOf(PiNativeRejectedError);
      expect(outcome).toMatchObject({ reason: "not-found" });
      // The write may be in place by now, so the refusal must not say otherwise.
      expect(outcome.message).not.toMatch(/nothing was changed/);
    },
  );

  it("does not record a choice while Pi already serves a session the Host has not filed the process under yet", async () => {
    // Held: the write, and the state read from which the Host learns the new session's id.
    const held: { write?: () => void; adoption?: () => void } = {};
    let switched = false;
    const r = await rig({ pi: { onCommand: (command, process) => {
      if (command.type === "new_session") switched = true;
      if (command.type === "set_model" && command.provider === "fakeprov2" && !held.write) {
        held.write = () => { process.state.model = process.models.find(model => model.provider === "fakeprov2")!; process.respond(command, process.state.model); };
        return true;
      }
      if (command.type === "get_state" && switched && !held.adoption) {
        held.adoption = () => (process as unknown as { handle(command: unknown): void }).handle(command);
        return true;
      }
      return false;
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    const attempt = live.setModel({ provider: "fakeprov2", modelId: "dup-model" }, yes).catch(error => error as Error);
    await waitFor(() => Boolean(held.write));
    const replacing = r.adapter.piNative.newSession(sessionId);
    await waitFor(() => Boolean(held.adoption));
    // Pi has switched; the handle still looks current to the Host.
    expect(live.isCurrent()).toBe(true);
    held.write!();
    const outcome = await attempt;
    expect((await records(r))[sessionId]?.modelSource).toBeUndefined();
    expect(outcome).toMatchObject({ name: "PiNativeRejectedError", reason: "not-found" });
    held.adoption!();
    const replacement = await replacing;
    expect(replacement.sessionId).not.toBe(sessionId);
    expect((await records(r))[replacement.sessionId]?.modelSource).toBeUndefined();
  });

  it("sends no further native write once the process serves another session", async () => {
    // Held here: the lookup of supported levels that comes before a thinking write.
    let armed = false, release: (() => void) | undefined;
    const r = await rig({ pi: { onCommand: (command, process) => {
      if (command.type !== "get_available_thinking_levels" || !armed || release) return false;
      release = () => process.respond(command, { levels: ["off", "low", "medium", "high"] });
      return true;
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const process = r.spawner.last();
    const level = (await r.adapter.piNative.getState(sessionId)).thinkingLevel;
    expect(level).not.toBe("high");
    armed = true;
    const attempt = failure(r.adapter.piNative.setThinkingLevel(sessionId, "high"));
    await waitFor(() => Boolean(release));
    const replacement = await r.adapter.piNative.newSession(sessionId);
    release!();
    expect(await attempt).toMatchObject({ reason: "not-found" });
    expect(writes(process)).toEqual([]);
    expect((await r.adapter.piNative.getState(replacement.sessionId)).thinkingLevel).toBe(level);
  });

  it("does not record a choice whose requester stopped being current while Pi applied it", async () => {
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov/dup-model" } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const process = r.spawner.last();
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    const before = (await records(r))[sessionId];
    // Allowed until Pi has taken the write; by then the conversation is bound to another session, say.
    const taken = () => commands(process, "set_model").some(command => command.provider === "fakeprov2");
    const refused = await failure(live.setModel({ provider: "fakeprov2", modelId: "dup-model" }, { isCurrent: async () => !taken() }));
    expect(refused).toMatchObject({ reason: "not-found" });
    expect(refused.message).not.toMatch(/nothing was changed/);
    expect(taken()).toBe(true);
    // The model is the new one and is shown as such; who chose it is not rewritten.
    expect((await records(r))[sessionId]).toEqual(before);
    expect(await live.getState()).toMatchObject({ model: { provider: "fakeprov2", modelId: "dup-model" }, modelSource: "bot-default" });
  });

  it("records nothing when the session is replaced while the record itself waits for its file", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const process = r.spawner.last();
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    const taken = () => commands(process, "set_model").some(command => command.provider === "fakeprov2");
    // The store's next read of its file takes long enough for a whole session replacement.
    let slowNextRead = false, replacing: Promise<{ sessionId: string }> | undefined;
    const prototype = PiSessionStore.prototype as unknown as { load(): Promise<unknown> };
    const read = prototype.load;
    const spy = vi.spyOn(prototype, "load").mockImplementation(async function (this: PiSessionStore) {
      if (slowNextRead) { slowNextRead = false; await (replacing = r.adapter.piNative.newSession(sessionId)); }
      return read.call(this);
    });
    cleanups.push(async () => { spy.mockRestore(); });
    // The requester's check passes every time; its last call, after Pi took the write, is the last check before the record.
    const outcome = await live.setModel({ provider: "fakeprov2", modelId: "dup-model" }, { isCurrent: async () => { if (taken()) slowNextRead = true; return true; } }).catch(error => error as Error);
    expect(replacing).toBeDefined();
    const replacement = await replacing!;
    const sessions = await records(r);
    expect(sessions[sessionId]?.modelSource).toBeUndefined();
    expect(sessions[replacement.sessionId]?.modelSource).toBeUndefined();
    expect(outcome).toMatchObject({ name: "PiNativeRejectedError", reason: "not-found" });
    expect((outcome as Error).message).toMatch(/not recorded/);
  });

  it("stops applying a Bot default when the session is replaced under it", async () => {
    const { held, pi } = holding();
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov2/dup-model", effort: "high" }, pi });
    const { sessionId } = await r.adapter.createSession(1);
    const turn = failure(r.adapter.sendUserMessage(sessionId, message("hi")));
    await waitFor(() => Boolean(held.release));
    const process = r.spawner.last();
    const replacement = await r.adapter.piNative.newSession(sessionId);
    held.release!();
    expect(await turn).toMatchObject({ reason: "not-found" });
    // Neither the effort nor the message went to a session nobody sent them to.
    expect(writes(process).map(command => command.type)).toEqual(["set_model"]);
    expect(commands(process, "prompt")).toEqual([]);
    // And neither session is on record as having the default applied.
    const sessions = await records(r);
    expect(sessions[sessionId]?.appliedBotDefault).toBeUndefined();
    expect(sessions[replacement.sessionId]?.appliedBotDefault).toBeUndefined();
    // The next message runs normally, in the session the process serves now.
    const next = await r.adapter.sendUserMessage(replacement.sessionId, message("again"));
    expect(next).toMatchObject({ text: "ok", sessionId: replacement.sessionId });
    expect((await records(r))[replacement.sessionId]?.appliedBotDefault).toBe(piBotDefaultFingerprint("fakeprov2/dup-model", "high"));
  });
});

describe("PiRpcAdapter error identity", () => {
  it("keeps the Pi RPC type on a provider failure, so a bare status is still recognised", async () => {
    const r = await rig({ pi: { onPrompt: run => { run.reply("", { stopReason: "error", errorMessage: "429: {\"message\":\"rate limit\"}\n  /synthetic/accounts/someone/pi/trace.log" }); run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    const error = await failure(r.adapter.sendUserMessage(sessionId, message("x")));
    expect(error).toBeInstanceOf(PiRpcCommandError);
    expect(error.message).toBe("429: {\"message\":\"rate limit\"}");
    expect(classifyFailure(error)).toBe("engine-rate-limit");
  });

  it("carries the provider's status and explanation of a failed model request, sanitized", async () => {
    const raw = "OpenAI API error (400): {\"type\":\"invalid_request_error\",\"code\":\"model_not_found\",\"message\":\"The 'gpt-4' model is not supported when using Codex with a ChatGPT account.\"}";
    const r = await rig({ pi: { onPrompt: run => { run.reply("", { stopReason: "error", errorMessage: raw }); run.finish(); } } });
    const error = await failure(r.adapter.sendUserMessage((await r.adapter.createSession(1)).sessionId, message("x")));
    expect(error).toBeInstanceOf(PiRpcCommandError);
    expect((error as PiRpcCommandError).provider).toEqual({ status: 400, code: "model_not_found", reason: "The 'gpt-4' model is not supported when using Codex with a ChatGPT account." });
    expect(classifyFailure(error)).toBe("engine-request-rejected");
    // A command Pi refused is not a model request: it carries no provider explanation.
    const none = await rig({ pi: { models: [], model: undefined } });
    const refused = await failure(none.adapter.sendUserMessage((await none.adapter.createSession(1)).sessionId, message("hi")));
    expect((refused as PiRpcCommandError).provider).toBeUndefined();
  });

  it("keeps the type on a rejected prompt and on a failed start, with owner-facing wording", async () => {
    const none = await rig({ pi: { models: [], model: undefined } });
    const noModel = await failure(none.adapter.sendUserMessage((await none.adapter.createSession(1)).sessionId, message("hi")));
    expect(noModel).toBeInstanceOf(PiRpcCommandError);
    expect((noModel as PiRpcCommandError).kind).toBe("no-model");
    expect(noModel.message).toMatch(/^Pi has no usable model\./);

    const broken = await rig({ pi: { exitAtStart: { code: 1, stderr: "Error: bad flag\n" } } });
    const start = await failure(broken.adapter.sendUserMessage((await broken.adapter.createSession(1)).sessionId, message("hi")));
    expect(start).toBeInstanceOf(PiStartupError);
    expect((start as PiStartupError).reason).toBe("exit");
    expect(start.message).toBe("Pi exited during startup: Error: bad flag");
    expect(classifyFailure(start)).toBe("engine-cli");
  });

  it("stores the model scope through the shared codec and hands Pi the native pair", async () => {
    const odd = fakePiModel("corp/gateway", "team model:v1%");
    const r = await rig({ pi: { models: [fakePiModel("fakeprov", "dup-model"), odd] } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const scoped = await r.adapter.piNative.setModelScope(sessionId, [{ provider: "corp/gateway", modelId: "team model:v1%" }]);
    // A provider with a slash, a model with a space and a literal percent sign come back exactly.
    expect(scoped.scope).toEqual([{ provider: "corp/gateway", modelId: "team model:v1%" }]);
    expect(JSON.parse(await readFile(path.join(r.stateDir, "pi", "state.json"), "utf8")).scopedModels).toEqual(["corp%2Fgateway/team%20model:v1%25"]);
    const args = r.spawner.last().args;
    expect(args[args.indexOf("--models") + 1]).toBe("corp/gateway/team model:v1%");
  });
});

describe("PiRpcAdapter follow-up boundaries", () => {
  it("defers the implemented built-ins that need an idle session, instead of treating them as terminal-only", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ pi: { onPrompt: async run => { await gate; run.reply("done"); run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("long");
    const turn = r.adapter.sendUserMessage(sessionId, input);
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    for (const text of ["/trust yes", "/import /synthetic/x.jsonl", "/scoped-models clear"]) expect(await r.adapter.steerActiveTurn(sessionId, { text })).toBe(true);
    release(); await turn;
    const texts = input.events.filter(event => event.type === "assistant_text").map(event => event.text);
    expect(texts).toEqual(expect.arrayContaining([
      "/trust can run once the current reply has finished.",
      "/import can run once the current reply has finished.",
      "/scoped-models can run once the current reply has finished.",
    ]));
    expect(commands(r.spawner.last(), "steer")).toHaveLength(0);
    expect(r.spawner.processes).toHaveLength(1);
  });

  it("reads Pi's default without starting the owner's MCP servers", async () => {
    const seen: Array<string[] | undefined> = [];
    const r = await rig({ config: { approvalMode: "bypass", model: "fakeprov2/dup-model" }, options: { queryCatalogFn: async input => { seen.push(input.extraArgs); return { models: [], current: { provider: "fakeprov", modelId: "dup-model", thinkingLevel: "medium" } }; } } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("a"));
    await r.writeConfig({ approvalMode: "bypass" });
    await r.adapter.sendUserMessage(sessionId, message("b"));
    expect(seen).toEqual([["--no-mcp"]]);
  });

  it("cancels an editor dialog too large for the card and says so, rather than returning cut text as the edit", async () => {
    const big = "x".repeat(16_001);
    const asked: EngineApprovalRequest[] = [];
    const r = await rig({ pi: { onPrompt: run => {
      run.process.ui({ id: "big", method: "editor", title: "Edit", prefill: big });
      run.process.ui({ id: "fits", method: "editor", title: "Edit small", prefill: "x".repeat(16_000) });
      run.process.on("ui-response", () => { if (run.process.uiResponses.length === 2) { run.reply("ok"); run.finish(); } });
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("go", { onApprovalRequest: async request => { asked.push(request); const q = (request.toolInput as { questions: Array<{ question: string }> }).questions[0]!; return { behavior: "allow", updatedInput: { answers: { [q.question]: "edited" } } }; } });
    await r.adapter.sendUserMessage(sessionId, input);
    expect(r.spawner.last().uiResponses).toEqual(expect.arrayContaining([
      { type: "extension_ui_response", id: "big", cancelled: true },
      { type: "extension_ui_response", id: "fits", value: "edited" },
    ]));
    expect(asked).toHaveLength(1);
    const notice = input.events.filter(event => event.type === "assistant_text").map(event => event.text).find(text => /16,001 characters/.test(text));
    expect(notice).toMatch(/^\[Pi\] An extension asked to edit 16,001 characters.*cancelled and the original text is unchanged/);
  });
});

describe("PiRpcAdapter settings errors name the model in canonical form", () => {
  it("leaves no whitespace in the identity the Host's settings-error reader has to take whole", async () => {
    const r = await rig({ pi: { models: [fakePiModel("fakeprov", "dup-model"), fakePiModel("corp gateway", "My Model", { reasoning: false })] } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    await r.adapter.piNative.setModel(sessionId, { provider: "corp gateway", modelId: "My Model" });
    const unsupported = await failure(r.adapter.piNative.setThinkingLevel(sessionId, "high"));
    expect(unsupported.message).toBe('Invalid model selection: corp%20gateway/My%20Model has no "high" effort (available: off)');
    const unavailable = await failure(r.adapter.piNative.setModel(sessionId, { provider: "corp gateway", modelId: "Other Model" }));
    expect(unavailable.message).toMatch(/^Invalid model selection: corp%20gateway\/Other%20Model is not available in Pi\./);
    expect(classifyFailure(unsupported)).toBe("engine-settings");
    expect(classifyFailure(unavailable)).toBe("engine-settings");
  });
});

/**
 * Input typed while a run streams, against what Pi 1.5.2 does natively (lab probes o01–o03):
 * `!`/`!!` run in Pi's shell at once; steer refuses a registered extension command; steer expands
 * templates and skills; a steer that arrives after the last reply is parked and would otherwise be
 * delivered into the next, unrelated run.
 */
describe("PiRpcAdapter input during a run", () => {
  const EXT_REFUSAL = (name: string) => `Extension command "/${name}" cannot be queued. Use prompt() or execute the command when not streaming.`;
  async function running(config: Record<string, unknown> = { approvalMode: "bypass" }, extra: Partial<CodexUserMessageInput> = {}, pi: FakePiOptions = {}) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ config, pi: { onPrompt: async run => { await gate; run.reply("done"); run.finish(); }, ...pi } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("long", extra);
    const turn = r.adapter.sendUserMessage(sessionId, input);
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    return { r, sessionId, input, turn, release, process: r.spawner.last() };
  }
  const texts = (events: EngineStreamEvent[]) => events.filter(event => event.type === "assistant_text").map(event => event.text);

  it.each([
    { text: "!echo hi", command: "echo hi", excluded: false },
    { text: "  !!pwd  ", command: "pwd", excluded: true },
  ])("runs $text in Pi's shell at once instead of steering the model with it", async ({ text, command, excluded }) => {
    const { r, sessionId, input, turn, release, process } = await running();
    expect(await r.adapter.steerActiveTurn(sessionId, { text, throwOnError: true })).toBe(true);
    expect(commands(process, "steer")).toHaveLength(0);
    expect(commands(process, "bash")).toEqual([expect.objectContaining({ command, ...(excluded ? { excludeFromContext: true } : {}) })]);
    release(); await turn;
    const output = texts(input.events).findIndex(line => line.includes("out"));
    expect(output).toBeGreaterThanOrEqual(0);
    expect(input.events.findIndex(event => event.type === "result")).toBeGreaterThan(input.events.findIndex(event => event.type === "assistant_text" && event.text.includes("out")));
  });

  it("asks in normal mode for every `!`, answers the request before the owner decides, and runs it once inside the same turn", async () => {
    let decide!: (decision: EngineApprovalDecision) => void;
    const asked: string[] = [];
    const { r, sessionId, input, turn, release, process } = await running({ approvalMode: "normal" }, {
      onApprovalRequest: request => { asked.push(`${request.toolName}:${JSON.stringify(request.toolInput)}`); return new Promise<EngineApprovalDecision>(resolve => { decide = resolve; }); },
    });
    // Admitted once the card is up: the Hub's steer call must not wait for a person.
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "!rm -rf build", throwOnError: true })).toBe(true);
    expect(asked).toEqual(['bash:{"command":"rm -rf build"}']);
    expect(commands(process, "bash")).toHaveLength(0);
    // The run finishes while the owner is still deciding; the turn waits for the command it accepted.
    release();
    let ended = false; void turn.then(() => { ended = true; }, () => { ended = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(ended).toBe(false);
    decide(allow("session"));
    const response = await turn;
    expect(commands(process, "bash").map(command => command.command)).toEqual(["rm -rf build"]);
    expect(texts(input.events).some(line => line.includes("out"))).toBe(true);
    expect(response.text).toBe("done");
    // A session-scope answer is not a standing grant for typed shell commands.
    const again = message("next", { onApprovalRequest: async request => { asked.push(request.toolName); return { behavior: "deny" }; } });
    await r.adapter.sendUserMessage(sessionId, message("!rm -rf build", { onApprovalRequest: again.onApprovalRequest! }));
    expect(asked.at(-1)).toBe("bash");
    expect(commands(process, "bash")).toHaveLength(1);
  });

  it("never runs a `!` that was denied, could not be asked, or whose turn was stopped while asking", async () => {
    const denied = await running({ approvalMode: "normal" }, { onApprovalRequest: async () => ({ behavior: "deny" }) });
    expect(await denied.r.adapter.steerActiveTurn(denied.sessionId, { text: "!touch x" })).toBe(true);
    denied.release(); await denied.turn;
    expect(commands(denied.process, "bash")).toHaveLength(0);
    expect(texts(denied.input.events)).toContain("Not approved. Nothing was run.");

    const unasked = await running({ approvalMode: "normal" });
    expect(await unasked.r.adapter.steerActiveTurn(unasked.sessionId, { text: "!touch x" })).toBe(true);
    unasked.release(); await unasked.turn;
    expect(commands(unasked.process, "bash")).toHaveLength(0);
    expect(texts(unasked.input.events).some(line => /need your approval/.test(line))).toBe(true);

    const controller = new AbortController();
    const stopped = await running({ approvalMode: "normal" }, { abortSignal: controller.signal, onApprovalRequest: () => new Promise<EngineApprovalDecision>(() => {}) });
    expect(await stopped.r.adapter.steerActiveTurn(stopped.sessionId, { text: "!touch x" })).toBe(true);
    controller.abort();
    await expect(stopped.turn).rejects.toThrow(/aborted/);
    expect(commands(stopped.process, "bash")).toHaveLength(0);
  });

  it("treats a bare `!` as text, as Pi's editor does", async () => {
    const { r, sessionId, turn, release, process } = await running();
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "!!" })).toBe(true);
    expect(commands(process, "bash")).toHaveLength(0);
    expect(commands(process, "steer").map(command => command.message)).toEqual(["!!"]);
    release(); await turn;
  });

  it("refuses a registered extension command before anything reaches Pi, so it can run as a turn of its own", async () => {
    const { r, sessionId, turn, release, process } = await running(undefined, {}, { commands: [{ name: "labcmd", source: "extension" }, { name: "labtpl", source: "prompt" }, { name: "skill:labskill", source: "skill" }] });
    const error = await failure(r.adapter.steerActiveTurn(sessionId, { text: "/labcmd now", throwOnError: true }));
    expect(error).toBeInstanceOf(EngineSteeringRejectedError);
    expect((error as EngineSteeringRejectedError).reason).toBe("unsupported");
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "/labcmd now" })).toBe(false);
    expect(process.received.some(command => String(command.message ?? "").startsWith("/labcmd"))).toBe(false);
    // Templates and skills are steered as typed; Pi expands them itself (o02-A).
    expect(await r.adapter.steerActiveTurn(sessionId, { text: " /labtpl hi " })).toBe(true);
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "/skill:labskill go" })).toBe(true);
    expect(commands(process, "steer").map(command => command.message)).toEqual(["/labtpl hi", "/skill:labskill go"]);
    release(); await turn;
  });

  it("reports Pi's own refusal of a steer as a definite rejection, never as an uncertain delivery", async () => {
    const { r, sessionId, turn, release } = await running(undefined, {}, {
      onCommand: (command, process) => {
        if (command.type === "steer" && String(command.message).startsWith("/late")) { process.fail(command, EXT_REFUSAL("late")); return true; }
      },
    });
    // The command registered after the adapter looked: Pi refuses it and nothing is queued.
    const error = await failure(r.adapter.steerActiveTurn(sessionId, { text: "/late x", throwOnError: true }));
    expect(error).toBeInstanceOf(EngineSteeringRejectedError);
    expect((error as EngineSteeringRejectedError).reason).toBe("not_ready");
    release(); await turn;
  });

  it("does not steer once the last reply ended without tools: Pi would park the text for the next run", async () => {
    let finish!: () => void;
    const r = await rig({ pi: { onPrompt: async run => { run.reply("final answer"); await new Promise<void>(resolve => { finish = resolve; }); run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    const turn = r.adapter.sendUserMessage(sessionId, message("go"));
    await waitFor(() => Boolean(finish));
    await waitFor(() => r.spawner.last().received.some(command => command.type === "prompt"));
    await new Promise(resolve => setTimeout(resolve, 10));
    const error = await failure(r.adapter.steerActiveTurn(sessionId, { text: "one more thing", throwOnError: true }));
    expect((error as EngineSteeringRejectedError).reason).toBe("not_ready");
    expect(commands(r.spawner.last(), "steer")).toHaveLength(0);
    // A live command still runs: it does not depend on the model reading it.
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "/thinking high" })).toBe(true);
    finish(); await turn;
  });

  it("hands back a steer Pi parked after the run instead of letting it reach the next turn", async () => {
    const { r, sessionId, input, turn, release, process } = await running();
    r.adapter.piNative.subscribe(sessionId, () => {});
    const native: PiNativeEvent[] = [];
    r.adapter.piNative.subscribe(sessionId, event => { native.push(event); });
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "also update the changelog" })).toBe(true);
    // The fake leaves the steer queued when the run ends: what Pi 1.5.2 does with one that arrives late (o03).
    release(); await turn;
    expect(commands(process, "clear_queue")).toHaveLength(1);
    expect(texts(input.events).some(line => line.includes("also update the changelog") && /did not reach the model/.test(line))).toBe(true);
    expect(native.some(event => event.type === "editor_text" && event.text === "also update the changelog")).toBe(true);
    expect((await r.adapter.piNative.getState(sessionId)).pending).toEqual({ steering: [], followUp: [] });
    const next = message("unrelated");
    await r.adapter.sendUserMessage(sessionId, next);
    expect(process.queue).toEqual({ steering: [], followUp: [] });
  });

  it("leaves a delivered steer alone and hands back exactly what Pi still holds, expanded templates included", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ pi: { onPrompt: async run => {
      await gate;
      // Pi took the first steer into the run; the second arrived late and stayed queued, expanded.
      run.process.queue = { steering: ["TEMPLATE-EXPANDED hi"], followUp: [] };
      run.emit({ type: "queue_update", steering: ["TEMPLATE-EXPANDED hi"], followUp: [] });
      run.reply("done"); run.finish();
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("long");
    const turn = r.adapter.sendUserMessage(sessionId, input);
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "first" })).toBe(true);
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "/labtpl hi" })).toBe(true);
    release(); await turn;
    const handed = texts(input.events).find(line => /did not reach the model/.test(line))!;
    // clear_queue is the authority: the template as Pi expanded it, never a guess from the order of sends.
    expect(handed).toContain("TEMPLATE-EXPANDED hi");
    expect(handed).not.toContain("first");
  });

  it("trims typed input before looking for a command, as Pi's editor does, also between runs", async () => {
    const r = await rig();
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("  !echo hi  "));
    expect(commands(r.spawner.last(), "bash").map(command => command.command)).toEqual(["echo hi"]);
    await r.adapter.sendUserMessage(sessionId, message("  /labtpl hi  ", { turnInstructions: "PRIVATE-TURN" }));
    const prompt = commands(r.spawner.last(), "prompt").at(-1)!;
    expect(prompt.message).toBe("/labtpl hi");
  });

  it("lists the live process's native commands through the live handle, without the bridge's own, and starts nothing", async () => {
    const r = await rig({ pi: { commands: [{ name: "labcmd", description: "lab", source: "extension" }, { name: "tarobird-bridge", source: "extension" }, { name: "skill:labskill", source: "skill" }] } });
    const { sessionId } = await r.adapter.createSession(1);
    expect(r.adapter.piNative.getLiveSession!(sessionId)).toBeUndefined();
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    expect(await live.listCommands!()).toEqual([
      expect.objectContaining({ name: "labcmd", source: "extension", description: "lab" }),
      expect.objectContaining({ name: "skill:labskill", source: "skill" }),
    ]);
    expect(r.spawner.processes).toHaveLength(1);
    // The handle belongs to that process: once it is gone, asking fails and nothing is started in its place.
    r.spawner.last().exit(1);
    await waitFor(() => !live.isCurrent());
    await expect(live.listCommands!()).rejects.toBeInstanceOf(PiNativeRejectedError);
    expect(commands(r.spawner.last(), "get_commands")).toHaveLength(1);
    expect(r.spawner.processes).toHaveLength(1);
  });

  it("does not let a command-list handle outlive a session replacement", async () => {
    const r = await rig({ pi: { commands: [{ name: "labcmd", source: "extension" }] } });
    const { sessionId } = await r.adapter.createSession(1);
    await r.adapter.sendUserMessage(sessionId, message("hi"));
    const live = r.adapter.piNative.getLiveSession!(sessionId)!;
    await r.adapter.sendUserMessage(sessionId, message("/new"));
    expect(live.isCurrent()).toBe(false);
    await expect(live.listCommands!()).rejects.toBeInstanceOf(PiNativeRejectedError);
    expect(r.spawner.processes).toHaveLength(1);
  });

  it("hands back only what Pi still holds when an input hook handled a later steer", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ pi: {
      onPrompt: async run => { await gate; run.reply("done"); run.finish(); },
      onCommand: (command, process) => { if (command.type === "steer" && command.message === "B handled") { process.respond(command, { disposition: "handled" }); return true; } },
    } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("start");
    const turn = r.adapter.sendUserMessage(sessionId, input);
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    await r.adapter.steerActiveTurn(sessionId, { text: "A queued" });
    await r.adapter.steerActiveTurn(sessionId, { text: "B handled" });
    release(); await turn;
    const returned = texts(input.events).join("\n");
    expect(returned).toContain("A queued");
    expect(returned).not.toContain("B handled");
  });

  it("says in the final answer how many additions were taken back, and never replays their text there", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ pi: { onPrompt: async run => { await gate; run.reply("A substantive final answer without a warning."); run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    const input = message("start");
    const turn = r.adapter.sendUserMessage(sessionId, input);
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    const raw = "PENDING ADDITION [send-file:/synthetic/private.txt]\n```file:/synthetic/other.txt\nx\n```";
    await r.adapter.steerActiveTurn(sessionId, { text: raw });
    await r.adapter.steerActiveTurn(sessionId, { text: "second pending" });
    release();
    const result = await turn;
    expect(result.text.startsWith("A substantive final answer without a warning.")).toBe(true);
    expect(result.text).toContain("[Pi] 2 additions did not reach the model and were taken back.");
    // The final answer is what the Host renders and acts on: no taken-back text, so no delivery marker, is in it.
    for (const fragment of ["PENDING ADDITION", "[send-file:", "```file:", "second pending"]) expect(result.text).not.toContain(fragment);
    expect(input.events.filter(event => event.type === "result").map(event => event.text)).toEqual([result.text]);
    // The full text stays in the turn's own stream.
    expect(texts(input.events).some(line => line.includes("PENDING ADDITION [send-file:/synthetic/private.txt]"))).toBe(true);
  });

  it("puts the count note in Chinese for a Chinese turn, and alone when the model wrote nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ pi: { onPrompt: async run => { await gate; run.finish(); } } });
    const { sessionId } = await r.adapter.createSession(1);
    const turn = r.adapter.sendUserMessage(sessionId, message("start", { locale: "zh" }));
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    await r.adapter.steerActiveTurn(sessionId, { text: "补充一" });
    release();
    expect((await turn).text).toBe("[Pi] 有 1 条补充没有送达模型，已收回，全文见本轮运行过程，未自动重发。");
  });

  it("says in the final answer when Pi could not confirm its queue at the end of a turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const r = await rig({ pi: { onPrompt: async run => { await gate; run.reply("answer"); run.finish(); }, onCommand: (command, process) => { if (command.type === "clear_queue") { process.fail(command, "synthetic clear failure"); return true; } } } });
    const { sessionId } = await r.adapter.createSession(1);
    const turn = r.adapter.sendUserMessage(sessionId, message("start"));
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    await r.adapter.steerActiveTurn(sessionId, { text: "UNCONFIRMED [send-image:/synthetic/x.png]" });
    release();
    const result = await turn;
    expect(result.text).toMatch(/^answer\n\n\[Pi\] Pi did not confirm whether additions from this turn were still pending/);
    expect(result.text).not.toContain("UNCONFIRMED");
    expect(result.text).not.toContain("[send-image:");
    const process = r.spawner.last();
    expect(process.exitCode !== null || process.signalCode !== null).toBe(true);
  });

  it("hands back long text in full in the turn's own stream", async () => {
    const { r, sessionId, input, turn, release } = await running();
    const text = `${"X".repeat(2_200)}RECOVERY-TAIL`;
    await r.adapter.steerActiveTurn(sessionId, { text });
    release(); await turn;
    expect(texts(input.events).join("\n")).toContain(text);
  });

  it("after a stop, a steer that Pi queued only after the first clear is cleared too, and never reaches the next turn", async () => {
    let accept!: () => void;
    const r = await rig({ pi: { onPrompt: async () => {}, onCommand: (command, process) => {
      if (command.type === "steer") { accept = () => { process.queue.steering.push(String(command.message)); process.respond(command, { disposition: "queued" }); }; return true; }
    } } });
    const { sessionId } = await r.adapter.createSession(1);
    const controller = new AbortController();
    const input = message("start", { abortSignal: controller.signal });
    const turn = r.adapter.sendUserMessage(sessionId, input).catch(error => error);
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    const steer = r.adapter.steerActiveTurn(sessionId, { text: "LATE STOP INPUT" });
    await waitFor(() => Boolean(accept));
    controller.abort();
    await waitFor(() => commands(r.spawner.last(), "clear_queue").length > 0);
    accept(); await steer; await turn;
    const process = r.spawner.last();
    expect(process.queue.steering).toEqual([]);
    expect(process.exitCode).toBeNull();
    expect(texts(input.events).some(line => line.includes("LATE STOP INPUT") && /stopped/.test(line))).toBe(true);
  });

  it("does not reuse a process whose stop clear_queue was refused: the queue was not cleared, so the process ends and says so", async () => {
    const r = await rig({ pi: { onPrompt: async () => {}, onCommand: (command, process) => { if (command.type === "clear_queue") { process.fail(command, "synthetic clear failure"); return true; } } } });
    const { sessionId } = await r.adapter.createSession(1);
    const controller = new AbortController();
    const input = message("start", { abortSignal: controller.signal });
    const turn = r.adapter.sendUserMessage(sessionId, input).catch(error => error);
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    await r.adapter.steerActiveTurn(sessionId, { text: "NOT CLEARED" });
    controller.abort(); await turn;
    const process = r.spawner.last();
    expect(process.exitCode !== null || process.signalCode !== null).toBe(true);
    // Unconfirmed is never reported as "not delivered", and nothing is sent again.
    expect(texts(input.events).some(line => /did not confirm/.test(line))).toBe(true);
    expect(commands(process, "steer")).toHaveLength(1);
  });

  it("ends the process when a stopped turn's in-flight steer never answers, so it cannot reach the next turn", async () => {
    const r = await rig({ pi: { onPrompt: async () => {}, onCommand: command => command.type === "steer" ? true : undefined } });
    const { sessionId } = await r.adapter.createSession(1);
    const controller = new AbortController();
    const turn = r.adapter.sendUserMessage(sessionId, message("start", { abortSignal: controller.signal })).catch(error => error);
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    void r.adapter.steerActiveTurn(sessionId, { text: "NEVER ANSWERED" }).catch(() => {});
    await waitFor(() => commands(r.spawner.last(), "steer").length > 0);
    controller.abort(); await turn;
    expect(r.spawner.last().exitCode !== null || r.spawner.last().signalCode !== null).toBe(true);
  });

  it("does not swallow `/session <args>` when an extension of that name exists: it is that command, so it waits for a turn of its own", async () => {
    const { r, sessionId, input, turn, release, process } = await running(undefined, {}, { commands: [{ name: "session", source: "extension" }, { name: "copy", source: "prompt" }] });
    const error = await failure(r.adapter.steerActiveTurn(sessionId, { text: "/session custom-args", throwOnError: true }));
    expect((error as EngineSteeringRejectedError).reason).toBe("unsupported");
    // A template of a built-in's name with arguments is that template: Pi expands it as a steer.
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "/copy notes" })).toBe(true);
    expect(commands(process, "steer").map(command => command.message)).toEqual(["/copy notes"]);
    // Without arguments it is still the built-in.
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "/session" })).toBe(true);
    release(); await turn;
    expect(texts(input.events).some(line => /session/i.test(line) && line !== "done")).toBe(true);
  });

  it("hands back what was still queued when the turn is stopped, like Pi's Esc", async () => {
    const r = await rig({ pi: { onPrompt: () => { /* runs until stopped */ } } });
    const { sessionId } = await r.adapter.createSession(1);
    const controller = new AbortController();
    const input = message("long", { abortSignal: controller.signal });
    const turn = r.adapter.sendUserMessage(sessionId, input);
    await waitFor(() => Boolean(r.spawner.processes[0]?.activeRun));
    expect(await r.adapter.steerActiveTurn(sessionId, { text: "please also update the changelog" })).toBe(true);
    controller.abort();
    await expect(turn).rejects.toThrow(/aborted/);
    expect(texts(input.events).some(line => line.includes("please also update the changelog") && /stopped/.test(line))).toBe(true);
  });
});
