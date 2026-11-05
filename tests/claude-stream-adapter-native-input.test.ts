import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeInputProgress } from "../src/client-protocol/native-input.js";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import * as processTree from "../src/codex/process-tree.js";
import { APP_USER_STOP_REASON } from "../src/runtime/turn-cancellation.js";

// Frame shapes, fields and ordering follow isolated Claude Code 2.1.309 probes
// (send_now delivering/stopped, cancel_async_message, request markers and a
// foreground Bash moved to the background for a waiting message).
const CAPABILITIES_309 = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "interrupt_send_now_v1", "interrupt_requeue_taken_v1", "msg_lifecycle_v1", "request_marker_lists_v1"];
const CAPABILITIES_307 = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"];
const SESSION = "native-input-S";

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

function setup() {
  const children: FakeChild[] = [];
  const spawnFn = () => { const child = new FakeChild(); children.push(child); return child; };
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn, taskNotificationStartGraceMs: 0 });
  return { adapter, children };
}

type Written = { type: string; uuid?: string; priority?: string; origin?: unknown; request_id?: string; request?: Record<string, unknown>; message?: { content: Array<{ text: string }> } };
const written = (child: FakeChild): Written[] => child.stdin.lines.map((line) => JSON.parse(line) as Written);
const users = (child: FakeChild) => written(child).filter((line) => line.type === "user");
const emit = (child: FakeChild, frame: Record<string, unknown>) => child.stdout.emitData(JSON.stringify({ session_id: SESSION, ...frame }) + "\n");
const lifecycle = (child: FakeChild, uuid: string, state: string) => emit(child, { type: "command_lifecycle", command_uuid: uuid, state });
const ack = (child: FakeChild, request: Written, response: Record<string, unknown> = {}) =>
  emit(child, { type: "control_response", response: { subtype: "success", request_id: request.request_id, response } });
const controlRequests = (child: FakeChild, subtype?: string) => written(child).filter((line) => line.type === "control_request" && (!subtype || line.request?.subtype === subtype));
const requesting = (child: FakeChild, uuids: string[]) => emit(child, { type: "system", subtype: "status", status: "requesting", user_message_uuids: uuids });
/** A real reply start (2.1.309 shape: an API message with an id and a model). */
const messageStart = (child: FakeChild, extra: Record<string, unknown> = {}) => emit(child, { type: "stream_event", event: { type: "message_start", message: { id: "msg_reply", model: "claude-sonnet-5-5" } }, parent_tool_use_id: null, ...extra });

async function startTurn(adapter: ClaudeStreamAdapter, children: FakeChild[], input: { text?: string; capabilities?: string[]; events?: EngineStreamEvent[]; abortSignal?: AbortSignal } = {}) {
  const before = children[0]?.stdin.lines.length ?? 0;
  const turn = adapter.sendUserMessage(SESSION, { text: input.text ?? "work", files: [], abortSignal: input.abortSignal,
    onEngineEvent: input.events ? (event) => { input.events!.push(event); } : undefined });
  await waitFor(() => (children[0]?.stdin.lines.length ?? 0) > before && written(children[0]).some((line, index) => index >= before && line.type === "user"));
  const child = children[0];
  const prompt = users(child).at(-1)!;
  emit(child, { type: "system", subtype: "init", capabilities: input.capabilities ?? CAPABILITIES_309 });
  lifecycle(child, prompt.uuid!, "queued");
  lifecycle(child, prompt.uuid!, "started");
  requesting(child, [prompt.uuid!]);
  return { turn, child, prompt: prompt.uuid! };
}

/** Writes one ordinary App input natively and returns its uuid once Claude queued it. */
async function nativeInput(adapter: ClaudeStreamAdapter, child: FakeChild, id: string, text: string, onOutcome?: (outcome: unknown) => void) {
  const progress: NativeInputProgress[] = [];
  const count = users(child).length;
  const admitted = adapter.steerActiveTurn(SESSION, { text, throwOnError: true, nativeInput: { id, onProgress: (item) => { progress.push(item); } }, ...(onOutcome ? { onOutcome } : {}) });
  await waitFor(() => users(child).length === count + 1);
  const uuid = users(child).at(-1)!.uuid!;
  lifecycle(child, uuid, "queued");
  await expect(admitted).resolves.toBe(true);
  return { uuid, progress };
}

let kill: ReturnType<typeof vi.spyOn>;
afterEach(() => { kill?.mockRestore(); });
const spyKill = () => { kill = vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve()); return kill; };

describe("Claude native input capability", () => {
  it("reports only what the live worker's CLI advertised, never inferred from a version", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      expect(adapter.nativeInputCapability(SESSION)).toBeUndefined();
      const { turn, child } = await startTurn(adapter, children, { capabilities: CAPABILITIES_309 });
      expect(adapter.nativeInputCapability(SESSION)).toEqual({ sendNow: true, cancel: true, modelReceipt: true });
      emit(child, { type: "system", subtype: "init", capabilities: CAPABILITIES_307 });
      expect(adapter.nativeInputCapability(SESSION)).toEqual({ sendNow: false, cancel: true, modelReceipt: false });
      emit(child, { type: "system", subtype: "init" });
      expect(adapter.nativeInputCapability(SESSION)).toBeUndefined();
      expect(adapter.nativeInputCapability("other-session")).toBeUndefined();
      emit(child, { type: "result", subtype: "success", result: "done" });
      await turn;
    } finally { await adapter.destroy(); }
  });
});

