import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { EngineNativeInputUnsentError, type AppPlatformTools, type CodexUserMessageInput, type EngineStreamEvent } from "../src/codex/adapter.js";
import type { NativeInputProgress } from "../src/client-protocol/native-input.js";
import { APP_USER_STOP_REASON } from "../src/runtime/turn-cancellation.js";
import * as processTree from "../src/codex/process-tree.js";

// Replay ordering from six isolated 2.1.309 probes, including the review result
// whose origin remains task-notification even after a human command takes over.
const CAPS = ["msg_lifecycle_v1", "request_marker_lists_v1", "interrupt_receipt_v1", "interrupt_send_now_v1"];
const SESSION = "review-session", OWNER = "conversation-a";
class Child extends EventEmitter {
  lines: any[] = [];
  stdout = new EventEmitter(); stderr = new EventEmitter();
  stdin = { write: (line: string, callback?: (error?: Error) => void) => { this.lines.push(JSON.parse(line)); callback?.(); return true; } };
  frame(value: object) { this.stdout.emit("data", JSON.stringify({ session_id: SESSION, ...value }) + "\n"); }
  life(uuid: string, state: string) { this.frame({ type: "command_lifecycle", command_uuid: uuid, state }); }
  get prompts() { return this.lines.filter(line => line.type === "user"); }
  controls(name: string) { return this.lines.filter(line => line.type === "control_request" && line.request.subtype === name); }
  ack(request: any, response: object) { this.frame({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response } }); }
  reply(text: string, uuid?: string) { this.frame({ type: "assistant", ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}), message: { model: "claude-sonnet-5-5", content: [{ type: "text", text }] } }); }
  result(text: string, uuid?: string, review = false, error = false) { this.frame({ type: "result", subtype: error ? "error_during_execution" : "success", is_error: error, result: text, ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}), ...(review ? { origin: { kind: "task-notification" } } : {}) }); }
  init(caps = CAPS) { this.frame({ type: "system", subtype: "init", capabilities: caps }); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate: () => boolean) { for (let n = 0; n < 400; n++) { if (predicate()) return; await tick(); } throw new Error("fixture did not reach expected frame"); }
const adapters: ClaudeStreamAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(a => a.destroy())); vi.restoreAllMocks(); });
async function fixture(options: { caps?: string[]; grace?: boolean; timeout?: number; tools?: AppPlatformTools; secondTask?: boolean } = {}) {
  const kill = vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve());
  const child = new Child();
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn: () => child, taskNotificationStartGraceMs: 10_000, turnInactivityTimeoutMs: options.timeout ?? null }); adapters.push(adapter);
  const old: EngineStreamEvent[] = [], current: EngineStreamEvent[] = [], progress: NativeInputProgress[] = [];
  const oldApproval = vi.fn(async () => ({ behavior: "deny" as const })), newApproval = vi.fn(async () => ({ behavior: "deny" as const }));
  const first = adapter.sendUserMessage(SESSION, { text: "Start background", files: [], appPlatformTools: options.tools, inputOwnerKey: OWNER, onEngineEvent: e => { old.push(e); }, onApprovalRequest: oldApproval });
  if (options.tools) {
    await until(() => child.controls("initialize").length === 1);
    child.ack(child.controls("initialize")[0], {});
    child.frame({ type: "control_request", request_id: "list", request: { subtype: "mcp_message", server_name: "tarocub_app", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } } });
  }
  await until(() => child.prompts.length === 1); child.init(options.caps); const p = child.prompts[0].uuid;
  child.life(p, "queued"); child.life(p, "started");
  child.frame({ type: "assistant", message: { content: [{ type: "tool_use", id: "launch", name: "Bash", input: { command: "work", run_in_background: true } }] } });
  child.frame({ type: "system", subtype: "task_started", task_id: "task-bg", tool_use_id: "launch", task_type: "local_bash" });
  if (options.secondTask) {
    child.frame({ type: "assistant", message: { content: [{ type: "tool_use", id: "launch-2", name: "Bash", input: { command: "more", run_in_background: true } }] } });
    child.frame({ type: "system", subtype: "task_started", task_id: "task-bg-2", tool_use_id: "launch-2", task_type: "local_bash" });
  }
  child.result("LAUNCHED", p); child.life(p, "completed"); await first;
  child.frame({ type: "system", subtype: "task_notification", task_id: "task-bg", tool_use_id: "launch", status: "completed", summary: "Background test" });
  if (!options.grace) { child.init(options.caps); child.reply("Review before input."); }
  const send = async (extra: Partial<CodexUserMessageInput> = {}) => {
    const count = child.prompts.length;
    const turn = adapter.sendUserMessage(SESSION, { text: "Also PINEAPPLE", files: [], inputOwnerKey: OWNER, reviewAdmission: "native", nativeInput: { id: "input-a", onProgress: p => { progress.push(p); } }, onEngineEvent: e => { current.push(e); }, onApprovalRequest: newApproval, ...extra });
    void turn.catch(() => undefined);
    await until(() => child.prompts.length > count);
    return { turn, uuid: child.prompts.at(-1).uuid as string };
  };
  return { child, adapter, old, current, progress, send, kill, oldApproval, newApproval };
}
function modelStarts(child: Child, uuid: string) {
  child.frame({ type: "system", subtype: "status", status: "requesting", user_message_uuids: [uuid] });
  child.frame({ type: "stream_event", user_message_uuid: uuid, event: { type: "message_start", message: { id: "answer", model: "claude-sonnet-5-5" } } });
}

