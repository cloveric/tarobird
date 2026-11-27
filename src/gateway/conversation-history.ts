import { z } from "zod";
import path from "node:path";
import { idSchema, type Json } from "../client-protocol/index.js";
import { CONVERSATION_HISTORY_CAPABILITY, historyActionSchema, historyInternalSnapshotSchema, historyNativeResultSchema, type HistoryAction, type HistoryNativeResult } from "../client-protocol/conversation-history.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../core/message-normalizer.js";
import type { CoreServiceRuntime } from "../core/runtime.js";
import type { CoreBridgeLike } from "../core/types.js";
import type { GatewayChannel } from "./channel.js";
import { GatewayReceipts } from "./receipts.js";
import { readValidatedConfigFile } from "../state/instance-config.js";
import { captureAppToolVersion, inheritAppToolVersion } from "./app-tool-registration.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";

type Scope = { chatId: number; conversationKey: string; workspaceOverride?: string; isCurrentSession: () => Promise<boolean> };
type HistoryBridge = CoreBridgeLike & {
  applyConversationHistory?(input: Scope & { operationId: string; expectedRevision: string; action: HistoryAction; nativeAnchor?: Json }): Promise<HistoryNativeResult>;
  finalizeConversationHistory?(input: Scope & { operationId: string; expectedRevision: string; action: HistoryAction; result: HistoryNativeResult; destination?: { conversationId: string; chatId: number; conversationKey: string } }): Promise<{ revision: string }>;
};
const snapshotReadSchema = historyInternalSnapshotSchema.extend({ cachedWhilePending: z.literal(true).optional() });
const readSchema = z.object({ userId: idSchema, botId: idSchema, conversationId: idSchema }).strict();
const applySchema = readSchema.extend({ operationId: idSchema, expectedRevision: idSchema, action: historyActionSchema,
  nativeAnchor: z.json().optional(), anchorGeneration: idSchema.optional(), anchorSessionId: z.string().min(1).max(4096).optional(),
}).strict();
const finalizeSchema = applySchema.extend({ result: historyNativeResultSchema, destinationConversationId: idSchema.optional() }).strict();
const unknown: HistoryNativeResult = { outcome: "unknown", reason: "uncertain" };
/** Native snapshot reads slower than this are recorded in the timeline. */
const HISTORY_READ_LOG_AFTER_MS = 1_000;
const reservationSchema = z.object({ identity: z.string(), workspaceOverride: z.string().optional(), workspaceUnreadable: z.literal(true).optional() }).strict();
const toolsSchema = z.object({ sourceSessionId: z.string().min(1).max(4096), toolVersion: z.string().min(1).max(256).nullable() }).strict();