describe("Claude native input progress", () => {
  it("writes the user's input as their own message without priority and reports dequeued before, never as, model receipt", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const outcomes: unknown[] = [];
      const { uuid, progress } = await nativeInput(adapter, child, "host-a", "Also cover MANGO.", (outcome) => { outcomes.push(outcome); });
      expect(users(child).at(-1)).toEqual({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text: "Also cover MANGO." }] }, origin: { kind: "human" } });
      expect(users(child).at(-1)!.priority).toBeUndefined();
      expect(progress).toEqual([{ state: "queued" }]);
      // Folded at the next model request: taken off the queue, not yet seen by the model.
      lifecycle(child, uuid, "started");
      requesting(child, [prompt, uuid]);
      expect(progress).toEqual([{ state: "queued" }, { state: "dequeued" }]);
      // The legacy outcome keeps its existing meaning for older consumers.
      expect(outcomes).toEqual([{ status: "applied", via: "fold" }]);
      // The announcement, a subagent's reply, a ping or a start without a real model is no receipt.
      emit(child, { type: "stream_event", event: { type: "message_start", message: { id: "msg_child", model: "claude-sonnet-5-5" } }, parent_tool_use_id: "toolu_agent" });
      emit(child, { type: "assistant", parent_tool_use_id: "toolu_agent", message: { content: [{ type: "text", text: "child" }] } });
      emit(child, { type: "stream_event", event: { type: "ping" }, parent_tool_use_id: null });
      emit(child, { type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null });
      emit(child, { type: "stream_event", event: { type: "message_start", message: { id: "msg_x", model: "<synthetic>" } }, parent_tool_use_id: null });
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      // The main model starts replying to the request that carried it (requests are serial).
      messageStart(child);
      expect(progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "received" }]);
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "MANGO" }] } });
      lifecycle(child, uuid, "completed");
      emit(child, { type: "result", subtype: "success", result: "MANGO", user_message_uuid: prompt, user_message_uuids: [prompt, uuid] });
      await expect(turn).resolves.toMatchObject({ text: "MANGO" });
      expect(progress).toHaveLength(3);
    } finally { await adapter.destroy(); }
  });

  it("keeps two inputs in their written order and attributes the model receipt to each", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const first: NativeInputProgress[] = [], second: NativeInputProgress[] = [];
      const a = adapter.steerActiveTurn(SESSION, { text: "first addition", nativeInput: { id: "host-1", onProgress: (item) => { first.push(item); } } });
      const b = adapter.steerActiveTurn(SESSION, { text: "second addition", nativeInput: { id: "host-2", onProgress: (item) => { second.push(item); } } });
      await waitFor(() => users(child).length === 3);
      const [, inputA, inputB] = users(child);
      expect([inputA!.message!.content[0]!.text, inputB!.message!.content[0]!.text]).toEqual(["first addition", "second addition"]);
      lifecycle(child, inputA!.uuid!, "queued");
      lifecycle(child, inputB!.uuid!, "queued");
      await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
      lifecycle(child, inputA!.uuid!, "started");
      lifecycle(child, inputB!.uuid!, "started");
      requesting(child, [prompt, inputA!.uuid!, inputB!.uuid!]);
      expect(first.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      messageStart(child);
      expect(first.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
      expect(second.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
      emit(child, { type: "result", subtype: "success", result: "both", user_message_uuids: [prompt, inputA!.uuid, inputB!.uuid] });
      await expect(turn).resolves.toMatchObject({ text: "both" });
    } finally { await adapter.destroy(); }
  });

  it("never reports a receipt without the marker capability, or from a synthetic or failed reply", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children, { capabilities: CAPABILITIES_307 });
      const { uuid, progress } = await nativeInput(adapter, child, "host-old", "addition");
      lifecycle(child, uuid, "started");
      emit(child, { type: "assistant", user_message_uuids: [uuid], message: { content: [{ type: "text", text: "reply" }] } });
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      // With the markers, an API-error reply or a stamped stream event is still no model reply.
      emit(child, { type: "system", subtype: "init", capabilities: CAPABILITIES_309 });
      const second = await nativeInput(adapter, child, "host-synthetic", "another");
      lifecycle(child, second.uuid, "started");
      emit(child, { type: "assistant", error: "rate_limit", user_message_uuids: [second.uuid], message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } });
      messageStart(child, { user_message_uuids: [second.uuid] });
      expect(second.progress.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      lifecycle(child, uuid, "completed");
      lifecycle(child, second.uuid, "completed");
      // No main-model reply after it was dequeued: a successful result naming it
      // is not a receipt; the turn ended, so the model's receipt stays unconfirmed.
      emit(child, { type: "result", subtype: "success", result: "done", user_message_uuids: [prompt, uuid, second.uuid] });
      await turn;
      expect(progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "unknown", reason: "ended_without_model_receipt" }]);
      expect(second.progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "unknown", reason: "ended_without_model_receipt" }]);
    } finally { await adapter.destroy(); }
  });

  it("never treats an error result naming a replied-to input as its receipt", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child, prompt } = await startTurn(adapter, children, { abortSignal: stop.signal });
      const { uuid, progress } = await nativeInput(adapter, child, "host-err", "addition");
      lifecycle(child, uuid, "started");
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } });
      const stopped = expect(turn).rejects.toThrow("stopped by user");
      stop.abort(APP_USER_STOP_REASON);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [], turn: "stopped" });
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", user_message_uuid: prompt, user_message_uuids: [prompt, uuid] });
      lifecycle(child, uuid, "cancelled");
      lifecycle(child, prompt, "cancelled");
      await stopped;
      expect(progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "unknown", reason: "interrupted_before_receipt" }]);
    } finally { await adapter.destroy(); }
  });

  it("reports a new turn's opener as received from its first stamped reply", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid, progress } = await nativeInput(adapter, child, "host-next", "and then PAPAYA");
      // The addition missed the fold: Claude runs it as its own next turn.
      emit(child, { type: "result", subtype: "success", result: "first part", user_message_uuid: prompt, user_message_uuids: [prompt] });
      lifecycle(child, prompt, "completed");
      lifecycle(child, uuid, "started");
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      emit(child, { type: "assistant", user_message_uuid: uuid, user_message_uuids: [uuid], message: { content: [{ type: "text", text: "PAPAYA answer" }] } });
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
      emit(child, { type: "result", subtype: "success", result: "PAPAYA answer", user_message_uuid: uuid, user_message_uuids: [uuid] });
      await expect(turn).resolves.toMatchObject({ text: "first part\nPAPAYA answer" });
    } finally { await adapter.destroy(); }
  });

  it("never writes a retried input twice and replays its known state to the new observer", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children);
      const { uuid } = await nativeInput(adapter, child, "host-retry", "only once");
      const replayed: NativeInputProgress[] = [];
      await expect(adapter.steerActiveTurn(SESSION, { text: "only once", throwOnError: true, nativeInput: { id: "host-retry", onProgress: (item) => { replayed.push(item); } } })).resolves.toBe(true);
      expect(users(child).filter((line) => line.uuid === uuid)).toHaveLength(1);
      expect(users(child)).toHaveLength(2);
      expect(replayed).toEqual([{ state: "queued" }]);
      lifecycle(child, uuid, "started");
      expect(replayed).toEqual([{ state: "queued" }, { state: "dequeued" }]);
      emit(child, { type: "result", subtype: "success", result: "done" });
      await turn;
    } finally { await adapter.destroy(); }
  });
});

