import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KimiAcpAdapter, type KimiChildProcess, type SpawnKimi } from "../src/codex/kimi-acp-adapter.js";
import type { KimiHookEvent } from "../src/codex/kimi-hook-relay.js";

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: any };

class FakeReadable extends EventEmitter {
  emitData(chunk: string) { this.emit("data", chunk); }
  end() { this.emit("end"); }
}

class FakeServer {
  readonly messages: Message[] = [];
  readonly pendingPrompts = new Map<number | string, Message>();
  capabilities: Record<string, unknown> = { loadSession: true, sessionCapabilities: { list: {}, fork: {}, delete: {}, close: {} } };
  forkError: string | undefined;
  deleteError: string | undefined;
  autoCancel = true;
  forkResult: unknown = undefined;
  private buffer = "";
  private nextId = 50_000;
  constructor(private readonly stdout: FakeReadable, readonly sessionId: string, readonly forkId: string) {}
  receive(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) this.handle(JSON.parse(line) as Message);
  }
  requests(method: string) { return this.messages.filter((message) => message.method === method); }
  responseTo(id: number) { return this.messages.find((message) => message.id === id && !message.method); }
  update(update: Record<string, unknown>, sessionId: string) { this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }); }
  requestPermission(sessionId: string): number {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "w1", title: "Write file", kind: "edit" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
    return id;
  }
  respondPrompt(result: Record<string, unknown> = { stopReason: "end_turn" }) {
    const [id] = this.pendingPrompts.entries().next().value as [number | string, Message];
    this.pendingPrompts.delete(id);
    this.send({ jsonrpc: "2.0", id, result });
  }
  private handle(message: Message) {
    this.messages.push(message);
    if (!message.method) return;
    const reply = (result: unknown) => this.send({ jsonrpc: "2.0", id: message.id, result });
    const configOptions = [{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "yolo", options: [{ value: "default", name: "Default" }, { value: "yolo", name: "YOLO" }] }];
    switch (message.method) {
      case "initialize": return reply({ protocolVersion: 1, agentInfo: { name: "Fake Kimi", version: "test" }, agentCapabilities: this.capabilities, authMethods: [] });
      case "session/new": return reply({ sessionId: this.sessionId, configOptions });
      case "session/fork":
        if (this.forkError) return this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error", data: { details: this.forkError } } });
        return reply(this.forkResult ?? { sessionId: this.forkId, configOptions });
      case "session/set_config_option": return reply({ configOptions: configOptions.map((option) => ({ ...option, currentValue: message.params!.value })) });
      case "session/prompt": this.pendingPrompts.set(message.id!, message); return;
      case "session/cancel": {
        if (!this.autoCancel) return;
        const pending = [...this.pendingPrompts.entries()].find(([, prompt]) => prompt.params?.sessionId === message.params?.sessionId);
        if (pending) { this.pendingPrompts.delete(pending[0]); this.send({ jsonrpc: "2.0", id: pending[0], result: { stopReason: "cancelled" } }); }
        return;
      }
      case "session/close": return reply({});
      case "session/delete":
        if (this.deleteError) return this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error", data: { details: this.deleteError } } });
        return reply({});
      default: if (message.id !== undefined) this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported ${message.method}` } });
    }
  }
  private send(message: Message) { queueMicrotask(() => this.stdout.emitData(`${JSON.stringify(message)}\n`)); }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin: { write(chunk: string, callback?: (error?: Error | null) => void): boolean; end(cb?: () => void): void; destroy(): void };
  readonly server: FakeServer;
  constructor(readonly pid: number, sessionId: string, forkId: string) {
    super();
    this.server = new FakeServer(this.stdout, sessionId, forkId);
    this.stdin = { write: (chunk, callback) => { this.server.receive(chunk.toString()); callback?.(null); return true; }, end: (cb) => cb?.(), destroy: () => {} };
  }
  close(code: number | null) { this.emit("close", code, null); this.stdout.end(); }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met in time");
}

function harness(configure?: (server: FakeServer, index: number) => void, options: Partial<NonNullable<ConstructorParameters<typeof KimiAcpAdapter>[1]>> = {}) {
  const children: FakeChild[] = [];
  const killed: Array<number | undefined> = [];
  const spawnFn: SpawnKimi = () => {
    const index = children.length + 1;
    const child = new FakeChild(800 + index, "kimi-parent", "kimi-fork");
    configure?.(child.server, index);
    children.push(child);
    return child as unknown as KimiChildProcess;
  };
  const killProcessTreeFn = (pid: number | undefined) => {
    killed.push(pid);
    const child = children.find((candidate) => candidate.pid === pid);
    if (child) queueMicrotask(() => child.close(null));
  };
  const adapter = new KimiAcpAdapter("kimi", {
    spawnFn, killProcessTreeFn, workspacePath: "/tmp/kimi-side", idleWorkerTtlMs: 0, idleSweepIntervalMs: 0,
    turnTimeoutMs: null, inactivityTimeoutMs: null, ...options,
    syncWorkspaceInstructionsFn: vi.fn(async (_path: string, instructions: string | null) => instructions ?? ""),
  });
  return { adapter, children, killed };
}

async function idleParent(h: ReturnType<typeof harness>) {
  const turn = h.adapter.sendUserMessage("tarobot-kimi", { text: "Remember GUAVA-9", files: [] });
  await waitFor(() => h.children[0]?.server.pendingPrompts.size === 1);
  h.children[0]!.server.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } }, "kimi-parent");
  h.children[0]!.server.respondPrompt();
  await expect(turn).resolves.toMatchObject({ text: "OK", sessionId: "kimi-parent" });
}

const ask = (side: Awaited<ReturnType<KimiAcpAdapter["openSideSession"]>>, text: string, signal = new AbortController().signal) =>
  side.send({ text, onEngineEvent: () => {}, abortSignal: signal });

describe("Kimi native side forks", () => {
  it("reports native, non-concurrent, permission-enforced, deleted-on-close capability", () => {
    expect(harness().adapter.sideCapability()).toEqual({ context: "native", concurrent: false, readOnly: "enforced", residue: "deleted-on-close", seesInProgressTurn: false, attachments: { images: true, files: "text", paths: true } });
  });

  it("refuses a logical parent ID without spawning", async () => {
    const h = harness();
    await expect(h.adapter.openSideSession({ sourceSessionId: "tarobot-1" })).rejects.toThrow("no_main_session");
    expect(h.children).toHaveLength(0);
  });

  it("sends side images as ACP image blocks and text as embedded resources only when the runtime advertises them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-side-attachments-"));
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");
    await writeFile(path.join(root, "1-chart.png"), png);
    const files = [
      { attachmentId: "att_img", path: path.join(root, "1-chart.png"), name: "chart.png", mime: "image/png", size: png.length, kind: "image" as const },
      { attachmentId: "att_txt", path: path.join(root, "2-notes.ts"), name: "notes.ts", mime: "application/octet-stream", size: 12, kind: "text" as const, text: "const KIWI=1" },
      { attachmentId: "att_pdf", path: path.join(root, "3-spec.pdf"), name: "spec.pdf", mime: "application/pdf", size: 9, kind: "binary" as const },
    ];
    const h = harness((server, index) => { if (index === 2) server.capabilities = { ...server.capabilities, promptCapabilities: { image: true, embeddedContext: true } }; });
    try {
      await idleParent(h);
      const side = await h.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      const server = h.children[1]!.server;
      const answer = side.send({ text: "Compare", attachments: files, onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await waitFor(() => server.pendingPrompts.size === 1);
      const prompt = server.requests("session/prompt")[0]!.params!.prompt as Array<Record<string, any>>;
      expect(prompt.map((block) => block.type)).toEqual(["text", "image", "resource"]);
      expect(prompt[1]).toMatchObject({ mimeType: "image/png", data: png.toString("base64") });
      expect(prompt[2]!.resource).toMatchObject({ mimeType: "text/plain", text: "const KIWI=1" });
      expect(prompt[0]!.text).toContain(`Path: ${files[2]!.path}`);
      expect(prompt[0]!.text).not.toContain("const KIWI=1");
      server.respondPrompt();
      await answer;
      await side.dispose();

      const plain = harness();
      await idleParent(plain);
      const bare = await plain.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      await expect(bare.send({ text: "Look", attachments: [files[0]!], onEngineEvent: () => {}, abortSignal: new AbortController().signal })).rejects.toThrow("attachment_unsupported");
      expect(plain.children[1]!.server.requests("session/prompt")).toHaveLength(0);
      const inline = bare.send({ text: "Read", attachments: [files[1]!], onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await waitFor(() => plain.children[1]!.server.pendingPrompts.size === 1);
      const blocks = plain.children[1]!.server.requests("session/prompt")[0]!.params!.prompt as Array<Record<string, any>>;
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.text).toContain("const KIWI=1");
      plain.children[1]!.server.respondPrompt();
      await inline;
      await bare.dispose();
      await plain.adapter.destroy();
    } finally { await h.adapter.destroy(); await rm(root, { recursive: true, force: true }); }
  });

  it("releases an idle parent worker, forks in its own process, refuses permissions and deletes the fork", async () => {
    const h = harness();
    try {
      await idleParent(h);
      const parent = h.children[0]!;
      const opened = h.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      await waitFor(() => h.children.length === 2);
      const side = await opened;
      expect(h.killed).toContain(parent.pid);
      const server = h.children[1]!.server;
      expect(server.requests("session/fork")[0]!.params).toEqual({ sessionId: "kimi-parent", cwd: "/tmp/kimi-side", mcpServers: [] });
      expect(server.requests("session/set_config_option").map((message) => message.params)).toContainEqual({ sessionId: "kimi-fork", configId: "mode", value: "default" });
      expect(side.nativeId).toBe("kimi-fork");

      const events: unknown[] = [];
      const answer = side.send({ text: "Marker?", turnInstructions: "Side only.", onEngineEvent: (event) => { events.push(event); }, abortSignal: new AbortController().signal });
      await waitFor(() => server.pendingPrompts.size === 1);
      expect(JSON.stringify(server.requests("session/prompt")[0]!.params)).toContain("Marker?");
      expect(server.requests("session/prompt")[0]!.params!.sessionId).toBe("kimi-fork");
      const permission = server.requestPermission("kimi-fork");
      await waitFor(() => !!server.responseTo(permission));
      expect(server.responseTo(permission)!.result).toEqual({ outcome: { outcome: "cancelled" } });
      server.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ignored other session" } }, "kimi-parent");
      server.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "GUAVA" } }, "kimi-fork");
      server.update({ sessionUpdate: "tool_call", toolCallId: "r1", title: "Read", kind: "read", status: "completed" }, "kimi-fork");
      server.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "-9" } }, "kimi-fork");
      await new Promise((resolve) => setTimeout(resolve, 5));
      server.respondPrompt({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
      await expect(answer).resolves.toEqual({ text: "GUAVA\n\n-9", usage: { inputTokens: 10, outputTokens: 2 } });
      expect(events).toContainEqual({ type: "assistant_text", text: "GUAVA", delta: true });

      await side.dispose();
      expect(server.requests("session/close").map((message) => message.params)).toEqual([{ sessionId: "kimi-fork" }]);
      expect(server.requests("session/delete").map((message) => message.params)).toEqual([{ sessionId: "kimi-fork" }]);
      expect(h.killed).toContain(h.children[1]!.pid);
      await side.dispose();
      expect(server.requests("session/delete")).toHaveLength(1);
      await expect(ask(side, "again")).rejects.toThrow("expired");
    } finally { await h.adapter.destroy(); }
  });

  it("refuses a side conversation while the parent turn is running", async () => {
    const h = harness();
    try {
      const turn = h.adapter.sendUserMessage("tarobot-kimi", { text: "Long", files: [] });
      await waitFor(() => h.children[0]?.server.pendingPrompts.size === 1);
      await expect(h.adapter.openSideSession({ sourceSessionId: "kimi-parent" })).rejects.toThrow("busy");
      expect(h.children).toHaveLength(1);
      expect(h.killed).toHaveLength(0);
      h.children[0]!.server.respondPrompt();
      await turn;
    } finally { await h.adapter.destroy(); }
  });

  it("reports unsupported when the agent cannot fork and delete", async () => {
    const h = harness((server, index) => { if (index === 1) server.capabilities = { loadSession: true, sessionCapabilities: { list: {} } }; });
    try {
      await expect(h.adapter.openSideSession({ sourceSessionId: "kimi-parent" })).rejects.toThrow("unsupported");
      expect(h.children[0]!.server.requests("session/fork")).toHaveLength(0);
      expect(h.killed).toContain(h.children[0]!.pid);
    } finally { await h.adapter.destroy(); }
  });

  it("maps a parent held by another Kimi process to busy without deleting anything", async () => {
    const h = harness((server) => { server.forkError = "This session is in use by another Kimi Code process."; });
    try {
      await expect(h.adapter.openSideSession({ sourceSessionId: "kimi-parent" })).rejects.toThrow("busy");
      expect(h.children[0]!.server.requests("session/delete")).toHaveLength(0);
      expect(h.killed).toContain(h.children[0]!.pid);
    } finally { await h.adapter.destroy(); }
  });

  it("cancels only the side turn and expires after the side process exits", async () => {
    const h = harness();
    try {
      const side = await h.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      const server = h.children[0]!.server;
      const controller = new AbortController();
      const pending = ask(side, "Explain", controller.signal);
      await waitFor(() => server.pendingPrompts.size === 1);
      controller.abort();
      await expect(pending).rejects.toThrow("cancelled");
      await waitFor(() => server.requests("session/cancel").length === 1);
      expect(server.requests("session/cancel")[0]!.params).toEqual({ sessionId: "kimi-fork" });
      h.children[0]!.close(1);
      await expect(ask(side, "Still there?")).rejects.toThrow("expired");
      await side.dispose();
    } finally { await h.adapter.destroy(); }
  });

  it("deletes the exact fork from a fresh ACP process when in-process delete fails", async () => {
    const h = harness((server, index) => { if (index === 1) server.deleteError = "storage busy"; });
    try {
      const side = await h.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      await side.dispose();
      expect(h.children[0]!.server.requests("session/delete").map((message) => message.params)).toEqual([{ sessionId: "kimi-fork" }]);
      expect(h.killed).toContain(h.children[0]!.pid);
      expect(h.children[1]!.server.requests("session/delete").map((message) => message.params)).toEqual([{ sessionId: "kimi-fork" }]);
      expect(h.children.flatMap((child) => child.server.requests("session/delete").map((message) => message.params!.sessionId))).not.toContain("kimi-parent");
    } finally { await h.adapter.destroy(); }
  });

  it("deletes a crashed side process's fork from a fresh ACP process", async () => {
    const h = harness();
    try {
      const side = await h.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      h.children[0]!.close(1);
      await side.dispose();
      expect(h.children[0]!.server.requests("session/delete")).toHaveLength(0);
      expect(h.children[1]!.server.requests("session/delete").map((message) => message.params)).toEqual([{ sessionId: "kimi-fork" }]);
    } finally { await h.adapter.destroy(); }
  });

  it("reports a fork that could not be removed and accepts an already-missing one", async () => {
    const failing = harness((server) => { server.deleteError = "storage busy"; });
    try {
      const side = await failing.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      await expect(side.dispose()).rejects.toThrow(/storage busy/);
      await expect(side.dispose()).rejects.toThrow(/storage busy/);
    } finally { await failing.adapter.destroy().catch(() => undefined); }
    const missing = harness((server, index) => { server.deleteError = index === 1 ? "storage busy" : "Session not found: kimi-fork"; });
    try {
      const side = await missing.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      await expect(side.dispose()).resolves.toBeUndefined();
    } finally { await missing.adapter.destroy(); }
  });

  it("waits for a stopped native prompt before the next one and never reuses its late chunks", async () => {
    const h = harness((server) => { server.autoCancel = false; });
    try {
      const side = await h.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      const server = h.children[0]!.server;
      const controller = new AbortController();
      const first = ask(side, "Long answer", controller.signal);
      await waitFor(() => server.pendingPrompts.size === 1);
      controller.abort();
      await expect(first).rejects.toThrow("cancelled");
      const second = ask(side, "Short answer");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(server.requests("session/prompt")).toHaveLength(1);
      server.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late old chunk" } }, "kimi-fork");
      server.respondPrompt({ stopReason: "cancelled" });
      await waitFor(() => server.pendingPrompts.size === 1 && server.requests("session/prompt").length === 2);
      server.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new answer" } }, "kimi-fork");
      await new Promise((resolve) => setTimeout(resolve, 5));
      server.respondPrompt();
      await expect(second).resolves.toEqual({ text: "new answer" });
    } finally { await h.adapter.destroy(); }
  });

  it("refuses the next side turn when a stopped native prompt never settles", async () => {
    const h = harness((server) => { server.autoCancel = false; }, { cancelGraceMs: 20 });
    try {
      const side = await h.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      const server = h.children[0]!.server;
      const controller = new AbortController();
      const first = ask(side, "Long answer", controller.signal);
      await waitFor(() => server.pendingPrompts.size === 1);
      controller.abort();
      await expect(first).rejects.toThrow("cancelled");
      await expect(ask(side, "Next")).rejects.toThrow("busy");
      expect(server.requests("session/prompt")).toHaveLength(1);
    } finally { await h.adapter.destroy(); }
  });

  it.each([
    ["the parent id", { sessionId: "kimi-parent" }],
    ["an empty id", { sessionId: "" }],
    ["no id", {}],
  ])("never closes or deletes anything when the fork returns %s", async (_label, result) => {
    const h = harness((server) => { server.forkResult = result; });
    try {
      await expect(h.adapter.openSideSession({ sourceSessionId: "kimi-parent" })).rejects.toThrow(/distinct side session id/);
      for (const method of ["session/close", "session/delete", "session/cancel"]) expect(h.children.flatMap((child) => child.server.requests(method))).toHaveLength(0);
    } finally { await h.adapter.destroy(); }
  });

  it("identifies itself as TaroBot to the side ACP process", async () => {
    const h = harness();
    try {
      await h.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      expect(h.children[0]!.server.requests("initialize")[0]!.params!.clientInfo.name).toBe("tarobot");
    } finally { await h.adapter.destroy(); }
  });

  it("deletes open forks when the adapter is destroyed", async () => {
    const h = harness();
    await h.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
    await h.adapter.destroy();
    expect(h.children[0]!.server.requests("session/delete").map((message) => message.params)).toEqual([{ sessionId: "kimi-fork" }]);
  });
});

describe("Kimi side open versus a parent turn that has just started", () => {
  it("refuses instead of killing a parent worker that a concurrent turn has obtained but not yet prompted", async () => {
    const h = harness();
    const proto = KimiAcpAdapter.prototype as unknown as { getOrCreateWorker: (...args: unknown[]) => Promise<unknown> };
    const original = proto.getOrCreateWorker;
    try {
      await idleParent(h);
      const parent = h.children[0]!;
      let opened: Promise<unknown> | undefined;
      // Test-only interleaving: the side open is issued exactly when the main
      // turn has obtained its worker. Nothing on the main path is delayed; the
      // startup-lock release and runTurn that follow are the production awaits.
      vi.spyOn(proto, "getOrCreateWorker").mockImplementation(async function (this: KimiAcpAdapter, ...args: unknown[]) {
        const worker = await original.apply(this, args);
        if (!opened) {
          opened = this.openSideSession({ sourceSessionId: "kimi-parent" });
          void opened.catch(() => undefined); // Asserted below.
        }
        return worker;
      });
      const main = h.adapter.sendUserMessage("kimi-parent", { text: "Main follow-up", files: [] });
      await waitFor(() => opened !== undefined);
      await expect(opened!).rejects.toThrow("busy");
      await waitFor(() => parent.server.pendingPrompts.size === 1);
      expect(h.killed).not.toContain(parent.pid);
      expect(h.children).toHaveLength(1);
      parent.server.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } }, "kimi-parent");
      parent.server.respondPrompt();
      await expect(main).resolves.toMatchObject({ text: "Done" });
      vi.restoreAllMocks();
      // The claim ends with the turn, so the now idle parent can be released.
      const side = await h.adapter.openSideSession({ sourceSessionId: "kimi-parent" });
      expect(h.killed).toContain(parent.pid);
      await side.dispose();
    } finally { vi.restoreAllMocks(); await h.adapter.destroy(); }
  });

  it("settles accepted hook-relay events before judging the parent idle", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "kimi-side-hook-home-"));
    let deliver: ((event: KimiHookEvent) => Promise<void>) | undefined;
    let accepted: KimiHookEvent | undefined;
    const startHookRelayFn = async (options: { onEvent: (event: KimiHookEvent) => Promise<void> }) => {
      deliver = options.onEvent;
      return {
        env: { TAROCUB_KIMI_HOOK_URL: "http://127.0.0.1:9/unused", TAROCUB_KIMI_HOOK_TOKEN: "fixture" },
        // A real relay answers 202 before its handler runs; draining runs it.
        drainAcceptedEvents: async () => { const event = accepted; accepted = undefined; if (event) await deliver!(event); },
        close: async () => {},
      };
    };
    const h = harness(undefined, { engineHomePath: home, hookRelayEnabled: true, startHookRelayFn: startHookRelayFn as never });
    try {
      await idleParent(h);
      const parent = h.children[0]!;
      accepted = { hookEventName: "TaskStarted", sessionId: "kimi-parent", taskId: "bg-1", kind: "process", description: "Build", detached: true };
      await expect(h.adapter.openSideSession({ sourceSessionId: "kimi-parent" })).rejects.toThrow("busy");
      expect(accepted).toBeUndefined();
      expect(h.killed).not.toContain(parent.pid);
      expect(h.children).toHaveLength(1);
    } finally { await h.adapter.destroy(); await rm(home, { recursive: true, force: true }); }
  });
});