export function gatewayConversationHistory(bridge: HistoryBridge, channel: GatewayChannel, runtime: CoreServiceRuntime, stateDir: string, botId: string, sideBusy: (conversationId: string) => boolean = () => false) {
  const receipts = new GatewayReceipts(stateDir);
  const idleReads = new Map<string, Promise<z.infer<typeof snapshotReadSchema>>>();
  const readConfig = () => readValidatedConfigFile(path.join(stateDir, "config.json"), { forExecution: true });
  return async (method: string, raw: unknown): Promise<Json> => {
    const p = method === "history.snapshot" ? readSchema.parse(raw) : method === "history.finalize" ? finalizeSchema.parse(raw) : applySchema.parse(raw);
    const operationId = "operationId" in p ? p.operationId : undefined;
    const authorized = async () => {
      if (p.botId !== botId || !channel.transport.capabilities.includes(CONVERSATION_HISTORY_CAPABILITY)) return false;
      try { return z.object({ allowed: z.boolean() }).strict().parse(await channel.transport.requestLive("history.authorize", { userId: p.userId, conversationId: p.conversationId, ...(operationId ? { operationId } : {}) })).allowed; }
      catch { return false; }
    };
    if (!await authorized()) throw new Error("history_forbidden");
    const conversationKey = buildCoreConversationKey(p.conversationId);
    const scope: Scope = { chatId: stableCoreNumericId(conversationKey), conversationKey, isCurrentSession: authorized };
    const busy = () => runtime.chatQueue.isBusy(conversationKey) || runtime.activeRuns.has(conversationKey)
      || (runtime.concurrentRuns.get(conversationKey)?.size ?? 0) > 0 || runtime.pendingBatches.has(conversationKey)
      || [...runtime.pendingApprovals.values()].some(approval => approval.conversationKey === conversationKey || approval.chatId === p.conversationId)
      || channel.isConversationProcessing(p.conversationId);
    if (method === "history.snapshot") {
      const getHistory = bridge.getConversationHistory?.bind(bridge);
      if (!getHistory) return { supported: false };
      const config = await readConfig();
      // A legacy global resume belongs to one conversation only. Its scoped
      // fallback is resolved by the controller, not copied into every request.
      const workspaceOverride = (await channel.conversationWorkspace?.(p.conversationId))?.trim() || config.workspacePath?.trim();
      if (workspaceOverride) scope.workspaceOverride = workspaceOverride;
      const readSnapshot = async (turnPending: boolean) => {
        const startedAt = performance.now();
        let outcome: string | undefined;
        try {
          const read = snapshotReadSchema.parse(await (turnPending ? getHistory(scope, { turnPending }) : getHistory(scope)));
          outcome = read.revision ? "read" : read.blocked ?? "unavailable";
          return read;
        } finally {
          const elapsed = performance.now() - startedAt;
          if (turnPending || elapsed >= HISTORY_READ_LOG_AFTER_MS) {
            // Use an event type understood by 1.6.0 when it reopens this log.
            await appendTimelineEventBestEffort(stateDir, { type: "engine.event", channel: "gateway", conversationKey, chatId: scope.chatId,
              outcome: outcome ?? "error", detail: "history.snapshot", metadata: { source: "gateway.history", turnPending,
                durationMs: Math.round(elapsed), ...(outcome === undefined ? { failureCategory: "snapshot_read_failed" } : {}) } }, "history timeline event");
          }
        }
      };
      // A menu-open read and an activity-driven refresh may arrive together.
      // Share only the in-flight idle read, scoped to the owner and workspace.
      const readIdle = () => {
        const key = JSON.stringify([p.userId, conversationKey, workspaceOverride]);
        const existing = idleReads.get(key);
        if (existing) return existing;
        const read = readSnapshot(false).finally(() => idleReads.delete(key));
        idleReads.set(key, read);
        return read;
      };
      // Cached answers while a turn is queued or running avoid the turn lock.
      // If it drained during the read, finish this request with one idle read.
      // The App may already have received its final activity update.
      let read = await (busy() ? readSnapshot(true) : readIdle());
      if (!await authorized()) throw new Error("history_forbidden");
      if (read.cachedWhilePending && !busy() && !sideBusy(p.conversationId)) {
        read = await readIdle();
        if (!await authorized()) throw new Error("history_forbidden");
      }
      const { cachedWhilePending: _cached, ...result } = read;
      const blocked = busy() ? "busy" : sideBusy(p.conversationId) ? "side_session" : result.blocked;
      return z.json().parse({ ...result, ...(blocked ? { blocked } : {}) });
    }
    const command = applySchema.strip().parse(p), key = `history:${command.userId}:${command.operationId}`;
    const identity = JSON.stringify(command);
    const authorize = async () => { if (!await authorized()) throw new Error("history_forbidden"); };
    if (method === "history.receipt") {
      // Do not call run(): even its interrupted-state rewrite is not a read.
      const reserved = await receipts.inspect(`${key}:identity`), stored = reserved?.state === "complete" && reserved.result?.ok ? reserved.result.result : undefined;
      if (!stored || reservationSchema.parse(stored).identity !== identity) return {};
      const receipt = await receipts.inspect(`${key}:native`); await authorize();
      return receipt?.state === "complete" && receipt.result?.ok ? { result: historyNativeResultSchema.parse(receipt.result.result) } : {};
    }
    if (method === "history.finalize") {
      const final = finalizeSchema.parse(p), reservation = await receipts.inspect(`${key}:identity`), receipt = await receipts.inspect(`${key}:native`);
      const reservedScope = reservation?.state === "complete" && reservation.result?.ok ? reservationSchema.parse(reservation.result.result) : undefined;
      const confirmed = receipt?.state === "complete" && receipt.result?.ok ? historyNativeResultSchema.parse(receipt.result.result) : undefined;
      // The Hub releases an operation left unconfirmed past its time as a
      // rejection, without a matching receipt; never one still running here.
      const releasing = final.result.outcome === "rejected" && (!confirmed || confirmed.outcome === "unknown");
      if (releasing && receipts.isRunning(`${key}:native`)) throw new Error("history_operation_running");
      if (reservedScope ? reservedScope.identity !== identity : !releasing) throw new Error("history_request_conflict");
      if (reservedScope?.workspaceOverride) scope.workspaceOverride = reservedScope.workspaceOverride;
      if (!releasing && (!confirmed || JSON.stringify(confirmed) !== JSON.stringify(final.result))) throw new Error("history_receipt_unconfirmed");
      if (!bridge.finalizeConversationHistory) throw new Error("history_unsupported");
      const destinationKey = final.destinationConversationId ? buildCoreConversationKey(final.destinationConversationId) : undefined;
      if (final.action.kind === "fork" && final.result.outcome === "applied") {
        const saved = await receipts.inspect(`${key}:app-tools`);
        if (!saved?.result?.ok || saved.state !== "complete") throw new Error("history_app_tools_unconfirmed");
        const tools = toolsSchema.parse(saved.result.result);
        if (tools.sourceSessionId !== final.result.sourceSessionId || !final.result.destinationSessionId
          || final.result.destinationSessionId === tools.sourceSessionId) throw new Error("history_app_tools_conflict");
        await authorize();
        await inheritAppToolVersion(stateDir, final.result.destinationSessionId, tools.toolVersion);
      }
      await authorize();
      // Local binding CAS is retryable; this path has no native mutation call.
      return z.json().parse(await bridge.finalizeConversationHistory({ ...scope, operationId: final.operationId, expectedRevision: final.expectedRevision, action: final.action, result: final.result,
        ...(destinationKey ? { destination: { conversationId: final.destinationConversationId!, chatId: stableCoreNumericId(destinationKey), conversationKey: destinationKey } } : {}) }));
    }
    if (method !== "history.apply") throw new Error("history_method_unsupported");
    const reservation = await receipts.run(`${key}:identity`, async (): Promise<Json> => {
      try {
        const config = await readConfig();
        const workspaceOverride = (await channel.conversationWorkspace?.(p.conversationId))?.trim() || config.workspacePath?.trim();
        return { identity, ...(workspaceOverride ? { workspaceOverride } : {}) };
      } catch {
        return { identity, workspaceUnreadable: true };
      }
    }, 0, authorize);
    if (!reservation.ok || reservationSchema.parse(reservation.result).identity !== identity) return unknown;
    // Finish a confirmed fork in the directory used for its native creation,
    // even after restart or a later change to the Bot's workspace setting.
    const reservedScope = reservationSchema.parse(reservation.result);
    if (reservedScope.workspaceOverride) scope.workspaceOverride = reservedScope.workspaceOverride;
    const receipt = await receipts.run(`${key}:native`, async () => {
      if (reservedScope.workspaceUnreadable) return { outcome: "rejected", reason: "storage_unavailable" };
      if (!bridge.applyConversationHistory || !bridge.getConversationHistory) return { outcome: "rejected", reason: "unsupported" };
      if (busy()) return { outcome: "rejected", reason: "busy" };
      if (sideBusy(p.conversationId)) return { outcome: "rejected", reason: "side_session" };
      if (await channel.canSteerConversation?.(p.conversationId) !== true) return { outcome: "rejected", reason: "binding_pending" };
      const snapshot = historyInternalSnapshotSchema.parse(await bridge.getConversationHistory(scope));
      if (snapshot.blocked === "busy" || snapshot.blocked === "side_session") return { outcome: "rejected", reason: snapshot.blocked };
      if (command.anchorGeneration && (snapshot.bindingGeneration !== command.anchorGeneration || snapshot.sourceSessionId !== command.anchorSessionId)) return { outcome: "rejected", reason: "source_changed" };
      const permission = z.object({ allowed: z.boolean() }).strict().parse(await channel.transport.requestLive("history.authorize", { userId: command.userId, conversationId: command.conversationId, operationId: command.operationId, purpose: "apply" }));
      if (!permission.allowed) return unknown;
      if (command.action.kind === "fork") {
        if (!snapshot.sourceSessionId) return { outcome: "rejected", reason: "not_ready" };
        // Native Codex forks inherit the source's frozen dynamic definitions.
        // Persist their local version before native mutation; restart/finalize
        // must never substitute today's definitions or a later source record.
        const tools = await receipts.run(`${key}:app-tools`, async () => ({ sourceSessionId: snapshot.sourceSessionId!, toolVersion: await captureAppToolVersion(stateDir, snapshot.sourceSessionId!) }), 0, authorize);
        if (!tools.ok) return { outcome: "rejected", reason: "storage_unavailable" };
        if (toolsSchema.parse(tools.result).sourceSessionId !== snapshot.sourceSessionId) return { outcome: "rejected", reason: "source_changed" };
      }
      try { return historyNativeResultSchema.parse(await bridge.applyConversationHistory({ ...scope, operationId: command.operationId, expectedRevision: command.expectedRevision, action: command.action, ...(command.nativeAnchor ? { nativeAnchor: command.nativeAnchor } : {}) })); }
      catch { return unknown; }
    }, 0, authorize);
    const result = receipt.ok ? historyNativeResultSchema.parse(receipt.result) : unknown;
    await appendTimelineEventBestEffort(stateDir, { type: "command.handled", channel: "gateway", conversationKey, chatId: scope.chatId,
      outcome: result.outcome, detail: `history.${command.action.kind}`, metadata: { source: "gateway.history", operationId: command.operationId,
        ...(command.action.kind === "fork" ? { scope: command.action.scope } : {}), ...(result.reason ? { reason: result.reason } : {}),
        ...(receipt.ok ? {} : { receipt: receipt.error ?? "operation_failed" }) } }, "history timeline event");
    // Publication is replayable evidence. Persist it before returning, but do
    // not await the Hub response in the RPC frame chain.
    const publication = channel.transport.enqueue("history.result", { operationId: command.operationId, result });
    void publication.response.catch(() => undefined); await publication.persisted;
    return z.json().parse(result);
  };
}