describe("Claude native input receipt evidence", () => {
  it("never links a reply that is not the start of the main model's reply to the announced request", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid, progress } = await nativeInput(adapter, child, "host-neg", "addition");
      lifecycle(child, uuid, "started");
      // Not yet announced in a request: a reply start belongs to an earlier request.
      messageStart(child);
      requesting(child, [prompt, uuid]);
      emit(child, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }, user_message_uuids: [uuid], parent_tool_use_id: null });
      emit(child, { type: "stream_event", event: { type: "error", error: { type: "overloaded_error" } }, parent_tool_use_id: null });
      emit(child, { type: "assistant", error: "overloaded", message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } });
      // A new request that does not carry it replaces the link.
      requesting(child, [prompt]);
      messageStart(child);
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      // A compaction between the announcement and the reply clears the link too.
      requesting(child, [prompt, uuid]);
      emit(child, { type: "system", subtype: "status", status: "compacting" });
      emit(child, { type: "system", subtype: "compact_boundary", uuid: "cb-1" });
      messageStart(child);
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      lifecycle(child, uuid, "completed");
      emit(child, { type: "result", subtype: "success", result: "done", user_message_uuid: prompt, user_message_uuids: [prompt, uuid] });
      await turn;
      // After the turn's result, nothing late can link.
      requesting(child, [uuid]);
      emit(child, { type: "result", subtype: "success", result: "late" });
      messageStart(child);
      expect(progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "unknown", reason: "ended_without_model_receipt" }]);
    } finally { await adapter.destroy(); }
  });

  it("never links a reply start that arrives after the announced request's turn ended", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid, progress } = await nativeInput(adapter, child, "host-after-result", "addition");
      lifecycle(child, uuid, "started");
      requesting(child, [prompt, uuid]);
      // The turn ends (for example a stop hook) before any reply to that request.
      emit(child, { type: "result", subtype: "success", result: "", user_message_uuid: prompt, user_message_uuids: [prompt, uuid] });
      messageStart(child);
      lifecycle(child, uuid, "completed");
      await turn.catch(() => undefined);
      expect(progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "unknown", reason: "ended_without_model_receipt" }]);
    } finally { await adapter.destroy(); }
  });

  it("never counts a late reply start after a stop", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child, prompt } = await startTurn(adapter, children, { abortSignal: stop.signal });
      const { uuid, progress } = await nativeInput(adapter, child, "host-late-stop", "addition");
      lifecycle(child, uuid, "started");
      requesting(child, [prompt, uuid]);
      const stopped = expect(turn).rejects.toThrow("stopped by user");
      stop.abort(APP_USER_STOP_REASON);
      messageStart(child);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [], turn: "stopped" });
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", user_message_uuid: prompt, user_message_uuids: [prompt, uuid] });
      lifecycle(child, uuid, "cancelled");
      lifecycle(child, prompt, "cancelled");
      await stopped;
      expect(progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "unknown", reason: "interrupted_before_receipt" }]);
    } finally { await adapter.destroy(); }
  });

  it("counts a main-model reply after a compaction, at the turn's successful result", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid, progress } = await nativeInput(adapter, child, "host-compact", "addition");
      lifecycle(child, uuid, "started");
      emit(child, { type: "system", subtype: "status", status: "compacting" });
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "after compaction" }] } });
      lifecycle(child, uuid, "completed");
      emit(child, { type: "result", subtype: "success", result: "after compaction", user_message_uuid: prompt, user_message_uuids: [prompt, uuid] });
      await turn;
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
    } finally { await adapter.destroy(); }
  });

  it("ends an older CLI's own-turn input as unconfirmed once that turn completes, and replays it to a retry", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children, { capabilities: CAPABILITIES_307 });
      const { uuid, progress } = await nativeInput(adapter, child, "host-own", "next");
      emit(child, { type: "result", subtype: "success", result: "first", user_message_uuid: prompt });
      lifecycle(child, prompt, "completed");
      lifecycle(child, uuid, "started");
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "second" }] } });
      emit(child, { type: "result", subtype: "success", result: "second", user_message_uuid: uuid });
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      // An input that opened its own turn ends after that turn's result.
      lifecycle(child, uuid, "completed");
      await expect(turn).resolves.toMatchObject({ text: "first\nsecond" });
      expect(progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "unknown", reason: "ended_without_model_receipt" }]);
      // Settled: callbacks released; a retry only replays the final state.
      const replay: NativeInputProgress[] = [];
      await expect(adapter.steerActiveTurn(SESSION, { text: "next", throwOnError: true, nativeInput: { id: "host-own", onProgress: (item) => { replay.push(item); } } })).resolves.toBe(true);
      expect(replay).toEqual([{ state: "unknown", reason: "ended_without_model_receipt" }]);
      expect(users(child)).toHaveLength(2);
    } finally { await adapter.destroy(); }
  });

  it("refuses a new native input before writing when its ownership could not be kept", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children);
      // The prompt plus 255 live inputs fill every tracked command slot.
      const live: string[] = [];
      for (let index = 0; index < 255; index += 1) live.push((await nativeInput(adapter, child, `host-cap-${index}`, `input ${index}`)).uuid);
      const writes = users(child).length;
      await expect(adapter.steerActiveTurn(SESSION, { text: "one too many", throwOnError: true, nativeInput: { id: "host-cap-over", onProgress: () => undefined } })).rejects.toMatchObject({ reason: "not_ready" });
      expect(users(child)).toHaveLength(writes);
      // The oldest written input is still owned and controllable.
      const cancelling = adapter.controlNativeInput(SESSION, { inputId: "host-cap-0", action: "cancel" });
      await waitFor(() => controlRequests(child, "cancel_async_message").length === 1);
      expect(controlRequests(child, "cancel_async_message")[0]!.request).toEqual({ subtype: "cancel_async_message", message_uuid: live[0] });
      lifecycle(child, live[0]!, "cancelled");
      ack(child, controlRequests(child, "cancel_async_message")[0]!, { cancelled: true });
      await expect(cancelling).resolves.toEqual({ outcome: "accepted", result: "cancelled" });
      // A settled input frees its slot.
      const after = await nativeInput(adapter, child, "host-cap-after", "fits now");
      for (const uuid of [...live.slice(1), after.uuid]) lifecycle(child, uuid, "started");
      emit(child, { type: "result", subtype: "success", result: "done" });
      await expect(turn).resolves.toMatchObject({ text: "done" });
    } finally { await adapter.destroy(); }
  });

  it("keeps the 2.1.307 legacy steering path unchanged (no markers, no moved-call frames)", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const events: EngineStreamEvent[] = [];
      const { turn, child, prompt } = await startTurn(adapter, children, { capabilities: CAPABILITIES_307, events });
      const outcomes: unknown[] = [];
      const steering = adapter.steerActiveTurn(SESSION, { text: "later", onOutcome: (outcome) => { outcomes.push(outcome); } });
      await waitFor(() => users(child).length === 2);
      const steer = users(child)[1]!;
      expect(steer.origin).toBeUndefined();
      lifecycle(child, steer.uuid!, "queued");
      await steering;
      emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_ls", name: "Bash", input: { command: "ls" } }] } });
      emit(child, { type: "system", subtype: "task_started", task_id: "bls", tool_use_id: "toolu_ls", task_type: "local_bash", description: "List", is_backgrounded: false });
      emit(child, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_ls", content: "a" }] }, tool_use_result: { stdout: "a" } });
      emit(child, { type: "system", subtype: "task_notification", task_id: "bls", tool_use_id: "toolu_ls", status: "completed" });
      emit(child, { type: "result", subtype: "success", result: "first", user_message_uuid: prompt });
      lifecycle(child, steer.uuid!, "started");
      emit(child, { type: "result", subtype: "success", result: "second", user_message_uuid: steer.uuid });
      await expect(turn).resolves.toMatchObject({ text: "first\nsecond" });
      expect(outcomes).toEqual([{ status: "applied", via: "continuation" }]);
      expect(events.filter((event) => event.type === "background_task_started" || event.type === "background_task_finished")).toEqual([]);
      expect(adapter.nativeInputCapability(SESSION)).toEqual({ sendNow: false, cancel: true, modelReceipt: false });
    } finally { await adapter.destroy(); }
  });
});

