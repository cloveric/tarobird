import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { AppPlatformTools } from "../src/codex/adapter.js";
import { ClaudeAppMcp } from "../src/codex/claude-app-mcp.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";

const fullName = "mcp__tarocub_app__app_send_file";
const args = { path: "/workspace/result.txt", kind: "file" };
const appTools = (call = vi.fn(async () => ({ text: '{"delivered":true}' }))): AppPlatformTools => ({
  definitions: [{ name: "app_send_file", description: "Deliver a file", inputSchema: { type: "object" } }, { name: "app_capability", description: "Read guidance", inputSchema: { type: "object" } }],
  instructions: "Native App: use app_send_file and app_capability.", turnInstructions: "Private native turn guidance.",
  isRegistered: vi.fn(async () => false), register: vi.fn(async () => undefined), call,
});
const mcp = (requestId: string, message: unknown, server_name = "tarocub_app") => ({ type: "control_request", request_id: requestId, request: { subtype: "mcp_message", server_name, message } });
const invoke = (id: number, toolId: string | undefined = "native-1", name = "app_send_file", input: unknown = args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: input, _meta: { "claudecode/toolUseId": toolId } } });
async function tickUntil(test: () => boolean) { await vi.waitFor(() => expect(test()).toBe(true), { timeout: 2000, interval: 1 }); }
function server() {
  const tools = appTools(), written: any[] = [], signal = new AbortController();
  const host = new ClaudeAppMcp(tools.definitions, (frame) => written.push(frame));
  const grant = () => host.observe("native-1", fullName, args, tools, "session-1", signal.signal);
  const response = async (id: string) => { await tickUntil(() => written.some((f) => f.response?.request_id === id)); return written.find((f) => f.response?.request_id === id).response.response.mcp_response; };
  return { host, tools, written, signal, grant, response };
}

