import type { Message } from "../../src/client-protocol/index.js";
import { anyRun, isRunActive, nativeRun } from "../../src/client-protocol/run.js";
import type { Bot } from "./connection.js";
import { isAgentBusRecord } from "./agent-bus-record.js";
import type { EngineTaskSnapshot } from "../../src/client-protocol/engine-tasks.js";

/** Use the worker's declared stop scope, never infer it from a saved card. */
export function affectedBackgroundTasks(snapshot?: EngineTaskSnapshot) {
  if (!snapshot?.supported) return [];
  return snapshot.tasks.filter(task => task.status === "running" && task.mode === "background"
    && (snapshot.foregroundStopScope === "all" || snapshot.foregroundStopScope === "subagents" && task.kind === "subagent"));
}

export function turnStopImpact(messages: Message[], bots: Pick<Bot, "id" | "engine">[], conversationId: string, botId?: string) {
  const rows = messages.filter(message => message.conversationId === conversationId && message.authorType === "bot" && (!botId || message.authorId === botId) && message.status !== "deleted" && message.status !== "error");
  const foreground = rows.filter(message => !isAgentBusRecord(message) && (message.blocks.some(block => block.type === "card" && nativeRun(block) && isRunActive(nativeRun(block)!.phase))
    || !message.blocks.some(block => block.type === "card" && anyRun(block)) && ["pending", "streaming"].includes(message.status)));
  const risk = foreground.some(message => bots.some(bot => bot.id === message.authorId && bot.engine === "claude")
    && (message.blocks.some(block => block.type === "card" && nativeRun(block)?.current?.name === "background_review_wait" && nativeRun(block)?.current?.status === "waiting")
      || rows.some(other => other.authorId === message.authorId && other.blocks.some(block => block.type === "card" && block.extra?.scopedRun && anyRun(block) && isRunActive(anyRun(block)!.phase)))));
  const identity = JSON.stringify(foreground.map(message => [message.id, ...message.blocks.flatMap(block => block.type === "card" ? nativeRun(block)?.id ?? [] : [])]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
  return { risk, identity };
}