describe("Claude native send-now", () => {
  it("is refused without writing anything when the live CLI lacks interrupt_send_now_v1", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children, { capabilities: CAPABILITIES_307 });
      const { uuid } = await nativeInput(adapter, child, "host-old", "addition");
      const before = child.stdin.lines.length;
      // An older CLI would treat interrupt{send_now} as a plain Stop.
      await expect(adapter.controlNativeInput(SESSION, { inputId: "host-old", action: "send-now" })).resolves.toEqual({ outcome: "rejected", reason: "unsupported" });
      await expect(adapter.controlNativeInput(SESSION, { inputId: "unknown-id", action: "send-now" })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      await expect(adapter.controlNativeInput("other-session", { inputId: "host-old", action: "send-now" })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      expect(child.stdin.lines.length).toBe(before);
      lifecycle(child, uuid, "started");
      emit(child, { type: "result", subtype: "success", result: "done" });
      await turn;
    } finally { await adapter.destroy(); }
  });

  it("asks Claude with the original uuid and reports its own answer; a moved call stays bound to its turn", async () => {
    const killSpy = spyKill();
    const { adapter, children } = setup();
    try {
      const events: EngineStreamEvent[] = [];
      const { turn, child, prompt } = await startTurn(adapter, children, { events });
      emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_fg", name: "Bash", input: { command: "ping -c 30 127.0.0.1", timeout: 60000 } }] } });
      emit(child, { type: "system", subtype: "task_started", task_id: "bfg", tool_use_id: "toolu_fg", task_type: "local_bash", description: "Run loopback ping check", is_backgrounded: false });
      const { uuid, progress } = await nativeInput(adapter, child, "host-now", "Also end with PINEAPPLE.");
      const sending = adapter.controlNativeInput(SESSION, { inputId: "host-now", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      const request = controlRequests(child, "interrupt")[0]!;
      expect(request.request).toEqual({ subtype: "interrupt", send_now: true, message_uuid: uuid });
      ack(child, request, { still_queued: [uuid], send_now: "delivering" });
      await expect(sending).resolves.toEqual({ outcome: "accepted", result: "delivering" });
      // Delivering is not a receipt: the model has not seen it yet.
      expect(progress.map((item) => item.state)).toEqual(["queued"]);
      // Claude moves the running call aside; the turn goes on and takes the input in.
      emit(child, { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bfg", task_type: "local_bash", description: "Run loopback ping check" }] });
      emit(child, { type: "system", subtype: "task_updated", task_id: "bfg", patch: { is_backgrounded: true } });
      emit(child, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: "Command was moved to the background (ID: bfg) so that a message that arrived while it was running can reach you; it was not interrupted." }] },
        tool_use_result: { stdout: "", backgroundTaskId: "bfg", backgroundedToDeliverMessage: true } });
      lifecycle(child, uuid, "started");
      requesting(child, [prompt, uuid]);
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      messageStart(child);
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "PINEAPPLE" }] } });
      expect(events.filter((event) => event.type === "background_task_started")).toEqual([expect.objectContaining({ taskId: "bfg", origin: "bound" })]);
      lifecycle(child, uuid, "completed");
      emit(child, { type: "result", subtype: "success", result: "PINEAPPLE", user_message_uuid: prompt, user_message_uuids: [prompt, uuid] });
      await expect(turn).resolves.toMatchObject({ text: "PINEAPPLE" });
      await expect(adapter.listTasks(SESSION)).resolves.toMatchObject({ tasks: [expect.objectContaining({ mode: "background", owner: "bound", status: "running" })] });
      // Its later completion reports to the turn that started it.
      emit(child, { type: "system", subtype: "task_notification", task_id: "bfg", tool_use_id: "toolu_fg", status: "completed", summary: "Run loopback ping check" });
      await waitFor(() => events.some((event) => event.type === "background_task_finished"));
      expect(events.find((event) => event.type === "background_task_finished")).toMatchObject({ taskId: "bfg", origin: "bound", status: "completed" });
      expect(controlRequests(child, "cancel_async_message")).toHaveLength(0);
      expect(controlRequests(child, "interrupt")).toHaveLength(1);
      expect(killSpy).not.toHaveBeenCalled();
    } finally { await adapter.destroy(); }
  });

  it("continues the same host turn when Claude cuts it for the input (stopped), without withdrawing or failing", async () => {
    const killSpy = spyKill();
    const { adapter, children } = setup();
    try {
      const events: EngineStreamEvent[] = [];
      const { turn, child, prompt } = await startTurn(adapter, children, { events });
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "Starting." }, { type: "tool_use", id: "toolu_fg", name: "Bash", input: { command: "sh work.sh 30 FG" } }] } });
      const outcomes: unknown[] = [];
      const { uuid, progress } = await nativeInput(adapter, child, "host-cut", "Also end with PINEAPPLE.", (outcome) => { outcomes.push(outcome); });
      const sending = adapter.controlNativeInput(SESSION, { inputId: "host-cut", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [uuid], send_now: "stopped" });
      await expect(sending).resolves.toEqual({ outcome: "accepted", result: "stopped" });
      emit(child, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_fg", is_error: true, content: "The user doesn't want to proceed with this tool use." }] } });
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", user_message_uuid: prompt, user_message_uuids: [prompt] });
      lifecycle(child, prompt, "cancelled");
      let settled = false;
      void turn.then(() => { settled = true; }, () => { settled = true; });
      await settle();
      expect(settled).toBe(false);
      expect(controlRequests(child, "cancel_async_message")).toHaveLength(0);
      lifecycle(child, uuid, "started");
      requesting(child, [uuid]);
      emit(child, { type: "stream_event", event: { type: "message_start" }, user_message_uuid: uuid, user_message_uuids: [uuid] });
      emit(child, { type: "assistant", user_message_uuid: uuid, user_message_uuids: [uuid], message: { content: [{ type: "text", text: "Done. PINEAPPLE" }] } });
      emit(child, { type: "result", subtype: "success", result: "Done. PINEAPPLE", user_message_uuid: uuid, user_message_uuids: [uuid] });
      lifecycle(child, uuid, "completed");
      const result = await turn;
      // The cut answer stays as streamed, marked as stopped for the input.
      expect(result.text).toBe("Starting.\n\n（Claude 为立即发送的消息中断了以上回答。）\nDone. PINEAPPLE");
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
      expect(outcomes).toEqual([{ status: "applied", via: "continuation" }]);
      expect(events.filter((event) => event.type === "result")).toHaveLength(1);
      // Only the send-now request: no Stop, no withdrawal, no process stop.
      expect(controlRequests(child).map((line) => line.request!.subtype)).toEqual(["interrupt"]);
      expect(killSpy).not.toHaveBeenCalled();
      // The worker stays usable for the next turn.
      const next = adapter.sendUserMessage(SESSION, { text: "next", files: [] });
      await waitFor(() => users(child).length === 3);
      const nextPrompt = users(child)[2]!;
      lifecycle(child, nextPrompt.uuid!, "started");
      emit(child, { type: "result", subtype: "success", result: "next answer", user_message_uuid: nextPrompt.uuid });
      await expect(next).resolves.toMatchObject({ text: "next answer" });
    } finally { await adapter.destroy(); }
  });

  it("treats the cut as the send-now continuation even when it arrives before Claude's answer", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid } = await nativeInput(adapter, child, "host-race", "now please");
      const sending = adapter.controlNativeInput(SESSION, { inputId: "host-race", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", user_message_uuid: prompt });
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [uuid], send_now: "stopped" });
      await expect(sending).resolves.toEqual({ outcome: "accepted", result: "stopped" });
      lifecycle(child, uuid, "started");
      emit(child, { type: "result", subtype: "success", result: "answered now", user_message_uuid: uuid });
      await expect(turn).resolves.toMatchObject({ text: "answered now" });
      expect(controlRequests(child, "cancel_async_message")).toHaveLength(0);
    } finally { await adapter.destroy(); }
  });

  it("reports a missing, refused or lost answer as such and never assumes delivery", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children);
      await nativeInput(adapter, child, "host-x", "addition");
      const missing = adapter.controlNativeInput(SESSION, { inputId: "host-x", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      // A relayed or older answer without the send_now field is not a receipt.
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [] });
      await expect(missing).resolves.toEqual({ outcome: "unknown", reason: "uncertain" });
      const refused = adapter.controlNativeInput(SESSION, { inputId: "host-x", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 2);
      // Claude refused this one request; the capability itself is not withdrawn.
      emit(child, { type: "control_response", response: { subtype: "error", request_id: controlRequests(child, "interrupt")[1]!.request_id, error: "invalid request" } });
      await expect(refused).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      const lost = adapter.controlNativeInput(SESSION, { inputId: "host-x", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 3);
      const turnSettled = expect(turn).rejects.toThrow();
      child.close(1);
      await expect(lost).resolves.toEqual({ outcome: "unknown", reason: "uncertain" });
      await turnSettled;
      // Nothing was resent and nothing else was asked of Claude.
      expect(users(child)).toHaveLength(2);
      expect(controlRequests(child).every((line) => line.request!.send_now === true)).toBe(true);
    } finally { await adapter.destroy(); }
  });

  it("answers a definite rejection when no control was written, so a later attempt can act", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const admitted = adapter.steerActiveTurn(SESSION, { text: "late ack", throwOnError: true, nativeInput: { id: "host-late", onProgress: () => undefined } });
      await waitFor(() => users(child).length === 2);
      const uuid = users(child)[1]!.uuid!;
      const failed = expect(admitted).rejects.toThrow("did not acknowledge");
      // Withdraw and send-now asked before Claude acknowledged the input itself.
      const withdraw = adapter.controlNativeInput(SESSION, { inputId: "host-late", action: "cancel" });
      const now = adapter.controlNativeInput(SESSION, { inputId: "host-late", action: "send-now" });
      await vi.advanceTimersByTimeAsync(5_100);
      await failed;
      vi.useRealTimers();
      await expect(withdraw).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      await expect(now).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      expect(controlRequests(child)).toHaveLength(0);
      // Claude acknowledges a moment later: a new attempt is evaluated afresh.
      lifecycle(child, uuid, "queued");
      const retry = adapter.controlNativeInput(SESSION, { inputId: "host-late", action: "cancel" });
      await waitFor(() => controlRequests(child, "cancel_async_message").length === 1);
      ack(child, controlRequests(child, "cancel_async_message")[0]!, { cancelled: true });
      await expect(retry).resolves.toEqual({ outcome: "accepted", result: "cancelled" });
      // The held input's continuation is not part of this check.
      void turn.catch(() => undefined);
    } finally { vi.useRealTimers(); await adapter.destroy(); }
  });

  it("keeps a written control without Claude's answer uncertain", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children);
      await nativeInput(adapter, child, "host-written", "addition");
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const withdraw = adapter.controlNativeInput(SESSION, { inputId: "host-written", action: "cancel" });
      await waitFor(() => controlRequests(child, "cancel_async_message").length === 1);
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      await expect(withdraw).resolves.toEqual({ outcome: "unknown", reason: "uncertain" });
      void turn.catch(() => undefined);
    } finally { vi.useRealTimers(); await adapter.destroy(); }
  });

  it("refuses send-now and withdrawal once Claude has taken the input in", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children);
      const { uuid } = await nativeInput(adapter, child, "host-taken", "addition");
      lifecycle(child, uuid, "started");
      const before = child.stdin.lines.length;
      await expect(adapter.controlNativeInput(SESSION, { inputId: "host-taken", action: "send-now" })).resolves.toEqual({ outcome: "rejected", result: "not_queued" });
      await expect(adapter.controlNativeInput(SESSION, { inputId: "host-taken", action: "cancel" })).resolves.toEqual({ outcome: "rejected", result: "not_queued" });
      expect(child.stdin.lines.length).toBe(before);
      emit(child, { type: "result", subtype: "success", result: "done" });
      await turn;
    } finally { await adapter.destroy(); }
  });
});