describe("Claude SDK App MCP boundary", () => {
  it("waits for both the CLI acknowledgment and a real tools listing", async () => {
    const f = server(); let ready = false;
    try {
      void f.host.ready.then(() => { ready = true; }); f.host.start();
      f.host.handle({ type: "control_response", response: { subtype: "success", request_id: f.written[0].request_id } });
      await Promise.resolve(); expect(ready).toBe(false);
      f.host.handle(mcp("init", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } }));
      expect((await f.response("init")).result).toMatchObject({ protocolVersion: "2025-11-25", capabilities: { tools: {} } });
      f.host.handle(mcp("list", { jsonrpc: "2.0", id: 1, method: "tools/list" }));
      expect((await f.response("list")).result.tools).toEqual(f.tools.definitions); await f.host.ready; expect(ready).toBe(true);
    } finally { f.host.close(); }
  });
  it("requires matching native tool ID, arguments, server and active turn", async () => {
    const f = server();
    try {
      f.grant();
      for (const [id, frame] of [
        ["missing", mcp("missing", { ...invoke(1), params: { name: "app_send_file", arguments: args } })],
        ["foreign", mcp("foreign", invoke(2, "foreign"))],
        ["changed", mcp("changed", invoke(3, "native-1", "app_send_file", { ...args, path: "/another/file" }))],
        ["wrong-server", mcp("wrong-server", invoke(4), "other")],
        ["wrong-tool", mcp("wrong-tool", invoke(5, "native-1", "unregistered"))],
      ] as const) { f.host.handle(frame); const response = await f.response(id); expect(response.result?.isError || response.error).toBeTruthy(); }
      f.host.handle(mcp("notification", { ...invoke(6), id: undefined })); await f.response("notification");
      expect(f.tools.call).not.toHaveBeenCalled();
      f.host.handle(mcp("ok", invoke(7))); expect((await f.response("ok")).result.content[0].text).toBe('{"delivered":true}');
      expect(f.tools.call).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", callId: "native-1", name: "app_send_file", arguments: args }));
      f.signal.abort(); f.host.handle(mcp("late", invoke(8))); expect((await f.response("late")).result.isError).toBe(true);
      expect(f.tools.call).toHaveBeenCalledTimes(1);
    } finally { f.host.close(); }
  });
  it("passes cancellation through the private control channel and never exposes an exception", async () => {
    const f = server(); let callSignal: AbortSignal | undefined;
    vi.mocked(f.tools.call).mockImplementationOnce(async (call) => { callSignal = call.abortSignal; await new Promise<void>((resolve) => callSignal!.addEventListener("abort", () => resolve(), { once: true })); return { text: "cancelled" }; });
    try {
      f.grant(); f.host.handle(mcp("running", invoke(1))); await tickUntil(() => !!callSignal);
      f.host.handle({ type: "control_cancel_request", request_id: "running" }); expect(callSignal!.aborted).toBe(true);
      await Promise.resolve(); expect(f.written.some((x) => x.response?.request_id === "running")).toBe(false);
      vi.mocked(f.tools.call).mockRejectedValueOnce(new Error("private-secret-never-return"));
      f.host.observe("failure-2", fullName, args, f.tools, "session-1", f.signal.signal);
      f.host.handle(mcp("failure", invoke(2, "failure-2"))); await tickUntil(() => f.written.some((x) => x.response?.request_id === "failure"));
      expect(JSON.stringify(f.written)).not.toContain("private-secret");
      expect(f.written.find((x) => x.response?.request_id === "failure").response.subtype).toBe("error");
    } finally { f.host.close(); }
  });
  it("negotiates supported protocol versions and executes each observed tool use at most once", async () => {
    const f = server();
    try {
      f.host.handle(mcp("old-cli", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
      expect((await f.response("old-cli")).result.protocolVersion).toBe("2025-06-18");
      f.grant(); f.host.handle(mcp("first", invoke(1))); f.host.handle(mcp("replay", invoke(2)));
      expect((await f.response("first")).result).toEqual((await f.response("replay")).result);
      expect(f.tools.call).toHaveBeenCalledTimes(1);
    } finally { f.host.close(); }
  });
  it("accepts MCP cancellation only from the installed server and the exact RPC request", async () => {
    const f = server(); let signal: AbortSignal | undefined;
    vi.mocked(f.tools.call).mockImplementation(async (call) => { signal = call.abortSignal; await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true })); return { text: "cancelled" }; });
    try {
      f.grant(); f.host.handle(mcp("running", invoke(42))); await tickUntil(() => !!signal);
      const cancel = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42 } };
      f.host.handle(mcp("foreign-cancel", cancel, "other")); await f.response("foreign-cancel"); expect(signal!.aborted).toBe(false);
      f.host.handle(mcp("cancel", cancel)); await f.response("cancel"); expect(signal!.aborted).toBe(true);
      expect(f.written.some((x) => x.response?.request_id === "running")).toBe(false);
    } finally { f.host.close(); }
  });
  it("rejects failed initialization and times out without a model prompt", async () => {
    vi.useFakeTimers(); const f = server();
    try { f.host.start(); const rejected = expect(f.host.ready).rejects.toThrow("initialization timed out"); await vi.advanceTimersByTimeAsync(60_000); await rejected; }
    finally { f.host.close(); vi.useRealTimers(); }
    const g = server(); g.host.start(); g.host.handle({ type: "control_response", response: { request_id: g.written[0].request_id, subtype: "error", error: "sensitive" } });
    await expect(g.host.ready).rejects.toThrow("rejected native App tools"); g.host.close();
  });
});

