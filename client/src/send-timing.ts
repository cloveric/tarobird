import type { ClientFrame, Message } from "../../src/client-protocol/index.js";
import type { SideErrorCode } from "../../src/client-protocol/side.js";

export const SEND_TIMING_STORAGE_KEY = "tarobird.debug.sendTiming";
const MAX_RECORDS = 200;
const MAX_PENDING_AGE_MS = 30_000;

export type SendTimingRoute = "queue" | "steer" | "native_message" | "discussion_start" | "discussion_note" | "side";
export type SendTimingSurface = "main" | "side";
export type SendTimingStage =
  | "workbenchDoneAt"
  | "steeringPreflightDoneAt"
  | "steeringStateDoneAt"
  | "historySettledDoneAt"
  | "enqueueDoneAt"
  | "outboxFlushSentAt"
  | "outboxReloadDoneAt"
  | "historyReadDoneAt"
  | "bubbleVisibleAt"
  | "composerClearedAt";

export interface SendTimingRecord {
  id: number;
  conversationId: string;
  clientMsgId?: string;
  messageId?: string;
  engine?: string;
  kind: "direct" | "group" | "side";
  route?: SendTimingRoute;
  messageLength: number;
  historyCount?: number;
  enterAt: number;
  workbenchDoneAt?: number;
  steeringPreflightDoneAt?: number;
  steeringStateDoneAt?: number;
  historySettledDoneAt?: number;
  enqueueDoneAt?: number;
  outboxFlushSentAt?: number;
  outboxReloadDoneAt?: number;
  historyReadGapWaitMs?: number;
  historyReadCostMs?: number;
  historyReadDoneAt?: number;
  bubbleVisibleAt?: number;
  composerClearedAt?: number;
  /** A `SendTimingFailureCode` or an error's class name, never its message. */
  error?: string;
}

/** Why a send stopped, as a call site may name it. The Host's side-conversation
 *  refusal codes are a closed list and pass through unchanged. */
export type SendTimingFailureCode =
  | "aborted"
  | "conversation_changed"
  | "local_command"
  | "stale_generation"
  | "file_rejected"
  | SideErrorCode;

const FAILURE_CODES: Record<SendTimingFailureCode, true> = {
  aborted: true,
  conversation_changed: true,
  local_command: true,
  stale_generation: true,
  file_rejected: true,
  unsupported: true,
  no_main_session: true,
  busy: true,
  limit_reached: true,
  budget_exhausted: true,
  expired: true,
  cancelled: true,
  failed: true,
  attachment_unavailable: true,
  attachment_unsupported: true,
  attachment_too_large: true,
};

/** Records are readable from `window.__tarobirdSendTiming`, and the text of an
 *  error can quote what the user typed (an unresolved @name of a group draft,
 *  an attachment's file name). Only a fixed code is kept: a listed call-site
 *  code, or the class name of a thrown error. */
function failureCode(reason: unknown): string {
  if (typeof reason === "string") return Object.hasOwn(FAILURE_CODES, reason) ? reason : "failed";
  if (reason instanceof Error) return /^[A-Za-z][A-Za-z0-9]{0,47}$/.test(reason.name) ? reason.name : "Error";
  return "aborted";
}

export interface SendTimingDebugApi {
  readonly records: SendTimingRecord[];
  clear(): void;
  latest(): SendTimingRecord | undefined;
}

type ComposerClearState = "pending" | "armed" | "skipped";

interface ActiveTrace {
  record: SendTimingRecord;
  matchText?: string;
  baselineMessageIds?: Set<string>;
  composerClear: ComposerClearState;
  retired: boolean;
}

export interface SendTimingTrace {
  readonly id: number;
  mark(stage: SendTimingStage, at?: number): void;
  setRoute(route: SendTimingRoute): void;
  setClientMsgId(clientMsgId?: string, messageId?: string): void;
  setMatchText(text: string): void;
  setHistoryCount(count: number): void;
  resetForFallback(): void;
  expectComposerClear(): void;
  skipComposerClear(): void;
  /** Pass a `SendTimingFailureCode`, or whatever was thrown: the record keeps
   *  a fixed code only (see `failureCode`), never the text of an error. */
  fail(reason: unknown): void;
}

