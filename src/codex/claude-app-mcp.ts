import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppPlatformTools } from "./adapter.js";

export const CLAUDE_APP_MCP_SERVER = "tarocub_app";
const prefix = `mcp__${CLAUDE_APP_MCP_SERVER}__`;
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export class ClaudeAppMcpInitializationError extends Error {
  constructor(message: string, readonly reason: "rejected" | "timeout") { super(message); }
}
export const claudeAppInstructions = (text: string) => text.replace(/\b(app_send_file|app_send_batch|app_capability|app_show_widget)\b/g, `${prefix}$1`);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const rpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() });
type Binding = { tools: AppPlatformTools; sessionId: string; name: string; arguments: string; signal: AbortSignal; execution?: ReturnType<AppPlatformTools["call"]> };

/** SDK MCP over Claude's existing private stdio control channel. No listener,
 * global MCP edits or model-controlled recipient. Execution additionally needs
 * a matching foreground tool_use observed on this exact worker and turn. */
export class ClaudeAppMcp {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly initializeId = `tarocub-app-${randomUUID()}`;
  private readonly bindings = new Map<string, Binding>();
  private readonly turnSignals = new WeakSet<AbortSignal>();
  private readonly calls = new Map<string, AbortController>();
  private readonly rpcCalls = new Map<string | number, Set<AbortController>>();
  private readonly definitionKey: string;
  private timer?: ReturnType<typeof setTimeout>;
  private acknowledged = false;
  private listed = false;
  private closed = false;

