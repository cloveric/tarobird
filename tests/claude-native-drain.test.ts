import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { EngineCancellationUnconfirmedError, type EngineStreamEvent } from "../src/codex/adapter.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { APP_USER_STOP_REASON } from "../src/runtime/turn-cancellation.js";

class Child extends EventEmitter {
  lines: Array<Record<string, any>> = [];
  stdin = { write: (text: string, done?: (error?: Error | null) => void) => { this.lines.push(JSON.parse(text)); done?.(null); return true; } };
  stdout = new EventEmitter(); stderr = new EventEmitter();
}
const SESSION = "native-drain";
const capabilities = ["msg_lifecycle_v1", "interrupt_receipt_v1", "interrupt_cancel_queued_v1"];
const adapters: ClaudeStreamAdapter[] = [];
function setup(grace = 1000) {
  const children: Child[] = [];
  const adapter = new ClaudeStreamAdapter("claude", { taskNotificationStartGraceMs: grace,
    spawnFn: () => { const child = new Child(); children.push(child); return child; } });
  adapters.push(adapter); return { adapter, children };
}
const emit = (child: Child, frame: object) => child.stdout.emit("data", JSON.stringify({ session_id: SESSION, ...frame }) + "\n");
const lifecycle = (child: Child, uuid: string, state: string) => emit(child, { type: "command_lifecycle", command_uuid: uuid, state });
async function until(predicate: () => boolean) { await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3000, interval: 5 }); }
async function start(f: ReturnType<typeof setup>, events?: (event: EngineStreamEvent) => void | Promise<void>, signal?: AbortSignal) {
  const turn = f.adapter.sendUserMessage(SESSION, { text: "Check", files: [], onEngineEvent: events, abortSignal: signal });
  await until(() => !!f.children[0]?.lines.some(line => line.type === "user"));
  const child = f.children[0]!, uuid = child.lines.find(line => line.type === "user")!.uuid;
  emit(child, { type: "system", subtype: "init", capabilities }); lifecycle(child, uuid, "started");
  return { turn, child, uuid };
}
function task(child: Child, id = "agent") {
  emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: `tool-${id}`, name: "Agent", input: { description: id, run_in_background: true } }] } });
  emit(child, { type: "system", subtype: "task_started", task_id: id, tool_use_id: `tool-${id}`, task_type: "local_agent", description: id, is_backgrounded: true });
  emit(child, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `tool-${id}`, content: "Started" }] } });
}
const terminal = (child: Child, id = "agent") => emit(child, { type: "system", subtype: "task_notification", task_id: id, tool_use_id: `tool-${id}`, status: "completed" });
const review = (child: Child, id = "agent") => emit(child, { type: "result", result: `${id} reviewed`, task_id: id, status: "completed", origin: { kind: "task-notification" } });
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(adapters.splice(0).map(adapter => adapter.destroy())); });

function launch(child: Child, id = "late", extra: object = {}) {
  emit(child, { type: "assistant", ...extra, message: { content: [{ type: "tool_use", id: `tool-${id}`, name: "Agent", input: { description: id, run_in_background: true } }] } });
}
function launchResult(child: Child, id = "late", extra: object = {}) {
  emit(child, { type: "user", ...extra, message: { content: [{ type: "tool_result", tool_use_id: `tool-${id}`, content: "Async agent launched" }] } });
}
function launched(child: Child, id = "late", extra: object = {}) {
  emit(child, { type: "system", ...extra, subtype: "task_started", task_id: id, tool_use_id: `tool-${id}`, task_type: "local_agent", description: id, is_backgrounded: true });
}
function beginReview(child: Child, id: string) {
  terminal(child, id);
  emit(child, { type: "user", origin: { kind: "task-notification" },
    message: { content: `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>` } });
}

it("keeps a remembered launch busy when task_started follows the foreground result", async () => {
  const f = setup(), { turn, child } = await start(f);
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  launch(child); launchResult(child);
  // A long foreground summary must not spend the launch/start grace early.
  now += 10000;
  emit(child, { type: "result", result: "Started after a long summary" }); await turn;
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  now += 900; launched(child);
  now += 5000; expect(f.adapter.hasPendingNativeWork()).toBe(true);
  terminal(child, "late"); expect(f.adapter.hasPendingNativeWork()).toBe(true);
  review(child, "late"); await until(() => !f.adapter.hasPendingNativeWork());
});

it("expires a never-started explicit launch without extending the grace on drain reads", async () => {
  const f = setup(), { turn, child } = await start(f);
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  launch(child); launchResult(child);
  emit(child, { type: "result", result: "No start follows" }); await turn;
  for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
    expect(f.adapter.hasPendingNativeWork()).toBe(true); now += 100;
  }
  expect(f.adapter.hasPendingNativeWork()).toBe(false);
  // A duplicate launch result must not reopen or indefinitely renew the lease.
  launchResult(child); expect(f.adapter.hasPendingNativeWork()).toBe(false);
});