let nextId = 1;
let testHookEnabled = false;
const records: SendTimingRecord[] = [];
const pending: ActiveTrace[] = [];

function surfaceOf(kind: SendTimingRecord["kind"]): SendTimingSurface {
  return kind === "side" ? "side" : "main";
}

export function setSendTimingTestHook(enabled: boolean): void {
  testHookEnabled = enabled;
  if (enabled) ensureGlobalApi();
}

export function isSendTimingEnabled(): boolean {
  if (testHookEnabled) return true;
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(SEND_TIMING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function hasActiveSendTiming(): boolean {
  return pending.length > 0;
}

export function hasPendingBubbleTiming(conversationId: string, surface: SendTimingSurface = "main"): boolean {
  if (!pending.length || !conversationId) return false;
  return pending.some(item => !item.retired
    && item.record.conversationId === conversationId
    && surfaceOf(item.record.kind) === surface
    && item.record.bubbleVisibleAt === undefined);
}

export function hasPendingComposerTiming(conversationId: string, surface: SendTimingSurface = "main"): boolean {
  if (!pending.length || !conversationId) return false;
  return pending.some(item => !item.retired
    && item.record.conversationId === conversationId
    && surfaceOf(item.record.kind) === surface
    && item.composerClear === "armed"
    && item.record.composerClearedAt === undefined);
}

function ensureGlobalApi(): void {
  const host = globalThis as { __tarobirdSendTiming?: SendTimingDebugApi };
  if (host.__tarobirdSendTiming) return;
  host.__tarobirdSendTiming = {
    records,
    clear() {
      records.length = 0;
      pending.length = 0;
    },
    latest() {
      return records.at(-1);
    },
  };
}

function prunePending(now: number): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    const item = pending[i]!;
    const composerDone = item.composerClear === "skipped" || item.record.composerClearedAt !== undefined;
    const done = item.retired
      || (item.record.bubbleVisibleAt !== undefined && composerDone)
      || now - item.record.enterAt > MAX_PENDING_AGE_MS;
    if (done) pending.splice(i, 1);
  }
}

function findByFrame(frame: ClientFrame): ActiveTrace | undefined {
  const id = "clientMsgId" in frame ? frame.clientMsgId : "clientActionId" in frame ? frame.clientActionId : undefined;
  if (!id) return undefined;
  for (let i = pending.length - 1; i >= 0; i--) {
    const item = pending[i]!;
    if (!item.retired && item.record.clientMsgId === id) return item;
  }
  return undefined;
}

function messageText(message: Message): string {
  return message.blocks.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
}

function matchesDiscussionMessage(item: ActiveTrace, message: Message): boolean {
  if (item.record.kind !== "group" || message.authorType !== "user") return false;
  const prefix = item.record.route === "discussion_start" ? "gdtopic_"
    : item.record.route === "discussion_note" ? "gdnote_"
    : undefined;
  if (!prefix || !message.clientMsgId?.startsWith(prefix)) return false;
  if (item.baselineMessageIds?.has(message.id)) return false;
  if (item.matchText === undefined) return false;
  if (messageText(message) !== item.matchText) return false;
  if (!item.matchText && !message.blocks.some(block => "attachmentId" in block)) return false;
  return true;
}

function matchesTraceMessage(item: ActiveTrace, message: Message): boolean {
  if (item.record.messageId && message.id === item.record.messageId) return true;
  if (item.record.clientMsgId && message.clientMsgId === item.record.clientMsgId) return true;
  return matchesDiscussionMessage(item, message);
}

/** Start a release-safe opt-in timing trace. Returns undefined with zero
 *  allocations or clock calls when `tarobird.debug.sendTiming !== "1"`. */
