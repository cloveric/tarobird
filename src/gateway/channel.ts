import { WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY, WORKBENCH_SLIDES_CAPABILITY, isSlidesRequest, designOperationCapability } from "../client-protocol/workbench-design.js";
import { WORKBENCH_CAPABILITY, WORKBENCH_MARKDOWN_CAPABILITY, workbenchReceiptSchema, workbenchPublishedSource, workbenchContextSchema, workbenchContextOmittedSchema, type WorkbenchSource, type WorkbenchRequest, type WorkbenchContext, type WorkbenchContextOmitted } from "../client-protocol/workbench.js";
import { widgetsEnabled } from "../runtime/widget-policy.js";
import { backgroundTaskSchema } from "../client-protocol/background-task.js";
import { BACKGROUND_TASK_GROUP_CAPABILITY, backgroundTaskGroupSourceSchema } from "../client-protocol/background-task-group.js";
import { scopedTaskLabelSchema } from "../client-protocol/engine-tasks.js";
import { summarizeRecordedChanges } from "../core/recorded-diff.js";
import { RUN_CHANGES_CAPABILITY } from "../client-protocol/run-changes.js";
import { queueNoticeSchema } from "../client-protocol/queue-notice.js";
import { publicThinkingPreview } from "../client-protocol/run-thinking.js";
import { attachmentMime } from "../client-protocol/attachment-mime.js";
import { RUN_CAPABILITY, RUN_SCOPES_CAPABILITY, isRunActive, anyRun, runSummarySchema, scopedJournal, type RunEntry, type ScopedJournal } from "../client-protocol/run.js";
import { routeAlertSchema } from "../hub/route-monitor.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { widgetBlock, type WidgetInput } from "../client-protocol/widget.js";
import { validateWidget } from "../runtime/widget.js";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import path from "node:path";
import type { CardActionEvent, CommentEvent, NormalizedMessage, RejectEvent } from "../core/channel-events.js";
import { z } from "zod";
import { CHUNK_BYTES, blocksText, conversationSchema, messageSchema, type Block, type CardElement, type Conversation, type Json, type Message } from "../client-protocol/index.js";
import { newId } from "../hub/store.js";
import { withChannelProfile } from "./platform-profile.js";
import type { CoreFetchedMessage, CoreRuntimeChannelLike, CoreSendOptions, CoreStreamControllerLike } from "../core/types.js";
import { translateCard } from "./card-translator.js";
import { GatewayTransport } from "./transport.js";
import { GatewayReceipts } from "./receipts.js";
import { GatewayRunWriter } from "./run-writer.js";
import type { GroupDiscussionDispatch } from "../client-protocol/group-discussion.js";
import type { AgentBusDispatch } from "../client-protocol/agent-bus.js";
import { groupDiscussionPrompt } from "./group-discussion.js";
import type { CronExecutor } from "../runtime/cron-scheduler.js";

