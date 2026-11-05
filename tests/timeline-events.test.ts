import { describe, expect, it } from "vitest";

import {
  engineEventTimelineMetadata,
  shouldPersistEngineTimelineEvent,
} from "../src/runtime/timeline-events.js";

describe("engine event timeline metadata", () => {
  it("persists recovery milestones with safe semantic fields", () => {
    const event = { type: "engine_retry" as const, status: "waiting" as const, reason: "capacity" as const, attempt: 2, delayMs: 5000, sessionId: "native" };
    expect(shouldPersistEngineTimelineEvent(event)).toBe(true);
    expect(engineEventTimelineMetadata(event)).toMatchObject({ status: "waiting", retryReason: "capacity", retryAttempt: 2, retryDelayMs: 5000, sessionId: "native" });
  });
  it("keeps native child activity identity separate from background task ownership", () => {
    const event = { type: "subagent_activity" as const, id: "activity-1", kind: "started" as const, agentId: "child-1", label: "/root/reviewer", model: "fixture-model", effort: "xhigh" };
    expect(shouldPersistEngineTimelineEvent(event)).toBe(true);
    expect(engineEventTimelineMetadata(event)).toMatchObject({ activityId: "activity-1", agentId: "child-1", agentLabel: "/root/reviewer", model: "fixture-model", effort: "xhigh", status: "started", taskId: undefined });
  });
  it("keeps session identity and delivery suppression for background lifecycle events", () => {
    expect(engineEventTimelineMetadata({
      type: "task_notification",
      text: "Background build completed.",
      status: "completed",
      taskId: "bash-build1",
      sessionId: "kimi-session-1",
      suppressUserDelivery: true,
    })).toEqual({
      toolName: undefined,
      textChars: 27,
      status: "completed",
      taskId: "bash-build1",
      sessionId: "kimi-session-1",
      userDeliverySuppressed: true,
    });
  });

  it("drops high-frequency rendering fragments but keeps semantic milestones", () => {
    expect(shouldPersistEngineTimelineEvent({ type: "assistant_text", text: "tok", delta: true })).toBe(false);
    expect(shouldPersistEngineTimelineEvent({ type: "thinking", text: "reasoning" })).toBe(false);
    expect(shouldPersistEngineTimelineEvent({
      type: "tool_progress",
      toolUseId: "tool-1",
      text: "still running",
    })).toBe(false);

    expect(shouldPersistEngineTimelineEvent({ type: "assistant_text", text: "complete message" })).toBe(true);
    expect(shouldPersistEngineTimelineEvent({ type: "tool_use", toolName: "Read" })).toBe(true);
    expect(shouldPersistEngineTimelineEvent({ type: "result", text: "done" })).toBe(true);
  });
});
