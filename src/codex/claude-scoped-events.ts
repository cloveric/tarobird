import { randomUUID } from "node:crypto";
import type { EngineStreamEvent, ScopedEngineEvent } from "./adapter.js";
import type { RunScope } from "../client-protocol/run.js";

type Emit = (event: EngineStreamEvent) => void | Promise<void>;
export type ClaudeScopeOwner = { emit: Emit; turnId?: number; origin: "bound" | "unattributed"; inputOwnerKey?: string };
type Partial = { kind: "text" | "thinking"; raw: string; visible: string };
export type ClaudeScope = {
  scope: RunScope; rootScope?: RunScope; owner: ClaudeScopeOwner;
  taskId?: string; background: boolean; launchedDetached: boolean; closed: boolean;
  tools: Set<string>;
  partialBlocks: Map<number, Partial>;
  seenFrames: Set<string>; deliveries: Set<Promise<void>>;
};
type Frame = { type?: string; uuid?: string; event?: unknown; result?: string; is_error?: boolean;
  message?: { id?: string; content?: Array<{ type?: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> };
  tool_use_result?: unknown;
};
const MAX_SCOPES = 128, MAX_DEPTH = 8, MAX_PARTIAL = 65536;
const delegate = (name: unknown) => name === "Agent" || name === "Task";
const detached = (input: unknown) => !!input && typeof input === "object" && (input as Record<string, unknown>).run_in_background === true;

/** Ownership is registered at tool start. Native child IDs never select a new
 * turn's callback, session, permission handler or tool executor. */
export class ClaudeScopedEvents {
  private scopes = new Set<ClaudeScope>();
  private inFlight = new Set<Promise<void>>();
  private delegates = new Map<string, Set<ClaudeScope>>();
  private retiredCallIds = new Set<string>();
  private childToolIds = new Set<string>();
  constructor(private helpers: {
    sanitize: (text: string, partial?: boolean) => string;
    flatten: (content: unknown) => string | undefined;
    evidence: (value: unknown) => PartialToolEvidence;
  }) {}
  private create(owner: ClaudeScopeOwner, kind: RunScope["kind"], label?: string, parent?: ClaudeScope, callId?: string, background = false, taskId?: string): ClaudeScope | undefined {
    if (owner.origin !== "bound" || this.scopes.size >= MAX_SCOPES) return undefined;
    let depth = 0, id = parent?.scope.parentId;
    while (id && depth++ < MAX_DEPTH) id = [...this.scopes].find(s => s.scope.id === id)?.scope.parentId;
    if (depth >= MAX_DEPTH) return undefined;
    const scope: RunScope = { id: randomUUID(), kind, ...(label ? { label: label.slice(0, 512) } : {}),
      ...(parent ? { parentId: parent.scope.id } : {}), ...(callId ? { parentCallId: callId.slice(0, 512) } : {}) };
    const state: ClaudeScope = { scope, rootScope: parent && !background ? parent.rootScope ?? parent.scope : undefined, owner,
      taskId, background: background || !!parent?.background, launchedDetached: background, tools: new Set(), partialBlocks: new Map(), closed: false, seenFrames: new Set(), deliveries: new Set() };
    this.scopes.add(state);
    this.emit(state, { type: "scope_status", status: "running" });
    return state;
  }
  registerDelegate(callId: string, name: unknown, input: unknown, owner: ClaudeScopeOwner, parent?: ClaudeScope): ClaudeScope | undefined {
    if (!delegate(name) || !callId || callId.length > 512 || parent?.closed || this.retiredCallIds.has(callId)) return undefined;
    const candidates = this.delegates.get(callId) ?? new Set<ClaudeScope>();
    const existing = [...candidates].find(s => s.owner.emit === owner.emit && s.owner.turnId === owner.turnId && s.scope.parentId === parent?.scope.id);
    if (existing) return existing;
    const label = input && typeof input === "object" && typeof (input as Record<string, unknown>).description === "string"
      ? (input as { description: string }).description : String(name);
    const state = this.create(owner, "subagent", label, parent, callId, detached(input));
    if (state) { candidates.add(state); this.delegates.set(callId, candidates); }
    return state;
  }
  findDelegate(callId: string): ClaudeScope | undefined {
    const candidates = [...(this.delegates.get(callId) ?? [])].filter(s => !s.closed);
    // Duplicate native IDs in different contexts are ambiguous, not permission
    // to pick the newest task. Native protocol has no other parent identity.
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  hasChildTool(callId: string): boolean { return this.childToolIds.has(callId); }
  /** Includes final card persistence after its scope has already closed. */
  hasPendingDeliveries(): boolean { return this.inFlight.size > 0; }
  toolScopes(callId: string): ClaudeScope[] {
    return [...this.scopes].filter(state => !state.closed && state.scope.kind === "subagent" && state.tools.has(callId));
  }
  startReview(owner: ClaudeScopeOwner, taskId?: string, label?: string): ClaudeScope | undefined {
    const state = this.create(owner, "background", label, undefined, undefined, true, taskId);
    if (state) state.taskId = taskId;
    return state;
  }
  bindTask(callId: string | undefined, taskId: string): void {
    const state = callId ? this.findDelegate(callId) : undefined;
    if (state) { state.taskId = taskId; state.background = true; state.launchedDetached = true; }
  }
  emit(state: ClaudeScope, event: ScopedEngineEvent): void {
    if (state.closed) return;
    if (event.type === "tool_use" && event.toolUseId) {
      if (state.tools.size < 1024) state.tools.add(event.toolUseId);
      if (state.scope.kind === "subagent") {
        this.childToolIds.add(event.toolUseId);
        while (this.childToolIds.size > 4096) this.childToolIds.delete(this.childToolIds.values().next().value!);
      }
    }
    if (event.type === "tool_result" && event.toolUseId) state.tools.delete(event.toolUseId);
    const wrapper: Extract<EngineStreamEvent, { type: "scoped" }> = {
      type: "scoped", scope: state.scope, ...(state.rootScope ? { rootScope: state.rootScope } : {}),
      origin: state.owner.origin, event, ...(state.taskId ? { taskId: state.taskId } : {}),
      ...(state.background ? { detached: true } : {}),
    };
    // Preserve ordering across asynchronous card creation and the final receipt.
    try {
      const delivery = Promise.resolve(state.owner.emit(wrapper)).then(() => undefined, () => undefined);
      this.inFlight.add(delivery);
      state.deliveries.add(delivery);
      void delivery.finally(() => { this.inFlight.delete(delivery); state.deliveries.delete(delivery); });
    } catch { /* Presentation failure cannot break engine ownership. */ }
  }
  accept(state: ClaudeScope, frame: Frame): void {
    if (state.closed) return;
    if (frame.uuid) {
      if (state.seenFrames.has(frame.uuid)) return;
      state.seenFrames.add(frame.uuid);
      while (state.seenFrames.size > 256) state.seenFrames.delete(state.seenFrames.values().next().value!);
    }
    if (frame.type === "stream_event") {
      const e = frame.event as { type?: string; index?: number; content_block?: { type?: string; text?: string; thinking?: string }; delta?: { type?: string; text?: string; thinking?: string } } | undefined;
      if (e?.type === "message_start") { state.partialBlocks.clear(); return; }
      if (!e || !Number.isSafeInteger(e.index) || e.index! < 0) return;
      const kind = e.type === "content_block_start" ? e.content_block?.type : e.delta?.type === "text_delta" ? "text" : e.delta?.type === "thinking_delta" ? "thinking" : undefined;
      if (kind !== "text" && kind !== "thinking") return;
      const index = e.index!;
      if (e.type === "content_block_start") {
        if (state.partialBlocks.size >= 64 && !state.partialBlocks.has(index)) return;
        const used = [...state.partialBlocks.entries()].reduce((sum, [id, part]) => sum + (id === index ? 0 : part.raw.length), 0);
        const raw = kind === "text" ? e.content_block?.text : e.content_block?.thinking;
        state.partialBlocks.set(index, { kind, raw: typeof raw === "string" ? raw.slice(0, Math.max(0, MAX_PARTIAL - used)) : "", visible: "" });
      } else if (e.type === "content_block_delta") {
        const part = state.partialBlocks.get(index), text = kind === "text" ? e.delta?.text : e.delta?.thinking;
        if (!part || part.kind !== kind || typeof text !== "string") return;
        const used = [...state.partialBlocks.values()].reduce((sum, value) => sum + value.raw.length, 0);
        part.raw += text.slice(0, Math.max(0, MAX_PARTIAL - used));
      } else return;
      const part = state.partialBlocks.get(index)!;
      const visible = this.helpers.sanitize(part.raw, true);
      if (!visible.startsWith(part.visible)) return;
      const text = visible.slice(part.visible.length), continuation = !!part.visible;
      part.visible = visible;
      if (text) this.emit(state, { type: kind === "text" ? "assistant_text" : "thinking", text, delta: continuation });
      return;
    }
    const content = Array.isArray(frame.message?.content) ? frame.message.content.filter(item => item && typeof item === "object") : [];
    if (frame.type === "assistant") {
      for (const [index, item] of content.entries()) {
        if (item.type === "text" || item.type === "thinking") {
          const raw = item.type === "text" ? item.text : item.thinking;
          if (typeof raw !== "string") continue;
          const streamed = state.partialBlocks.get(index);
          const partial = streamed?.kind === item.type ? streamed.visible : undefined, complete = this.helpers.sanitize(raw);
          const continued = !!partial && complete.startsWith(partial);
          const text = continued ? complete.slice(partial!.length) : complete;
          state.partialBlocks.delete(index);
          if (text) this.emit(state, { type: item.type === "text" ? "assistant_text" : "thinking", text, delta: continued });
        } else if (item.type === "tool_use" && typeof item.name === "string") {
          if (typeof item.id === "string") this.registerDelegate(item.id, item.name, item.input, state.owner, state);
          this.emit(state, { type: "tool_use", toolName: item.name, toolInput: item.input, ...(typeof item.id === "string" ? { toolUseId: item.id } : {}) });
        }
      }
      state.partialBlocks.clear();
    } else if (frame.type === "user") {
      const results = content.filter(item => item.type === "tool_result");
      for (const item of results) {
        this.emit(state, { type: "tool_result", ...(typeof item.tool_use_id === "string" ? { toolUseId: item.tool_use_id } : {}),
          output: this.helpers.flatten(item.content), isError: item.is_error === true,
          ...(results.length === 1 ? this.helpers.evidence(frame.tool_use_result) : {}) });
        if (typeof item.tool_use_id === "string") this.finishDelegate(item.tool_use_id, state.owner.turnId, item.is_error ? "error" : "done", state);
      }
    } else if (frame.type === "result") {
      if (typeof frame.result === "string") this.emit(state, { type: "result", text: this.helpers.sanitize(frame.result) });
      this.finish(state, frame.is_error ? "error" : "done");
    }
  }
  finishDelegate(callId: string, turnId: number | undefined, status: "done" | "error", parent?: ClaudeScope): void {
    for (const state of this.delegates.get(callId) ?? []) if (!state.launchedDetached && state.owner.turnId === turnId && state.scope.parentId === parent?.scope.id) this.finish(state, status);
  }
  finishTask(taskId: string, status: "done" | "error" | "unknown" = "unknown"): void {
    for (const state of [...this.scopes]) if (state.scope.kind === "subagent" && state.taskId === taskId) this.finish(state, status);
  }
  finishTurn(turnId: number, status: "done" | "error" | "stopped"): void {
    for (const state of [...this.scopes]) if (!state.background && state.owner.turnId === turnId) this.finish(state, status);
  }
  finish(state: ClaudeScope, status: "done" | "error" | "stopped" | "unknown"): Promise<void> {
    if (state.closed) return Promise.all([...state.deliveries]).then(() => undefined);
    this.emit(state, { type: "scope_status", status });
    state.closed = true;
    state.partialBlocks.clear(); state.seenFrames.clear(); state.tools.clear();
    this.scopes.delete(state);
    if (state.scope.parentCallId) {
      this.retiredCallIds.add(state.scope.parentCallId);
      while (this.retiredCallIds.size > 4096) this.retiredCallIds.delete(this.retiredCallIds.values().next().value!);
      const set = this.delegates.get(state.scope.parentCallId); set?.delete(state);
      if (!set?.size) this.delegates.delete(state.scope.parentCallId);
    }
    const root = state.rootScope?.id ?? state.scope.id;
    const descendants = [...this.scopes].filter(s => s.scope.parentId === state.scope.id && (s.rootScope?.id ?? s.scope.id) === root);
    return Promise.all([...state.deliveries, ...descendants.map(child => this.finish(child, status === "stopped" ? "stopped" : "unknown"))]).then(() => undefined);
  }
  close(): Promise<void> {
    for (const state of [...this.scopes]) void this.finish(state, "stopped");
    return Promise.all([...this.inFlight]).then(() => undefined);
  }
}
type PartialToolEvidence = Pick<Extract<EngineStreamEvent, { type: "tool_result" }>, "changes" | "sources" | "durationMs">;