it("anchors a late first launch result once rather than the earliest tool call", async () => {
  const f = setup(), { turn, child } = await start(f);
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  launch(child);
  emit(child, { type: "result", result: "Launching" }); await turn;
  now += 900; launchResult(child);
  now += 900; expect(f.adapter.hasPendingNativeWork()).toBe(true);
  launchResult(child); now += 100;
  expect(f.adapter.hasPendingNativeWork()).toBe(false);
});

it("does not renew an expired older launch from a different foreground turn", async () => {
  const f = setup(), { turn, child } = await start(f);
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  launch(child); launchResult(child); emit(child, { type: "result", result: "First" }); await turn;
  now += 1000; expect(f.adapter.hasPendingNativeWork()).toBe(false);
  const next = f.adapter.sendUserMessage(SESSION, { text: "Unrelated turn", files: [] });
  await until(() => child.lines.filter(line => line.type === "user").length === 2);
  emit(child, { type: "result", result: "Second" }); await next;
  expect(f.adapter.hasPendingNativeWork()).toBe(false);
});

it("keeps a nested explicit launch owned through the parent reply and a late task_started", async () => {
  const f = setup(), { turn, child } = await start(f, () => undefined);
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "parent", name: "Agent", input: { description: "Parent" } }] } });
  const nested = { parent_tool_use_id: "parent" };
  launch(child, "nested", nested); launchResult(child, "nested", nested);
  emit(child, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "parent", content: "Parent finished" }] } });
  now += 10000;
  emit(child, { type: "result", result: "Parent summarized" }); await turn;
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  now += 900; launched(child, "nested", nested);
  now += 5000; expect(f.adapter.hasPendingNativeWork()).toBe(true);
  emit(child, { type: "system", ...nested, subtype: "task_notification", task_id: "nested", tool_use_id: "tool-nested", status: "completed" });
  await until(() => !f.adapter.hasPendingNativeWork());
});

it("does not invent a launch grace for foreground calls or unrelated launch acknowledgements", async () => {
  const f = setup(), { turn, child } = await start(f);
  emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-late", name: "Agent", input: { description: "Foreground" } }] } });
  launchResult(child); emit(child, { type: "result", result: "Foreground done" }); await turn;
  expect(f.adapter.hasPendingNativeWork()).toBe(false);
  launchResult(child, "unknown"); expect(f.adapter.hasPendingNativeWork()).toBe(false);
});

it.each(["starts", "never-starts"])("anchors a review's explicit launch after its long summary (%s)", async outcome => {
  const f = setup(), { turn, child } = await start(f);
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  task(child, "parent"); emit(child, { type: "result", result: "Parent started" }); await turn;
  terminal(child, "parent");
  emit(child, { type: "user", origin: { kind: "task-notification" },
    message: { content: "<task-notification><task-id>parent</task-id><status>completed</status></task-notification>" } });
  launch(child, "review-child"); launchResult(child, "review-child");
  now += 10000;
  review(child, "parent");
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  now += 900;
  if (outcome === "starts") {
    launched(child, "review-child"); now += 5000;
    expect(f.adapter.hasPendingNativeWork()).toBe(true);
    terminal(child, "review-child"); review(child, "review-child");
    await until(() => !f.adapter.hasPendingNativeWork());
  } else {
    // A replayed parent result must not reanchor the no-longer-owned review.
    review(child, "parent"); now += 100;
    expect(f.adapter.hasPendingNativeWork()).toBe(false);
    launchResult(child, "review-child"); review(child, "parent");
    expect(f.adapter.hasPendingNativeWork()).toBe(false);
  }
});

it.each(["foreground", "sibling-review"])("does not let a later review renew another launch from the same parent (%s)", async origin => {
  const f = setup(), { turn, child } = await start(f);
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  task(child, "A"); task(child, "B");
  if (origin === "foreground") { launch(child, "orphan"); launchResult(child, "orphan"); }
  emit(child, { type: "result", result: "Both started" }); await turn;
  beginReview(child, "A");
  if (origin === "sibling-review") { launch(child, "orphan"); launchResult(child, "orphan"); }
  review(child, "A"); now += 2000;
  beginReview(child, "B"); now += 2000; review(child, "B");
  expect(f.adapter.hasPendingNativeWork()).toBe(false);
});

it.each([false, true])("keeps a launch's review identity across repeated native notification frames (observer=%s)", async observe => {
  const f = setup(), { turn, child } = await start(f, observe ? () => undefined : undefined);
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  task(child, "A"); emit(child, { type: "result", result: "Started" }); await turn;
  beginReview(child, "A"); launch(child, "orphan"); launchResult(child, "orphan");
  now += 10000; terminal(child, "A"); review(child, "A");
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  now += 1000; await until(() => !f.adapter.hasPendingNativeWork());
});

