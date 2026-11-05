import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { ClaudeStreamAdapter, claudeTransientRetryReason } from "../src/codex/claude-stream-adapter.js";
import { EngineRetryableError } from "../src/codex/turn-retry.js";
import { ENGINE_RECOVERY_CONTINUATION } from "../src/runtime/engine-recovery.js";

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met in time");
}

class FakeStream extends EventEmitter {
  emitData(chunk: string) { this.emit("data", chunk); }
}

class FakeClaudeChild extends EventEmitter {
  stdin = { lines: [] as string[], write(chunk: string, callback?: (error?: Error | null) => void) { const text = chunk.toString().trim(); if (text) this.lines.push(text); callback?.(null); return true; } };
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill() {}
  close(code: number | null) { this.emit("close", code); }
  send(frame: Record<string, unknown>) { this.stdout.emitData(`${JSON.stringify({ session_id: "native-1", ...frame })}\n`); }
}

const overloaded = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

function boot() {
  const children: FakeClaudeChild[] = [];
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn: () => { const child = new FakeClaudeChild(); children.push(child); return child as never; } });
  const start = (sessionId: string, options: { abortSignal?: AbortSignal; text?: string } = {}) => {
    const events: EngineStreamEvent[] = [];
    const result = adapter.sendUserMessage(sessionId, { text: options.text ?? "ORIGINAL PROJECT REQUEST", files: [], abortSignal: options.abortSignal, onEngineEvent: (event) => { events.push(event); } })
      .then((response) => ({ response, error: undefined as unknown }), (error: unknown) => ({ response: undefined, error }));
    return { events, result };
  };
  return { adapter, children, start };
}

function expectReceipt(error: unknown, expected: Record<string, unknown>) {
  expect(error).toBeInstanceOf(EngineRetryableError);
  expect((error as EngineRetryableError).retry).toMatchObject(expected);
  return error as EngineRetryableError;
}

