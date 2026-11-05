import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";

class FakeStream extends EventEmitter {
  emitData(chunk: string) { this.emit("data", chunk); }
}
class FakeWritable {
  lines: string[] = [];
  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) this.lines.push(text);
    callback?.(null);
    return true;
  }
}
class FakeChild extends EventEmitter {
  stdin = new FakeWritable(); stdout = new FakeStream(); stderr = new FakeStream();
  kill() { return true; }
  close(code: number | null) { this.emit("close", code); }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not met in time");
}

function harness() {
  const children: FakeChild[] = [];
  const spawnFn = () => { const child = new FakeChild(); children.push(child); return child; };
  const adapter = new CodexAppServerAdapter("codex", "/tmp/side-fixture", spawnFn as never);
  const child = () => children.at(-1)!;
  const frames = () => (children.at(-1)?.stdin.lines ?? []).map((line) => JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown });
  const requests = (method: string) => frames().filter((frame) => frame.method === method);
  const respond = async (method: string, result: unknown, nth = 1) => {
    await waitFor(() => requests(method).length >= nth);
    child().stdout.emitData(JSON.stringify({ id: requests(method)[nth - 1]!.id, result }) + "\n");
  };
  const fail = async (method: string, message: string, nth = 1) => {
    await waitFor(() => requests(method).length >= nth);
    child().stdout.emitData(JSON.stringify({ id: requests(method)[nth - 1]!.id, error: { code: -32600, message } }) + "\n");
  };
  const emit = (method: string, params: Record<string, unknown>) => child().stdout.emitData(JSON.stringify({ method, params }) + "\n");
  const serverRequest = (id: string, method: string, params: Record<string, unknown>) => child().stdout.emitData(JSON.stringify({ id, method, params }) + "\n");
  const responsesTo = (id: string) => frames().filter((frame) => frame.id === id && frame.method === undefined);
  return { adapter, children, child, frames, requests, respond, fail, emit, serverRequest, responsesTo };
}

const CONFIG = { config: { mcp_servers: { fs_tools: { command: "fs-mcp" }, "web-search_2": { url: "https://example.invalid/mcp" } } } };

async function openSide(h: ReturnType<typeof harness>, source = "parent-thread", fork: Record<string, unknown> = { thread: { id: "side-thread", ephemeral: true } }) {
  const opened = h.adapter.openSideSession({ sourceSessionId: source });
  await h.respond("initialize", {});
  await h.respond("config/read", CONFIG);
  await h.respond("thread/fork", fork);
  if ((fork.thread as { ephemeral?: unknown } | undefined)?.ephemeral === true) await h.respond("thread/inject_items", {});
  return opened;
}

// Settle an unsafe fork too, so the pre-fix regression fails on the result
// instead of merely timing out waiting for an RPC the fix must never send.
async function attemptSide(h: ReturnType<typeof harness>, configRead = 1) {
  const forks = h.requests("thread/fork").length, injections = h.requests("thread/inject_items").length;
  const opened = h.adapter.openSideSession({ sourceSessionId: "parent-thread" });
  let settled = false; void opened.then(() => { settled = true; }, () => { settled = true; });
  await h.respond("config/read", { config: {} }, configRead);
  await waitFor(() => settled || h.requests("thread/fork").length > forks);
  if (!settled) {
    await h.respond("thread/fork", { thread: { id: `side-${forks}`, ephemeral: true } }, forks + 1);
    await h.respond("thread/inject_items", {}, injections + 1);
  }
  return opened;
}

