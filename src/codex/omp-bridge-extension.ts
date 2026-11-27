import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

/**
 * TaroBird approval bridge extension for oh-my-pi (`omp --extension <path>`).
 * Loaded inside omp's own process, so it uses Node built-ins only (no zod,
 * no TaroBird modules, no omp packages).
 *
 * Connects once to the Host's private local socket, authenticates with a
 * one-time token, and enforces fail-closed `tool_call` approval gating when
 * the Host policy has `gate === true` (`approvalMode === "normal"`).
 */

export const OMP_BRIDGE_ENDPOINT_ENV = "TAROBIRD_OMP_BRIDGE_ENDPOINT";
export const OMP_BRIDGE_TOKEN_ENV = "TAROBIRD_OMP_BRIDGE_TOKEN";
export const OMP_BRIDGE_PROTOCOL = 1;
export const OMP_BRIDGE_GLOBAL_KEY = "tarobird.omp.bridge.v1";
export const OMP_BRIDGE_MAX_FRAME_BYTES = 1024 * 1024;

const HELLO_TIMEOUT_MS = 10_000;
const APPROVAL_INPUT_BUDGET_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Json = Record<string, unknown>;
type CallFailure = "closed" | "error" | "aborted" | "timeout" | "too-large";
type CallResult = { ok: true; result: unknown } | { ok: false; reason: CallFailure };
type SourceInfo = { path?: unknown; source?: unknown };
/** builtin: implemented by omp itself under its canonical builtin:<name> path; other: anything else. */
export type OmpBridgeToolOrigin = "builtin" | "other";

interface OmpExtensionApi {
  on(event: string, handler: (event: any, ctx: any) => unknown): unknown;
  getAllTools?(): Array<{ name?: unknown; description?: unknown; sourceInfo?: SourceInfo }>;
}

interface Bridge {
  socket: Socket | undefined;
  closed: boolean;
  /** Starts fail-closed (`true`) until the Host explicitly sets policy. */
  gate: boolean;
  hostTools: Set<string>;
  pending: Map<string, (result: CallResult) => void>;
  ready: Promise<void>;
  call(method: string, payload: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CallResult>;
}

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function boundedInput(input: unknown): { input: unknown; inputTruncated?: true } {
  let json: string;
  try { json = JSON.stringify(input) ?? "null"; } catch { return { input: { notice: "The tool input cannot be shown." }, inputTruncated: true }; }
  if (Buffer.byteLength(json) <= APPROVAL_INPUT_BUDGET_BYTES) return { input };
  const clip = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return value.length > 4000 ? `${value.slice(0, 4000)}… [${value.length - 4000} more characters]` : value;
    if (depth >= 4 || typeof value !== "object" || value === null) return typeof value === "object" && value !== null ? "[omitted]" : value;
    if (Array.isArray(value)) {
      const kept = value.slice(0, 50).map(item => clip(item, depth + 1));
      return value.length > 50 ? [...kept, `… [${value.length - 50} more items not shown]`] : kept;
    }
    const entries = Object.entries(value);
    const kept: Json = Object.fromEntries(entries.slice(0, 50).map(([key, item]) => [key, clip(item, depth + 1)]));
    if (entries.length > 50) {
      let key = "…";
      while (Object.hasOwn(kept, key)) key += "…";
      kept[key] = `[${entries.length - 50} more fields not shown]`;
    }
    return kept;
  };
  const notice = "This preview is shortened; marked parts are not shown. The tool runs with its full input.";
  const clipped = clip(input, 0);
  let shown: unknown = clipped;
  if (Array.isArray(clipped)) shown = [notice, ...clipped];
  else if (isRecord(clipped)) {
    let key = "⚠";
    while (Object.hasOwn(clipped, key)) key += "⚠";
    shown = { [key]: notice, ...clipped };
  } else if (typeof clipped === "string") shown = `[${notice}] ${clipped}`;
  if (Buffer.byteLength(JSON.stringify(shown) ?? "null") <= APPROVAL_INPUT_BUDGET_BYTES) return { input: shown, inputTruncated: true };
  return { input: { notice: `This preview is shortened: the tool input is too large to show in full (${Buffer.byteLength(json)} bytes); only its beginning is shown. The tool runs with its full input.`, preview: json.slice(0, 8000) }, inputTruncated: true };
}

async function serveHost(bridge: Bridge, method: string, payload: unknown): Promise<unknown> {
  const body = isRecord(payload) ? payload : {};
  if (method === "policy") {
    bridge.gate = body.gate !== false;
    if (Array.isArray(body.hostTools)) {
      bridge.hostTools = new Set(body.hostTools.filter((name): name is string => typeof name === "string" && name.length > 0));
    }
    return { gate: bridge.gate };
  }
  throw new Error("unknown method");
}

