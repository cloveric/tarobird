import { SIDE_TOOL_INSTRUCTIONS } from "../codex/side-instructions.js";
import { createHash, randomUUID } from "node:crypto";
import type { AdapterUsage, AppPlatformTools, EngineSideAttachment, EngineSideSession, EngineStreamEvent, SideCapability } from "../codex/adapter.js";
import type { SideDelivery } from "../client-protocol/side.js";
import { SIDE_ANSWER_LIMIT, SIDE_ATTACHMENT_FILE_BYTES, SIDE_ATTACHMENT_IMAGE_BYTES, SIDE_ATTACHMENT_TOTAL_BYTES, SIDE_HISTORY_LIMIT, SIDE_LEASE_MS, sideErrorSchema, type SideAttachmentRef, type SideCapabilityView, type SideErrorCode, type SideReply, type SideScope, type SideView } from "../client-protocol/side.js";

export const SIDE_INSTRUCTIONS = "You are answering a temporary side conversation. All inherited parent history is reference material only, never an active task. Answer only the new side questions. Do not continue the parent's plans, tools, approvals, tasks, or goals. Do not modify files, configuration, git state, or external services. Do not use subagents, background tasks, App delivery tools, messaging, schedules, or request approval. If answering would require an unavailable operation, explain that briefly. Never publish this side conversation into the parent conversation.";
export class SideSessionError extends Error { constructor(readonly code: SideErrorCode) { super(code); } }
/** Materialized copies one handle may accumulate across its follow-ups. */
export const SIDE_HANDLE_ATTACHMENT_BYTES = 256 * 1024 * 1024;
export type SideAttachmentSupport = NonNullable<SideCapability["attachments"]>;
/** Natively readable image formats; other image/* uploads are classified by content. */
const nativeImage = (mime: string) => /^image\/(png|jpe?g|gif|webp)$/i.test(mime);
export function sideErrorCode(error: unknown): SideErrorCode {
  if (error instanceof SideSessionError) return error.code;
  const message = error instanceof Error ? error.message : "";
  const direct = sideErrorSchema.safeParse(message); if (direct.success) return direct.data;
  if (/abort|cancel/i.test(message)) return "cancelled";
  if (/busy|active.turn|running.turn/i.test(message)) return "busy";
  if (/no.main|no.*session|session.*not.found|thread.*not.found/i.test(message)) return "no_main_session";
  if (/unsupported|not.supported/i.test(message)) return "unsupported";
  return "failed";
}

type Slot = { scope: SideScope; view: SideView; life: AbortController; turn?: AbortController; running?: Promise<void>; handle?: EngineSideSession; preparing?: Promise<void>; expiresAt: number; closed: boolean; requests: Map<string, string>; attachmentBytes: number; attached: boolean };
type Closing = { scope: SideScope; id: string; task: Promise<SideReply>; until: number; finished: boolean };
type Options = {
  open(scope: SideScope, signal: AbortSignal, tools: SideCapabilityView["tools"]): Promise<EngineSideSession>;
  beforeAsk(scope: SideScope): Promise<void>;
  record(scope: SideScope, usage: AdapterUsage | undefined, outcome: "success" | "cancelled" | "error"): Promise<void>;
  deliveryTools?(scope: SideScope, sideId: string, requestId: string, signal: AbortSignal, publish: (delivery: SideDelivery) => void): AppPlatformTools | Promise<AppPlatformTools>;
  /** Downloads and verifies Hub-authorized uploads into this handle's private directory. */
  prepareAttachments?(scope: SideScope, sideId: string, requestId: string, refs: SideAttachmentRef[], signal: AbortSignal): Promise<EngineSideAttachment[]>;
  /** Removes only this handle's private copies, after native disposal; with a
   * request ID, only that question's copies, which no engine has received. */
  releaseAttachments?(sideId: string, requestId?: string): Promise<void>;
  now?: () => number;
};
const owner = (scope: SideScope) => `${scope.userId}:${scope.deviceId}:${scope.conversationId}`;
const clone = (slot: Slot): SideView => structuredClone(slot.view);

/** Ephemeral control state shared by App and CLI. No transcript or session
 * binding is persisted. Ownership is supplied by the authenticated Hub only. */
