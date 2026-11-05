import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { EngineCancellationUnconfirmedError, EngineSteeringRejectedError, EngineStopTooLateError } from "../src/codex/adapter.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import * as processTree from "../src/codex/process-tree.js";
import { APP_STOP_PROCESS_GRACE_MS, APP_USER_STOP_REASON } from "../src/runtime/turn-cancellation.js";

// Frame shapes and ordering follow real Claude Code 2.1.307 probes
// (docs/client/claude-native-control-2026-10-23.md).
const CAPABILITIES = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"];
const SESSION = "native-S";

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met in time");
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

class FakeStream extends EventEmitter { emitData(chunk: string) { this.emit("data", chunk); } }
class FakeWritable {
  lines: string[] = [];
  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) this.lines.push(text);
    callback?.(null);
    return true;
  }
}
class FakeChild extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeStream();
  stderr = new FakeStream();
  close(code: number | null) { this.emit("close", code); }
}

function setup(taskNotificationStartGraceMs = 0) {
  const children: FakeChild[] = [];
  const spawnFn = () => { const child = new FakeChild(); children.push(child); return child; };
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn, taskNotificationStartGraceMs });
  return { adapter, children };
}

type Written = { type: string; uuid?: string; priority?: string; request_id?: string; request?: Record<string, unknown>; message?: { content: Array<{ text: string }> }; response?: Record<string, unknown> };
const written = (child: FakeChild): Written[] => child.stdin.lines.map((line) => JSON.parse(line) as Written);
const lastWritten = (child: FakeChild): Written => written(child).at(-1)!;
const emit = (child: FakeChild, frame: Record<string, unknown>) => child.stdout.emitData(JSON.stringify({ session_id: SESSION, ...frame }) + "\n");
const lifecycle = (child: FakeChild, uuid: string, state: string) => emit(child, { type: "command_lifecycle", command_uuid: uuid, state });
const ack = (child: FakeChild, request: Written, response: Record<string, unknown> = {}) =>
  emit(child, { type: "control_response", response: { subtype: "success", request_id: request.request_id, response } });
const controlRequests = (child: FakeChild, subtype: string) => written(child).filter((line) => line.type === "control_request" && line.request?.subtype === subtype);

/** Starts a turn, publishes capabilities and returns its prompt uuid once Claude reports it started. */
async function startTurn(adapter: ClaudeStreamAdapter, children: FakeChild[], input: { text: string; abortSignal?: AbortSignal; events?: EngineStreamEvent[]; onApprovalRequest?: () => Promise<{ behavior: "deny" }>; capabilities?: string[]; start?: boolean }) {
  const before = children[0]?.stdin.lines.length ?? 0;
  const turn = adapter.sendUserMessage(SESSION, { text: input.text, files: [], abortSignal: input.abortSignal, onApprovalRequest: input.onApprovalRequest,
    onEngineEvent: input.events ? (event) => { input.events!.push(event); } : undefined });
  await waitFor(() => (children[0]?.stdin.lines.length ?? 0) > before && written(children[0]).some((line, index) => index >= before && line.type === "user"));
  const child = children[0];
  const prompt = written(child).filter((line) => line.type === "user").at(-1)!;
  emit(child, { type: "system", subtype: "init", capabilities: input.capabilities ?? CAPABILITIES });
  lifecycle(child, prompt.uuid!, "queued");
  if (input.start !== false) lifecycle(child, prompt.uuid!, "started");
  return { turn, child, uuid: prompt.uuid! };
}

let kill: ReturnType<typeof vi.spyOn>;
afterEach(() => { kill?.mockRestore(); });
const spyKill = () => { kill = vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve()); return kill; };

