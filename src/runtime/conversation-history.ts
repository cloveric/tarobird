import { SessionHistoryPendingError } from "../state/session-history-error.js";
import { createHash } from "node:crypto";
import type { Json } from "../client-protocol/index.js";
import { historyNativeAnchorSchema, historyNativeResultSchema, type HistoryAction, type HistoryCapabilities, type HistoryInternalSnapshot, type HistoryNativeResult, type HistoryReason } from "../client-protocol/conversation-history.js";
import type { SessionHistoryBinding, SessionHistoryFinalization } from "../state/session-store.js";
import { bridgeConversationLockId, withBridgeTurnLock } from "./turn-lock.js";
import { z } from "zod";
import type { CodexAdapter, NativeHistoryAnchor, NativeHistoryState } from "../codex/adapter.js";

export interface ConversationHistoryScope {
  chatId: number; conversationKey: string; workspaceOverride?: string;
  isCurrentSession?: () => Promise<boolean>;
}
/** Bridge-only provenance, stripped before the Gateway sends the snapshot. */
export type ConversationHistoryRead = HistoryInternalSnapshot & { cachedWhilePending?: true };
export interface ConversationHistoryApply extends ConversationHistoryScope {
  operationId: string; expectedRevision: string; action: HistoryAction; nativeAnchor?: Json;
}
export interface ConversationHistoryFinalize extends ConversationHistoryScope {
  operationId: string; expectedRevision: string; action: HistoryAction; result: HistoryNativeResult;
  destination?: { conversationId: string; chatId: number; conversationKey: string };
}
/** Private adapter contract; no native session identity is accepted from App input. */
export type NativeConversationHistoryState = NativeHistoryState;
export function nativeHistoryAnchor(event: unknown): NativeHistoryAnchor | undefined {
  const result = z.object({ type: z.literal("history_anchor"), anchor: historyNativeAnchorSchema }).safeParse(event);
  return result.success ? result.data.anchor : undefined;
}
export type NativeConversationHistoryAdapter = Pick<CodexAdapter, "getHistoryState" | "forkHistory" | "rewindHistory">;
export interface HistorySessionManager {
  getLockNamespace?(): Promise<string>;
  getHistoryBinding?(scope: ConversationHistoryScope): Promise<SessionHistoryBinding | null>;
  reserveHistory?(scope: ConversationHistoryScope, revision: string, operationId: string): Promise<SessionHistoryBinding>;
  releaseHistory?(scope: ConversationHistoryScope, operationId: string): Promise<void>;
  finalizeHistory?(scope: ConversationHistoryScope, input: SessionHistoryFinalization): Promise<{ revision: string }>;
}
const reject = (reason: HistoryReason): HistoryNativeResult => ({ outcome: "rejected", reason });
const unknown = (): HistoryNativeResult => ({ outcome: "unknown", reason: "uncertain" });
const capabilities = (native: NativeConversationHistoryState): HistoryCapabilities => ({ rewind: native.rewind === true, fork: native.fork?.whole === true, anchoredFork: native.fork?.anchored === true });
const token = (binding: SessionHistoryBinding, head: string, workspace: string | undefined) => createHash("sha256").update(JSON.stringify([
  binding.record.historyGeneration, binding.record.historyRevision, binding.record.codexSessionId, head, workspace ?? null,
])).digest("hex");

/** Coordinates native history with the same locks used by ordinary turns.
 * Gateway receipts own at-most-once invocation. This class never retries a
 * native mutation or treats a missing result as proof that nothing changed. */
/** Conversations whose last capabilities are remembered for busy answers. */
const KNOWN_CAPABILITIES_MAX = 512;

export class ConversationHistoryController {
  /** What each conversation could do when last read. A busy answer carries it
   * (without a revision, so nothing can be admitted) so the App can show the
   * entry disabled with a reason instead of hiding it during a reply. */
  private readonly known = new Map<string, HistoryCapabilities>();
  constructor(private readonly sessions: HistorySessionManager, private readonly adapter: NativeConversationHistoryAdapter,
    private readonly hasNativeReader: (sessionId: string) => boolean = () => false,
    private readonly claim?: (sessionId: string) => (() => void) | undefined,
    private readonly hasSideReader: (sessionId: string) => boolean = () => false) {}

  private supported(): boolean {
    return !!(this.adapter.getHistoryState && this.sessions.getHistoryBinding && this.sessions.reserveHistory && this.sessions.releaseHistory && this.sessions.finalizeHistory);
  }

  /** `turnPending`: a turn for this conversation is queued or running. Answer
   * as when busy, from the binding and the capabilities last read, without the
   * turn lock or a native read, so a slow read cannot delay that turn. Before
   * anything is known in this process, read once as usual. */
  async get(input: ConversationHistoryScope, options: { turnPending?: boolean } = {}): Promise<ConversationHistoryRead> {
    if (!this.supported()) return { supported: false };
    if (options.turnPending && this.known.has(input.conversationKey)) {
      return { ...await this.busySnapshot(input), cachedWhilePending: true };
    }
    try {
      const snapshot = await this.idleLock(input, () => this.inspect(input));
      this.known.delete(input.conversationKey);
      if (snapshot.supported && snapshot.capabilities) {
        this.known.set(input.conversationKey, snapshot.capabilities);
        if (this.known.size > KNOWN_CAPABILITIES_MAX) this.known.delete(this.known.keys().next().value!);
      }
      return snapshot;
    } catch (error) {
      if (error instanceof Error && error.message === "history_busy") return await this.busySnapshot(input);
      throw error;
    }
  }

