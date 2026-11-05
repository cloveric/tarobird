/** Host-originated Claude Code stream-json controls on one worker process.
 *
 * Verified against Claude Code 2.1.307 (bundled schema plus isolated probes,
 * docs/client/claude-native-control-2026-10-23.md): `system/init.capabilities`,
 * `command_lifecycle` for uuid-stamped user messages, `interrupt`,
 * `cancel_async_message`, `stop_task`, `task_started` / `task_updated` /
 * `task_notification` and the `background_tasks_changed` level signal.
 * Every caller gates on an advertised capability; nothing is inferred from a
 * version string. This module never writes user text.
 *
 * Claude Code 2.1.309 additionally advertises `interrupt_send_now_v1` (an
 * `interrupt` with `send_now:true` and a `message_uuid` answers
 * `send_now: delivering|stopped|nothing_waiting`; a CLI without it treats the
 * same request as a plain Stop) and `request_marker_lists_v1` (the uuids a
 * model request carries, on `system/status "requesting"` and on reply frames),
 * both verified with isolated 2.1.309 probes. */

export const CLAUDE_INTERRUPT_RECEIPT = "interrupt_receipt_v1";
export const CLAUDE_MESSAGE_LIFECYCLE = "msg_lifecycle_v1";
export const CLAUDE_INTERRUPT_SEND_NOW = "interrupt_send_now_v1";
export const CLAUDE_REQUEST_MARKER_LISTS = "request_marker_lists_v1";

const REQUEST_PREFIX = "tarobot-ctl-";
const MAX_TRACKED_COMMANDS = 256;
/** Live (written, queued or started) commands are never forgotten below this:
 * the soft bound only sheds settled history. */
const HARD_MAX_TRACKED_COMMANDS = 1024;
const MAX_TRACKED_TASKS = 512;
/** Matches the shared snapshot bound; the host trims live plus ended to it. */
const MAX_ENDED_TASKS = 128;

export type ClaudeCommandState = "written" | "queued" | "started" | "completed" | "cancelled" | "discarded" | "refused";
const COMMAND_STATES = new Set<ClaudeCommandState>(["queued", "started", "completed", "cancelled", "discarded", "refused"]);
const TERMINAL_COMMAND_STATES = new Set<ClaudeCommandState>(["completed", "cancelled", "discarded", "refused"]);
export const isTerminalCommandState = (state: ClaudeCommandState | undefined): boolean => state !== undefined && TERMINAL_COMMAND_STATES.has(state);

export type ClaudeNativeTaskKind = "bash" | "agent" | "workflow" | "monitor" | "other";
/** A live native task of this worker. `background:false` is a blocking call of
 * the running turn (a foreground subagent or a long foreground shell). */
export type ClaudeNativeTask = {
  taskId: string;
  kind: ClaudeNativeTaskKind;
  description: string;
  subagentType?: string;
  toolUseId?: string;
  parentTaskId?: string;
  background: boolean;
  status: "pending" | "running" | "paused";
  startedAt: number;
  updatedAt: number;
  /** `task_progress.summary`: the CLI's own one-line status, when it sends one. */
  progress?: string;
};
export type ClaudeEndedTask = Omit<ClaudeNativeTask, "status"> & { status: "done" | "error" | "stopped" | "unknown" };

function endedStatus(status: string): ClaudeEndedTask["status"] {
  if (status === "completed") return "done";
  if (status === "failed") return "error";
  if (status === "killed" || status === "stopped") return "stopped";
  return "unknown";
}

export class ClaudeControlError extends Error {
  constructor(readonly subtype: string, message: string, readonly kind: "rejected" | "timeout" | "closed") {
    super(message); this.name = "ClaudeControlError";
  }
}