describe("Claude native transient retry receipts", () => {
  it("continues the real native session after a 529 result on a new logical conversation", async () => {
    const { adapter, children, start } = boot();
    try {
      const turn = start("tarobot-301");
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0]!.send({ type: "system", subtype: "init" });
      children[0]!.send({ type: "result", subtype: "error_during_execution", is_error: true, result: overloaded, api_error_status: 529, usage: { input_tokens: 40, output_tokens: 2 }, total_cost_usd: 0.01 });
      const { error } = await turn.result;
      expect(turn.events.filter((event) => event.type === "session")).toEqual([{ type: "session", sessionId: "native-1" }]);
      const receipt = expectReceipt(error, { sessionId: "native-1", mode: "continue", reason: "capacity", usage: { inputTokens: 40, outputTokens: 2, costUsd: 0.01 } });
      expect(receipt.message).toBe(overloaded);

      // The receipt's session reaches the same live worker; no replacement process or session.
      const resumed = start(receipt.retry.sessionId, { text: "continue" });
      await waitFor(() => children[0]!.stdin.lines.length === 2);
      children[0]!.send({ type: "result", result: "continued" });
      expect((await resumed.result).response?.text).toBe("continued");
      expect(children).toHaveLength(1);
    } finally { await adapter.destroy(); }
  });

  it("uses the structured status when the CLI reports no result text", async () => {
    const { adapter, children, start } = boot();
    try {
      const turn = start("tarobot-302");
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0]!.send({ type: "system", subtype: "init" });
      children[0]!.send({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: "503" });
      expectReceipt((await turn.result).error, { sessionId: "native-1", mode: "continue", reason: "connection" });
    } finally { await adapter.destroy(); }
  });

  it("keeps the interrupted-turn note out of the automatic continuation, but not the user's next message", async () => {
    const { adapter, children, start } = boot();
    const note = "resume a stopped task";
    const failWithTool = (child: FakeClaudeChild, id: string) => {
      child.send({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: "Bash", input: { command: "touch out.txt" } }] } });
      child.send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "" }] } });
      child.send({ type: "result", subtype: "error_during_execution", is_error: true, result: overloaded, api_error_status: 529 });
    };
    const prompt = (child: FakeClaudeChild, index: number) => JSON.stringify(JSON.parse(child.stdin.lines[index]!));
    try {
      const turn = start("tarobot-310");
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      const child = children[0]!;
      child.send({ type: "system", subtype: "init" });
      failWithTool(child, "t1");
      const receipt = expectReceipt((await turn.result).error, { sessionId: "native-1", mode: "continue" });
      const continued = adapter.sendUserMessage(receipt.retry.sessionId, { text: ENGINE_RECOVERY_CONTINUATION, files: [], engineRecoveryContinuation: true })
        .then(() => undefined, (error: unknown) => error);
      await waitFor(() => child.stdin.lines.length === 2);
      expect(prompt(child, 1)).toContain("Continue the user's unfinished task");
      expect(prompt(child, 1)).not.toContain(note);
      failWithTool(child, "t2");
      expect(await continued).toBeInstanceOf(EngineRetryableError);
      // Recovery ended without success: the user's own next message keeps the observed facts.
      const manual = start(receipt.retry.sessionId, { text: "继续" });
      await waitFor(() => child.stdin.lines.length === 3);
      expect(prompt(child, 2)).toContain(note);
      child.send({ type: "result", result: "done" });
      expect((await manual.result).response?.text).toBe("done");
    } finally { await adapter.destroy(); }
  });

  it("only continues, never replays, after tools and text already streamed", async () => {
    const { adapter, children, start } = boot();
    try {
      const turn = start("tarobot-303");
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      const child = children[0]!;
      child.send({ type: "system", subtype: "init" });
      child.send({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Editing" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "touch out.txt" } }] } });
      child.send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] } });
      child.send({ type: "result", subtype: "error_during_execution", is_error: true, result: overloaded, api_error_status: 529 });
      const { error } = await turn.result;
      expect(turn.events.map((event) => event.type)).toEqual(expect.arrayContaining(["tool_use", "tool_result"]));
      expectReceipt(error, { sessionId: "native-1", mode: "continue", reason: "capacity" });
    } finally { await adapter.destroy(); }
  });

  it.each([
    ["session limit reported as 429", { result: "You've hit your session limit · resets 11:20am (Asia/Shanghai)", api_error_status: 429 }],
    ["usage limit", { result: "Claude AI usage limit reached|1760000000", api_error_status: 429 }],
    ["plain 429 without rate_limit_error", { result: "API Error: 429 Too Many Requests", api_error_status: 429 }],
    ["authentication", { result: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}', api_error_status: 401 }],
    ["bad request", { result: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}', api_error_status: 400 }],
    ["no status", { result: "Claude reported an error" }],
  ])("keeps %s fatal", async (_label, frame) => {
    const { adapter, children, start } = boot();
    try {
      const turn = start("tarobot-304");
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0]!.send({ type: "system", subtype: "init" });
      children[0]!.send({ type: "result", subtype: "error_during_execution", is_error: true, ...frame });
      const { error } = await turn.result;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EngineRetryableError);
    } finally { await adapter.destroy(); }
  });

  it("marks an explicit rate_limit_error as rate-limit", async () => {
    const { adapter, children, start } = boot();
    try {
      const turn = start("tarobot-305");
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0]!.send({ type: "system", subtype: "init" });
      children[0]!.send({ type: "result", subtype: "error_during_execution", is_error: true, result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests exceeded"}}', api_error_status: 429 });
      expectReceipt((await turn.result).error, { mode: "continue", reason: "rate-limit" });
    } finally { await adapter.destroy(); }
  });

  it("withholds the receipt while a background task can absorb the continuation", async () => {
    const { adapter, children, start } = boot();
    try {
      const turn = start("tarobot-306");
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0]!.send({ type: "system", subtype: "init" });
      children[0]!.send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "toolu-bg", input: { command: "sleep 600", run_in_background: true } }] } });
      children[0]!.send({ type: "system", subtype: "task_started", task_id: "bg-1", tool_use_id: "toolu-bg" });
      expect(turn.events.some((event) => event.type === "background_task_started")).toBe(true);
      children[0]!.send({ type: "result", subtype: "error_during_execution", is_error: true, result: overloaded, api_error_status: 529 });
      const { error } = await turn.result;
      expect(error).not.toBeInstanceOf(EngineRetryableError);
    } finally { await adapter.destroy(); }
  });

  it("gives no receipt when the process exits or the user stops", async () => {
    const { adapter, children, start } = boot();
    try {
      const exited = start("tarobot-307");
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0]!.send({ type: "system", subtype: "init" });
      children[0]!.stderr.emitData("API Error: 529 overloaded\n");
      children[0]!.close(1);
      expect((await exited.result).error).not.toBeInstanceOf(EngineRetryableError);

      const controller = new AbortController();
      const stopped = start("tarobot-308", { abortSignal: controller.signal });
      await waitFor(() => children[1]?.stdin.lines.length === 1);
      children[1]!.send({ type: "system", subtype: "init", session_id: "native-2" });
      controller.abort();
      const { error } = await stopped.result;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EngineRetryableError);
    } finally { await adapter.destroy(); }
  });
});