describe("ordinary input during a Claude background review", () => {
  it.each([true, false])("releases a confirmed stop after completed lifecycle, then accepts the next prompt (started frame=%s)", async started => {
    const f = await fixture(), abort = new AbortController();
    const { turn, uuid } = await f.send({ abortSignal: abort.signal });
    f.child.life(uuid, "queued"); if (started) f.child.life(uuid, "started");
    modelStarts(f.child, uuid); f.child.life(uuid, "completed");
    f.child.frame({ type: "assistant", message: { content: [{ type: "tool_use", id: "long", name: "Bash", input: { command: "work" } }] } });
    abort.abort(APP_USER_STOP_REASON);
    await until(() => f.child.controls("interrupt").length === 1);
    f.child.ack(f.child.controls("interrupt")[0], { turn: "stopped", still_queued: [] });
    f.child.result("", uuid, true, true); await tick();
    expect(f.adapter.isSessionInputBlocked(SESSION)).toBe(false);
    await expect(turn).rejects.toThrow("stopped by user");
    const next = f.adapter.sendUserMessage(SESSION, { text: "Next prompt", files: [], inputOwnerKey: OWNER });
    await until(() => f.child.prompts.length === 3);
    const nextUuid = f.child.prompts[2].uuid;
    f.child.life(nextUuid, "started"); f.child.result("NEXT_OK", nextUuid); f.child.life(nextUuid, "completed");
    await expect(next).resolves.toMatchObject({ text: "NEXT_OK" });
    expect(f.kill).not.toHaveBeenCalled();
  });
  it.each([undefined, new Error("card action superseded input")])("withdraws an unconsumed review input on non-App abort without killing the review (%s)", async reason => {
    const f = await fixture(), abort = new AbortController();
    const { turn, uuid } = await f.send({ abortSignal: abort.signal });
    f.child.life(uuid, "queued"); abort.abort(reason); await tick();
    expect(f.kill).not.toHaveBeenCalled();
    await until(() => f.child.controls("cancel_async_message").length === 1);
    expect(f.child.controls("interrupt")).toEqual([]);
    f.child.ack(f.child.controls("cancel_async_message")[0], { cancelled: true }); f.child.life(uuid, "cancelled");
    await expect(turn).rejects.toThrow("stopped by user");
    expect(f.adapter.isSessionInputBlocked(SESSION)).toBe(false);
    expect(f.adapter.backgroundInputTarget(SESSION, OWNER)).toBeTruthy();
    f.child.reply("Review survived"); f.child.result("Review survived", undefined, true); await tick();
    expect(JSON.stringify(f.old)).toContain("Review survived");
    expect(JSON.stringify(f.current)).not.toContain("Review survived");
    expect(f.kill).not.toHaveBeenCalled();
  });
  it("queues once, then adopts at started; old review, new answer and model receipt stay distinct", async () => {
    const f = await fixture();
    const target = f.adapter.backgroundInputTarget(SESSION, OWNER);
    expect(target).toBeTruthy(); expect(f.adapter.backgroundInputTarget(SESSION, OWNER)).toBe(target);
    expect(f.adapter.backgroundInputTarget(SESSION, "different-conversation")).toBeUndefined();
    const { turn, uuid } = await f.send();
    expect(f.child.prompts.at(-1)).not.toHaveProperty("origin"); expect(f.child.prompts.at(-1)).not.toHaveProperty("priority");
    f.child.life(uuid, "queued"); f.child.reply("Still old review.");
    expect(f.progress).toEqual([{ state: "queued" }]); expect(f.current.filter(e => e.type === "assistant_text")).toEqual([]);
    f.child.life(uuid, "started");
    expect(f.progress.map(p => p.state)).toEqual(["queued", "dequeued"]);
    modelStarts(f.child, uuid); f.child.reply("PINEAPPLE", uuid);
    f.child.life(uuid, "completed"); f.child.result("PINEAPPLE", uuid, true);
    await expect(turn).resolves.toMatchObject({ text: "PINEAPPLE" });
    expect(f.progress.map(p => p.state)).toEqual(["queued", "dequeued", "received"]);
    expect(f.old.filter(e => e.type === "task_notification").some(e => "text" in e && e.text.includes("Still old review."))).toBe(true);
    expect(JSON.stringify(f.old)).not.toContain("PINEAPPLE"); expect(JSON.stringify(f.current)).not.toContain("Still old review.");
    expect(f.child.prompts).toHaveLength(2); expect(f.kill).not.toHaveBeenCalled();
  });
  it("does not resolve a queued prompt with the old result when it misses the fold", async () => {
    const f = await fixture(); const { turn, uuid } = await f.send(); let finished = false; void turn.then(() => { finished = true; });
    f.child.life(uuid, "queued"); f.child.result("Original review result", undefined, true); await tick();
    expect(finished).toBe(false); expect(JSON.stringify(f.current)).not.toContain("Original review result");
    f.child.life(uuid, "started"); f.child.init(); modelStarts(f.child, uuid); f.child.reply("MANGO", uuid); f.child.result("MANGO", uuid); f.child.life(uuid, "completed");
    await expect(turn).resolves.toMatchObject({ text: "MANGO" }); expect(f.progress.at(-1)?.state).toBe("received");
  });
  it("identifies the review init even when the human command was queued first", async () => {
    const f = await fixture({ grace: true }); const { turn, uuid } = await f.send(); f.child.life(uuid, "queued");
    f.child.init(); f.child.reply("Grace-window review.");
    expect(JSON.stringify(f.current)).not.toContain("Grace-window review.");
    f.child.life(uuid, "started"); modelStarts(f.child, uuid); f.child.result("PINEAPPLE", uuid, true);
    await expect(turn).resolves.toMatchObject({ text: "PINEAPPLE" }); expect(JSON.stringify(f.old)).toContain("Grace-window review.");
  });
  it("uses the old approval callback before consumption and the new callback afterwards", async () => {
    const f = await fixture(); const { turn, uuid } = await f.send(); f.child.life(uuid, "queued");
    const ask = (request_id: string) => f.child.frame({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [] } } });
    ask("before"); await tick(); expect(f.oldApproval).toHaveBeenCalledTimes(1); expect(f.newApproval).not.toHaveBeenCalled();
    f.child.life(uuid, "started"); ask("after"); await tick(); expect(f.newApproval).toHaveBeenCalledTimes(1);
    f.child.result("Done", uuid, true); await turn;
  });
  it.each([true, false])("withdraws a queued prompt only after cancelled:true without interrupting its review (lifecycle first: %s)", async lifecycleFirst => {
    const f = await fixture(); const { turn, uuid } = await f.send(); f.child.life(uuid, "queued");
    const cancelled = f.adapter.controlNativeInput(SESSION, { inputId: "input-a", action: "cancel" });
    await until(() => f.child.controls("cancel_async_message").length === 1);
    expect(f.progress.at(-1)?.state).toBe("queued");
    if (lifecycleFirst) f.child.life(uuid, "cancelled");
    f.child.ack(f.child.controls("cancel_async_message")[0], { cancelled: true });
    await expect(cancelled).resolves.toMatchObject({ outcome: "accepted", result: "cancelled" });
    await expect(turn).rejects.toMatchObject({ reason: "withdrawn" }); expect(f.progress.at(-1)?.state).toBe("cancelled");
    f.child.reply("Review still runs"); f.child.result("Review still runs", undefined, true);
    expect(f.child.controls("interrupt")).toEqual([]); expect(f.kill).not.toHaveBeenCalled();
  });
  it("releases a stopped adopted turn when cancelled precedes its review-origin result", async () => {
    const f = await fixture(); const abort = new AbortController(); const { turn, uuid } = await f.send({ abortSignal: abort.signal });
    f.child.life(uuid, "queued"); f.child.life(uuid, "started"); modelStarts(f.child, uuid); abort.abort(APP_USER_STOP_REASON);
    await until(() => f.child.controls("interrupt").length === 1);
    f.child.ack(f.child.controls("interrupt")[0], { turn: "stopped", still_queued: [] });
    f.child.life(uuid, "cancelled"); f.child.result("", uuid, true, true);
    await expect(turn).rejects.toThrow("stopped by user"); expect(f.adapter.isSessionInputBlocked(SESSION)).toBe(false); expect(f.kill).not.toHaveBeenCalled();
  });
  it("keeps a consumed prompt running when cancellation is rejected", async () => {
    const f = await fixture(); const { turn, uuid } = await f.send(); f.child.life(uuid, "queued");
    const cancelled = f.adapter.controlNativeInput(SESSION, { inputId: "input-a", action: "cancel" });
    await until(() => f.child.controls("cancel_async_message").length === 1);
    f.child.life(uuid, "started"); f.child.ack(f.child.controls("cancel_async_message")[0], { cancelled: false });
    await expect(cancelled).resolves.toMatchObject({ outcome: "rejected", result: "not_queued" });
    modelStarts(f.child, uuid); f.child.result("Still answers", uuid, true);
    await expect(turn).resolves.toMatchObject({ text: "Still answers" });
    expect(f.progress.some(p => p.state === "cancelled")).toBe(false); expect(f.kill).not.toHaveBeenCalled();
  });
  it("does not replace a live review when turn instructions change", async () => {
    const f = await fixture(); const { turn, uuid } = await f.send({ instructions: "New instructions" });
    expect(f.kill).not.toHaveBeenCalled(); f.child.life(uuid, "started"); f.child.result("Done", uuid, true); await turn;
  });
  it("keeps send-now unavailable for later inputs on an adopted review turn", async () => {
    const f = await fixture(); const { turn, uuid } = await f.send();
    f.child.life(uuid, "queued"); f.child.life(uuid, "started"); modelStarts(f.child, uuid);
    const secondary = f.adapter.steerActiveTurn(SESSION, { text: "One more", nativeInput: { id: "input-b", onProgress: () => undefined } });
    await until(() => f.child.prompts.length === 3);
    const next = f.child.prompts[2].uuid;
    f.child.life(next, "queued"); await expect(secondary).resolves.toBe(true);
    await expect(f.adapter.controlNativeInput(SESSION, { inputId: "input-b", action: "send-now" })).resolves.toMatchObject({ outcome: "rejected" });
    expect(f.child.controls("interrupt")).toEqual([]); expect(f.kill).not.toHaveBeenCalled();
    f.child.life(next, "started"); f.child.life(next, "completed");
    f.child.result("Done", uuid, true); await turn;
  });
  it("hands native App tool calls to the new request only after its command starts", async () => {
    const makeTools = (): AppPlatformTools => ({ definitions: [{ name: "app_send_file", description: "Send", inputSchema: { type: "object" } }], instructions: "File tools", isRegistered: vi.fn(async () => false), register: vi.fn(async () => undefined), call: vi.fn(async () => ({ text: "delivered" })) });
    const oldTools = makeTools(), newTools = makeTools(); const f = await fixture({ tools: oldTools });
    const { turn, uuid } = await f.send({ appPlatformTools: newTools }); f.child.life(uuid, "queued");
    const call = (id: string) => {
      f.child.frame({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__tarocub_app__app_send_file", input: { path: "x" } }] } });
      f.child.frame({ type: "control_request", request_id: id, request: { subtype: "mcp_message", server_name: "tarocub_app", message: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "app_send_file", arguments: { path: "x" }, _meta: { "claudecode/toolUseId": id } } } } });
    };
    call("review"); await until(() => f.child.lines.some(x => x.response?.request_id === "review"));
    expect(oldTools.call).not.toHaveBeenCalled(); expect(newTools.call).not.toHaveBeenCalled();
    f.child.life(uuid, "started"); call("current"); await until(() => vi.mocked(newTools.call).mock.calls.length === 1);
    expect(oldTools.call).not.toHaveBeenCalled(); f.child.result("Delivered", uuid, true); await turn;
  });
  it("fences a stop racing with native consumption without killing the review process", async () => {
    const f = await fixture(); const abort = new AbortController(); const { turn, uuid } = await f.send({ abortSignal: abort.signal });
    f.child.life(uuid, "queued"); abort.abort(APP_USER_STOP_REASON);
    await until(() => f.child.controls("cancel_async_message").length === 1);
    f.child.life(uuid, "started"); f.child.ack(f.child.controls("cancel_async_message")[0], { cancelled: false });
    await until(() => f.child.controls("interrupt").length === 1);
    f.child.ack(f.child.controls("interrupt")[0], { turn: "stopped", still_queued: [] });
    f.child.life(uuid, "cancelled"); f.child.result("", uuid, true, true);
    await expect(turn).rejects.toThrow("stopped by user"); expect(f.adapter.isSessionInputBlocked(SESSION)).toBe(false); expect(f.kill).not.toHaveBeenCalled();
  });
  it.each(["refused", "discarded", "cancelled"])("settles a terminal %s command that never started without killing its review", async state => {
    const f = await fixture(); const { turn, uuid } = await f.send(); f.child.life(uuid, "queued");
    f.child.life(uuid, state); await expect(turn).rejects.toThrow();
    expect(f.adapter.backgroundInputTarget(SESSION, OWNER)).toBeTruthy();
    f.child.reply("Original continues"); f.child.result("Original continues", undefined, true);
    expect(f.kill).not.toHaveBeenCalled(); expect(f.child.controls("interrupt")).toEqual([]);
  });
  it("does not adopt a queued review that has not begun or make it wait forever", async () => {
    const f = await fixture({ secondTask: true });
    f.child.frame({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>task-bg-2</task-id><status>completed</status><summary>second</summary></task-notification>' } });
    f.child.result("First review finished", undefined, true);
    const { turn, uuid } = await f.send(); f.child.life(uuid, "started"); f.child.result("Human first", uuid); await turn;
    expect(JSON.stringify(f.old)).not.toContain("Human first");
    vi.useFakeTimers();
    try {
      const next = f.adapter.sendUserMessage(SESSION, { text: "After review grace", files: [], inputOwnerKey: OWNER }); void next.catch(() => undefined);
      for (let n=0; n<25; n++) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_100);
      expect(f.child.prompts).toHaveLength(3);
      f.child.result("Normal queue continues", f.child.prompts[2].uuid); await expect(next).resolves.toMatchObject({ text: "Normal queue continues" });
    } finally { vi.useRealTimers(); }
  });
  it.each(["request", "assistant", "result", "completed"])("hands over on native %s evidence even if started was omitted", async evidence => {
    const f = await fixture(); const { turn, uuid } = await f.send(); f.child.life(uuid, "queued");
    if (evidence === "request") modelStarts(f.child, uuid);
    if (evidence === "assistant") f.child.reply("Own reply", uuid);
    if (evidence === "completed") f.child.life(uuid, "completed");
    f.child.result("Own reply", uuid, true);
    await expect(turn).resolves.toMatchObject({ text: "Own reply" });
    expect(JSON.stringify(f.old)).not.toContain("Own reply"); expect(f.kill).not.toHaveBeenCalled();
    if (evidence === "request" || evidence === "assistant") expect(f.progress.at(-1)?.state).toBe("received");
    else expect(f.progress.some(p => p.state === "received")).toBe(false);
  });
  it("keeps the stop fence scoped after its promise timed out and the input starts late", async () => {
    const f = await fixture(); const abort = new AbortController(); const { turn, uuid } = await f.send({ abortSignal: abort.signal });
    f.child.life(uuid, "queued"); vi.useFakeTimers();
    try {
      abort.abort(APP_USER_STOP_REASON); await vi.advanceTimersByTimeAsync(11000);
      await expect(turn).rejects.toThrow(); expect(f.adapter.isSessionInputBlocked(SESSION)).toBe(true);
      f.child.life(uuid, "started"); expect(f.child.controls("interrupt")).toHaveLength(1);
      f.child.ack(f.child.controls("interrupt")[0], { turn: "stopped", still_queued: [] });
      f.child.life(uuid, "cancelled"); f.child.result("", uuid, true, true);
      expect(f.adapter.isSessionInputBlocked(SESSION)).toBe(false); expect(f.kill).not.toHaveBeenCalled();
      expect(JSON.stringify(f.old)).not.toContain("Task was stopped");
    } finally { vi.useRealTimers(); }
  });
  it("reports an absent admission receipt as unknown, preserves the review, and accepts late real evidence", async () => {
    const f = await fixture({ timeout: 25 });
    vi.useFakeTimers();
    try {
      const turn = f.adapter.sendUserMessage(SESSION, { text: "Late", files: [], inputOwnerKey: OWNER, reviewAdmission: "native", nativeInput: { id: "late", onProgress: p => f.progress.push(p) } });
      void turn.catch(() => undefined);
      for (let n=0; n<25 && f.child.prompts.length<2; n++) await vi.advanceTimersByTimeAsync(0);
      expect(f.child.prompts).toHaveLength(2); const uuid = f.child.prompts[1].uuid;
      await vi.advanceTimersByTimeAsync(5100); expect(f.progress).toEqual([{ state: "unknown", reason: "no_admission_receipt" }]);
      expect(f.kill).not.toHaveBeenCalled(); expect(f.child.prompts).toHaveLength(2);
      f.child.life(uuid, "queued"); f.child.life(uuid, "started"); modelStarts(f.child, uuid); f.child.result("Late", uuid, true);
      await expect(turn).resolves.toMatchObject({ text: "Late" }); expect(f.progress.at(-1)?.state).toBe("received");
    } finally { vi.useRealTimers(); }
  });
  it("keeps explicit next-turn input outside the CLI until the review ends", async () => {
    const f = await fixture(); const next = f.adapter.sendUserMessage(SESSION, { text: "Next", files: [], inputOwnerKey: OWNER, onEngineEvent: e => { f.current.push(e); } });
    await tick(); expect(f.child.prompts).toHaveLength(1); expect(f.current).toContainEqual(expect.objectContaining({ type: "background_review_wait", status: "started" }));
    f.child.result("Old", undefined, true); await until(() => f.child.prompts.length === 2);
    f.child.result("Next answer", f.child.prompts[1].uuid); await expect(next).resolves.toMatchObject({ text: "Next answer" });
  });
  it.each([[], ["msg_lifecycle_v1", "request_marker_lists_v1"], ["msg_lifecycle_v1", "interrupt_receipt_v1"]].map(caps => ({ caps })))("rejects native review admission without all required contracts: $caps", async ({ caps }) => {
    const f = await fixture({ caps }); expect(f.adapter.backgroundInputTarget(SESSION, OWNER)).toBeUndefined();
    await expect(f.adapter.sendUserMessage(SESSION, { text: "unsafe", files: [], inputOwnerKey: OWNER, reviewAdmission: "native", nativeInput: { id: "no", onProgress: p => { f.progress.push(p); } } })).rejects.toBeInstanceOf(EngineNativeInputUnsentError);
    expect(f.progress).toEqual([{ state: "dropped", reason: "not_admitted" }]); expect(f.child.prompts).toHaveLength(1);
  });
  it("rejects a foreign conversation and an expired target before writing", async () => {
    const f = await fixture();
    await expect(f.adapter.sendUserMessage(SESSION, { text: "foreign", files: [], inputOwnerKey: "different", reviewAdmission: "native" })).rejects.toMatchObject({ reason: "not_admitted" });
    f.child.result("Finished", undefined, true);
    await expect(f.adapter.sendUserMessage(SESSION, { text: "late", files: [], inputOwnerKey: OWNER, reviewAdmission: "native" })).rejects.toMatchObject({ reason: "not_admitted" });
    expect(f.child.prompts).toHaveLength(1);
  });
  it("does not kill a silent review while its human message is natively queued", async () => {
    const f = await fixture({ timeout: 25 }); const { turn, uuid } = await f.send(); f.child.life(uuid, "queued");
    await new Promise(r => setTimeout(r, 75)); expect(f.kill).not.toHaveBeenCalled();
    f.child.life(uuid, "started"); f.child.result("Done", uuid, true); await turn;
  });
});

