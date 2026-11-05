import { buildCoreConversationKey } from "../core/message-normalizer.js";
import type { CoreServiceRuntime } from "../core/runtime.js";
import type { DrainBlocker } from "./control.js";

/** Approval cards normally belong to an active run; count that conversation once.
 * Delegated Bus requests execute outside the conversation runtime entirely. */
export function gatewayActiveWorkCount(runtime: Pick<CoreServiceRuntime, "activeRuns" | "pendingApprovals"> & Partial<Pick<CoreServiceRuntime, "concurrentRuns" | "chatQueue">>, delegatedRequests = 0): number {
  const conversations = new Set(runtime.activeRuns.keys());
  for (const key of runtime.chatQueue?.busyKeys() ?? []) conversations.add(String(key));
  for (const [key, runs] of runtime.concurrentRuns ?? []) if (runs.size) conversations.add(key);
  for (const pending of runtime.pendingApprovals.values()) conversations.add(pending.conversationKey ?? buildCoreConversationKey(pending.chatId));
  return conversations.size + delegatedRequests;
}

/** Ordinary choice cards are durable Hub messages and can be claimed after
 * restart without this map. Native question/approval callbacks are in memory;
 * preserve those even if their originating turn has already returned. */
export function gatewayDrainBlockers(runtime: Pick<CoreServiceRuntime, "activeRuns" | "pendingApprovals" | "pendingBatches" | "queueCards" | "choiceCards"> & Partial<Pick<CoreServiceRuntime, "concurrentRuns" | "chatQueue">>, botId: string): DrainBlocker[] {
  const groups = new Map<string, DrainBlocker>();
  const add = (type: DrainBlocker["type"], count: number, conversationKey?: string) => {
    if (!count) return;
    const key = JSON.stringify([type, conversationKey]);
    const group = groups.get(key);
    if (group) group.count += count;
    else groups.set(key, { botId, type, count, ...(conversationKey ? { conversationKey } : {}) });
  };
  for (const key of runtime.activeRuns.keys()) add("run", 1, key);
  for (const [key, runs] of runtime.concurrentRuns ?? []) {
    add("run", [...runs].filter(run => run !== runtime.activeRuns.get(key)).length, key);
  }
  for (const pending of runtime.pendingApprovals.values()) add(pending.asyncQuestion ? "async_question" : "approval", 1, pending.conversationKey ?? buildCoreConversationKey(pending.chatId));
  for (const key of runtime.chatQueue?.busyKeys() ?? []) add("queue", 1, String(key));
  for (const key of runtime.pendingBatches.keys()) add("batch", 1, key);
  add("queue", runtime.queueCards.size);
  add("native_choice", [...runtime.choiceCards.values()].filter(card => card.status === "active" && card.answerActiveTurn).length);
  return [...groups.values()];
}
