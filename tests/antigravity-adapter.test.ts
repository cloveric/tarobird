import { nativeRunProbe } from "./helpers/native-run.js";
import { runEntryTitle, runDiff, runPlan } from "../client/src/run-presentation.js";
import { summarizeRun } from "../src/core/run-record.js";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ProcessAntigravityAdapter } from "../src/codex/antigravity-adapter.js";
import { EngineIncompleteResponseError } from "../src/codex/adapter.js";
import { classifyFailure, getBusErrorSemantics } from "../src/runtime/error-classification.js";
import * as processTree from "../src/codex/process-tree.js";
import { APP_USER_STOP_REASON, APP_STOP_PROCESS_GRACE_MS } from "../src/runtime/turn-cancellation.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const CONVERSATION_ID = "11111111-2222-4333-8444-555555555555";

describe("ProcessAntigravityAdapter", () => {
  it.each([false, true].flatMap(goal => ["legacy-error", "exit-zero", "exit-error", "protocol-error"].map(end => ({ goal, end }))))("does not replay work when the terminal receipt is missing or legacy ($goal/$end)", async ({ goal, end }) => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    try {
      const failure = adapter.sendUserMessage("tarobot-incomplete-receipt", { text: goal ? "/goal inspect" : "inspect", files: [] }).then(() => undefined, error => error);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
      child.stdout.emitData(jsonLine({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, step_index: 1, step_type: "tool", state: "DONE", tool_name: "write_file", tool_info: { output: "saved" } } }));
      if (end === "legacy-error") child.stdout.emitData(jsonLine({ event: "result", result: { conversation_id: CONVERSATION_ID, status: "ERROR", response: "", error: "503 Service Unavailable" } }));
      if (end === "protocol-error") child.stdout.emitData(jsonLine({ event: "result", result: null }));
      child.close(end === "exit-error" ? 1 : 0);
      const error = await failure;
      expect(error).toBeInstanceOf(EngineIncompleteResponseError);
      expect(getBusErrorSemantics(classifyFailure(error))).toMatchObject({ retryable: false });
      expect(calls).toHaveLength(1);
    } finally { await adapter.destroy(); }
  });
  it.each([false, true])("keeps a successful tool-only empty response non-retryable (goal=%s)", async goal => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const events: Array<{ type: string }> = [];
    try {
      const turn = adapter.sendUserMessage("tarobot-tool-only-empty", { text: goal ? "/goal inspect" : "inspect", files: [], onEngineEvent: event => { events.push(event); } });
      const failure = turn.then(() => undefined, error => error);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
      child.stdout.emitData(jsonLine({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, step_index: 1, step_type: "tool", state: "DONE", tool_name: "write_file", tool_info: { output: "saved" } } }));
      child.stdout.emitData(jsonLine({ event: "result", result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: " \n" } }));
      child.close(0);
      const error = await failure;
      expect(error).toBeInstanceOf(EngineIncompleteResponseError);
      expect(getBusErrorSemantics(classifyFailure(error))).toMatchObject({ retryable: false });
      expect(events.some(event => event.type === "result")).toBe(false);
      expect(calls).toHaveLength(1);
    } finally { await adapter.destroy(); }
  });
  it.each([
    "unknown flag: --log-file",
    "Antigravity emitted result before init: Authentication required",
  ])("does not replay an incomplete turn because of diagnostic text: %s", async diagnostic => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const abort = new AbortController();
    let settled = false;
    try {
      const turn = adapter.sendUserMessage("tarobot-incomplete-diagnostic", { text: "inspect", files: [], abortSignal: abort.signal });
      const failure = turn.then(() => { settled = true; }, error => { settled = true; return error; });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
      child.stdout.emitData(jsonLine({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, step_index: 1, step_type: "agent_response", state: "DONE", text_delta: "partial answer" } }));
      child.stderr.emitData(diagnostic);
      child.stdout.emitData(jsonLine({ event: "result", result: { conversation_id: CONVERSATION_ID, status: "ERROR", response: "partial answer", finished_reason: "error" } }));
      await vi.waitFor(() => expect(settled || calls.length > 1).toBe(true));
      if (calls.length > 1) abort.abort();
      const error = await failure;
      expect(calls).toHaveLength(1);
      expect(error).toBeInstanceOf(EngineIncompleteResponseError);
    } finally { abort.abort(); await adapter.destroy(); }
  });
  it.each([false, true].flatMap(goal => ["ACTIVE", "DONE", "unindexed"].map(state => ({ goal, state }))))("does not make a tool-only failed turn retryable ($goal/$state)", async ({ goal, state }) => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const events: Array<{ type: string }> = [];
    try {
      const turn = adapter.sendUserMessage("tarobot-tool-only-finish", { text: goal ? "/goal inspect" : "inspect", files: [], onEngineEvent: event => { events.push(event); } });
      const failure = turn.then(() => undefined, error => error);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
      child.stdout.emitData(jsonLine({ event: "step_update", step_update: {
        conversation_id: CONVERSATION_ID, ...(state === "unindexed" ? {} : { step_index: 1 }),
        step_type: "tool", state: state === "unindexed" ? "ACTIVE" : state,
        tool_name: "write_file", tool_info: { parameters: { path: "example.txt", content: "saved" }, output: "saved" },
      } }));
      child.stdout.emitData(jsonLine({ event: "result", result: { conversation_id: CONVERSATION_ID, status: "ERROR", response: "", error: "503 Service Unavailable", finished_reason: "error" } }));
      child.close(0);
      const error = await failure;
      expect(error).toBeInstanceOf(EngineIncompleteResponseError);
      expect(getBusErrorSemantics(classifyFailure(error))).toMatchObject({ retryable: false });
      expect(events.some(event => event.type === "result")).toBe(false);
      expect(calls).toHaveLength(1);
    } finally { await adapter.destroy(); }
  });
  it.each([false, true].flatMap(goal => ["print_timeout", "interrupted", "error", "future_reason"].map(reason => ({ goal, reason }))))("rejects explicit early termination even after a DONE answer ($goal/$reason)", async ({ goal, reason }) => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const events: Array<{ type: string }> = [];
    try {
      const turn = adapter.sendUserMessage("tarobot-finish-reason", { text: goal ? "/goal inspect" : "inspect", files: [], onEngineEvent: event => { events.push(event); } });
      const rejected = expect(turn).rejects.toThrow(/Antigravity.*(timeout|interrupted|failed|unfinished)/i);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
      child.stdout.emitData(jsonLine({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, step_index: 1, step_type: "agent_response", state: "DONE", text_delta: "partial answer" } }));
      child.stderr.emitData("historic diagnostic: 401 from a prior attempt\n");
      child.stdout.emitData(jsonLine({ event: "result", result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "partial answer", finished_reason: reason } }));
      child.close(0);
      await rejected;
      await expect(turn).rejects.toBeInstanceOf(EngineIncompleteResponseError);
      expect(events.some(event => event.type === "assistant_text")).toBe(true);
      expect(events.some(event => event.type === "result")).toBe(false);
      expect(calls).toHaveLength(1);
    } finally { await adapter.destroy(); }
  });
  it.each([false, true])("preserves a native authentication error before any answer (goal=%s)", async goal => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    try {
      const turn = adapter.sendUserMessage("tarobot-auth-finish", { text: goal ? "/goal inspect" : "inspect", files: [] });
      const rejected = expect(turn).rejects.toThrow("Authentication required");
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
      child.stdout.emitData(jsonLine({ event: "result", result: { conversation_id: CONVERSATION_ID, status: "ERROR", response: "", error: "Authentication required", finished_reason: "error" } }));
      child.close(0); await rejected;
      await expect(turn).rejects.not.toBeInstanceOf(EngineIncompleteResponseError);
      expect(calls).toHaveLength(1);
    } finally { await adapter.destroy(); }
  });
  it.each([false, true])("preserves actual checkpoint receipts in both AGY paths (goal=%s)", async goal => {
    const { spawnAntigravity, child, calls } = createSpawnHarness(), probe = nativeRunProbe();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    try {
      const turn = adapter.sendUserMessage("tarobot-compact", { text: goal ? "/goal inspect" : "inspect", files: [], onEngineEvent: probe.onEngineEvent });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
      const step = (index: number, state: string, type = "checkpoint") => child.stdout.emitData(jsonLine({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, step_index: index, state, step_type: type, duration_seconds: 8.725516 } }));
      step(1, "DONE", "system_message"); expect(probe.record.entries).toHaveLength(0);
      step(2, "DONE"); step(2, "ACTIVE"); step(2, "DONE");
      expect(probe.record.entries).toHaveLength(1);
      expect(probe.record.entries[0]).toMatchObject({ name: "context_checkpoint", status: "done" });
      expect(probe.record.entries[0].durationMs).toBeCloseTo(8725.516);
      step(3, "ACTIVE");
      expect(runEntryTitle(summarizeRun(probe.record, "running").current!)).toBe("正在整理上下文摘要");
      step(3, "ERROR"); expect(probe.record.entries[1].status).toBe("error");
      child.stdout.emitData(jsonLine({ event: "result", result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "continued" } }));
      if (goal) child.close(0);
      await expect(turn).resolves.toMatchObject({ text: "continued" });
    } finally { await adapter.destroy(); }
  });
  it.each([
    { app: false, goal: false }, { app: true, goal: false },
    { app: false, goal: true }, { app: true, goal: true },
  ])("bounds only explicit App stops in both native paths ($app/$goal)", async ({ app, goal }) => {
    const kill = vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve());
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const abort = new AbortController();
    try {
      const turn = adapter.sendUserMessage("telegram-12345", { text: goal ? "/goal count numbers" : "Long answer", files: [], abortSignal: abort.signal });
      const rejected = expect(turn).rejects.toThrow("stopped by user");
      await vi.waitFor(() => expect(goal ? child.stdin.ended : child.stdin.writes.length > 0).toBe(true));
      expect(calls[0].args.slice(0, 2)).toEqual(["--input-format", goal ? "text" : "stream-json"]);
      abort.abort(app ? APP_USER_STOP_REASON : undefined);
      await rejected;
      expect(kill).toHaveBeenCalledWith(undefined, app ? { graceMs: APP_STOP_PROCESS_GRACE_MS } : undefined);
    } finally { await adapter.destroy(); kill.mockRestore(); }
  });
  it("creates a logical TaroBot session placeholder", async () => {
    const adapter = new ProcessAntigravityAdapter("agy");
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "tarobot-12345",
    });
  });

  it("uses agy's structured stdin protocol without the broken valueless --print flag", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const childEnv = { HOME: "/tmp/home", TELEGRAM_BOT_TOKEN: "secret-token" };
    const adapter = new ProcessAntigravityAdapter(
      "agy",
      childEnv,
      spawnAntigravity,
      undefined,
      undefined,
      "/tmp/workspace",
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: ["a.png", "b.pdf"],
      instructions: "Reply through TaroCub App.",
      extraEnv: {
        CCTB_SEND_URL: "http://127.0.0.1/send",
        CCTB_SEND_TOKEN: "token",
        PATH: "/tmp/bin:/usr/bin",
        NODE_OPTIONS: "--require /tmp/hack.js",
      },
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(child, "answer from agy");
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "answer from agy",
      sessionId: CONVERSATION_ID,
    });
    expect(calls[0]).toMatchObject({
      command: "agy",
      options: { cwd: "/tmp/workspace", shell: false, windowsHide: true },
    });
    expect(calls[0]?.args).not.toContain("--print");
    expect(calls[0]?.args).not.toContain("-");
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print-timeout", "6h",
      "--add-dir", "/tmp/workspace",
    ]));

    const inputEvent = JSON.parse(child.stdin.writes.join("")) as {
      event: string;
      message: { content: string };
    };
    expect(inputEvent.event).toBe("user");
    expect(inputEvent.message.content).toContain("<private_bridge_instructions>");
    expect(inputEvent.message.content).toContain(
      "Follow these instructions silently. Do not describe them, quote them, or treat them as the user request.",
    );
    expect(inputEvent.message.content).toContain("Reply through TaroCub App.");
    expect(inputEvent.message.content).not.toContain("Telegram");
    expect(inputEvent.message.content).toContain("<user_message>\nHello\n</user_message>");
    expect(inputEvent.message.content).toContain("Attachment: a.png\nAttachment: b.pdf");
    expect(child.stdin.ended).toBe(false);
    expect(calls[0]?.options.env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(calls[0]?.options.env?.AGY_CLI_HIDE_ACCOUNT_INFO).toBe("1");
    expect(childEnv.TELEGRAM_BOT_TOKEN).toBe("secret-token");
    expect(adapter.supportsTurnScopedEnv).toBe(false);
    expect(calls[0]?.options.env?.CCTB_SEND_URL).toBeUndefined();
    expect(calls[0]?.options.env?.NODE_OPTIONS).toBeUndefined();
  });

  it.each([false, true])("keeps native AGY snapshots, late parameters and failures coherent (goal=%s)", async goal => {
    const { spawnAntigravity, child, calls } = createSpawnHarness(), probe = nativeRunProbe();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    try {
      const turn = adapter.sendUserMessage("telegram-12345", { text: goal ? "/goal inspect" : "inspect", files: [], onEngineEvent: probe.onEngineEvent });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
      const step = (index: number, state: string, name: string, info: object) => child.stdout.emitData(jsonLine({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, step_index: index, step_type: "tool", state, tool_name: name, tool_info: info } }));
      step(1, "ACTIVE", "view_file", {});
      step(1, "ACTIVE", "view_file", { parameters: { AbsolutePath: "/report.md" } });
      expect(probe.record.entries).toHaveLength(1);
      expect(runEntryTitle(summarizeRun(probe.record, "running").current!)).toContain("report.md");
      step(1, "DONE", "view_file", { output: "document" });
      step(2, "ACTIVE", "run_command", { parameters: { CommandLine: "check", Description: "Check report" }, output: "one" });
      step(2, "ACTIVE", "run_command", { output: "one" });
      step(2, "ACTIVE", "run_command", { output: "one two" });
      expect(probe.record.entries[1].output).toBe("one two");
      expect(runEntryTitle(summarizeRun(probe.record, "running").current!)).toBe("Check report");
      step(2, "ERROR", "run_command", { error: "failed" });
      step(2, "ERROR", "run_command", { error: "failed" });
      expect(probe.record.entries[1]).toMatchObject({ status: "error", output: "failed" });
      expect(probe.events.filter(event => event.type === "tool_result")).toHaveLength(2);
      expect(probe.record.entries[1].exitCode).toBeUndefined();
      expect(probe.record.entries.some(entry => entry.kind === "thinking")).toBe(false);
      child.stdout.emitData(jsonLine({ event: "result", result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "Report complete" } }));
      child.close(0); await turn;
      expect(summarizeRun(probe.record, "done")).toMatchObject({ count: 2, failed: 1 });
    } finally { await adapter.destroy(); }
  });

  it("maps structured session, text, tool, result, and per-step usage events", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter(
      "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, undefined, "/tmp/workspace",
    );
    const onProgress = vi.fn();
    const onEngineEvent = vi.fn();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Use a tool", files: [], onProgress, onEngineEvent,
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({
      event: "init", conversation_id: CONVERSATION_ID, init: { cwd: "/tmp/workspace" },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 1, state: "DONE",
        step_type: "agent_response", text_delta: "hello ",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 3 },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 2, state: "ACTIVE", step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "pwd" } },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 2, state: "DONE", step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command", parameters: { CommandLine: "pwd" }, output: "/tmp/workspace\n",
        },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 3, state: "DONE",
        step_type: "agent_response", text_delta: "world",
        usage: { input_tokens: 4, output_tokens: 1, cache_read_tokens: 2 },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "hello world",
        usage: { input_tokens: 999, output_tokens: 888, cache_read_tokens: 777 },
      },
    }));
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "hello world",
      sessionId: CONVERSATION_ID,
      usage: { inputTokens: 14, outputTokens: 3, cachedTokens: 5 },
    });
    expect(onProgress).toHaveBeenNthCalledWith(1, "hello ");
    expect(onProgress).toHaveBeenNthCalledWith(2, "hello world");
    expect(onEngineEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "session", sessionId: CONVERSATION_ID },
      { type: "assistant_text", text: "hello ", delta: true, sessionId: CONVERSATION_ID },
      {
        type: "tool_use", toolName: "run_command", toolInput: { CommandLine: "pwd" },
        toolUseId: `${CONVERSATION_ID}:2`, sessionId: CONVERSATION_ID,
      },
      {
        type: "tool_result", toolName: "run_command", toolUseId: `${CONVERSATION_ID}:2`,
        output: "/tmp/workspace\n", isError: false, sessionId: CONVERSATION_ID,
      },
      { type: "assistant_text", text: "world", delta: true, sessionId: CONVERSATION_ID },
      { type: "result", text: "hello world", sessionId: CONVERSATION_ID },
    ]);
  });

  it("emits a terminal tool result only once when agy repeats the final step snapshot", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const onEngineEvent = vi.fn();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Use a tool", files: [], onEngineEvent,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    const terminalTool = jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 2, state: "DONE", step_type: "tool",
        tool_name: "run_command", tool_info: { output: "ok" },
      },
    });
    child.stdout.emitData(terminalTool);
    child.stdout.emitData(terminalTool);
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "done" },
    }));
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "done" });
    const terminalEvents = onEngineEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "tool_result");
    expect(terminalEvents).toHaveLength(1);
  });

  it("stops a persistent turn when a foreground tool stays silent past the inactivity ceiling", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter(
      "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, undefined, undefined,
      5_000, 200,
    );
    const turn = adapter.sendUserMessage("telegram-12345", { text: "Run a long command", files: [] });
    const rejected = expect(turn).rejects.toThrow("became inactive after 1 minutes");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 2, state: "ACTIVE", step_type: "tool",
        tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "sleep 60" } },
      },
    }));

    await rejected;
    expect(child.stdin.ended).toBe(true);
  });

  it("stops a native goal when a foreground tool stays silent past the inactivity ceiling", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter(
      "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, undefined, undefined,
      5_000, 200,
    );
    const turn = adapter.sendUserMessage("telegram-12345", { text: "/goal run a long command", files: [] });
    const rejected = expect(turn).rejects.toThrow("became inactive after 1 minutes");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 2, state: "ACTIVE", step_type: "tool",
        tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "sleep 60" } },
      },
    }));

    await rejected;
    expect(child.stdin.ended).toBe(true);
  });

  it("uses streamed answer text when a successful result carries an empty response", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Answer", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 1, state: "DONE",
        step_type: "agent_response", text_delta: "streamed answer",
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "" },
    }));
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "streamed answer" });
  });

  it("rejects a successful result that contains no response or streamed answer", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Create images", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "" },
    }));

    await expect(promise).rejects.toThrow("Antigravity completed without returning a response");
    await adapter.destroy();
  });

  it("settles each successful result while keeping the stream worker open", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const abortController = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Finish without close",
      files: [],
      abortSignal: abortController.signal,
    });
    const observed = promise.then(
      (response) => ({ status: "resolved" as const, response }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(child, "completed despite inherited stdio");

    const outcome = await Promise.race([
      observed,
      new Promise<{ status: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ status: "timeout" }), 750);
      }),
    ]);
    if (outcome.status === "timeout") abortController.abort();

    expect(outcome).toEqual({
      status: "resolved",
      response: {
        text: "completed despite inherited stdio",
        sessionId: CONVERSATION_ID,
      },
    });
    expect(child.stdin.ended).toBe(false);
    await observed;
  });

  it("quarantines persistent tail events after result before opening the next turn", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const firstProgress = vi.fn();
    const firstEvents = vi.fn();

    const first = adapter.sendUserMessage("telegram-12345", {
      text: "First", files: [], onProgress: firstProgress, onEngineEvent: firstEvents,
    });
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 1, state: "DONE",
        step_type: "agent_response", text_delta: "first answer",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 3 },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "first answer" },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 99, state: "DONE",
        step_type: "agent_response", text_delta: " leaked tail",
        usage: { input_tokens: 999, output_tokens: 888, cache_read_tokens: 777 },
      },
    }));

    await expect(first).resolves.toEqual({
      text: "first answer",
      sessionId: CONVERSATION_ID,
      usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 3 },
    });
    expect(firstProgress).toHaveBeenCalledTimes(1);
    expect(firstProgress).toHaveBeenCalledWith("first answer");
    expect(JSON.stringify(firstEvents.mock.calls)).not.toContain("leaked tail");

    const second = adapter.sendUserMessage(CONVERSATION_ID, { text: "Second", files: [] });
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(2));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 1, state: "DONE",
        step_type: "agent_response", text_delta: "second answer",
        usage: { input_tokens: 20, output_tokens: 4, cache_read_tokens: 5 },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "second answer" },
    }));

    await expect(second).resolves.toEqual({
      text: "second answer",
      sessionId: CONVERSATION_ID,
      usage: { inputTokens: 20, outputTokens: 4, cachedTokens: 5 },
    });
    expect(calls).toHaveLength(1);
    await adapter.destroy();
  });

  it("quarantines a delayed tail until the next turn's matching user echo", async () => {
    const { spawnAntigravity, child } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const first = adapter.sendUserMessage("telegram-12345", { text: "First", files: [] });
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(child.stdin.writes[0]!);
    emitTurnSuccess(child, "first answer");
    await expect(first).resolves.toMatchObject({ text: "first answer" });

    const progress = vi.fn();
    const second = adapter.sendUserMessage(CONVERSATION_ID, {
      text: "Second",
      files: [],
      onProgress: progress,
    });
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(2));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 99,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "stale tail",
        usage: { input_tokens: 900, output_tokens: 900 },
      },
    }));
    child.stdout.emitData(child.stdin.writes[1]!);
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "second answer",
        usage: { input_tokens: 20, output_tokens: 4, cache_read_tokens: 5 },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "second answer" },
    }));

    await expect(second).resolves.toEqual({
      text: "second answer",
      sessionId: CONVERSATION_ID,
      usage: { inputTokens: 20, outputTokens: 4, cachedTokens: 5 },
    });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith("second answer");
    await adapter.destroy();
  });

  it("keeps a completed turn successful and recycles the worker after a later crash", async () => {
    const children = [new FakeChildProcess(), new FakeChildProcess()];
    const calls: SpawnCall[] = [];
    const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
      calls.push({ command, args, options });
      return children[calls.length - 1]!;
    };
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Late failure", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(children[0]!, "authoritative success");
    await expect(promise).resolves.toMatchObject({ text: "authoritative success" });
    children[0]!.stderr.emitData("post-result worker crash\n");
    children[0]!.close(1);

    const next = adapter.sendUserMessage(CONVERSATION_ID, { text: "Recover", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.args).toEqual(expect.arrayContaining(["--conversation", CONVERSATION_ID]));
    emitSuccess(children[1]!, "recovered");
    await expect(next).resolves.toMatchObject({ text: "recovered" });
  });

  it("reuses one persistent worker for consecutive turns in the same conversation", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const first = adapter.sendUserMessage("telegram-12345", { text: "First", files: [] });
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(1));
    emitSuccess(child, "first answer");
    await expect(first).resolves.toMatchObject({ text: "first answer", sessionId: CONVERSATION_ID });

    const second = adapter.sendUserMessage(CONVERSATION_ID, { text: "Second", files: [] });
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(2));
    emitTurnSuccess(child, "second answer");
    await expect(second).resolves.toMatchObject({ text: "second answer", sessionId: CONVERSATION_ID });

    expect(calls).toHaveLength(1);
    expect(child.stdin.ended).toBe(false);
    const messages = child.stdin.writes.map((line) => JSON.parse(line) as { message: { content: string } });
    expect(messages[0]?.message.content).toContain("<user_message>\nFirst\n</user_message>");
    expect(messages[1]?.message.content).toContain("<user_message>\nSecond\n</user_message>");
  });

  it("accepts exactly one matching stream-json user echo per turn", async () => {
    const { spawnAntigravity, child } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const turn = adapter.sendUserMessage(CONVERSATION_ID, { text: "Echoed", files: [] });
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(child.stdin.writes[0]!);
    emitTurnSuccess(child, "accepted");

    await expect(turn).resolves.toMatchObject({ text: "accepted", sessionId: CONVERSATION_ID });
    await adapter.destroy();
  });

  it("rejects a stream-json user echo that does not match the active turn", async () => {
    const { spawnAntigravity, child } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const turn = adapter.sendUserMessage(CONVERSATION_ID, { text: "Expected", files: [] });
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({ event: "user", message: { content: "Different" } }));

    await expect(turn).rejects.toThrow("does not match the active turn");
    expect(child.stdin.ended).toBe(true);
  });

  it("keeps different conversations on isolated workers", async () => {
    const firstId = CONVERSATION_ID;
    const secondId = "22222222-3333-4444-8555-666666666666";
    const children = [new FakeChildProcess(), new FakeChildProcess()];
    const calls: SpawnCall[] = [];
    const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
      calls.push({ command, args, options });
      return children[calls.length - 1]!;
    };
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const first = adapter.sendUserMessage(firstId, { text: "A", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = adapter.sendUserMessage(secondId, { text: "B", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    emitSuccess(children[0]!, "answer A", firstId);
    emitSuccess(children[1]!, "answer B", secondId);

    await expect(first).resolves.toMatchObject({ text: "answer A", sessionId: firstId });
    await expect(second).resolves.toMatchObject({ text: "answer B", sessionId: secondId });
    expect(children[0]!.stdin.writes).toHaveLength(1);
    expect(children[1]!.stdin.writes).toHaveLength(1);
  });

  it("fails closed when two workers claim the same real conversation", async () => {
    const children = [new FakeChildProcess(), new FakeChildProcess()];
    const calls: SpawnCall[] = [];
    const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
      calls.push({ command, args, options });
      return children[calls.length - 1]!;
    };
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const first = adapter.sendUserMessage("telegram-111", { text: "A", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = adapter.sendUserMessage("telegram-222", { text: "B", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    emitSuccess(children[0]!, "answer A");
    await expect(first).resolves.toMatchObject({ text: "answer A", sessionId: CONVERSATION_ID });
    children[1]!.stdout.emitData(jsonLine({
      event: "init", conversation_id: CONVERSATION_ID, init: {},
    }));

    await expect(second).rejects.toThrow(`conversation ${CONVERSATION_ID} is already owned`);
    expect(children[1]!.stdin.ended).toBe(true);
    expect(children[0]!.stdin.ended).toBe(false);

    const followUp = adapter.sendUserMessage(CONVERSATION_ID, { text: "Still alive", files: [] });
    await vi.waitFor(() => expect(children[0]!.stdin.writes).toHaveLength(2));
    emitTurnSuccess(children[0]!, "still alive");
    await expect(followUp).resolves.toMatchObject({ text: "still alive" });
    await adapter.destroy();
  });

  it("fails closed instead of overwriting an in-flight turn on the same worker", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const first = adapter.sendUserMessage(CONVERSATION_ID, { text: "First", files: [] });
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(1));
    await expect(adapter.sendUserMessage(CONVERSATION_ID, { text: "Second", files: [] }))
      .rejects.toThrow("already has an in-flight turn");
    expect(child.stdin.writes).toHaveLength(1);
    expect(calls).toHaveLength(1);

    emitSuccess(child, "first answer");
    await expect(first).resolves.toMatchObject({ text: "first answer" });
  });

  it("preserves UTF-8 characters split across structured stdout chunks", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const onEngineEvent = vi.fn();
    const text = "开头中文🙂结尾";
    const stream = Buffer.from([
      jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }),
      jsonLine({
        event: "step_update",
        step_update: {
          conversation_id: CONVERSATION_ID, step_index: 1, state: "DONE",
          step_type: "agent_response", text_delta: text,
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
      jsonLine({
        event: "result",
        result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: text },
      }),
    ].join(""), "utf8");

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Stream UTF-8", files: [], onEngineEvent,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const splitAt = stream.indexOf(Buffer.from("中", "utf8")) + 1;
    child.stdout.emitData(stream.subarray(0, splitAt));
    child.stdout.emitData(stream.subarray(splitAt));
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text });
    const streamedText = onEngineEvent.mock.calls
      .map(([event]) => event.type === "assistant_text" ? event.text : "")
      .join("");
    expect(streamedText).toBe(text);
    expect(streamedText).not.toContain("�");
  });

  it("resumes structured conversations with --conversation", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage(CONVERSATION_ID, { text: "Continue", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(child, "continued");
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "continued", sessionId: CONVERSATION_ID });
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--conversation", CONVERSATION_ID]));
  });

  it.each([
    ...["high", "xhigh", "max"].map(effort => ({ effort, model: "gemini-3.7-flash-high" })),
    ...["low", "medium", "high"].map(effort => ({ effort, model: `gemini-4-argon-${effort}` })),
  ].flatMap(settings => [
    { ...settings, text: "Hello" }, { ...settings, text: "/goal Complete the task" },
  ]))("passes Antigravity $model / $effort for $text and keeps full-auto turns sandboxed", async ({ effort, model, text }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-"));
    const configPath = path.join(root, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({
        engine: "antigravity", model, effort, approvalMode: "full-auto",
      }), "utf8");
      const { spawnAntigravity, child, calls } = createSpawnHarness();
      const adapter = new ProcessAntigravityAdapter(
        "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, configPath, "/tmp/workspace",
      );

      const promise = adapter.sendUserMessage("telegram-12345", { text, files: [] });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      emitSuccess(child, "ok");
      child.close(0);

      await expect(promise).resolves.toMatchObject({ text: "ok" });
      expect(calls[0]?.args).toEqual(expect.arrayContaining([
        "--model", model, "--effort", effort,
        "--dangerously-skip-permissions", "--sandbox",
      ]));
      const args = calls[0]!.args;
      expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", effort]);
      expect(args.slice(0, 2)).toEqual(["--input-format", text === "Hello" ? "stream-json" : "text"]);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("starts the ticket session worker with its --model/--effort and leaves other sessions and config.json unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-override-"));
    const configPath = path.join(root, "config.json");
    const config = JSON.stringify({ engine: "antigravity", model: "gemini-3.7-flash-high", effort: "high", approvalMode: "bypass" });
    const children: FakeChildProcess[] = [], calls: SpawnCall[] = [];
    const spawnAntigravity: SpawnAntigravity = (command, args, options) => { calls.push({ command, args, options }); const child = new FakeChildProcess(); children.push(child); return child; };
    const kill = vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve());
    await writeFile(configPath, config, "utf8");
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, configPath, "/tmp/workspace");
    const flag = (args: string[] | undefined, name: string) => args?.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    const run = async (sessionId: string, conversationId: string, engineOverride?: { model?: string; effort?: "low" }) => {
      const index = children.length;
      const promise = adapter.sendUserMessage(sessionId, { text: "Hello", files: [], ...(engineOverride ? { engineOverride } : {}) });
      await vi.waitFor(() => expect(children[index]?.stdin.writes).toHaveLength(1));
      emitSuccess(children[index]!, "ok", conversationId);
      await expect(promise).resolves.toMatchObject({ text: "ok" });
      return calls[index]!.args;
    };
    try {
      const ticket = await run("telegram-1", CONVERSATION_ID, { model: "gemini-4-argon-low", effort: "low" });
      expect([flag(ticket, "--model"), flag(ticket, "--effort")]).toEqual(["gemini-4-argon-low", "low"]);
      const plain = await run("telegram-2", "22222222-3333-4444-8555-666666666666");
      expect([flag(plain, "--model"), flag(plain, "--effort")]).toEqual(["gemini-3.7-flash-high", "high"]);
      await expect(adapter.sendUserMessage("telegram-3", { text: "Hello", files: [], engineOverride: { effort: "ultra" } }))
        .rejects.toThrow('Invalid model selection: gemini-3.7-flash-high has no "ultra" effort (available: low, medium, high, xhigh, max)');
      expect(calls).toHaveLength(2);
      expect(await readFile(configPath, "utf8")).toBe(config);
    } finally {
      await adapter.destroy(); kill.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("keeps Antigravity bypass explicitly unsandboxed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-"));
    const configPath = path.join(root, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({ engine: "antigravity", approvalMode: "bypass" }), "utf8");
      const { spawnAntigravity, child, calls } = createSpawnHarness();
      const adapter = new ProcessAntigravityAdapter(
        "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, configPath, "/tmp/workspace",
      );

      const promise = adapter.sendUserMessage("telegram-12345", { text: "Hello", files: [] });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      emitSuccess(child, "ok");
      child.close(0);

      await expect(promise).resolves.toMatchObject({ text: "ok" });
      expect(calls[0]?.args).toContain("--dangerously-skip-permissions");
      expect(calls[0]?.args).not.toContain("--sandbox");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("sandboxes a normal Antigravity turn after the user approves full-auto", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "once" });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello", files: [], onApprovalRequest,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(child, "ok");
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "ok" });
    expect(onApprovalRequest).toHaveBeenCalledOnce();
    expect(onApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ approvalScopes: { once: "turn" } }));
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--dangerously-skip-permissions", "--sandbox",
    ]));
  });

  it("keeps native /goal and private instructions in text stdin, outside argv, with a high ceiling when unbounded", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter(
      "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, undefined, "/tmp/workspace",
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "/goal finish the migration",
      files: ["plan.md"],
      instructions: "Deliver the final result through TaroBot. Private capability context: isolated-test-marker.",
      disableRuntimeTimeout: true,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(child, "GOAL_OK");
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "GOAL_OK" });
    expect(calls[0]?.args).not.toContain("-p");
    expect(calls[0]?.args).not.toContain("--print");
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--input-format", "text", "--output-format", "stream-json", "--print-timeout", "168h",
    ]));
    expect(calls[0]!.args.join(" ")).not.toMatch(/finish the migration|private_bridge_instructions|isolated-test-marker|plan\.md/);
    expect(child.stdin.writes).toHaveLength(1);
    const prompt = child.stdin.writes[0]!;
    expect(prompt.startsWith("/goal finish the migration")).toBe(true);
    expect(prompt).toContain("<private_bridge_instructions>");
    expect(prompt).toContain("Attachment: plan.md");
    expect(prompt).not.toContain("<user_message>\n/goal");
    expect(prompt).toContain("isolated-test-marker");
    expect(child.stdin.ended).toBe(true);
  });

  it("rejects an empty successful native /goal result", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const goal = adapter.sendUserMessage("telegram-12345", { text: "/goal create images", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "" },
    }));
    child.close(0);

    await expect(goal).rejects.toThrow("Antigravity completed without returning a response");
  });

  it("recycles a persistent conversation worker before running native /goal", async () => {
    const children = [new FakeChildProcess(), new FakeChildProcess(), new FakeChildProcess()];
    const calls: SpawnCall[] = [];
    const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
      calls.push({ command, args, options });
      return children[calls.length - 1]!;
    };
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const first = adapter.sendUserMessage("telegram-12345", { text: "First", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(children[0]!, "first answer");
    await expect(first).resolves.toMatchObject({ sessionId: CONVERSATION_ID });

    const goal = adapter.sendUserMessage(CONVERSATION_ID, { text: "/goal finish it", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(children[0]!.stdin.ended).toBe(true);
    expect(calls[1]?.args).toEqual(expect.arrayContaining(["--input-format", "text", "--conversation", CONVERSATION_ID]));
    emitSuccess(children[1]!, "goal complete");
    children[1]!.close(0);
    await expect(goal).resolves.toMatchObject({ text: "goal complete", sessionId: CONVERSATION_ID });

    const next = adapter.sendUserMessage(CONVERSATION_ID, { text: "After goal", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]?.args).toEqual(expect.arrayContaining([
      "--input-format", "stream-json", "--conversation", CONVERSATION_ID,
    ]));
    emitSuccess(children[2]!, "after goal");
    await expect(next).resolves.toMatchObject({ text: "after goal" });
    await adapter.destroy();
  });

  it("rejects native /goal when agy replaces the requested conversation", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const replacementId = "22222222-3333-4444-8555-666666666666";

    const goal = adapter.sendUserMessage(CONVERSATION_ID, { text: "/goal continue", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--conversation", CONVERSATION_ID]));
    emitSuccess(child, "silently restarted", replacementId);
    child.close(0);

    await expect(goal).rejects.toThrow("does not match the requested conversation");
  });

  it("ignores native /goal step updates that arrive after the result event", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const onProgress = vi.fn();
    const onEngineEvent = vi.fn();

    const goal = adapter.sendUserMessage(CONVERSATION_ID, {
      text: "/goal finish", files: [], onProgress, onEngineEvent,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "done" },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 99, state: "DONE",
        step_type: "agent_response", text_delta: "late internal text",
      },
    }));
    child.close(0);

    await expect(goal).resolves.toMatchObject({ text: "done", sessionId: CONVERSATION_ID });
    expect(onProgress.mock.calls.flat().some((value) => String(value).includes("late internal text"))).toBe(false);
    expect(onEngineEvent.mock.calls.flat()).not.toContainEqual(expect.objectContaining({
      type: "assistant_text", text: "late internal text",
    }));
  });

  it("fails closed on an unknown native /goal protocol event", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const goal = adapter.sendUserMessage(CONVERSATION_ID, { text: "/goal finish", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({ event: "future_error", error: "protocol changed" }));
    child.close(0);

    await expect(goal).rejects.toThrow("unsupported event: future_error");
  });

  it("destroy stops an active native /goal and blocks overlapping work on its conversation", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const goal = adapter.sendUserMessage(CONVERSATION_ID, { text: "/goal keep working", files: [] });
    const goalOutcome = goal.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    await expect(adapter.sendUserMessage(CONVERSATION_ID, { text: "Overlap", files: [] }))
      .rejects.toThrow("native /goal in flight");
    expect(calls).toHaveLength(1);

    await adapter.destroy();
    expect(child.stdin.ended).toBe(true);
    const outcome = await goalOutcome;
    expect(outcome.status).toBe("rejected");
    expect(outcome.status === "rejected" ? outcome.error : undefined).toEqual(expect.objectContaining({
      message: "Adapter destroyed",
    }));
  });

  it("fails closed on an Antigravity ERROR result", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Fail", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "ERROR", error: "upstream disconnected" },
    }));
    child.close(0);

    await expect(promise).rejects.toThrow("upstream disconnected");
  });

  it("delivers a completed persistent answer when agy repeats a stale session error in the result", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Answer despite old error", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 8,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "complete current answer",
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID,
        status: "ERROR",
        response: "complete current answer",
        error: "old 503 from an earlier turn",
      },
    }));
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "complete current answer" });
  });

  it("delivers a completed native-goal answer when agy repeats a stale session error in the result", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage(CONVERSATION_ID, { text: "/goal verify output", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 9,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "verified goal result",
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID,
        status: "ERROR",
        response: "verified goal result",
        error: "old 401 from an earlier turn",
      },
    }));
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "verified goal result" });
  });

  it("does not mask a persistent-turn failure with an opening response before a tool", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Inspect then answer", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "I will inspect the workspace.",
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "inspect",
        tool_info: { output: "partial evidence" },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID,
        status: "ERROR",
        response: "I will inspect the workspace.",
        error: "current 503 after tool execution",
      },
    }));

    await expect(promise).rejects.toThrow("current 503 after tool execution");
  });

  it("does not mask a native-goal failure with an opening response before a tool", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage(CONVERSATION_ID, { text: "/goal inspect then answer", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "I will inspect the workspace.",
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "inspect",
        tool_info: { output: "partial evidence" },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID,
        status: "ERROR",
        response: "I will inspect the workspace.",
        error: "current 401 after tool execution",
      },
    }));

    await expect(promise).rejects.toThrow("current 401 after tool execution");
  });

  it("retries once when agy authentication fails before init", async () => {
    const children = [new FakeChildProcess(), new FakeChildProcess()];
    const calls: SpawnCall[] = [];
    const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
      calls.push({ command, args, options });
      return children[calls.length - 1]!;
    };
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage(CONVERSATION_ID, { text: "Create a skill", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    children[0]!.stderr.emitData(
      "Error: authentication required. Run 'agy' to log in, then retry.\n" +
      "error: authentication failed or timed out\n",
    );
    children[0]!.stdout.emitData(jsonLine({
      event: "result",
      result: { status: "ERROR", error: "authentication required" },
    }));

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    emitSuccess(children[1]!, "skill created");
    await expect(promise).resolves.toMatchObject({ text: "skill created", sessionId: CONVERSATION_ID });
    expect(children[0]!.stdin.writes).toHaveLength(1);
    expect(children[1]!.stdin.writes).toHaveLength(1);
    await adapter.destroy();
  });

  it("does not replay an authentication failure after init", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage(CONVERSATION_ID, { text: "Publish content", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID,
        status: "ERROR",
        error: "UNAUTHENTICATED: invalid authentication credentials",
      },
    }));

    await expect(promise).rejects.toThrow("UNAUTHENTICATED");
    expect(calls).toHaveLength(1);
  });

  it("rejects an init event without a conversation_id", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Missing ID", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", init: {} }));

    await expect(promise).rejects.toThrow("init event is missing a valid conversation_id");
  });

  it("rejects a successful result without a conversation_id", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Missing result ID", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { status: "SUCCESS", response: "answer" },
    }));

    await expect(promise).rejects.toThrow("result event is missing a valid conversation_id");
  });

  it("rejects a conversation_id that changes during a turn", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const changedConversationId = "22222222-3333-4444-8555-666666666666";

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Changed ID", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: changedConversationId, status: "SUCCESS", response: "answer" },
    }));

    await expect(promise).rejects.toThrow("conversation_id changed during turn");
  });

  it("rejects malformed structured output instead of posting it as assistant text", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const onEngineEvent = vi.fn();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Malformed", files: [], onEngineEvent,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData("internal thinking accidentally printed\n");

    await expect(promise).rejects.toThrow("invalid structured output");
    expect(onEngineEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_text" }));
  });

  it("rejects a clean exit that never emitted the required result event", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Missing result", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.close(0);

    await expect(promise).rejects.toThrow("without a result event");
  });

  it("reports the terminating signal when a persistent worker is killed", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Killed", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.close(null, "SIGKILL");

    await expect(promise).rejects.toThrow("SIGKILL");
  });

  it("retries without --log-file only when an older agy rejects that flag", async () => {
    const children = [new FakeChildProcess(), new FakeChildProcess()];
    const calls: SpawnCall[] = [];
    const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
      calls.push({ command, args, options });
      return children[calls.length - 1]!;
    };
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Retry", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.args).toContain("--log-file");
    children[0]!.stderr.emitData("unknown flag: --log-file\n");
    children[0]!.close(2);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.args).not.toContain("--log-file");
    emitSuccess(children[1]!, "retried");
    children[1]!.close(0);

    await expect(promise).resolves.toMatchObject({ text: "retried", sessionId: CONVERSATION_ID });
  });

  it.each([
    { model: "claude-sonnet-4-6", effort: "medium" },
    { model: "gemini-3.7-flash-high", effort: "xhigh" },
  ])("restarts an idle worker with the same conversation after changing to $model / $effort", async ({ model, effort }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-persistent-config-"));
    const configPath = path.join(root, "config.json");
    const children = [new FakeChildProcess(), new FakeChildProcess()];
    const calls: SpawnCall[] = [];
    const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
      calls.push({ command, args, options });
      return children[calls.length - 1]!;
    };
    try {
      await writeFile(configPath, JSON.stringify({
        engine: "antigravity", model: "gemini-3.7-flash-high", effort: "high", approvalMode: "full-auto",
      }));
      const adapter = new ProcessAntigravityAdapter(
        "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, configPath, "/tmp/workspace",
      );

      const first = adapter.sendUserMessage("telegram-12345", { text: "First", files: [] });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      emitSuccess(children[0]!, "first answer");
      await expect(first).resolves.toMatchObject({ sessionId: CONVERSATION_ID });

      await writeFile(configPath, JSON.stringify({
        engine: "antigravity", model, effort, approvalMode: "full-auto",
      }));
      const second = adapter.sendUserMessage(CONVERSATION_ID, { text: "Second", files: [] });
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect(children[0]!.stdin.ended).toBe(true);
      expect(calls[1]?.args).toEqual(expect.arrayContaining([
        "--conversation", CONVERSATION_ID,
        "--model", model,
        "--effort", effort,
      ]));
      const args = calls[1]!.args;
      expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", effort]);
      expect(args.slice(args.indexOf("--conversation"), args.indexOf("--conversation") + 2)).toEqual(["--conversation", CONVERSATION_ID]);
      emitSuccess(children[1]!, "second answer");
      await expect(second).resolves.toMatchObject({ text: "second answer", sessionId: CONVERSATION_ID });
      await adapter.destroy();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("reaps idle stream workers without touching an active turn", async () => {
    const children = [new FakeChildProcess()];
    const calls: SpawnCall[] = [];
    const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
      calls.push({ command, args, options });
      return children[calls.length - 1]!;
    };
    const adapter = new ProcessAntigravityAdapter(
      "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, undefined, undefined,
      undefined, undefined, 25, 5,
    );
    try {
      const first = adapter.sendUserMessage(CONVERSATION_ID, { text: "First", files: [] });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(children[0]!.stdin.ended).toBe(false);
      emitSuccess(children[0]!, "first answer");
      await expect(first).resolves.toMatchObject({ text: "first answer" });

      await vi.waitFor(() => expect(children[0]!.stdin.ended).toBe(true));
      expect(calls).toHaveLength(1);
    } finally {
      await adapter.destroy();
    }
  });

  it("destroy closes every persistent worker and rejects an active turn", async () => {
    const children = [new FakeChildProcess(), new FakeChildProcess()];
    const calls: SpawnCall[] = [];
    const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
      calls.push({ command, args, options });
      return children[calls.length - 1]!;
    };
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const completed = adapter.sendUserMessage(CONVERSATION_ID, { text: "Complete", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const active = adapter.sendUserMessage("22222222-3333-4444-8555-666666666666", { text: "Active", files: [] });
    const activeOutcome = active.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    emitSuccess(children[0]!, "done", CONVERSATION_ID);
    await expect(completed).resolves.toMatchObject({ text: "done" });

    await adapter.destroy();
    expect(children[0]!.stdin.ended).toBe(true);
    expect(children[1]!.stdin.ended).toBe(true);
    const outcome = await activeOutcome;
    expect(outcome.status).toBe("rejected");
    expect(outcome.status === "rejected" ? outcome.error : undefined).toEqual(expect.objectContaining({
      message: "Adapter destroyed",
    }));
    await expect(adapter.sendUserMessage(CONVERSATION_ID, { text: "After destroy", files: [] }))
      .rejects.toThrow("Adapter destroyed");
  });
});

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};
type SpawnCall = { command: string; args: string[]; options: SpawnOptions };
type SpawnAntigravity = (command: string, args: string[], options: SpawnOptions) => FakeChildProcess;

