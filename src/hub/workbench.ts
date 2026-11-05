import { isSlidesRequest, designReadOperations, designMutationOperations } from "../client-protocol/workbench-design.js";
import { workbenchDesignError } from "../client-protocol/workbench-design.js";
import type { SqlValue } from "./database.js";
import { createHash, randomUUID } from "node:crypto";
import { workbenchContextSchema, workbenchReceiptSchema, workbenchRegistrationSchema, workbenchRequestSchema, workbenchSourceSchema, workbenchTargetSchema, workbenchChartSourceError, workbenchMarkdownError, workbenchOperationKind,
  workbenchDesignOpenResultSchema, isWorkbenchOpener, workbenchOpenerOnly, type WorkbenchContext, type WorkbenchRegistration, type WorkbenchRequest, type WorkbenchReceipt, type WorkbenchTarget, type WorkbenchCommandFrame, type WorkbenchCancelFrame } from "../client-protocol/workbench.js";
import { HubError, type HubStore } from "./store.js";
import { readWorkbenchTurnMetadata, reserveWorkbenchHistory, type WorkbenchHistoryLimits } from "./workbench-history.js";

export interface WorkbenchPeer {
  readonly key: object; readonly userId: string; readonly deviceId: string;
  active(): boolean; validate(): Promise<unknown>;
  send(frame: WorkbenchCommandFrame | WorkbenchCancelFrame): Promise<unknown>;
}
export interface WorkbenchActor { actor?:{kind:"bot"|"user";id:string;name:string}; sourceMessageId?: string; userId: string; conversationId: string; validate(): Promise<unknown>; context?: WorkbenchContext }
type Window = { peer: WorkbenchPeer; registration: WorkbenchRegistration };
type Pending = { actor: WorkbenchActor; window: Window; request: WorkbenchRequest; target: WorkbenchTarget; deadline: number; admitted: boolean; timer: ReturnType<typeof setTimeout>; finish(receipt: WorkbenchReceipt): void };
type Journal = { createdAt?: number; readOnly?: boolean; sourceMessageId?: string; screenshotId?: string; fingerprint: string; target: WorkbenchTarget; receipt?: WorkbenchReceipt };
const key = (deviceId: string, windowId: string) => `${deviceId}:${windowId}`;
const cancelKey = (actor: WorkbenchActor, requestId: string) => [actor.userId, actor.conversationId, actor.sourceMessageId ?? "", requestId].join("\0");
const MAX_EARLY_CANCELS_PER_USER = 64, MAX_EARLY_CANCELS = 1024;
// Received requests, duplicates of one ID included, before the flight limits apply.
const MAX_INTAKES_PER_USER = 32, MAX_INTAKES = 128;
type Intake = { cancelled: boolean; released?: boolean };
const failure = (error: unknown) => error instanceof HubError ? error.code : "workbench_failed";
const capability = (operation: WorkbenchRequest["operation"]) => operation.startsWith("design.comments.") ? "design.comments.v1" : operation.startsWith("design.history.") || operation === "design.restore" ? "design.history.v1" : operation === "design.open" ? "design.open.v1" : operation === "browser" ? "browser.v1" : operation.startsWith("chart.") ? "charts.v1" : operation.startsWith("design.") ? "design.v1" : operation.startsWith("markdown.") ? "markdown.v1" : operation === "tabs.list" ? undefined : "whiteboard.v1";
export const workbenchContextKey = (messageId: string) => `workbench-context:${messageId}`;
/** Exactly {target, openTarget} naming the same window: nothing else frozen. */
const pureOpener = (context: WorkbenchContext) => workbenchOpenerOnly(context) && Object.keys(context).length === 2;

/** A bounded command bridge, not a content sync service. All authority is from
 * authenticated sessions and the source user turn; renderer metadata cannot
 * grant another user's device or bypass conversation membership. */