describe("Claude soft stop", () => {
  it("interrupts natively, keeps the worker and fences the interrupted turn's late frames from the next turn", async () => {
    const killSpy = spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const first: EngineStreamEvent[] = [];
      const { turn, child, uuid } = await startTurn(adapter, children, { text: "long task", abortSignal: stop.signal, events: first });
      expect(written(child)[0]).toMatchObject({ type: "user", uuid });
      expect(written(child)[0]!.priority).toBeUndefined();
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
      let settledStop = false;
      const stopped = expect(turn.finally(() => { settledStop = true; })).rejects.toThrow("stopped by user");
      stop.abort(APP_USER_STOP_REASON);
      const [interrupt] = controlRequests(child, "interrupt");
      expect(interrupt).toBeDefined();
      // Named: Claude spares any other turn (e.g. its own background review).
      expect(interrupt!.request).toEqual({ subtype: "interrupt", for_user_message_uuids: [uuid] });
      expect(killSpy).not.toHaveBeenCalled();

      const second: EngineStreamEvent[] = [];
      const next = adapter.sendUserMessage(SESSION, { text: "next question", files: [], onEngineEvent: (event) => { second.push(event); } });
      await settle();
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(1);
      // A stop is reported only once Claude confirms it.
      expect(settledStop).toBe(false);
      ack(child, interrupt!, { still_queued: [], turn: "stopped" });
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "late interrupted text" }] } });
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", user_message_uuid: uuid });
      await settle();
      // Not before the interrupted command's own terminal lifecycle frame.
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(1);
      expect(settledStop).toBe(false);
      lifecycle(child, uuid, "cancelled");
      await stopped;
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
      expect(children).toHaveLength(1);
      const prompt2 = written(child).filter((line) => line.type === "user")[1]!;
      expect(prompt2.message!.content[0]!.text).toContain("next question");
      lifecycle(child, prompt2.uuid!, "started");
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } });
      emit(child, { type: "result", subtype: "success", result: "answer" });
      await expect(next).resolves.toMatchObject({ text: "answer" });
      expect(JSON.stringify(second)).not.toContain("late interrupted text");
      expect(JSON.stringify(first)).not.toContain("late interrupted text");
    } finally { await adapter.destroy(); }
  });

  it("keeps a background shell alive and delivers its later review to the stopped turn, never to the next one", async () => {
    const killSpy = spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const first: EngineStreamEvent[] = [];
      const { turn, child, uuid } = await startTurn(adapter, children, { text: "start build", abortSignal: stop.signal, events: first });
      emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "make all", run_in_background: true } }] } });
      emit(child, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Command running in background with ID: b1" }] } });
      emit(child, { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "make all" }] });
      emit(child, { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "toolu_bg", task_type: "local_bash", description: "make all", is_backgrounded: true });
      const stopped = expect(turn).rejects.toThrow("stopped by user");
      stop.abort(APP_USER_STOP_REASON);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [], turn: "stopped" });
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true });
      lifecycle(child, uuid, "cancelled");
      await stopped;
      const snapshot = await adapter.listTasks(SESSION);
      expect(snapshot).toEqual({ supported: true, foregroundStopScope: "subagents", tasks: [expect.objectContaining({ kind: "shell", mode: "background", status: "running", canStop: true, owner: "bound", label: "make all" })] });
      expect(snapshot.tasks[0]!.id).not.toBe("b1");
      expect(first.some((event) => event.type === "task_notification")).toBe(false);

      const second: EngineStreamEvent[] = [];
      const next = startTurn(adapter, children, { text: "unrelated", events: second });
      const { turn: nextTurn } = await next;
      emit(child, { type: "result", subtype: "success", result: "unrelated answer" });
      await expect(nextTurn).resolves.toMatchObject({ text: "unrelated answer" });

      emit(child, { type: "system", subtype: "task_updated", task_id: "b1", patch: { status: "completed" } });
      emit(child, { type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "toolu_bg", status: "completed", summary: "make all", output_file: "/tmp/b1.out" });
      emit(child, { type: "system", subtype: "background_tasks_changed", tasks: [] });
      emit(child, { type: "system", subtype: "init", capabilities: CAPABILITIES });
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "Build finished." }] } });
      emit(child, { type: "result", subtype: "success", result: "Build finished.", origin: { kind: "task-notification" } });
      await waitFor(() => first.some((event) => event.type === "task_notification" && event.text.includes("Build finished.")));
      expect(JSON.stringify(second)).not.toContain("Build finished.");
      expect(first.some((event) => event.type === "task_notification" && (event.reason === "engine_exit" || event.status === "interrupted"))).toBe(false);
      await expect(adapter.listTasks(SESSION)).resolves.toEqual({ supported: true, foregroundStopScope: "subagents", tasks: [expect.objectContaining({ id: snapshot.tasks[0]!.id, status: "done", canStop: false })] });
      expect(killSpy).not.toHaveBeenCalled();
    } finally { await adapter.destroy(); }
  });

  it.each([
    ["a non-App abort reason", undefined, CAPABILITIES],
    ["a CLI without the lifecycle contract", APP_USER_STOP_REASON, ["interrupt_receipt_v1"]],
  ])("keeps bounded process cleanup for %s", async (_label, reason, capabilities) => {
    const killSpy = spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child } = await startTurn(adapter, children, { text: "long", abortSignal: stop.signal, capabilities });
      const stopped = expect(turn).rejects.toThrow("stopped by user");
      stop.abort(reason);
      await stopped;
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(controlRequests(child, "interrupt")).toHaveLength(0);
      const next = adapter.sendUserMessage(SESSION, { text: "again", files: [] });
      void next.catch(() => undefined);
      await waitFor(() => children.length === 2 && children[1]!.stdin.lines.length === 1);
    } finally { await adapter.destroy(); }
  });

  it("reports an unconfirmed stop instead of killing anything, and holds later input pending until Claude settles", async () => {
    const killSpy = spyKill();
    vi.useFakeTimers();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const first: EngineStreamEvent[] = [];
      const turn = adapter.sendUserMessage(SESSION, { text: "long", files: [], abortSignal: stop.signal, onEngineEvent: (event) => { first.push(event); } });
      const unconfirmed = expect(turn).rejects.toBeInstanceOf(EngineCancellationUnconfirmedError);
      await vi.advanceTimersByTimeAsync(0);
      const child = children[0]!;
      const uuid = written(child)[0]!.uuid!;
      emit(child, { type: "system", subtype: "init", capabilities: CAPABILITIES });
      lifecycle(child, uuid, "started");
      emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "make", run_in_background: true } }] } });
      emit(child, { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "toolu_bg", task_type: "local_bash", description: "make", is_backgrounded: true });
      stop.abort(APP_USER_STOP_REASON);
      emit(child, { type: "control_response", response: { subtype: "error", request_id: controlRequests(child, "interrupt")[0]!.request_id, error: "boom" } });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(killSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      await unconfirmed;
      expect(adapter.isSessionInputBlocked(SESSION)).toBe(true);
      // Later input did not run: it is neither written nor consumed as a
      // failure. It stays pending, and only its own abort ends the wait.
      const abortable = new AbortController();
      let abortableSettled = false;
      const cancelled = adapter.sendUserMessage(SESSION, { text: "withdrawn input", files: [], abortSignal: abortable.signal });
      void cancelled.then(() => { abortableSettled = true; }, () => { abortableSettled = true; });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(abortableSettled).toBe(false);
      const cancelledCheck = expect(cancelled).rejects.toThrow("stopped by user");
      abortable.abort(APP_USER_STOP_REASON);
      await cancelledCheck;
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(1);
      expect(killSpy).not.toHaveBeenCalled();
      expect(children).toHaveLength(1);
      expect(first.some((event) => event.type === "task_notification")).toBe(false);
      await expect(adapter.listTasks(SESSION)).resolves.toMatchObject({ tasks: [expect.objectContaining({ status: "running" })] });
      // Claude settles late: the waiting input is written then, on the same process.
      const next = adapter.sendUserMessage(SESSION, { text: "after", files: [] });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(1);
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, user_message_uuid: uuid });
      lifecycle(child, uuid, "cancelled");
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.isSessionInputBlocked(SESSION)).toBe(false);
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(2);
      const prompt = written(child).filter((line) => line.type === "user")[1]!;
      lifecycle(child, prompt.uuid!, "started");
      emit(child, { type: "result", subtype: "success", result: "after answer", user_message_uuid: prompt.uuid });
      await expect(next).resolves.toMatchObject({ text: "after answer" });
    } finally { vi.useRealTimers(); await adapter.destroy(); }
  });

  it("reports a stop that arrived after the turn finished as too late", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child, uuid } = await startTurn(adapter, children, { text: "work", abortSignal: stop.signal });
      const tooLate = expect(turn).rejects.toBeInstanceOf(EngineStopTooLateError);
      stop.abort(APP_USER_STOP_REASON);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [], turn: "idle" });
      emit(child, { type: "result", subtype: "success", result: "finished", user_message_uuid: uuid });
      lifecycle(child, uuid, "completed");
      await tooLate;
    } finally { await adapter.destroy(); }
  });

  it("withdraws a prompt Claude has not started instead of interrupting whatever runs", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child, uuid } = await startTurn(adapter, children, { text: "queued", abortSignal: stop.signal, start: false });
      const stopped = expect(turn).rejects.toThrow("stopped by user");
      stop.abort(APP_USER_STOP_REASON);
      expect(controlRequests(child, "interrupt")).toHaveLength(0);
      const [cancel] = controlRequests(child, "cancel_async_message");
      expect(cancel!.request).toEqual({ subtype: "cancel_async_message", message_uuid: uuid });
      const next = adapter.sendUserMessage(SESSION, { text: "after", files: [] });
      void next.catch(() => undefined);
      ack(child, cancel!, { cancelled: true });
      lifecycle(child, uuid, "cancelled");
      await stopped;
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
    } finally { await adapter.destroy(); }
  });

  it("interrupts a withdrawn prompt that still starts, and attributes none of its output", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child, uuid } = await startTurn(adapter, children, { text: "queued", abortSignal: stop.signal, start: false });
      const stopped = expect(turn).rejects.toThrow("stopped by user");
      stop.abort(APP_USER_STOP_REASON);
      ack(child, controlRequests(child, "cancel_async_message")[0]!, { cancelled: false });
      const events: EngineStreamEvent[] = [];
      const next = adapter.sendUserMessage(SESSION, { text: "after", files: [], onEngineEvent: (event) => { events.push(event); } });
      lifecycle(child, uuid, "started");
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "orphan text" }] } });
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true });
      lifecycle(child, uuid, "cancelled");
      await stopped;
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
      const prompt2 = written(child).filter((line) => line.type === "user")[1]!;
      lifecycle(child, prompt2.uuid!, "started");
      emit(child, { type: "result", subtype: "success", result: "fresh" });
      await expect(next).resolves.toMatchObject({ text: "fresh" });
      expect(JSON.stringify(events)).not.toContain("orphan text");
    } finally { await adapter.destroy(); }
  });

  it("denies permission requests of the stopped turn instead of borrowing the next turn's approver", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child, uuid } = await startTurn(adapter, children, { text: "long", abortSignal: stop.signal });
      const stopped = expect(turn).rejects.toThrow("stopped by user");
      stop.abort(APP_USER_STOP_REASON);
      const approver = vi.fn(async () => ({ behavior: "deny" as const }));
      const next = adapter.sendUserMessage(SESSION, { text: "next", files: [], onApprovalRequest: approver });
      void next.catch(() => undefined);
      emit(child, { type: "control_request", request_id: "perm-late", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "touch x" }, tool_use_id: "toolu_late" } });
      await waitFor(() => written(child).some((line) => line.type === "control_response" && line.response?.request_id === "perm-late"));
      const answer = written(child).find((line) => line.type === "control_response" && line.response?.request_id === "perm-late")!;
      expect(JSON.stringify(answer)).toContain("deny");
      expect(approver).not.toHaveBeenCalled();
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [] });
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true });
      lifecycle(child, uuid, "cancelled");
      await stopped;
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
    } finally { await adapter.destroy(); }
  });

  it("keeps a fenced turn away from the review machinery while a task notification is pending", async () => {
    const killSpy = spyKill();
    const { adapter, children } = setup(5_000);
    try {
      const stop = new AbortController();
      const owner: EngineStreamEvent[] = [];
      const { turn, child, uuid } = await startTurn(adapter, children, { text: "work", abortSignal: stop.signal, events: owner });
      emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "make", run_in_background: true } }] } });
      emit(child, { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "toolu_bg", task_type: "local_bash", description: "make", is_backgrounded: true });
      const steering = adapter.steerActiveTurn(SESSION, { text: "extra" });
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
      const steer = written(child).filter((line) => line.type === "user")[1]!;
      lifecycle(child, steer.uuid!, "queued");
      await steering;
      emit(child, { type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "toolu_bg", status: "completed", summary: "make" });
      const stopped = expect(turn).rejects.toThrow("stopped by user");
      stop.abort(APP_USER_STOP_REASON);
      expect(controlRequests(child, "interrupt")[0]!.request).toEqual({ subtype: "interrupt", for_user_message_uuids: [uuid, steer.uuid] });
      expect(controlRequests(child, "cancel_async_message").map((line) => line.request!.message_uuid)).toEqual([steer.uuid]);
      const next = adapter.sendUserMessage(SESSION, { text: "next", files: [] });
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [], turn: "stopped" });
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, user_message_uuid: uuid });
      lifecycle(child, uuid, "cancelled");
      // The withdrawal lost the race: the steer starts its own turn, so the
      // stop is not confirmed yet.
      lifecycle(child, steer.uuid!, "started");
      await waitFor(() => controlRequests(child, "interrupt").length === 2);
      emit(child, { type: "system", subtype: "init", capabilities: CAPABILITIES });
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "orphan text" }] } });
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, user_message_uuid: steer.uuid });
      lifecycle(child, steer.uuid!, "cancelled");
      await stopped;
      await settle();
      // The interrupt kept the uuid-less notification queued: Claude now
      // reviews b1, and only then may the next prompt be written.
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(2);
      emit(child, { type: "system", subtype: "init", capabilities: CAPABILITIES });
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "make finished" }] } });
      emit(child, { type: "result", subtype: "success", result: "make finished", origin: { kind: "task-notification" } });
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 3);
      const prompt = written(child).filter((line) => line.type === "user")[2]!;
      lifecycle(child, prompt.uuid!, "started");
      emit(child, { type: "result", subtype: "success", result: "clean", user_message_uuid: prompt.uuid });
      await expect(next).resolves.toMatchObject({ text: "clean" });
      expect(owner).toContainEqual(expect.objectContaining({ type: "task_notification", taskId: "b1", text: expect.stringContaining("make finished") }));
      expect(JSON.stringify(owner)).not.toContain("orphan text");
      expect(killSpy).not.toHaveBeenCalled();
    } finally { await adapter.destroy(); }
  });

  it("ignores a late interrupt failure once the stopped turn already settled", async () => {
    const killSpy = spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child, uuid } = await startTurn(adapter, children, { text: "work", abortSignal: stop.signal });
      const tooLate = expect(turn).rejects.toBeInstanceOf(EngineStopTooLateError);
      stop.abort(APP_USER_STOP_REASON);
      // The turn had already ended; its frames were still in the pipe.
      emit(child, { type: "result", subtype: "success", result: "done anyway", user_message_uuid: uuid });
      lifecycle(child, uuid, "completed");
      await tooLate;
      const next = adapter.sendUserMessage(SESSION, { text: "next", files: [] });
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
      const prompt = written(child).filter((line) => line.type === "user")[1]!;
      lifecycle(child, prompt.uuid!, "started");
      emit(child, { type: "control_response", response: { subtype: "error", request_id: controlRequests(child, "interrupt")[0]!.request_id, error: "late failure" } });
      await settle();
      expect(killSpy).not.toHaveBeenCalled();
      emit(child, { type: "result", subtype: "success", result: "next answer", user_message_uuid: prompt.uuid });
      await expect(next).resolves.toMatchObject({ text: "next answer" });
    } finally { await adapter.destroy(); }
  });

});