describe("Claude native send-now boundaries", () => {
  it("refuses send-now while the host turn only waits for the input to run next", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid } = await nativeInput(adapter, child, "host-wait", "next");
      emit(child, { type: "result", subtype: "success", result: "first", user_message_uuid: prompt });
      await settle();
      // No turn of this input runs now (Claude may be running its own review).
      await expect(adapter.controlNativeInput(SESSION, { inputId: "host-wait", action: "send-now" })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      expect(controlRequests(child, "interrupt")).toHaveLength(0);
      lifecycle(child, uuid, "started");
      emit(child, { type: "result", subtype: "success", result: "second", user_message_uuid: uuid });
      await expect(turn).resolves.toMatchObject({ text: "first\nsecond" });
    } finally { await adapter.destroy(); }
  });

  it("allows one control at a time per input", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid } = await nativeInput(adapter, child, "host-one", "addition");
      const first = adapter.controlNativeInput(SESSION, { inputId: "host-one", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      await expect(adapter.controlNativeInput(SESSION, { inputId: "host-one", action: "send-now" })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      await expect(adapter.controlNativeInput(SESSION, { inputId: "host-one", action: "cancel" })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
      expect(controlRequests(child).map((line) => line.request!.subtype)).toEqual(["interrupt"]);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [uuid], send_now: "delivering" });
      await expect(first).resolves.toEqual({ outcome: "accepted", result: "delivering" });
      lifecycle(child, uuid, "started");
      emit(child, { type: "result", subtype: "success", result: "done", user_message_uuids: [prompt, uuid] });
      await turn;
    } finally { await adapter.destroy(); }
  });

  it("continues the turn when Claude, after answering delivering, still cuts it for the input", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid } = await nativeInput(adapter, child, "host-later", "addition");
      const sending = adapter.controlNativeInput(SESSION, { inputId: "host-later", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [uuid], send_now: "delivering" });
      await expect(sending).resolves.toEqual({ outcome: "accepted", result: "delivering" });
      // Moving the blocking work aside failed; Claude stops the turn later.
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", user_message_uuid: prompt });
      lifecycle(child, uuid, "started");
      emit(child, { type: "result", subtype: "success", result: "now answered", user_message_uuid: uuid });
      await expect(turn).resolves.toMatchObject({ text: "now answered" });
      expect(controlRequests(child, "cancel_async_message")).toHaveLength(0);
    } finally { await adapter.destroy(); }
  });

  it("treats a failure that is not a cut, or a cut after nothing_waiting, as a failure that withdraws the input", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      for (const [answer, terminal] of [["delivering", "model_error"], ["nothing_waiting", "aborted_tools"]] as const) {
        const { turn, child, prompt } = await startTurn(adapter, children);
        const id = `host-fail-${answer}`;
        const { uuid, progress } = await nativeInput(adapter, child, id, "addition");
        const sending = adapter.controlNativeInput(SESSION, { inputId: id, action: "send-now" });
        await waitFor(() => controlRequests(child, "interrupt").some((line) => line.request!.message_uuid === uuid));
        ack(child, controlRequests(child, "interrupt").find((line) => line.request!.message_uuid === uuid)!, { still_queued: [uuid], send_now: answer });
        await sending;
        const failed = expect(turn).rejects.toThrow("model failed");
        emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: terminal, result: "model failed", user_message_uuid: prompt });
        await failed;
        await waitFor(() => controlRequests(child, "cancel_async_message").some((line) => line.request!.message_uuid === uuid));
        lifecycle(child, uuid, "cancelled");
        ack(child, controlRequests(child, "cancel_async_message").find((line) => line.request!.message_uuid === uuid)!, { cancelled: true });
        await waitFor(() => progress.at(-1)?.state === "dropped");
        expect(progress.at(-1)).toEqual({ state: "dropped", reason: "turn_failed" });
      }
    } finally { await adapter.destroy(); }
  });

  it("does not treat a later abort as a cut for an ordinary input once the send-now input was taken in", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const n = await nativeInput(adapter, child, "host-n", "send this now");
      const sending = adapter.controlNativeInput(SESSION, { inputId: "host-n", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [n.uuid], send_now: "delivering" });
      await sending;
      lifecycle(child, n.uuid, "started");
      const m = await nativeInput(adapter, child, "host-m", "ordinary follow-up");
      const failed = expect(turn).rejects.toThrow("stalled");
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", result: "stalled", user_message_uuid: prompt, user_message_uuids: [prompt, n.uuid] });
      await failed;
      await waitFor(() => controlRequests(child, "cancel_async_message").some((line) => line.request!.message_uuid === m.uuid));
    } finally { await adapter.destroy(); }
  });

  it("marks a cut answer as interrupted, not as taken over, when the waiting input is then stopped", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child, prompt } = await startTurn(adapter, children, { abortSignal: stop.signal });
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "Partial answer" }] } });
      const { uuid, progress } = await nativeInput(adapter, child, "host-gap", "addition");
      const sending = adapter.controlNativeInput(SESSION, { inputId: "host-gap", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [uuid], send_now: "stopped" });
      await sending;
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", user_message_uuid: prompt });
      await settle();
      stop.abort(APP_USER_STOP_REASON);
      await waitFor(() => controlRequests(child, "cancel_async_message").length === 1);
      lifecycle(child, uuid, "cancelled");
      ack(child, controlRequests(child, "cancel_async_message")[0]!, { cancelled: true });
      await expect(turn).resolves.toMatchObject({ text: "Partial answer\n\n（以上回答在中途被中断。）" });
      await waitFor(() => progress.at(-1)?.state === "dropped");
      expect(progress.at(-1)).toEqual({ state: "dropped", reason: "stopped" });
    } finally { await adapter.destroy(); }
  });

  it("does not report a withdrawn input as admitted again when its id is retried", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children);
      const { uuid } = await nativeInput(adapter, child, "host-gone", "addition");
      const cancelling = adapter.controlNativeInput(SESSION, { inputId: "host-gone", action: "cancel" });
      await waitFor(() => controlRequests(child, "cancel_async_message").length === 1);
      lifecycle(child, uuid, "cancelled");
      ack(child, controlRequests(child, "cancel_async_message")[0]!, { cancelled: true });
      await cancelling;
      const replayed: NativeInputProgress[] = [];
      await expect(adapter.steerActiveTurn(SESSION, { text: "addition", throwOnError: true, nativeInput: { id: "host-gone", onProgress: (item) => { replayed.push(item); } } })).rejects.toMatchObject({ reason: "stale" });
      expect(replayed).toEqual([{ state: "cancelled", reason: "retracted" }]);
      expect(users(child)).toHaveLength(2);
      emit(child, { type: "result", subtype: "success", result: "done" });
      await turn;
    } finally { await adapter.destroy(); }
  });
});