const context = new AsyncLocalStorage<{ conversationId: string; messageId?: string; workbench?: WorkbenchContext; workbenchContextOmitted?: WorkbenchContextOmitted; queueSlot?: boolean; ticket?: Conversation["ticket"]; botSource?: Message["botSource"]; groupDiscussion?: GroupDiscussionDispatch; admit?: () => void }>();
const inputSchema = z.object({ widget: z.unknown().optional(), text: z.string().optional(), markdown: z.string().optional(), card: z.unknown().optional(), post: z.unknown().optional(), image: z.unknown().optional(), file: z.unknown().optional(), audio: z.unknown().optional(), video: z.unknown().optional() });
/** Upload failed before any publish request. Safe to repair with a new call ID. */
export class GatewayArtifactUploadError extends Error {
  constructor(readonly code: "upload_failed" | "too-large", readonly status?: number, readonly index?: number) { super(code); }
}
export interface GatewayArtifact {
  bytes: Buffer; name: string; mime: string; kind: "file" | "image" | "audio" | "video"; caption?: string;
}
export class GatewayChannel implements CoreRuntimeChannelLike {
  readonly profile = "gateway" as const;
  private readonly events = new EventEmitter();
  private readonly messageCache = new Map<string, { message: Message; bytes: number }>();
  private cachedMessageBytes = 0;
  private readonly conversations = new Map<string, Conversation>();
  private readonly processing = new Set<string>();
  private readonly processingAgentBus = new Map<string, string>();
  private readonly admissions = new Map<string, Promise<void>>();
  private readonly receipts: GatewayReceipts;
  private runWriter: GatewayRunWriter;
  private scopedRunWriter: GatewayRunWriter;
  private readonly updates = new Map<string, Promise<void>>();
  private readonly tasks = new Set<Promise<void>>();
  private receiveMessage!: (message: Message, conversation: Conversation, agentBus?: AgentBusDispatch, groupDiscussion?: GroupDiscussionDispatch, queueSlot?: boolean, workbench?: WorkbenchContext, workbenchContextOmitted?: WorkbenchContextOmitted) => Promise<void>;
  prepareConversation?: (chatId: string) => Promise<void>;
  canSteerConversation?: (chatId: string) => Promise<boolean>;
  /** A replayed Agent Bus input can carry a stop issued while it was running. */
  onAgentBusStopRequested?: (runId: string) => void;
  onCall?: (method: string, params: Json) => Promise<Json>;
  runCron?: CronExecutor;
  beforeDisconnect?: () => void | Promise<void>;
  /** A successful durable receipt can outlive its final run-card publication. */
  onRecoveredDelivery?: () => Promise<void>;
  isBusy(): boolean { return this.processing.size > 0 || this.tasks.size > 0 || this.updates.size > 0 || this.runWriter.isBusy() || this.scopedRunWriter.isBusy() || this.transport.isBusy(); }
  constructor(readonly transport: GatewayTransport) {
    this.receipts = new GatewayReceipts(transport.options.stateDir);
    this.runWriter = new GatewayRunWriter(input => transport.request("run.write", input));
    this.scopedRunWriter = new GatewayRunWriter(input => transport.request("run.scope.write", input));
    this.receiveMessage = async (message, conversation, agentBus, groupDiscussion, queueSlot = false, workbench, workbenchContextOmitted) => {
      if (this.processing.has(message.id)) { if (agentBus?.stopRequested) this.onAgentBusStopRequested?.(agentBus.runId); return; }
      this.processing.add(message.id); if (agentBus) this.processingAgentBus.set(message.id, agentBus.runId); this.rememberMessage(message); this.conversations.set(conversation.id, conversation);
      const previous = this.admissions.get(conversation.id);
      let release!: () => void;
      const admitted = new Promise<void>((resolve) => { release = resolve; });
      this.admissions.set(conversation.id, admitted);
      const admit = () => { release(); if (this.admissions.get(conversation.id) === admitted) this.admissions.delete(conversation.id); };
      // Only a Hub-dispatched turn record selects discussion execution, and only
      // for the conversation the Hub froze it for.
      const discussion = groupDiscussion?.conversationId === conversation.id && conversation.type === "group" ? groupDiscussion : undefined;
      const task = withChannelProfile("gateway", () => context.run({ conversationId: conversation.id, messageId: message.id, workbench: workbenchContextOmitted ? undefined : workbench, workbenchContextOmitted, queueSlot, ticket: conversation.ticket, botSource: message.botSource, ...(discussion ? { groupDiscussion: discussion } : {}), admit }, async () => {
        try {
          await previous;
          let executed = false;
          const receipt = await this.receipts.run(`message:${message.id}`, async () => {
          executed = true;
          const incoming = this.incoming(message, conversation);
          // A discussion input is addressed to this Bot by the Hub. Its engine
          // text is the user's topic; the topic message is the reference parent
          // for attachments only, not a quoted reply context.
          const { replyToMessageId: _quoted, ...unquoted } = incoming;
          const normalized: NormalizedMessage = discussion ? { ...unquoted, content: groupDiscussionPrompt(discussion), mentionedBot: true, groupDiscussion: discussion }
            : { ...incoming, ...(agentBus ? { agentBus } : {}) };
          if (message.replyTo) {
            const parent = await this.message(message.replyTo);
            if (parent.conversationId === conversation.id) {
              // The topic itself is not quoted, but an explicit user quote on
              // that topic still uses Core's normal quoted-context handling.
              if (discussion && parent.replyTo) normalized.replyToMessageId = parent.replyTo;
              const previous = this.incoming(parent, conversation).resources;
              for (const resource of previous) if (!normalized.resources.some((r) => r.fileKey === resource.fileKey)) normalized.resources.push(resource);
            }
          }
          for (const listener of this.events.listeners("message")) await (listener as (value: NormalizedMessage) => Promise<void>)(normalized);
          return null;
          });
          if (!receipt.ok) {
            await transport.request("delivery.fail", { messageId: message.id, reason: receipt.error === "operation_interrupted" ? "interrupted" : "failed" });
          }
          await transport.request("ack", { messageId: message.id });
          transport.deliverySettled();
          // The boot sweep deliberately skips pending inputs. A cached success
          // retires that fence without executing the turn, so sweep once more
          // after its ack. The service retains the original boot cutoff; live
          // turns and autonomous work from this worker remain untouched.
          if (!executed && receipt.ok) await this.onRecoveredDelivery?.();
        } catch (error) {
          // A receipt/outbox write may have failed after execution. Reattach so
          // the durable receipt can settle the fence without repeating work.
          transport.reconnectAfterDeliveryFailure();
          this.events.emit("error", error instanceof Error ? error : new Error("gateway_message_failed"));
        }
        finally { admit(); this.processing.delete(message.id); this.processingAgentBus.delete(message.id); await transport.refreshStatus(); }
      }));
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
      return task;
    };
    transport.onMessage = async (message, conversation, agentBus, groupDiscussion, workbench, workbenchContextOmitted) => { void this.receiveMessage(message, conversation, agentBus, groupDiscussion, false, workbench, workbenchContextOmitted).catch(() => transport.reconnectAfterDeliveryFailure()); };
    transport.onCall = async (method, params) => withChannelProfile("gateway", async () => {
      const p = z.record(z.string(), z.json()).parse(params);
      if (method === "interaction") {
        const data = z.object({ receiptId: z.string(), conversationId: z.string(), messageId: z.string(), userId: z.string(), actionId: z.string(), tag: z.string().default("button"), name: z.string().optional(), value: z.unknown(), values: z.record(z.string(), z.unknown()) }).parse(p);
        return this.receipts.run(`interaction:${data.receiptId}`, async () => {
        const selected = data.values[data.name ?? data.actionId];
        const action = { tag: data.tag, name: data.name, value: data.value, ...(typeof selected === "string" ? { option: selected } : {}), ...(Array.isArray(selected) ? { options: selected } : {}), form_value: data.values };
        const event: CardActionEvent = { chatId: data.conversationId, messageId: data.messageId, operator: { openId: `gwuser_${data.userId}` }, action, raw: { event: { action }, action } };
        await context.run({ conversationId: data.conversationId, messageId: data.messageId }, async () => { for (const listener of this.events.listeners("cardAction")) await (listener as (event: CardActionEvent) => Promise<void>)(event); });
        return null;
        });
      }
      if (method === "route.alert") { const alert = routeAlertSchema.parse(params); return this.receipts.run(`route-alert:${alert.id}`, async () => { if (!this.onCall) throw new Error("route_alert_handler_unavailable"); return this.onCall(method, params); }, 45 * 60_000); }
      if (method === "restart") { const { receiptId } = z.object({ receiptId: z.string().min(1).max(128) }).parse(params); return this.receipts.run(`restart:${receiptId}`, async () => await this.onCall?.(method, params) ?? null); }
      return this.onCall?.(method, params) ?? null;
    });
  }
  on(name: "message", handler: (message: NormalizedMessage) => void | Promise<void>): () => void;
  on(name: "reject", handler: (event: RejectEvent) => void): () => void;
  on(name: "cardAction", handler: (event: CardActionEvent) => void | Promise<void>): () => void;
  on(name: "comment", handler: (event: CommentEvent) => void | Promise<void>): () => void;
  on(name: "error", handler: (error: Error) => void): () => void;
  on(name: string, handler: (...args: never[]) => unknown): () => void {
    const listener = (...args: unknown[]) => (handler as (...values: unknown[]) => unknown)(...args);
    this.events.on(name, listener); return () => this.events.off(name, listener);
  }
  connect(): Promise<void> { return this.transport.connect(); }
  supportsScopedRunPresentation(): boolean { return !!this.transport.capabilities?.includes(RUN_CAPABILITY) && this.transport.capabilities.includes(RUN_SCOPES_CAPABILITY); }
  inConversation<T>(conversationId: string, operation: () => T): T { return withChannelProfile("gateway", () => context.run({ conversationId }, operation)); }
  currentConversationId(): string | undefined { return context.getStore()?.conversationId; }
  currentMessageId(): string | undefined { return context.getStore()?.messageId; }
  currentTicket(): Conversation["ticket"] { return context.getStore()?.ticket; }
  workbenchContextOmitted(): WorkbenchContextOmitted | undefined { return context.getStore()?.workbenchContextOmitted; }
  async workbenchContext(): Promise<WorkbenchContext | undefined> {
    const turn = context.getStore();
    if (!turn?.messageId || !this.transport.capabilities.includes(WORKBENCH_CAPABILITY) || turn.botSource || turn.groupDiscussion) return undefined;
    return turn.workbench;
  }
  async workbench(request: WorkbenchRequest, signal?: AbortSignal) {
    const turn = context.getStore();
    if (!turn?.messageId || turn.botSource || turn.groupDiscussion) throw new Error("workbench_user_turn_required");
    if (turn.workbenchContextOmitted) throw new Error("workbench_context_unavailable");
    if (!this.transport.capabilities.includes(WORKBENCH_CAPABILITY)) throw new Error("workbench_host_update_required");
    const feature = designOperationCapability(request.operation); if(feature && !this.transport.capabilities.includes(feature)) throw new Error("workbench_design_suite_host_update_required");
    if (isSlidesRequest(request) && !this.transport.capabilities.includes(WORKBENCH_SLIDES_CAPABILITY)) throw new Error("workbench_slides_host_update_required");
    if (request.operation.startsWith("design.") && !this.transport.capabilities.includes(WORKBENCH_DESIGN_CAPABILITY)) throw new Error("workbench_design_host_update_required");
    // The Host resolves the opener of the latest input that reached this turn.
    if (request.operation === "design.open" && !this.transport.capabilities.includes(WORKBENCH_DESIGN_OPEN_CAPABILITY)) throw new Error("workbench_design_open_host_update_required");
    if (request.operation.startsWith("markdown.") && !this.transport.capabilities.includes(WORKBENCH_MARKDOWN_CAPABILITY)) throw new Error("workbench_markdown_host_update_required");
    try { return workbenchReceiptSchema.parse(await this.transport.requestLive("workbench.command", { conversationId: turn.conversationId, contextMessageId: turn.messageId, request: { ...request, contextMessageId: turn.messageId } }, signal)); }
    catch (error) {
      if (signal?.aborted) await this.transport.requestLive("workbench.cancel", {conversationId: turn.conversationId, contextMessageId: turn.messageId, requestId: request.requestId}, AbortSignal.timeout(2000)).catch(() => undefined);
      throw error;
    }
  }
  async workbenchImage(image: { bytes: Buffer; mime: string; name: string }, signal?: AbortSignal): Promise<string> {
    const turn = context.getStore(); if (!turn?.messageId || turn.botSource || turn.groupDiscussion) throw new Error("workbench_user_turn_required");
    if (turn.workbenchContextOmitted) throw new Error("workbench_context_unavailable");
    const created = z.object({id: z.string()}).parse(await this.http("workbench/uploads", "POST", JSON.stringify({ conversationId: turn.conversationId, contextMessageId: turn.messageId, name: image.name, mime: image.mime, size: image.bytes.length, sha256: createHash("sha256").update(image.bytes).digest("hex") }), signal));
    const status = z.object({complete: z.boolean(), chunks: z.array(z.number())}).parse(await this.http(`uploads/${created.id}`, "GET", undefined, signal));
    if (!status.complete) {
      for (let offset=0; offset<image.bytes.length; offset+=CHUNK_BYTES) if (!status.chunks.includes(offset/CHUNK_BYTES)) await this.http(`uploads/${created.id}/${offset/CHUNK_BYTES}`, "PUT", image.bytes.subarray(offset,offset+CHUNK_BYTES), signal);
      await this.http(`uploads/${created.id}/complete`, "POST", undefined, signal);
    }
    return created.id;
  }
  async workbenchScreenshot(requestId: string, attachmentId: string, signal?: AbortSignal): Promise<Buffer> {
    const turn = context.getStore(); if (!turn?.messageId) throw new Error("workbench_user_turn_required");
    const response = await fetch(`${this.transport.httpUrl}/api/instance/workbench/screenshot`, { method: "POST", signal,
      headers: { authorization: this.transport.authHeader, "Content-Type": "application/json" }, body: JSON.stringify({ requestId, attachmentId, contextMessageId: turn.messageId, conversationId: turn.conversationId }) });
    if (!response.ok || Number(response.headers.get("content-length")) > 4 * 1024 * 1024) throw new Error("workbench_screenshot_download_failed");
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body!) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error("workbench_screenshot_too_large"); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  isProcessingAgentBus(runId: string, messageId: string): boolean { return this.processingAgentBus.get(messageId) === runId; }
  currentBotSource(): Message["botSource"] { return context.getStore()?.botSource; }
  currentGroupDiscussion(): GroupDiscussionDispatch | undefined { return context.getStore()?.groupDiscussion; }
  releaseMessageAdmission(): void { context.getStore()?.admit?.(); }
  /** Read-only: an input for this conversation was received but its Core turn
   * has not been admitted to the Core queue yet. */
  hasPendingAdmission(conversationId: string): boolean { return this.admissions.has(conversationId); }
  ownsMessageQueueSlot(chatId: string, messageId: string): boolean {
    const current = context.getStore();
    return current?.queueSlot === true && current.conversationId === chatId && current.messageId === messageId;
  }
  /** A Hub steering record sent to a background-review target becomes a new
   * foreground turn that replies to it, with the admission fields set by the
   * steering handler. The record has no delivery row: it is never acknowledged
   * or failed as a delivery, and its own receipt runs the turn at most once. */
  dispatchNativeTurn(message: Message, conversation: Conversation, admission: Required<Pick<NormalizedMessage, "reviewAdmission" | "nativeInput">>): Promise<void> {
    if (this.processing.has(message.id)) return Promise.resolve();
    this.processing.add(message.id); this.rememberMessage(message); this.conversations.set(conversation.id, conversation);
    const previous = this.admissions.get(conversation.id);
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { release = resolve; });
    this.admissions.set(conversation.id, admitted);
    const admit = () => { release(); if (this.admissions.get(conversation.id) === admitted) this.admissions.delete(conversation.id); };
    // Optional: this turn's own frozen opener, under a live-only Hub lease that
    // ends with the turn. Any failure only leaves Workbench unauthorized.
    const designOpen = this.transport.capabilities.includes(WORKBENCH_DESIGN_OPEN_CAPABILITY), lease = { conversationId: conversation.id, messageId: message.id };
    const begin = async () => {
      if (!designOpen) return undefined;
      try { return z.object({ workbench: workbenchContextSchema.optional(), workbenchContextOmitted: workbenchContextOmittedSchema.optional() }).parse(await this.transport.requestLive("workbench.turn.begin", lease, AbortSignal.timeout(5_000))); }
      catch { return undefined; }
    };
    // Also after an uncertain begin; before the turn releases its slot.
    const end = async () => { if (designOpen) await this.transport.requestLive("workbench.turn.end", lease, AbortSignal.timeout(2_000)).catch(() => undefined); };
    const task = begin().then(turn => withChannelProfile("gateway", () => context.run({ conversationId: conversation.id, messageId: message.id, admit, ...(turn?.workbenchContextOmitted ? { workbenchContextOmitted: turn.workbenchContextOmitted } : turn?.workbench ? { workbench: turn.workbench } : {}) }, async () => {
      try {
        await previous;
        await this.receipts.run(`native-turn:${message.id}`, async () => {
          const normalized: NormalizedMessage = { ...this.incoming(message, conversation), ...admission };
          for (const listener of this.events.listeners("message")) await (listener as (value: NormalizedMessage) => Promise<void>)(normalized);
          return null;
        });
      } catch (error) { this.events.emit("error", error instanceof Error ? error : new Error("gateway_native_turn_failed")); }
      finally { await end(); admit(); this.processing.delete(message.id); await this.transport.refreshStatus(); }
    })));
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
    return task;
  }
  async takeQueued(conversationId: string): Promise<boolean> {
    const next = await this.transport.takeQueued(conversationId);
    if (!next) return false;
    if (next.conversation.id !== conversationId || next.message.conversationId !== conversationId) throw new Error("gateway_queue_scope_mismatch");
    await this.receiveMessage(next.message, next.conversation, undefined, undefined, true, next.workbench, next.workbenchContextOmitted);
    return true;
  }
  async disconnect(): Promise<void> {
    await this.beforeDisconnect?.();
    // Both writers register their pending durable batches before transport stop.
    const journalStop = this.runWriter.stop(), scopedStop = this.scopedRunWriter.stop();
    await this.transport.disconnect(); await Promise.allSettled([journalStop, scopedStop, ...this.tasks]);
    this.messageCache.clear(); this.cachedMessageBytes = 0; this.conversations.clear();
    this.runWriter = new GatewayRunWriter(input => this.transport.request("run.write", input));
    this.scopedRunWriter = new GatewayRunWriter(input => this.transport.request("run.scope.write", input));
  }
  async uploadImage(bytes: Buffer): Promise<string> {
    const conversationId = context.getStore()?.conversationId; if (!conversationId) throw new Error("image_upload_requires_conversation");
    return this.upload(conversationId, bytes, "image.png", "image/png");
  }
  async downloadMessageResource(messageId: string, fileKey: string): Promise<NodeJS.ReadableStream> {
    const message = await this.message(messageId);
    const parent = message.replyTo ? await this.message(message.replyTo) : undefined;
    const ids = this.attachmentIds(message.blocks);
    if (parent?.conversationId === message.conversationId) ids.push(...this.attachmentIds(parent.blocks));
    if (!ids.includes(fileKey)) throw new Error("resource_not_in_message");
    return Readable.from(await this.downloadResource(fileKey));
  }
  private attachmentIds(blocks: Block[]): string[] { const ids: string[] = []; for (const b of blocks) { if ("attachmentId" in b) ids.push(b.attachmentId); if (b.type === "card") { const walk = (elements: typeof b.elements) => { for (const e of elements) { if (e.attachmentId) ids.push(e.attachmentId); walk(e.children ?? []); } }; walk(b.elements); } } return ids; }
  private incoming(message: Message, conversation: Conversation): NormalizedMessage {
    const resources: NormalizedMessage["resources"] = [];
    for (const b of message.blocks) {
      if ("attachmentId" in b) resources.push({ type: b.type === "image" ? "image" : b.type === "audio" ? "audio" : "file", fileKey: b.attachmentId, fileName: "name" in b ? b.name : b.type === "image" ? b.title : undefined });
      if (b.type === "card") {
        const walk = (elements: typeof b.elements) => { for (const e of elements) { if (e.attachmentId && !resources.some((r) => r.fileKey === e.attachmentId)) resources.push({ type: "image", fileKey: e.attachmentId, fileName: e.text }); walk(e.children ?? []); } };
        walk(b.elements);
      }
    }
    const content = blocksText(message.blocks);
    // Forwarded slash-prefixed content is reference material, not a fresh command.
    const prefix = message.forwardedFrom ? `[Forwarded message from ${message.forwardedFrom.authorName} · ${message.forwardedFrom.conversationTitle}]\n` : "";
    // Routing consent comes from this human's text, not a forwarded caption,
    // Bot delegation, card label, filename or any other presentation envelope.
    const asrRoutingText = message.authorType === "user" && !message.forwardedFrom && !message.botSource
      ? message.blocks.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") : "";
    // Hub-owned ticket marker: the worker Bot's config.json stays unchanged.
    const model = conversation.ticket?.model?.trim(), effort = conversation.ticket?.effort || undefined, workspace = conversation.ticket?.workspace;
    return { ...(message.botSource ? { botSource: message.botSource } : {}), ...(model || effort ? { engineOverride: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } } : {}), ...(workspace ? { workspaceOverride: workspace } : {}), messageId: message.id, chatId: message.conversationId, chatType: conversation.type === "direct" ? "p2p" : "group", senderId: `gwuser_${message.authorId}`, content: prefix + content, asrRoutingText, rawContentType: "text", resources, mentions: [], mentionedBot: conversation.type === "direct" || !!message.mentions?.includes(this.transport.options.botId), mentionAll: false, ...(message.replyTo ? { replyToMessageId: message.replyTo } : {}), createTime: message.createdAt };
  }
  private forgetMessage(id: string): void {
    const old = this.messageCache.get(id);
    if (old) { this.cachedMessageBytes -= old.bytes; this.messageCache.delete(id); }
  }
  private rememberMessage(message: Message): void {
    this.forgetMessage(message.id);
    const bytes = Buffer.byteLength(JSON.stringify(message));
    // Keep recent stream updates fast, but never retain an unbounded transcript
    // in a long-running worker. Oversized messages remain available from Hub.
    if (bytes > 1024 * 1024) return;
    this.messageCache.set(message.id, { message, bytes }); this.cachedMessageBytes += bytes;
    while (this.messageCache.size > 128 || this.cachedMessageBytes > 8 * 1024 * 1024) this.forgetMessage(this.messageCache.keys().next().value!);
  }
  private async message(id: string): Promise<Message> {
    const cached = this.messageCache.get(id);
    if (cached) { this.messageCache.delete(id); this.messageCache.set(id, cached); return cached.message; }
    return messageSchema.parse(await this.transport.request("fetch", { messageId: id }));
  }
  private async settleScopedJournal(target: { messageId: string; conversationId: string; runId: string }, revision: number, ok: boolean): Promise<void> {
    const work = (this.updates.get(target.messageId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const old = await this.message(target.messageId);
      if (old.conversationId !== target.conversationId || old.status === "deleted") return;
      let changed = false;
      const blocks = old.blocks.map(block => {
        if (block.type !== "card") return block;
        const run = anyRun(block);
        if (!run || run.id !== target.runId || run.revision !== revision || isRunActive(run.phase)) return block;
        const sync = scopedJournal(block, run);
        if (!sync?.pending && (ok || run.detailsUnavailable)) return block;
        changed = true;
        return { ...block, extra: { ...block.extra, ...(sync ? { scopedJournal: { ...sync, pending: false } } : {}), ...(!ok ? { [block.extra?.scopedRun !== undefined ? "scopedRun" : "nativeRun"]: { ...run, detailsUnavailable: true } } : {}) } };
      });
      if (!changed) return;
      // Keep the current body and status, never replay the captured terminal
      // card over a newer publication or manufacture another reply.
      const message = messageSchema.parse(await this.transport.request("publish", { id: old.id, conversationId: old.conversationId, blocks, version: old.version + 1, status: old.status }));
      this.rememberMessage(message);
    });
    this.updates.set(target.messageId, work);
    try { await work; } finally { if (this.updates.get(target.messageId) === work) this.updates.delete(target.messageId); }
  }
  private async runCard(card: unknown, messageId: string, conversationId: string): Promise<{ block: Block; afterPublish?: () => void }> {
    const raw = z.record(z.string(), z.unknown()).parse(card);
    // Always consume producer-only grouping: translation would otherwise keep it
    // as an unknown property and bypass the Hub capability gate.
    const { appRun, appBackgroundTask, appScopedTask, appScopedGroup, appQueue, ...fallback } = raw;
    let translated = translateCard(fallback, () => this.transport.options.onWarning?.("card_property_preserved"));
    const queue = queueNoticeSchema.safeParse(appQueue);
    if (queue.success) translated = { ...translated, extra: { ...translated.extra, appQueue: queue.data } };
    else if (appQueue !== undefined) translated = { ...translated, extra: { ...translated.extra, appQueue: null } }; // Do not reinterpret an unknown version as a historical queue notice.
    const background = backgroundTaskSchema.safeParse(appBackgroundTask);
    if (background.success) translated = { ...translated, extra: { ...translated.extra, backgroundTask: background.data } };
    const taskLabel = scopedTaskLabelSchema.safeParse(appScopedTask);
    if (taskLabel.success) translated = { ...translated, extra: { ...translated.extra, scopedTask: taskLabel.data } };
    if (!this.transport.capabilities?.includes(RUN_CAPABILITY) || !appRun) return { block: translated };
    const bundle = appRun as { summary: unknown; entries: RunEntry[]; background?: boolean; goalTurnEnded?: boolean };
    const scopesSupported = this.transport.capabilities.includes(RUN_SCOPES_CAPABILITY);
    // Old clients must keep the static background report: nativeRun exposes
    // conversation-level stop controls that could cancel a newer foreground turn.
    if (bundle.background && !scopesSupported) return { block: translated };
    const parsed = runSummarySchema.safeParse(bundle.summary);
    // Native process metadata is optional. Keep the original readable card if
    // it is malformed or from an unsupported summary version.
    if (!parsed.success) return { block: translated };
    const summary = parsed.data;
    const target = { messageId, conversationId, runId: summary.id };
    let afterPublish: (() => void) | undefined;
    let sync: ScopedJournal | undefined;
    try {
      const entries = this.runWriter.capture(target, bundle.entries.filter(entry => !entry.scope));
      const active = isRunActive(summary.phase);
      const available = active ? !this.runWriter.unavailable(target) : await this.runWriter.flush(target, entries);
      if (!available) summary.detailsUnavailable = true;
      if (active) afterPublish = this.runWriter.holdForPublication(target, entries);
    } catch {
      // Malformed optional evidence must not swallow a readable response.
      summary.detailsUnavailable = true;
    }
    if (scopesSupported) {
      try {
        const scoped = this.scopedRunWriter.capture(target, bundle.entries.filter(entry => !!entry.scope));
        if (this.scopedRunWriter.unavailable(target)) summary.detailsUnavailable = true;
        // Scope evidence never delays the final answer or blocks the primary
        // writer. Its own durable queue drains after the body is published.
        const rootPublished = afterPublish;
        if (!isRunActive(summary.phase) && (scoped.length || this.scopedRunWriter.hasPending(target))) sync = { runId: summary.id, revision: summary.revision, pending: true };
        const scopedPublished = this.scopedRunWriter.holdForPublication(target, scoped);
        afterPublish = () => {
          rootPublished?.(); scopedPublished();
          if (!isRunActive(summary.phase)) {
            // An acknowledgement updates only sync metadata, even after the UI's
            // bounded catch-up window. Slow success is never reported as failure.
            const completion = this.scopedRunWriter.flush(target, []).then(ok => this.settleScopedJournal(target, summary.revision, ok)).catch(() => undefined);
            this.tasks.add(completion);
            void completion.finally(() => this.tasks.delete(completion));
          }
        };
      } catch { summary.detailsUnavailable = true; }
    }
    const changes = !bundle.background && !isRunActive(summary.phase) && !summary.detailsUnavailable && this.transport.capabilities.includes(RUN_CHANGES_CAPABILITY)
      ? { v: 1, runId: summary.id, revision: summary.revision, ...summarizeRecordedChanges(bundle.entries) } : undefined;
    if (changes) changes.partial ||= summary.truncated || ["stopped", "error", "interrupted", "partial"].includes(summary.phase);
    const thinking = !bundle.background ? publicThinkingPreview(bundle.entries, summary) : undefined;
    const goalTurnEnded = !bundle.background && bundle.goalTurnEnded === true && summary.phase === "done"
      ? { runId: summary.id, revision: summary.revision } : undefined;
    // A presentation hint for bound background reports only, bound to this
    // scoped summary. Each member keeps its own message, journal and status.
    const group = scopesSupported && bundle.background && background.success && background.data.origin === "bound" && this.transport.capabilities.includes(BACKGROUND_TASK_GROUP_CAPABILITY)
      ? backgroundTaskGroupSourceSchema.safeParse(appScopedGroup) : undefined;
    return { block: { ...translated, extra: { ...translated.extra, ...(goalTurnEnded ? { goalTurnEnded } : {}), ...(thinking ? { nativeRunThinking: thinking } : {}), ...(changes ? { runChanges: changes } : {}), ...(sync ? { scopedJournal: sync } : {}), ...(group?.success ? { backgroundTaskGroup: { ...group.data, runId: summary.id } } : {}), [bundle.background ? "scopedRun" : "nativeRun"]: JSON.parse(JSON.stringify(summary)) } }, afterPublish };
  }

  async send(to: string, raw: unknown, opts: CoreSendOptions = {}): Promise<{ messageId: string }> {
    const input = inputSchema.parse(raw); const blocks: Block[] = []; const id = newId("msg");
    let widgetFallback: Block | undefined;
    if (input.widget !== undefined) {
      const widget = validateWidget(input.widget);
      widgetFallback = { type: "text", text: `${widget.title}\n\n${widget.summary}` };
      blocks.push(widgetsEnabled() ? widgetBlock(widget) : widgetFallback);
    }
    if (input.text !== undefined || input.markdown !== undefined) blocks.push({ type: "text", text: input.markdown ?? input.text ?? "" });
    const prepared = input.card ? await this.runCard(input.card, id, to) : undefined;
    try {
      if (prepared) blocks.push(prepared.block);
      if (input.post) { const post = z.record(z.string(), z.unknown()).parse(input.post); blocks.push({ type: "text", text: JSON.stringify(post) }); }
      for (const kind of ["image", "file", "audio", "video"] as const) {
        if (!input[kind]) continue;
        const file = z.object({ source: z.instanceof(Buffer), fileName: z.string().optional() }).parse(input[kind]);
        const name = file.fileName ?? (kind === "image" ? "image.png" : kind === "audio" ? "recording.ogg" : "attachment.bin");
        const audioMime: Record<string, string> = { ".ogg": "audio/ogg", ".opus": "audio/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".flac": "audio/flac", ".webm": "audio/webm" };
        const mime = kind === "image" ? "image/png" : kind === "audio" ? audioMime[path.extname(name).toLowerCase()] ?? "application/octet-stream" : attachmentMime(name);
        const attachmentId = await this.upload(to, file.source, name, mime);
        blocks.push(kind === "image" ? { type: "image", attachmentId } : kind === "audio" ? { type: "audio", attachmentId, name } : { type: "file", attachmentId, name, size: file.source.length, mime });
      }
      const publish = () => this.transport.request("publish", { id, conversationId: to, blocks, replyTo: opts.replyTo, version: 1, status: this.cardStatus(input.card) });
      let published;
      try { published = await publish(); }
      catch (error) {
        if (!widgetFallback || blocks[0] === widgetFallback || !(error instanceof Error) || !["widgets_disabled", "widget_settings_unavailable"].includes(error.message)) throw error;
        // A compatibility directive cannot receive a native error result. Keep
        // its useful conclusion if the host disabled the visual in flight.
        blocks[0] = widgetFallback; published = await publish();
      }
      const message = messageSchema.parse(published);
      this.rememberMessage(message); return { messageId: id };
    } finally { prepared?.afterPublish?.(); }
  }
  async sendWidget(input: { conversationId: string; messageId: string; replyTo?: string; widget: WidgetInput; signal: AbortSignal }): Promise<{ messageId: string; source?: WorkbenchSource }> {
    input.signal.throwIfAborted();
    if (!widgetsEnabled()) throw new Error("widgets_disabled");
    const message = messageSchema.parse(await this.transport.request("publish", { id: input.messageId, conversationId: input.conversationId,
      replyTo: input.replyTo, blocks: [widgetBlock(validateWidget(input.widget))], version: 1, status: "complete" }));
    this.rememberMessage(message); return { messageId: message.id, source: workbenchPublishedSource(message) };
  }
  /** Native App delivery publishes the caption and attachment in one message.
   * The caller owns path validation and the durable tool-call receipt. */
  async sendArtifact(input: { conversationId: string; messageId: string; replyTo?: string; bytes: Buffer; name: string; mime: string; kind: "file" | "image" | "audio" | "video"; caption?: string; abortSignal: AbortSignal; onActivity?: () => void }): Promise<{ messageId: string }> {
    let attachmentId: string;
    try {
      input.abortSignal.throwIfAborted();
      attachmentId = await this.upload(input.conversationId, input.bytes, input.name, input.mime, input.abortSignal, input.onActivity);
      input.abortSignal.throwIfAborted();
    } catch (error) { throw error instanceof GatewayArtifactUploadError ? error : new GatewayArtifactUploadError("upload_failed"); }
    const blocks: Block[] = input.caption ? [{ type: "text", text: input.caption }] : [];
    blocks.push(input.kind === "image" ? { type: "image", attachmentId, title: input.name }
      : input.kind === "audio" ? { type: "audio", attachmentId, name: input.name }
      : { type: "file", attachmentId, name: input.name, size: input.bytes.length, mime: input.mime });
    const message = messageSchema.parse(await this.transport.request("publish", { id: input.messageId, conversationId: input.conversationId, replyTo: input.replyTo, blocks, version: 1, status: "complete" }));
    this.rememberMessage(message);
    return { messageId: message.id };
  }
  /** Publish only after every upload has completed. No partial visible gallery. */
  async sendArtifactBatch(input: { conversationId: string; messageId: string; replyTo?: string; artifacts: GatewayArtifact[]; caption?: string; abortSignal: AbortSignal; onActivity?: () => void }): Promise<{ messageId: string }> {
    const uploaded: Array<GatewayArtifact & { attachmentId: string }> = [];
    let index = 0;
    try {
      for (const artifact of input.artifacts) {
        input.abortSignal.throwIfAborted();
        const attachmentId = await this.upload(input.conversationId, artifact.bytes, artifact.name, artifact.mime, input.abortSignal, input.onActivity);
        uploaded.push({ ...artifact, attachmentId });
        index++;
      }
      input.abortSignal.throwIfAborted();
    } catch (error) {
      throw new GatewayArtifactUploadError(error instanceof GatewayArtifactUploadError ? error.code : "upload_failed", error instanceof GatewayArtifactUploadError ? error.status : undefined, index < input.artifacts.length ? index : undefined);
    }
    const blocks: Block[] = input.caption ? [{ type: "text", text: input.caption }] : [];
    const images = uploaded.filter((artifact) => artifact.kind === "image");
    if (images.length) blocks.push({ type: "card", elements: images.map((image) => ({ type: "image", attachmentId: image.attachmentId, text: image.caption || image.name })) });
    for (const artifact of uploaded.filter((entry) => entry.kind !== "image")) {
      if (artifact.caption) blocks.push({ type: "text", text: artifact.caption });
      blocks.push(artifact.kind === "audio" ? { type: "audio", attachmentId: artifact.attachmentId, name: artifact.name }
        : { type: "file", attachmentId: artifact.attachmentId, name: artifact.name, size: artifact.bytes.length, mime: artifact.mime });
    }
    const message = messageSchema.parse(await this.transport.request("publish", { id: input.messageId, conversationId: input.conversationId, replyTo: input.replyTo, blocks, version: 1, status: "complete" }));
    this.rememberMessage(message);
    return { messageId: message.id };
  }
  async updateCard(messageId: string, card: object): Promise<void> {
    const work = (this.updates.get(messageId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const old = await this.message(messageId);
      const prepared = await this.runCard(card, messageId, old.conversationId);
      try {
        const message = messageSchema.parse(await this.transport.request("publish", { id: messageId, conversationId: old.conversationId, blocks: [prepared.block], version: old.version + 1, status: this.cardStatus(card) }));
        this.rememberMessage(message);
      } finally { prepared.afterPublish?.(); }
    });
    this.updates.set(messageId, work);
    try { await work; } finally { if (this.updates.get(messageId) === work) this.updates.delete(messageId); }
  }
  async closeInactiveQuestion(input: { chatId: string; messageId: string; requestId: string; card: object }): Promise<boolean> {
    const message = await this.message(input.messageId);
    if (message.conversationId !== input.chatId || message.authorType !== "bot" || message.authorId !== this.transport.options.botId) return false;
    const matches = (elements: CardElement[]): boolean => elements.some(element => {
      const value = element.value && typeof element.value === "object" && !Array.isArray(element.value) ? element.value : {};
      return element.type === "button" && value.cctb_lark === "ask_user_question" && value.requestId === input.requestId || matches(element.children ?? []);
    });
    if (!message.blocks.some(block => block.type === "card" && matches(block.elements))) return false;
    await this.updateCard(message.id, input.card);
    return true;
  }
  private cardStatus(card: unknown): "streaming" | "complete" {
    // App delivery/stop confirmation remain active even though the legacy
    // transport has already disabled its own streaming presentation.
    const native = z.object({ appRun: z.object({ summary: runSummarySchema, background: z.boolean().optional() }) }).safeParse(card);
    // Read-only process reports must never activate the conversation composer,
    // including on older clients that only inspect the message envelope.
    if (native.success && native.data.appRun.background) return "complete";
    if (native.success) return isRunActive(native.data.appRun.summary.phase) ? "streaming" : "complete";
    const parsed = z.object({ config: z.object({ streaming_mode: z.boolean().optional() }).optional() }).safeParse(card);
    return parsed.success && parsed.data.config?.streaming_mode ? "streaming" : "complete";
  }
  async stream(to: string, input: { card: { initial: object; producer: (controller: CoreStreamControllerLike) => Promise<void> } }, opts?: CoreSendOptions): Promise<{ messageId: string }> {
    const result = await this.send(to, { card: input.card.initial }, opts);
    const controller: CoreStreamControllerLike = { messageId: result.messageId, current: input.card.initial, update: async (next) => { controller.current = typeof next === "function" ? next(controller.current) : next; await this.updateCard(result.messageId, controller.current); } };
    await input.card.producer(controller); return result;
  }
  async recallMessage(id: string): Promise<void> { const message = await this.message(id); await this.transport.request("publish", { id, conversationId: message.conversationId, blocks: [], status: "deleted", version: message.version + 1 }); this.forgetMessage(id); }
  async addReaction(id: string, emojiType: string): Promise<string> { const message = await this.message(id); const reactionId = newId("reaction"); await this.transport.request("reaction", { conversationId: message.conversationId, payload: { messageId: id, emojiType, reactionId, removed: false } }); return reactionId; }
  async removeReaction(id: string, reactionId: string): Promise<void> { const message = await this.message(id); await this.transport.request("reaction", { conversationId: message.conversationId, payload: { messageId: id, reactionId, removed: true } }); }
  async removeReactionByEmoji(id: string, emojiType: string): Promise<boolean> { await this.removeReaction(id, emojiType); return true; }
  async fetchMessage(id: string): Promise<CoreFetchedMessage | null> { const m = await this.message(id); return { messageId: m.id, messageType: "text", content: JSON.stringify({ text: blocksText(m.blocks) }), senderId: m.authorId, createTime: String(m.createdAt) }; }
  async getChatMode(id: string): Promise<"p2p" | "group"> { const c = this.conversations.get(id) ?? conversationSchema.parse(await this.transport.request("conversation", { conversationId: id })); return c.type === "direct" ? "p2p" : "group"; }
  async getChatTopicForm(): Promise<boolean> { return false; }
  async downloadResource(id: string): Promise<Buffer> { const response = await fetch(`${this.transport.httpUrl}/api/instance/attachments/${encodeURIComponent(id)}`, { headers: { authorization: this.transport.authHeader } }); if (!response.ok) throw new Error("resource_download_failed"); return Buffer.from(await response.arrayBuffer()); }
  private async http(endpoint: string, method: string, body?: string | Buffer, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.transport.httpUrl}/api/instance/${endpoint}`, { method, signal, headers: { authorization: this.transport.authHeader }, ...(body !== undefined ? { body: typeof body === "string" ? body : new Uint8Array(body) } : {}) });
    if (!response.ok) throw new GatewayArtifactUploadError(response.status === 413 ? "too-large" : "upload_failed", response.status); return response.json();
  }
  /** Stage a temporary side output through normal authenticated uploads. No
   * message is published; unreferenced blobs use the existing orphan policy. */
  async uploadSideArtifact(conversationId: string, artifact: GatewayArtifact, signal: AbortSignal, onActivity?: () => void): Promise<string> {
    signal.throwIfAborted();
    return this.upload(conversationId, artifact.bytes, artifact.name, artifact.mime, signal, onActivity);
  }
  private async upload(conversationId: string, bytes: Buffer, name: string, mime: string, signal?: AbortSignal, onActivity?: () => void): Promise<string> {
    const activity = () => { try { onActivity?.(); } catch { /* Liveness must not fail a completed upload step. */ } };
    const created = z.object({ id: z.string() }).parse(await this.http("uploads", "POST", JSON.stringify({ conversationId, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }), signal));
    activity();
    const status = z.object({ complete: z.boolean(), chunks: z.array(z.number()) }).parse(await this.http(`uploads/${created.id}`, "GET", undefined, signal));
    activity();
    if (!status.complete) {
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) if (!status.chunks.includes(offset / CHUNK_BYTES)) {
        await this.http(`uploads/${created.id}/${offset / CHUNK_BYTES}`, "PUT", bytes.subarray(offset, offset + CHUNK_BYTES), signal); activity();
      }
      await this.http(`uploads/${created.id}/complete`, "POST", undefined, signal);
      activity();
    }
    return created.id;
  }
}