function openBridge(endpoint: string, token: string): Bridge {
  const socket = connect(endpoint);
  let buffer = "";
  const write = (frame: Json): boolean => {
    if (bridge.closed || socket.destroyed) return false;
    let line: string;
    try { line = `${JSON.stringify(frame)}\n`; } catch { return false; }
    if (Buffer.byteLength(line) > OMP_BRIDGE_MAX_FRAME_BYTES) return false;
    socket.write(line);
    return true;
  };
  const close = () => {
    if (bridge.closed) return;
    bridge.closed = true;
    buffer = "";
    for (const finish of [...bridge.pending.values()]) finish({ ok: false, reason: "closed" });
    bridge.pending.clear();
    socket.destroy();
  };
  const bridge: Bridge = {
    socket,
    closed: false,
    gate: true,
    hostTools: new Set(),
    pending: new Map(),
    ready: Promise.resolve(),
    call(method, payload, options = {}) {
      if (bridge.closed) return Promise.resolve({ ok: false, reason: "closed" });
      if (options.signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" });
      return new Promise<CallResult>(resolve => {
        const id = randomUUID();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: CallResult) => {
          if (!bridge.pending.delete(id)) return;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const withdraw = (reason: CallFailure) => {
          if (bridge.pending.has(id)) {
            write({ v: 1, type: "cancel", id });
            finish({ ok: false, reason });
          }
        };
        const onAbort = () => withdraw("aborted");
        bridge.pending.set(id, finish);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.timeoutMs !== undefined) timer = setTimeout(() => withdraw("timeout"), options.timeoutMs);
        if (!write({ v: 1, type: "request", id, method, payload })) finish({ ok: false, reason: bridge.closed ? "closed" : "too-large" });
      });
    },
  };
  const receive = (line: string) => {
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { close(); return; }
    if (!isRecord(frame) || frame.v !== 1 || typeof frame.id !== "string" || !UUID.test(frame.id)) { close(); return; }
    const id = frame.id;
    if (frame.type === "response") {
      bridge.pending.get(id)?.(frame.error === true ? { ok: false, reason: "error" } : { ok: true, result: frame.result });
      return;
    }
    if (frame.type === "cancel") return;
    if (frame.type !== "request" || typeof frame.method !== "string") { close(); return; }
    void serveHost(bridge, frame.method, frame.payload).then(
      result => { if (!write({ v: 1, type: "response", id, result })) write({ v: 1, type: "response", id, error: true }); },
      () => { write({ v: 1, type: "response", id, error: true }); },
    );
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0 && !bridge.closed; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > OMP_BRIDGE_MAX_FRAME_BYTES) { close(); return; }
      receive(line);
    }
    if (Buffer.byteLength(buffer) > OMP_BRIDGE_MAX_FRAME_BYTES) close();
  });
  socket.on("error", close);
  socket.on("close", close);
  bridge.ready = bridge.call("hello", { token, protocol: OMP_BRIDGE_PROTOCOL }, { timeoutMs: HELLO_TIMEOUT_MS }).then(reply => {
    if (!reply.ok || !isRecord(reply.result) || reply.result.protocol !== OMP_BRIDGE_PROTOCOL) { close(); return; }
    bridge.gate = reply.result.gate !== false;
    if (Array.isArray(reply.result.hostTools)) {
      bridge.hostTools = new Set(reply.result.hostTools.filter((name): name is string => typeof name === "string" && name.length > 0));
    }
  });
  return bridge;
}

function acquireBridge(): Bridge | undefined {
  const store = globalThis as unknown as Record<symbol, Bridge | undefined>;
  const key = Symbol.for(OMP_BRIDGE_GLOBAL_KEY);
  const endpoint = process.env[OMP_BRIDGE_ENDPOINT_ENV];
  const token = process.env[OMP_BRIDGE_TOKEN_ENV];
  delete process.env[OMP_BRIDGE_ENDPOINT_ENV];
  delete process.env[OMP_BRIDGE_TOKEN_ENV];
  const existing = store[key];
  if (existing) return existing;
  if (!endpoint || !token) return undefined;
  return (store[key] = openBridge(endpoint, token));
}

/**
 * Determine who implements the tool that would run under `toolName`, matching Pi's
 * fail-closed provenance check. A name alone proves nothing: an extension may
 * register its own `read` or `grep` override, and MCP tools carry `builtin:mcp`.
 * Only a unique registry entry with `sourceInfo.source === "builtin"` and exact
 * `sourceInfo.path === "builtin:<toolName>"` counts as `"builtin"`.
 */
function toolOrigin(pi: OmpExtensionApi | undefined, toolName: string): OmpBridgeToolOrigin {
  let info: SourceInfo | undefined;
  try {
    const entries = (pi?.getAllTools?.() ?? []).filter(tool => isRecord(tool) && tool.name === toolName);
    if (entries.length !== 1) return "other";
    info = entries[0]!.sourceInfo;
  } catch {
    return "other";
  }
  if (!isRecord(info) || typeof info.path !== "string" || typeof info.source !== "string") return "other";
  if (info.source === "builtin") {
    return info.path === `builtin:${toolName}` ? "builtin" : "other";
  }
  return "other";
}

export default async function tarobirdOmpBridge(pi: OmpExtensionApi): Promise<void> {
  const bridge = acquireBridge();
  if (!bridge) return;
  await bridge.ready;

  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = String(event?.toolName ?? "");
    if (!bridge.gate) return undefined;
    if (bridge.hostTools.has(toolName)) return undefined;
    const origin = toolOrigin(pi, toolName);
    const reply = await bridge.call(
      "approve",
      { toolName, toolCallId: String(event?.toolCallId ?? ""), origin, ...boundedInput(event?.input) },
      { signal: ctx?.signal },
    );
    if (reply.ok && isRecord(reply.result) && reply.result.allow === true) return undefined;
    if (!reply.ok && reply.reason === "aborted") return { block: true, reason: "Cancelled before approval." };
    if (reply.ok && isRecord(reply.result) && reply.result.allow === false) {
      return { block: true, reason: typeof reply.result.reason === "string" && reply.result.reason ? reply.result.reason : "Denied in TaroBird." };
    }
    return { block: true, reason: "TaroBird approval is unavailable, so the tool was not run." };
  });
}