  private async busySnapshot(input: ConversationHistoryScope): Promise<HistoryInternalSnapshot> {
    const capabilities = this.known.get(input.conversationKey);
    // The binding is a store read, not a turn. With it the Hub still lists
    // this session's anchors, so message entries show disabled as well.
    const binding = await this.sessions.getHistoryBinding!(input).catch(() => null);
    return { supported: true, blocked: "busy", ...(capabilities ? { capabilities } : {}),
      ...(binding?.record.historyGeneration ? { sourceSessionId: binding.record.codexSessionId, bindingGeneration: binding.record.historyGeneration } : {}) };
  }

  private async inspect(input: ConversationHistoryScope): Promise<HistoryInternalSnapshot> {
    if (input.isCurrentSession && !await input.isCurrentSession()) return { supported: false };
    const binding = await this.sessions.getHistoryBinding!(input);
    if (!binding) return { supported: false };
    if (binding.record.historyFence) return { supported: true, blocked: "outcome_unknown", pendingOperation: binding.record.historyFence.operationId };
    const workspaceOverride = input.workspaceOverride ?? binding.record.resume?.workspacePath;
    // Some native reads load/replay a session. They must not race an owned
    // prompt even though they do not change its conversation history.
    const native = await this.idleLock(binding.record.codexSessionId,
      () => this.adapter.getHistoryState!(binding.record.codexSessionId, { workspaceOverride }));
    if (!native) return { supported: false };
    if (native.head === null) return { supported: true, capabilities: capabilities(native), blocked: native.blocked ?? "not_ready" };
    const current = await this.sessions.getHistoryBinding!(input);
    if (!current || current.record.historyRevision !== binding.record.historyRevision || input.isCurrentSession && !await input.isCurrentSession()) return { supported: true, blocked: "source_changed" };
    return {
      supported: true, revision: token(binding, native.head, workspaceOverride), capabilities: capabilities(native),
      sourceSessionId: binding.record.codexSessionId, bindingGeneration: binding.record.historyGeneration,
      ...(current.record.historyFence ? { blocked: "outcome_unknown" as const, pendingOperation: current.record.historyFence.operationId }
        : binding.shared ? { blocked: "shared_session" as const }
        : this.hasNativeReader(binding.record.codexSessionId) ? { blocked: "busy" as const }
        : this.hasSideReader(binding.record.codexSessionId) ? { blocked: "side_session" as const }
        : native.blocked ? { blocked: native.blocked } : {}),
    };
  }