  constructor(private readonly definitions: AppPlatformTools["definitions"], private readonly write: (value: unknown) => void, private readonly onActivity?: () => void) {
    this.definitionKey = canonical(definitions);
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => undefined);
  }

  matches(tools: AppPlatformTools): boolean { return this.definitionKey === canonical(tools.definitions); }
  owns(name: string): boolean { return !this.closed && this.definitions.some((tool) => `${prefix}${tool.name}` === name); }
  start(): void {
    this.timer = setTimeout(() => this.close(new ClaudeAppMcpInitializationError("Claude App tools initialization timed out", "timeout")), 60_000);
    this.write({ type: "control_request", request_id: this.initializeId, request: { subtype: "initialize" } });
  }
  private checkReady(): void {
    if (this.acknowledged && this.listed) { clearTimeout(this.timer); this.resolveReady(); }
  }

  observe(id: string, name: string, args: unknown, tools: AppPlatformTools, sessionId: string, signal: AbortSignal): void {
    if (this.closed || signal.aborted || !name.startsWith(prefix) || this.bindings.has(id)) return;
    const shortName = name.slice(prefix.length);
    if (!this.matches(tools) || !this.definitions.some((tool) => tool.name === shortName)) return;
    const binding: Binding = { tools, sessionId, name: shortName, arguments: canonical(args ?? {}), signal };
    this.bindings.set(id, binding);
    if (!this.turnSignals.has(signal)) {
      this.turnSignals.add(signal);
      signal.addEventListener("abort", () => {
        for (const [key, value] of this.bindings) if (value.signal === signal) this.bindings.delete(key);
      }, { once: true });
    }
  }

  permits(id: string | undefined, name: string, args: unknown): boolean {
    const binding = id ? this.bindings.get(id) : undefined;
    return !this.closed && !!binding && !binding.signal.aborted && `${prefix}${binding.name}` === name && binding.arguments === canonical(args ?? {});
  }

  handle(frame: Record<string, unknown>): boolean {
    if (frame.type === "control_response") {
      const response = frame.response as Record<string, unknown> | undefined;
      if (response?.request_id !== this.initializeId) return false;
      if (response.subtype !== "success") this.close(new ClaudeAppMcpInitializationError("Claude rejected native App tools initialization", "rejected"));
      else { this.acknowledged = true; this.checkReady(); }
      return true;
    }
    if (frame.type === "control_cancel_request" && typeof frame.request_id === "string") {
      const active = this.calls.get(frame.request_id);
      if (!active) return false;
      active.abort(); return true;
    }
    const request = frame.request as Record<string, unknown> | undefined;
    if (frame.type !== "control_request" || request?.subtype !== "mcp_message") return false;
    if (typeof frame.request_id !== "string" || !frame.request_id || this.closed) return true;
    const requestId = frame.request_id;
    if (this.calls.has(requestId)) return true;
    const controller = new AbortController(); this.calls.set(requestId, controller);
    const rpc = rpcSchema.safeParse(request.message);
    const rpcId = request.server_name === CLAUDE_APP_MCP_SERVER && rpc.success ? rpc.data.id : undefined;
    if (rpcId !== undefined) {
      const calls = this.rpcCalls.get(rpcId) ?? new Set<AbortController>();
      calls.add(controller); this.rpcCalls.set(rpcId, calls);
    }
    void this.dispatch(request, controller.signal).then((mcp_response) => {
      if (!this.closed && !controller.signal.aborted) {
        this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { mcp_response } } });
        this.checkReady();
      }
    }).catch(() => {
      if (!this.closed && !controller.signal.aborted) this.write({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "App tool failed; check the conversation receipt before retrying." } });
    }).finally(() => {
      if (this.calls.get(requestId) === controller) this.calls.delete(requestId);
      if (rpcId !== undefined) {
        const calls = this.rpcCalls.get(rpcId); calls?.delete(controller);
        if (calls?.size === 0) this.rpcCalls.delete(rpcId);
      }
    });
    return true;
  }

  private async dispatch(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const parsed = rpcSchema.safeParse(request.message);
    if (!parsed.success) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid MCP request" } };
    const rpc = parsed.data;
    const response = (result: unknown) => ({ jsonrpc: "2.0", ...(rpc.id !== undefined ? { id: rpc.id } : {}), result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } });
    if (request.server_name !== CLAUDE_APP_MCP_SERVER) return error(-32601, "Unknown SDK MCP server");
    if (rpc.id === undefined && rpc.method === "notifications/cancelled") {
      const id = rpc.params?.requestId;
      if (typeof id === "string" || typeof id === "number") for (const call of this.rpcCalls.get(id) ?? []) call.abort();
    }
    // Notifications cannot execute tools, even if they carry tool-like params.
    if (rpc.id === undefined) return response({});
    if (rpc.method === "initialize") return response({ protocolVersion: versions.find((version) => version === rpc.params?.protocolVersion) ?? versions[0], capabilities: { tools: {} }, serverInfo: { name: CLAUDE_APP_MCP_SERVER, version: "1.0.0" } });
    if (rpc.method === "ping") return response({});
    if (rpc.method === "tools/list") {
      this.listed = true;
      return response({ tools: this.definitions });
    }
    if (rpc.method !== "tools/call") return error(-32601, "Unsupported App MCP method");
    const meta = rpc.params?._meta as Record<string, unknown> | undefined;
    const toolUseId = typeof meta?.["claudecode/toolUseId"] === "string" ? meta["claudecode/toolUseId"] : undefined;
    const name = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};
    if (typeof name !== "string" || !this.permits(toolUseId, `${prefix}${name}`, args)) {
      return response({ isError: true, content: [{ type: "text", text: "No matching active App tool call; nothing was sent. Follow this turn's channel instructions. Subagents must return artifact paths to their parent. Detached task reviews may use [send-file:/absolute/path] or [send-image:/absolute/path] in their final result; the existing notification handler owns routing. Do not claim native delivery." }] });
    }
    const binding = this.bindings.get(toolUseId!)!;
    if (!binding.execution) {
      binding.execution = Promise.resolve().then(() => binding.tools.call({ name, arguments: args, callId: toolUseId!, sessionId: binding.sessionId, abortSignal: AbortSignal.any([signal, binding.signal]), onActivity: () => {
        if (!this.closed && !signal.aborted && !binding.signal.aborted) this.onActivity?.();
      } }));
    }
    const result = await binding.execution;
    return response({ content: [{ type: "text", text: name === "app_capability" ? claudeAppInstructions(result.text) : result.text }], ...(result.isError ? { isError: true } : {}) });
  }

  close(error = new Error("Claude worker ended")): void {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.rejectReady(error);
    for (const controller of this.calls.values()) controller.abort();
    this.calls.clear(); this.rpcCalls.clear(); this.bindings.clear();
  }
}