class FakeStream extends EventEmitter {
  emitData(chunk: string | Buffer) {
    this.emit("data", chunk);
  }
}

class FakeChildProcess extends EventEmitter {
  constructor(readonly pid?: number) {
    super();
  }

  stdin = {
    writes: [] as string[],
    ended: false,
    write: (chunk: string, callback?: (error?: Error | null) => void) => {
      if (this.stdin.ended) {
        callback?.(new Error("write after end"));
        return false;
      }
      this.stdin.writes.push(chunk);
      callback?.(null);
      return true;
    },
    end: (chunk?: string) => {
      if (chunk) this.stdin.writes.push(chunk);
      this.stdin.ended = true;
    },
    on: (_event: "error", _listener: (error: Error) => void) => undefined,
  };
  stdout = new FakeStream();
  stderr = new FakeStream();

  kill() { return true; }
  close(code: number | null, signal: NodeJS.Signals | null = null) { this.emit("close", code, signal); }
}

function createSpawnHarness() {
  const child = new FakeChildProcess();
  const calls: SpawnCall[] = [];
  const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { spawnAntigravity, child, calls };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function emitSuccess(child: FakeChildProcess, text: string, conversationId = CONVERSATION_ID): void {
  child.stdout.emitData(jsonLine({ event: "init", conversation_id: conversationId, init: {} }));
  emitTurnSuccess(child, text, conversationId);
}

function emitTurnSuccess(child: FakeChildProcess, text: string, conversationId = CONVERSATION_ID): void {
  child.stdout.emitData(jsonLine({
    event: "step_update",
    step_update: {
      conversation_id: conversationId, step_index: 1, state: "DONE",
      step_type: "agent_response", text_delta: text,
    },
  }));
  child.stdout.emitData(jsonLine({
    event: "result",
    result: { conversation_id: conversationId, status: "SUCCESS", response: text },
  }));
}