describe("Claude native send-now with several ordered inputs", () => {
  async function twoInputs(adapter: ClaudeStreamAdapter, child: FakeChild) {
    const a = await nativeInput(adapter, child, "host-a", "first, ordinary");
    const b = await nativeInput(adapter, child, "host-b", "second, send now");
    expect(users(child).slice(-2).map((line) => line.message!.content[0]!.text)).toEqual(["first, ordinary", "second, send now"]);
    return { a, b };
  }

  it("folds both, in order, when Claude moves the running call aside (delivering)", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { a, b } = await twoInputs(adapter, child);
      const sending = adapter.controlNativeInput(SESSION, { inputId: "host-b", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      expect(controlRequests(child, "interrupt")[0]!.request).toEqual({ subtype: "interrupt", send_now: true, message_uuid: b.uuid });
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [a.uuid, b.uuid], send_now: "delivering" });
      await expect(sending).resolves.toEqual({ outcome: "accepted", result: "delivering" });
      lifecycle(child, a.uuid, "started");
      lifecycle(child, b.uuid, "started");
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "both" }] } });
      lifecycle(child, a.uuid, "completed");
      lifecycle(child, b.uuid, "completed");
      emit(child, { type: "result", subtype: "success", result: "both", user_message_uuid: prompt, user_message_uuids: [prompt, a.uuid, b.uuid] });
      await expect(turn).resolves.toMatchObject({ text: "both" });
      expect(a.progress.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
      expect(b.progress.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
    } finally { await adapter.destroy(); }
  });

  it("continues with both, ahead-first, when Claude cuts the turn and runs them as one turn", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "Partial" }] } });
      const { a, b } = await twoInputs(adapter, child);
      const sending = adapter.controlNativeInput(SESSION, { inputId: "host-b", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [a.uuid, b.uuid], send_now: "stopped" });
      await sending;
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", user_message_uuid: prompt, user_message_uuids: [prompt] });
      lifecycle(child, prompt, "cancelled");
      lifecycle(child, a.uuid, "started");
      lifecycle(child, b.uuid, "started");
      emit(child, { type: "assistant", user_message_uuid: b.uuid, user_message_uuids: [a.uuid, b.uuid], message: { content: [{ type: "text", text: "A then B" }] } });
      expect(a.progress.at(-1)).toEqual({ state: "received" });
      expect(b.progress.at(-1)).toEqual({ state: "received" });
      emit(child, { type: "result", subtype: "success", result: "A then B", user_message_uuid: b.uuid, user_message_uuids: [a.uuid, b.uuid] });
      await expect(turn).resolves.toMatchObject({ text: "Partial\n\n（Claude 为立即发送的消息中断了以上回答。）\nA then B" });
      expect(controlRequests(child, "cancel_async_message")).toHaveLength(0);
    } finally { await adapter.destroy(); }
  });

  it("continues through each in order when Claude cuts the turn and runs them one after the other", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "Partial" }] } });
      const { a, b } = await twoInputs(adapter, child);
      const sending = adapter.controlNativeInput(SESSION, { inputId: "host-b", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [a.uuid, b.uuid], send_now: "stopped" });
      await sending;
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", user_message_uuid: prompt });
      lifecycle(child, a.uuid, "started");
      emit(child, { type: "assistant", user_message_uuid: a.uuid, user_message_uuids: [a.uuid], message: { content: [{ type: "text", text: "A answer" }] } });
      emit(child, { type: "result", subtype: "success", result: "A answer", user_message_uuid: a.uuid, user_message_uuids: [a.uuid] });
      lifecycle(child, a.uuid, "completed");
      let settled = false;
      void turn.then(() => { settled = true; }, () => { settled = true; });
      await settle();
      expect(settled).toBe(false);
      lifecycle(child, b.uuid, "started");
      emit(child, { type: "assistant", user_message_uuid: b.uuid, user_message_uuids: [b.uuid], message: { content: [{ type: "text", text: "B answer" }] } });
      emit(child, { type: "result", subtype: "success", result: "B answer", user_message_uuid: b.uuid, user_message_uuids: [b.uuid] });
      await expect(turn).resolves.toMatchObject({ text: "Partial\n\n（Claude 为立即发送的消息中断了以上回答。）\nA answer\nB answer" });
      expect(a.progress.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
      expect(b.progress.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
    } finally { await adapter.destroy(); }
  });
});