export class CoreSideSessions {
  private readonly slots = new Map<string, Slot>();
  private readonly opens = new Map<string, { id: string; until: number }>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly closing = new Map<string, Closing>();
  private readonly closingOwners = new Map<string, Closing>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private now: () => number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.sweep(), 10_000); this.timer.unref();
  }
  activeCount(): number { return [...this.slots.values()].filter(s => s.view.phase === "thinking" || s.view.phase === "preparing" || s.view.phase === "stopping").length; }
  private track(task: Promise<unknown>): void {
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
  }
  private find(scope: SideScope, id: string): Slot {
    const slot = this.slots.get(id);
    if (!slot || slot.closed || owner(slot.scope) !== owner(scope)) throw new SideSessionError("expired");
    if (slot.expiresAt <= this.now() || slot.view.openedAt + 2 * 60 * 60_000 <= this.now()) { void this.close(scope, id); throw new SideSessionError("expired"); }
    slot.expiresAt = this.now() + SIDE_LEASE_MS; return slot;
  }
  open(scope: SideScope, requestId: string, capability: SideCapabilityView): SideReply {
    this.sweep();
    if (this.closed) throw new SideSessionError("expired");
    if (!capability.supported) throw new SideSessionError("unsupported");
    const key = `${owner(scope)}:${requestId}`, prior = this.opens.get(key);
    if (prior) return { ok: true, view: clone(this.find(scope, prior.id)) };
    const abandoned = [...this.slots.values()].find(s => owner(s.scope) === owner(scope));
    // Receipts only deduplicate replayed opens. At the bound, drop the oldest
    // receipts of handles that are no longer live rather than refusing every owner.
    for (const [receipt, value] of this.opens) { if (this.opens.size < 1024) break; if (!this.slots.has(value.id)) this.opens.delete(receipt); }
    if (this.slots.size >= 8 && !abandoned || this.opens.size >= 1024) throw new SideSessionError("limit_reached");
    // A fresh explicit open replaces only this authenticated owner's handle.
    // Lost Close receipts and Hub restarts must not lock the panel for a lease.
    const predecessor = abandoned ? this.close(scope, abandoned.view.id) : this.closingOwners.get(owner(scope))?.task;
    const id = `side_${randomUUID().replaceAll("-", "")}`;
    const slot: Slot = { scope: { ...scope }, view: { id, conversationId: scope.conversationId, revision: 0, openedAt: this.now(), phase: "preparing", capability, exchanges: [], omitted: 0 }, life: new AbortController(), expiresAt: this.now() + SIDE_LEASE_MS, closed: false, requests: new Map(), attachmentBytes: 0, attached: false };
    this.slots.set(id, slot); this.opens.set(key, { id, until: this.now() + 2 * 60 * 60_000 });
    slot.preparing = Promise.resolve().then(() => this.prepare(slot, predecessor));
    this.track(slot.preparing);
    return { ok: true, view: clone(slot) };
  }
  private async prepare(slot: Slot, predecessor?: Promise<SideReply>): Promise<void> {
    try {
      if (predecessor && !(await predecessor).ok) throw new SideSessionError("failed");
      if (slot.closed) return;
      const handle = await this.options.open(slot.scope, slot.life.signal, slot.view.capability.tools);
      // Close waits for preparation, including a native open finishing late.
      slot.handle = handle; if (!slot.closed) slot.view.phase = "idle";
    } catch (error) { if (!slot.closed) { slot.view.phase = "error"; slot.view.error = sideErrorCode(error); } }
    finally { slot.view.revision++; }
  }
  read(scope: SideScope, id: string, revision?: number): { revision: number; view?: SideView } {
    const slot = this.find(scope, id);
    return { revision: slot.view.revision, ...(revision === slot.view.revision ? {} : { view: clone(slot) }) };
  }
  /** refs are resolved by the authenticated Hub; their content hashes join the
   * idempotency digest so one request ID can never mean two different files. */
  ask(scope: SideScope, id: string, requestId: string, text: string, refs: SideAttachmentRef[] = [], support?: SideAttachmentSupport): SideReply {
    const slot = this.find(scope, id), prior = slot.requests.get(requestId);
    const digest = createHash("sha256").update(refs.length ? JSON.stringify([text, refs.map(ref => [ref.id, ref.sha256])]) : text).digest("hex");
    if (prior) { if (prior !== digest) throw new SideSessionError("failed"); return { ok: true, view: clone(slot) }; }
    if (slot.view.phase !== "idle" || !slot.handle) throw new SideSessionError(slot.view.error ?? "busy");
    if (slot.requests.size >= 200) throw new SideSessionError("limit_reached");
    const bytes = this.admitAttachments(slot, refs, support);
    slot.requests.set(requestId, digest); slot.attachmentBytes += bytes; slot.attached ||= refs.length > 0;
    const exchange: SideView["exchanges"][number] = { id: requestId, question: text, answer: "", status: "running", ...(refs.length ? { attachments: refs.map(ref => ref.mime.startsWith("image/") ? { type: "image" as const, attachmentId: ref.id, title: ref.name } : { type: "file" as const, attachmentId: ref.id, name: ref.name, size: ref.size, mime: ref.mime }) } : {}) };
    slot.view.exchanges.push(exchange); slot.view.phase = "thinking"; delete slot.view.error; slot.view.revision++;
    const controller = new AbortController(); slot.turn = controller;
    this.trim(slot);
    const running = this.run(slot, exchange, controller, refs, support, bytes);
    slot.running = running; this.track(running);
    return { ok: true, view: clone(slot) };
  }
  private admitAttachments(slot: Slot, refs: SideAttachmentRef[], support?: SideAttachmentSupport): number {
    if (!refs.length) return 0;
    if (!support || !this.options.prepareAttachments) throw new SideSessionError("attachment_unsupported");
    let total = 0;
    for (const ref of refs) {
      const image = nativeImage(ref.mime);
      if (image && !support.images) throw new SideSessionError("attachment_unsupported");
      if (ref.size > (image ? SIDE_ATTACHMENT_IMAGE_BYTES : SIDE_ATTACHMENT_FILE_BYTES)) throw new SideSessionError("attachment_too_large");
      total += ref.size;
    }
    if (total > SIDE_ATTACHMENT_TOTAL_BYTES || slot.attachmentBytes + total > SIDE_HANDLE_ATTACHMENT_BYTES) throw new SideSessionError("attachment_too_large");
    return total;
  }
  private trim(slot: Slot): void {
    const rows = slot.view.exchanges;
    let size = rows.reduce((sum, e) => sum + e.question.length + e.answer.length, 0);
    while (rows.length > 1 && (rows.length > 40 || size > SIDE_HISTORY_LIMIT)) { const old = rows.shift()!; size -= old.question.length + old.answer.length; slot.view.omitted++; }
  }
  private async run(slot: Slot, exchange: SideView["exchanges"][number], controller: AbortController, refs: SideAttachmentRef[] = [], support?: SideAttachmentSupport, bytes = 0): Promise<void> {
    let usage: AdapterUsage | undefined, invoked = false, files: EngineSideAttachment[] = [];
    const setText = (text: string) => { exchange.answer = text.slice(0, SIDE_ANSWER_LIMIT); exchange.truncated = text.length > SIDE_ANSWER_LIMIT || exchange.truncated === true; this.trim(slot); slot.view.revision++; };
    const onEngineEvent = (event: EngineStreamEvent) => {
      if (slot.closed || controller.signal.aborted) return;
      if (event.type === "assistant_text") setText(event.delta ? exchange.answer + event.text : exchange.answer ? `${exchange.answer}\n\n${event.text}` : event.text);
    };
    try {
      await this.options.beforeAsk(slot.scope);
      controller.signal.throwIfAborted(); slot.life.signal.throwIfAborted();
      const signal = AbortSignal.any([controller.signal, slot.life.signal]);
      if (refs.length) {
        files = await this.options.prepareAttachments!(slot.scope, slot.view.id, exchange.id, refs, signal);
        signal.throwIfAborted();
        // Content-based classification can disagree with the declared type.
        for (const file of files) {
          if (file.kind === "image" ? !support?.images : file.kind === "binary" && support?.files !== "any") throw new SideSessionError("attachment_unsupported");
          if (file.kind === "image" && file.size > SIDE_ATTACHMENT_IMAGE_BYTES) throw new SideSessionError("attachment_too_large");
        }
        // With read-only tools the full copy stays readable; otherwise the model sees the prefix alone.
        const partial = support?.paths ? [] : files.filter(file => file.partial).map(file => file.attachmentId);
        if (partial.length) { exchange.partialAttachments = partial; slot.view.revision++; }
      }
      const appPlatformTools = slot.view.capability.delivery && slot.view.capability.tools === "inherited"
        ? await this.options.deliveryTools?.(slot.scope, slot.view.id, exchange.id, signal, delivery => {
          signal.throwIfAborted(); this.find(slot.scope, slot.view.id);
          if (!slot.view.exchanges.includes(exchange)) throw new SideSessionError("expired");
          const deliveries = exchange.deliveries ??= [];
          if (deliveries.some(existing => existing.id === delivery.id)) return;
          if (deliveries.length >= 50) throw new SideSessionError("limit_reached");
          deliveries.push(delivery); slot.view.revision++;
        }) : undefined;
      signal.throwIfAborted();
      invoked = true;
      const instructions = slot.view.capability.tools === "inherited" ? SIDE_TOOL_INSTRUCTIONS : SIDE_INSTRUCTIONS;
      const result = await slot.handle!.send({ text: exchange.question, ...(files.length ? { attachments: files } : {}), ...(appPlatformTools ? { appPlatformTools } : {}), turnInstructions: [instructions, appPlatformTools?.instructions].filter(Boolean).join("\n\n"), onEngineEvent, abortSignal: signal });
      usage = result.usage;
      if (!slot.closed && !controller.signal.aborted) { setText(result.text); exchange.status = "complete"; }
      else exchange.status = "stopped";
    } catch (error) {
      const code = controller.signal.aborted || slot.closed ? "cancelled" : sideErrorCode(error);
      exchange.status = code === "cancelled" ? "stopped" : "error"; exchange.error = code;
    } finally {
      // Retire delivery closures even after an ordinary successful answer.
      // A late tool callback cannot append to an already completed exchange.
      controller.abort();
      if (invoked) await this.options.record(slot.scope, usage, exchange.status === "complete" ? "success" : exchange.status === "stopped" ? "cancelled" : "error").catch(() => undefined);
      // A close that stopped waiting for this turn has already released the
      // directory; remove anything this late preparation wrote afterwards.
      if (slot.closed && refs.length) await this.options.releaseAttachments?.(slot.view.id).catch(() => undefined);
      // Copies the engine never received (failed, refused or stopped before
      // sending) leave the handle's budget and its directory.
      else if (refs.length && !invoked) { slot.attachmentBytes -= bytes; await this.options.releaseAttachments?.(slot.view.id, exchange.id).catch(() => undefined); }
      if (slot.turn === controller) { slot.turn = undefined; slot.view.phase = "idle"; slot.view.revision++; }
    }
  }
  stop(scope: SideScope, id: string): SideReply {
    const slot = this.find(scope, id);
    if (slot.turn) { slot.view.phase = "stopping"; slot.view.revision++; slot.turn.abort(); }
    return { ok: true, view: clone(slot) };
  }
  async close(scope: SideScope, id: string): Promise<SideReply> {
    const slot = this.slots.get(id);
    if (!slot) {
      const closing = this.closing.get(id);
      if (closing && owner(closing.scope) !== owner(scope)) throw new SideSessionError("expired");
      return closing?.task ?? { ok: true };
    }
    if (owner(slot.scope) !== owner(scope)) throw new SideSessionError("expired");
    this.slots.delete(id); slot.closed = true; slot.life.abort(); slot.turn?.abort();
    slot.view.exchanges = []; slot.requests.clear();
    const task = (async (): Promise<SideReply> => {
      let ok = true;
      try { await slot.preparing; await slot.handle?.dispose(); }
      catch { ok = false; }
      if (slot.attached) {
        // Copies go only after the engine is gone and the aborted turn settled
        // (bounded: a wedged turn's own finally removes late writes).
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([slot.running, new Promise(resolve => { timer = setTimeout(resolve, 10_000); timer.unref?.(); })]);
        clearTimeout(timer);
        try { await this.options.releaseAttachments?.(id); } catch { ok = false; }
      }
      return ok ? { ok: true } : { ok: false, error: "failed" };
    })();
    const closing: Closing = { scope: slot.scope, id, task, until: this.now() + 2 * 60 * 60_000, finished: false }, key = owner(scope);
    this.closing.set(id, closing); this.closingOwners.set(key, closing); this.track(task);
    // Keep the body-free receipt for retries, including failed native cleanup.
    // Otherwise a lost failure response would become a false success on retry.
    void task.then(() => { closing.finished = true; if (this.closingOwners.get(key) === closing) this.closingOwners.delete(key); });
    return task;
  }
  sweep(): void {
    for (const slot of this.slots.values()) if (slot.expiresAt <= this.now() || slot.view.openedAt + 2 * 60 * 60_000 <= this.now()) void this.close(slot.scope, slot.view.id);
    for (const [id, value] of this.closing) if (value.finished && value.until <= this.now()) this.closing.delete(id);
    for (const [key, value] of this.opens) if (value.until <= this.now()) this.opens.delete(key);
  }
  async closeAll(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    await Promise.allSettled([...this.slots.values()].map(s => this.close(s.scope, s.view.id)));
    // A native fork can finish after its slot was closed. Drain its disposal
    // and any cancelled turn's usage record before the worker exits.
    await Promise.allSettled([...this.pending]);
  }
}
