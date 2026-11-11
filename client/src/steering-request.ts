import { z } from "zod";
import { workbenchContextSchema, type WorkbenchContext } from "../../src/client-protocol/workbench.js";
import { messageSchema, type Message } from "../../src/client-protocol/index.js";
import { steerStatusSchema } from "../../src/client-protocol/steering.js";
import type { HubConnection } from "./connection.js";
import { randomNonce } from "./identity.js";
import { queueRequest } from "./prompt-queue-request.js";
import { steerReason, nativeInputReason } from "./steering-reason.js";
import { t } from "./i18n.js";

/** Only definitive pre-delivery rejection permits ordinary-send fallback. */
export class SteeringNotDeliveredError extends Error {
  constructor(readonly reason?: string, ordinary = false) { super(ordinary ? nativeInputReason(reason) : steerReason(reason)); }
  get canQueue() { return ["unsupported", "idle", "stale", "queued", "not_ready"].includes(this.reason ?? ""); }
}

const attemptSchema = z.object({ botId: z.string(), requestId: z.string(), targetId: z.string(), text: z.string(), mode: z.literal("message").optional(), settled: z.boolean().optional(), workbench: workbenchContextSchema.optional() });
type Attempt = z.infer<typeof attemptSchema>;
const draftKey = (conversationId: string, botId: string) => `native-input:${conversationId}:${botId}`;
const steeringDraftKey = (conversationId: string, botId: string) => `steering-input:${conversationId}:${botId}`;
export async function hasSteeringDraft(connection: HubConnection, conversationId: string, botId: string, text: string): Promise<boolean> {
  const raw = await connection.cache.operationRecord(steeringDraftKey(conversationId, botId));
  return !!raw && attemptSchema.parse(JSON.parse(raw)).text === text;
}
export async function clearSteeringDraft(connection: HubConnection, conversationId: string, botId: string, requestId: string) {
  if (!connection.cache) return;
  const key = steeringDraftKey(conversationId, botId), raw = await connection.cache.operationRecord(key);
  if (raw && attemptSchema.parse(JSON.parse(raw)).requestId === requestId) await connection.cache.clearOperationIfMatches(key, raw);
}
export async function hasNativeInputDraft(connection: HubConnection, conversationId: string, botId: string, text: string): Promise<boolean> {
  const raw = await connection.cache.operationRecord(draftKey(conversationId, botId));
  return !!raw && attemptSchema.parse(JSON.parse(raw)).text === text;
}
export async function clearNativeInputDraft(connection: HubConnection, conversationId: string, botId: string, requestId: string) {
  const key = draftKey(conversationId, botId), raw = await connection.cache.operationRecord(key);
  if (raw && attemptSchema.parse(JSON.parse(raw)).requestId === requestId) await connection.cache.clearOperationIfMatches(key, raw);
}
const pending = new WeakMap<HubConnection, Map<string, Attempt>>();
/** An uncertain HTTP send is checked with the original ID and target, even
 * after navigation. It is never retried as a fresh instruction or queued turn. */