// Isolated Claude Code 2.1.321 probes (#13, #31): a prompt written while Claude
// is on a background-task turn gets no turn of its own. Claude takes it at that
// turn's next request (`started`, then `requesting` naming it; no `system/init`
// names it), reports `completed`, and ends with one result that names the prompt
// but keeps origin task-notification. A background task that ends inside a
// prompt's own turn produces no user frame there; older CLIs announced one.
describe("ordinary prompt that Claude takes into a background-task turn", () => {
  async function launched() {
    vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve());
    const child = new Child();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn: () => child, taskNotificationStartGraceMs: 10_000, turnInactivityTimeoutMs: null }); adapters.push(adapter);
    const old: EngineStreamEvent[] = [], current: EngineStreamEvent[] = [];
    const first = adapter.sendUserMessage(SESSION, { text: "Start background", files: [], inputOwnerKey: OWNER, onEngineEvent: e => { old.push(e); } });
    await until(() => child.prompts.length === 1); child.init(); const p = child.prompts[0].uuid as string;
    child.life(p, "queued"); child.life(p, "started");
    child.frame({ type: "assistant", message: { content: [{ type: "tool_use", id: "launch", name: "Bash", input: { command: "work", run_in_background: true } }] } });
    child.frame({ type: "system", subtype: "task_started", task_id: "task-bg", tool_use_id: "launch", task_type: "local_bash" });
    child.result("LAUNCHED", p); child.life(p, "completed"); await first;
    // Nothing on stdout announces the notification Claude has already queued,
    // so the next prompt is written at once.
    const send = async (text: string) => {
      let settled = false;
      const turn = adapter.sendUserMessage(SESSION, { text, files: [], inputOwnerKey: OWNER, onEngineEvent: e => { current.push(e); } });
      void turn.then(() => { settled = true; }, () => { settled = true; });
      await until(() => child.prompts.length === 2);
      return { turn, uuid: child.prompts[1].uuid as string, settled: () => settled };
    };
    return { child, old, current, first: p, send };
  }
  const notification = '<task-notification><task-id>task-bg</task-id><tool-use-id>launch</tool-use-id><status>completed</status><summary>Background test</summary></task-notification>';
  /** A separate background-task message the user would see, carrying `text`. */
  const shownApart = (events: EngineStreamEvent[], text: string) => events.some(e => e.type === "task_notification" && !e.settlesCurrentTurn && !e.suppressUserDelivery && e.text.includes(text));
  const streamed = (events: EngineStreamEvent[]) => events.filter(e => e.type === "assistant_text").map(e => "text" in e ? e.text : "").join("");

  it("ends the prompt on the result that names it, and shows its answer once", async () => {
    const f = await launched();
    const s = await f.send("Make the badge bigger");
    f.child.life(s.uuid, "queued");
    f.child.init(); // the background-task turn: it names no prompt
    f.child.frame({ type: "system", subtype: "status", status: "requesting" });
    f.child.reply("Render finished.");
    f.child.frame({ type: "assistant", message: { content: [{ type: "tool_use", id: "deliver", name: "Bash", input: { command: "deliver" } }] } });
    f.child.frame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "deliver", content: "ok" }] } });
    f.child.life(s.uuid, "started"); modelStarts(f.child, s.uuid);
    f.child.reply("Badge enlarged and sent.", s.uuid);
    f.child.life(s.uuid, "completed"); f.child.result("Badge enlarged and sent.", s.uuid, true);
    await until(s.settled);
    await expect(s.turn).resolves.toMatchObject({ text: "Badge enlarged and sent." });
    expect(shownApart([...f.old, ...f.current], "Badge enlarged and sent.")).toBe(false);
  });

  it("never ends a waiting prompt on a background-task result that does not name it", async () => {
    const f = await launched();
    const s = await f.send("Next question");
    f.child.life(s.uuid, "queued");
    f.child.init(); f.child.reply("Background report.");
    f.child.result("Background report.", undefined, true);
    f.child.result("Stale report.", f.first, true); // names an earlier, finished command
    for (let n = 0; n < 20; n++) await tick();
    expect(s.settled()).toBe(false);
    f.child.life(s.uuid, "started"); f.child.init(); modelStarts(f.child, s.uuid);
    f.child.reply("Own answer.", s.uuid); f.child.result("Own answer.", s.uuid); f.child.life(s.uuid, "completed");
    await expect(s.turn).resolves.toMatchObject({ text: "Own answer." });
  });

  it("keeps a notification delivered inside the prompt's own turn in that turn", async () => {
    const f = await launched();
    const s = await f.send("Run the long check");
    f.child.life(s.uuid, "queued"); f.child.life(s.uuid, "started"); f.child.init(); modelStarts(f.child, s.uuid);
    f.child.frame({ type: "assistant", user_message_uuid: s.uuid, user_message_uuids: [s.uuid], message: { model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "check", name: "Bash", input: { command: "check" } }] } });
    f.child.frame({ type: "user", origin: { kind: "task-notification" }, message: { content: notification } });
    f.child.frame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "check", content: "ok" }] } });
    f.child.reply("Check passed; the background test finished too.");
    f.child.result("Check passed; the background test finished too.", s.uuid); f.child.life(s.uuid, "completed");
    await until(s.settled);
    await expect(s.turn).resolves.toMatchObject({ text: "Check passed; the background test finished too." });
    expect(streamed(f.current)).toContain("Check passed");
    expect(shownApart([...f.old, ...f.current], "Check passed")).toBe(false);
  });

  it("hands a running review to the prompt Claude takes into it, keeping the review's own text apart", async () => {
    const f = await launched();
    const s = await f.send("Make the badge bigger");
    f.child.life(s.uuid, "queued");
    f.child.frame({ type: "user", origin: { kind: "task-notification" }, message: { content: notification } });
    f.child.reply("Review before the prompt.");
    f.child.frame({ type: "assistant", message: { content: [{ type: "tool_use", id: "inspect", name: "Bash", input: { command: "inspect" } }] } });
    f.child.frame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "inspect", content: "ok" }] } });
    f.child.life(s.uuid, "started"); modelStarts(f.child, s.uuid);
    f.child.reply("Badge enlarged.", s.uuid);
    f.child.life(s.uuid, "completed"); f.child.result("Badge enlarged.", s.uuid, true);
    await until(s.settled);
    await expect(s.turn).resolves.toMatchObject({ text: "Badge enlarged." });
    expect(shownApart(f.old, "Review before the prompt.")).toBe(true);
    expect(JSON.stringify(f.old)).not.toContain("Badge enlarged.");
    expect(JSON.stringify(f.current)).not.toContain("Review before the prompt.");
  });
});