describe("Claude native steering", () => {
  it("opts ordinary sends into steering only for a live worker that advertised the lifecycle contract", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      expect(adapter.inFlightSendBehavior).toBe("steer");
      expect(adapter.supportsSessionSteering(SESSION)).toBe(false);
      const { turn, child } = await startTurn(adapter, children, { text: "work" });
      expect(adapter.supportsSessionSteering(SESSION)).toBe(true);
      await expect(adapter.listTasks(SESSION)).resolves.toMatchObject({ foregroundStopScope: "subagents" });
      // A later init without the contract (e.g. an older CLI after resume) revokes it.
      emit(child, { type: "system", subtype: "init" });
      expect(adapter.supportsSessionSteering(SESSION)).toBe(false);
      await expect(adapter.listTasks(SESSION)).resolves.toMatchObject({ foregroundStopScope: "all" });
      await expect(adapter.steerActiveTurn(SESSION, { text: "x", throwOnError: true })).rejects.toMatchObject({ reason: "unsupported" });
      emit(child, { type: "result", subtype: "success", result: "done" });
      await turn;
    } finally { await adapter.destroy(); }
  });

  it("rejects without writing when no started native turn can take the input", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      await expect(adapter.steerActiveTurn(SESSION, { text: "x", throwOnError: true })).rejects.toMatchObject({ reason: "stale" });
      const { turn, child, uuid } = await startTurn(adapter, children, { text: "work", start: false });
      await expect(adapter.steerActiveTurn(SESSION, { text: "x", throwOnError: true })).rejects.toEqual(new EngineSteeringRejectedError("queued"));
      expect(adapter.steerActiveTurn(SESSION, { text: "x" })).resolves.toBe(false);
      lifecycle(child, uuid, "started");
      emit(child, { type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1"] });
      await expect(adapter.steerActiveTurn(SESSION, { text: "x", throwOnError: true })).rejects.toMatchObject({ reason: "unsupported" });
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(1);
      emit(child, { type: "result", subtype: "success", result: "done" });
      await turn;
    } finally { await adapter.destroy(); }
  });

  it("writes the user's own text with a uuid and no priority, and reports admission", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children, { text: "work" });
      const steering = adapter.steerActiveTurn(SESSION, { text: "Also cover MANGO.", throwOnError: true });
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
      const steer = written(child).filter((line) => line.type === "user")[1]!;
      expect(steer).toEqual({ type: "user", uuid: expect.any(String), message: { role: "user", content: [{ type: "text", text: "Also cover MANGO." }] } });
      lifecycle(child, steer.uuid!, "queued");
      await expect(steering).resolves.toBe(true);
      // Folded at the next model request: one result settles the turn.
      lifecycle(child, steer.uuid!, "started");
      lifecycle(child, steer.uuid!, "completed");
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "MANGO" }] } });
      emit(child, { type: "result", subtype: "success", result: "MANGO" });
      await expect(turn).resolves.toMatchObject({ text: "MANGO" });
    } finally { await adapter.destroy(); }
  });

  it("continues the same host turn when a steer misses the fold and runs as Claude's next native turn", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const events: EngineStreamEvent[] = [];
      const { turn, child } = await startTurn(adapter, children, { text: "work", events });
      const steering = adapter.steerActiveTurn(SESSION, { text: "and then PAPAYA" });
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
      const steer = written(child).filter((line) => line.type === "user")[1]!;
      lifecycle(child, steer.uuid!, "queued");
      await expect(steering).resolves.toBe(true);
      emit(child, { type: "result", subtype: "success", result: "first part", usage: { input_tokens: 10, output_tokens: 2 } });
      let settled = false;
      void turn.then(() => { settled = true; }, () => { settled = true; });
      await settle();
      expect(settled).toBe(false);
      expect(events.filter((event) => event.type === "result")).toHaveLength(0);
      lifecycle(child, steer.uuid!, "started");
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "PAPAYA answer" }] } });
      emit(child, { type: "result", subtype: "success", result: "PAPAYA answer", usage: { input_tokens: 5, output_tokens: 3 } });
      const result = await turn;
      expect(result.text).toBe("first part\nPAPAYA answer");
      expect(result.usage).toMatchObject({ inputTokens: 15, outputTokens: 5 });
      expect(events.filter((event) => event.type === "result")).toEqual([expect.objectContaining({ text: "first part\nPAPAYA answer" })]);
      expect(events.some((event) => event.type === "assistant_text" && event.text.includes("PAPAYA answer"))).toBe(true);
    } finally { await adapter.destroy(); }
  });

  it("charges a held segment's cost once, on the next recorded result, when stopped during the hold", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const first = adapter.sendUserMessage("tarobot-cost", { text: "work", files: [], abortSignal: stop.signal });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      const child = children[0]!;
      const uuid = written(child)[0]!.uuid!;
      emit(child, { type: "system", subtype: "init", capabilities: CAPABILITIES });
      lifecycle(child, uuid, "started");
      const steering = adapter.steerActiveTurn(SESSION, { text: "extra" });
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
      const steer = written(child).filter((line) => line.type === "user")[1]!;
      lifecycle(child, steer.uuid!, "queued");
      await steering;
      emit(child, { type: "result", subtype: "success", result: "first", usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.5, user_message_uuid: uuid });
      await settle();
      stop.abort(APP_USER_STOP_REASON);
      const held = await first;
      expect(held.text).toMatch(/^first\n\n（运行中补充的 1 条消息未进入本轮/);
      expect(held.usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedTokens: undefined, costUsd: undefined });
      lifecycle(child, steer.uuid!, "cancelled");
      const second = adapter.sendUserMessage(SESSION, { text: "next", files: [] });
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 3);
      const prompt = written(child).filter((line) => line.type === "user")[2]!;
      lifecycle(child, prompt.uuid!, "started");
      emit(child, { type: "result", subtype: "success", result: "next", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.7, user_message_uuid: prompt.uuid });
      await expect(second).resolves.toMatchObject({ usage: { costUsd: 0.7 } });
    } finally { await adapter.destroy(); }
  });

  it("settles with a visible notice when a missed steer never runs", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children, { text: "work" });
      const steering = adapter.steerActiveTurn(SESSION, { text: "extra" });
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
      const steer = written(child).filter((line) => line.type === "user")[1]!;
      lifecycle(child, steer.uuid!, "queued");
      await steering;
      emit(child, { type: "result", subtype: "success", result: "done" });
      lifecycle(child, steer.uuid!, "discarded");
      await expect(turn).resolves.toMatchObject({ text: expect.stringMatching(/^done\n\n（运行中补充的 1 条消息未进入本轮/) });
    } finally { await adapter.destroy(); }
  });

  it("stopping while a missed steer waits keeps the finished first answer and withdraws only the addition", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child } = await startTurn(adapter, children, { text: "work", abortSignal: stop.signal });
      const outcomes: unknown[] = [];
      const steering = adapter.steerActiveTurn(SESSION, { text: "extra", onOutcome: (outcome) => { outcomes.push(outcome); } });
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
      const steer = written(child).filter((line) => line.type === "user")[1]!;
      lifecycle(child, steer.uuid!, "queued");
      await steering;
      emit(child, { type: "result", subtype: "success", result: "first" });
      await settle();
      stop.abort(APP_USER_STOP_REASON);
      // Observed drops are the caller's to restore; no notice is appended.
      await expect(turn).resolves.toMatchObject({ text: "first" });
      expect(outcomes).toEqual([{ status: "dropped", reason: "stopped" }]);
      expect(controlRequests(child, "interrupt")).toHaveLength(0);
      expect(controlRequests(child, "cancel_async_message").map((line) => line.request!.message_uuid)).toEqual([steer.uuid]);
      // The withdrawn addition fences the next prompt until it is terminal.
      const next = adapter.sendUserMessage(SESSION, { text: "next", files: [] });
      await settle();
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(2);
      lifecycle(child, steer.uuid!, "cancelled");
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 3);
      const prompt = written(child).filter((line) => line.type === "user")[2]!;
      lifecycle(child, prompt.uuid!, "started");
      emit(child, { type: "result", subtype: "success", result: "after", user_message_uuid: prompt.uuid });
      await expect(next).resolves.toMatchObject({ text: "after" });
    } finally { await adapter.destroy(); }
  });

  it("withdraws a failed turn's queued steer and stops it if it still starts", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children, { text: "work" });
      const steering = adapter.steerActiveTurn(SESSION, { text: "extra" });
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 2);
      const steer = written(child).filter((line) => line.type === "user")[1]!;
      lifecycle(child, steer.uuid!, "queued");
      await steering;
      const failed = expect(turn).rejects.toThrow("model failed");
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, result: "model failed" });
      await failed;
      expect(controlRequests(child, "cancel_async_message").map((line) => line.request!.message_uuid)).toEqual([steer.uuid]);
      // The next prompt waits: the withdrawn steer could still start on its own.
      const next = adapter.sendUserMessage(SESSION, { text: "next", files: [] });
      await settle();
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(2);
      lifecycle(child, steer.uuid!, "started");
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      expect(controlRequests(child, "interrupt")[0]!.request).toEqual({ subtype: "interrupt", for_user_message_uuids: [steer.uuid] });
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "orphan" }] } });
      emit(child, { type: "result", subtype: "success", result: "orphan answer", user_message_uuid: steer.uuid });
      lifecycle(child, steer.uuid!, "completed");
      await waitFor(() => written(child).filter((line) => line.type === "user").length === 3);
      const prompt = written(child).filter((line) => line.type === "user")[2]!;
      lifecycle(child, prompt.uuid!, "started");
      emit(child, { type: "result", subtype: "success", result: "clean" });
      await expect(next).resolves.toMatchObject({ text: "clean" });
    } finally { await adapter.destroy(); }
  });
});