export function beginSendTiming(init: {
  conversationId: string;
  kind: "direct" | "group" | "side";
  engine?: string;
  route?: SendTimingRoute;
  messageLength: number;
  historyCount?: number;
  matchText?: string;
  clientMsgId?: string;
  existingMessages?: readonly Message[];
}): SendTimingTrace | undefined {
  if (!isSendTimingEnabled()) return undefined;
  ensureGlobalApi();
  const enterAt = performance.now();
  prunePending(enterAt);
  const record: SendTimingRecord = {
    id: nextId++,
    conversationId: init.conversationId,
    ...(init.clientMsgId ? { clientMsgId: init.clientMsgId } : {}),
    ...(init.engine ? { engine: init.engine } : {}),
    kind: init.kind,
    ...(init.route ? { route: init.route } : {}),
    messageLength: init.messageLength,
    ...(init.historyCount !== undefined ? { historyCount: init.historyCount } : {}),
    enterAt,
  };
  records.push(record);
  if (records.length > MAX_RECORDS) records.shift();
  const active: ActiveTrace = {
    record,
    matchText: init.matchText,
    baselineMessageIds: init.existingMessages ? new Set(init.existingMessages.map(message => message.id)) : undefined,
    composerClear: init.messageLength > 0 ? "pending" : "skipped",
    retired: false,
  };
  pending.push(active);
  return {
    id: record.id,
    mark(stage, at = performance.now()) {
      if (active.retired || record[stage] !== undefined) return;
      record[stage] = at;
      if (stage === "bubbleVisibleAt" || stage === "composerClearedAt") prunePending(at);
    },
    setRoute(route) {
      if (!active.retired) record.route = route;
    },
    setClientMsgId(clientMsgId, messageId) {
      if (active.retired) return;
      if (clientMsgId) record.clientMsgId = clientMsgId;
      if (messageId) record.messageId = messageId;
    },
    setMatchText(text) {
      if (!active.retired) active.matchText = text;
    },
    setHistoryCount(count) {
      if (!active.retired) record.historyCount = count;
    },
    resetForFallback() {
      if (active.retired) return;
      delete record.route;
      delete record.clientMsgId;
      delete record.messageId;
      delete record.historySettledDoneAt;
      delete record.enqueueDoneAt;
      delete record.outboxFlushSentAt;
      delete record.outboxReloadDoneAt;
      delete record.historyReadDoneAt;
      delete record.historyReadGapWaitMs;
      delete record.historyReadCostMs;
      delete record.bubbleVisibleAt;
      delete record.composerClearedAt;
      if (active.composerClear === "armed") {
        active.composerClear = record.messageLength > 0 ? "pending" : "skipped";
      }
      if (!pending.includes(active)) pending.push(active);
    },
    expectComposerClear() {
      if (!active.retired && record.composerClearedAt === undefined) active.composerClear = "armed";
    },
    skipComposerClear() {
      if (active.retired) return;
      active.composerClear = "skipped";
      prunePending(performance.now());
    },
    fail(reason) {
      if (active.retired) return;
      active.retired = true;
      record.error = failureCode(reason);
      prunePending(performance.now());
    },
  };
}

export function markSendTimingByClientMsgId(frame: ClientFrame, stage: SendTimingStage): void {
  if (!pending.length) return;
  const active = findByFrame(frame);
  if (!active || active.record[stage] !== undefined) return;
  active.record[stage] = performance.now();
}

export function markSendTimingOutboxReload(
  conversationId: string,
  entries: ReadonlyArray<{ id: string }>,
  settledIds?: ReadonlyMap<string, unknown>,
): void {
  if (!pending.length) return;
  const now = performance.now();
  for (let i = pending.length - 1; i >= 0; i--) {
    const active = pending[i]!;
    if (active.retired || active.record.kind === "side" || active.record.conversationId !== conversationId) continue;
    if (active.record.enqueueDoneAt === undefined || active.record.outboxReloadDoneAt !== undefined) continue;
    const id = active.record.clientMsgId;
    if (!id || entries.some(entry => entry.id === id) || settledIds?.has(id)) {
      active.record.outboxReloadDoneAt = now;
    }
  }
}

