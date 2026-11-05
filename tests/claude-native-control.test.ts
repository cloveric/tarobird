import { describe, expect, it, vi } from "vitest";

import { ClaudeControlError, ClaudeNativeControl, CLAUDE_MESSAGE_LIFECYCLE } from "../src/codex/claude-native-control.js";

function harness() {
  const written: Array<Record<string, unknown>> = [];
  const lifecycle: Array<[string, string]> = [];
  const control = new ClaudeNativeControl((payload) => { written.push(payload as Record<string, unknown>); }, (uuid, state) => { lifecycle.push([uuid, state]); });
  const lastRequestId = () => (written.at(-1) as { request_id: string }).request_id;
  return { control, written, lifecycle, lastRequestId };
}

describe("ClaudeNativeControl", () => {
  it("correlates only its own control responses and leaves other channels' responses alone", async () => {
    const { control, written, lastRequestId } = harness();
    const pending = control.request("interrupt");
    expect(written[0]).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
    const id = lastRequestId();
    expect(id.startsWith("tarobot-ctl-")).toBe(true);
    // Side questions and App MCP use their own ids.
    expect(control.handle({ type: "control_response", response: { subtype: "success", request_id: "tarobot-side-x", response: {} } })).toBe(false);
    expect(control.handle({ type: "control_response", response: { subtype: "success", request_id: id, response: { still_queued: [] } } })).toBe(true);
    await expect(pending).resolves.toEqual({ still_queued: [] });
    // A late duplicate of an already settled response is still consumed.
    expect(control.handle({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } })).toBe(true);
  });

  it("rejects error responses, timeouts and closed channels with a typed error", async () => {
    vi.useFakeTimers();
    try {
      const { control, lastRequestId } = harness();
      const rejected = control.request("stop_task", { task_id: "t1" });
      control.handle({ type: "control_response", response: { subtype: "error", request_id: lastRequestId(), error: "Task t1 is not running (status: completed)" } });
      await expect(rejected).rejects.toMatchObject({ name: "ClaudeControlError", kind: "rejected", message: expect.stringContaining("is not running") });
      const timedOut = control.request("interrupt", {}, 100);
      const timedOutCheck = expect(timedOut).rejects.toMatchObject({ kind: "timeout" });
      await vi.advanceTimersByTimeAsync(101);
      await timedOutCheck;
      const closed = control.request("interrupt");
      control.close(new Error("gone"));
      await expect(closed).rejects.toBeInstanceOf(ClaudeControlError);
      await expect(control.request("interrupt")).rejects.toMatchObject({ kind: "closed" });
    } finally { vi.useRealTimers(); }
  });

  it("reads capabilities from every init frame instead of guessing from versions", () => {
    const { control } = harness();
    expect(control.has(CLAUDE_MESSAGE_LIFECYCLE)).toBe(false);
    control.handle({ type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1", 7] });
    expect(control.has(CLAUDE_MESSAGE_LIFECYCLE)).toBe(true);
    control.handle({ type: "system", subtype: "init", capabilities: [] });
    expect(control.has(CLAUDE_MESSAGE_LIFECYCLE)).toBe(false);
    control.handle({ type: "system", subtype: "init", capabilities: ["msg_lifecycle_v1"] });
    // An init frame without the field grants nothing; earlier grants do not linger.
    control.handle({ type: "system", subtype: "init" });
    expect(control.has(CLAUDE_MESSAGE_LIFECYCLE)).toBe(false);
  });

  it("evicts settled commands before a live prompt when the bound is reached", () => {
    const { control } = harness();
    control.track("live-prompt");
    control.handle({ type: "command_lifecycle", command_uuid: "live-prompt", state: "started" });
    for (let index = 0; index < 300; index += 1) {
      control.track(`steer-${index}`);
      control.handle({ type: "command_lifecycle", command_uuid: `steer-${index}`, state: "completed" });
    }
    expect(control.commandState("live-prompt")).toBe("started");
    expect(control.commandState("steer-299")).toBe("completed");
  });

  it("keeps a task's kind when a later start frame omits task_type, and maps terminal edges", () => {
    const { control } = harness();
    control.handle({ type: "system", subtype: "task_started", task_id: "a", task_type: "local_agent", description: "Agent" });
    control.handle({ type: "system", subtype: "task_started", task_id: "a", description: "Agent resumed" });
    expect(control.task("a")?.kind).toBe("agent");
    control.handle({ type: "system", subtype: "task_notification", task_id: "a", status: "failed" });
    control.handle({ type: "system", subtype: "task_started", task_id: "b", task_type: "local_bash", description: "b", is_backgrounded: true });
    control.handle({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    // Missing from the level is unknown until its own bookend names the outcome.
    expect(control.endedTasks().map((task) => [task.taskId, task.status])).toEqual([["a", "error"], ["b", "unknown"]]);
    control.handle({ type: "system", subtype: "task_notification", task_id: "b", status: "stopped" });
    expect(control.endedTasks().find((task) => task.taskId === "b")?.status).toBe("stopped");
  });

  it("tracks lifecycle only for uuids this host wrote and keeps the first terminal state", async () => {
    const { control, lifecycle } = harness();
    control.track("mine");
    expect(control.handle({ type: "command_lifecycle", command_uuid: "foreign", state: "started" })).toBe(true);
    expect(control.commandState("foreign")).toBeUndefined();
    const started = control.waitForCommand("mine", new Set(["started"]), 1_000);
    control.handle({ type: "command_lifecycle", command_uuid: "mine", state: "queued" });
    control.handle({ type: "command_lifecycle", command_uuid: "mine", state: "started" });
    await expect(started).resolves.toBe("started");
    control.handle({ type: "command_lifecycle", command_uuid: "mine", state: "cancelled" });
    control.handle({ type: "command_lifecycle", command_uuid: "mine", state: "completed" });
    expect(control.commandState("mine")).toBe("cancelled");
    expect(lifecycle).toEqual([["mine", "queued"], ["mine", "started"], ["mine", "cancelled"]]);
    // A waiter for a state that can no longer happen settles on the terminal state.
    control.track("other");
    const queued = control.waitForCommand("other", new Set(["queued"]), 1_000);
    control.handle({ type: "command_lifecycle", command_uuid: "other", state: "refused" });
    await expect(queued).resolves.toBe("refused");
  });

  it("maintains live tasks from edges and the REPLACE background level", async () => {
    const { control } = harness();
    control.handle({ type: "system", subtype: "task_started", task_id: "fg", task_type: "local_agent", description: "Review", subagent_type: "general-purpose", is_backgrounded: false, tool_use_id: "toolu_fg" });
    control.handle({ type: "system", subtype: "task_started", task_id: "bg", task_type: "local_bash", description: "Build", is_backgrounded: true });
    control.handle({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg", task_type: "local_bash", description: "Build" }, { task_id: "late", task_type: "local_workflow", description: "Spec" }] });
    expect(control.listTasks().map((task) => [task.taskId, task.kind, task.background])).toEqual([["fg", "agent", false], ["bg", "bash", true], ["late", "workflow", true]]);
    control.handle({ type: "system", subtype: "task_updated", task_id: "fg", patch: { is_backgrounded: true } });
    expect(control.task("fg")?.background).toBe(true);
    const ended = control.waitForTaskEnd("bg", 1_000);
    // Missing from the level means ended even when its own bookend was lost.
    control.handle({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "fg", task_type: "local_agent", description: "Review" }] });
    await expect(ended).resolves.toBe("ended");
    expect(control.listTasks().map((task) => task.taskId)).toEqual(["fg"]);
    control.handle({ type: "system", subtype: "task_updated", task_id: "fg", patch: { status: "killed" } });
    expect(control.listTasks()).toEqual([]);
    control.handle({ type: "system", subtype: "task_started", task_id: "x", task_type: "local_bash", description: "x" });
    control.close(new Error("exit"));
    expect(control.listTasks()).toEqual([]);
  });

  it("reports room for another command only without evicting a live one", () => {
    const { control } = harness();
    for (let index = 0; index < 256; index += 1) control.track(`live-${index}`);
    expect(control.canTrack()).toBe(false);
    control.handle({ type: "command_lifecycle", command_uuid: "live-7", state: "cancelled" });
    expect(control.canTrack()).toBe(true);
    control.track("next");
    expect(control.commandState("live-7")).toBeUndefined();
    expect(control.commandState("live-0")).toBe("written");
    expect(control.commandState("next")).toBe("written");
  });

  it("never forgets a live command for a new one below the hard bound", () => {
    const { control } = harness();
    for (let index = 0; index < 256; index += 1) control.track(`live-${index}`);
    control.track("prompt-257");
    expect(control.commandState("live-0")).toBe("written");
    expect(control.commandState("prompt-257")).toBe("written");
    // Settled history is shed first once some exists.
    control.handle({ type: "command_lifecycle", command_uuid: "live-3", state: "completed" });
    control.track("prompt-258");
    expect(control.commandState("live-3")).toBeUndefined();
    expect(control.commandState("live-0")).toBe("written");
    // Memory stays bounded: past the hard bound the oldest live one goes.
    for (let index = 0; index < 1024; index += 1) control.track(`more-${index}`);
    expect(control.commandState("live-0")).toBeUndefined();
    expect(control.commandState("more-1023")).toBe("written");
  });
});
