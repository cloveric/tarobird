import { createHash, randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  CANVAS_AGENT_PROTOCOL_VERSION,
  CANVAS_TOOL_NAMES,
  canvasSnapshotSchema,
  canvasToolDescriptions,
  canvasToolInputSchemas,
  isCanvasToolName,
  parseCanvasToolInput,
  type CanvasPresenceSnapshot,
} from "../client-protocol/infinite-canvas.js";
import { HubError, type HubStore } from "./store.js";

const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
const TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 512;

export type CanvasAgentGrant = {
  tokenHash: string;
  userId: string;
  deviceId: string;
  conversationId: string;
  tabId: string;
  clientId: string;
  expiresAt: number;
};

export type CanvasAgentEventSink = {
  ownerKey?: unknown;
  isOpen: () => boolean;
  send: (type: "hello" | "tool_call" | "tool_cancel" | "closed", data: Record<string, unknown>) => void;
  close: (reason: string) => void;
};

type ClientSession = {
  key: string;
  grant: CanvasAgentGrant;
  sink: CanvasAgentEventSink;
  snapshot: CanvasPresenceSnapshot | null;
  focusOrder: number;
};

type PendingToolCall = {
  sessionKey: string;
  tokenHash: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionKey(grant: Pick<CanvasAgentGrant, "deviceId" | "conversationId" | "clientId">): string {
  return `${grant.deviceId}\0${grant.conversationId}\0${grant.clientId}`;
}

function sendWsEvent(socket: WebSocket, type: string, data: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, data }));
  }
}

function toToolJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema) as Record<string, unknown>;
  } catch {
    return { type: "object", additionalProperties: true };
  }
}

/**
 * TaroBird Host bridge compatible with upstream infinite-canvas Canvas Agent (protocol v12).
 * Does not spawn an external canvas-agent process; issues short-lived tab-scoped tokens
 * bound to device + conversation + Bot permissions.
 */
export class CanvasAgentBroker {
  private readonly grants = new Map<string, CanvasAgentGrant>();
  private readonly sessions = new Map<string, ClientSession>();
  private readonly pending = new Map<string, PendingToolCall>();
  private focusSeq = 0;
  private closed = false;

  constructor(
    private readonly store: HubStore,
    private readonly ttlMs = DEFAULT_TOKEN_TTL_MS,
    private readonly maxTokens = DEFAULT_MAX_TOKENS,
  ) {}

  private async assertDeviceActive(deviceId: string): Promise<void> {
    const row = await this.store.db.serial(() =>
      this.store.db.get<{ revoked: number }>("SELECT revoked FROM devices WHERE id=?", [deviceId]),
    );
    if (!row || row.revoked !== 0) {
      throw new HubError("device_revoked", 401);
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [hash, grant] of this.grants) {
      if (grant.expiresAt <= now) {
        this.grants.delete(hash);
        const key = sessionKey(grant);
        const session = this.sessions.get(key);
        if (session?.grant.tokenHash === hash) {
          this.dropSession(key, "CANVAS_TOKEN_EXPIRED");
        }
      }
    }
  }

  private rejectPendingForSession(key: string, reason: string): void {
    for (const [reqId, req] of this.pending) {
      if (req.sessionKey === key) {
        this.pending.delete(reqId);
        clearTimeout(req.timer);
        req.reject(new Error(reason));
      }
    }
  }

  private dropSession(key: string, reason: string): void {
    const existing = this.sessions.get(key);
    if (!existing) return;
    this.sessions.delete(key);
    this.rejectPendingForSession(key, reason);
    try { existing.sink.close(reason); } catch { /* ignore */ }
  }