export function markSendTimingHistoryRead(
  conversationId: string,
  messages: readonly Message[],
  readEndAt: number,
  gapWaitMs: number,
  readCostMs: number,
): void {
  if (!pending.length) return;
  for (let i = pending.length - 1; i >= 0; i--) {
    const active = pending[i]!;
    if (active.retired || active.record.kind === "side" || active.record.conversationId !== conversationId) continue;
    if (active.record.historyReadDoneAt !== undefined) continue;
    if (active.record.kind === "group" && !active.record.route && active.baselineMessageIds) {
      for (const message of messages) active.baselineMessageIds.add(message.id);
      continue;
    }
    if (!active.record.clientMsgId && !active.record.messageId && active.record.route !== "discussion_start" && active.record.route !== "discussion_note") continue;
    for (let j = messages.length - 1; j >= 0; j--) {
      const message = messages[j]!;
      if (matchesTraceMessage(active, message)) {
        active.record.messageId ??= message.id;
        active.record.clientMsgId ??= message.clientMsgId;
        active.record.historyReadGapWaitMs = gapWaitMs;
        active.record.historyReadCostMs = readCostMs;
        active.record.historyReadDoneAt = readEndAt;
        break;
      }
    }
  }
}

export function markSendTimingBubbleVisible(
  conversationId: string,
  displayedMessages: readonly Message[],
  hasElement: (messageId: string) => boolean,
): void {
  if (!pending.length) return;
  const now = performance.now();
  for (let i = pending.length - 1; i >= 0; i--) {
    const active = pending[i]!;
    if (active.retired || active.record.kind === "side" || active.record.conversationId !== conversationId) continue;
    if (active.record.bubbleVisibleAt !== undefined) continue;
    for (let j = displayedMessages.length - 1; j >= 0; j--) {
      const message = displayedMessages[j]!;
      if (matchesTraceMessage(active, message) && hasElement(message.id)) {
        active.record.messageId ??= message.id;
        active.record.clientMsgId ??= message.clientMsgId;
        active.record.bubbleVisibleAt = now;
        break;
      }
    }
  }
  prunePending(now);
}

export function markSendTimingSideVisible(conversationId: string, questionText: string, exchangeId?: string): void {
  if (!pending.length) return;
  const now = performance.now();
  for (let i = pending.length - 1; i >= 0; i--) {
    const active = pending[i]!;
    if (active.retired || active.record.conversationId !== conversationId || active.record.kind !== "side") continue;
    if (active.record.bubbleVisibleAt !== undefined) continue;
    if (exchangeId !== undefined) {
      if (active.record.clientMsgId === exchangeId) {
        active.record.bubbleVisibleAt = now;
      }
    } else if (active.matchText === undefined || active.matchText === questionText) {
      active.record.bubbleVisibleAt = now;
    }
  }
  prunePending(now);
}

export function markSendTimingComposerCleared(conversationId: string, surface: SendTimingSurface = "main"): void {
  if (!pending.length) return;
  const now = performance.now();
  for (let i = pending.length - 1; i >= 0; i--) {
    const active = pending[i]!;
    if (active.retired || active.record.conversationId !== conversationId || surfaceOf(active.record.kind) !== surface) continue;
    if (active.composerClear === "armed" && active.record.composerClearedAt === undefined) {
      active.record.composerClearedAt = now;
    }
  }
  prunePending(now);
}

export function getSendTimingRecords(): readonly SendTimingRecord[] {
  return records;
}

export function clearSendTimingRecords(): void {
  records.length = 0;
  pending.length = 0;
}

if (isSendTimingEnabled()) ensureGlobalApi();