  async apply(input: ConversationHistoryApply): Promise<HistoryNativeResult> {
    if (!this.supported()) return reject("unsupported");
    let reserved = false;
    try {
      return await this.idleLock(input, async () => {
        if (input.isCurrentSession && !await input.isCurrentSession()) return reject("source_changed");
        const binding = await this.sessions.getHistoryBinding!(input);
        if (!binding) return reject("not_ready");
        if (binding.record.historyFence) return reject("outcome_unknown");
        if (binding.shared) return reject("shared_session");
        const sessionId = binding.record.codexSessionId;
        return this.idleLock(sessionId, async () => {
          if (this.hasNativeReader(sessionId)) return reject("busy");
          if (this.hasSideReader(sessionId)) return reject("side_session");
          const release = this.claim?.(sessionId);
          if (this.claim && !release) return reject(this.hasSideReader(sessionId) ? "side_session" : "busy");
          try {
          const workspaceOverride = input.workspaceOverride ?? binding.record.resume?.workspacePath;
          const native = await this.adapter.getHistoryState!(sessionId, { workspaceOverride });
          if (!native) return reject("unsupported");
          if (native.blocked) return reject(native.blocked);
          if (native.head === null) return reject("not_ready");
          if (token(binding, native.head, workspaceOverride) !== input.expectedRevision) return reject("source_changed");
          const point = input.action.kind === "rewind" || input.action.scope === "anchor";
          const supported = capabilities(native);
          if (input.action.kind === "rewind" ? !supported.rewind || !this.adapter.rewindHistory
            : !this.adapter.forkHistory || (point ? !supported.anchoredFork : !supported.fork)) return reject("unsupported");
          if (point && input.nativeAnchor === undefined) return reject("anchor_unavailable");
          const anchor = point ? historyNativeAnchorSchema.safeParse(input.nativeAnchor) : undefined;
          if (point && (!anchor?.success || anchor.data.sessionId !== sessionId
            || input.action.kind === "rewind" && !anchor.data.rewind
            || input.action.kind === "fork" && (!anchor.data.fork || !anchor.data.forkBoundary))) return reject("anchor_unavailable");
          const cut = anchor?.success ? anchor.data : undefined;
          if (input.isCurrentSession && !await input.isCurrentSession()) return reject("source_changed");
          await this.sessions.reserveHistory!(input, binding.record.historyRevision!, input.operationId);
          reserved = true;
          // Recheck authorization after the durable reservation but before the
          // native boundary. An exact refusal can be safely finalized later.
          if (input.isCurrentSession && !await input.isCurrentSession()) return reject("source_changed");
          const result = input.action.kind === "rewind"
            ? await this.adapter.rewindHistory!(sessionId, { expectedHead: native.head, anchor: cut!, workspaceOverride })
            : await this.adapter.forkHistory!(sessionId, { expectedHead: native.head, ...(point ? { anchor: cut } : {}), workspaceOverride });
          const expectedBoundary = input.action.kind === "rewind" ? "before-input" : point ? cut!.forkBoundary : "whole";
          if (result.outcome === "applied" && (result.boundary !== expectedBoundary
            || input.action.kind === "rewind" && !result.excludedInputIds?.includes(cut!.inputId))) return unknown();
          const translated = result.outcome === "applied" ? {
            outcome: "applied", sourceSessionId: sessionId,
            ...(input.action.kind === "fork" ? { destinationSessionId: result.sessionId } : {}),
            ...(result.head !== null ? { nativeHead: result.head } : {}),
            ...(result.boundary !== "whole" ? { forkBoundary: result.boundary } : {}),
            ...(result.excludedInputIds ? { excludedNativeInputIds: result.excludedInputIds } : {}),
          } : result.outcome === "rejected" ? reject(result.reason) : unknown();
          if (result.outcome === "applied" && input.action.kind === "rewind" && result.sessionId !== sessionId) return unknown();
          const parsed = historyNativeResultSchema.safeParse(translated);
          if (!parsed.success) return unknown();
          if (parsed.data.outcome === "applied" && (parsed.data.sourceSessionId !== sessionId
            || input.action.kind === "fork" && (!parsed.data.destinationSessionId || parsed.data.destinationSessionId === sessionId)
            || input.action.kind === "rewind" && (parsed.data.destinationSessionId || !parsed.data.excludedNativeInputIds?.length))) return unknown();
          return parsed.data;
          } finally { release?.(); }
        });
      });
    } catch (error) {
      if (reserved) return unknown();
      const message = error instanceof Error ? error.message : "";
      if (message === "history_busy") return reject("busy");
      if (message === "history_source_changed") return reject("source_changed");
      if (message === "history_shared_session") return reject("shared_session");
      if (message === "history_outcome_pending") return reject("outcome_unknown");
      return reject("storage_unavailable");
    }
  }

  async finalize(input: ConversationHistoryFinalize): Promise<{ revision: string }> {
    if (input.result.outcome === "unknown" || input.result.outcome === "applied" && !this.supported()) throw new SessionHistoryPendingError();
    if (input.result.outcome === "rejected" && !this.sessions.getHistoryBinding) return { revision: input.expectedRevision };
    return this.idleLock(input, async () => {
      const binding = await this.sessions.getHistoryBinding!(input);
      if (input.isCurrentSession && !await input.isCurrentSession()) throw new Error("history_source_changed");
      if (!binding) {
        if (input.result.outcome === "rejected") return { revision: input.expectedRevision };
        throw new Error("history_source_changed");
      }
      if (input.result.outcome === "rejected") {
        if (binding.record.historyFence?.operationId === input.operationId) await this.sessions.releaseHistory!(input, input.operationId);
        else if (binding.record.historyFence) throw new Error("history_source_changed");
        return { revision: binding.record.historyRevision! };
      }
      if (input.result.sourceSessionId !== binding.record.codexSessionId) throw new Error("history_source_changed");
      if (input.action.kind === "fork") {
        if (!input.destination || !input.result.destinationSessionId) throw new Error("history_destination_missing");
        const previousResume = binding.record.resume;
        const workspace = input.workspaceOverride ?? previousResume?.workspacePath;
        return this.sessions.finalizeHistory!(input, { operationId: input.operationId, destination: {
          telegramChatId: input.destination.chatId, conversationKey: input.destination.conversationKey,
          codexSessionId: input.result.destinationSessionId, status: "idle", updatedAt: new Date().toISOString(),
          resume: workspace ? { sessionId: input.result.destinationSessionId, workspacePath: workspace, dirName: previousResume?.dirName ?? "" } : null,
        } });
      }
      return this.sessions.finalizeHistory!(input, { operationId: input.operationId, rewind: true });
    });
  }

  private async idleLock<T>(scope: ConversationHistoryScope | string, task: () => Promise<T>): Promise<T> {
    const id = typeof scope === "string" ? scope : bridgeConversationLockId(scope, await this.sessions.getLockNamespace?.());
    const controller = new AbortController();
    const busy = new Error("history_busy");
    return withBridgeTurnLock(id, task, { signal: controller.signal, waitNotifyAfterMs: 0, onWait: () => controller.abort(busy) });
  }
}