describe("Codex native side conversations", () => {
  it("opens an opt-in side with inherited tools, search and network, without changing the parent", async () => {
    const h = harness();
    try {
      expect(h.adapter.sideCapability({ tools: "inherited" })).toMatchObject({ readOnly: "advisory", toolAccess: "inherited" });
      const opened = h.adapter.openSideSession({ sourceSessionId: "parent-thread", tools: "inherited" });
      await h.respond("initialize", {});
      await h.respond("thread/fork", { thread: { id: "side-thread", ephemeral: true } });
      await h.respond("thread/inject_items", {});
      const side = await opened;
      expect(h.requests("config/read")).toHaveLength(0);
      const fork = h.requests("thread/fork")[0]!.params!;
      expect(fork.config).toEqual({ "features.multi_agent": false, "features.multi_agent_v2": false, web_search: "live", "sandbox_workspace_write.network_access": true });
      // Without a Bot config the fork retains the native runtime's sandbox.
      expect(fork).not.toHaveProperty("sandbox");
      expect(JSON.stringify(h.requests("thread/inject_items")[0]!.params)).toContain("Use available search, network, browser, MCP and plugin tools");
      const answer = side.send({ text: "Research this", onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await h.respond("turn/start", { turn: { id: "side-turn" } });
      expect(h.requests("turn/start")[0]!.params).not.toHaveProperty("sandboxPolicy");
      h.emit("turn/completed", { threadId: "side-thread", turn: { id: "side-turn", status: "completed", items: [{ type: "agentMessage", text: "Researched" }] } });
      await expect(answer).resolves.toMatchObject({ text: "Researched" });
      await side.dispose();
      expect(h.requests("thread/unsubscribe")[0]!.params).toEqual({ threadId: "side-thread" });
      expect(h.requests("turn/interrupt")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });
  it("reports an honest native, concurrent, read-only capability", () => {
    const { adapter } = harness();
    expect(adapter.sideCapability()).toEqual({ context: "native", concurrent: true, readOnly: "enforced", residue: "none", seesInProgressTurn: false, attachments: { images: true, files: "any", paths: true } });
  });

  it("refuses a logical parent ID without starting, resuming or forking any thread", async () => {
    const h = harness();
    await expect(h.adapter.openSideSession({ sourceSessionId: "tarobot-123" })).rejects.toThrow("no_main_session");
    expect(h.children).toHaveLength(0);
  });

  it("forks the parent ephemerally and read-only, answers on the side thread and unsubscribes on dispose", async () => {
    const h = harness();
    try {
      const side = await openSide(h);
      expect(side.nativeId).toBe("side-thread");
      const fork = h.requests("thread/fork")[0]!.params!;
      expect(fork).toMatchObject({ threadId: "parent-thread", ephemeral: true, excludeTurns: true, sandbox: "read-only", approvalPolicy: "never", cwd: "/tmp/side-fixture" });
      expect(fork).not.toHaveProperty("beforeTurnId");
      expect(h.requests("config/read")[0]!.params).toEqual({ cwd: "/tmp/side-fixture", includeLayers: false });
      // Every inherited MCP server is disabled by a flat key that keeps its
      // transport; tool families with side effects and web search are off.
      expect(fork.config).toEqual({
        "mcp_servers.fs_tools.enabled": false,
        "mcp_servers.web-search_2.enabled": false,
        features: { apps: false, plugins: false, computer_use: false, browser_use: false, browser_use_external: false, multi_agent: false, multi_agent_v2: false, code_mode_host: false, skill_mcp_dependency_install: false },
        web_search: "disabled",
      });
      const inject = h.requests("thread/inject_items")[0]!.params!;
      expect(inject.threadId).toBe("side-thread");
      expect(JSON.stringify(inject.items)).toContain("Side conversation boundary.");

      const events: EngineStreamEvent[] = [];
      const answer = side.send({ text: "What changed?", turnInstructions: "Answer briefly.", onEngineEvent: (event) => { events.push(event); }, abortSignal: new AbortController().signal });
      await h.respond("turn/start", { turn: { id: "side-turn-1" } });
      const start = h.requests("turn/start")[0]!.params!;
      expect(start).toMatchObject({ threadId: "side-thread", approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
      expect(JSON.stringify(start.input)).toContain("What changed?");
      expect(JSON.stringify(start.input)).toContain("Answer briefly.");
      h.emit("item/agentMessage/delta", { threadId: "side-thread", turnId: "side-turn-1", delta: "The parser." });
      h.emit("turn/completed", { threadId: "side-thread", turn: { id: "side-turn-1", status: "completed", items: [{ type: "agentMessage", text: "The parser." }] } });
      await expect(answer).resolves.toEqual({ text: "The parser.", usage: undefined });
      expect(events).toContainEqual(expect.objectContaining({ type: "assistant_text", text: "The parser.", delta: true }));
      expect(events.some((event) => event.type === "session")).toBe(false);

      await side.dispose();
      expect(h.requests("thread/unsubscribe").map((frame) => frame.params)).toEqual([{ threadId: "side-thread" }]);
      await side.dispose();
      expect(h.requests("thread/unsubscribe")).toHaveLength(1);
      await expect(side.send({ text: "again", onEngineEvent: () => {}, abortSignal: new AbortController().signal })).rejects.toThrow("expired");
      for (const method of ["thread/start", "thread/resume", "thread/read", "thread/delete", "thread/archive"]) expect(h.requests(method)).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });

  it("sends side images as native localImage items and other files as inline text or read-only paths", async () => {
    const h = harness();
    try {
      const side = await openSide(h);
      const attachments = [
        { attachmentId: "att_img", path: "/private/side/1-chart.png", name: "chart.png", mime: "image/png", size: 2048, kind: "image" as const },
        { attachmentId: "att_txt", path: "/private/side/2-notes.md", name: "notes.md", mime: "text/markdown", size: 18, kind: "text" as const, text: "MARKER-TEXT-42" },
        { attachmentId: "att_pdf", path: "/private/side/3-spec.pdf", name: "spec.pdf", mime: "application/pdf", size: 4096, kind: "binary" as const },
      ];
      const answer = side.send({ text: "", attachments, onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await h.respond("turn/start", { turn: { id: "side-turn-1" } });
      const input = h.requests("turn/start")[0]!.params!.input as Array<Record<string, unknown>>;
      expect(input.slice(1)).toEqual([{ type: "localImage", path: "/private/side/1-chart.png" }]);
      const prompt = String(input[0]!.text);
      expect(prompt).toContain("without question text");
      expect(prompt).toContain("MARKER-TEXT-42");
      expect(prompt).toContain("Path: /private/side/3-spec.pdf");
      expect(prompt).toContain("Provided as an image input.");
      h.emit("turn/completed", { threadId: "side-thread", turn: { id: "side-turn-1", status: "completed", items: [{ type: "agentMessage", text: "Seen." }] } });
      await expect(answer).resolves.toMatchObject({ text: "Seen." });
      expect(h.requests("turn/start")[0]!.params).toMatchObject({ sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalPolicy: "never" });
    } finally { h.adapter.destroy(); }
  });

  it("forks before the parent's live turn and leaves that turn, its binding and its thread untouched", async () => {
    const h = harness();
    try {
      const parentEvents: EngineStreamEvent[] = [];
      const parent = h.adapter.sendUserMessage("parent-thread", { text: "Long task", files: [], onEngineEvent: (event) => { parentEvents.push(event); } });
      await h.respond("initialize", {});
      await h.respond("thread/resume", { thread: { id: "parent-thread" } });
      await h.respond("turn/start", { turn: { id: "parent-turn" } });

      const opened = h.adapter.openSideSession({ sourceSessionId: "parent-thread" });
      await h.respond("config/read", { config: {} });
      await h.respond("thread/fork", { thread: { id: "side-thread", ephemeral: true } });
      await h.respond("thread/inject_items", {});
      const side = await opened;
      expect(h.requests("thread/fork")[0]!.params).toMatchObject({ threadId: "parent-thread", beforeTurnId: "parent-turn" });

      const answer = side.send({ text: "Status?", onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await h.respond("turn/start", { turn: { id: "side-turn" } }, 2);
      h.emit("item/agentMessage/delta", { threadId: "parent-thread", turnId: "parent-turn", delta: "parent text" });
      h.emit("turn/completed", { threadId: "side-thread", turn: { id: "side-turn", status: "completed", items: [{ type: "agentMessage", text: "side answer" }] } });
      await expect(answer).resolves.toMatchObject({ text: "side answer" });

      await side.dispose();
      h.emit("turn/completed", { threadId: "parent-thread", turn: { id: "parent-turn", status: "completed", items: [{ type: "agentMessage", text: "parent done" }] } });
      await expect(parent).resolves.toMatchObject({ text: "parent done" });
      expect(parentEvents.filter((event) => event.type === "session").map((event) => event.sessionId)).toEqual(["parent-thread"]);
      expect(h.requests("turn/interrupt")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });

  it.each([false, true])("refuses a fork while turn/start has no receipt, including cancelled=%s", async cancelled => {
    const h = harness(), abort = new AbortController();
    try {
      const parent = h.adapter.sendUserMessage("parent-thread", { text: "Long task", files: [], abortSignal: abort.signal });
      void parent.catch(() => undefined);
      await h.respond("initialize", {}); await h.respond("thread/resume", { thread: { id: "parent-thread" } });
      await waitFor(() => h.requests("turn/start").length === 1);
      if (cancelled) { abort.abort(); await expect(parent).rejects.toThrow(/aborted/); }
      await expect(attemptSide(h)).rejects.toThrow("busy");
      expect(h.requests("thread/fork")).toHaveLength(0);
      if (cancelled) {
        await h.respond("turn/start", { turn: { id: "late-parent-turn" } });
        await waitFor(() => h.requests("turn/interrupt").length === 1);
        expect(h.requests("turn/interrupt")[0]!.params).toEqual({ threadId: "parent-thread", turnId: "late-parent-turn" });
      } else {
        await h.fail("turn/start", "start rejected"); await expect(parent).rejects.toThrow("start rejected");
        const side = await attemptSide(h, 2);
        expect(h.requests("thread/fork")[0]!.params).not.toHaveProperty("beforeTurnId");
        await side.dispose();
      }
    } finally { h.adapter.destroy(); }
  });

  it("refuses a fork while the main entry is reserved before turn/start", async () => {
    const h = harness(); let announce!: () => void, announced = false;
    const announcement = new Promise<void>(resolve => { announce = resolve; });
    try {
      const parent = h.adapter.sendUserMessage("parent-thread", { text: "Long task", files: [], onEngineEvent: async event => { if (event.type === "session") { announced = true; await announcement; } } });
      void parent.catch(() => undefined);
      await h.respond("initialize", {}); await h.respond("thread/resume", { thread: { id: "parent-thread" } });
      await waitFor(() => announced);
      expect(h.requests("turn/start")).toHaveLength(0);
      await expect(attemptSide(h)).rejects.toThrow("busy");
      expect(h.requests("thread/fork")).toHaveLength(0);
      announce(); await h.fail("turn/start", "start rejected"); await expect(parent).rejects.toThrow("start rejected");
    } finally { announce(); h.adapter.destroy(); }
  });

  it("uses a goal's known boundary but never substitutes it for an unidentified foreground turn", async () => {
    const h = harness();
    try {
      const watch = h.adapter.watchThreadGoal("parent-thread", { objective: "Finish the fixture" }); void watch.catch(() => undefined);
      await h.respond("initialize", {}); await h.respond("thread/resume", { thread: { id: "parent-thread" } });
      await h.respond("thread/goal/clear", { cleared: false });
      await h.respond("thread/goal/set", { goal: { threadId: "parent-thread", objective: "Finish the fixture", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } });
      await expect(attemptSide(h)).rejects.toThrow("busy");
      h.emit("turn/started", { threadId: "parent-thread", turn: { id: "goal-turn" } });
      const side = await attemptSide(h, 2);
      expect(h.requests("thread/fork")[0]!.params).toMatchObject({ beforeTurnId: "goal-turn" });
      await side.dispose();
      const parent = h.adapter.sendUserMessage("parent-thread", { text: "Steering", files: [] }); void parent.catch(() => undefined);
      await waitFor(() => h.requests("turn/start").length === 1);
      await expect(attemptSide(h, 3)).rejects.toThrow("busy");
      expect(h.requests("thread/fork")).toHaveLength(1);
      await h.fail("turn/start", "start rejected"); await expect(parent).rejects.toThrow("start rejected");
    } finally { h.adapter.destroy(); }
  });

  it("honors cancellation while the side config read is pending", async () => {
    const h = harness(), abort = new AbortController();
    try {
      const opened = h.adapter.openSideSession({ sourceSessionId: "parent-thread", abortSignal: abort.signal });
      void opened.catch(() => undefined);
      await h.respond("initialize", {});
      await waitFor(() => h.requests("config/read").length === 1); abort.abort();
      await h.respond("config/read", CONFIG);
      await expect(opened).rejects.toMatchObject({ name: "AbortError" });
      expect(h.requests("thread/fork")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });

  it("rechecks the parent after the asynchronous side policy read", async () => {
    const h = harness();
    try {
      const opened = h.adapter.openSideSession({ sourceSessionId: "parent-thread" }); void opened.catch(() => undefined);
      await h.respond("initialize", {});
      await waitFor(() => h.requests("config/read").length === 1);
      const parent = h.adapter.sendUserMessage("parent-thread", { text: "Started during the config read", files: [] }); void parent.catch(() => undefined);
      await h.respond("thread/resume", { thread: { id: "parent-thread" } });
      await waitFor(() => h.requests("turn/start").length === 1);
      await h.respond("config/read", CONFIG);
      await expect(opened).rejects.toThrow("busy");
      expect(h.requests("thread/fork")).toHaveLength(0);
      await h.fail("turn/start", "start rejected"); await expect(parent).rejects.toThrow("start rejected");
    } finally { h.adapter.destroy(); }
  });

  it("stops only the side turn and never interrupts the parent", async () => {
    const h = harness();
    try {
      const side = await openSide(h);
      const controller = new AbortController();
      const answer = side.send({ text: "Explain", onEngineEvent: () => {}, abortSignal: controller.signal });
      await h.respond("turn/start", { turn: { id: "side-turn" } });
      controller.abort();
      await expect(answer).rejects.toThrow(/aborted/);
      expect(h.requests("turn/interrupt").map((frame) => frame.params)).toEqual([{ threadId: "side-thread", turnId: "side-turn" }]);
      await side.dispose();
    } finally { h.adapter.destroy(); }
  });

  it("declines approvals, questions and App tools inside a side turn without invoking callbacks", async () => {
    const h = harness();
    try {
      const side = await openSide(h);
      const onEngineEvent = vi.fn();
      const answer = side.send({ text: "Check", onEngineEvent, abortSignal: new AbortController().signal });
      await h.respond("turn/start", { turn: { id: "side-turn" } });
      const scope = { threadId: "side-thread", turnId: "side-turn" };
      h.serverRequest("approval", "item/commandExecution/requestApproval", { ...scope, itemId: "cmd", command: "rm -rf build" });
      h.serverRequest("question", "item/tool/requestUserInput", { ...scope, itemId: "q", isBlocking: true, questions: [{ id: "a", header: "A", question: "Pick", options: [{ label: "x", description: "x" }] }] });
      h.serverRequest("tool", "item/tool/call", { ...scope, callId: "call", tool: "app_send_file", arguments: { path: "/tmp/x" } });
      await waitFor(() => ["approval", "question", "tool"].every((id) => h.responsesTo(id).length === 1));
      expect(h.responsesTo("approval")[0]!.result).toEqual({ decision: "decline" });
      expect(h.responsesTo("question")[0]!.result).toEqual({ answers: {} });
      expect(h.responsesTo("tool")[0]!.result).toMatchObject({ success: false });
      expect(onEngineEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "permission_request" }));
      h.emit("turn/completed", { threadId: "side-thread", turn: { id: "side-turn", status: "completed", items: [{ type: "agentMessage", text: "Read-only answer" }] } });
      await expect(answer).resolves.toMatchObject({ text: "Read-only answer" });
      await side.dispose();
    } finally { h.adapter.destroy(); }
  });

  it("routes a modern side's native file call to its own receiver, never a parent approval", async () => {
    const h = harness();
    try {
      const opening = h.adapter.openSideSession({ sourceSessionId: "parent-thread", tools: "inherited" });
      await h.respond("initialize", {}); await h.respond("thread/fork", { thread: { id: "side-thread", ephemeral: true } }); await h.respond("thread/inject_items", {});
      const side = await opening, call = vi.fn(async () => ({ text: '{"delivered":true,"destination":"side"}' }));
      const tools = { definitions: [{ name: "app_send_file", description: "Side file", inputSchema: {} }], instructions: "side", call, register: async () => {}, isRegistered: async () => true };
      const answer = side.send({ text: "Send image", appPlatformTools: tools, onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await h.respond("turn/start", { turn: { id: "side-turn" } });
      const scope = { threadId: "side-thread", turnId: "side-turn" };
      h.serverRequest("file", "item/tool/call", { ...scope, callId: "one", tool: "app_send_file", arguments: { path: "/tmp/sample.png", kind: "image" } });
      await waitFor(() => h.responsesTo("file").length === 1);
      expect(h.responsesTo("file")[0]!.result).toMatchObject({ success: true }); expect(call).toHaveBeenCalledTimes(1);
      h.serverRequest("foreign", "item/tool/call", { ...scope, threadId: "parent-thread", callId: "two", tool: "app_send_file", arguments: {} });
      h.serverRequest("question", "item/tool/requestUserInput", { ...scope, itemId: "question", questions: [] });
      await waitFor(() => h.responsesTo("foreign").length === 1 && h.responsesTo("question").length === 1);
      expect(call).toHaveBeenCalledTimes(1); expect(h.responsesTo("foreign")[0]!.result).toMatchObject({ success: false });
      h.emit("turn/completed", { threadId: "side-thread", turn: { id: "side-turn", status: "completed", items: [{ type: "agentMessage", text: "Sent" }] } });
      await answer;
      h.serverRequest("late", "item/tool/call", { ...scope, callId: "late", tool: "app_send_file", arguments: {} });
      await waitFor(() => h.responsesTo("late").length === 1); expect(call).toHaveBeenCalledTimes(1);
      await side.dispose();
    } finally { h.adapter.destroy(); }
  });

  it("settles an empty side answer without reading the ephemeral thread's history", async () => {
    const h = harness();
    try {
      const side = await openSide(h);
      const answer = side.send({ text: "?", onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await h.respond("turn/start", { turn: { id: "side-turn" } });
      h.emit("turn/completed", { threadId: "side-thread", turn: { id: "side-turn", status: "completed", items: [] } });
      await expect(answer).resolves.toEqual({ text: "", usage: undefined });
      expect(h.requests("thread/read")).toHaveLength(0);
      await side.dispose();
    } finally { h.adapter.destroy(); }
  });

  it("deletes exactly a generated persisted fork and refuses it", async () => {
    const h = harness();
    try {
      const opened = h.adapter.openSideSession({ sourceSessionId: "parent-thread" });
      await h.respond("initialize", {});
      await h.respond("config/read", CONFIG);
      await h.respond("thread/fork", { thread: { id: "persisted-fork", ephemeral: false } });
      await h.respond("thread/delete", {});
      await expect(opened).rejects.toThrow("unsupported");
      expect(h.requests("thread/delete").map((frame) => frame.params)).toEqual([{ threadId: "persisted-fork" }]);
      expect(h.requests("thread/unsubscribe")).toHaveLength(0);
      expect(h.requests("thread/inject_items")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });

  it.each([
    ["the parent id", { thread: { id: "parent-thread", ephemeral: true } }],
    ["no id", { thread: { ephemeral: true } }],
    ["an empty id", { thread: { id: "", ephemeral: false } }],
  ])("never cleans up anything when the fork returns %s", async (_label, fork) => {
    const h = harness();
    try {
      const opened = h.adapter.openSideSession({ sourceSessionId: "parent-thread" });
      await h.respond("initialize", {});
      await h.respond("config/read", CONFIG);
      await h.respond("thread/fork", fork);
      await expect(opened).rejects.toThrow(/distinct side thread id/);
      for (const method of ["thread/delete", "thread/unsubscribe", "turn/interrupt", "thread/inject_items"]) expect(h.requests(method)).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });

  it("fails closed before forking when an MCP server cannot be addressed safely or config cannot be read", async () => {
    const unsafe = harness();
    try {
      const opened = unsafe.adapter.openSideSession({ sourceSessionId: "parent-thread" });
      await unsafe.respond("initialize", {});
      await unsafe.respond("config/read", { config: { mcp_servers: { "odd.name": { command: "x" } } } });
      await expect(opened).rejects.toThrow("unsupported");
      expect(unsafe.requests("thread/fork")).toHaveLength(0);
    } finally { unsafe.adapter.destroy(); }
    const failing = harness();
    try {
      const opened = failing.adapter.openSideSession({ sourceSessionId: "parent-thread" });
      await failing.respond("initialize", {});
      await failing.fail("config/read", "config unavailable");
      await expect(opened).rejects.toThrow("config unavailable");
      expect(failing.requests("thread/fork")).toHaveLength(0);
    } finally { failing.adapter.destroy(); }
  });

  it("maps a missing parent rollout to no_main_session instead of starting a fresh thread", async () => {
    const h = harness();
    try {
      const opened = h.adapter.openSideSession({ sourceSessionId: "missing-thread" });
      await h.respond("initialize", {});
      await h.respond("config/read", { config: {} });
      await h.fail("thread/fork", "no rollout found for thread id missing-thread");
      await expect(opened).rejects.toThrow("no_main_session");
      expect(h.requests("thread/start")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });

  it("interrupts and settles a running side turn on dispose", async () => {
    const h = harness();
    try {
      const side = await openSide(h);
      const answer = side.send({ text: "Long", onEngineEvent: () => {}, abortSignal: new AbortController().signal });
      await h.respond("turn/start", { turn: { id: "side-turn" } });
      await side.dispose();
      await expect(answer).rejects.toThrow(/side conversation closed/);
      expect(h.requests("turn/interrupt").map((frame) => frame.params)).toEqual([{ threadId: "side-thread", turnId: "side-turn" }]);
      expect(h.requests("thread/unsubscribe").map((frame) => frame.params)).toEqual([{ threadId: "side-thread" }]);
    } finally { h.adapter.destroy(); }
  });

  it("reports expired after the shared app-server child is replaced", async () => {
    const h = harness();
    try {
      const side = await openSide(h);
      h.child().close(1);
      await expect(side.send({ text: "Still there?", onEngineEvent: () => {}, abortSignal: new AbortController().signal })).rejects.toThrow("expired");
      await side.dispose();
      expect(h.requests("thread/unsubscribe")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });
});
