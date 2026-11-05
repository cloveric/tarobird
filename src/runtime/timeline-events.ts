import { channelProfile } from "../core/channel-profile.js";
import type { EngineStreamEvent } from "../codex/adapter.js";
import { appendTimelineEvent } from "../state/timeline-log.js";

/**
 * Persist semantic milestones, not token-level rendering noise. Live cards and
 * delivery handlers still receive every event; only the diagnostic timeline is
 * compacted so a single verbose turn cannot rotate away useful history.
 */
export function shouldPersistEngineTimelineEvent(event: EngineStreamEvent): boolean {
  if (event.type === "scoped") {
    if (event.event.type === "scope_status") return true;
    return shouldPersistEngineTimelineEvent(event.event);
  }
  if (event.type === "thinking" || event.type === "tool_progress") return false;
  if (event.type === "assistant_text" && event.delta === true) return false;
  return true;
}

export function engineEventTimelineMetadata(event: EngineStreamEvent): {
  toolName: string | undefined;
  textChars: number | undefined;
  status: string | undefined;
  taskId: string | undefined;
  requestId: string | undefined;
  sessionId: string | undefined;
  userDeliverySuppressed: boolean | undefined;
  taskOrigin?: "bound" | "unattributed";
  notificationReason?: "no_result" | "engine_exit";
  scopeId?: string; scopeKind?: string; parentScopeId?: string;
  activityId?: string; agentId?: string; agentLabel?: string; model?: string; effort?: string;
  retryReason?: string; retryAttempt?: number; retryDelayMs?: number;
} {
  if (event.type === "scoped") {
    const inner = event.event.type === "scope_status" ? { type: "result" as const, text: "" } : event.event;
    return { ...engineEventTimelineMetadata(inner), scopeId: event.scope.id, scopeKind: event.scope.kind,
      parentScopeId: event.scope.parentId, taskOrigin: event.origin,
      ...(event.event.type === "scope_status" ? { status: event.event.status } : {}) };
  }
  return {
    ...(event.type === "engine_retry" ? { retryReason: event.reason, retryAttempt: event.attempt, retryDelayMs: event.delayMs } : {}),
    ...(event.type === "subagent_activity" ? { activityId: event.id, agentId: event.agentId, agentLabel: event.label, model: event.model, effort: event.effort } : {}),
    ...((event.type === "task_notification" || event.type === "background_task_started" || event.type === "background_task_finished") && event.origin ? { taskOrigin: event.origin } : {}),
    ...(event.type === "task_notification" && event.reason ? { notificationReason: event.reason } : {}),
    toolName: "toolName" in event ? event.toolName : undefined,
    textChars: "text" in event ? event.text.length : undefined,
    status: event.type === "subagent_activity" ? event.kind : "status" in event ? event.status : undefined,
    taskId: "taskId" in event ? event.taskId : undefined,
    requestId: "requestId" in event ? event.requestId : undefined,
    sessionId: "sessionId" in event ? event.sessionId : undefined,
    userDeliverySuppressed: event.type === "task_notification"
      ? event.suppressUserDelivery
      : undefined,
  };
}

export async function appendTimelineEventBestEffort(
  stateDir: string,
  event: Parameters<typeof appendTimelineEvent>[1],
  label = "timeline event",
): Promise<void> {
  try {
    await appendTimelineEvent(stateDir, event.channel === "lark" && channelProfile() === "gateway" ? { ...event, channel: "gateway" } : event);
  } catch (error) {
    console.error(`Failed to persist ${label}:`, error instanceof Error ? error.message : error);
  }
}