export async function sendSteering(connection: HubConnection, conversationId: string, botId: string, text: string, current: () => boolean, ordinary = false, immediately = false, workbench?: WorkbenchContext, expectedTargetId?: string): Promise<Message | undefined> {
  let store = pending.get(connection); if (!store) { store = new Map(); pending.set(connection, store); }
  const key = `${conversationId}:${botId}`, route = `/api/conversations/${conversationId}/steer`;
  const persistedKey = ordinary ? draftKey(conversationId, botId) : steeringDraftKey(conversationId, botId);
  let attempt = store.get(key), savedRaw = "";
  if (connection.cache) {
    const raw = savedRaw = await connection.cache.operationRecord(persistedKey);
    if (raw) attempt = attemptSchema.parse(JSON.parse(raw));
  }
  if (immediately && attempt?.text === text && !attempt.mode) throw new SteeringNotDeliveredError("unsupported", true);
  if (!attempt || attempt.text !== text) {
    const request = queueRequest([], 15_000);
    try {
      let status;
      // Ordinary input also asks for a background-review target: it starts a
      // new turn that Claude admits natively. Explicit steering keeps run targets only.
      try { status = steerStatusSchema.parse(await request.wait(connection.http(`${route}?botId=${botId}${ordinary ? "&review=1" : ""}`, { signal: request.signal }))); }
      catch (error) {
        // A fresh preflight is read-only: no input identity or native message
        // has been written yet. Ordinary sending may safely use the durable
        // queue. An older uncertain attempt must keep its receipt protection.
        if (ordinary && (!attempt || attempt.settled)) throw new SteeringNotDeliveredError("not_ready", true);
        throw error;
      }
      if (!status.supported || !status.targetId) throw new SteeringNotDeliveredError(status.reason, ordinary);
      // A choice made for task A must never supplement task B merely because
      // the composer capability poll has not observed the transition yet.
      if (expectedTargetId && status.targetId !== expectedTargetId) throw new SteeringNotDeliveredError("stale", ordinary);
      if (!ordinary && status.targetKind) throw new SteeringNotDeliveredError("idle");
      if (ordinary && status.sendBehavior !== "steer") throw new SteeringNotDeliveredError("unsupported", ordinary);
      if (immediately && !status.nativeInput?.sendNow) throw new SteeringNotDeliveredError("unsupported", true);
      if (attempt?.targetId === status.targetId && !attempt.settled) throw new Error(t("上一条消息结果待确认，请先核对对话中的回执。"));
      // A different live target permits a genuinely new instruction. Keep the
      // old uncertain receipt in history; it must not lock future turns forever.
      attempt = { botId, requestId: randomNonce(), targetId: status.targetId, text, ...(ordinary && status.nativeInput ? { mode: "message" as const } : {}), ...(workbench ? { workbench: workbenchContextSchema.parse(workbench) } : {}) };
    } finally { request.dispose(); }
    if (!current()) return;
    // Only the Codex composer opts explicit input into durable draft recovery.
    // Other engines/groups retain their existing explicit-steering lifecycle.
    if ((attempt.mode || !ordinary && !!expectedTargetId) && connection.cache && !await connection.cache.updateOperationIfMatches(persistedKey, savedRaw, JSON.stringify(attempt))) throw new Error(t("另一窗口正在发送此消息，请核对回执后重试。"));
    if (!current()) return;
    store.set(key, attempt);
  }
  if (!current()) return;
  const receipt = await deliverAttempt(connection, conversationId, attempt, ordinary);
  if (expectedTargetId && attempt.targetId !== expectedTargetId && receipt.blocks.some(block => block.type === "steering" && block.outcome === "accepted")) {
    throw new Error(t("这段文字已补充到之前的任务，未发送给当前任务。如需再次发送，请修改内容。"));
  }
  return receipt;
}

async function deliverAttempt(connection: HubConnection, conversationId: string, attempt: Attempt, ordinary: boolean): Promise<Message> {
  const botId = attempt.botId, store = pending.get(connection), key = `${conversationId}:${botId}`;
  const persistedKey = ordinary ? draftKey(conversationId, botId) : steeringDraftKey(conversationId, botId);
  const request = queueRequest([], 15_000);
  try {
    const { settled: _settled, ...body } = attempt;
    const receipt = messageSchema.parse(await request.wait(connection.http(`/api/conversations/${conversationId}/steer`, { method: "POST", body: JSON.stringify(body), signal: request.signal })));
    const result = receipt.blocks.find(block => block.type === "steering");
    if ((result?.outcome === "accepted" || result?.outcome === "rejected") && store?.get(key)?.requestId === attempt.requestId) store.delete(key);
    if (attempt.mode && result?.outcome === "rejected") await clearNativeInputDraft(connection, conversationId, botId, attempt.requestId);
    if (!ordinary && result?.outcome === "rejected") await clearSteeringDraft(connection, conversationId, botId, attempt.requestId);
    if ((attempt.mode || !ordinary) && connection.cache && result?.outcome === "accepted") {
      const saved = JSON.stringify(attempt);
      // Keep the identity until the originating draft is cleared. A reload
      // between admission and draft cleanup must not execute the text twice.
      await connection.cache.updateOperationIfMatches(persistedKey, saved, JSON.stringify({ ...attempt, settled: true }));
    }
    return receipt;
  } catch { throw new Error(ordinary ? nativeInputReason("uncertain") : steerReason("uncertain")); }
  finally { request.dispose(); }
}

