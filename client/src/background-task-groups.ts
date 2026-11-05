import type { Message, Block } from "../../src/client-protocol/index.js";
import { isRunActive, runSummarySchema, type RunSummary } from "../../src/client-protocol/run.js";
import { backgroundTaskNotice } from "../../src/client-protocol/background-task.js";
import { backgroundTaskGroupSchema } from "../../src/client-protocol/background-task-group.js";

export type BackgroundTaskRow = { message: Message; block: Extract<Block, { type: "card" }>; run: RunSummary; scopeId: string };
export type BackgroundTaskGroup = { key: string; anchor: Message; tasks: BackgroundTaskRow[] };
export function visibleTaskIds(group: BackgroundTaskGroup, limit = 5) {
  const active = group.tasks.filter(task => isRunActive(taskPhase(task)));
  const ended = group.tasks.filter(task => !isRunActive(taskPhase(task)));
  return new Set([...active, ...ended].slice(0, limit).map(task => task.message.id));
}
export function taskPhase(task: BackgroundTaskRow): RunSummary["phase"] {
  if (backgroundTaskNotice(task.block)?.delivery === "unconfirmed") return "partial";
  return isRunActive(task.run.phase) && task.message.status === "error" ? "interrupted" : task.run.phase;
}
export function taskCounts(group: BackgroundTaskGroup) {
  const result = { running: 0, done: 0, error: 0, interrupted: 0, unknown: 0 };
  for (const task of group.tasks) {
    const phase = taskPhase(task);
    if (isRunActive(phase)) result.running++;
    else if (phase === "done") result.done++;
    else if (phase === "error") result.error++;
    else if (phase === "stopped" || phase === "interrupted") result.interrupted++;
    else result.unknown++;
  }
  return result;
}
/** A view over the original records, never a second source of execution state.
 * Rich/forwarded messages and unknown metadata retain their complete old view. */
export function groupBackgroundTasks(messages: Message[], supported = true) {
  const groups = new Map<string, BackgroundTaskGroup>();
  if (supported) for (const message of messages) {
    if (message.authorType !== "bot" || message.status === "deleted" || message.forwardedFrom || message.botSource || message.groupDiscussion || message.blocks.length !== 1) continue;
    const block = message.blocks[0]!;
    if (block.type !== "card" || block.extra?.nativeRun !== undefined) continue;
    if (block.extra?.backgroundTask !== undefined && backgroundTaskNotice(block)?.origin !== "bound") continue;
    const meta = backgroundTaskGroupSchema.safeParse(block.extra?.backgroundTaskGroup), run = runSummarySchema.safeParse(block.extra?.scopedRun);
    if (!meta.success || !run.success || meta.data.runId !== run.data.id) continue;
    const key = JSON.stringify([message.conversationId, message.authorId, message.replyTo ?? "", meta.data.groupId]);
    let group = groups.get(key);
    if (!group) { group = { key, anchor: message, tasks: [] }; groups.set(key, group); }
    group.tasks.push({ message, block, run: run.data, scopeId: meta.data.scopeId });
  }
  // Ambiguous duplicate scopes are shown independently; never hide evidence.
  for (const [key, group] of groups) if (new Set(group.tasks.map(task => task.scopeId)).size !== group.tasks.length) groups.delete(key);
  const byAnchor = new Map<string, BackgroundTaskGroup>(), anchors = new Map<string, string>();
  for (const group of groups.values()) {
    byAnchor.set(group.anchor.id, group);
    for (const task of group.tasks) anchors.set(task.message.id, group.anchor.id);
  }
  return { groups: [...groups.values()], byAnchor, anchors, messages: messages.filter(message => !anchors.has(message.id) || anchors.get(message.id) === message.id) };
}
export function groupElapsed(group: BackgroundTaskGroup, now: number) {
  return Math.max(0, Math.max(...group.tasks.map(task => task.run.endedAt ?? (isRunActive(taskPhase(task)) ? Math.max(task.run.updatedAt, now) : task.run.updatedAt))) - Math.min(...group.tasks.map(task => task.run.startedAt)));
}
