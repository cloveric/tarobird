import { workbenchContextSchema, workbenchContextOmittedSchema, type WorkbenchContext, type WorkbenchContextOmitted } from "../client-protocol/workbench.js";
import { WORKBENCH_DESIGN_OPEN_CAPABILITY } from "../client-protocol/workbench-design.js";
import { NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY } from "../client-protocol/native-input.js";
import { STEERING_OUTCOME_CAPABILITY } from "../client-protocol/steering-outcome.js";
import { WIDGET_POLICY_CAPABILITY } from "../client-protocol/widget-settings.js";
import { VOICE_POLICY_CAPABILITY } from "../client-protocol/voice-settings.js";
import { PROMPT_QUEUE_CAPABILITY, PROMPT_QUEUE_PULL_CAPABILITY, PROMPT_QUEUE_ENGINES } from "../client-protocol/prompt-queue.js";
import { RUN_SCOPES_CAPABILITY } from "../client-protocol/run.js";
import { randomBytes } from "node:crypto";
import { FRAGMENT_CAPABILITY } from "../client-protocol/fragments.js";
import { nodeFrameReader, writeFrame } from "../client-protocol/fragments-node.js";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { MAX_FRAME_BYTES, conversationSchema, idSchema, jsonSchema, messageSchema, type Conversation, type Json, type Message } from "../client-protocol/index.js";
import { JsonStore } from "../state/json-store.js";
import { isLoopback } from "../hub/network.js";
import { botRuntimeStatusSchema } from "../client-protocol/instance.js";
import { AGENT_BUS_WORKER_CAPABILITY, AGENT_BUS_LEGACY_WORKER_CAPABILITY, agentBusDispatchSchema, type AgentBusDispatch } from "../client-protocol/agent-bus.js";
import { GROUP_DISCUSSION_WORKER_CAPABILITY, groupDiscussionDispatchSchema, type GroupDiscussionDispatch } from "../client-protocol/group-discussion.js";