  async issueToken(input: {
    userId: string;
    deviceId: string;
    conversationId: string;
    tabId: string;
    clientId: string;
  }): Promise<{
    token: string;
    expiresAt: number;
    protocolVersion: number;
    clientId: string;
    conversationId: string;
    tabId: string;
  }> {
    if (this.closed) throw new HubError("hub_stopping", 503);
    this.pruneExpired();
    await this.assertDeviceActive(input.deviceId);
    await this.store.db.serial(() => this.store.requireMember(input.userId, input.conversationId));

    const targetKey = sessionKey(input);
    // Replace any prior grant for the same device + conversation + clientId.
    for (const [hash, grant] of this.grants) {
      if (sessionKey(grant) === targetKey) {
        this.grants.delete(hash);
        const session = this.sessions.get(targetKey);
        if (session?.grant.tokenHash === hash) {
          this.dropSession(targetKey, "CANVAS_TOKEN_REPLACED");
        }
      }
    }

    while (this.grants.size >= this.maxTokens) {
      const oldest = this.grants.entries().next().value;
      if (!oldest) break;
      const [oldestHash, oldestGrant] = oldest;
      this.grants.delete(oldestHash);
      const oldestKey = sessionKey(oldestGrant);
      if (this.sessions.get(oldestKey)?.grant.tokenHash === oldestHash) {
        this.dropSession(oldestKey, "CANVAS_TOKEN_EVICTED");
      }
    }

    const token = `ca_${randomBytes(32).toString("base64url")}`;
    const tokenHash = hashToken(token);
    const expiresAt = Date.now() + this.ttlMs;
    this.grants.set(tokenHash, {
      tokenHash,
      userId: input.userId,
      deviceId: input.deviceId,
      conversationId: input.conversationId,
      tabId: input.tabId,
      clientId: input.clientId,
      expiresAt,
    });

    return {
      token,
      expiresAt,
      protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION,
      clientId: input.clientId,
      conversationId: input.conversationId,
      tabId: input.tabId,
    };
  }

  async verifyToken(rawToken: string | undefined, expectedClientId?: string): Promise<CanvasAgentGrant> {
    if (!rawToken || !rawToken.startsWith("ca_")) throw new HubError("canvas_agent_unauthorized", 401);
    this.pruneExpired();
    const grant = this.grants.get(hashToken(rawToken));
    if (!grant || grant.expiresAt <= Date.now()) {
      throw new HubError("canvas_agent_unauthorized", 401);
    }
    if (expectedClientId && grant.clientId !== expectedClientId) {
      throw new HubError("canvas_agent_forbidden", 403);
    }
    await this.assertDeviceActive(grant.deviceId);
    try {
      await this.store.db.serial(() => this.store.requireMember(grant.userId, grant.conversationId));
    } catch {
      throw new HubError("canvas_agent_forbidden", 403);
    }
    return grant;
  }

  async sweepRevokedDevices(): Promise<void> {
    if (this.closed) return;
    this.pruneExpired();
    const deviceIds = new Set<string>();
    for (const grant of this.grants.values()) deviceIds.add(grant.deviceId);
    for (const session of this.sessions.values()) deviceIds.add(session.grant.deviceId);
    for (const deviceId of deviceIds) {
      const row = await this.store.db.serial(() =>
        this.store.db.get<{ revoked: number }>("SELECT revoked FROM devices WHERE id=?", [deviceId]),
      );
      if (!row || row.revoked !== 0) {
        this.revokeForDevice(deviceId);
      }
    }
  }

  revoke(input: { userId: string; deviceId: string; conversationId?: string; clientId?: string }): void {
    for (const [hash, grant] of this.grants) {
      if (grant.userId !== input.userId || grant.deviceId !== input.deviceId) continue;
      if (input.conversationId && grant.conversationId !== input.conversationId) continue;
      if (input.clientId && grant.clientId !== input.clientId) continue;
      this.grants.delete(hash);
      const key = sessionKey(grant);
      const session = this.sessions.get(key);
      if (session?.grant.tokenHash === hash) {
        this.dropSession(key, "CANVAS_DISCONNECTED");
      }
    }
  }