describe("Claude unconfirmed stop recovery", () => {
  /** Starts a live turn under fake timers and leaves it running natively. */
  async function liveTurn(adapter: ClaudeStreamAdapter, children: FakeChild[], text: string, stop: AbortController, events?: EngineStreamEvent[]) {
    const turn = adapter.sendUserMessage(SESSION, { text, files: [], abortSignal: stop.signal, onEngineEvent: events ? (event) => { events.push(event); } : undefined });
    await vi.advanceTimersByTimeAsync(0);
    const child = children.at(-1)!;
    const uuid = written(child).filter((line) => line.type === "user").at(-1)!.uuid!;
    emit(child, { type: "system", subtype: "init", capabilities: CAPABILITIES });
    lifecycle(child, uuid, "started");
    return { turn, child, uuid };
  }
  /** Stops it and lets the confirmation window pass without any native frame. */
  async function leaveUnconfirmed(stop: AbortController, turn: Promise<unknown>) {
    const unconfirmed = expect(turn).rejects.toBeInstanceOf(EngineCancellationUnconfirmedError);
    stop.abort(APP_USER_STOP_REASON);
    await vi.advanceTimersByTimeAsync(10_001);
    await unconfirmed;
  }

  it("offers a recovery token only for an unconfirmed stop and force-stops exactly that worker", async () => {
    const killSpy = spyKill();
    vi.useFakeTimers();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const owner: EngineStreamEvent[] = [];
      const { turn, child } = await liveTurn(adapter, children, "long", stop, owner);
      emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "make", run_in_background: true } }] } });
      emit(child, { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "toolu_bg", task_type: "local_bash", description: "make", is_backgrounded: true });
      expect((await adapter.listTasks(SESSION)).recovery).toBeUndefined();
      const unconfirmed = expect(turn).rejects.toBeInstanceOf(EngineCancellationUnconfirmedError);
      stop.abort(APP_USER_STOP_REASON);
      await vi.advanceTimersByTimeAsync(9_000);
      // Still inside the confirmation window: nothing to recover yet.
      expect((await adapter.listTasks(SESSION)).recovery).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_001);
      await unconfirmed;
      const { recovery } = await adapter.listTasks(SESSION);
      expect(recovery).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/), reason: "stop_unconfirmed" });
      await expect(adapter.recoverSession(SESSION, { token: "not-the-token" })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      await expect(adapter.recoverSession("other-session", { token: recovery!.token })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      expect(killSpy).not.toHaveBeenCalled();
      // accepted = the forced stop was issued; the exit is observed separately.
      await expect(adapter.recoverSession(SESSION, { token: recovery!.token })).resolves.toEqual({ outcome: "accepted" });
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(undefined, { graceMs: APP_STOP_PROCESS_GRACE_MS });
      await expect(adapter.listTasks(SESSION)).resolves.toEqual({ supported: true, tasks: [] });
      await expect(adapter.recoverSession(SESSION, { token: recovery!.token })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      // The process exits: surviving background work is reported, not hidden.
      child.close(143);
      await vi.advanceTimersByTimeAsync(0);
      expect(owner).toContainEqual(expect.objectContaining({ type: "task_notification", taskId: "b1", status: "interrupted", reason: "engine_exit" }));
      // A replacement worker never honours the old token.
      const next = adapter.sendUserMessage(SESSION, { text: "again", files: [] });
      void next.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(2);
      await expect(adapter.recoverSession(SESSION, { token: recovery!.token })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      expect(killSpy).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); await adapter.destroy(); }
  });

  it("lets input waiting behind an unconfirmed stop continue on a fresh process after explicit recovery", async () => {
    const killSpy = spyKill();
    vi.useFakeTimers();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child } = await liveTurn(adapter, children, "long", stop);
      await leaveUnconfirmed(stop, turn);
      const next = adapter.sendUserMessage(SESSION, { text: "queued after stop", files: [] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(1);
      const { recovery } = await adapter.listTasks(SESSION);
      await expect(adapter.recoverSession(SESSION, { token: recovery!.token })).resolves.toEqual({ outcome: "accepted" });
      await vi.advanceTimersByTimeAsync(0);
      expect(killSpy).toHaveBeenCalledTimes(1);
      // Nothing reached the old process; the input runs once, on the new one.
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(1);
      expect(children).toHaveLength(2);
      const fresh = children[1]!;
      const prompt = written(fresh).filter((line) => line.type === "user");
      expect(prompt).toHaveLength(1);
      expect(prompt[0]!.message!.content[0]!.text).toContain("queued after stop");
      expect(adapter.isSessionInputBlocked(SESSION)).toBe(false);
      emit(fresh, { type: "system", subtype: "init", capabilities: CAPABILITIES });
      lifecycle(fresh, prompt[0]!.uuid!, "started");
      emit(fresh, { type: "result", subtype: "success", result: "fresh answer", user_message_uuid: prompt[0]!.uuid });
      await expect(next).resolves.toMatchObject({ text: "fresh answer" });
    } finally { vi.useRealTimers(); await adapter.destroy(); }
  });

  it("reports blocked input exactly while a stop fence is open, without creating a worker", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      expect(adapter.isSessionInputBlocked(SESSION)).toBe(false);
      expect(adapter.isSessionInputBlocked("never-seen")).toBe(false);
      expect(children).toHaveLength(0);
      const stop = new AbortController();
      const { turn, child, uuid } = await startTurn(adapter, children, { text: "work", abortSignal: stop.signal });
      expect(adapter.isSessionInputBlocked(SESSION)).toBe(false);
      const stopped = expect(turn).rejects.toThrow("stopped by user");
      stop.abort(APP_USER_STOP_REASON);
      // Confirmed or not, an open fence blocks new input.
      expect(adapter.isSessionInputBlocked(SESSION)).toBe(true);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [], turn: "stopped" });
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, user_message_uuid: uuid });
      expect(adapter.isSessionInputBlocked(SESSION)).toBe(true);
      lifecycle(child, uuid, "cancelled");
      await stopped;
      expect(adapter.isSessionInputBlocked(SESSION)).toBe(false);
      await adapter.forceStopSession(SESSION);
      expect(adapter.isSessionInputBlocked(SESSION)).toBe(false);
      expect(children).toHaveLength(1);
    } finally { await adapter.destroy(); }
  });

  it("rejects a token once Claude settles the fence late", async () => {
    const killSpy = spyKill();
    vi.useFakeTimers();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child, uuid } = await liveTurn(adapter, children, "long", stop);
      await leaveUnconfirmed(stop, turn);
      const { recovery } = await adapter.listTasks(SESSION);
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, user_message_uuid: uuid });
      lifecycle(child, uuid, "cancelled");
      expect((await adapter.listTasks(SESSION)).recovery).toBeUndefined();
      await expect(adapter.recoverSession(SESSION, { token: recovery!.token })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      expect(killSpy).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); await adapter.destroy(); }
  });

  it("never lets an earlier fence's token recover a later fence on the same worker", async () => {
    const killSpy = spyKill();
    vi.useFakeTimers();
    const { adapter, children } = setup();
    try {
      const firstStop = new AbortController();
      const first = await liveTurn(adapter, children, "one", firstStop);
      await leaveUnconfirmed(firstStop, first.turn);
      const old = (await adapter.listTasks(SESSION)).recovery!;
      emit(first.child, { type: "result", subtype: "error_during_execution", is_error: true, user_message_uuid: first.uuid });
      lifecycle(first.child, first.uuid, "cancelled");
      const secondStop = new AbortController();
      const second = await liveTurn(adapter, children, "two", secondStop);
      expect(second.child).toBe(first.child);
      await leaveUnconfirmed(secondStop, second.turn);
      const current = (await adapter.listTasks(SESSION)).recovery!;
      expect(current.token).not.toBe(old.token);
      await expect(adapter.recoverSession(SESSION, { token: old.token })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      expect(killSpy).not.toHaveBeenCalled();
      await expect(adapter.recoverSession(SESSION, { token: current.token })).resolves.toEqual({ outcome: "accepted" });
      expect(killSpy).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); await adapter.destroy(); }
  });
});

