import type { Message } from "../../src/client-protocol/index.js";
import { isAgentBusRecord } from "./agent-bus-record.js";
import type { MessageAttention } from "./attention.js";

/** Newest ordinary reply per Bot author in one conversation. */
export type BotReply = { id: string; status: Message["status"]; createdAt: number; at: number };
type ReplyActivity = { replies?: Record<string, BotReply>; workingReplies?: Record<string, number> };
type AgentActivity = ReplyActivity & { unread: Record<string, number>; attention?: Record<string, MessageAttention> };

export type AgentState = "idle" | "working" | "done" | "failed" | "ask";
/** `at` is the Host time of the reply or request that decided the state. */
export type AgentSignal = { state: AgentState; at: number };
export const IDLE_AGENT: AgentSignal = Object.freeze({ state: "idle", at: 0 });

/** Keep only the newest reply per Bot. Forwarded copies and mirrored Agent Bus
 * records are not this conversation's own turn. */
export function projectReply(activity: ReplyActivity, message: Message, at: number): void {
  if (message.authorType !== "bot" || message.forwardedFrom || isAgentBusRecord(message)) return;
  projectWorkingReply(activity, message, at);
  const replies = activity.replies ??= {}, current = replies[message.authorId];
  if (message.status === "deleted") {
    if (current?.id === message.id) delete replies[message.authorId];
    return;
  }
  if (current && current.id !== message.id && current.createdAt > message.createdAt) return;
  replies[message.authorId] = { id: message.id, status: message.status, createdAt: message.createdAt, at };
}

/** Track in-flight messages independently of the newest reply. A separate
 * question, attachment or queued reply cannot finish another running message.
 * Only active IDs/timestamps are retained; terminal updates remove their ID. */
export function projectWorkingReply(activity: Pick<ReplyActivity, "workingReplies">, message: Message, at: number): void {
  const working = activity.workingReplies ??= {};
  if (message.authorType === "bot" && !message.forwardedFrom && !isAgentBusRecord(message) && message.status === "streaming") working[message.id] = at;
  else delete working[message.id];
}

/** List-avatar state for a conversation, a group with its topics, or a Bot's
 * direct conversations. A pending question/approval outranks a running turn;
 * finished replies count only until they are read. Queued (`pending`) replies
 * are not shown as work: an offline Bot has not started them. */
export function agentSignal(activities: Iterable<AgentActivity | undefined>): AgentSignal {
  let ask = 0, working = 0, finished: BotReply | undefined;
  for (const activity of activities) {
    if (!activity) continue;
    for (const request of Object.values(activity.attention ?? {})) ask = Math.max(ask, request.at || 1);
    for (const at of Object.values(activity.workingReplies ?? {})) working = Math.max(working, at || 1);
    for (const reply of Object.values(activity.replies ?? {})) {
      // Compatibility for callers/caches not yet projected. An initialized
      // empty working map is authoritative.
      if (activity.workingReplies === undefined && reply.status === "streaming") working = Math.max(working, reply.at || 1);
      else if ((reply.status === "complete" || reply.status === "error") && activity.unread[reply.id] !== undefined && (!finished || reply.at > finished.at)) finished = reply;
    }
  }
  if (ask) return { state: "ask", at: ask };
  if (working) return { state: "working", at: working };
  if (finished) return { state: finished.status === "error" ? "failed" : "done", at: finished.at };
  return IDLE_AGENT;
}