export class WorkbenchBroker {
  private readonly windows = new Map<string, Window>();
  private readonly pending = new Map<string, Pending>();
  private readonly flights = new Map<string, { fingerprint: string; sourceMessageId?: string; promise: Promise<WorkbenchReceipt> }>();
  /** Requests the broker has received, by cancel key: a cancel binds to them. */
  private readonly intakes = new Map<string, Set<Intake>>();
  /** Cancels that overtook their command before it reached the broker, for one deadline. */
  private readonly cancels = new Map<string, number>();
  private readonly userIntakes = new Map<string, number>();
  private intakeCount = 0;
  /** Terminal: after close nothing registers or dispatches, even on resume. */
  private closed = false;
  constructor(private readonly store: HubStore, private readonly timeoutMs = 25_000, private readonly historyLimits?: WorkbenchHistoryLimits) {}
  private member(userId: string, conversationId: string) { return this.store.db.serial(() => this.store.requireMember(userId, conversationId)); }
  private get<T>(sql: string, params: SqlValue[]) { return this.store.db.serial(() => this.store.db.get<T>(sql, params)); }
  private run(sql: string, params: SqlValue[]) { return this.store.db.serial(() => this.store.db.run(sql, params)); }


  async register(peer: WorkbenchPeer, input: unknown): Promise<void> {
    const registration = workbenchRegistrationSchema.parse(input);
    if (this.closed) throw new HubError("workbench_host_stopping", 503);
    await peer.validate(); await this.member(peer.userId, registration.conversationId);
    if (this.closed) throw new HubError("workbench_host_stopping", 503);
    if (!peer.active()) throw new HubError("workbench_app_unavailable", 409);
    const id = key(peer.deviceId, registration.windowId), previous = this.windows.get(id);
    // Openers are lightweight chat endpoints with their own bounds, so visible
    // chats never consume the quota for real Workbench panels.
    const opener = isWorkbenchOpener(registration), alike = [...this.windows.values()].filter(w => isWorkbenchOpener(w.registration) === opener);
    if ((!previous || isWorkbenchOpener(previous.registration) !== opener) && (alike.length >= (opener ? 64 : 128) || alike.filter(w => w.peer.userId === peer.userId).length >= (opener ? 8 : 16))) throw new HubError("workbench_window_limit", 429);
    if (previous && (previous.peer.key !== peer.key || previous.registration.generation !== registration.generation || previous.registration.conversationId !== registration.conversationId)) this.remove(previous, "workbench_target_replaced");
    const window = previous && previous.peer.key === peer.key && previous.registration.generation === registration.generation && previous.registration.conversationId === registration.conversationId ? previous : { peer, registration };
    window.registration = registration; this.windows.set(id, window);
    // Before admission a vanished Tab means nothing ran. After admission the
    // App owns the outcome (a Bot close removes its own Tab); its receipt, a
    // disconnect or the deadline settles it, never this registration.
    for (const [dispatchId, pending] of this.pending) if (pending.window === window && !pending.admitted && pending.target.tabId && !registration.tabs.some(tab => tab.id === pending.target.tabId)) this.cancel(dispatchId, "workbench_target_closed");
      // A hidden or repurposed opener can no longer open anything it was asked to.
      else if (pending.window === window && !pending.admitted && pending.request.operation === "design.open" && !(isWorkbenchOpener(registration) && registration.visible)) this.cancel(dispatchId, "workbench_open_target_unavailable");
  }
  unregister(peer: WorkbenchPeer, windowId?: string): void {
    for (const window of [...this.windows.values()]) if (window.peer.key === peer.key && (!windowId || window.registration.windowId === windowId)) this.remove(window, "workbench_app_disconnected");
  }
  private remove(window: Window, reason: string): void {
    if (this.windows.get(key(window.peer.deviceId, window.registration.windowId)) === window) this.windows.delete(key(window.peer.deviceId, window.registration.windowId));
    for (const [id, pending] of this.pending) if (pending.window === window) this.cancel(id, reason);
  }
  private cancel(dispatchId: string, reason: string): void {
    const pending = this.pending.get(dispatchId); if (!pending) return;
    void pending.window.peer.send({ v: 1, type: "workbench.cancel", dispatchId, reason }).catch(() => undefined);
    pending.finish({ requestId: pending.request.requestId, target: pending.target, status: pending.admitted ? "unknown" : "not_executed", error: reason });
  }
  async cancelRequest(actor: WorkbenchActor, requestId: string): Promise<void> {
    await actor.validate();
    // Only this user, conversation and source turn. A received request holds its
    // own cancellation until it settles; a command the Hub has not handed to the
    // broker yet is remembered for one deadline, bounded per user and overall.
    const id = cancelKey(actor, requestId), now = Date.now();
    for (const intake of this.intakes.get(id) ?? []) intake.cancelled = true;
    if (this.closed) return;
    for (const [early, expires] of this.cancels) if (expires <= now) this.cancels.delete(early);
    this.cancels.delete(id); this.cancels.set(id, now + this.timeoutMs);
    const user = `${actor.userId}\0`, own = [...this.cancels.keys()].filter(early => early.startsWith(user));
    for (const early of own.slice(0, Math.max(0, own.length - MAX_EARLY_CANCELS_PER_USER))) this.cancels.delete(early);
    while (this.cancels.size > MAX_EARLY_CANCELS) this.cancels.delete(this.cancels.keys().next().value!);
    for (const [dispatchId, pending] of this.pending) if (pending.request.requestId === requestId && pending.actor.userId === actor.userId && pending.actor.conversationId === actor.conversationId && pending.actor.sourceMessageId === actor.sourceMessageId) this.cancel(dispatchId, "workbench_cancelled");
  }
  // Early cancels end with the broker. Received requests keep their own mark
  // until they settle and remove their record themselves.
  close(): void {
    this.closed = true; this.cancels.clear();
    // Requests still awaiting validation can no longer dispatch: drop their
    // records now instead of when (or if) that validation returns.
    for (const intakes of this.intakes.values()) for (const intake of intakes) intake.released = true;
    this.intakes.clear(); this.userIntakes.clear(); this.intakeCount = 0;
    for (const window of [...this.windows.values()]) this.remove(window, "workbench_host_stopping");
  }

