import { NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY, nativeInputControlResultSchema, type NativeInputObserver, type NativeInputProgress } from "../client-protocol/native-input.js";
import { STEERING_OUTCOME_CAPABILITY } from "../client-protocol/steering-outcome.js";
import { createHash, randomUUID } from "node:crypto";
import { EngineSteeringRejectedError } from "../codex/adapter.js";
import { z } from "zod";
import { blocksText, conversationSchema, idSchema, messageSchema } from "../client-protocol/index.js";
import { steerCallSchema, steerStatusCallSchema, nativeInputControlRequestSchema, steerResultSchema, type SteerResult } from "../client-protocol/steering.js";
import { CoreGoalRunController } from "../core/bus.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../core/message-normalizer.js";
import type { CoreActiveRun, CoreServiceRuntime } from "../core/runtime.js";
import type { CoreBridgeLike } from "../core/types.js";
import type { GatewayChannel } from "./channel.js";
import { GatewayReceipts } from "./receipts.js";

/** Read-only: an opaque ID while this conversation's own background review can
 * natively admit a new foreground turn's prompt; undefined otherwise. */
type ReviewTargetBridge = CoreBridgeLike & { backgroundInputTarget?(input: { chatId: number; conversationKey: string }): Promise<string | undefined> };
/** Finish before the Hub's 10 s RPC deadline, leaving transport/persistence
 * headroom. Missing evidence stays unknown; later native receipts still apply. */
const REVIEW_ADMISSION_RECEIPT_MS = 8_000;

/** Explicit steering is bound to one live run. It never falls back to the queue,
 * never steers an autonomous goal, and doesn't inherit the automatic 30s window.
 * An ordinary input sent to a background-review target is not a steer: it
 * starts a new foreground turn, reachable only from the review's own
 * conversation, whose prompt Claude admits natively. Claude may take it into
 * the running review; the adapter then moves that native turn to this turn. */