const requestSchema = z.object({ v: z.literal(1), type: z.literal("instance.request"), id: idSchema, method: z.string(), params: jsonSchema });
const journalSchema = z.object({ requests: z.array(requestSchema) });
const HANDSHAKE_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 30_000;
type Request = z.infer<typeof requestSchema>;
const inboundSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("instance.ready"), capabilities: z.array(z.string()).optional() }),
  z.object({ v: z.literal(1), type: z.literal("instance.queue"), conversationId: idSchema }),
  z.object({ v: z.literal(1), type: z.literal("instance.result"), id: idSchema, result: jsonSchema.optional(), error: z.string().optional() }),
  z.object({ v: z.literal(1), type: z.literal("instance.message"), workbench: workbenchContextSchema.optional(), workbenchContextOmitted: workbenchContextOmittedSchema.optional(), message: messageSchema, conversation: conversationSchema, agentBus: agentBusDispatchSchema.optional(), groupDiscussion: groupDiscussionDispatchSchema.optional() }),
  z.object({ v: z.literal(1), type: z.literal("instance.call"), id: idSchema, method: z.string(), params: jsonSchema }),
  z.object({ v: z.literal(1), type: z.literal("pong") }),
]);
export interface GatewayTransportOptions { url: string; botId: string; secret: string; stateDir: string; engine?: string; model?: string; effort?: string; onWarning?: (code: string) => void }
export class GatewayTransport {
  private ws?: WebSocket; private stopped = false; private ready = false; private attempt = 0;
  private fragments = false;
  capabilities: readonly string[] = [];
  private readonly replayed = new WeakMap<WebSocket, Set<string>>();
  private replay: Promise<void> = Promise.resolve();
  private boot?: Promise<void>;
  private bootStarted = false;
  private reconnect?: ReturnType<typeof setTimeout>; private heartbeat?: ReturnType<typeof setInterval>;
  private readyTimeout?: ReturnType<typeof setTimeout>;
  private journal: Request[] = []; private diskTail: Promise<unknown> = Promise.resolve();
  private readonly state: JsonStore<z.infer<typeof journalSchema>>;
  private status: z.infer<typeof botRuntimeStatusSchema>;
  private statusTail: Promise<void> = Promise.resolve();
  private pending = new Map<string, { resolve: (result: Json) => void; reject: (error: Error) => void }>();
  private readonly transient = new Set<string>();
  private receiving = 0;
  private deliveryRecoveryAttempt = 0;
  private readyAt = 0;
  private bootPending = false;
  private partialFrame = false;
  /** A transient socket disconnect keeps requests pending for replay; an
   * explicit worker stop must not start new durable recovery work. */
  throwIfStopped(): void { if (this.stopped) throw new Error("gateway_stopped"); }
  /** Includes admission/approval and publication persistence before runtime
   * activeRuns is populated, so an idle drain cannot cut off accepted work. */
  isBusy(): boolean { return this.receiving > 0 || this.pending.size > 0 || this.journal.length > 0 || this.bootPending || this.partialFrame; }
  onMessage?: (message: Message, conversation: Conversation, agentBus?: AgentBusDispatch, groupDiscussion?: GroupDiscussionDispatch, workbench?: WorkbenchContext, workbenchContextOmitted?: WorkbenchContextOmitted) => Promise<void>;
  onQueue?: (conversationId: string) => void;
  onCall?: (method: string, params: Json) => Promise<Json>;
  /** Once per process attachment, after old publications and before new input. */
  onBoot?: () => Promise<void>;
  constructor(readonly options: GatewayTransportOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "ws:" || !isLoopback(url.hostname.replace(/^\[|\]$/g, "")) || url.pathname !== "/instance" || url.username || url.password) throw new Error("Gateway requires a loopback ws:// address ending in /instance");
    this.state = new JsonStore(path.join(options.stateDir, "gateway-outbox.json"), (value) => journalSchema.parse(value));
    this.status = { engine: options.engine ?? "", model: options.model ?? "", effort: options.effort ?? "" };
  }
  get httpUrl(): string { return this.options.url.replace(/^ws:/, "http:").replace(/\/instance$/, ""); }
  get authHeader(): string { return `Instance ${this.options.botId}:${this.options.secret}`; }
  async connect(): Promise<void> { this.bootPending ||= !this.bootStarted; this.journal = (await this.state.read({ requests: [] })).requests; this.stopped = false; this.open(); }
  private open(): void {
    if (this.stopped) return;
    const reader = nodeFrameReader();
    const ws = new WebSocket(this.options.url, { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, handshakeTimeout: HANDSHAKE_TIMEOUT_MS }); this.ws = ws;
    let awaitingPong = false;
    ws.on("pong", () => { awaitingPong = false; });
    ws.on("open", () => {
      if (this.ws !== ws || this.stopped) { ws.terminate(); return; }
      this.readyTimeout = setTimeout(() => {
        if (this.ws === ws && !this.ready && !this.stopped) { this.options.onWarning?.("gateway_ready_timeout"); ws.terminate(); }
      }, READY_TIMEOUT_MS); this.readyTimeout.unref();
      // Protocol pongs do not wait for metadata reads, database writes or a
      // model turn. A silent socket must recover without timing out the task.
      this.heartbeat = setInterval(() => {
        if (this.ws !== ws || this.stopped || !this.ready) return;
        if (awaitingPong) { this.options.onWarning?.("gateway_heartbeat_timeout"); ws.terminate(); return; }
        awaitingPong = true;
        ws.ping(undefined, undefined, error => { if (error) ws.terminate(); });
        void this.refreshStatus().catch(() => undefined);
      }, HEARTBEAT_MS); this.heartbeat.unref();
      this.statusTail = this.statusTail.then(async () => {
        await this.readStatus();
        // Standalone/manual workers without a Host binding still use their own
        // environment; do not claim that the Host's voice settings apply.
        if (this.ws === ws && !this.stopped) this.send({ v: 1, type: "instance.hello", capabilities: [...(this.status.engine === "claude" ? [NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY] : []), ...(process.env.TAROBOT_HOST_DIR ? [VOICE_POLICY_CAPABILITY, WIDGET_POLICY_CAPABILITY] : []), FRAGMENT_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY, "conversations.tasks.v1", "bot-messages.v1", AGENT_BUS_WORKER_CAPABILITY, AGENT_BUS_LEGACY_WORKER_CAPABILITY, GROUP_DISCUSSION_WORKER_CAPABILITY, ...((PROMPT_QUEUE_ENGINES as readonly string[]).includes(this.status.engine) ? [PROMPT_QUEUE_CAPABILITY, ...(this.onQueue ? [PROMPT_QUEUE_PULL_CAPABILITY] : [])] : [])], botId: this.options.botId, secret: this.options.secret, ...this.status });
      }).catch(() => undefined);
    });
    ws.on("message", (data) => {
      if (this.ws !== ws || this.stopped) return;
      try { const value = reader.read(data.toString()); this.partialFrame = reader.hasPendingTransfer(); if (value !== undefined) {
        this.receiving++;
        void this.receive(value, ws).catch(() => { this.options.onWarning?.("gateway_receive_failed"); ws.terminate(); }).finally(() => { this.receiving--; });
      } }
      catch { this.options.onWarning?.("gateway_receive_failed"); ws.terminate(); }
    });
    ws.on("error", () => this.options.onWarning?.("gateway_connection_failed"));
    ws.on("close", () => {
      reader.clear();
      if (this.ws !== ws) return;
      this.partialFrame = false;
      for (const id of this.transient) { this.pending.get(id)?.reject(new Error("gateway_disconnected")); this.pending.delete(id); }
      this.transient.clear();
      // A hello followed immediately by Hub-side dispatch failure is not a
      // recovered connection. Retain backoff across these rapid attachments.
      if (this.ready && !this.deliveryRecoveryAttempt && Date.now() - this.readyAt >= 30_000) this.attempt = 0;
      this.ready = false; if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.readyTimeout) clearTimeout(this.readyTimeout);
      if (!this.stopped) { this.reconnect = setTimeout(() => this.open(), Math.min(15_000, 250 * 2 ** Math.min(this.attempt++, 6))); this.reconnect.unref(); }
    });
  }
  private send(value: unknown): void {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) void writeFrame(ws, value, this.fragments).catch(() => ws.terminate());
  }
  private async readStatus(): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const file = path.join(this.options.stateDir, "config.json");
      const reading = (async () => {
        if ((await stat(file)).size > 256 * 1024) return;
        const config = z.object({ engine: z.string().max(64).optional(), model: z.string().max(128).optional(), effort: z.string().max(32).optional() }).parse(JSON.parse(await readFile(file, { encoding: "utf8", signal: controller.signal })));
        return botRuntimeStatusSchema.parse({ engine: config.engine ?? this.options.engine ?? "", model: config.model ?? "", effort: config.effort ?? "" });
      })();
      const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); this.options.onWarning?.("gateway_metadata_read_timeout"); resolve(undefined); }, 2000); timer.unref(); });
      const status = await Promise.race([reading, timeout]);
      // A late read must not overwrite metadata from a newer refresh.
      if (status) this.status = status;
    } catch { /* Keep the last valid metadata; never publish config contents/errors. */ }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  /** No journal entries: publish current metadata after commands and heartbeats,
   * including edits made outside the App. Serialized reads cannot race back. */
  refreshStatus(): Promise<void> {
    const update = this.statusTail.then(async () => {
      if (this.stopped || !this.ready) return;
      await this.readStatus();
      if (!this.stopped && this.ready) this.send({ v: 1, type: "ping", status: this.status });
    });
    this.statusTail = update.catch(() => undefined); return this.statusTail;
  }
  private async receive(value: unknown, ws = this.ws): Promise<void> {
    if (this.stopped || this.ws !== ws || ws?.readyState !== WebSocket.OPEN) return;
    const frame = inboundSchema.parse(value);
    if (frame.type === "instance.ready") {
      if (this.ready) return;
      if (this.readyTimeout) clearTimeout(this.readyTimeout);
      this.capabilities = frame.capabilities ?? [];
      this.ready = true; this.readyAt = Date.now(); this.fragments = frame.capabilities?.includes(FRAGMENT_CAPABILITY) ?? false;
      if (ws) this.replayed.set(ws, new Set());
      this.replay = (async () => { if (ws) for (const request of [...this.journal]) {
        // A Hub rollback may leave optional scope batches in the durable
        // outbox. Old strict method schemas would close the whole connection;
        // retire only this unsupported evidence, preserving replies/root logs.
        if (request.method === "input.progress" && !this.capabilities.includes(NATIVE_INPUT_CAPABILITY) || request.method === "run.scope.write" && !this.capabilities.includes(RUN_SCOPES_CAPABILITY) || request.method === "steer.outcome" && !this.capabilities.includes(STEERING_OUTCOME_CAPABILITY)) {
          await this.persist(() => { this.journal = this.journal.filter(value => value.id !== request.id); });
          this.pending.get(request.id)?.reject(new Error(request.method === "input.progress" ? "native_input_unsupported" : request.method === "steer.outcome" ? "steering_outcome_unsupported" : "run_scopes_unsupported")); this.pending.delete(request.id);
          continue;
        }
        if (!this.fragments && Buffer.byteLength(JSON.stringify(request)) > MAX_FRAME_BYTES) { this.pending.get(request.id)?.reject(new Error("hub_update_required")); this.pending.delete(request.id); this.options.onWarning?.("hub_update_required"); continue; }
        this.replayed.get(ws)!.add(request.id);
        await writeFrame(ws, request, this.fragments);
      } })();
      if (!this.bootStarted) {
        this.bootPending = true;
        const boot = this.replay.then(() => {
          // A new socket may attach while an old replay is waiting for disk IO.
          // Only the current socket may start recovery; once started, preserve
          // that same barrier across every later reconnect.
          if (this.stopped || this.ws !== ws || ws?.readyState !== WebSocket.OPEN) return;
          this.bootStarted = true; return this.onBoot?.();
        }).catch(() => {
          this.options.onWarning?.("gateway_boot_recovery_failed");
        }).finally(() => { if (this.boot === boot) this.bootPending = false; });
        this.boot = boot;
      }
      await this.replay;
      return;
    }
    if (frame.type === "instance.result") {
      const pending = this.pending.get(frame.id);
      if (this.transient.delete(frame.id)) {
        this.pending.delete(frame.id);
        if (frame.error) pending?.reject(new Error(frame.error)); else pending?.resolve(frame.result ?? null);
        return;
      }
      try { await this.persist(() => { this.journal = this.journal.filter((r) => r.id !== frame.id); }); }
      catch (error) { this.reconnectAfterDeliveryFailure(); throw error; }
      this.pending.delete(frame.id);
      if (frame.error) pending?.reject(new Error(frame.error)); else pending?.resolve(frame.result ?? null); return;
    }
    if (frame.type === "instance.message" || frame.type === "instance.queue") {
      await this.replay; await this.boot;
      // The replacement connection redelivers pending input. Do not let an
      // old callback cross the boot barrier after shutdown or reconnect.
      if (this.stopped || this.ws !== ws || ws?.readyState !== WebSocket.OPEN) return;
      if (frame.type === "instance.queue") { this.onQueue?.(frame.conversationId); return; }
      await this.onMessage?.(frame.message, frame.conversation, frame.agentBus, frame.groupDiscussion, frame.workbench, frame.workbenchContextOmitted); return;
    }
    if (frame.type === "instance.call") {
      try { const result = await this.onCall?.(frame.method, frame.params); if (!this.stopped && this.ws === ws) this.send({ v: 1, type: "instance.result", id: frame.id, result: result ?? null }); }
      catch { if (!this.stopped && this.ws === ws) this.send({ v: 1, type: "instance.result", id: frame.id, error: "gateway_call_failed" }); }
      finally { await this.refreshStatus(); }
    }
  }
  private persist(update: () => void): Promise<void> {
    const result = this.diskTail.then(async () => {
      const previous = [...this.journal];
      try { update(); await this.state.write({ requests: this.journal }); }
      catch (error) { this.journal = previous; throw error; }
    });
    this.diskTail = result.catch(() => undefined); return result;
  }
  /** Workbench calls address ephemeral App windows: never persist or replay. */
  async requestLive(method: string, params: unknown, signal?: AbortSignal): Promise<Json> {
    this.throwIfStopped(); signal?.throwIfAborted();
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) throw new Error("gateway_disconnected");
    const id = `live_${randomBytes(16).toString("hex")}`;
    const result = new Promise<Json>((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.transient.add(id); });
    const reject = (reason: string) => { this.pending.get(id)?.reject(new Error(reason)); this.pending.delete(id); this.transient.delete(id); };
    const abort = () => reject("workbench_outcome_unknown");
    const timer = setTimeout(() => reject("workbench_outcome_unknown"), 35_000); timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    try { this.send({ v: 1, type: "instance.request", id, method, params }); return await result; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id); this.transient.delete(id); }
  }
  async request(method: string, params: unknown): Promise<Json> {
    return this.enqueue(method, params).response;
  }
  /** A pull is a live execution-slot reservation, never a durable command to
   * replay after that slot is gone. A lost claim is recovered as fenced input
   * on reattachment through GatewayReceipts, just like a lost push delivery. */
  async takeQueued(conversationId: string): Promise<{ message: Message; conversation: Conversation; workbench?: WorkbenchContext; workbenchContextOmitted?: WorkbenchContextOmitted } | null> {
    this.throwIfStopped();
    if (!this.capabilities.includes(PROMPT_QUEUE_PULL_CAPABILITY)) throw new Error("queue_unsupported");
    const ws = this.ws;
    if (!this.ready || ws?.readyState !== WebSocket.OPEN) throw new Error("gateway_disconnected");
    const id = `pull_${randomBytes(16).toString("hex")}`;
    const result = new Promise<Json>((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.transient.add(id); });
    const timer = setTimeout(() => { this.pending.get(id)?.reject(new Error("gateway_queue_timeout")); this.pending.delete(id); this.transient.delete(id); ws.terminate(); }, 10_000); timer.unref();
    this.send({ v: 1, type: "instance.request", id, method: "queue.take", params: { conversationId } });
    try { return z.object({ message: messageSchema, conversation: conversationSchema, workbench: workbenchContextSchema.optional(), workbenchContextOmitted: workbenchContextOmittedSchema.optional() }).nullable().parse(await result); }
    finally { clearTimeout(timer); }
  }
  /** Separates durable outbox acceptance from the Hub's response. Requests are
   * journaled, sent and replayed in call order, so once `persisted` resolves a
   * later request (such as an input's ack) cannot overtake this one, even while
   * earlier responses are slow or the Hub is disconnected. */
  enqueue(method: string, params: unknown): { persisted: Promise<void>; response: Promise<Json> } {
    this.throwIfStopped();
    if (method.startsWith("workbench.")) throw new Error("workbench_requires_live_request");
    if (method === "queue.take") throw new Error("queue_pull_requires_live_slot");
    if (method === "run.scope.write" && !this.capabilities.includes(RUN_SCOPES_CAPABILITY)) throw new Error("run_scopes_unsupported");
    if (method === "input.progress" && !this.capabilities.includes(NATIVE_INPUT_CAPABILITY)) throw new Error("native_input_unsupported");
    if (method === "steer.outcome" && !this.capabilities.includes(STEERING_OUTCOME_CAPABILITY)) throw new Error("steering_outcome_unsupported");
    const request = requestSchema.parse({ v: 1, type: "instance.request", id: `rpc_${randomBytes(16).toString("hex")}`, method, params: JSON.parse(JSON.stringify(params)) });
    const checkSize = () => {
      if (this.ready && !this.fragments && Buffer.byteLength(JSON.stringify(request)) > MAX_FRAME_BYTES) {
        this.options.onWarning?.("hub_update_required");
        throw new Error("hub_update_required");
      }
    };
    // Reject known-undeliverable new requests before they enter the durable
    // outbox. Retrying them must not accumulate work the old Hub cannot read.
    // Previously journaled/offline requests remain intact for a Hub upgrade.
    checkSize();
    const response = new Promise<Json>((resolve, reject) => this.pending.set(request.id, { resolve, reject }));
    // Register a handler immediately; a disconnect during fsync cannot produce
    // an unhandled rejection before the caller begins awaiting the response.
    void response.catch(() => undefined);
    const persisted = this.persist(() => { checkSize(); this.journal.push(request); });
    const sent = persisted.then(async () => {
      // Replay can be replaced while an old disk write is pending. Wait for
      // the current generation before sending, preserving its order/dedup set.
      for (;;) { const replay = this.replay; await replay.catch(() => undefined); if (replay === this.replay) break; }
      checkSize();
      if (this.ready && (!this.ws || !this.replayed.get(this.ws)?.delete(request.id))) this.send(request);
    });
    void persisted.catch(() => undefined);
    void sent.catch(() => { this.pending.delete(request.id); });
    return { persisted, response: sent.then(() => response) };
  }
  /** Retry a fenced delivery after an uncertain local persistence failure.
   * Receipts/outbox replay decide the outcome; never synthesize an ack. */
  reconnectAfterDeliveryFailure(): void {
    if (!this.stopped) {
      // A successful hello alone does not mean a broken disk recovered. Keep
      // exponential backoff until an actual delivery receipt is settled.
      this.attempt = Math.max(this.attempt, Math.min(6, this.deliveryRecoveryAttempt++));
      this.options.onWarning?.("gateway_delivery_recovery"); this.ws?.terminate();
    }
  }
  deliverySettled(): void { this.deliveryRecoveryAttempt = 0; this.attempt = 0; }
  async disconnect(): Promise<void> {
    this.stopped = true; this.ready = false; if (this.reconnect) clearTimeout(this.reconnect); if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.readyTimeout) clearTimeout(this.readyTimeout);
    this.ws?.terminate(); for (const p of this.pending.values()) p.reject(new Error("gateway_stopped")); this.pending.clear(); this.transient.clear(); await this.boot; await this.diskTail; await this.statusTail;
  }
}
export async function readGatewaySecret(file: string): Promise<string> {
  const metadata = await stat(file);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Gateway key must be owner-only (0600)");
  const secret = (await readFile(file, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error("invalid_gateway_key");
  return secret;
}