describe("Claude native input receipt races", () => {
  it("keeps the continuation when Claude's stopped answer arrives after the input already started", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid, progress } = await nativeInput(adapter, child, "host-late-answer", "now");
      const sending = adapter.controlNativeInput(SESSION, { inputId: "host-late-answer", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", user_message_uuid: prompt });
      lifecycle(child, prompt, "cancelled");
      lifecycle(child, uuid, "started");
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [uuid], send_now: "stopped" });
      await expect(sending).resolves.toEqual({ outcome: "accepted", result: "stopped" });
      emit(child, { type: "assistant", user_message_uuids: [uuid], user_message_uuid: uuid, message: { content: [{ type: "text", text: "now answered" }] } });
      emit(child, { type: "result", subtype: "success", result: "now answered", user_message_uuid: uuid, user_message_uuids: [uuid] });
      await expect(turn).resolves.toMatchObject({ text: "now answered" });
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
    } finally { await adapter.destroy(); }
  });

  it("reports Claude's delivering answer as given even when the input was taken in first", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid, progress } = await nativeInput(adapter, child, "host-fast", "now");
      const sending = adapter.controlNativeInput(SESSION, { inputId: "host-fast", action: "send-now" });
      await waitFor(() => controlRequests(child, "interrupt").length === 1);
      lifecycle(child, uuid, "started");
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [], send_now: "delivering" });
      await expect(sending).resolves.toEqual({ outcome: "accepted", result: "delivering" });
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
      emit(child, { type: "result", subtype: "success", result: "ok", user_message_uuids: [prompt, uuid] });
      await turn;
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
    } finally { await adapter.destroy(); }
  });

  it("follows Claude's answer, not arrival order, for withdrawal", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      // Taken in while the withdrawal was on its way: not withdrawn.
      const late = await nativeInput(adapter, child, "host-raced", "raced");
      const failing = adapter.controlNativeInput(SESSION, { inputId: "host-raced", action: "cancel" });
      await waitFor(() => controlRequests(child, "cancel_async_message").length === 1);
      lifecycle(child, late.uuid, "started");
      ack(child, controlRequests(child, "cancel_async_message")[0]!, { cancelled: false });
      await expect(failing).resolves.toEqual({ outcome: "rejected", result: "not_queued" });
      expect(late.progress.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      // Answer before its lifecycle frame: reported once.
      const early = await nativeInput(adapter, child, "host-early", "withdraw me");
      const cancelling = adapter.controlNativeInput(SESSION, { inputId: "host-early", action: "cancel" });
      await waitFor(() => controlRequests(child, "cancel_async_message").length === 2);
      ack(child, controlRequests(child, "cancel_async_message")[1]!, { cancelled: true });
      await expect(cancelling).resolves.toEqual({ outcome: "accepted", result: "cancelled" });
      lifecycle(child, early.uuid, "cancelled");
      expect(early.progress).toEqual([{ state: "queued" }, { state: "cancelled", reason: "retracted" }]);
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
      emit(child, { type: "result", subtype: "success", result: "done", user_message_uuids: [prompt, late.uuid] });
      await expect(turn).resolves.toMatchObject({ text: "done" });
    } finally { await adapter.destroy(); }
  });
});

describe("Claude native input withdrawal", () => {
  it("withdraws a queued input only on Claude's cancelled:true, without a drop notice", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children);
      const outcomes: unknown[] = [];
      const { uuid, progress } = await nativeInput(adapter, child, "host-c", "never mind", (outcome) => { outcomes.push(outcome); });
      const cancelling = adapter.controlNativeInput(SESSION, { inputId: "host-c", action: "cancel" });
      await waitFor(() => controlRequests(child, "cancel_async_message").length === 1);
      const request = controlRequests(child, "cancel_async_message")[0]!;
      expect(request.request).toEqual({ subtype: "cancel_async_message", message_uuid: uuid });
      // Claude closes the command before it answers.
      lifecycle(child, uuid, "cancelled");
      expect(progress.map((item) => item.state)).toEqual(["queued"]);
      ack(child, request, { cancelled: true });
      await expect(cancelling).resolves.toEqual({ outcome: "accepted", result: "cancelled" });
      expect(progress).toEqual([{ state: "queued" }, { state: "cancelled", reason: "retracted" }]);
      await expect(adapter.controlNativeInput(SESSION, { inputId: "host-c", action: "cancel" })).resolves.toEqual({ outcome: "accepted", result: "cancelled" });
      emit(child, { type: "result", subtype: "success", result: "done" });
      await expect(turn).resolves.toMatchObject({ text: "done" });
      expect(outcomes).toEqual([]);
      expect(controlRequests(child, "cancel_async_message")).toHaveLength(1);
    } finally { await adapter.destroy(); }
  });

  it("never claims a withdrawal Claude answered cancelled:false, and keeps following the input", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid, progress } = await nativeInput(adapter, child, "host-late", "addition");
      const cancelling = adapter.controlNativeInput(SESSION, { inputId: "host-late", action: "cancel" });
      await waitFor(() => controlRequests(child, "cancel_async_message").length === 1);
      ack(child, controlRequests(child, "cancel_async_message")[0]!, { cancelled: false });
      await expect(cancelling).resolves.toEqual({ outcome: "rejected", result: "not_queued" });
      expect(progress.map((item) => item.state)).toEqual(["queued"]);
      lifecycle(child, uuid, "started");
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
      emit(child, { type: "result", subtype: "success", result: "done", user_message_uuids: [prompt, uuid] });
      expect(progress.map((item) => item.state)).toEqual(["queued", "dequeued", "received"]);
      await turn;
    } finally { await adapter.destroy(); }
  });

  it("releases the held turn when the last waiting continuation input is withdrawn", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid } = await nativeInput(adapter, child, "host-held", "and then something");
      emit(child, { type: "result", subtype: "success", result: "first answer", user_message_uuid: prompt });
      let settled = false;
      void turn.then(() => { settled = true; }, () => { settled = true; });
      await settle();
      expect(settled).toBe(false);
      const cancelling = adapter.controlNativeInput(SESSION, { inputId: "host-held", action: "cancel" });
      await waitFor(() => controlRequests(child, "cancel_async_message").length === 1);
      lifecycle(child, uuid, "cancelled");
      ack(child, controlRequests(child, "cancel_async_message")[0]!, { cancelled: true });
      await expect(cancelling).resolves.toEqual({ outcome: "accepted", result: "cancelled" });
      // The user's own withdrawal adds no "did not enter" notice.
      await expect(turn).resolves.toMatchObject({ text: "first answer" });
    } finally { await adapter.destroy(); }
  });
});