  async list(actor: WorkbenchActor): Promise<Array<WorkbenchRegistration & { deviceId: string }>> {
    await actor.validate(); await this.member(actor.userId, actor.conversationId);
    const result: Array<WorkbenchRegistration & { deviceId: string }> = [];
    for (const window of [...this.windows.values()]) {
      if (window.peer.userId !== actor.userId || window.registration.conversationId !== actor.conversationId) continue;
      try { await window.peer.validate(); await this.member(window.peer.userId, window.registration.conversationId); if (!window.peer.active()) throw new Error(); }
      catch { this.remove(window, "workbench_app_disconnected"); continue; }
      result.push({ ...window.registration, deviceId: window.peer.deviceId });
    }
    await actor.validate(); return result;
  }
  /** The sender may freeze an explicitly selected same-user remote desktop,
   * but cannot mint an arbitrary device/window identity in a message. An
   * opener is only ever the sending device's own visible chat. */
  async validateContext(userId: string, conversationId: string, input: unknown, deviceId?: string): Promise<WorkbenchContext> {
    const context = workbenchContextSchema.parse(input), target = context.target;
    // The opener is a locator, not authority: the sender's own device, never
    // contradicting a live registration. A just-retired one may be frozen;
    // design.open later requires it registered and visible, and fails closed.
    if (context.openTarget && (context.openTarget.deviceId !== deviceId || this.openerConflict(userId, conversationId, context.openTarget))) throw new HubError("workbench_open_target_unavailable", 409);
    // A closed panel freezes only the opener: no content, selection or source.
    if (pureOpener(context)) { await this.member(userId, conversationId); return context; }
    const window = this.windows.get(key(target.deviceId, target.windowId));
    if (!window || window.peer.userId !== userId || window.registration.conversationId !== conversationId || !window.peer.active()) throw new HubError("workbench_target_unavailable", 409);
    if (isWorkbenchOpener(window.registration)) throw new HubError("invalid_workbench_context", 400);
    await window.peer.validate(); await this.member(userId, conversationId);
    if (target.tabId && !window.registration.tabs.some(tab => tab.id === target.tabId)) throw new HubError("workbench_target_closed", 409);
    if (context.source) await this.validateSource(userId, conversationId, context.source);
    for (const attachmentId of [...(context.imageEdit?.attachmentIds ?? []), ...(context.imageEdit?.referenceAttachmentIds ?? []), ...(context.imageEdit?.originalAttachmentId ? [context.imageEdit.originalAttachmentId] : [])]) if (!await this.get("SELECT 1 FROM attachments WHERE id=? AND conversation_id=? AND complete=1", [attachmentId, conversationId])) throw new HubError("attachment_not_found", 404);
    return context;
  }
  async contextForMessage(userId: string, messageId: string, conversationId: string): Promise<WorkbenchContext | undefined> {
    const message = await this.store.messageForUser(userId, messageId);
    if (message.conversationId !== conversationId || message.authorType !== "user" || message.authorId !== userId || message.botSource || message.forwardedFrom) throw new HubError("workbench_context_forbidden", 403);
    const metadata = await this.store.db.serial(() => readWorkbenchTurnMetadata(this.store.db, messageId));
    if (metadata.workbenchContextOmitted) throw new HubError("workbench_context_unavailable", 409);
    return metadata.workbench;
  }
  private async validateSource(userId: string, conversationId: string, source: unknown): Promise<void> {
    const parsed = workbenchSourceSchema.safeParse(source);
    if (!parsed.success) throw new HubError("invalid_workbench_source", 400);
    const reference = parsed.data, message = await this.store.messageForUser(userId, reference.messageId);
    if (message.conversationId !== conversationId || message.status === "deleted" || message.version !== reference.version || !message.blocks[reference.blockIndex]) throw new HubError("workbench_source_unavailable", 409);
  }
  private async validatePending(pending: Pending, applied = false): Promise<void> {
    await pending.actor.validate(); await this.member(pending.actor.userId, pending.actor.conversationId);
    const window = pending.window;
    if (Date.now() >= pending.deadline || !window.peer.active() || this.windows.get(key(window.peer.deviceId, window.registration.windowId)) !== window) throw new HubError("workbench_target_unavailable", 409);
    await window.peer.validate();
    if (window.peer.userId !== pending.actor.userId || window.registration.conversationId !== pending.actor.conversationId) throw new HubError("workbench_target_forbidden", 403);
    if (!applied && pending.target.tabId && !window.registration.tabs.some(tab => tab.id === pending.target.tabId)) throw new HubError("workbench_target_closed", 409);
    // design.open reaches only a visible opener and never names a tab. Openers
    // accept nothing else. After admission the App owns the outcome.
    const opening = pending.request.operation === "design.open";
    if (!applied && opening && (pending.target.tabId || !isWorkbenchOpener(window.registration) || !window.registration.visible)) throw new HubError("workbench_open_target_unavailable", 409);
    if (!opening && isWorkbenchOpener(window.registration)) throw new HubError("workbench_capability_unsupported", 409);
    const payload = pending.request.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      if (pending.actor.sourceMessageId && pending.request.operation === "browser" && ["resume", "download_open", "download_reveal", "clear_data", "revoke_scope", "find", "stop_find", "zoom", "device", "print", "save_screenshot", "history", "clear_history", "settings", "settings_set"].includes(String(payload.action))) throw new HubError("workbench_browser_user_action_required", 403);
      const ids = pending.request.operation === "image.insert" ? [payload.attachmentId] : pending.request.operation === "browser" && payload.action === "upload" ? payload.attachmentIds : [];
      if (!Array.isArray(ids) || ids.length > 16) throw new HubError("invalid_workbench_attachments");
      for (const attachmentId of ids) {
        if (typeof attachmentId !== "string" || !await this.get("SELECT 1 FROM attachments a WHERE a.id=? AND a.conversation_id=? AND a.owner_id=? AND a.complete=1 AND NOT EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id) AND (NOT EXISTS(SELECT 1 FROM message_attachments ma WHERE ma.attachment_id=a.id) OR EXISTS(SELECT 1 FROM message_attachments ma JOIN messages m ON ma.message_id=m.id WHERE ma.attachment_id=a.id AND m.status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=m.id AND d.user_id=?)))", [attachmentId, pending.actor.conversationId, pending.actor.userId, pending.actor.userId])) throw new HubError("workbench_attachment_forbidden", 403);
        // Uploading to an external site is narrower than inserting a freshly
        // generated file into this user's board: the user must have supplied
        // the file in this turn, or explicitly quoted the message containing it.
        if (pending.actor.sourceMessageId && pending.request.operation === "browser" && payload.action === "upload" && !await this.get("SELECT 1 FROM message_attachments ma JOIN messages m ON m.id=ma.message_id WHERE ma.attachment_id=? AND (m.id=? OR m.id=(SELECT reply_to FROM messages WHERE id=?)) AND m.conversation_id=? AND m.status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=m.id AND d.user_id=?)", [attachmentId, pending.actor.sourceMessageId, pending.actor.sourceMessageId, pending.actor.conversationId, pending.actor.userId])) throw new HubError("workbench_upload_source_required", 403);
      }
    }
    // Markdown notes have a hard kind boundary: their operations act only on a
    // markdown tab, and no other operation may address one. A missing tab is
    // never replaced by another note. Creates and tabs.list carry no tab.
    const kind = workbenchOperationKind(pending.request.operation), tab = pending.target.tabId ? window.registration.tabs.find(item => item.id === pending.target.tabId) : undefined;
    if (kind && tab && (kind === "design" || tab.kind === "design" || kind === "markdown" || tab.kind === "markdown") && kind !== tab.kind) throw new HubError("workbench_wrong_kind", 409);
    if (!applied && (kind === "markdown" || kind === "design") && !pending.request.operation.endsWith(".create") && !opening && !tab) throw new HubError("workbench_target_required", 400);
    const markdownError = workbenchMarkdownError(pending.request) ?? workbenchDesignError(pending.request);
    if (markdownError) throw new HubError(markdownError, 400);
    if (pending.request.operation.startsWith("chart.")) {
      const error = workbenchChartSourceError(pending.request);
      if (error) throw new HubError(error, 400);
      const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.source : undefined;
      await this.validateSource(pending.actor.userId, pending.actor.conversationId, source);
    }
  }
  async admit(peer: Pick<WorkbenchPeer, "userId" | "deviceId">, dispatchId: string): Promise<{ admitted: true; dispatchId: string; deadline: number; target: WorkbenchTarget; generation: string }> {
    const pending = this.pending.get(dispatchId);
    if (!pending || pending.window.peer.userId !== peer.userId || pending.window.peer.deviceId !== peer.deviceId) throw new HubError("workbench_dispatch_not_found", 404);
    try { await this.validatePending(pending); }
    catch (error) { this.cancel(dispatchId, failure(error)); throw error; }
    if (this.pending.get(dispatchId) !== pending) throw new HubError("workbench_dispatch_expired", 409);
    if (pending.admitted) throw new HubError("workbench_already_admitted", 409);
    pending.admitted = true;
    return { admitted: true, dispatchId, deadline: pending.deadline, target: pending.target, generation: pending.window.registration.generation };
  }
  async receive(peer: WorkbenchPeer, dispatchId: string, input: unknown): Promise<void> {
    const pending = this.pending.get(dispatchId); if (!pending) return;
    if (pending.window.peer.key !== peer.key) throw new HubError("workbench_receipt_forbidden", 403);
    const receipt = workbenchReceiptSchema.parse(input);
    if (receipt.requestId !== pending.request.requestId || receipt.target.deviceId !== pending.target.deviceId || receipt.target.windowId !== pending.target.windowId || receipt.target.tabId !== pending.target.tabId) throw new HubError("workbench_receipt_mismatch", 409);
    if (!pending.admitted && !["not_executed", "cancelled", "conflict"].includes(receipt.status)) throw new HubError("workbench_admission_required", 409);
    try { await this.validatePending(pending, pending.admitted); }
    catch (error) { this.cancel(dispatchId, failure(error)); return; }
    if (receipt.status === "success" && /^(whiteboard\.(create|patch|undo|redo)|design\.(create|publish|open|restore|comments\.(reply|resolve))|markdown\.(create|replace|patch|undo|redo)|chart\.|image\.)/.test(pending.request.operation)) throw new HubError("workbench_saved_receipt_required", 409);
    const shot = receipt.result && typeof receipt.result === "object" && !Array.isArray(receipt.result) ? receipt.result.screenshot : undefined;
    if (shot && typeof shot === "object" && !Array.isArray(shot)) {
      if (typeof shot.attachmentId !== "string" || !await this.get("SELECT 1 FROM attachments WHERE id=? AND conversation_id=? AND owner_id=? AND complete=1 AND size<=4194304 AND mime IN ('image/png','image/jpeg')", [shot.attachmentId, pending.actor.conversationId, pending.actor.userId])) throw new HubError("workbench_screenshot_invalid", 409);
    }
    // The real controller must already be registered by this same socket, so
    // the Bot's next command finds it. Otherwise the App may have opened the
    // panel, but the outcome is unknown and must not be retried.
    if (pending.request.operation === "design.open" && receipt.status === "applied") {
      const opened = workbenchDesignOpenResultSchema.safeParse(receipt.result);
      const real = opened.success && opened.data.target.deviceId === pending.target.deviceId ? this.windows.get(key(opened.data.target.deviceId, opened.data.target.windowId)) : undefined;
      if (!opened.success || !real || real.peer.key !== peer.key || real.registration.conversationId !== pending.actor.conversationId || isWorkbenchOpener(real.registration) || !real.registration.visible || !real.registration.capabilities.includes("design.v1") || isSlidesRequest(pending.request) && (!real.registration.capabilities.includes("design.slides.v1") || real.registration.tabs.find(tab => tab.id === opened.data.target.tabId)?.designFormat !== "slides") || real.registration.tabs.find(tab => tab.id === opened.data.target.tabId)?.kind !== "design") {
        this.cancel(dispatchId, "workbench_open_target_unregistered"); return;
      }
    }
    pending.finish(receipt);
  }
  async request(actor: WorkbenchActor, input: unknown): Promise<WorkbenchReceipt> {
    const request = workbenchRequestSchema.parse(input);
    if (this.closed) throw new HubError("workbench_host_stopping", 503);
    const users = this.userIntakes.get(actor.userId) ?? 0;
    if (this.intakeCount >= MAX_INTAKES || users >= MAX_INTAKES_PER_USER) throw new HubError("workbench_busy", 429);
    // Registered before any await, so a later cancel always finds this request.
    const id = cancelKey(actor, request.requestId), intake: Intake = { cancelled: (this.cancels.get(id) ?? 0) > Date.now() };
    let intakes = this.intakes.get(id); if (!intakes) this.intakes.set(id, intakes = new Set()); intakes.add(intake);
    this.intakeCount++; this.userIntakes.set(actor.userId, users + 1);
    try {
      await actor.validate(); await this.member(actor.userId, actor.conversationId);
      const fingerprint = createHash("sha256").update(JSON.stringify({ request, context: actor.context ?? null })).digest("hex");
      const journalKey = `workbench-command:${actor.userId}:${actor.conversationId}:${request.requestId}`;
      const flight = this.flights.get(journalKey);
      if (flight) { if (flight.fingerprint !== fingerprint || request.operation.startsWith("design.") && flight.sourceMessageId !== actor.sourceMessageId) throw new HubError("request_id_conflict", 409); return await flight.promise; }
      if (this.flights.size >= 64) throw new HubError("workbench_busy", 429);
      const promise = this.execute(actor, request, fingerprint, journalKey, intake); this.flights.set(journalKey, { fingerprint, sourceMessageId: actor.sourceMessageId, promise });
      try { return await promise; } finally { this.flights.delete(journalKey); }
    } finally {
      if (!intake.released) {
        intake.released = true; intakes.delete(intake); if (!intakes.size && this.intakes.get(id) === intakes) this.intakes.delete(id);
        this.intakeCount--; const left = (this.userIntakes.get(actor.userId) ?? 1) - 1;
        if (left > 0) this.userIntakes.set(actor.userId, left); else this.userIntakes.delete(actor.userId);
      }
    }
  }
  async screenshot(actor: WorkbenchActor, requestId: string, attachmentId: string): Promise<void> {
    await actor.validate(); await this.member(actor.userId, actor.conversationId);
    const row = await this.get<{value:string}>("SELECT value FROM meta WHERE key=?", [`workbench-command:${actor.userId}:${actor.conversationId}:${requestId}`]);
    if (!row || (JSON.parse(row.value) as Journal).screenshotId !== attachmentId || (JSON.parse(row.value) as Journal).sourceMessageId !== actor.sourceMessageId) throw new HubError("workbench_screenshot_forbidden", 403);
  }
  /** Inside the send transaction: content targets stay live-guarded; the
   * optional opener only must not have become a contradictory registration. */
  assertContextActive(userId: string, conversationId: string, context: WorkbenchContext): void {
    if (context.openTarget && this.openerConflict(userId, conversationId, context.openTarget)) throw new HubError("workbench_open_target_unavailable", 409);
    if (pureOpener(context)) return;
    const window = this.windows.get(key(context.target.deviceId, context.target.windowId));
    if (!window || !window.peer.active() || window.peer.userId !== userId || window.registration.conversationId !== conversationId || isWorkbenchOpener(window.registration) || context.target.tabId && !window.registration.tabs.some(tab => tab.id === context.target.tabId)) throw new HubError("workbench_target_unavailable", 409);
  }
  /** A live registration at that address that is not this user's opener here. */
  private openerConflict(userId: string, conversationId: string, openTarget: NonNullable<WorkbenchContext["openTarget"]>): boolean {
    const window = this.windows.get(key(openTarget.deviceId, openTarget.windowId));
    return !!window && (window.peer.userId !== userId || window.registration.conversationId !== conversationId || !isWorkbenchOpener(window.registration));
  }
  private async execute(actor: WorkbenchActor, request: WorkbenchRequest, fingerprint: string, journalKey: string, intake: Intake): Promise<WorkbenchReceipt> {
    const old = await this.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [journalKey]);
    if (old) {
      const journal = JSON.parse(old.value) as Journal;
      if (journal.fingerprint !== fingerprint || request.operation.startsWith("design.") && journal.sourceMessageId !== actor.sourceMessageId) throw new HubError("request_id_conflict", 409);
      return journal.receipt ?? { requestId: request.requestId, target: journal.target, status: "unknown", error: "workbench_previous_outcome_unknown" };
    }
    // design.open goes only to the turn's frozen opener (a Bot), or to the
    // owner's explicit opener; never to another window. A context frozen with
    // the panel closed names only that opener and targets nothing else.
    const opening = request.operation === "design.open", opener = actor.sourceMessageId ? actor.context?.openTarget : actor.context?.openTarget ?? request.target;
    if (opening && !opener) throw new HubError("workbench_open_target_required", 400);
    if (opening && request.target && (request.target.tabId || request.target.deviceId !== opener!.deviceId || request.target.windowId !== opener!.windowId)) throw new HubError("workbench_open_target_mismatch", 409);
    const available = await this.list(actor), wanted = opening ? { deviceId: opener!.deviceId, windowId: opener!.windowId } : request.target ?? (workbenchOpenerOnly(actor.context) ? undefined : actor.context?.target);
    // The broker may have stopped, or the window closed, while targets were listed.
    if (this.closed) throw new HubError("workbench_host_stopping", 503);
    const cap = capability(request.operation);
    const matches = available.filter(window => (!isSlidesRequest(request) || window.capabilities.includes("design.slides.v1")) && (!wanted || window.deviceId === wanted.deviceId && window.windowId === wanted.windowId) && (opening ? isWorkbenchOpener(window) && window.visible : !isWorkbenchOpener(window) && (!cap || window.capabilities.includes(cap))));
    if (!matches.length) throw new HubError(opening ? "workbench_open_target_unavailable" : available.length && !wanted ? "workbench_capability_unsupported" : "workbench_app_unavailable", 409);
    if (matches.length !== 1) throw new HubError("workbench_target_ambiguous", 409);
    const chosen = matches[0]!, window = this.windows.get(key(chosen.deviceId, chosen.windowId));
    if (!window) throw new HubError("workbench_app_unavailable", 409);
    const creates = request.operation === "whiteboard.create" || request.operation === "markdown.create" || request.operation === "design.create" || request.operation === "chart.open" || request.operation === "browser" && !!request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) && ["create", "open"].includes(String(request.payload.action));
    // Revisions identify a version within one document, not the document itself.
    // A newly created Design can share its revision with the formerly active tab.
    // Reads may use the turn's exact frozen context; writes must name their tab.
    if (designMutationOperations.includes(request.operation) && !request.target?.tabId || designReadOperations.includes(request.operation) && !wanted?.tabId) throw new HubError("workbench_target_required", 400);
    const tabId = creates || opening || request.operation === "tabs.list" ? undefined : wanted?.tabId ?? chosen.activeTabId;
    if (tabId && !chosen.tabs.some(tab => tab.id === tabId)) throw new HubError("workbench_target_closed", 409);
    const target: WorkbenchTarget = { deviceId: chosen.deviceId, windowId: chosen.windowId, ...(tabId ? { tabId } : {}) };
    // Synchronous with creating the pending command: a later cancel finds it.
    const cancelled = intake.cancelled;
    if (!cancelled && (this.pending.size >= 32 || [...this.pending.values()].filter(p => p.actor.userId === actor.userId).length >= 8)) throw new HubError("workbench_busy", 429);
    const dispatchId = `wb_${randomUUID().replaceAll("-", "")}`, deadline = Date.now() + this.timeoutMs;
    let settle!: (value: WorkbenchReceipt) => void;
    const result = new Promise<WorkbenchReceipt>(resolve => { settle = resolve; });
    const pending: Pending = { actor, window, request, target, deadline, admitted: false, timer: setTimeout(() => this.cancel(dispatchId, "workbench_timeout"), this.timeoutMs), finish: receipt => {
      if (this.pending.get(dispatchId) !== pending) return; this.pending.delete(dispatchId); clearTimeout(pending.timer); settle(receipt);
    } };
    this.pending.set(dispatchId, pending);
    if (cancelled) pending.finish({ requestId: request.requestId, target, status: "not_executed", error: "workbench_cancelled" });
    const journal: Journal = { createdAt: Date.now(), readOnly: ["tabs.list", "whiteboard.read", "markdown.read", ...designReadOperations].includes(request.operation), fingerprint, target, ...(actor.sourceMessageId ? {sourceMessageId: actor.sourceMessageId} : {}) };
    try {
      await this.validatePending(pending);
      await this.store.db.transaction(async () => {
        const value = JSON.stringify(journal);
        if (!await reserveWorkbenchHistory(this.store.db, journalKey, value, this.historyLimits)) throw new HubError("workbench_history_limit", 429);
        await this.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [journalKey, value]);
      });
      // Settled before dispatch (cancel, closed target, disconnect, deadline):
      // never sent, and its outcome is recorded below like any other.
      if (this.pending.get(dispatchId) === pending) await window.peer.send({ v: 1, type: "workbench.command", dispatchId, deadline, userId: actor.userId, conversationId: actor.conversationId, generation: chosen.generation, request, target, ...(actor.actor && (chosen.capabilities.includes("design.history.v1") || chosen.capabilities.includes("design.comments.v1")) ? {actor:actor.actor} : {}) });
    } catch (error) { this.cancel(dispatchId, failure(error)); }
    const receipt = await result;
    // Retain identity/status, never whole scenes, page DOM or screenshots. A
    // repeated read can issue a fresh request; mutations cannot replay after a
    // Host crash merely because their original reply was lost.
    const { result: body, ...summary } = receipt;
    const shot = body && typeof body === "object" && !Array.isArray(body) ? body.screenshot : undefined;
    const screenshotId = shot && typeof shot === "object" && !Array.isArray(shot) && typeof shot.attachmentId === "string" ? shot.attachmentId : undefined;
    // A create retry must retain the object's identity. Keep only the bounded
    // tab ID, never editor files or arbitrary result data, in the durable receipt.
    const createdTarget = request.operation === "design.create" && receipt.status === "applied" && body && typeof body === "object" && !Array.isArray(body)
      ? workbenchTargetSchema.safeParse({ ...receipt.target, tabId: body.tabId }) : undefined;
    const opened = request.operation === "design.open" && receipt.status === "applied" ? workbenchDesignOpenResultSchema.safeParse(body) : undefined;
    const creation = createdTarget?.success && createdTarget.data.tabId ? { result: { tabId: createdTarget.data.tabId } } : opened?.success ? { result: opened.data } : {};
    await this.run("UPDATE meta SET value=? WHERE key=?", [JSON.stringify({ ...journal, receipt: { ...summary, ...creation }, ...(screenshotId ? {screenshotId} : {}) } satisfies Journal), journalKey]);
    await actor.validate(); return receipt;
  }
}