class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); lines: any[] = [];
  stdin = { write: (chunk: string, callback?: (error?: Error | null) => void) => { this.lines.push(JSON.parse(chunk)); callback?.(null); return true; } };
  emitFrame(frame: unknown) { this.stdout.emit("data", JSON.stringify(frame) + "\n"); }
}
function adapterHarness(turnInactivityTimeoutMs?: number) {
  const children: Child[] = [], launches: string[][] = [];
  const adapter = new ClaudeStreamAdapter("claude", { turnInactivityTimeoutMs, spawnFn: (_command, args) => { const child = new Child(); children.push(child); launches.push(args); return child; } });
  const handshake = async (child: Child) => {
    child.emitFrame({ type: "control_response", response: { subtype: "success", request_id: child.lines[0].request_id } });
    child.emitFrame(mcp("list", { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    await tickUntil(() => child.lines.some((f) => f.type === "user"));
    child.emitFrame({ type: "system", subtype: "init", session_id: "native-session" });
  };
  const finish = (child: Child) => child.emitFrame({ type: "result", result: "done", session_id: "native-session" });
  return { adapter, children, launches, handshake, finish };
}
const assistantTool = (id = "native-1", parent?: string) => ({ type: "assistant", parent_tool_use_id: parent ?? null, message: { content: [{ type: "tool_use", id, name: fullName, input: args }] } });

describe("Claude App adapter integration", () => {
  it("uses native tools on an existing session, preserving custom MCPs and fresh private turn guidance", async () => {
    const h = adapterHarness(), tools = appTools(), approve = vi.fn(async () => ({ behavior: "deny" as const }));
    try {
      const turn = h.adapter.sendUserMessage("native-session", { text: "Send my file", files: [], instructions: "Compatibility instructions", turnInstructions: "Old marker recipe", appPlatformTools: tools, onApprovalRequest: approve });
      await tickUntil(() => h.children.length === 1); const child = h.children[0]!;
      expect(child.lines.some((f) => f.type === "user")).toBe(false);
      child.emitFrame({ type: "system", subtype: "init", session_id: "native-session" });
      child.emitFrame(assistantTool()); child.emitFrame(mcp("before-prompt", invoke(0)));
      await tickUntil(() => child.lines.some((f) => f.response?.request_id === "before-prompt"));
      expect(tools.call).not.toHaveBeenCalled(); await h.handshake(child);
      expect(h.launches[0]).toContain("--mcp-config"); expect(h.launches[0]).not.toContain("--strict-mcp-config");
      const configPath = h.launches[0]![h.launches[0]!.indexOf("--mcp-config") + 1]!;
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ mcpServers: { tarocub_app: { type: "sdk", name: "tarocub_app" } } });
      expect(h.launches[0]).toContain("-r"); expect(h.launches[0]).toContain("native-session");
      const prompt = child.lines.find((f) => f.type === "user").message.content[0].text;
      expect(prompt).toContain(fullName); expect(prompt).toContain("Private native turn guidance"); expect(prompt).not.toContain("Old marker recipe");
      child.emitFrame(assistantTool());
      child.emitFrame({ type: "control_request", request_id: "approve", request: { subtype: "can_use_tool", tool_name: fullName, tool_use_id: "native-1", input: args } });
      await tickUntil(() => child.lines.some((f) => f.response?.request_id === "approve"));
      expect(child.lines.find((f) => f.response?.request_id === "approve").response.response.behavior).toBe("allow"); expect(approve).not.toHaveBeenCalled();
      child.emitFrame(mcp("call", invoke(2))); await tickUntil(() => vi.mocked(tools.call).mock.calls.length === 1);
      h.finish(child); await turn;
      const secondTools = appTools(); const second = h.adapter.sendUserMessage("native-session", { text: "Other App conversation", files: [], appPlatformTools: secondTools });
      await tickUntil(() => child.lines.filter((f) => f.type === "user").length === 2); expect(h.children).toHaveLength(1);
      child.emitFrame(mcp("stale", invoke(3))); await tickUntil(() => child.lines.some((f) => f.response?.request_id === "stale"));
      expect(child.lines.find((f) => f.response?.request_id === "stale").response.response.mcp_response.result.isError).toBe(true);
      child.emitFrame(assistantTool("next-2")); child.emitFrame(mcp("second", invoke(4, "next-2"))); await tickUntil(() => vi.mocked(secondTools.call).mock.calls.length === 1);
      expect(tools.call).toHaveBeenCalledTimes(1); h.finish(child); await second;
      expect(tools.register).not.toHaveBeenCalled(); expect(tools.isRegistered).not.toHaveBeenCalled();
    } finally { await h.adapter.destroy(); }
  });
  it("denies subagent/unobserved calls and preserves approvals for unrelated tools", async () => {
    const h = adapterHarness(), tools = appTools(), approval = vi.fn(async () => ({ behavior: "deny" as const }));
    try {
      const turn = h.adapter.sendUserMessage("native-session", { text: "work", files: [], appPlatformTools: tools, onApprovalRequest: approval });
      await tickUntil(() => h.children.length === 1); const child = h.children[0]!; await h.handshake(child);
      child.emitFrame({ type: "control_request", request_id: "unobserved-approval", request: { subtype: "can_use_tool", tool_name: fullName, tool_use_id: "subagent", input: args } });
      await tickUntil(() => child.lines.some((f) => f.response?.request_id === "unobserved-approval"));
      expect(approval).not.toHaveBeenCalled();
      child.emitFrame(assistantTool("subagent", "task-parent")); child.emitFrame(mcp("nested", invoke(2, "subagent")));
      await tickUntil(() => child.lines.some((f) => f.response?.request_id === "nested")); expect(tools.call).not.toHaveBeenCalled();
      child.emitFrame({ type: "control_request", request_id: "other", request: { subtype: "can_use_tool", tool_name: "mcp__other__send", input: {} } });
      await tickUntil(() => approval.mock.calls.length === 1);
      h.finish(child); await turn;
      child.emitFrame(assistantTool()); child.emitFrame(mcp("background", invoke(3)));
      await tickUntil(() => child.lines.some((f) => f.response?.request_id === "background")); expect(tools.call).not.toHaveBeenCalled();
    } finally { await h.adapter.destroy(); }
  });
  it("stops before handshake completion without sending a user prompt or resurrecting the worker", async () => {
    const h = adapterHarness(), abort = new AbortController();
    try {
      const turn = h.adapter.sendUserMessage("native-session", { text: "work", files: [], appPlatformTools: appTools(), abortSignal: abort.signal });
      const rejected = expect(turn).rejects.toThrow("stopped by user");
      await tickUntil(() => h.children.length === 1); const child = h.children[0]!; abort.abort(); await rejected;
      child.emitFrame({ type: "control_response", response: { subtype: "success", request_id: child.lines[0].request_id } });
      child.emitFrame(mcp("list", { jsonrpc: "2.0", id: 1, method: "tools/list" }));
      await Promise.resolve(); expect(child.lines.some((f) => f.type === "user")).toBe(false);
    } finally { await h.adapter.destroy(); }
  });
  it("falls back once after a pre-prompt handshake rejection without resetting or replaying model work", async () => {
    const h = adapterHarness(), tools = appTools(), events = vi.fn();
    try {
      const turn = h.adapter.sendUserMessage("native-session", { text: "send file", files: [], appPlatformTools: tools, instructions: "Compatibility platform", turnInstructions: "Legacy delivery recipe", onEngineEvent: events });
      void turn.catch(() => undefined);
      await tickUntil(() => h.children.length === 1 && h.children[0]!.lines.length > 0); const failed = h.children[0]!;
      failed.emitFrame({ type: "control_response", response: { subtype: "error", request_id: failed.lines[0].request_id } });
      await tickUntil(() => h.children.length === 2 && h.children[1]!.lines.length > 0); const fallback = h.children[1]!;
      expect(failed.lines.some((f) => f.type === "user")).toBe(false);
      expect(h.launches[1]).not.toContain("--mcp-config"); expect(h.launches[1]).toContain("native-session");
      expect(fallback.lines[0].message.content[0].text).toContain("Compatibility platform");
      expect(fallback.lines[0].message.content[0].text).toContain("Legacy delivery recipe");
      const inlineFile = "```file:report.txt\nexact bytes\n```";
      fallback.emitFrame({ type: "result", result: inlineFile, session_id: "native-session" });
      expect((await turn).text).toBe(inlineFile);
      expect(events.mock.calls.filter(([event]) => event.text?.includes("兼容文件交付"))).toHaveLength(1);
      const next = h.adapter.sendUserMessage("native-session", { text: "again", files: [], appPlatformTools: tools, instructions: "Compatibility platform" });
      await tickUntil(() => fallback.lines.filter((f) => f.type === "user").length === 2);
      expect(h.children).toHaveLength(2); h.finish(fallback); await next;
      expect(tools.call).not.toHaveBeenCalled();
    } finally { await h.adapter.destroy(); }
  });
  it("does not downgrade another healthy native session after a rejected initialization", async () => {
    const h = adapterHarness(), tools = appTools();
    try {
      const first = h.adapter.sendUserMessage("native-session", { text: "healthy", files: [], appPlatformTools: tools });
      await tickUntil(() => h.children.length === 1); const healthy = h.children[0]!; await h.handshake(healthy); h.finish(healthy); await first;
      const failed = h.adapter.sendUserMessage("other-session", { text: "reject", files: [], appPlatformTools: tools }); void failed.catch(() => undefined);
      await tickUntil(() => h.children.length === 2 && h.children[1]!.lines.length > 0); const rejected = h.children[1]!;
      rejected.emitFrame({ type: "control_response", response: { subtype: "error", request_id: rejected.lines[0].request_id } });
      await tickUntil(() => h.children.length === 3 && h.children[2]!.lines.length > 0);
      h.children[2]!.emitFrame({ type: "result", result: "fallback", session_id: "other-session" }); await failed;
      const next = h.adapter.sendUserMessage("native-session", { text: "still native", files: [], appPlatformTools: tools });
      await tickUntil(() => healthy.lines.filter((f) => f.type === "user").length === 2); expect(h.children).toHaveLength(3);
      healthy.emitFrame(assistantTool()); healthy.emitFrame(mcp("native-call", invoke(2))); await tickUntil(() => vi.mocked(tools.call).mock.calls.length === 1);
      h.finish(healthy); await next;
    } finally { await h.adapter.destroy(); }
  });
  it("retries native setup next turn after a transient initialization timeout", async () => {
    vi.useFakeTimers(); const h = adapterHarness(), tools = appTools();
    try {
      const first = h.adapter.sendUserMessage("native-session", { text: "slow start", files: [], appPlatformTools: tools }); void first.catch(() => undefined);
      await tickUntil(() => h.children.length === 1 && h.children[0]!.lines.length > 0);
      await vi.advanceTimersByTimeAsync(60_000);
      await tickUntil(() => h.children.length === 2 && h.children[1]!.lines.length > 0);
      expect(h.children[0]!.lines.some((f) => f.type === "user")).toBe(false); h.finish(h.children[1]!); await first;
      const next = h.adapter.sendUserMessage("native-session", { text: "retry", files: [], appPlatformTools: tools }); void next.catch(() => undefined);
      await tickUntil(() => h.children.length === 3 && h.children[2]!.lines.length > 0);
      expect(h.launches[2]).toContain("--mcp-config"); await h.handshake(h.children[2]!); h.finish(h.children[2]!); await next;
    } finally { await h.adapter.destroy(); vi.useRealTimers(); }
  });
  it("does not replay model work when the process fails after receiving the prompt", async () => {
    const h = adapterHarness();
    try {
      const turn = h.adapter.sendUserMessage("native-session", { text: "work once", files: [], appPlatformTools: appTools() });
      const rejected = expect(turn).rejects.toThrow();
      await tickUntil(() => h.children.length === 1); const child = h.children[0]!; await h.handshake(child);
      child.emit("close", 1); await rejected;
      expect(h.children).toHaveLength(1); expect(child.lines.filter((f) => f.type === "user")).toHaveLength(1);
    } finally { await h.adapter.destroy(); }
  });
  it("keeps a progressing host upload alive past engine inactivity but still cancels it on stop", async () => {
    vi.useFakeTimers(); const h = adapterHarness(1000), tools = appTools(), abort = new AbortController(); let hostSignal: AbortSignal | undefined; let activity: (() => void) | undefined;
    vi.mocked(tools.call).mockImplementation(async (call) => {
      hostSignal = call.abortSignal;
      activity = call.onActivity;
      await new Promise<void>((resolve) => call.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
      return { text: "stopped", isError: true };
    });
    try {
      const turn = h.adapter.sendUserMessage("native-session", { text: "upload", files: [], appPlatformTools: tools, abortSignal: abort.signal });
      const rejected = expect(turn).rejects.toThrow("stopped by user");
      await tickUntil(() => h.children.length === 1); const child = h.children[0]!; await h.handshake(child);
      child.emitFrame(assistantTool()); child.emitFrame(mcp("upload", invoke(2)));
      await tickUntil(() => !!hostSignal); expect(activity).toBeTypeOf("function");
      for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(900); activity!(); }
      expect(hostSignal!.aborted).toBe(false); abort.abort(); await rejected; expect(hostSignal!.aborted).toBe(true);
    } finally { await h.adapter.destroy(); vi.useRealTimers(); }
  });
  it("still times out a host call with no real transfer progress", async () => {
    vi.useFakeTimers(); const h = adapterHarness(1000), tools = appTools(); let hostSignal: AbortSignal | undefined;
    vi.mocked(tools.call).mockImplementation(async (call) => { hostSignal = call.abortSignal; await new Promise<void>((resolve) => call.abortSignal.addEventListener("abort", () => resolve(), { once: true })); return { text: "stopped", isError: true }; });
    try {
      const turn = h.adapter.sendUserMessage("native-session", { text: "upload", files: [], appPlatformTools: tools });
      const rejected = expect(turn).rejects.toThrow("became inactive");
      await tickUntil(() => h.children.length === 1); const child = h.children[0]!; await h.handshake(child);
      child.emitFrame(assistantTool()); child.emitFrame(mcp("wedged", invoke(2))); await tickUntil(() => !!hostSignal);
      await vi.advanceTimersByTimeAsync(1100); await rejected; expect(hostSignal!.aborted).toBe(true);
    } finally { await h.adapter.destroy(); vi.useRealTimers(); }
  });
  it.each([false, true])("rejects a real detached task-review envelope while foreground App turn=%s", async (foreground) => {
    const h = adapterHarness(), firstTools = appTools(), secondTools = appTools();
    try {
      const first = h.adapter.sendUserMessage("native-session", { text: "start", files: [], appPlatformTools: firstTools });
      void first.catch(() => undefined);
      await tickUntil(() => h.children.length === 1); const child = h.children[0]!; await h.handshake(child);
      child.emitFrame({ type: "system", subtype: "task_started", task_id: "detached", session_id: "native-session" });
      h.finish(child); await first;
      const next = foreground ? h.adapter.sendUserMessage("native-session", { text: "another conversation", files: [], appPlatformTools: secondTools }) : undefined;
      void next?.catch(() => undefined);
      if (foreground) await tickUntil(() => child.lines.filter((f) => f.type === "user").length === 2);
      child.emitFrame({ type: "user", origin: { kind: "task-notification" }, message: { content: [{ type: "text", text: "<task-notification><task-id>detached</task-id><status>completed</status><summary>ready</summary></task-notification>" }] } });
      child.emitFrame(assistantTool("review-call")); child.emitFrame(mcp("review", invoke(2, "review-call")));
      await tickUntil(() => child.lines.some((f) => f.response?.request_id === "review"));
      expect(child.lines.find((f) => f.response?.request_id === "review").response.response.mcp_response.result.isError).toBe(true);
      expect(firstTools.call).not.toHaveBeenCalled(); expect(secondTools.call).not.toHaveBeenCalled();
      child.emitFrame({ type: "result", origin: { kind: "task-notification" }, result: "review done", session_id: "native-session" });
      if (next) { h.finish(child); await next; }
    } finally { await h.adapter.destroy(); }
  });
  it("keeps compatibility guidance when native tool installation is deferred by existing background work", async () => {
    const h = adapterHarness(), tools = appTools();
    try {
      const first = h.adapter.sendUserMessage("native-session", { text: "start work", files: [], instructions: "legacy platform" });
      await tickUntil(() => h.children.length === 1 && h.children[0]!.lines.length === 1); const child = h.children[0]!;
      child.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id: "background-tool", name: "Bash", input: { run_in_background: true } }] } });
      child.emitFrame({ type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "background-tool", session_id: "native-session" });
      h.finish(child); await first;
      const next = h.adapter.sendUserMessage("native-session", { text: "send file", files: [], appPlatformTools: tools, turnInstructions: "Legacy delivery recipe", instructions: "legacy platform" });
      await tickUntil(() => child.lines.filter((f) => f.type === "user").length === 2);
      expect(h.children).toHaveLength(1); expect(h.launches[0]).not.toContain("--mcp-config");
      const prompt = child.lines.filter((f) => f.type === "user")[1].message.content[0].text;
      expect(prompt).toContain("Legacy delivery recipe"); expect(prompt).not.toContain(fullName);
      h.finish(child); await next; expect(tools.call).not.toHaveBeenCalled();
    } finally { await h.adapter.destroy(); }
  });
  it("cannot lend installed App tools to a Feishu turn while background work defers reconfiguration", async () => {
    const h = adapterHarness(), tools = appTools();
    try {
      const first = h.adapter.sendUserMessage("native-session", { text: "start work", files: [], appPlatformTools: tools });
      await tickUntil(() => h.children.length === 1); const child = h.children[0]!; await h.handshake(child);
      child.emitFrame({ type: "assistant", message: { content: [{ type: "tool_use", id: "background-tool", name: "Bash", input: { run_in_background: true } }] } });
      child.emitFrame({ type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "background-tool", session_id: "native-session" });
      h.finish(child); await first;
      const next = h.adapter.sendUserMessage("native-session", { text: "Feishu request", files: [], instructions: "Feishu platform" });
      await tickUntil(() => child.lines.filter((f) => f.type === "user").length === 2); expect(h.children).toHaveLength(1);
      expect(child.lines.filter((f) => f.type === "user")[1].message.content[0].text).toContain("Feishu platform");
      child.emitFrame(assistantTool("wrong-channel")); child.emitFrame(mcp("feishu", invoke(4, "wrong-channel")));
      await tickUntil(() => child.lines.some((f) => f.response?.request_id === "feishu"));
      expect(child.lines.find((f) => f.response?.request_id === "feishu").response.response.mcp_response.result.isError).toBe(true);
      h.finish(child); await next; expect(tools.call).not.toHaveBeenCalled();
    } finally { await h.adapter.destroy(); }
  });
});