it("does not reuse a monitor task's earlier review identity for a later review", async () => {
  const f = setup(), { turn, child } = await start(f);
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  task(child, "monitor"); emit(child, { type: "result", result: "Watching" }); await turn;
  const progress = () => emit(child, { type: "user", origin: { kind: "task-notification" },
    message: { content: "<task-notification><task-id>monitor</task-id><event>New progress</event></task-notification>" } });
  progress(); launch(child, "orphan"); launchResult(child, "orphan"); review(child, "monitor");
  now += 2000; progress(); review(child, "monitor");
  beginReview(child, "monitor"); review(child, "monitor");
  expect(f.adapter.hasPendingNativeWork()).toBe(false);
});

it("keeps native background tasks and their completion review busy after the foreground reply", async () => {
  const f = setup(), { turn, child } = await start(f);
  task(child); emit(child, { type: "result", result: "Started" }); await turn;
  expect((await f.adapter.listTasks(SESSION)).tasks[0]).toMatchObject({ status: "running", mode: "background" });
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  terminal(child);
  expect((await f.adapter.listTasks(SESSION)).tasks[0]).toMatchObject({ status: "done" });
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  emit(child, { type: "system", subtype: "init" });
  emit(child, { type: "assistant", message: { content: [{ type: "text", text: "Summarizing" }] } });
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  review(child); await until(() => !f.adapter.hasPendingNativeWork());
});

it("does not strand drain on a bounded completion-notification grace window without a review", async () => {
  const f = setup(25), { turn, child } = await start(f);
  task(child); emit(child, { type: "result", result: "Started" }); await turn;
  terminal(child); expect(f.adapter.hasPendingNativeWork()).toBe(true);
  await until(() => !f.adapter.hasPendingNativeWork());
});

it.each(["resolve", "reject", "throw"])("keeps a public result delivery busy until its observer settles (%s)", async outcome => {
  let release!: () => void, reject!: (error: Error) => void, delivering = false;
  const delivery = new Promise<void>((yes, no) => { release = yes; reject = no; });
  const f = setup();
  try {
    const { turn, child } = await start(f, event => {
      if (event.type !== "task_notification") return;
      delivering = true;
      if (outcome === "throw") throw Error("synthetic callback failure");
      return delivery;
    });
    task(child); emit(child, { type: "result", result: "Started" }); await turn;
    terminal(child); review(child); await until(() => delivering);
    if (outcome !== "throw") {
      expect(f.adapter.hasPendingNativeWork()).toBe(true);
      if (outcome === "resolve") release(); else reject(Error("synthetic delivery failure"));
    } else release();
    await until(() => !f.adapter.hasPendingNativeWork());
  } finally { release(); }
});

it("keeps overlapping result reviews and a waiting input owned until each is settled", async () => {
  const f = setup(), { turn, child } = await start(f);
  task(child, "A"); task(child, "B"); emit(child, { type: "result", result: "Started" }); await turn;
  terminal(child, "A"); emit(child, { type: "system", subtype: "init" });
  emit(child, { type: "user", task_id: "B", status: "completed", origin: { kind: "task-notification" },
    message: { content: "<task-notification>\n<task-id>B</task-id>\n<status>completed</status>\n</task-notification>" } });
  const next = f.adapter.sendUserMessage(SESSION, { text: "After reviews", files: [] });
  void next.catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(child.lines.filter(line => line.type === "user")).toHaveLength(1);
  review(child, "A"); expect(f.adapter.hasPendingNativeWork()).toBe(true);
  review(child, "B"); await until(() => child.lines.filter(line => line.type === "user").length === 2);
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  emit(child, { type: "result", result: "Next done" }); await next;
  await until(() => !f.adapter.hasPendingNativeWork());
});

it.each(["resolve", "reject"])("waits for a closed subagent scope's final card delivery (%s)", async outcome => {
  let release!: () => void, reject!: (error: Error) => void, delivering = false;
  const delivery = new Promise<void>((yes, no) => { release = yes; reject = no; });
  const f = setup();
  try {
    const { turn, child } = await start(f, event => {
      if (event.type === "scoped" && event.scope.kind === "subagent" && event.event.type === "scope_status" && event.event.status === "done") {
        delivering = true; return delivery;
      }
    });
    task(child); emit(child, { type: "result", result: "Started" }); await turn;
    terminal(child); review(child); await until(() => delivering);
    expect(f.adapter.hasPendingNativeWork()).toBe(true);
    if (outcome === "resolve") release(); else reject(Error("synthetic card failure"));
    await until(() => !f.adapter.hasPendingNativeWork());
  } finally { release(); }
});