describe("Claude native task control", () => {
  it("lists tasks with opaque per-worker ids and stops one by native stop_task", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const events: EngineStreamEvent[] = [];
      const { turn, child } = await startTurn(adapter, children, { text: "work", events });
      emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { prompt: "p", subagent_type: "general-purpose", run_in_background: true } }] } });
      emit(child, { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "toolu_agent", task_type: "local_agent", subagent_type: "general-purpose", description: "Research", is_backgrounded: true });
      emit(child, { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", subagent_type: "general-purpose", description: "Research" }] });
      emit(child, { type: "system", subtype: "task_started", task_id: "a1-child", tool_use_id: "toolu_child", task_type: "local_bash", description: "Agent step", is_backgrounded: false, parent_task_id: "a1" });
      emit(child, { type: "system", subtype: "task_progress", task_id: "a1", description: "Research", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 }, summary: "Reading sources" });
      emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_fg", name: "Bash", input: { command: "npm test" } }] } });
      emit(child, { type: "system", subtype: "task_started", task_id: "f1", tool_use_id: "toolu_fg", task_type: "local_bash", description: "Long test run", is_backgrounded: false });
      const { tasks } = await adapter.listTasks(SESSION);
      expect(tasks).toEqual([
        expect.objectContaining({ label: "Research", kind: "subagent", mode: "background", status: "running", canStop: true, owner: "bound", progress: "Reading sources", updatedAt: expect.any(Number), startedAt: expect.any(Number) }),
        expect.objectContaining({ label: "Agent step", kind: "shell", mode: "foreground", owner: "bound", parentId: tasks[0]!.id }),
        expect.objectContaining({ label: "Long test run", kind: "shell", mode: "foreground", owner: "bound" }),
      ]);
      expect(tasks.map((task) => task.id)).not.toContain("a1");
      emit(child, { type: "system", subtype: "task_notification", task_id: "a1-child", status: "completed" });
      // Native ids and unknown tokens never reach Claude.
      await expect(adapter.stopTask(SESSION, { taskId: "a1" })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      await expect(adapter.stopTask("other-session", { taskId: tasks[0]!.id })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      expect(controlRequests(child, "stop_task")).toHaveLength(0);
      const stopping = adapter.stopTask(SESSION, { taskId: tasks[0]!.id });
      await waitFor(() => controlRequests(child, "stop_task").length === 1);
      const request = controlRequests(child, "stop_task")[0]!;
      expect(request.request).toEqual({ subtype: "stop_task", task_id: "a1" });
      expect(written(child).filter((line) => line.type === "user")).toHaveLength(1);
      emit(child, { type: "system", subtype: "task_updated", task_id: "a1", patch: { status: "killed" } });
      emit(child, { type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "toolu_agent", status: "stopped", summary: "Research" });
      ack(child, request);
      await expect(stopping).resolves.toEqual({ outcome: "accepted" });
      // An ended task stays visible with its final state but cannot be stopped again.
      await expect(adapter.stopTask(SESSION, { taskId: tasks[0]!.id })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      const after = await adapter.listTasks(SESSION);
      expect(after.tasks.find((task) => task.id === tasks[0]!.id)).toMatchObject({ status: "stopped", canStop: false });
      const rejected = adapter.stopTask(SESSION, { taskId: tasks[2]!.id });
      await waitFor(() => controlRequests(child, "stop_task").length === 2);
      emit(child, { type: "control_response", response: { subtype: "error", request_id: controlRequests(child, "stop_task")[1]!.request_id, error: "Task f1 is not running (status: completed)" } });
      await expect(rejected).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      emit(child, { type: "result", subtype: "success", result: "parent continued" });
      await expect(turn).resolves.toMatchObject({ text: "parent continued" });
      // The stopped agent's native state reached its owning turn, not engine_exit.
      expect(events).toContainEqual(expect.objectContaining({ type: "background_task_finished", taskId: "a1", status: "stopped", origin: "bound" }));
    } finally { await adapter.destroy(); }
  });

  it("never lets a token outlive its worker, even when a native task id is reused", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const first = await startTurn(adapter, children, { text: "work" });
      emit(first.child, { type: "system", subtype: "task_started", task_id: "same-id", task_type: "local_bash", description: "old", is_backgrounded: true });
      const [old] = (await adapter.listTasks(SESSION)).tasks;
      const stopped = expect(first.turn).rejects.toThrow("stopped by user");
      await adapter.forceStopSession(SESSION);
      await stopped;
      const next = adapter.sendUserMessage(SESSION, { text: "again", files: [] });
      void next.catch(() => undefined);
      await waitFor(() => children.length === 2 && children[1]!.stdin.lines.length === 1);
      emit(children[1]!, { type: "system", subtype: "task_started", task_id: "same-id", task_type: "local_bash", description: "new", is_backgrounded: true });
      await expect(adapter.stopTask(SESSION, { taskId: old!.id })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      expect(controlRequests(children[1]!, "stop_task")).toHaveLength(0);
      expect((await adapter.listTasks(SESSION)).tasks.map((task) => task.id)).not.toContain(old!.id);
    } finally { await adapter.destroy(); }
  });

  it("forceStopSession uses the bounded process cleanup", async () => {
    const killSpy = spyKill();
    const { adapter, children } = setup();
    try {
      const { turn } = await startTurn(adapter, children, { text: "work" });
      const stopped = expect(turn).rejects.toThrow("stopped by user");
      await expect(adapter.forceStopSession(SESSION)).resolves.toBe(true);
      await stopped;
      expect(killSpy).toHaveBeenCalledWith(undefined, { graceMs: APP_STOP_PROCESS_GRACE_MS });
      await expect(adapter.forceStopSession(SESSION)).resolves.toBe(false);
      await expect(adapter.listTasks(SESSION)).resolves.toEqual({ supported: true, tasks: [] });
    } finally { await adapter.destroy(); }
  });
});