type PendingRequest = { subtype: string; resolve: (response: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Waiter<T> = { accept: (value: T) => boolean; done: (value: T | undefined) => void };

function taskKind(taskType: unknown): ClaudeNativeTaskKind {
  if (typeof taskType !== "string") return "other";
  if (taskType === "local_bash") return "bash";
  if (/_agent$|teammate/.test(taskType)) return "agent";
  if (taskType === "local_workflow") return "workflow";
  if (taskType.startsWith("monitor")) return "monitor";
  return "other";
}

const text = (value: unknown, max = 500): string | undefined => typeof value === "string" && value ? value.slice(0, max) : undefined;

export class ClaudeNativeControl {
  private sequence = 0;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly commands = new Map<string, ClaudeCommandState>();
  private readonly commandWaiters = new Map<string, Set<Waiter<ClaudeCommandState>>>();
  private readonly tasks = new Map<string, ClaudeNativeTask>();
  private readonly ended = new Map<string, ClaudeEndedTask>();
  private readonly taskWaiters = new Map<string, Set<Waiter<string>>>();
  /** Undefined until the first `background_tasks_changed`; then REPLACE semantics. */
  private liveBackground: Set<string> | undefined;
  private capabilitySet = new Set<string>();
  private closedWith: Error | undefined;

  constructor(
    private readonly write: (payload: unknown) => void,
    private readonly onCommand?: (uuid: string, state: ClaudeCommandState) => void,
  ) {}

  has(capability: string): boolean { return this.capabilitySet.has(capability); }
  get closed(): boolean { return this.closedWith !== undefined; }

  /** Sends one control request and resolves with its success payload. */
  request(subtype: string, fields: Record<string, unknown> = {}, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    if (this.closedWith) return Promise.reject(new ClaudeControlError(subtype, this.closedWith.message, "closed"));
    const requestId = `${REQUEST_PREFIX}${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.requests.delete(requestId)) return;
        reject(new ClaudeControlError(subtype, `Claude ${subtype} was not acknowledged`, "timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.requests.set(requestId, { subtype, resolve, reject, timer });
      try { this.write({ type: "control_request", request_id: requestId, request: { ...fields, subtype } }); }
      catch (error) { clearTimeout(timer); this.requests.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  /** Registers a uuid this host wrote, before its first lifecycle frame. */
  track(uuid: string): void {
    this.commands.set(uuid, "written");
    while (this.commands.size > MAX_TRACKED_COMMANDS) {
      // Only settled history is shed: every written, queued or started command
      // stays attributable. Past the hard bound the oldest one goes as a last resort.
      const settled = [...this.commands].find(([, state]) => isTerminalCommandState(state))?.[0];
      const oldest = settled ?? (this.commands.size > HARD_MAX_TRACKED_COMMANDS ? this.commands.keys().next().value! : undefined);
      if (oldest === undefined) break;
      this.commands.delete(oldest);
      this.settleWaiters(this.commandWaiters, oldest, undefined);
    }
  }

  /** Whether one more uuid fits the soft bound without growing past it (new
   * native input is refused rather than admitted beyond it). */
  canTrack(): boolean {
    return this.commands.size < MAX_TRACKED_COMMANDS || [...this.commands.values()].some(isTerminalCommandState);
  }

  commandState(uuid: string): ClaudeCommandState | undefined { return this.commands.get(uuid); }

  /** Resolves with the first state in `states` (or a terminal one), or undefined on timeout/close. */
  waitForCommand(uuid: string, states: ReadonlySet<ClaudeCommandState>, timeoutMs: number): Promise<ClaudeCommandState | undefined> {
    const current = this.commands.get(uuid);
    if (current && (states.has(current) || isTerminalCommandState(current))) return Promise.resolve(current);
    if (this.closedWith || current === undefined) return Promise.resolve(undefined);
    return this.wait(this.commandWaiters, uuid, timeoutMs, (state) => states.has(state) || isTerminalCommandState(state));
  }

  forget(uuid: string): void { this.commands.delete(uuid); }

  listTasks(): ClaudeNativeTask[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  /** The most recent tasks that ended on this process, oldest first. */
  endedTasks(): ClaudeEndedTask[] {
    return [...this.ended.values()].map((task) => ({ ...task }));
  }

  task(taskId: string): ClaudeNativeTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  /** Resolves with the terminal status once the task has ended, or undefined on timeout/close. */
  waitForTaskEnd(taskId: string, timeoutMs: number): Promise<string | undefined> {
    if (!this.tasks.has(taskId) || this.closedWith) return Promise.resolve(undefined);
    return this.wait(this.taskWaiters, taskId, timeoutMs, () => true);
  }

  /** Consumes this host's control responses and lifecycle frames (true), and
   * observes task frames without consuming them (false). */
  handle(frame: Record<string, unknown>): boolean {
    if (frame.type === "control_response") return this.handleResponse(frame);
    if (frame.type === "command_lifecycle") { this.handleLifecycle(frame); return true; }
    if (frame.type !== "system") return false;
    switch (frame.subtype) {
      case "init":
        // Each init states the process's contract; a frame without it grants nothing.
        this.capabilitySet = new Set(Array.isArray(frame.capabilities) ? frame.capabilities.filter((item): item is string => typeof item === "string") : []);
        return false;
      case "task_started": this.taskStarted(frame); return false;
      case "task_updated": this.taskUpdated(frame); return false;
      case "task_progress": this.taskProgress(frame); return false;
      case "task_notification":
        if (typeof frame.task_id === "string") this.taskEnded(frame.task_id, typeof frame.status === "string" ? frame.status : "unknown");
        return false;
      case "background_tasks_changed": this.backgroundLevel(frame); return false;
      default: return false;
    }
  }

  close(error: Error): void {
    if (this.closedWith) return;
    this.closedWith = error;
    for (const [id, pending] of this.requests) {
      clearTimeout(pending.timer);
      pending.reject(new ClaudeControlError(pending.subtype, error.message, "closed"));
      this.requests.delete(id);
    }
    for (const uuid of [...this.commandWaiters.keys()]) this.settleWaiters(this.commandWaiters, uuid, undefined);
    for (const taskId of [...this.taskWaiters.keys()]) this.settleWaiters(this.taskWaiters, taskId, undefined);
    this.tasks.clear();
    this.ended.clear();
    this.liveBackground = undefined;
  }

  private handleResponse(frame: Record<string, unknown>): boolean {
    const response = frame.response && typeof frame.response === "object" ? frame.response as Record<string, unknown> : undefined;
    const requestId = typeof response?.request_id === "string" ? response.request_id : undefined;
    if (!requestId?.startsWith(REQUEST_PREFIX)) return false;
    const pending = this.requests.get(requestId);
    // A late response to a request that already timed out is still ours.
    if (!pending) return true;
    this.requests.delete(requestId);
    clearTimeout(pending.timer);
    if (response!.subtype === "success") {
      const payload = response!.response;
      pending.resolve(payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {});
    } else {
      pending.reject(new ClaudeControlError(pending.subtype, typeof response!.error === "string" ? response!.error.slice(0, 500) : `Claude rejected ${pending.subtype}`, "rejected"));
    }
    return true;
  }

  private handleLifecycle(frame: Record<string, unknown>): void {
    const uuid = typeof frame.command_uuid === "string" ? frame.command_uuid : undefined;
    const state = typeof frame.state === "string" && COMMAND_STATES.has(frame.state as ClaudeCommandState) ? frame.state as ClaudeCommandState : undefined;
    // Only uuids this host wrote are tracked; other clients' and internal commands are ignored.
    if (!uuid || !state || !this.commands.has(uuid)) return;
    const previous = this.commands.get(uuid);
    // Exactly one terminal state per worker process; a repeated 'queued'
    // (requeue after interrupt) may follow 'started' but never a terminal.
    if (isTerminalCommandState(previous)) return;
    this.commands.set(uuid, state);
    try { this.onCommand?.(uuid, state); } catch { /* observers cannot break the stream */ }
    this.settleWaiters(this.commandWaiters, uuid, state);
  }

  private taskStarted(frame: Record<string, unknown>): void {
    const taskId = text(frame.task_id, 200);
    if (!taskId) return;
    if (!this.tasks.has(taskId) && this.tasks.size >= MAX_TRACKED_TASKS) return;
    const previous = this.tasks.get(taskId);
    this.tasks.set(taskId, {
      taskId,
      kind: frame.task_type === undefined && previous ? previous.kind : taskKind(frame.task_type),
      description: text(frame.description) ?? previous?.description ?? "",
      ...(text(frame.subagent_type, 120) ? { subagentType: text(frame.subagent_type, 120) } : previous?.subagentType ? { subagentType: previous.subagentType } : {}),
      ...(text(frame.tool_use_id, 200) ? { toolUseId: text(frame.tool_use_id, 200) } : previous?.toolUseId ? { toolUseId: previous.toolUseId } : {}),
      ...(text(frame.parent_task_id, 200) ? { parentTaskId: text(frame.parent_task_id, 200) } : {}),
      background: frame.is_backgrounded === true || previous?.background === true || this.liveBackground?.has(taskId) === true,
      status: "running",
      startedAt: previous?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
      ...(previous?.progress ? { progress: previous.progress } : {}),
    });
    this.ended.delete(taskId);
  }

  private taskProgress(frame: Record<string, unknown>): void {
    const task = this.tasks.get(text(frame.task_id, 200) ?? "");
    if (!task) return;
    task.updatedAt = Date.now();
    const summary = text(frame.summary, 300);
    if (summary) task.progress = summary;
  }

  private taskUpdated(frame: Record<string, unknown>): void {
    const taskId = text(frame.task_id, 200);
    const patch = frame.patch && typeof frame.patch === "object" ? frame.patch as Record<string, unknown> : undefined;
    if (!taskId || !patch) return;
    const status = typeof patch.status === "string" ? patch.status : undefined;
    if (status === "completed" || status === "failed" || status === "killed") { this.taskEnded(taskId, status); return; }
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.updatedAt = Date.now();
    if (status === "pending" || status === "running" || status === "paused") task.status = status;
    if (patch.is_backgrounded === true) task.background = true;
    const description = text(patch.description);
    if (description) task.description = description;
  }

  private backgroundLevel(frame: Record<string, unknown>): void {
    if (!Array.isArray(frame.tasks)) return;
    const level = new Set<string>();
    for (const item of frame.tasks) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const taskId = text(entry.task_id, 200);
      if (!taskId || level.size >= MAX_TRACKED_TASKS) continue;
      level.add(taskId);
      const task = this.tasks.get(taskId);
      if (task) { task.background = true; continue; }
      if (this.tasks.size >= MAX_TRACKED_TASKS || this.ended.has(taskId)) continue;
      const now = Date.now();
      this.tasks.set(taskId, {
        taskId, kind: taskKind(entry.task_type), description: text(entry.description) ?? "",
        ...(text(entry.subagent_type, 120) ? { subagentType: text(entry.subagent_type, 120) } : {}),
        ...(text(entry.parent_task_id, 200) ? { parentTaskId: text(entry.parent_task_id, 200) } : {}),
        background: true, status: "running", startedAt: now, updatedAt: now,
      });
    }
    // REPLACE: a background task missing from the level has ended even if its
    // edge bookend was missed. Foreground tasks are not part of this level.
    for (const [taskId, task] of this.tasks) if (task.background && !level.has(taskId)) this.taskEnded(taskId, "ended");
    this.liveBackground = level;
  }

  private taskEnded(taskId: string, status: string): void {
    const task = this.tasks.get(taskId);
    const final = endedStatus(status);
    if (task) {
      this.tasks.delete(taskId);
      const { status: _live, ...rest } = task;
      this.ended.set(taskId, { ...rest, status: final, updatedAt: Date.now() });
      while (this.ended.size > MAX_ENDED_TASKS) this.ended.delete(this.ended.keys().next().value!);
    } else {
      // The level can drop a task before its own bookend names the outcome.
      const known = this.ended.get(taskId);
      if (known && known.status === "unknown" && final !== "unknown") { known.status = final; known.updatedAt = Date.now(); }
    }
    this.liveBackground?.delete(taskId);
    this.settleWaiters(this.taskWaiters, taskId, status);
  }

  private wait<T>(registry: Map<string, Set<Waiter<T>>>, key: string, timeoutMs: number, accept: (value: T) => boolean): Promise<T | undefined> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter<T> = {
        accept,
        done: (value) => {
          if (timer) clearTimeout(timer);
          registry.get(key)?.delete(waiter);
          if (registry.get(key)?.size === 0) registry.delete(key);
          resolve(value);
        },
      };
      const set = registry.get(key) ?? new Set();
      set.add(waiter);
      registry.set(key, set);
      timer = setTimeout(() => waiter.done(undefined), timeoutMs);
      timer.unref?.();
    });
  }

  private settleWaiters<T>(registry: Map<string, Set<Waiter<T>>>, key: string, value: T | undefined): void {
    for (const waiter of [...registry.get(key) ?? []]) {
      if (value === undefined || waiter.accept(value)) waiter.done(value);
    }
  }

}