it.each([
  ["done-before-close", "resolve"], ["done-before-close", "reject"],
  ["stopped-during-close", "resolve"], ["stopped-during-close", "reject"],
])("retains a final scoped card delivery after child close (%s, %s)", async (stage, outcome) => {
  let release!: () => void, reject!: (error: Error) => void, delivering = false;
  const delivery = new Promise<void>((yes, no) => { release = yes; reject = no; });
  const f = setup();
  try {
    const { turn, child } = await start(f, event => {
      if (event.type === "scoped" && event.scope.kind === "subagent" && event.event.type === "scope_status"
        && event.event.status === (stage === "done-before-close" ? "done" : "stopped")) {
        delivering = true; return delivery;
      }
    });
    task(child); emit(child, { type: "result", result: "Started" }); await turn;
    if (stage === "done-before-close") {
      terminal(child); review(child); await until(() => delivering);
    }
    child.emit("close", 0);
    await until(() => delivering);
    expect((await f.adapter.listTasks(SESSION)).tasks).toEqual([]);
    // Let unrelated task-notification/result observers settle. Only the
    // removed worker's scoped card observer still owns pending delivery.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.adapter.hasPendingNativeWork()).toBe(true);
    if (outcome === "resolve") release(); else reject(Error("synthetic closing card failure"));
    await until(() => !f.adapter.hasPendingNativeWork());
  } finally { release(); }
});

it("keeps a native continuation held between result and the queued message starting", async () => {
  const f = setup(), { turn, child, uuid } = await start(f);
  const steering = f.adapter.steerActiveTurn(SESSION, { text: "Additional work" });
  await until(() => child.lines.filter(line => line.type === "user").length === 2);
  const addition = child.lines.filter(line => line.type === "user")[1]!.uuid;
  lifecycle(child, addition, "queued"); await steering;
  emit(child, { type: "result", result: "First", user_message_uuid: uuid });
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  lifecycle(child, addition, "started");
  emit(child, { type: "result", result: "Second", user_message_uuid: addition }); await turn;
  await until(() => !f.adapter.hasPendingNativeWork());
});

it("keeps an unconfirmed native stop fenced after its foreground promise rejects", async () => {
  const f = setup(), stop = new AbortController(), { turn, child, uuid } = await start(f, undefined, stop.signal);
  const unconfirmed = expect(turn).rejects.toBeInstanceOf(EngineCancellationUnconfirmedError);
  vi.useFakeTimers();
  stop.abort(APP_USER_STOP_REASON);
  const request = child.lines.find(line => line.type === "control_request" && line.request.subtype === "interrupt")!;
  emit(child, { type: "control_response", response: { subtype: "error", request_id: request.request_id, error: "synthetic refusal" } });
  await vi.advanceTimersByTimeAsync(10001); await unconfirmed;
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  emit(child, { type: "result", subtype: "error_during_execution", is_error: true, user_message_uuid: uuid });
  lifecycle(child, uuid, "cancelled"); await vi.advanceTimersByTimeAsync(0);
  expect(f.adapter.hasPendingNativeWork()).toBe(false);
});

it("releases a task collected by TaskOutput without relying on a later native notice", async () => {
  const f = setup(), { turn, child } = await start(f);
  task(child);
  emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "collect", name: "TaskOutput", input: { task_id: "agent" } }] } });
  emit(child, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "collect", content: "<task_id>agent</task_id><status>completed</status>" }] } });
  emit(child, { type: "result", result: "Collected" }); await turn;
  await until(() => !f.adapter.hasPendingNativeWork());
  launchResult(child, "agent"); launched(child, "agent");
  expect(f.adapter.hasPendingNativeWork()).toBe(false);
});

it("ignores retired sessions after their public interruption delivery settles", async () => {
  const f = setup(), { turn, child } = await start(f);
  task(child); emit(child, { type: "result", result: "Started" }); await turn;
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  child.emit("close", 1);
  await until(() => !f.adapter.hasPendingNativeWork());
});

it("the Bridge shares native lifecycle across authenticated surfaces without changing unsupported engines", () => {
  const access = { load: vi.fn(), issuePairingCode: vi.fn() } as AccessStoreLike;
  const sessions = { getOrCreateSession: vi.fn(), bindSession: vi.fn() };
  const plain = { createSession: vi.fn(), sendUserMessage: vi.fn() };
  expect(new Bridge(access, sessions, plain).hasPendingNativeWork()).toBe(false);
  let busy = true;
  const bridge = new Bridge(access, sessions, { ...plain, hasPendingNativeWork: () => busy });
  expect(bridge.createAuthenticatedSurface().hasPendingNativeWork()).toBe(true);
  busy = false; expect(bridge.hasPendingNativeWork()).toBe(false);
  expect(sessions.getOrCreateSession).not.toHaveBeenCalled();
  expect(plain.sendUserMessage).not.toHaveBeenCalled();
});
