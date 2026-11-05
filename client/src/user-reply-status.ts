import type { Message } from "../../src/client-protocol/index.js";
import { isRunActive, nativeRun, type RunSummary } from "../../src/client-protocol/run.js";

export type UserReplyState = "replying" | "done" | "error" | "partial" | "stopped" | "interrupted" | "waiting_approval" | "waiting_answer" | "stopping" | "unconfirmed";
export type UserReply = { botId: string; messageId: string; state: UserReplyState };
type Evidence = { botId: string; messageId: string; run?: RunSummary; failed: boolean; at: number; createdAt: number };

function newer(next: Evidence, old: Evidence): boolean {
  // Hub failDelivery is final for this user/Bot pair. Clock skew or a stale
  // cached run must not turn its explicit recovery failure into success.
  if (!next.run || !old.run) return !next.run && (!!old.run || next.createdAt > old.createdAt || next.createdAt === old.createdAt && next.messageId > old.messageId);
  if (next.run && old.run && next.run.id === old.run.id) {
    if (next.run.revision !== old.run.revision) return next.run.revision > old.run.revision;
    if (next.failed !== old.failed) return next.failed;
    return next.run.updatedAt > old.run.updatedAt || next.run.updatedAt === old.run.updatedAt && next.messageId > old.messageId;
  }
  // A late update to an older run must never replace a newer attempt.
  return next.at > old.at || next.at === old.at && next.run.id > old.run.id;
}

function replyState(evidence: Evidence, online: boolean): UserReplyState {
  const run = evidence.run;
  if (!run) return "error";
  if (evidence.failed && isRunActive(run.phase)) return "interrupted";
  if (evidence.failed && run.phase === "done") return "error";
  if (isRunActive(run.phase) && !online) return "unconfirmed";
  switch (run.phase) {
    case "thinking": case "working": case "answering": case "delivering": return "replying";
    default: return run.phase;
  }
}

/** Only host-confirmed foreground runs count. User delivery acknowledgements,
 * ordinary text/files, queue positions and background/subagent notices do not
 * prove that a prompt was answered. Index the whole conversation once, not the
 * neighboring or currently visible virtual rows. No inference from prose. */
export function userReplyStatuses(messages: readonly Message[], conversationId: string, onlineBots: ReadonlySet<string>): Map<string, UserReply[]> {
  const users = new Set(messages.filter(m => m.conversationId === conversationId && m.authorType === "user" && m.status === "complete" && !m.blocks.some(b => b.type === "steering")).map(m => m.id));
  const evidence = new Map<string, Map<string, Evidence>>();
  for (const message of messages) {
    if (message.conversationId !== conversationId || message.authorType !== "bot" || message.status === "deleted" || message.forwardedFrom || !message.replyTo || !users.has(message.replyTo)) continue;
    const cards = message.blocks.filter(b => b.type === "card");
    if (cards.some(b => b.extra?.scopedRun !== undefined || b.extra?.backgroundTask !== undefined)) continue;
    const runs = cards.map(b => nativeRun(b)).filter((r): r is RunSummary => !!r);
    if (!runs.length && message.status !== "error") continue;
    const byBot = evidence.get(message.replyTo) ?? new Map<string, Evidence>();
    for (const run of runs.length ? runs : [undefined]) {
      const next: Evidence = { botId: message.authorId, messageId: message.id, run, failed: message.status === "error", at: run?.startedAt ?? message.createdAt, createdAt: message.createdAt };
      const old = byBot.get(message.authorId);
      if (!old || newer(next, old)) byBot.set(message.authorId, next);
    }
    evidence.set(message.replyTo, byBot);
  }
  return new Map([...evidence].map(([id, byBot]) => [id, [...byBot.values()].sort((a, b) => a.botId.localeCompare(b.botId)).map(e => ({ botId: e.botId, messageId: e.messageId, state: replyState(e, onlineBots.has(e.botId)) }))]));
}