  revokeForDevice(deviceId: string): void {
    for (const [hash, grant] of this.grants) {
      if (grant.deviceId !== deviceId) continue;
      this.grants.delete(hash);
      const key = sessionKey(grant);
      const session = this.sessions.get(key);
      if (session?.grant.tokenHash === hash) {
        this.dropSession(key, "DEVICE_REVOKED");
      }
    }
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.grant.deviceId === deviceId) {
        this.dropSession(key, "DEVICE_REVOKED");
      }
    }
  }

  detachForOwner(ownerKey: unknown, clientId?: string): void {
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.sink.ownerKey !== ownerKey) continue;
      if (clientId && session.grant.clientId !== clientId) continue;
      this.dropSession(key, "CANVAS_DISCONNECTED");
    }
  }

  attachClientSink(grant: CanvasAgentGrant, sink: CanvasAgentEventSink): void {
    if (this.closed) {
      try { sink.close("hub_stopping"); } catch { /* ignore */ }
      return;
    }
    const key = sessionKey(grant);
    this.dropSession(key, "CANVAS_DISCONNECTED");
    const session: ClientSession = {
      key,
      grant,
      sink,
      snapshot: null,
      focusOrder: ++this.focusSeq,
    };
    this.sessions.set(key, session);
    sink.send("hello", {
      protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION,
      clientId: grant.clientId,
      conversationId: grant.conversationId,
    });
  }

  openEvents(grant: CanvasAgentGrant, socket: WebSocket): void {
    if (this.closed) {
      socket.close(1012, "hub_stopping");
      return;
    }
    const key = sessionKey(grant);
    const sink: CanvasAgentEventSink = {
      isOpen: () => socket.readyState === WebSocket.OPEN,
      send: (type, data) => sendWsEvent(socket, type, data),
      close: (reason) => { try { socket.close(4001, reason); } catch { /* ignore */ } },
    };
    this.attachClientSink(grant, sink);
    socket.on("close", () => {
      const current = this.sessions.get(key);
      if (current?.sink !== sink) return;
      this.sessions.delete(key);
      this.rejectPendingForSession(key, "CANVAS_DISCONNECTED");
    });
  }

  updateState(grant: CanvasAgentGrant, rawSnapshot: unknown): void {
    const session = this.sessions.get(sessionKey(grant));
    if (!session || session.grant.tokenHash !== grant.tokenHash) {
      throw new HubError("canvas_disconnected", 409);
    }
    session.snapshot = rawSnapshot === null || rawSnapshot === undefined ? null : canvasSnapshotSchema.parse(rawSnapshot);
  }

  activateClient(grant: CanvasAgentGrant): void {
    const session = this.sessions.get(sessionKey(grant));
    if (!session || session.grant.tokenHash !== grant.tokenHash) {
      throw new HubError("canvas_disconnected", 409);
    }
    session.focusOrder = ++this.focusSeq;
  }

  resolveResult(grant: CanvasAgentGrant, rawBody: unknown): boolean {
    const body = z.object({
      requestId: z.string().min(1).max(128),
      result: z.unknown().optional(),
      error: z.object({ code: z.string().max(128), message: z.string().max(512) }).optional(),
    }).parse(rawBody);
    const pending = this.pending.get(body.requestId);
    if (!pending || pending.sessionKey !== sessionKey(grant) || pending.tokenHash !== grant.tokenHash) return false;
    this.pending.delete(body.requestId);
    clearTimeout(pending.timer);
    if (body.error) pending.reject(new Error(body.error.code));
    else pending.resolve(body.result);
    return true;
  }

  health(grant: CanvasAgentGrant) {
    const active = this.sessions.get(sessionKey(grant));
    const convClients = [...this.sessions.values()].filter(
      (s) => s.grant.conversationId === grant.conversationId && this.grants.has(s.grant.tokenHash) && s.sink.isOpen(),
    );
    return {
      ok: true,
      protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION,
      conversationId: grant.conversationId,
      clients: convClients.length,
      hasCanvas: Boolean(active?.grant.tokenHash === grant.tokenHash && active?.snapshot),
    };
  }

  statusForConversation(conversationId: string): { connected: boolean; projectId?: string; title?: string } {
    const target = this.pickSessionForConversation(conversationId);
    if (!target) return { connected: false };
    return {
      connected: true,
      ...(target.snapshot ? { projectId: target.snapshot.projectId, title: target.snapshot.title } : {}),
    };
  }

  private pickSessionForConversation(conversationId: string): ClientSession | undefined {
    this.pruneExpired();
    const now = Date.now();
    const candidates = [...this.sessions.values()]
      .filter((s) =>
        s.grant.conversationId === conversationId
        && this.grants.has(s.grant.tokenHash)
        && s.sink.isOpen()
        && s.grant.expiresAt > now,
      )
      .sort((a, b) => b.focusOrder - a.focusOrder);
    return candidates[0];
  }

  listMcpTools() {
    const readOnlySet = new Set([
      "canvas_get_state",
      "canvas_get_nodes",
      "canvas_list_models",
      "canvas_list_references",
      "canvas_view_image",
      "generation_get_status",
      "prompts_search",
      "assets_list",
    ]);
    return CANVAS_TOOL_NAMES.map((name) => ({
      name,
      description: canvasToolDescriptions[name],
      inputSchema: {
        ...toToolJsonSchema(canvasToolInputSchemas[name]),
        properties: {
          ...((toToolJsonSchema(canvasToolInputSchemas[name]).properties as Record<string, unknown>) ?? {}),
          projectId: { type: "string", description: "Target canvas project ID returned by canvas_get_state." },
        },
      },
      annotations: {
        readOnlyHint: readOnlySet.has(name),
        ...(readOnlySet.has(name) ? { destructiveHint: false, idempotentHint: true } : {}),
      },
    }));
  }

  async callToolForBot(input: {
    botId: string;
    conversationId: string;
    name: string;
    args: unknown;
    projectId?: string;
    signal?: AbortSignal;
  }): Promise<unknown> {
    if (this.closed) throw new HubError("hub_stopping", 503);
    try {
      await this.store.db.serial(() => this.store.requireBot(input.botId, input.conversationId));
    } catch {
      throw new HubError("canvas_agent_forbidden", 403);
    }

    if (!isCanvasToolName(input.name)) {
      throw new HubError("canvas_unknown_tool", 400);
    }
    const parsedArgs = parseCanvasToolInput(input.name, input.args);
    await this.sweepRevokedDevices();
    const session = this.pickSessionForConversation(input.conversationId);
    if (!session) {
      throw new HubError("canvas_disconnected", 409);
    }
    return this.dispatchToolCall(session, input.name, parsedArgs, input.projectId, input.signal);
  }

  private dispatchToolCall(
    session: ClientSession,
    name: string,
    input: Record<string, unknown>,
    projectId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        this.pending.delete(requestId);
        cleanup();
        session.sink.send("tool_cancel", { requestId });
        reject(new Error("TOOL_CANCELLED"));
      };
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        cleanup();
        session.sink.send("tool_cancel", { requestId });
        reject(new Error("CANVAS_TIMEOUT"));
      }, TOOL_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, {
        sessionKey: session.key,
        tokenHash: session.grant.tokenHash,
        timer,
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (err) => { cleanup(); reject(err); },
      });
      session.sink.send("tool_call", { requestId, name, input, ...(projectId ? { projectId } : {}) });
    });
  }

  async handleMcpRequest(input: {
    botId: string;
    conversationId: string;
    body: unknown;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      await this.store.db.serial(() => this.store.requireBot(input.botId, input.conversationId));
    } catch {
      return {
        status: 403,
        body: { jsonrpc: "2.0", id: null, error: { code: -32003, message: "canvas_agent_forbidden" } },
      };
    }

    const req = z.object({
      jsonrpc: z.literal("2.0").optional(),
      id: z.union([z.string(), z.number(), z.null()]).optional(),
      method: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
    }).safeParse(input.body);

    if (!req.success) {
      return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid_request" } } };
    }
    const { id = null, method, params } = req.data;
    if (method === "initialize") {
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "tarobird-infinite-canvas-agent", version: "1.0.0" },
          },
        },
      };
    }
    if (method === "notifications/initialized") {
      return { status: 200, body: { jsonrpc: "2.0", id, result: {} } };
    }
    if (method === "tools/list") {
      return { status: 200, body: { jsonrpc: "2.0", id, result: { tools: this.listMcpTools() } } };
    }
    if (method === "tools/call") {
      const toolName = typeof params?.name === "string" ? params.name : "";
      const rawArgs = (params?.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      const { projectId, ...restArgs } = rawArgs;
      try {
        const result = await this.callToolForBot({
          botId: input.botId,
          conversationId: input.conversationId,
          name: toolName,
          args: restArgs,
          projectId: typeof projectId === "string" ? projectId : undefined,
          signal: input.signal,
        });
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result ?? {}) }],
            },
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "CANVAS_TOOL_FAILED";
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: JSON.stringify({ error: message }) }],
            },
          },
        };
      }
    }
    return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32601, message: "method_not_found" } } };
  }

  dispose(): void {
    this.closed = true;
    for (const key of [...this.sessions.keys()]) {
      this.dropSession(key, "CANVAS_DISCONNECTED");
    }
    this.grants.clear();
  }
}