export function gatewaySteering(bridge: ReviewTargetBridge, runtime: CoreServiceRuntime, channel: GatewayChannel, stateDir: string) {
  // App request IDs are unique per author, not globally. Never let another
  // member alias a native input by choosing the same client request ID.
  const nativeId = (userId: string, requestId: string) => createHash("sha256").update(JSON.stringify([userId, requestId])).digest("hex");
  const ids = new WeakMap<CoreActiveRun, string>();
  const receipts = new GatewayReceipts(stateDir);
  const current = (conversationId: string) => {
    const run = runtime.activeRuns.get(buildCoreConversationKey(conversationId));
    const attached = run?.abortController instanceof CoreGoalRunController ? run.abortController.liveConcurrentTurn() : null;
    const target = attached ?? (run?.goalWatch ? undefined : run);
    return target?.abortController.signal.aborted ? undefined : target;
  };
  const token = (run: CoreActiveRun) => { let id = ids.get(run); if (!id) { id = randomUUID(); ids.set(run, id); } return id; };
  // A turn started from a review target may still wait in Claude's queue, or
  // continue Claude's own review. Send-now would cut that review: never offer it.
  const reviewTurns = new Map<string, number>();
  const supported = () => bridge.supportsSteering?.() === true && typeof bridge.steerActiveTurn === "function";
  const chat = (conversationId: string) => { const conversationKey = buildCoreConversationKey(conversationId); return { chatId: stableCoreNumericId(conversationKey), conversationKey }; };
  const reviewNegotiated = () => !!channel.transport?.capabilities.includes(NATIVE_INPUT_CAPABILITY) && channel.transport.capabilities.includes(NATIVE_REVIEW_INPUT_CAPABILITY) && typeof bridge.backgroundInputTarget === "function";
  /** No Core run and no running or queued Core job may exist: this target is only status.
   * A dispatched review turn or a received input awaiting Core admission counts
   * too: both reach Core asynchronously, and one target admits one new turn. */
  const idleForReview = (conversationId: string) => !reviewTurns.has(conversationId) && channel.hasPendingAdmission?.(conversationId) !== true
    && !runtime.activeRuns.has(chat(conversationId).conversationKey) && !runtime.chatQueue.isBusy(chat(conversationId).conversationKey);
  const reviewTarget = async (conversationId: string): Promise<string | undefined> => {
    if (!reviewNegotiated() || !idleForReview(conversationId)) return undefined;
    // The local native read comes first; most polls end here without Hub reads.
    const targetId = await bridge.backgroundInputTarget!(chat(conversationId));
    if (!targetId || !idSchema.safeParse(targetId).success) return undefined;
    if (await channel.getChatMode(conversationId) !== "p2p" || await channel.canSteerConversation?.(conversationId) !== true) return undefined;
    return idleForReview(conversationId) ? targetId : undefined;
  };
  const progressReporter = (p: { conversationId: string; userId: string; requestId: string; targetId: string }) => (progress: NativeInputProgress) => {
    void channel.transport.request("input.progress", { conversationId: p.conversationId, userId: p.userId, requestId: p.requestId, targetId: p.targetId, progress }).catch(() => channel.transport.options.onWarning?.("native_input_progress_delivery_failed"));
  };
  /** A new foreground turn whose prompt Claude may admit while its review runs.
   * Every rejection here is decided before anything reaches Claude. */
  const sendToReview = async (p: z.infer<typeof steerCallSchema>): Promise<SteerResult> => {
    if (p.mode !== "message" || !p.messageId || !reviewNegotiated()) return { outcome: "rejected", reason: "unsupported" };
    if (await channel.getChatMode(p.conversationId) !== "p2p" || p.text.trimStart().startsWith("/")) return { outcome: "rejected", reason: "unsupported" };
    if (!await channel.canSteerConversation?.(p.conversationId)) return { outcome: "rejected", reason: "binding_changed" };
    if (!idleForReview(p.conversationId)) return { outcome: "rejected", reason: "stale" };
    if (!await bridge.nativeInputCapability?.(chat(p.conversationId))) return { outcome: "rejected", reason: "unsupported" };
    if (await bridge.backgroundInputTarget!(chat(p.conversationId)) !== p.targetId || !idleForReview(p.conversationId)) return { outcome: "rejected", reason: "stale" };
    // The turn replies to this exact authenticated Hub record, never to text
    // or a target chosen by the caller.
    const message = messageSchema.parse(await channel.transport.request("fetch", { messageId: p.messageId }));
    const control = message.blocks.find(block => block.type === "steering");
    if (message.conversationId !== p.conversationId || message.authorType !== "user" || message.authorId !== p.userId || message.clientMsgId !== p.requestId
      || control?.botId !== channel.transport.options.botId || control.targetId !== p.targetId || control.mode !== "message" || blocksText(message.blocks) !== p.text) return { outcome: "rejected", reason: "stale" };
    const conversation = conversationSchema.parse(await channel.transport.request("conversation", { conversationId: p.conversationId }));
    if (conversation.type !== "direct" || conversation.archived) return { outcome: "rejected", reason: "unsupported" };
    if (!idleForReview(p.conversationId)) return { outcome: "rejected", reason: "stale" };
    const report = progressReporter(p);
    return await new Promise<SteerResult>((resolve) => {
      let settled = false;
      const finish = (result: SteerResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      // Unknown, never a rejection: the prompt may already be in Claude's queue.
      const timer = setTimeout(() => finish({ outcome: "unknown", reason: "uncertain" }), REVIEW_ADMISSION_RECEIPT_MS);
      timer.unref?.();
      const nativeInput: NativeInputObserver = { id: nativeId(p.userId, p.requestId), onProgress: progress => {
        report(progress);
        // Only an explicit pre-write refusal proves nothing reached Claude.
        if (progress.state === "dropped") finish(progress.reason === "not_admitted" || progress.reason === "refused" ? { outcome: "rejected", reason: "not_ready" } : { outcome: "unknown", reason: "uncertain" });
        else if (progress.state === "queued" || progress.state === "dequeued" || progress.state === "received" || progress.state === "cancelled") finish({ outcome: "accepted" });
        else finish({ outcome: "unknown", reason: "uncertain" });
      } };
      reviewTurns.set(p.conversationId, (reviewTurns.get(p.conversationId) ?? 0) + 1);
      // A turn that ends without any receipt cannot prove non-delivery.
      void channel.dispatchNativeTurn(message, conversation, { reviewAdmission: "native", nativeInput })
        .then(() => finish({ outcome: "unknown", reason: "uncertain" }), () => finish({ outcome: "unknown", reason: "uncertain" }))
        .finally(() => { const left = (reviewTurns.get(p.conversationId) ?? 1) - 1; if (left > 0) reviewTurns.set(p.conversationId, left); else reviewTurns.delete(p.conversationId); });
    });
  };
  return async (method: string, raw: unknown) => {
    if (method === "steer.status") {
      const { conversationId, backgroundReview } = steerStatusCallSchema.parse(raw);
      if (!supported()) return { supported: false, reason: "unsupported" };
      const conversationKey = buildCoreConversationKey(conversationId);
      const behavior = await bridge.inFlightSendBehavior?.({ chatId: stableCoreNumericId(conversationKey), conversationKey }) === "steer" ? { sendBehavior: "steer" as const } : {};
      const nativeInput = channel.transport?.capabilities.includes(NATIVE_INPUT_CAPABILITY)
        ? await bridge.nativeInputCapability?.({ chatId: stableCoreNumericId(conversationKey), conversationKey }) : undefined;
      const run = current(conversationId);
      if (!run && backgroundReview && nativeInput && behavior.sendBehavior) {
        // Send-now is not offered: it would cut Claude's review short.
        const targetId = await reviewTarget(conversationId);
        if (targetId && !current(conversationId)) return { supported: true, targetId, targetKind: "background-review", sendBehavior: "steer", nativeInput: { ...nativeInput, sendNow: false } };
      }
      const runInput = nativeInput && run && reviewTurns.has(conversationId) ? { ...nativeInput, sendNow: false } : nativeInput;
      return run ? { supported: true, targetId: token(run), ...behavior, ...(runInput ? { nativeInput: runInput } : {}) } : { supported: true, reason: "idle", ...behavior, ...(nativeInput ? { nativeInput } : {}) };
    }
    if (method === "input.control") {
      const p = nativeInputControlRequestSchema.extend({ conversationId: idSchema, userId: idSchema, inputId: idSchema }).parse(raw);
      const identity = { conversationId: p.conversationId, inputId: p.inputId, action: p.action };
      const receipt = await receipts.run(`input.control:${p.userId}:${p.requestId}`, async () => {
        const wrap = (result: unknown) => ({ ...identity, result: nativeInputControlResultSchema.parse(result) });
        if (!channel.transport?.capabilities.includes(NATIVE_INPUT_CAPABILITY) || !bridge.controlNativeInput) return wrap({ outcome: "rejected", reason: "unsupported" });
        const isCurrentSession = async () => await channel.canSteerConversation?.(p.conversationId) === true;
        if (!await isCurrentSession()) return wrap({ outcome: "rejected", reason: "binding_changed" });
        const conversationKey = buildCoreConversationKey(p.conversationId);
        return wrap(await bridge.controlNativeInput({ chatId: stableCoreNumericId(conversationKey), conversationKey, inputId: nativeId(p.userId, p.inputId), action: p.action, isCurrentSession }));
      });
      if (!receipt.ok) return { outcome: "unknown", reason: "uncertain" };
      const stored = nativeInputControlRequestSchema.omit({ requestId: true }).extend({ conversationId: idSchema, inputId: idSchema, result: nativeInputControlResultSchema }).parse(receipt.result);
      return stored.conversationId === p.conversationId && stored.inputId === p.inputId && stored.action === p.action ? stored.result : { outcome: "rejected", reason: "stale" };
    }
    const p = steerCallSchema.parse(raw);
    const send = async (): Promise<SteerResult> => {
      if (!supported()) return { outcome: "rejected", reason: "unsupported" };
      const run = current(p.conversationId);
      // A review target never matches a run token. Without a live run it can
      // only start a new turn; with one, the caller's status is outdated.
      if (!run) return p.mode === "message" && p.messageId ? await sendToReview(p) : { outcome: "rejected", reason: "stale" };
      if (token(run) !== p.targetId) return { outcome: "rejected", reason: "stale" };
      if (!await channel.canSteerConversation?.(p.conversationId)) return { outcome: "rejected", reason: "binding_changed" };
      // Recheck after asynchronous binding/session reads. A queued next turn must
      // never inherit an instruction intended for the run which just finished.
      const isCurrentTurn = () => current(p.conversationId) === run;
      if (!isCurrentTurn()) return { outcome: "rejected", reason: "stale" };
      const conversationKey = buildCoreConversationKey(p.conversationId);
      // Which run may now contain this input: the Hub stops design.open there
      // from reaching the run's original device until adoption is proven.
      const source = idSchema.safeParse(run.sourceMessageId).success ? { sourceMessageId: run.sourceMessageId! } : {};
      if (p.mode && (!channel.transport?.capabilities.includes(NATIVE_INPUT_CAPABILITY) || !await bridge.nativeInputCapability?.({ chatId: stableCoreNumericId(conversationKey), conversationKey }))) return { outcome: "rejected", reason: "unsupported" };
      if (!isCurrentTurn()) return { outcome: "rejected", reason: "stale" };
      try {
        const accepted = await bridge.steerActiveTurn!({ chatId: stableCoreNumericId(conversationKey), conversationKey,
          text: p.text, isCurrentTurn, throwOnError: true,
          ...(p.mode ? { nativeInput: { id: nativeId(p.userId, p.requestId), onProgress: progressReporter(p) } } : {}),
          ...(!p.mode && channel.transport?.capabilities.includes(STEERING_OUTCOME_CAPABILITY) ? { onOutcome: application => {
            // The transport journals this observation for reconnect. It changes
            // only the original input receipt and never delivers new work.
            void channel.transport.request("steer.outcome", { conversationId: p.conversationId, userId: p.userId, requestId: p.requestId, targetId: p.targetId, application }).catch(() => channel.transport.options.onWarning?.("steering_outcome_delivery_failed"));
          } } : {}),
        });
        return accepted ? { outcome: "accepted", ...source } : { outcome: "rejected", reason: "not_ready" };
      } catch (error) {
        return error instanceof EngineSteeringRejectedError
          ? { outcome: "rejected", reason: error.reason }
          : { outcome: "unknown", reason: "uncertain", ...source };
      }
    };
    if (p.mode) {
      const identity = { conversationId: p.conversationId, targetId: p.targetId, text: p.text };
      const receipt = await receipts.run(`input.send:${p.userId}:${p.requestId}`, async () => ({ ...identity, result: await send() }));
      if (!receipt.ok) return { outcome: "unknown", reason: "uncertain" };
      const stored = z.object({ conversationId: idSchema, targetId: idSchema, text: z.string(), result: steerResultSchema }).parse(receipt.result);
      return stored.conversationId === p.conversationId && stored.targetId === p.targetId && stored.text === p.text ? stored.result : { outcome: "rejected", reason: "stale" };
    }
    const receipt = await receipts.run(`steer:${p.userId}:${p.requestId}`, send);
    return receipt.ok ? receipt.result! : { outcome: "unknown", reason: "uncertain" };
  };
}