describe("Claude native input at stop and exit", () => {
  it("reports an input taken into a turn that is then stopped as unknown, not dropped", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const stop = new AbortController();
      const { turn, child, prompt } = await startTurn(adapter, children, { abortSignal: stop.signal });
      const { uuid, progress } = await nativeInput(adapter, child, "host-s11", "addition");
      lifecycle(child, uuid, "started");
      requesting(child, [prompt, uuid]);
      const stopped = expect(turn).rejects.toThrow("stopped by user");
      stop.abort(APP_USER_STOP_REASON);
      ack(child, controlRequests(child, "interrupt")[0]!, { still_queued: [], turn: "stopped" });
      lifecycle(child, uuid, "cancelled");
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", user_message_uuid: prompt, user_message_uuids: [prompt, uuid] });
      lifecycle(child, prompt, "cancelled");
      await stopped;
      // It may remain in the session's history although no reply to it began.
      expect(progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "unknown", reason: "interrupted_before_receipt" }]);
    } finally { await adapter.destroy(); }
  });

  it("drops a queued input at stop only when Claude confirms the withdrawal", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      for (const [answer, expected] of [[true, { state: "dropped", reason: "stopped" }], [false, { state: "unknown", reason: "withdraw_unconfirmed" }]] as const) {
        const stop = new AbortController();
        const { turn, child } = await startTurn(adapter, children, { abortSignal: stop.signal });
        const before = controlRequests(child, "cancel_async_message").length;
        const { uuid, progress } = await nativeInput(adapter, child, `host-stop-${answer}`, "addition");
        const stopped = expect(turn).rejects.toThrow("stopped by user");
        stop.abort(APP_USER_STOP_REASON);
        await waitFor(() => controlRequests(child, "cancel_async_message").length > before);
        const interrupt = controlRequests(child, "interrupt").at(-1)!;
        ack(child, interrupt, { still_queued: [], turn: "stopped" });
        lifecycle(child, uuid, "cancelled");
        ack(child, controlRequests(child, "cancel_async_message").find((line) => line.request!.message_uuid === uuid)!, { cancelled: answer });
        emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", user_message_uuid: users(child).at(-2)!.uuid });
        lifecycle(child, users(child).at(-2)!.uuid!, "cancelled");
        await stopped;
        expect(progress.at(-1)).toEqual(expected);
      }
    } finally { await adapter.destroy(); }
  });

  it("marks inputs without a final state unknown when the process exits, but never re-reports one whose turn completed", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      // An older CLI (lifecycle, no request markers) never gives a model receipt.
      const { turn, child } = await startTurn(adapter, children, { capabilities: CAPABILITIES_307 });
      const done = await nativeInput(adapter, child, "host-done", "folded");
      lifecycle(child, done.uuid, "started");
      emit(child, { type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
      lifecycle(child, done.uuid, "completed");
      expect(done.progress.map((item) => item.state)).toEqual(["queued", "dequeued"]);
      emit(child, { type: "result", subtype: "success", result: "done" });
      await turn;
      expect(done.progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "unknown", reason: "ended_without_model_receipt" }]);
      const second = await startTurn(adapter, children, { capabilities: CAPABILITIES_307 });
      const waiting = await nativeInput(adapter, second.child, "host-wait", "still queued");
      const failed = expect(second.turn).rejects.toThrow();
      child.close(1);
      await failed;
      expect(waiting.progress.at(-1)).toEqual({ state: "unknown", reason: "engine_exit" });
      expect(done.progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "unknown", reason: "ended_without_model_receipt" }]);
      await expect(adapter.controlNativeInput(SESSION, { inputId: "host-wait", action: "cancel" })).resolves.toEqual({ outcome: "rejected", reason: "stale" });
    } finally { await adapter.destroy(); }
  });
});

describe("Claude calls moved to the background mid-run", () => {
  it("keeps a call reported as moved by its result bound to its turn, even without task_updated", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const events: EngineStreamEvent[] = [];
      const { turn, child } = await startTurn(adapter, children, { events });
      emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_build", name: "Bash", input: { command: "make all" } }] } });
      emit(child, { type: "system", subtype: "task_started", task_id: "bbuild", tool_use_id: "toolu_build", task_type: "local_bash", description: "Build", is_backgrounded: false });
      // The Ctrl+B-equivalent result, with no task_updated frame observed.
      emit(child, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_build", content: "Command was manually backgrounded by user with ID: bbuild." }] },
        tool_use_result: { stdout: "", backgroundTaskId: "bbuild", backgroundedByUser: true } });
      emit(child, { type: "result", subtype: "success", result: "continuing" });
      await turn;
      expect(events.filter((event) => event.type === "background_task_started")).toEqual([expect.objectContaining({ taskId: "bbuild", origin: "bound" })]);
      emit(child, { type: "system", subtype: "task_notification", task_id: "bbuild", tool_use_id: "toolu_build", status: "completed", summary: "Build" });
      await waitFor(() => events.some((event) => event.type === "background_task_finished"));
      expect(events.find((event) => event.type === "background_task_finished")).toMatchObject({ taskId: "bbuild", origin: "bound" });
    } finally { await adapter.destroy(); }
  });

  it("does not adopt an ordinary foreground call that simply finished", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const events: EngineStreamEvent[] = [];
      const { turn, child } = await startTurn(adapter, children, { events });
      emit(child, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_ls", name: "Bash", input: { command: "ls" } }] } });
      emit(child, { type: "system", subtype: "task_started", task_id: "bls", tool_use_id: "toolu_ls", task_type: "local_bash", description: "List", is_backgrounded: false });
      emit(child, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_ls", content: "a b c" }] }, tool_use_result: { stdout: "a b c", interrupted: false } });
      emit(child, { type: "system", subtype: "task_notification", task_id: "bls", tool_use_id: "toolu_ls", status: "completed" });
      emit(child, { type: "result", subtype: "success", result: "listed" });
      await turn;
      expect(events.filter((event) => event.type === "background_task_started" || event.type === "background_task_finished")).toEqual([]);
    } finally { await adapter.destroy(); }
  });
});

describe("Claude native input unknown reasons", () => {
  it("publishes a changed unknown reason before releasing the observer", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child } = await startTurn(adapter, children);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const progress: NativeInputProgress[] = [];
      const admitted = adapter.steerActiveTurn(SESSION, { text: "unacknowledged", throwOnError: true, nativeInput: { id: "host-why", onProgress: (item) => { progress.push(item); } } });
      await waitFor(() => users(child).length === 2);
      const uuid = users(child)[1]!.uuid!;
      const failed = expect(admitted).rejects.toThrow("did not acknowledge");
      await vi.advanceTimersByTimeAsync(5_100);
      await failed;
      vi.useRealTimers();
      expect(progress).toEqual([{ state: "unknown", reason: "no_admission_receipt" }]);
      // Claude later closes it as consumed by a turn that ended, without any receipt.
      lifecycle(child, uuid, "completed");
      expect(progress).toEqual([{ state: "unknown", reason: "no_admission_receipt" }, { state: "unknown", reason: "ended_without_model_receipt" }]);
      // Settled now: nothing more is published, and the same reason is not repeated.
      emit(child, { type: "result", subtype: "success", result: "done" });
      await turn;
      child.close(0);
      expect(progress).toHaveLength(2);
    } finally { vi.useRealTimers(); await adapter.destroy(); }
  });

  it("never lets a process exit replace a known unknown reason", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const { uuid, progress } = await nativeInput(adapter, child, "host-exit", "addition");
      lifecycle(child, uuid, "started");
      const failed = expect(turn).rejects.toThrow();
      emit(child, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "model_error", result: "model failed", user_message_uuid: prompt, user_message_uuids: [prompt, uuid] });
      await failed;
      expect(progress.at(-1)).toEqual({ state: "unknown", reason: "interrupted_before_receipt" });
      child.close(1);
      await settle();
      expect(progress).toEqual([{ state: "queued" }, { state: "dequeued" }, { state: "unknown", reason: "interrupted_before_receipt" }]);
    } finally { await adapter.destroy(); }
  });
});

describe("Claude continuation with messages that ran together", () => {
  it("settles when two waiting additions run as one native turn named after the last", async () => {
    spyKill();
    const { adapter, children } = setup();
    try {
      const { turn, child, prompt } = await startTurn(adapter, children);
      const a = adapter.steerActiveTurn(SESSION, { text: "first" });
      const b = adapter.steerActiveTurn(SESSION, { text: "second" });
      await waitFor(() => users(child).length === 3);
      const [, inputA, inputB] = users(child);
      lifecycle(child, inputA!.uuid!, "queued");
      lifecycle(child, inputB!.uuid!, "queued");
      await Promise.all([a, b]);
      emit(child, { type: "result", subtype: "success", result: "first part", user_message_uuid: prompt });
      lifecycle(child, inputA!.uuid!, "started");
      lifecycle(child, inputB!.uuid!, "started");
      emit(child, { type: "result", subtype: "success", result: "both additions", user_message_uuid: inputB!.uuid, user_message_uuids: [inputA!.uuid, inputB!.uuid] });
      await expect(turn).resolves.toMatchObject({ text: "first part\nboth additions" });
    } finally { await adapter.destroy(); }
  });
});