/** Queue recovery may check an old ID only after authoritative status proves
 * its target is no longer live. It must never inject into a still-running task
 * merely because the user chose queue. Unknown status stays protected. */
export async function recoverSteeringDraft(connection: HubConnection, conversationId: string, botId: string, text: string, current: () => boolean): Promise<"missing" | "pending" | "accepted" | "rejected"> {
  const key = steeringDraftKey(conversationId, botId), raw = await connection.cache.operationRecord(key);
  if (!raw) return "missing";
  const attempt = attemptSchema.parse(JSON.parse(raw));
  if (attempt.text !== text) return "missing";
  if (attempt.settled) return "accepted";
  const request = queueRequest([], 15_000);
  try {
    const status = steerStatusSchema.parse(await request.wait(connection.http(`/api/conversations/${conversationId}/steer?botId=${botId}`, { signal: request.signal })));
    if (status.targetId === attempt.targetId || !(status.reason === "idle" || status.supported && status.targetId)) return "pending";
    if (!current() || await connection.cache.operationRecord(key) !== raw || !current()) return "pending";
    const receipt = await deliverAttempt(connection, conversationId, attempt, false);
    const outcome = receipt.blocks.find(block => block.type === "steering")?.outcome;
    return outcome === "accepted" || outcome === "rejected" ? outcome : "pending";
  } catch { return "pending"; }
  finally { request.dispose(); }
}

export async function retireEditedNativeInputDraft(connection: HubConnection, conversationId: string, botId: string, text: string) {
  const key = draftKey(conversationId, botId), raw = await connection.cache.operationRecord(key);
  if (!raw) return;
  const attempt = attemptSchema.parse(JSON.parse(raw));
  if (attempt.settled && attempt.text !== text) await connection.cache.clearOperationIfMatches(key, raw);
}

export async function retireEditedSteeringDraft(connection: HubConnection, conversationId: string, botId: string, text: string) {
  const key = steeringDraftKey(conversationId, botId), raw = await connection.cache.operationRecord(key);
  if (!raw) return;
  const attempt = attemptSchema.parse(JSON.parse(raw));
  if (attempt.settled && attempt.text !== text) await connection.cache.clearOperationIfMatches(key, raw);
}

export function settleSteeringRequest(connection: HubConnection, message: Message, currentText?: () => string | undefined) {
  const receipt = message.blocks.find(block => block.type === "steering");
  if (!receipt || !["accepted", "rejected"].includes(receipt.outcome)) return;
  const store = pending.get(connection), key = `${message.conversationId}:${receipt.botId}`;
  const ownsAttempt = store?.get(key)?.requestId === message.clientMsgId;
  if (connection.cache) {
    const persistedKey = receipt.mode === "message" ? draftKey(message.conversationId, receipt.botId) : steeringDraftKey(message.conversationId, receipt.botId);
    void connection.cache.operationRecord(persistedKey).then(async raw => {
      if (!raw) return;
      const attempt = attemptSchema.parse(JSON.parse(raw));
      if (attempt.requestId !== message.clientMsgId) return;
      // A different window may have an unrelated draft. Only the window that
      // initiated this attempt may retire it on recovery based on local edits.
      const text = ownsAttempt ? currentText?.() : undefined;
      if (receipt.outcome === "rejected" || text !== undefined && text !== attempt.text) await connection.cache.clearOperationIfMatches(persistedKey, raw);
      else if (!attempt.settled) await connection.cache.updateOperationIfMatches(persistedKey, raw, JSON.stringify({ ...attempt, settled: true }));
    }).catch(() => undefined);
  }
  if (store && store.get(key)?.requestId === message.clientMsgId) store.delete(key);
}