describe("Claude cumulative cost ledger", () => {
  // Claude Code 2.1.307 (isolated fake-API probe): per-turn `usage`, but a
  // session-cumulative `total_cost_usd` that `-r` restores in a new process.
  const ok = (child: FakeClaudeChild, total: number, extra: Record<string, unknown> = {}) =>
    child.send({ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 1000, output_tokens: 100 }, total_cost_usd: total, ...extra });

  it("records each turn's increase, and a failed receipt never re-adds earlier spend", async () => {
    const { adapter, children, start } = boot();
    try {
      const first = start("tarobot-401");
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0]!.send({ type: "system", subtype: "init" });
      ok(children[0]!, 0.0045);
      expect((await first.result).response?.usage).toMatchObject({ inputTokens: 1000, costUsd: 0.0045 });

      const failed = start("native-1");
      await waitFor(() => children[0]!.stdin.lines.length === 2);
      children[0]!.send({ type: "result", subtype: "success", is_error: true, result: overloaded, api_error_status: 529, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0.0045 });
      expectReceipt((await failed.result).error, { usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });

      const resumed = start("native-1", { text: "continue" });
      await waitFor(() => children[0]!.stdin.lines.length === 3);
      ok(children[0]!, 0.009);
      expect((await resumed.result).response?.usage?.costUsd).toBe(0.0045);
    } finally { await adapter.destroy(); }
  });

  it("keeps the baseline across a respawn and leaves an unknown resumed baseline uncounted", async () => {
    const { adapter, children, start } = boot();
    try {
      const fresh = start("tarobot-402");
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0]!.send({ type: "system", subtype: "init" });
      ok(children[0]!, 0.009);
      expect((await fresh.result).response?.usage?.costUsd).toBe(0.009);
      children[0]!.close(0);

      // A new process resumes with -r and the CLI restores the cumulative ledger.
      const afterRespawn = start("native-1");
      await waitFor(() => children[1]?.stdin.lines.length === 1);
      ok(children[1]!, 0.0135);
      expect((await afterRespawn.result).response?.usage?.costUsd).toBe(0.0045);

      // A session this host process never recorded has no baseline: tokens only.
      const unknown = start("native-other");
      await waitFor(() => children[2]?.stdin.lines.length === 1);
      ok(children[2]!, 0.5, { session_id: "native-other" });
      const unknownUsage = (await unknown.result).response?.usage;
      expect(unknownUsage).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
      expect(unknownUsage?.costUsd).toBeUndefined();
      const next = start("native-other");
      await waitFor(() => children[2]!.stdin.lines.length === 2);
      ok(children[2]!, 0.5045, { session_id: "native-other" });
      expect((await next.result).response?.usage?.costUsd).toBe(0.0045);
    } finally { await adapter.destroy(); }
  });
});

describe("claudeTransientRetryReason", () => {
  it.each([
    [{ result: overloaded }, "capacity"],
    [{ api_error_status: 529 }, "capacity"],
    [{ result: "API Error: 502 Bad Gateway" }, "connection"],
    [{ api_error_status: "504" }, "connection"],
    [{ result: 'API Error: 429 {"error":{"type":"rate_limit_error"}}' }, "rate-limit"],
    [{ result: "API Error: 429 You've hit your limit · resets 3pm" }, undefined],
    [{ result: "API Error: 529 Overloaded", api_error_status: null }, "capacity"],
    [{ result: "The overloaded server said 529 in prose" }, undefined],
    [{ result: "API Error: 403 forbidden" }, undefined],
    [{}, undefined],
  ])("maps %j to %s", (frame, expected) => {
    expect(claudeTransientRetryReason(frame)).toBe(expected);
  });
});
