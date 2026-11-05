import { nativeRunProbe } from "./helpers/native-run.js";
import { runEntryTitle, runDiff, runPlan } from "../client/src/run-presentation.js";
import { summarizeRun } from "../src/core/run-record.js";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import type { EngineStreamEvent, EngineAnswerProgress, EngineApprovalDecision } from "../src/codex/adapter.js";
import { applyCoreEngineEvent, initialCoreRunState } from "../src/core/card-renderer.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import * as processTree from "../src/codex/process-tree.js";
import { APP_USER_STOP_REASON, APP_STOP_PROCESS_GRACE_MS } from "../src/runtime/turn-cancellation.js";
import { classifyFailure } from "../src/runtime/error-classification.js";

async function waitFor(condition: () => boolean): Promise<void> {
  if ((vi as unknown as { isFakeTimers?: () => boolean }).isFakeTimers?.()) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (condition()) {
        return;
      }
      await vi.advanceTimersByTimeAsync(0);
    }
    throw new Error("Condition was not met in time");
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error("Condition was not met in time");
}

class FakeStream extends EventEmitter {
  emitData(chunk: string | Buffer) {
    this.emit("data", chunk);
  }
}

class FakeWritable {
  lines: string[] = [];

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) {
      this.lines.push(text);
    }
    callback?.(null);
    return true;
  }
}

class FakeClaudeChildProcess extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeStream();
  stderr = new FakeStream();
  killCalls = 0;

  kill() {
    this.killCalls += 1;
  }

  close(code: number | null) {
    this.emit("close", code);
  }
}

function createSpawnHarness() {
  const children: FakeClaudeChildProcess[] = [];
  const calls: Array<{
    command: string;
    args: string[];
    options: {
      stdio: ["pipe", "pipe", "pipe"];
      shell?: boolean;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      windowsHide?: boolean;
    };
  }> = [];

  const spawnFn = (
    command: string,
    args: string[],
    options: {
      stdio: ["pipe", "pipe", "pipe"];
      shell?: boolean;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      windowsHide?: boolean;
    },
  ) => {
    const child = new FakeClaudeChildProcess();
    children.push(child);
    calls.push({ command, args, options });
    return child;
  };

  return { children, calls, spawnFn };
}

it("captures Claude status/boundary compaction once without leaking child or idle events", async () => {
  const harness = createSpawnHarness(), probe = nativeRunProbe();
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn: harness.spawnFn });
  try {
    const result = adapter.sendUserMessage("tarobot-compact", { text: "continue", files: [], onEngineEvent: probe.onEngineEvent });
    await waitFor(() => harness.children[0]?.stdin.lines.length === 1);
    const emit = (e: object) => harness.children[0].stdout.emitData(JSON.stringify({ session_id: "native-compact", ...e }) + "\n");
    emit({ type: "system", subtype: "init" });
    emit({ type: "system", subtype: "status", status: "compacting", parent_tool_use_id: "foreign-child" });
    expect(probe.record.entries).toHaveLength(0);
    emit({ type: "system", subtype: "status", status: "compacting" });
    emit({ type: "system", subtype: "status", status: "compacting" });
    expect(summarizeRun(probe.record, "running").current?.name).toBe("context_compaction");
    emit({ type: "system", subtype: "status", status: null });
    expect(probe.record.entries[0].status).toBe("running");
    emit({ type: "system", subtype: "compact_boundary", uuid: "boundary" });
    emit({ type: "system", subtype: "compact_boundary", uuid: "boundary" });
    expect(probe.record.entries).toHaveLength(1);
    expect(probe.record.entries[0].status).toBe("done");
    emit({ type: "result", result: "continued" });
    await expect(result).resolves.toMatchObject({ text: "continued" });
    const count = probe.events.length;
    emit({ type: "system", subtype: "status", status: "compacting" });
    expect(probe.events).toHaveLength(count);
  } finally { await adapter.destroy(); }
});

describe("ClaudeStreamAdapter", () => {

  it("applies Chrome toggles between turns, resumes the same session and overrides global defaults", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chrome-worker-")), configPath = path.join(root, "config.json");
    const { children, calls, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn, configPath, enableChromeIntegration: true });
    try {
      await writeFile(configPath, JSON.stringify({ engine: "claude", claudeChrome: false }));
      const first = adapter.sendUserMessage("tarobot-chrome", { text: "first", files: [] });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      expect(calls[0].args).toContain("--no-chrome"); expect(calls[0].args).not.toContain("--chrome");
      await writeFile(configPath, JSON.stringify({ engine: "claude", claudeChrome: true }));
      await expect(adapter.sendUserMessage("tarobot-chrome", { text: "too early", files: [] })).rejects.toThrow("turn is in flight");
      expect(children).toHaveLength(1);
      children[0].stdout.emitData('{"type":"result","result":"first","session_id":"chrome-session"}\n'); await first;
      for (const [index, enabled] of [[1, true], [2, false]] as const) {
        await writeFile(configPath, JSON.stringify({ engine: "claude", claudeChrome: enabled }));
        const next = adapter.sendUserMessage("chrome-session", { text: "next", files: [] });
        await waitFor(() => children[index]?.stdin.lines.length === 1);
        expect(calls[index].args).toContain(enabled ? "--chrome" : "--no-chrome");
        expect(calls[index].args).not.toContain(enabled ? "--no-chrome" : "--chrome");
        expect(calls[index].args.slice(calls[index].args.indexOf("-r"), calls[index].args.indexOf("-r") + 2)).toEqual(["-r", "chrome-session"]);
        children[index].stdout.emitData('{"type":"result","result":"next","session_id":"chrome-session"}\n'); await next;
      }
    } finally { await adapter.destroy(); await removeTempRoot(root); }
  });
  it("does not reuse obsolete Chrome access or kill background work after a toggle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chrome-background-")), configPath = path.join(root, "config.json");
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn, configPath });
    try {
      await writeFile(configPath, JSON.stringify({ engine: "claude", claudeChrome: true }));
      const first = adapter.sendUserMessage("tarobot-chrome", { text: "background", files: [] });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"background","session_id":"chrome-session"}\n');
      children[0].stdout.emitData('{"type":"result","result":"started","session_id":"chrome-session"}\n'); await first;
      await writeFile(configPath, JSON.stringify({ engine: "claude", claudeChrome: false }));
      await expect(adapter.sendUserMessage("chrome-session", { text: "next", files: [] })).rejects.toThrow("browser integration changed while background tasks");
      expect(children).toHaveLength(1); expect(children[0].stdin.lines).toHaveLength(1);
    } finally { await adapter.destroy(); await removeTempRoot(root); }
  });

  it("preserves observed calls when the prompt write reports a delayed pipe failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-pipe-recovery-"));
    const recoveryStatePath = path.join(root, "receipt.json");
    const harness = createSpawnHarness();
    let writeCallback: ((error?: Error | null) => void) | undefined;
    const adapter = new ClaudeStreamAdapter("claude", {
      recoveryStatePath, workspacePath: "/bot/pipe",
      spawnFn: (command, args, options) => {
        const child = harness.spawnFn(command, args, options);
        child.stdin.write = (chunk, callback) => {
          child.stdin.lines.push(chunk.trim()); writeCallback = callback; return true;
        };
        return child;
      },
    });
    try {
      const result = adapter.sendUserMessage("telegram-pipe", { text: "Read", files: [] });
      const rejected = expect(result).rejects.toThrow("EPIPE");
      await waitFor(() => !!writeCallback);
      const emit = (event: unknown) => harness.children[0].stdout.emitData(JSON.stringify(event) + "\n");
      emit({ type: "system", subtype: "init", session_id: "native-pipe" });
      emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "read", name: "Read", input: {} }] } });
      writeCallback!(new Error("EPIPE"));
      await rejected;
      await adapter.destroy();
      const state = JSON.parse(await readFile(recoveryStatePath, "utf8"));
      expect(state.entries).toEqual([expect.objectContaining({ toolCalls: 1, toolResults: 0, pendingTools: ["Read"] })]);
    } finally { await adapter.destroy(); await removeTempRoot(root); }
  });

  it("rejects the active turn if an earlier write reports a late pipe failure", async () => {
    const harness = createSpawnHarness();
    const callbacks: Array<((error?: Error | null) => void) | undefined> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn: (command, args, options) => {
      const child = harness.spawnFn(command, args, options);
      child.stdin.write = (chunk, callback) => { child.stdin.lines.push(chunk.trim()); callbacks.push(callback); return true; };
      return child;
    } });
    try {
      const first = adapter.sendUserMessage("native-pipe", { text: "First", files: [] });
      await waitFor(() => callbacks.length === 1);
      harness.children[0].stdout.emitData('{"type":"result","result":"Done","session_id":"native-pipe"}\n');
      await first;
      let outcome: unknown;
      const second = adapter.sendUserMessage("native-pipe", { text: "Second", files: [] })
        .then(() => { outcome = "unexpected success"; }, error => { outcome = error; });
      await waitFor(() => callbacks.length === 2);
      callbacks[0]!(new Error("EPIPE late"));
      await waitFor(() => outcome !== undefined);
      await second;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("EPIPE late");
    } finally { await adapter.destroy(); }
  });

  it("keeps observed unfinished calls across stop and adapter restart without replaying a prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-interrupted-"));
    const recoveryStatePath = path.join(root, "receipt.json");
    const first = createSpawnHarness(), second = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn: first.spawnFn, recoveryStatePath, workspacePath: "/bot/A" });
    let resumed: ClaudeStreamAdapter | undefined;
    try {
      const stop = new AbortController();
      const result = adapter.sendUserMessage("telegram-new", { text: "Read directory", files: [], abortSignal: stop.signal });
      const rejected = expect(result).rejects.toThrow("stopped by user");
      await waitFor(() => first.children[0]?.stdin.lines.length === 1);
      const emit = (event: unknown) => first.children[0].stdout.emitData(JSON.stringify(event) + "\n");
      emit({ type: "system", subtype: "init", session_id: "native-A" });
      emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "skill", name: "Skill", input: { skill: "folder" } }] } });
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "skill", content: "Loaded" }] } });
      emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "shell", name: "Bash", input: { command: "do-not-persist-secret-command" } }] } });
      // An unrelated child receipt cannot claim completion of the parent call.
      emit({ type: "user", parent_tool_use_id: "child", message: { content: [{ type: "tool_result", tool_use_id: "shell", content: "child" }] } });
      stop.abort(); await rejected; await adapter.destroy();
      const disk = await readFile(recoveryStatePath, "utf8");
      expect(disk).not.toContain("do-not-persist-secret-command");
      resumed = new ClaudeStreamAdapter("claude", { spawnFn: second.spawnFn, recoveryStatePath, workspacePath: "/bot/A" });
      const next = resumed.sendUserMessage("native-A", { text: "停止，不要继续", files: [] });
      await waitFor(() => second.children[0]?.stdin.lines.length === 1);
      const prompt = JSON.parse(second.children[0].stdin.lines[0]).message.content[0].text;
      expect(prompt).toContain('"toolCallsObserved":2');
      expect(prompt).toContain('"toolResultsObserved":1');
      expect(prompt).toContain('"toolsWithoutResultsSample":["Bash"]');
      expect(prompt).toContain("Do not automatically replay interrupted commands");
      expect(prompt).toMatch(/停止，不要继续$/u);
      expect(second.children[0].stdin.lines).toHaveLength(1);
      first.children[0].close(143);
      second.children[0].stdout.emitData('{"type":"result","result":"Stopped","session_id":"native-A"}\n');
      await expect(next).resolves.toMatchObject({ text: "Stopped" });
      const final = resumed.sendUserMessage("native-A", { text: "hello", files: [] });
      await waitFor(() => second.children[0].stdin.lines.length === 2);
      expect(JSON.parse(second.children[0].stdin.lines[1]).message.content[0].text).toBe("hello");
      second.children[0].stdout.emitData('{"type":"result","result":"Hello","session_id":"native-A"}\n');
      await final;
    } finally { await adapter.destroy(); await resumed?.destroy(); await removeTempRoot(root); }
  });
  it.each(["No response requested.", "", undefined])("does not publish a synthetic placeholder as success or retry it (result=%s)", async (resultText) => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const events: EngineStreamEvent[] = [];
    try {
      const turn = adapter.sendUserMessage("native-A", { text: "Do the task", files: [], locale: "zh", onEngineEvent: event => { events.push(event); } });
      const failed = expect(turn).rejects.toThrow("本轮未确认完成");
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]}}\n');
      expect(events.some(event => event.type === "assistant_text")).toBe(false);
      children[0].stdout.emitData(JSON.stringify({ type: "result", result: resultText, session_id: "native-A" }) + "\n");
      await failed;
      expect(events.some(event => event.type === "result")).toBe(false);
      expect(children[0].stdin.lines).toHaveLength(1);
      // The exact same words really generated on a new request remain valid.
      const literal = adapter.sendUserMessage("native-A", { text: "Reply exactly No response requested.", files: [] });
      await waitFor(() => children[0].stdin.lines.length === 2);
      children[0].stdout.emitData('{"type":"assistant","message":{"model":"claude-opus","content":[{"type":"text","text":"No response requested."}]}}\n');
      children[0].stdout.emitData('{"type":"result","result":"No response requested.","session_id":"native-A"}\n');
      await expect(literal).resolves.toMatchObject({ text: "No response requested." });
    } finally { await adapter.destroy(); }
  });
  it("ignores resume padding before a real answer without dropping that answer", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const turn = adapter.sendUserMessage("native-A", { text: "hello", files: [] });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]}}\n');
      children[0].stdout.emitData('{"type":"assistant","message":{"model":"claude-opus","content":[{"type":"text","text":"Hello"}]}}\n');
      children[0].stdout.emitData('{"type":"result","result":"Hello","session_id":"native-A"}\n');
      await expect(turn).resolves.toMatchObject({ text: "Hello" });
    } finally { await adapter.destroy(); }
  });
  it.each([false, true])("uses bounded process cleanup only for explicit App stops (app=%s)", async (app) => {
    const kill = vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve());
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const abort = new AbortController();
    try {
      const turn = adapter.sendUserMessage("telegram-12345", { text: "Long answer", files: [], abortSignal: abort.signal });
      const rejected = expect(turn).rejects.toThrow("stopped by user");
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      abort.abort(app ? APP_USER_STOP_REASON : undefined);
      await rejected;
      expect(kill).toHaveBeenCalledWith(undefined, app ? { graceMs: APP_STOP_PROCESS_GRACE_MS } : undefined);
    } finally { await adapter.destroy(); kill.mockRestore(); }
  });
  it("does not resurrect a stopped worker when its late stdout arrives before the next turn", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const first = adapter.sendUserMessage("telegram-12345", { text: "First", files: [] });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"result","subtype":"success","result":"Ready","session_id":"session-123"}\n');
      await first;
      const abort = new AbortController();
      const stopped = adapter.sendUserMessage("session-123", { text: "Long answer", files: [], abortSignal: abort.signal });
      const rejected = expect(stopped).rejects.toThrow("stopped by user");
      await waitFor(() => children[0].stdin.lines.length === 2);
      abort.abort(); await rejected;
      // SIGTERM is asynchronous. Bytes already in the pipe can arrive after
      // the user sees the interrupted card but before the process closes.
      children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"late output"}]},"session_id":"session-123"}\n');
      const next = adapter.sendUserMessage("session-123", { text: "Resume immediately", files: [] });
      void next.catch(() => undefined);
      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      children[0].close(143);
      children[1].stdout.emitData('{"type":"result","subtype":"success","result":"Recovered","session_id":"session-123"}\n');
      await expect(next).resolves.toMatchObject({ text: "Recovered" });
    } finally { await adapter.destroy(); }
  });
  it("creates a logical TaroBot session placeholder", async () => {
    const adapter = new ClaudeStreamAdapter("claude");
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "tarobot-12345",
    });
  });

  it("propagates the result's usage so /usage and budget enforcement see Claude spend", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    const turn = adapter.sendUserMessage("telegram-12345", { text: "count me", files: [] });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-usage"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-usage","usage":{"input_tokens":11,"output_tokens":7,"cache_read_input_tokens":3},"total_cost_usd":0.0012}\n');

    // The worker resolves with usage — sendUserMessage must not drop it (it
    // previously did, making every Claude turn invisible to usage/budget).
    await expect(turn).resolves.toMatchObject({
      text: "ONE",
      usage: { inputTokens: 11, outputTokens: 7, cachedTokens: 3, costUsd: 0.0012 },
    });
  });

  it("decodes UTF-8 JSON correctly when a multibyte character crosses stdout chunks", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const turn = adapter.sendUserMessage("telegram-12345", { text: "中文", files: [] });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);

    const line = Buffer.from('{"type":"result","subtype":"success","is_error":false,"result":"你好🙂","session_id":"session-utf8"}\n');
    const marker = line.indexOf(Buffer.from("好"));
    children[0].stdout.emitData(line.subarray(0, marker + 1));
    children[0].stdout.emitData(line.subarray(marker + 1));

    await expect(turn).resolves.toEqual({ text: "你好🙂", sessionId: "session-utf8" });
  });

  it("processes the final JSON event when the CLI exits without a newline", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const turn = adapter.sendUserMessage("telegram-12345", { text: "finish", files: [] });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);

    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"FINAL","session_id":"session-final"}');
    children[0].close(0);

    await expect(turn).resolves.toEqual({ text: "FINAL", sessionId: "session-final" });
  });

  it("keeps a Chrome-enabled persistent Claude session alive across multiple turns", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      enableChromeIntegration: true,
    });

    const first = adapter.sendUserMessage("telegram-12345", {
      text: "First",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    expect(calls[0]?.args).toEqual([
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--forward-subagent-text",
      "--permission-prompt-tool",
      "stdio",
      "--chrome",
      "--permission-mode", "manual",
    ]);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"ONE"}]},"session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');

    await expect(first).resolves.toEqual({
      text: "ONE",
      sessionId: "session-123",
    });

    const second = adapter.sendUserMessage("session-123", {
      text: "Second",
      files: [],
    });

    await waitFor(() => children[0].stdin.lines.length === 2);
    expect(children).toHaveLength(1);
    const secondInput = JSON.parse(children[0].stdin.lines[1] ?? "{}");
    expect(secondInput.message.content[0].text).toBe("Second");
    children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"TWO"}]},"session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-123"}\n');

    await expect(second).resolves.toEqual({
      text: "TWO",
    });
  });

  it("defaults configured stream Claude instances without approval mode to unsafe bypass", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, "{}\n", "utf8");
      const adapter = new ClaudeStreamAdapter("claude", {
        spawnFn,
        configPath,
      });

      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "First",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      expect(calls[0]?.args).toContain("--dangerously-skip-permissions");
      expect(calls[0]?.args).not.toContain("bypassPermissions");
      expect(calls[0]?.args).not.toContain("--chrome");

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');
      await expect(turn).resolves.toEqual({
        text: "ONE",
        sessionId: "session-123",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it.each(["manual", "auto", "acceptEdits"])("uses explicit native %s permissions and routes remaining approvals", async (permissionMode) => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-permissions-"));
    const configPath = path.join(root, "config.json");
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn, configPath });
    const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "deny" });
    try {
      await writeFile(configPath, JSON.stringify({ engine: "claude", approvalMode: "normal", claudePermissionMode: permissionMode }));
      const turn = adapter.sendUserMessage("telegram-12345", { text: "Test", files: [], onApprovalRequest });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      expect(calls[0]?.args).toEqual(expect.arrayContaining(["--permission-mode", permissionMode]));
      expect(calls[0]?.args).not.toContain("--dangerously-skip-permissions");
      children[0].stdout.emitData(JSON.stringify({ type: "control_request", request_id: "permission-test", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "fixture" } } }) + "\n");
      await waitFor(() => children[0].stdin.lines.length === 2);
      expect(onApprovalRequest).toHaveBeenCalledTimes(1);
      expect(JSON.parse(children[0].stdin.lines[1]!)).toMatchObject({ type: "control_response", response: { response: { behavior: "deny" } } });
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"session-123"}\n');
      await expect(turn).resolves.toMatchObject({ text: "done" });
    } finally { await adapter.destroy(); await removeTempRoot(root); }
  });

  it("sanitizes an incompatible config effort through the validated reader on the Claude path", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    // sanitizeConfigCompatibility logs the dropped effort; keep test output clean.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      // effort "ultra" is not a Claude effort: the raw reader used to forward it
      // as `--effort ultra`; the validated reader must drop it.
      await writeFile(
        configPath,
        JSON.stringify({ engine: "claude", approvalMode: "normal", effort: "ultra", model: "opus" }) + "\n",
        "utf8",
      );
      const adapter = new ClaudeStreamAdapter("claude", {
        spawnFn,
        configPath,
      });

      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "First",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      expect(calls[0]?.args).not.toContain("--effort");
      expect(calls[0]?.args).toContain("--model");
      expect(calls[0]?.args).toContain("opus");

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');
      await expect(turn).resolves.toEqual({
        text: "ONE",
        sessionId: "session-123",
      });

      // Control: a compatible effort still reaches the CLI unchanged.
      const compatibleHarness = createSpawnHarness();
      await writeFile(
        configPath,
        JSON.stringify({ engine: "claude", approvalMode: "normal", effort: "high", model: "opus" }) + "\n",
        "utf8",
      );
      const compatibleAdapter = new ClaudeStreamAdapter("claude", {
        spawnFn: compatibleHarness.spawnFn,
        configPath,
      });
      const compatibleTurn = compatibleAdapter.sendUserMessage("telegram-12345", {
        text: "First",
        files: [],
      });
      await waitFor(() => compatibleHarness.children.length === 1 && compatibleHarness.children[0].stdin.lines.length === 1);
      expect(compatibleHarness.calls[0]?.args).toContain("--effort");
      expect(compatibleHarness.calls[0]?.args).toContain("high");
      compatibleHarness.children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-456"}\n');
      compatibleHarness.children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-456"}\n');
      await expect(compatibleTurn).resolves.toEqual({
        text: "TWO",
        sessionId: "session-456",
      });
    } finally {
      consoleError.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("sweeps stale alias keys from the worker map when a turn re-keys the session", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const workers = (adapter as unknown as { workers: Map<string, unknown> }).workers;

    const first = adapter.sendUserMessage("telegram-12345", {
      text: "First",
      files: [],
    });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-1"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-1"}\n');
    await expect(first).resolves.toEqual({
      text: "ONE",
      sessionId: "session-1",
    });
    expect([...workers.keys()]).toEqual(["session-1"]);

    // Simulate a stale alias left behind by an earlier re-key (the reconfigure
    // path re-keys a resumed worker under its engine-reported session id, so the
    // caller's key and the map key can diverge and strand old entries).
    workers.set("session-0", workers.get("session-1")!);

    const second = adapter.sendUserMessage("session-1", {
      text: "Second",
      files: [],
    });
    await waitFor(() => children[0].stdin.lines.length === 2);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-2"}\n');
    await expect(second).resolves.toEqual({
      text: "TWO",
      sessionId: "session-2",
    });

    // The same live process re-keys to the new session id; every other key that
    // pointed at this worker (current AND stale aliases) must be gone.
    expect(children).toHaveLength(1);
    expect([...workers.keys()]).toEqual(["session-2"]);
  });

  it("reaps an idle Claude worker after the configured TTL and resumes on the next turn", async () => {
    vi.useFakeTimers();
    const { children, calls, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      idleWorkerTtlMs: 10,
      idleSweepIntervalMs: 5,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "First",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');
      await expect(first).resolves.toEqual({
        text: "ONE",
        sessionId: "session-123",
      });

      await vi.advanceTimersByTimeAsync(20);

      const second = adapter.sendUserMessage("session-123", {
        text: "Second",
        files: [],
      });

      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      expect(calls[1]?.args).toContain("-r");
      expect(calls[1]?.args).toContain("session-123");
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({
        text: "TWO",
      });
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("does not reap a Claude worker while a turn is in flight", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      idleWorkerTtlMs: 10,
      idleSweepIntervalMs: 5,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Long task",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      await vi.advanceTimersByTimeAsync(100);

      const second = adapter.sendUserMessage("telegram-67890", {
        text: "Another session",
        files: [],
      });
      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-456"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-456"}\n');

      await expect(first).resolves.toEqual({
        text: "ONE",
        sessionId: "session-123",
      });
      await expect(second).resolves.toEqual({
        text: "TWO",
        sessionId: "session-456",
      });
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("resumes an existing Claude session when there is no live worker", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const resultPromise = adapter.sendUserMessage("session-abc", {
      text: "Resume",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    expect(calls[0]?.args).toEqual([
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--forward-subagent-text",
      "--permission-prompt-tool",
      "stdio",
      "--no-chrome",
      "-r",
      "session-abc",
      "--permission-mode", "manual",
    ]);
    expect(calls[0]?.options.windowsHide).toBe(true);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-abc"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"READY","session_id":"session-abc"}\n');

    await expect(resultPromise).resolves.toEqual({
      text: "READY",
    });
  });

  it("can opt out of Claude AskUserQuestion for plain transports", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      disallowedTools: ["AskUserQuestion"],
    });

    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Do not ask interactively",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    expect(calls[0]?.args).toContain("--disallowedTools");
    expect(calls[0]?.args).toContain("AskUserQuestion");
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"session-123"}\n');

    await expect(resultPromise).resolves.toEqual({
      text: "OK",
      sessionId: "session-123",
    });
  });

  it("runs resumed Claude sessions in the selected workspace override", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const botWorkspace = path.join(root, "bot-workspace");
    const resumedWorkspace = path.join(root, "resumed-project");

    try {
      const adapter = new ClaudeStreamAdapter("claude", {
        spawnFn,
        workspacePath: botWorkspace,
      });

      const resultPromise = adapter.sendUserMessage("session-abc", {
        text: "Resume",
        files: [],
        workspaceOverride: resumedWorkspace,
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      expect(calls[0]?.options.cwd).toBe(resumedWorkspace);
      expect(calls[0]?.args).toContain("--add-dir");
      expect(calls[0]?.args).toContain(resumedWorkspace);
      expect(calls[0]?.args).not.toContain(botWorkspace);

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-abc"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"READY","session_id":"session-abc"}\n');

      await expect(resultPromise).resolves.toEqual({
        text: "READY",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("restarts the worker when instructions or approval mode change", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");
    const configPath = path.join(root, "config.json");
    const workspacePath = path.join(root, "workspace");

    try {
      await writeFile(instructionsPath, "You are v1.", "utf8");
      await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");

      const adapter = new ClaudeStreamAdapter("claude", {
        spawnFn,
        instructionsPath,
        configPath,
        workspacePath,
      });

      const first = adapter.sendUserMessage("telegram-12345", {
        text: "First",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');
      const firstResult = await first;
      expect(firstResult.sessionId).toBe("session-123");

      await writeFile(instructionsPath, "You are v2.", "utf8");
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }) + "\n", "utf8");

      const second = adapter.sendUserMessage("session-123", {
        text: "Second",
        files: [],
      });

      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      expect(calls[1]?.args).not.toContain("--system-prompt");
      expect(calls[1]?.args).not.toContain("--append-system-prompt");
      expect(calls[1]?.args).toContain("--append-system-prompt-file");
      const secondPromptFilePath = calls[1]?.args[calls[1].args.indexOf("--append-system-prompt-file") + 1];
      expect(secondPromptFilePath).toBeTruthy();
      await expect(readFile(secondPromptFilePath!, "utf8")).resolves.toContain("You are v2.");
      expect(calls[1]?.args.join(" ")).not.toContain("You are v2.");
      const secondTurn = JSON.parse(children[1].stdin.lines[0] ?? "{}");
      expect(secondTurn.message.content[0].text).toBe("Second");
      expect(calls[1]?.args).toContain("--permission-mode");
      expect(calls[1]?.args).toContain("bypassPermissions");
      expect(calls[1]?.args).toContain("-r");
      expect(calls[1]?.args).toContain("session-123");

      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({ text: "TWO" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("merges bridge instructions with instance agent instructions", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "You are v1.", "utf8");
      const adapter = new ClaudeStreamAdapter("claude", {
        spawnFn,
        instructionsPath,
      });

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        instructions: "[Telegram Bridge Capabilities]\nUse file blocks.",
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      expect(calls[0]?.args).not.toContain("--system-prompt");
      expect(calls[0]?.args).not.toContain("--append-system-prompt");
      expect(calls[0]?.args).toContain("--append-system-prompt-file");
      const promptFilePath = calls[0]?.args[calls[0].args.indexOf("--append-system-prompt-file") + 1];
      expect(promptFilePath).toBeTruthy();
      const promptFile = await readFile(promptFilePath!, "utf8");
      expect(promptFile).toContain("You are v1.");
      expect(promptFile).toContain("[Telegram Bridge Capabilities]");
      const turn = JSON.parse(children[0].stdin.lines[0] ?? "{}");
      expect(turn.message.content[0].text).toBe("Hello");

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"session-123"}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps one worker when only turn-scoped instructions change", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    const first = adapter.sendUserMessage("telegram-12345", {
      text: "first request",
      files: [],
      instructions: "Stable Lark contract",
      turnInstructions: "First-turn delivery check",
    });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    const firstTurn = JSON.parse(children[0].stdin.lines[0] ?? "{}");
    expect(firstTurn.message.content[0].text).toContain("First-turn delivery check");
    expect(firstTurn.message.content[0].text).toContain("first request");
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');
    await expect(first).resolves.toEqual({ text: "ONE", sessionId: "session-123", usage: undefined });

    const second = adapter.sendUserMessage("session-123", {
      text: "second request",
      files: [],
      instructions: "Stable Lark contract",
      turnInstructions: "Second-turn delivery check",
    });
    await waitFor(() => children[0].stdin.lines.length === 2);
    expect(children).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const secondTurn = JSON.parse(children[0].stdin.lines[1] ?? "{}");
    expect(secondTurn.message.content[0].text).toContain("Second-turn delivery check");
    expect(secondTurn.message.content[0].text).not.toContain("First-turn delivery check");
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-123"}\n');
    await expect(second).resolves.toEqual({ text: "TWO", usage: undefined });
  });

  it("rejects structured error results", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Fail",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":true,"result":"Permission denied","session_id":"session-123"}\n');

    await expect(resultPromise).rejects.toThrow("Permission denied");
  });

  it.each([false, true])("keeps CLI auth failure envelopes out of answers (prior output=%s)", async prior => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const onProgress = vi.fn(), onEngineEvent = vi.fn();
    const result = adapter.sendUserMessage("auth-failure", { text: "Check", files: [], onProgress, onEngineEvent });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"auth-session"}\n');
    if (prior) children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"A real answer before the failure."}]}}\n');
    const failure = "Failed to authenticate: OAuth session expired and could not be refreshed";
    children[0].stdout.emitData(JSON.stringify({ type: "assistant", error: "authentication_failed", isApiErrorMessage: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: failure }] } }) + "\n");
    children[0].stdout.emitData('{"type":"result","is_error":true,"result":"","session_id":"auth-session"}\n');
    await expect(result).rejects.toMatchObject({ name: "ClaudeError", message: failure });
    expect(onProgress.mock.calls.map(call => call[0])).toEqual(prior ? ["A real answer before the failure."] : []);
    expect(onEngineEvent.mock.calls.filter(call => call[0].type === "assistant_text").map(call => call[0].text))
      .toEqual(prior ? ["A real answer before the failure."] : []);
    expect(children).toHaveLength(1); // Auth failures must not replay work.
    await adapter.destroy();
  });

  it.each([false, true])("retains an assistant auth error on CLI exit (MCP warning=%s)", async warning => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const onProgress = vi.fn();
    const result = adapter.sendUserMessage("auth-exit", { text: "Check", files: [], onProgress });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    if (warning) children[0].stdout.emitData(JSON.stringify({ type: "system", subtype: "init", session_id: "auth-session",
      mcp_server_errors: [{ name: "probe", message: "invalid config" }] }) + "\n");
    children[0].stdout.emitData('{"type":"assistant","error":"authentication_failed","message":{"model":"<synthetic>","content":[{"type":"text","text":"Failed to authenticate: OAuth session expired"}]}}\n');
    children[0].close(1);
    await expect(result).rejects.toMatchObject({ name: "ClaudeError", message: expect.stringContaining("Failed to authenticate: OAuth session expired") });
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain("Failed to authenticate");
    await adapter.destroy();
  });

  it("preserves ordinary answer text discussing an authentication error", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const onProgress = vi.fn();
    const result = adapter.sendUserMessage("auth-explanation", { text: "Explain this error", files: [], onProgress });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    const answer = "Failed to authenticate means the CLI needs a fresh sign-in.";
    children[0].stdout.emitData(JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: answer }] } }) + "\n");
    children[0].stdout.emitData(JSON.stringify({ type: "result", result: answer }) + "\n");
    await expect(result).resolves.toMatchObject({ text: answer });
    expect(onProgress).toHaveBeenCalledWith(answer);
    await adapter.destroy();
  });

  it.each(["", "Failed to authenticate", "Failed\r\n  to\tauthenticate", null])("rejects contradictory success after an unresolved auth error (%s)", async text => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const onProgress = vi.fn();
    const result = adapter.sendUserMessage("auth-terminal", { text: "Check", files: [], onProgress });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData(JSON.stringify({ type: "assistant", error: "authentication_failed",
      message: { model: "<synthetic>", content: text === null ? [] : [{ type: "text", text: "Failed to authenticate" }] } }) + "\n");
    children[0].stdout.emitData(JSON.stringify({ type: "result", is_error: false, result: text ?? "" }) + "\n");
    await expect(result).rejects.toMatchObject({ name: "ClaudeError", message: text === null ? "Claude authentication failed" : "Failed to authenticate" });
    expect(onProgress).not.toHaveBeenCalled();
    await adapter.destroy();
  });

  it("allows a genuine answer after the CLI recovers from a synthetic API error", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const onProgress = vi.fn();
    const result = adapter.sendUserMessage("auth-recovered", { text: "Check", files: [], onProgress });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"assistant","error":"api_error","message":{"model":"<synthetic>","content":[{"type":"text","text":"API Error: 503"}]}}\n');
    children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"Recovered answer"}]}}\n');
    children[0].stdout.emitData('{"type":"result","is_error":false,"result":""}\n');
    await expect(result).resolves.toMatchObject({ text: "Recovered answer" });
    expect(onProgress.mock.calls.map(call => call[0])).toEqual(["Recovered answer"]);
    await adapter.destroy();
  });

  it("does not reject with an empty error for empty structured error results", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Fail",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"error","is_error":true,"result":"","session_id":"session-123"}\n');

    await expect(resultPromise).rejects.toThrow("Claude reported an error");
  });

  it("does not expose internal reminders when a structured error contains only protocol text", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Fail",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: [
        "user<system-reminder>",
        "[SYSTEM NOTIFICATION - NOT USER INPUT]",
        "<task-notification>",
        "<task-id>task-secret</task-id>",
        "<output-file>/private/tmp/claude/task-secret.output</output-file>",
        "</task-notification>",
      ].join("\n"),
      session_id: "session-123",
    }) + "\n");

    const error = await resultPromise.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Claude reported an error");
  });

  it("surfaces stderr when Claude stream exits before completing a turn", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Fail",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stderr.emitData("No deferred tool marker found in the resumed session.");
    children[0].close(1);

    await expect(resultPromise).rejects.toThrow(/No deferred tool marker/);
  });

  it("routes Claude stdio permission requests through the Telegram approval callback", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const approvalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "once" });
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Use a tool",
      files: [],
      onApprovalRequest: approvalRequest,
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData(JSON.stringify({
      type: "control_request",
      request_id: "approval-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: { file_path: "/tmp/a.txt", content: "hello" },
        cwd: "/tmp/workspace",
      },
    }) + "\n");

    await waitFor(() => children[0].stdin.lines.length === 2);
    expect(approvalRequest).toHaveBeenCalledWith(expect.objectContaining({
      engine: "claude",
      toolName: "Write",
      toolInput: { file_path: "/tmp/a.txt", content: "hello" },
      approvalScopes: { once: "once", session: "session" },
      cwd: "/tmp/workspace",
      sessionId: "session-123",
    }));
    expect(JSON.parse(children[0].stdin.lines[1] ?? "{}")).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "approval-1",
        response: {
          behavior: "allow",
          updatedInput: { file_path: "/tmp/a.txt", content: "hello" },
        },
      },
    });

    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"session-123"}\n');
    await expect(resultPromise).resolves.toEqual({
      text: "DONE",
      sessionId: "session-123",
    });
  });

  it("coalesces overlapping identical stdio approval requests", async () => {
    const { children, spawnFn } = createSpawnHarness();
    let resolveDecision!: (decision: { behavior: "deny" }) => void;
    const decision = new Promise<{ behavior: "deny" }>((resolve) => {
      resolveDecision = resolve;
    });
    const approvalRequest = vi.fn(() => decision);
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Use a tool",
      files: [],
      onApprovalRequest: approvalRequest,
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    const request = (requestId: string) => JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /tmp/example" },
      },
    }) + "\n";
    children[0].stdout.emitData(request("approval-1"));
    children[0].stdout.emitData(request("approval-2"));
    await waitFor(() => approvalRequest.mock.calls.length === 1);
    resolveDecision({ behavior: "deny" });
    await waitFor(() => children[0].stdin.lines.length === 3);

    expect(approvalRequest).toHaveBeenCalledTimes(1);
    expect(children[0].stdin.lines.slice(1).map((line) => JSON.parse(line).response.request_id).sort()).toEqual([
      "approval-1",
      "approval-2",
    ]);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"session-123"}\n');
    await expect(resultPromise).resolves.toMatchObject({ text: "DONE" });
  });

  it("routes AskUserQuestion through the callback even in full-auto mode", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    const answeredInput = {
      questions: [
        {
          question: "Choose one?",
          header: "Choice",
          multiSelect: false,
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
        },
      ],
      answers: {
        "Choose one?": "A",
      },
    };
    const approvalRequest = vi.fn().mockResolvedValue({
      behavior: "allow",
      updatedInput: answeredInput,
    });
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      configPath,
    });

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }) + "\n", "utf8");
      const resultPromise = adapter.sendUserMessage("telegram-12345", {
        text: "Ask me",
        files: [],
        onApprovalRequest: approvalRequest,
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "control_request",
        request_id: "question-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Choose one?",
                header: "Choice",
                multiSelect: false,
                options: [
                  { label: "A", description: "First" },
                  { label: "B", description: "Second" },
                ],
              },
            ],
          },
        },
      }) + "\n");

      await waitFor(() => children[0].stdin.lines.length === 2);
      expect(approvalRequest).toHaveBeenCalledTimes(1);
      expect(JSON.parse(children[0].stdin.lines[1] ?? "{}")).toEqual({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "question-1",
          response: {
            behavior: "allow",
            updatedInput: answeredInput,
          },
        },
      });

      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"session-123"}\n');
      await expect(resultPromise).resolves.toEqual({
        text: "DONE",
        sessionId: "session-123",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("carries native Claude plans, edit receipts and search sources into the App journal", async () => {
    const { children, spawnFn } = createSpawnHarness(), probe = nativeRunProbe();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const turn = adapter.sendUserMessage("telegram-12345", { text: "inspect", files: [], onEngineEvent: probe.onEngineEvent });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      const emit = (event: object) => children[0].stdout.emitData(JSON.stringify(event) + "\n");
      emit({ type: "system", subtype: "init", session_id: "native" });
      const call = (id: string, name: string, input: object) => emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
      const result = (id: string, content: string, tool_use_result?: unknown, is_error = false) => emit({ type: "user", tool_use_result, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
      call("plan", "TodoWrite", { todos: [{ content: "Check report", status: "in_progress" }] });
      result("plan", "Saved");
      expect(probe.record.entries).toHaveLength(1);
      expect(runPlan(probe.record.entries[0])).toEqual([{ content: "Check report", status: "in_progress" }]);
      call("edit", "Edit", { file_path: "/report.md", old_string: "before", new_string: "requested" });
      result("edit", "updated", { filePath: "/report.md", structuredPatch: [{ lines: ["-before", "+actual"] }] });
      expect(runDiff(probe.record.entries[1])).toBe("/report.md\n-before\n+actual");
      call("positioned", "Edit", { file_path: "/positioned.ts" });
      result("positioned", "updated", { filePath: "/positioned.ts", structuredPatch: [{ oldStart: 42, oldLines: 1, newStart: 42, newLines: 2, lines: ["-old", "+new", "+more"] }] });
      expect(runDiff(probe.record.entries[2])).toContain("@@ -42,1 +42,2 @@");
      call("created", "Write", { file_path: "/new.ts" });
      result("created", "created", { type: "create", filePath: "/new.ts", content: "created\n", structuredPatch: [] });
      expect(runDiff(probe.record.entries[3])).toContain("@@ -0,0 +1,1 @@\n+created");
      call("search", "WebSearch", { query: "source" });
      result("search", "found", { durationSeconds: 1.25, results: [{ content: [{ url: "https://example.com/source", title: "Source" }] }] });
      expect(probe.record.entries[4]).toMatchObject({ sources: [{ url: "https://example.com/source", title: "Source" }], durationMs: 1250 });
      call("bash", "Bash", { command: "false", description: "Check command" });
      result("bash", '{"exitCode":0}', { stdout: "exitCode: 0", stderr: "failed", interrupted: false }, true);
      expect(probe.record.entries[5]).toMatchObject({ status: "error" });
      expect(probe.record.entries[5].exitCode).toBeUndefined();
      expect(summarizeRun(probe.record, "running").phase).not.toBe("done");
      emit({ type: "result", result: "Reported failure accurately", session_id: "native" }); await turn;
      expect(summarizeRun(probe.record, "done")).toMatchObject({ phase: "done", count: 5, failed: 1 });
    } finally { await adapter.destroy(); }
  });

  it("streams partial text and thinking before completed blocks without duplicating them in the shared renderer", async () => {
    const { children, spawnFn } = createSpawnHarness(); const events: EngineStreamEvent[] = [], progress = vi.fn();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const response = adapter.sendUserMessage("telegram-12345", { text: "Stream", files: [], onProgress: progress, onEngineEvent: (event) => { events.push(event); } });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    const emit = (event: object) => children[0].stdout.emitData(JSON.stringify(event) + "\n");
    const stream = (event: object) => emit({ type: "stream_event", session_id: "native", event });
    emit({ type: "system", subtype: "init", session_id: "native" });
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " 检查" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "状态" } });
    expect(events.filter((e) => e.type === "thinking").map((e) => e.text).join("")).toBe("检查状态");
    emit({ type: "assistant", message: { content: [{ type: "thinking", thinking: " 检查状态" }] } });
    stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好 " } });
    stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "世界\n" } });
    expect(progress).toHaveBeenLastCalledWith("你好 世界");
    expect(events.filter((e) => e.type === "assistant_text").map((e) => e.text).join("")).toBe("你好 世界");
    // Native CLI emits this complete block before content_block_stop.
    emit({ type: "assistant", message: { content: [{ type: "text", text: "你好 世界\n" }] } });
    stream({ type: "content_block_stop", index: 1 });
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool", name: "Read", input: {} }] } });
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "ok" }] } });
    stream({ type: "content_block_start", index: 2, content_block: { type: "text", text: "下一段" } });
    emit({ type: "assistant", message: { content: [{ type: "text", text: "下一段完成" }] } });
    emit({ type: "result", result: "下一段完成", session_id: "native" }); await response;
    const rendered = events.reduce(applyCoreEngineEvent, initialCoreRunState("lark:test"));
    expect(rendered.reasoning.content).toBe("检查状态");
    expect(events.filter(e => e.type === "thinking").map(e => e.delta)).toEqual([false, true]);
    expect(rendered.blocks.filter((b) => b.kind === "text").map((b) => b.content)).toEqual(["你好 世界", "下一段完成"]);
    expect(progress).toHaveBeenLastCalledWith("你好 世界\n下一段完成");
    await adapter.destroy();
  });

  it("withholds split internal frames, preserves fenced examples, ignores malformed and child partials", async () => {
    const { children, spawnFn } = createSpawnHarness(); const events: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const result = adapter.sendUserMessage("telegram-12345", { text: "Stream safely", files: [], onEngineEvent: (event) => { events.push(event); } });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    const emit = (value: object) => children[0].stdout.emitData(JSON.stringify(value) + "\n");
    const stream = (event: object) => emit({ type: "stream_event", event });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    const parts = ["公开内容\nus", "er <sys", "tem-reminder>\nPRIVATE", "_FRAME\n</system-reminder>\n", "继续公开内容\n", "```xml\n<system-reminder>literal example</system-reminder>\n```"];
    for (const text of parts) {
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      const visible = events.filter((e) => e.type === "assistant_text").map((e) => e.text).join("");
      expect(visible).not.toContain("PRIVATE"); expect(visible).not.toContain("_FRAME");
    }
    stream({ type: "content_block_delta", index: -1, delta: { type: "text_delta", text: "MALFORMED" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: { forged: true } } });
    emit({ type: "stream_event", parent_tool_use_id: "child", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CHILD" } } });
    emit({ type: "assistant", message: { content: [{ type: "text", text: parts.join("") }] } });
    emit({ type: "result", session_id: "native" });
    const answer = await result, visible = events.filter((e) => e.type === "assistant_text").map((e) => e.text).join("");
    expect(answer.text).toBe(visible); expect(visible).toContain("literal example"); expect(visible).not.toMatch(/PRIVATE|MALFORMED|CHILD/);
    await adapter.destroy();
  });

  it("emits structured Claude stream events for tools, text, permission, and result", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Use tools",
      files: [],
      onApprovalRequest: vi.fn().mockResolvedValue({ behavior: "deny" }),
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "I should inspect files" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "Working..." },
        ],
      },
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "control_request",
      request_id: "approval-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "approval-call-1",
        input: { command: "rm -rf /tmp/example" },
      },
    }) + "\n");

    await waitFor(() => children[0].stdin.lines.length === 2);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"session-123"}\n');
    await promise;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session", sessionId: "session-123" }),
      expect.objectContaining({ type: "thinking", text: "I should inspect files", sessionId: "session-123" }),
      expect.objectContaining({ type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, sessionId: "session-123" }),
      expect.objectContaining({ type: "assistant_text", text: "Working...", sessionId: "session-123" }),
      expect.objectContaining({ type: "permission_request", toolName: "Bash", toolUseId: "approval-call-1", toolInput: { command: "rm -rf /tmp/example" }, sessionId: "session-123" }),
      expect.objectContaining({ type: "result", text: "DONE", sessionId: "session-123" }),
    ]));
  });

  it("does not invent a completed task from an empty orphan recovery result", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const turn = adapter.sendUserMessage("telegram-isolation", { text: "new request", files: [], onEngineEvent: event => { events.push(event); } });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      children[0].stdout.emitData(JSON.stringify({ type: "result", origin: { kind: "task-notification" }, result: "", session_id: "parent-session" }) + "\n");
      children[0].stdout.emitData(JSON.stringify({ type: "system", subtype: "init", session_id: "parent-session" }) + "\n");
      children[0].stdout.emitData(JSON.stringify({ type: "result", result: "actual new answer", session_id: "parent-session" }) + "\n");
      await expect(turn).resolves.toMatchObject({ text: "actual new answer", sessionId: "parent-session" });
      expect(events.filter(event => event.type === "task_notification" && !event.suppressUserDelivery)).toEqual([]);
    } finally { await adapter.destroy(); }
  });

  it.each(["", "No response requested."])("keeps a silent Monitor expiry out of chat (%j) and releases the next prompt", async (review) => {
    const { children, spawnFn } = createSpawnHarness();
    const events: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const first = adapter.sendUserMessage("monitor-session", { text: "Scan disk", files: [], onEngineEvent: e => { events.push(e); } });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      const send = (frame: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "monitor-session", ...frame }) + "\n");
      send({ type: "result", result: "Scan report delivered" });
      await first;
      send({ type: "user", origin: { kind: "task-notification", producer: "session-task" }, message: { content: '<task-notification><task-id>monitor-1</task-id><summary>Monitor event: "disk scan"</summary><event>[Monitor expired after 30m with 2 events delivered. Re-arm it if you still need the watch.]</event></task-notification>' } });
      const next = adapter.sendUserMessage("monitor-session", { text: "Quote the no-response phrase", files: [], onEngineEvent: e => { events.push(e); } });
      void next.catch(() => undefined); // Cleanup also runs after a failed assertion.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(children[0].stdin.lines).toHaveLength(1);
      send({ type: "assistant", message: { content: [{ type: "text", text: review }] } });
      // Some CLI versions omit origin on the review's terminal result.
      send({ type: "result", result: review });
      await waitFor(() => children[0].stdin.lines.length === 2);
      expect(events.filter(e => e.type === "task_notification" || e.type === "background_task_finished")).toEqual([]);
      send({ type: "result", result: "No response requested." });
      await expect(next).resolves.toMatchObject({ text: "No response requested." });
    } finally { await adapter.destroy(); }
  });

  it("delivers meaningful Monitor progress without completing the task or its foreground turn", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const events: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const turn = adapter.sendUserMessage("monitor-session", { text: "Scan disk", files: [], onEngineEvent: e => { events.push(e); } });
      void turn.catch(() => undefined);
      let settled = false;
      void turn.then(() => { settled = true; }, () => { settled = true; });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      const send = (frame: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "monitor-session", ...frame }) + "\n");
      send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "monitor-start", input: { run_in_background: true } }] } });
      send({ type: "system", subtype: "task_started", task_id: "monitor-1", tool_use_id: "monitor-start", summary: "Scan disk" });
      send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>monitor-1</task-id><summary>Monitor event: "disk scan"</summary><event>Found a large cache</event></task-notification>' } });
      send({ type: "result", origin: { kind: "task-notification" }, result: "Found 6 GB of rebuildable cache." });
      expect(events.filter(e => e.type === "background_task_finished")).toEqual([]);
      expect(events.filter(e => e.type === "task_notification")).toEqual([expect.objectContaining({
        taskId: "monitor-1", status: "update", text: "Found 6 GB of rebuildable cache.", origin: "bound",
      })]);
      expect(events.some(e => e.type === "task_notification" && e.settlesCurrentTurn)).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(false);
      // A real terminal envelope must still retain the original task owner.
      send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>monitor-1</task-id><status>completed</status><summary>Scan finished</summary></task-notification>' } });
      send({ type: "result", origin: { kind: "task-notification" }, result: "Scan finished; no changes made." });
      expect(events.filter(e => e.type === "background_task_finished")).toEqual([expect.objectContaining({ taskId: "monitor-1", status: "completed" })]);
      expect(events.filter(e => e.type === "task_notification").at(-1)).toMatchObject({ origin: "bound", status: "completed" });
      send({ type: "result", result: "Actual foreground answer" });
      await expect(turn).resolves.toMatchObject({ text: "Actual foreground answer" });
    } finally { await adapter.destroy(); vi.useRealTimers(); }
  });

  it("marks recovered task reports as unattributed instead of linking them to the new prompt", async () => {
    const { children, spawnFn } = createSpawnHarness(); const events: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const turn = adapter.sendUserMessage("telegram-recovery", { text: "NEW REQUEST", files: [], onEngineEvent: e => { events.push(e); } });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      const send = (frame: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "parent", ...frame }) + "\n");
      send({ type: "system", subtype: "init" });
      send({ type: "system", subtype: "task_notification", task_id: "old", status: "stopped" });
      send({ type: "result", origin: { kind: "task-notification" }, task_id: "old", result: "Recovered old task report" });
      send({ type: "result", result: "New answer" });
      await expect(turn).resolves.toMatchObject({ text: "New answer" });
      expect(events.filter(e => e.type === "task_notification")).toEqual([expect.objectContaining({ origin: "unattributed", status: "stopped", text: "Recovered old task report" })]);
    } finally { await adapter.destroy(); }
  });

  it("fences child session identities and scopes child output during a background review", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const turn = adapter.sendUserMessage("telegram-parent", { text: "parent request", files: [], onEngineEvent: event => { events.push(event); } });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      const send = (frame: object) => children[0].stdout.emitData(JSON.stringify(frame) + "\n");
      send({ type: "system", subtype: "init", session_id: "parent-session" });
      send({ type: "assistant", message: { content: [{ type: "tool_use", id: "agent-parent", name: "Agent", input: {} }] }, session_id: "parent-session" });
      send({ type: "system", subtype: "init", parent_tool_use_id: "agent-parent", session_id: "child-session" });
      send({ type: "control_request", request_id: "child-capability", parent_tool_use_id: "agent-parent", session_id: "child-session", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } });
      send({ type: "assistant", parent_tool_use_id: "agent-parent", message: { content: [{ type: "text", text: "child progress" }] }, session_id: "child-session" });
      send({ type: "system", subtype: "task_notification", task_id: "parent-task", status: "completed", session_id: "parent-session" });
      send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>parent-task</task-id><status>completed</status><summary>parent task</summary></task-notification>' }, session_id: "parent-session" });
      send({ type: "assistant", parent_tool_use_id: "agent-parent", message: { content: [{ type: "text", text: "CHILD_PUBLIC_RESULT" }] }, session_id: "child-session" });
      send({ type: "result", parent_tool_use_id: "agent-parent", result: "CHILD_PUBLIC_RESULT", session_id: "child-session" });
      send({ type: "assistant", message: { content: [{ type: "text", text: "parent review" }] }, session_id: "parent-session" });
      send({ type: "result", origin: { kind: "task-notification" }, result: "parent review", session_id: "parent-session" });
      send({ type: "result", result: "parent answer", session_id: "parent-session" });
      await expect(turn).resolves.toMatchObject({ text: "parent answer", sessionId: "parent-session" });
      expect(JSON.stringify(events)).not.toContain('child-session');
      expect(JSON.stringify(events.filter(event => event.type !== 'scoped'))).not.toContain('CHILD_PUBLIC_RESULT');
      expect(events).toContainEqual(expect.objectContaining({ type: 'scoped', scope: expect.objectContaining({ kind: 'subagent', parentCallId: 'agent-parent' }), event: { type: 'result', text: 'CHILD_PUBLIC_RESULT' } }));
      expect(children[0].stdin.lines.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: "control_response", response: expect.objectContaining({ request_id: "child-capability", subtype: "success", response: expect.objectContaining({ behavior: "deny" }) }) }));
      expect(events.filter(event => event.type === 'task_notification')).toEqual([expect.objectContaining({ taskId: 'parent-task', text: 'parent review', sessionId: 'parent-session' })]);
    } finally { await adapter.destroy(); }
  });

  it.each(["explicit result first", "queued review first"])("keeps overlapping background results with their owners: %s", async (order) => {
    const { children, spawnFn } = createSpawnHarness();
    const first: EngineStreamEvent[] = [], second: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const a = adapter.sendUserMessage("telegram-parent", { text: "A", files: [], onEngineEvent: e => { first.push(e); } });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      const send = (frame: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "parent-session", ...frame }) + "\n");
      send({ type: "system", subtype: "init" });
      send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "start-A", input: { run_in_background: true } }] } });
      send({ type: "system", subtype: "task_started", task_id: "A", tool_use_id: "start-A" });
      send({ type: "result", result: "A started" });
      await a;
      const b = adapter.sendUserMessage("parent-session", { text: "B", files: [], onEngineEvent: e => { second.push(e); } });
      await waitFor(() => children[0].stdin.lines.length === 2);
      send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "start-B", input: { run_in_background: true } }] } });
      send({ type: "system", subtype: "task_started", task_id: "B", tool_use_id: "start-B" });
      send({ type: "result", result: "B started" });
      await b;
      send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>A</task-id><status>completed</status></task-notification>' } });
      send({ type: "assistant", message: { content: [{ type: "text", text: "A review" }] } });
      send({ type: "result", origin: { kind: "task-notification" }, task_id: "unknown", result: "UNOWNED_RESULT" });
      if (order === "explicit result first") {
        send({ type: "system", subtype: "task_notification", task_id: "B", status: "completed" });
        send({ type: "result", origin: { kind: "task-notification" }, task_id: "B", result: "B result" });
        send({ type: "result", origin: { kind: "task-notification" }, task_id: "A", result: "" });
      } else {
        send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>B</task-id><status>completed</status></task-notification>' } });
        send({ type: "result", origin: { kind: "task-notification" }, task_id: "A", result: "" });
        send({ type: "result", origin: { kind: "task-notification" }, task_id: "B", result: "B result" });
      }
      expect(first.filter(e => e.type === 'task_notification')).toEqual([expect.objectContaining({ taskId: 'A', text: 'A review', origin: 'bound' })]);
      expect(second.filter(e => e.type === 'task_notification')).toEqual([expect.objectContaining({ taskId: 'B', text: 'B result', origin: 'bound' })]);
    } finally { await adapter.destroy(); }
  });

  it("routes forwarded subagent text to the parent tool without polluting the main answer", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<Record<string, unknown>> = [];
    const onProgress = vi.fn();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Delegate this",
      files: [],
      onProgress,
      onEngineEvent: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData(JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { prompt: "inspect" } }],
      },
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "agent-1",
      message: {
        content: [
          { type: "thinking", thinking: "private child reasoning" },
          {
            type: "text",
            text: "child progress\n\nuser<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nchild secret",
          },
        ],
      },
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "user",
      parent_tool_use_id: "agent-1",
      message: {
        content: [{ type: "tool_result", tool_use_id: "child-tool", content: "child internals" }],
      },
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "agent-1", content: "child done" }],
      },
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"PARENT"}]},"session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"PARENT","session_id":"session-123"}\n');

    await expect(promise).resolves.toEqual({ text: "PARENT", sessionId: "session-123" });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith("PARENT");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_use", toolUseId: "agent-1", toolName: "Agent" }),
      expect.objectContaining({ type: "tool_progress", toolUseId: "agent-1", text: "child progress", delta: false }),
      expect.objectContaining({ type: "tool_result", toolUseId: "agent-1", output: "child done" }),
      expect.objectContaining({ type: "assistant_text", text: "PARENT" }),
    ]));
    expect(events.some((event) => event.type === "thinking" && event.text === "private child reasoning")).toBe(false);
    expect(events.some((event) => event.type === "assistant_text" && event.text === "child progress")).toBe(false);
    expect(events.some((event) => event.type === "tool_result" && event.toolUseId === "child-tool")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("SYSTEM NOTIFICATION");
    expect(JSON.stringify(events)).not.toContain("child secret");
  });

  it("surfaces and deduplicates Claude MCP startup errors", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<Record<string, unknown>> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const warning = "broken_probe: Skipped invalid MCP server config api_key=&#91;redacted&#93; &#91;send-file:/tmp/secret&#93;";

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Check MCP",
      files: [],
      onEngineEvent: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    const init = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session-mcp",
      mcp_server_errors: [
        {
          name: "broken_probe",
          type: "invalid_config",
          message: "Skipped invalid MCP server config api_key=secret-value [send-file:/tmp/secret]",
        },
        { ignored: true },
      ],
    }) + "\n";
    children[0].stdout.emitData(init);
    children[0].stdout.emitData(init);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"session-mcp"}\n');

    await expect(promise).resolves.toEqual({
      text: `DONE\n\n⚠️ MCP startup warning:\n- ${warning}`,
      sessionId: "session-mcp",
    });
    expect(events.filter((event) =>
      event.type === "assistant_text" && typeof event.text === "string" && event.text.includes(warning)
    )).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "assistant_text", text: "DONE", sessionId: "session-mcp" }),
      expect.objectContaining({
        type: "result",
        text: `DONE\n\n⚠️ MCP startup warning:\n- ${warning}`,
        sessionId: "session-mcp",
      }),
    ]));
  });

  it("retains MCP startup diagnostics when Claude fails after init", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Check MCP failure",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session-mcp-failure",
      mcp_server_errors: [{ name: "broken_probe", message: "invalid config" }],
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Turn failed",
      session_id: "session-mcp-failure",
    }) + "\n");

    await expect(promise).rejects.toThrow(
      "Turn failed\n\n⚠️ MCP startup warning:\n- broken_probe: invalid config",
    );
  });

  it("emits Claude background task notifications after the original turn has resolved", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Run in background",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
    await expect(promise).resolves.toEqual({
      text: "Started in the background.",
      sessionId: "session-123",
    });

    children[0].stdout.emitData(JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "The background command completed successfully.",
      session_id: "session-123",
      origin: { kind: "task-notification" },
    }) + "\n");

    await waitFor(() => events.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "task_notification"
    ));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task_notification",
        text: "The background command completed successfully.",
        sessionId: "session-123",
      }),
    ]));
    expect(events.filter((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "task_notification"
    )).toHaveLength(1);
  });

  it("strips echoed internal reminders from Claude background task reviews", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string; text?: string }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const foreground = adapter.sendUserMessage("telegram-12345", {
        text: "Run in background",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-background",
            name: "Bash",
            input: { command: "sleep 5", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-background","tool_use_id":"toolu-background","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await foreground;

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-background</task-id>",
            "<tool-use-id>toolu-background</tool-use-id>",
            "<status>completed</status>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");
      const leakedText = [
        "等三页跑完。",
        "",
        "user<system-reminder>",
        "[SYSTEM NOTIFICATION - NOT USER INPUT]",
        "This is an automated background-task event, NOT a message from the user.",
        "<task-notification>",
        "<task-id>task-background</task-id>",
        "<output-file>/private/tmp/claude/tasks/task-background.output</output-file>",
        "<status>completed</status>",
        "</task-notification>",
      ].join("\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: leakedText }] },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: leakedText,
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");

      await waitFor(() => events.some((event) => event.type === "task_notification"));
      const notification = events.find((event) => event.type === "task_notification");
      expect(notification?.text).toBe("等三页跑完。");
      expect(JSON.stringify(notification)).not.toContain("system-reminder");
      expect(JSON.stringify(notification)).not.toContain("task-notification");
      expect(JSON.stringify(notification)).not.toContain("/private/tmp/claude");
    } finally {
      await adapter.destroy();
    }
  });

  it("strips echoed internal reminders from foreground Claude answers", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string; text?: string }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "Give me the result",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      const leakedText = "可见结果。\n\nuser<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\ninternal only";
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: leakedText }] },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: leakedText,
        session_id: "session-123",
      }) + "\n");

      await expect(turn).resolves.toMatchObject({ text: "可见结果。" });
      expect(events.filter((event) => event.type === "assistant_text")).toEqual([
        expect.objectContaining({ text: "可见结果。" }),
      ]);
      expect(JSON.stringify(events)).not.toContain("SYSTEM NOTIFICATION");
    } finally {
      adapter.destroy();
    }
  });

  it("preserves literal control-tag examples and whitespace inside fenced output", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const literal = [
      "```text",
      "<task-notification>",
      "example without a closing control frame",
      "```",
      "",
      "```file:notes.txt",
      "alpha\t ",
      "",
      "",
      "omega\t",
      "```",
      "",
      "<system-reminder>",
      "This is ordinary unmatched example text.",
      "The answer continues here.",
    ].join("\n");

    try {
      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "Show literal protocol examples",
        files: [],
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: literal,
        session_id: "session-123",
      }) + "\n");

      await expect(turn).resolves.toMatchObject({ text: literal });
    } finally {
      await adapter.destroy();
    }
  });

  it("does not retain foreground Bash calls that Claude temporarily promotes to tasks", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Run a foreground command",
        files: [],
        instructions: "original instructions",
        onEngineEvent: (event) => {
          events.push(event);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-foreground",
            name: "Bash",
            input: { command: "sleep 5; printf done" },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      // Claude 2.1.222 emits this lifecycle for foreground Bash calls that
      // exceed its short synchronous wait, even without run_in_background.
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-foreground","tool_use_id":"toolu-foreground","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-foreground","tool_use_id":"toolu-foreground","status":"completed","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "toolu-foreground",
            content: "done",
            is_error: false,
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Foreground answer.","session_id":"session-123"}\n');
      await first;

      expect(events.some((event) => event.type === "background_task_started")).toBe(false);
      expect(events.some((event) => event.type === "task_notification")).toBe(false);

      // A phantom background task used to reject this settings change for six
      // hours. With no detached work, the adapter can replace the idle worker.
      const second = adapter.sendUserMessage("session-123", {
        text: "Use the new instructions",
        files: [],
        instructions: "changed instructions",
      });
      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Reconfigured.","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({ text: "Reconfigured." });
    } finally {
      adapter.destroy();
    }
  });

  it("retains tasks whose tool call explicitly requests background execution", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string; taskId?: string }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "Run in background",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-background",
            name: "Bash",
            input: { command: "sleep 5", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-background","tool_use_id":"toolu-background","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await turn;

      expect(events).toContainEqual(expect.objectContaining({
        type: "background_task_started",
        taskId: "task-background",
      }));

      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-background","tool_use_id":"toolu-background","status":"completed","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Background done.","session_id":"session-123","origin":{"kind":"task-notification"}}\n');
      await waitFor(() => events.some((event) => event.type === "task_notification"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "task_notification",
        taskId: "task-background",
      }));
    } finally {
      adapter.destroy();
    }
  });

  it("emits a bookkeeping terminal event before a Claude task review finishes", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string; taskId?: string; status?: string }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "Run in background",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-background",
            name: "Bash",
            input: { command: "sleep 5", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-background","tool_use_id":"toolu-background","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await turn;

      // Claude can expose the terminal notification as a synthetic user frame
      // without ever producing the follow-up review result. The lifecycle must
      // still settle immediately so an unrelated service restart is not blocked.
      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "<task-notification>\n<task-id>task-background</task-id>\n<tool-use-id>toolu-background</tool-use-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>",
        },
        origin: { kind: "task-notification" },
        session_id: "session-123",
      }) + "\n");

      await waitFor(() => events.some((event) => event.type === "background_task_finished"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "background_task_finished",
        taskId: "task-background",
        status: "completed",
      }));
      expect(events.some((event) => event.type === "task_notification")).toBe(false);
    } finally {
      await adapter.destroy();
    }
  });

  it("cancels only the waiting prompt and admits a later foreground turn after its Claude review finishes", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const firstEvents: Array<{ type?: string; taskId?: string; status?: string; text?: string }> = [];
    const secondEvents: Array<{ type?: string; text?: string }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Run in background",
        files: [],
        onEngineEvent: (event) => {
          firstEvents.push(event);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-background",
            name: "Bash",
            input: { command: "sleep 5", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-background","tool_use_id":"toolu-background","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await first;

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-background</task-id>",
            "<tool-use-id>toolu-background</tool-use-id>",
            "<output-file>/tmp/task-background.output</output-file>",
            "<status>failed</status>",
            "<summary>Initial attempt failed; reviewing the result</summary>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Intermediate retry failed." }] },
        session_id: "session-123",
      }) + "\n");

      for (const withHandler of [true, false]) {
        const cancelledEvents: EngineStreamEvent[] = [], abort = new AbortController();
        const waiting = adapter.sendUserMessage("session-123", {
          text: "Cancel this waiting question", files: [], abortSignal: abort.signal,
          ...(withHandler ? { onEngineEvent: (event: EngineStreamEvent) => { cancelledEvents.push(event); } } : {}),
        });
        void waiting.catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 0));
        abort.abort(APP_USER_STOP_REASON);
        await expect(waiting).rejects.toThrow("Task was stopped by user");
        expect(children).toHaveLength(1); expect(children[0].stdin.lines).toHaveLength(1); expect(children[0].killCalls).toBe(0);
        if (withHandler) expect(cancelledEvents.filter(event => event.type === "background_review_wait").map(event => event.status)).toEqual(["started", "cancelled"]);
        // An absent incoming handler must not fall back to the previous turn.
        expect(firstEvents.some(event => event.type === "background_review_wait")).toBe(false);
      }

      const second = adapter.sendUserMessage("session-123", {
        text: "Unrelated foreground question",
        files: [],
        onEngineEvent: (event) => {
          secondEvents.push(event);
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(children[0].stdin.lines).toHaveLength(1);
      expect(secondEvents).toContainEqual(expect.objectContaining({ type: "background_review_wait", status: "started" }));

      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Final background review chunk." }] },
        session_id: "session-123",
      }) + "\n");
      // Claude 2.1.228 can omit origin on the result that closes the user-origin
      // review frame. The active review state still identifies its ownership.
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Final verified task result.","session_id":"session-123"}\n');

      await waitFor(() => children[0].stdin.lines.length === 2);
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Foreground answer." }] },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Foreground answer.","session_id":"session-123"}\n');

      await expect(second).resolves.toEqual({ text: "Foreground answer." });
      expect(secondEvents).toContainEqual(expect.objectContaining({ type: "background_review_wait", status: "finished" }));
      await waitFor(() => firstEvents.some((event) => event.type === "task_notification"));
      expect(firstEvents).toContainEqual(expect.objectContaining({
        type: "task_notification",
        taskId: "task-background",
        status: "failed",
        text: "Final verified task result.",
      }));
      expect(secondEvents).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/background|retry/i) }),
      ]));
      expect(secondEvents).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "task_notification" }),
      ]));

      // The terminal user-origin frame must also clear the background-task
      // ledger, otherwise a settings change would stay deferred for six hours.
      const third = adapter.sendUserMessage("session-123", {
        text: "Use changed instructions",
        files: [],
        instructions: "changed instructions",
      });
      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Reconfigured.","session_id":"session-123"}\n');
      await expect(third).resolves.toEqual({ text: "Reconfigured." });
    } finally {
      adapter.destroy();
    }
  });

  it("settles a task whose terminal frame is consumed by its own still-running turn", async () => {
    // The CLI injects a completion into the ACTIVE turn instead of spawning a
    // review, so nothing later settles the ledger entry. It then dangled until
    // the 6h prune — and a service restart inside that window reported the
    // already-consumed task as "stopped because the Claude engine process
    // exited before completion" (a false alarm seen live after a release).
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string; taskId?: string; text?: string; suppressUserDelivery?: boolean }> = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      taskNotificationStartGraceMs: 5,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Run the gate in background and keep working",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu-gate", name: "Bash", input: { command: "npm test", run_in_background: true } }] },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-gate","tool_use_id":"toolu-gate","task_type":"local_bash","session_id":"session-123"}\n');

      // Mid-turn: the task completes and the CLI hands the result to the
      // still-running turn.
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-gate","tool_use_id":"toolu-gate","status":"completed","summary":"Full suite gate","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Gate is green; wrapping up." }] },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"All verified.","session_id":"session-123"}\n');
      await expect(first).resolves.toMatchObject({ text: "All verified." });

      // A settings change waits through the bounded review-start window, then
      // reconfigures instead of remaining pinned behind a phantom task.
      const second = adapter.sendUserMessage("session-123", {
        text: "Use changed instructions",
        files: [],
        instructions: "changed instructions",
      });
      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      const taskEvents = events.filter((event) => event.type === "task_notification");
      expect(taskEvents).toHaveLength(1);
      expect(taskEvents[0]).toEqual(expect.objectContaining({
        taskId: "task-gate",
        suppressUserDelivery: true,
      }));
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Reconfigured.","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({ text: "Reconfigured." });

      // And worker teardown reports no false interruption for it.
      adapter.destroy();
      const deathNotices = events.filter((event) =>
        event.type === "task_notification" && /exited before completion/.test(event.text ?? ""));
      expect(deathNotices).toHaveLength(0);
    } finally {
      adapter.destroy();
    }
  });

  it("delivers a task review that starts after its foreground turn resolves", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{
      type?: string;
      taskId?: string;
      status?: string;
      text?: string;
      suppressUserDelivery?: boolean;
    }> = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      taskNotificationStartGraceMs: 10_000,
    });

    try {
      const foreground = adapter.sendUserMessage("telegram-12345", {
        text: "Run the image check in the background and finish the foreground work",
        files: [],
        onEngineEvent: (event) => {
          events.push(event as never);
        },
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-image-check",
            name: "Bash",
            input: { command: "check-image", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-image-check","tool_use_id":"toolu-image-check","session_id":"session-123"}\n');

      // Claude queues the completion while the originating turn is active,
      // closes that turn, then starts a separate task-origin review.
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-image-check","tool_use_id":"toolu-image-check","status":"completed","summary":"Image check completed","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Foreground work completed.","session_id":"session-123"}\n');
      await expect(foreground).resolves.toMatchObject({ text: "Foreground work completed." });

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-image-check</task-id>",
            "<tool-use-id>toolu-image-check</tool-use-id>",
            "<status>completed</status>",
            "<summary>Image check completed</summary>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "The image passed the final review." }] },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"The image passed the final review.","session_id":"session-123","origin":{"kind":"task-notification"}}\n');

      await waitFor(() => events.some((event) =>
        event.type === "task_notification" && event.suppressUserDelivery !== true
      ));
      expect(events.filter((event) =>
        event.type === "task_notification" && event.suppressUserDelivery !== true
      )).toEqual([
        expect.objectContaining({
          taskId: "task-image-check",
          status: "completed",
          text: "The image passed the final review.",
        }),
      ]);
    } finally {
      await adapter.destroy();
    }
  });

  it("starts the review grace after whichever foreground turn blocked an older task completion", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{
      type?: string;
      taskId?: string;
      text?: string;
      suppressUserDelivery?: boolean;
    }> = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      taskNotificationStartGraceMs: 20,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Start the older background task",
        files: [],
        onEngineEvent: (event) => {
          events.push(event as never);
        },
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-older",
            name: "Bash",
            input: { command: "older-task", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-older","tool_use_id":"toolu-older","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Older task started.","session_id":"session-123"}\n');
      await first;

      const second = adapter.sendUserMessage("session-123", {
        text: "Work on an unrelated foreground request",
        files: [],
      });
      await waitFor(() => children[0].stdin.lines.length === 2);
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-older","tool_use_id":"toolu-older","status":"completed","summary":"Older task completed","session_id":"session-123"}\n');
      await new Promise((resolve) => setTimeout(resolve, 30));
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Foreground request completed.","session_id":"session-123"}\n');
      await second;

      const third = adapter.sendUserMessage("session-123", {
        text: "Queue this behind the older task review",
        files: [],
      });
      void third.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(children[0].stdin.lines).toHaveLength(2);

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-older</task-id>",
            "<tool-use-id>toolu-older</tool-use-id>",
            "<status>completed</status>",
            "<summary>Older task completed</summary>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Older task review delivered.","session_id":"session-123","origin":{"kind":"task-notification"}}\n');

      await waitFor(() => children[0].stdin.lines.length === 3);
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Queued foreground answer.","session_id":"session-123"}\n');
      await expect(third).resolves.toEqual({ text: "Queued foreground answer." });
      expect(events).toContainEqual(expect.objectContaining({
        type: "task_notification",
        taskId: "task-older",
        text: "Older task review delivered.",
      }));
    } finally {
      await adapter.destroy();
    }
  });

  it("keeps a review's identity when another turn's task completes mid-review", async () => {
    // Task P (turn 1) is under review when task T (turn 2) completes. The
    // system frame for T used to REPLACE pendingTaskNotification, so P's
    // review terminal — which carries no task_id on Claude ≥2.1.229 — was
    // attributed to T: delivered under T's id through TURN 2's event handler,
    // T later double-delivered, P never delivered and left a zombie that
    // blocked settings changes for six hours.
    const { children, spawnFn } = createSpawnHarness();
    const firstEvents: Array<{ type?: string; taskId?: string; text?: string }> = [];
    const secondEvents: Array<{ type?: string; taskId?: string; text?: string }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Run P in background",
        files: [],
        onEngineEvent: (event) => {
          firstEvents.push(event);
        },
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu-P", name: "Bash", input: { command: "sleep 5", run_in_background: true } }] },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-P","tool_use_id":"toolu-P","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started P.","session_id":"session-123"}\n');
      await first;

      const second = adapter.sendUserMessage("session-123", {
        text: "Run T in background",
        files: [],
        onEngineEvent: (event) => {
          secondEvents.push(event);
        },
      });
      await waitFor(() => children[0].stdin.lines.length === 2);
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu-T", name: "Bash", input: { command: "sleep 5", run_in_background: true } }] },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-T","tool_use_id":"toolu-T","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started T.","session_id":"session-123"}\n');
      await second;

      // P's review turn starts.
      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-P</task-id>",
            "<tool-use-id>toolu-P</tool-use-id>",
            "<status>completed</status>",
            "<summary>P generation done</summary>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Reviewing P output now." }] },
        session_id: "session-123",
      }) + "\n");

      // T completes MID-REVIEW: its system frame must not steal the review.
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-T","tool_use_id":"toolu-T","status":"completed","summary":"T generation done","session_id":"session-123"}\n');

      // P's review terminal, no task_id (Claude ≥2.1.229 shape).
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"P review verdict: P output verified.","session_id":"session-123"}\n');

      await waitFor(() => firstEvents.some((event) => event.type === "task_notification"));
      expect(firstEvents).toContainEqual(expect.objectContaining({
        type: "task_notification",
        taskId: "task-P",
        text: "P review verdict: P output verified.",
      }));
      expect(secondEvents.filter((event) => event.type === "task_notification")).toHaveLength(0);

      // T's own review then runs and lands on T.
      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-T</task-id>",
            "<tool-use-id>toolu-T</tool-use-id>",
            "<status>completed</status>",
            "<summary>T generation done</summary>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"T review verdict: T output verified.","session_id":"session-123"}\n');

      await waitFor(() => secondEvents.some((event) => event.type === "task_notification"));
      const visibleForT = secondEvents.filter((event) => event.type === "task_notification");
      expect(visibleForT).toHaveLength(1);
      expect(visibleForT[0]).toEqual(expect.objectContaining({
        taskId: "task-T",
        text: "T review verdict: T output verified.",
      }));
      expect(firstEvents.filter((event) => event.type === "task_notification")).toHaveLength(1);

      // Both ledgers cleared: a settings change reconfigures instead of deferring.
      const third = adapter.sendUserMessage("session-123", {
        text: "Use changed instructions",
        files: [],
        instructions: "changed instructions",
      });
      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Reconfigured.","session_id":"session-123"}\n');
      await expect(third).resolves.toEqual({ text: "Reconfigured." });
    } finally {
      adapter.destroy();
    }
  });

  it("does not block a foreground turn on a task notification whose review never starts", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      taskNotificationStartGraceMs: 25,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Run in background",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-background","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await first;

      // A terminal task notification can arrive without the synthetic
      // user/init frame that starts Claude's review turn. It carries task
      // ownership metadata, but must not reserve stdin forever by itself.
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-background","status":"completed","session_id":"session-123"}\n');

      const second = adapter.sendUserMessage("session-123", {
        text: "Continue with the next foreground task",
        files: [],
      });
      void second.catch(() => undefined);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(children[0].stdin.lines).toHaveLength(1);
      await waitFor(() => children[0].stdin.lines.length === 2);
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Foreground continued.","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({ text: "Foreground continued." });
    } finally {
      await adapter.destroy();
    }
  });

  it("does not restart a Claude worker during a task review that had no task_started event", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Start background work",
        files: [],
        instructions: "original instructions",
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await first;

      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-without-start","status":"completed","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');

      const second = adapter.sendUserMessage("session-123", {
        text: "Use the updated instructions after the review",
        files: [],
        instructions: "changed instructions",
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(children).toHaveLength(1);
      expect(children[0].stdin.lines).toHaveLength(1);

      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Review complete.","session_id":"session-123","origin":{"kind":"task-notification"}}\n');
      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Current turn answer.","session_id":"session-123"}\n');

      await expect(second).resolves.toEqual({ text: "Current turn answer." });
      expect(children).toHaveLength(2);
    } finally {
      adapter.destroy();
    }
  });

  it("expires an untracked Claude task review so a queued foreground turn can continue", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      idleWorkerTtlMs: 10_000,
      idleSweepIntervalMs: 5,
      backgroundTaskMaxAgeMs: 25,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Start background work",
        files: [],
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await first;

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-lost-review</task-id>",
            "<status>completed</status>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");

      const second = adapter.sendUserMessage("session-123", {
        text: "Continue after the lost review",
        files: [],
      });
      void second.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(children[0].stdin.lines).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 40));
      await waitFor(() => children[0].stdin.lines.length === 2);
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Queue recovered.","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({ text: "Queue recovered." });
    } finally {
      await adapter.destroy();
    }
  });

  it("keeps a queued foreground turn behind consecutive Claude task reviews in one stdout batch", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Run two background checks",
        files: [],
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await first;

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-a</task-id>",
            "<status>completed</status>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");

      const foreground = adapter.sendUserMessage("session-123", {
        text: "Answer the foreground question",
        files: [],
      });
      void foreground.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(children[0].stdin.lines).toHaveLength(1);

      // Both records arrive in one stdout callback. Resolving task A's waiter
      // must not let the foreground prompt pass task B, which starts before the
      // waiter continuation gets its next microtask.
      children[0].stdout.emitData([
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Task A reviewed.",
          session_id: "session-123",
          origin: { kind: "task-notification" },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              "<task-notification>",
              "<task-id>task-b</task-id>",
              "<status>completed</status>",
              "</task-notification>",
            ].join("\n"),
          },
          session_id: "session-123",
          origin: { kind: "task-notification" },
        }),
        "",
      ].join("\n"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(children[0].stdin.lines).toHaveLength(1);

      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Task B reviewed.","session_id":"session-123","origin":{"kind":"task-notification"}}\n');
      await waitFor(() => children[0].stdin.lines.length === 2);
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Foreground answer.","session_id":"session-123"}\n');
      await expect(foreground).resolves.toEqual({ text: "Foreground answer." });
    } finally {
      adapter.destroy();
    }
  });

  it("routes a Claude background review permission request to the task owner's approval callback", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const approvalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "once" });
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Run a background repair",
        files: [],
        onApprovalRequest: approvalRequest,
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-background-approval",
            name: "Bash",
            input: { command: "sleep 5", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-background-approval","tool_use_id":"toolu-background-approval","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await first;

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-background-approval</task-id>",
            "<status>completed</status>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "control_request",
        request_id: "background-approval-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Write",
          input: { file_path: "/tmp/repaired.txt", content: "verified" },
        },
      }) + "\n");

      await waitFor(() => children[0].stdin.lines.length === 2);
      expect(approvalRequest).toHaveBeenCalledTimes(1);
      expect(JSON.parse(children[0].stdin.lines[1] ?? "{}")).toEqual(expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          request_id: "background-approval-1",
          response: expect.objectContaining({ behavior: "allow" }),
        }),
      }));

      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Background repair verified.","session_id":"session-123","origin":{"kind":"task-notification"}}\n');
    } finally {
      adapter.destroy();
    }
  });

  it.each(["reply", "empty", "exit", "question"])("reports background answer progress independently of a foreground turn (%s)", async ending => {
    const { children, spawnFn } = createSpawnHarness();
    const feedback = vi.fn<(event: EngineAnswerProgress) => void>();
    const approval = vi.fn().mockResolvedValue({ behavior: "allow", updatedInput: { answers: { "Which version?": "Latest" } }, onAnswerProgress: feedback });
    const events: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const emit = (value: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "session-feedback", ...value }) + "\n");
    try {
      const first = adapter.sendUserMessage("feedback-fixture", { text: "Check in the background", files: [], onApprovalRequest: approval, onEngineEvent: e => { events.push(e); } });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      emit({ type: "system", subtype: "init" });
      emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "spawn", name: "Bash", input: { run_in_background: true } }] } });
      emit({ type: "system", subtype: "task_started", task_id: "review-A", tool_use_id: "spawn" });
      emit({ type: "result", result: "Started" }); await first;
      emit({ type: "user", message: { content: "<task-notification>\n<task-id>review-A</task-id>\n<status>completed</status>\n</task-notification>" }, origin: { kind: "task-notification" } });
      emit({ type: "control_request", request_id: "ask-A", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which version?", options: [{ label: "Latest" }] }] } } });
      await waitFor(() => children[0].stdin.lines.length === 2);
      expect(approval.mock.calls[0][0].supportsAnswerProgress).toBe(true);
      expect(JSON.parse(children[0].stdin.lines[1]).response.response).toEqual({ behavior: "allow", updatedInput: { answers: { "Which version?": "Latest" } } });
      expect(feedback).toHaveBeenLastCalledWith({ phase: "sent" });
      emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "read-A", name: "Read", input: { file_path: "private-path" } }] } });
      expect(feedback).toHaveBeenLastCalledWith({ phase: "working", toolName: "Read" });
      // Another task's late terminal frame must not finish A's receipt.
      emit({ type: "result", task_id: "unrelated-B", result: "Other task", origin: { kind: "task-notification" } });
      expect(feedback).toHaveBeenLastCalledWith({ phase: "working", toolName: "Read" });
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-A", content: "private output" }] } });
      expect(feedback).toHaveBeenLastCalledWith({ phase: "thinking" });
      emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
      expect(feedback).toHaveBeenLastCalledWith({ phase: "thinking" });
      expect(events.some(e => e.type === "tool_use" && e.toolUseId === "read-A")).toBe(false);
      expect(JSON.stringify(feedback.mock.calls)).not.toContain("private");
      if (ending === "exit") {
        children[0].close(1);
        expect(feedback).toHaveBeenLastCalledWith({ phase: "interrupted" });
      } else if (ending === "question") {
        approval.mockResolvedValueOnce({ behavior: "deny" });
        emit({ type: "control_request", request_id: "ask-next", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: {} } });
        expect(feedback).toHaveBeenLastCalledWith({ phase: "waiting_input" });
        await waitFor(() => children[0].stdin.lines.length === 3);
        emit({ type: "result", result: "Ended", origin: { kind: "task-notification" } });
        expect(feedback).toHaveBeenLastCalledWith({ phase: "waiting_input" });
      } else {
        const foregroundEvents: EngineStreamEvent[] = [];
        const next = adapter.sendUserMessage("session-feedback", { text: "Another prompt", files: [], onEngineEvent: e => { foregroundEvents.push(e); } });
        emit({ type: "result", result: ending === "reply" ? "Follow-up result" : "", origin: { kind: "task-notification" } });
        expect(feedback).toHaveBeenLastCalledWith({ phase: ending === "reply" ? "finished" : "unknown" });
        await waitFor(() => children[0].stdin.lines.length === 3);
        const count = feedback.mock.calls.length;
        emit({ type: "assistant", message: { content: [{ type: "text", text: "Foreground answer" }] } });
        emit({ type: "result", result: "Foreground answer" }); await next;
        expect(feedback).toHaveBeenCalledTimes(count);
        expect(foregroundEvents.some(e => e.type === "assistant_text" && e.text === "Foreground answer")).toBe(true);
      }
    } finally { await adapter.destroy(); }
  });

  it("does not acknowledge a late answer as sent after its background review has closed", async () => {
    const { children, spawnFn } = createSpawnHarness();
    let resolve!: (decision: EngineApprovalDecision) => void;
    const approval = vi.fn(() => new Promise<EngineApprovalDecision>(done => { resolve = done; }));
    const feedback = vi.fn();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const emit = (value: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "late-answer", ...value }) + "\n");
    try {
      const first = adapter.sendUserMessage("late-fixture", { text: "Start", files: [], onApprovalRequest: approval });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      emit({ type: "system", subtype: "init" });
      emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "start-review", input: { run_in_background: true } }] } });
      emit({ type: "system", subtype: "task_started", task_id: "review", tool_use_id: "start-review" });
      emit({ type: "result", result: "Started" }); await first;
      emit({ type: "user", message: { content: "<task-notification>\n<task-id>review</task-id>\n<status>completed</status>\n</task-notification>" }, origin: { kind: "task-notification" } });
      emit({ type: "control_request", request_id: "late-question", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: {} } });
      await waitFor(() => !!resolve);
      emit({ type: "result", result: "Review ended before an answer", origin: { kind: "task-notification" } });
      resolve({ behavior: "allow", updatedInput: { answers: { question: "Too late" } }, onAnswerProgress: feedback });
      await waitFor(() => children[0].stdin.lines.length === 2);
      expect(feedback.mock.calls).toEqual([[{ phase: "unknown" }]]);
      expect(JSON.parse(children[0].stdin.lines[1]).response.response.behavior).toBe("deny");
      expect(children[0].stdin.lines[1]).not.toContain("Too late");
    } finally { await adapter.destroy(); }
  });

  it("keeps background review approvals with the task owner when a foreground turn is already pending", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const taskApproval = vi.fn().mockResolvedValue({ behavior: "allow", scope: "once" });
    const foregroundApproval = vi.fn().mockResolvedValue({ behavior: "deny" });
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Run a background repair",
        files: [],
        onApprovalRequest: taskApproval,
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-overlap-approval",
            name: "Bash",
            input: { command: "sleep 5", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-overlap-approval","tool_use_id":"toolu-overlap-approval","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await first;

      const foreground = adapter.sendUserMessage("session-123", {
        text: "Unrelated foreground question",
        files: [],
        onApprovalRequest: foregroundApproval,
      });
      void foreground.catch(() => undefined);
      await waitFor(() => children[0].stdin.lines.length === 2);

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-overlap-approval</task-id>",
            "<status>completed</status>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "control_request",
        request_id: "background-overlap-approval-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Write",
          input: { file_path: "/tmp/repaired.txt", content: "verified" },
        },
      }) + "\n");

      await waitFor(() => children[0].stdin.lines.length === 3);
      expect(taskApproval).toHaveBeenCalledTimes(1);
      expect(foregroundApproval).not.toHaveBeenCalled();
      expect(JSON.parse(children[0].stdin.lines[2] ?? "{}")).toEqual(expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          request_id: "background-overlap-approval-1",
          response: expect.objectContaining({ behavior: "allow" }),
        }),
      }));

      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Background repair verified.","session_id":"session-123","origin":{"kind":"task-notification"}}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Foreground answer.","session_id":"session-123"}\n');
      await expect(foreground).resolves.toEqual({ text: "Foreground answer." });
    } finally {
      await adapter.destroy();
    }
  });

  it("delivers both parent and nested task reviews when Claude serializes them", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{
      type?: string;
      taskId?: string;
      status?: string;
      text?: string;
      suppressUserDelivery?: boolean;
    }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Generate assets in the background",
        files: [],
        onEngineEvent: (event) => {
          events.push(event as never);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-parent",
            name: "Bash",
            input: { command: "generate-assets", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-parent","tool_use_id":"toolu-parent","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await first;

      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-parent","tool_use_id":"toolu-parent","status":"completed","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-parent</task-id>",
            "<tool-use-id>toolu-parent</tool-use-id>",
            "<status>completed</status>",
            "<summary>Parent generation completed</summary>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");

      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-nested",
            name: "Bash",
            input: { command: "repair-assets", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-nested","tool_use_id":"toolu-nested","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-nested","tool_use_id":"toolu-nested","status":"completed","summary":"Nested repair completed","session_id":"session-123"}\n');

      // Claude 2.1.229 omits task_id on the result that closes the parent review.
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Final verified parent result.","session_id":"session-123"}\n');
      await waitFor(() => events.some((event) =>
        event.type === "task_notification" && event.text === "Final verified parent result."
      ));

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-nested</task-id>",
            "<tool-use-id>toolu-nested</tool-use-id>",
            "<status>completed</status>",
            "<summary>Nested repair completed</summary>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Final verified nested result.","session_id":"session-123","origin":{"kind":"task-notification"}}\n');
      await waitFor(() => events.some((event) =>
        event.type === "task_notification" && event.text === "Final verified nested result."
      ));

      children[0].close(0);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const visibleTerminalEvents = events.filter((event) =>
        event.type === "task_notification" && event.suppressUserDelivery !== true
      );
      expect(visibleTerminalEvents).toEqual([
        expect.objectContaining({
          taskId: "task-parent",
          status: "completed",
          text: "Final verified parent result.",
        }),
        expect.objectContaining({
          taskId: "task-nested",
          status: "completed",
          text: "Final verified nested result.",
        }),
      ]);
      expect(events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("engine process exited") }),
      ]));
    } finally {
      await adapter.destroy();
    }
  });

  it("starts a queued foreground turn after parent-review nested tasks settle", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      taskNotificationStartGraceMs: 0,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Generate assets in the background",
        files: [],
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-parent-queued",
            name: "Bash",
            input: { command: "generate-assets", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-parent-queued","tool_use_id":"toolu-parent-queued","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await first;

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            "<task-notification>",
            "<task-id>task-parent-queued</task-id>",
            "<tool-use-id>toolu-parent-queued</tool-use-id>",
            "<status>completed</status>",
            "</task-notification>",
          ].join("\n"),
        },
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");

      const queued = adapter.sendUserMessage("session-123", {
        text: "Are the assets ready?",
        files: [],
      });
      void queued.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(children[0].stdin.lines).toHaveLength(1);

      for (const suffix of ["a", "b"]) {
        children[0].stdout.emitData(JSON.stringify({
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: `toolu-nested-${suffix}`,
              name: "Bash",
              input: { command: `repair-${suffix}`, run_in_background: true },
            }],
          },
          session_id: "session-123",
        }) + "\n");
        children[0].stdout.emitData(JSON.stringify({
          type: "system",
          subtype: "task_started",
          task_id: `task-nested-${suffix}`,
          tool_use_id: `toolu-nested-${suffix}`,
          session_id: "session-123",
        }) + "\n");
        children[0].stdout.emitData(JSON.stringify({
          type: "system",
          subtype: "task_notification",
          task_id: `task-nested-${suffix}`,
          tool_use_id: `toolu-nested-${suffix}`,
          status: "completed",
          session_id: "session-123",
        }) + "\n");
      }

      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Final verified parent result.","session_id":"session-123"}\n');
      await waitFor(() => children[0].stdin.lines.length === 2);
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Yes, they are ready.","session_id":"session-123"}\n');

      await expect(queued).resolves.toEqual({ text: "Yes, they are ready." });
    } finally {
      await adapter.destroy();
    }
  });

  it("settles a background task immediately when TaskOutput collects its terminal result", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{
      type?: string;
      taskId?: string;
      suppressUserDelivery?: boolean;
    }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Run and collect background work",
        files: [],
        instructions: "original instructions",
        onEngineEvent: (event) => {
          events.push(event as never);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-background",
            name: "Bash",
            input: { command: "npm test", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-collected","tool_use_id":"toolu-background","task_type":"local_bash","summary":"Full suite gate","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "toolu-background",
            content: "Command running in background with ID: task-collected.",
            is_error: false,
          }],
        },
        session_id: "session-123",
      }) + "\n");

      // A non-TaskOutput tool result containing similar XML must not settle it.
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-read",
            name: "Read",
            input: { file_path: "/tmp/example.xml" },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "toolu-read",
            content: "<task_id>task-collected</task_id><status>completed</status>",
            is_error: false,
          }],
        },
        session_id: "session-123",
      }) + "\n");
      expect(events.filter((event) => event.type === "task_notification")).toHaveLength(0);

      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-task-output",
            name: "TaskOutput",
            input: { task_id: "task-collected", block: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "toolu-task-output",
            content: "<retrieval_status>success</retrieval_status>\n<task_id>task-collected</task_id>\n<task_type>local_bash</task_type>\n<status>completed</status>\n<exit_code>0</exit_code>",
            is_error: false,
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"All checks passed.","session_id":"session-123"}\n');
      await expect(first).resolves.toMatchObject({ text: "All checks passed." });

      expect(events.filter((event) => event.type === "task_notification")).toEqual([
        expect.objectContaining({
          taskId: "task-collected",
          suppressUserDelivery: true,
        }),
      ]);

      // Claude may still emit the ordinary out-of-band pair after TaskOutput.
      // The collected-task tombstone must suppress that duplicate.
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-collected","tool_use_id":"toolu-background","status":"completed","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Background done.","session_id":"session-123","origin":{"kind":"task-notification"}}\n');
      expect(events.filter((event) => event.type === "task_notification")).toHaveLength(1);

      // The consumed task no longer pins worker reconfiguration.
      const second = adapter.sendUserMessage("session-123", {
        text: "Use new instructions",
        files: [],
        instructions: "changed instructions",
      });
      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Reconfigured.","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({ text: "Reconfigured." });
    } finally {
      await adapter.destroy();
    }
  });

  it("suppresses the death notice for a long-silent task (result was consumed in-turn)", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string; taskId?: string; suppressUserDelivery?: boolean }> = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      // Threshold 0 → every retained task counts as long-silent.
      backgroundTaskSilentSuppressMs: 0,
    });

    try {
      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "Run in background",
        files: [],
        onEngineEvent: (event) => {
          events.push(event as never);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-background",
            name: "Bash",
            input: { command: "sleep 5", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-background","tool_use_id":"toolu-background","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await turn;

      children[0].close(1);
      await waitFor(() => events.some((event) => event.type === "task_notification"));
      const notice = events.find((event) => event.type === "task_notification")!;
      expect(notice.taskId).toBe("task-background");
      // Settles the timeline pairing without alarming the user.
      expect(notice.suppressUserDelivery).toBe(true);
    } finally {
      adapter.destroy();
    }
  });

  it("terminalizes outstanding background tasks with an interrupted notification when the worker dies", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string; taskId?: string; status?: string; text?: string }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "Run in background",
        files: [],
        onEngineEvent: (event) => {
          events.push(event as never);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-background",
            name: "Bash",
            input: { command: "sleep 5", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-background","tool_use_id":"toolu-background","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await turn;

      // The worker dies (crash/kill) BEFORE the task's completion notification
      // arrives. The task must be terminalized — not left to block restarts
      // silently until the stale cutoff.
      children[0].close(1);
      await waitFor(() => events.some((event) => event.type === "task_notification"));
      const failure = events.find((event) => event.type === "task_notification")!;
      expect(failure.taskId).toBe("task-background");
      expect(failure.status).toBe("interrupted");
      expect(failure.text).toContain("exited before completion");
    } finally {
      await adapter.destroy();
    }
  });

  it("waits for background-task terminal delivery before destroy resolves", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string; taskId?: string; status?: string }> = [];
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let deliveryFinished = false;
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "Run in background",
        files: [],
        onEngineEvent: async (event) => {
          events.push(event as never);
          if (event.type === "task_notification") {
            await deliveryGate;
            deliveryFinished = true;
          }
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-background",
            name: "Bash",
            input: { command: "sleep 5", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-background","tool_use_id":"toolu-background","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await turn;

      const destroying = adapter.destroy();
      await waitFor(() => events.some((event) => event.type === "task_notification"));
      let destroySettled = false;
      void destroying.then(() => {
        destroySettled = true;
      });
      await Promise.resolve();

      expect(destroySettled).toBe(false);
      expect(deliveryFinished).toBe(false);
      releaseDelivery();
      await destroying;
      expect(deliveryFinished).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({
        type: "task_notification",
        taskId: "task-background",
        status: "interrupted",
      }));
      expect(adapter.destroy()).toBe(destroying);
    } finally {
      releaseDelivery();
      await adapter.destroy();
    }
  });

  it("emits Claude background task notifications when the task result is empty but metadata has a summary", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Run in background",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
    await expect(promise).resolves.toEqual({
      text: "Started in the background.",
      sessionId: "session-123",
    });

    children[0].stdout.emitData(JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-empty",
      status: "completed",
      summary: "Background audit finished.",
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      task_id: "task-empty",
      session_id: "session-123",
      origin: { kind: "task-notification" },
    }) + "\n");

    await waitFor(() => events.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "task_notification"
    ));
    expect(events).toContainEqual(expect.objectContaining({
      type: "task_notification",
      text: "Background audit finished.",
      taskId: "task-empty",
      status: "completed",
    }));
  });

  it("does not describe a stopped Claude background task with an empty result as completed", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Run in background",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
    await expect(promise).resolves.toEqual({
      text: "Started in the background.",
      sessionId: "session-123",
    });

    children[0].stdout.emitData(JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-stopped",
      status: "stopped",
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      task_id: "task-stopped",
      session_id: "session-123",
      origin: { kind: "task-notification" },
    }) + "\n");

    await waitFor(() => events.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "task_notification"
    ));
    expect(events).toContainEqual(expect.objectContaining({
      type: "task_notification",
      text: "Background task stopped.",
      taskId: "task-stopped",
      status: "stopped",
    }));
  });

  it("does not resolve an active user turn with a Claude background task notification result", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const first = adapter.sendUserMessage("telegram-12345", {
      text: "Start background work",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
    await first;

    const second = adapter.sendUserMessage("session-123", {
      text: "Meanwhile, answer this",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children[0].stdin.lines.length === 2);
    children[0].stdout.emitData(JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "The background command completed successfully." },
        ],
      },
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "The background command completed successfully.",
      session_id: "session-123",
      origin: { kind: "task-notification" },
    }) + "\n");

    let secondResolved = false;
    void second.then(() => {
      secondResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondResolved).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task_notification",
        text: "The background command completed successfully.",
        taskId: "task-1",
        status: "completed",
        sessionId: "session-123",
      }),
    ]));

    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Current turn answer.","session_id":"session-123"}\n');
    await expect(second).resolves.toEqual({
      text: "Current turn answer.",
    });
  });

  it("settles the active turn when its own background task completion is the terminal output", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    try {
      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Run a long audit workflow",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "start-audit", input: { run_in_background: true } }] } }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","tool_use_id":"start-audit","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        status: "completed",
        session_id: "session-123",
        summary: "Audit complete",
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "# Audit complete\n\nFull background report.",
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");

      await vi.advanceTimersByTimeAsync(1600);

      await expect(promise).resolves.toEqual({
        text: "# Audit complete\n\nFull background report.",
        sessionId: "session-123",
      });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "task_notification",
          taskId: "task-1",
          status: "completed",
          text: "# Audit complete\n\nFull background report.",
          settlesCurrentTurn: true,
        }),
        expect.objectContaining({
          type: "result",
          text: "# Audit complete\n\nFull background report.",
          sessionId: "session-123",
        }),
      ]));
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("does not let background completion turn an unresolved auth failure into success", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      let settled = false;
      const onEngineEvent = vi.fn();
      const result = adapter.sendUserMessage("auth-background", { text: "Run audit", files: [], onEngineEvent });
      void result.then(() => { settled = true; }, () => { settled = true; });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      const emit = (frame: object) => children[0].stdout.emitData(JSON.stringify(frame) + "\n");
      emit({ type: "system", subtype: "init", session_id: "auth-session" });
      emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "audit", input: { run_in_background: true } }] } });
      emit({ type: "system", subtype: "task_started", task_id: "task-audit", tool_use_id: "audit", session_id: "auth-session" });
      emit({ type: "assistant", error: "authentication_failed", message: { model: "<synthetic>", content: [{ type: "text", text: "Failed to authenticate" }] } });
      emit({ type: "system", subtype: "task_notification", task_id: "task-audit", status: "completed", session_id: "auth-session", summary: "Audit ready" });
      emit({ type: "result", is_error: false, result: "Background report", session_id: "auth-session", origin: { kind: "task-notification" } });
      await vi.advanceTimersByTimeAsync(1600);
      expect(settled).toBe(false);
      expect(onEngineEvent.mock.calls.some(call => call[0].type === "task_notification" && call[0].settlesCurrentTurn)).toBe(false);
      emit({ type: "result", is_error: true, result: "", session_id: "auth-session" });
      await expect(result).rejects.toMatchObject({ name: "ClaudeError", message: "Failed to authenticate" });
    } finally { await adapter.destroy(); vi.useRealTimers(); }
  });

  it("does not settle a turn from background completion while another tool is still running", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    try {
      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Run a foreground check and a background audit",
        files: [],
      });
      let resolved = false;
      void promise.then(() => {
        resolved = true;
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu-foreground",
              name: "Read",
              input: { file_path: "/tmp/input.txt" },
            },
            {
              type: "tool_use",
              id: "toolu-background",
              name: "Bash",
              input: { command: "run-audit", run_in_background: true },
            },
          ],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","tool_use_id":"toolu-background","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-1","tool_use_id":"toolu-background","status":"completed","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Background audit complete.",
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");

      await vi.advanceTimersByTimeAsync(1600);
      expect(resolved).toBe(false);

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-foreground",
              content: "foreground check complete",
            },
          ],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Final combined answer.","session_id":"session-123"}\n');

      await expect(promise).resolves.toEqual(expect.objectContaining({
        text: "Final combined answer.",
      }));
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("routes Claude background task notifications to the turn that started the task", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const first = adapter.sendUserMessage("telegram-12345", {
      text: "Start background work",
      files: [],
      onEngineEvent: (event) => {
        firstEvents.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
    await first;

    const second = adapter.sendUserMessage("session-123", {
      text: "New chat context on the same session",
      files: [],
      onEngineEvent: (event) => {
        secondEvents.push(event);
      },
    });

    await waitFor(() => children[0].stdin.lines.length === 2);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Current turn answer.","session_id":"session-123"}\n');
    await second;

    children[0].stdout.emitData(JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "The background command completed successfully.",
      session_id: "session-123",
      origin: { kind: "task-notification" },
    }) + "\n");

    await waitFor(() => firstEvents.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "task_notification"
    ));
    expect(firstEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task_notification",
        text: "The background command completed successfully.",
        taskId: "task-1",
        sessionId: "session-123",
      }),
    ]));
    expect(secondEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task_notification",
      }),
    ]));
  });

  it("does not reap idle Claude workers while background tasks are active", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      idleWorkerTtlMs: 10,
      idleSweepIntervalMs: 5,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Start background work",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
      await first;

      await vi.advanceTimersByTimeAsync(20);

      const second = adapter.sendUserMessage("session-123", {
        text: "Still same worker",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 2);
      children[0].stdout.emitData(JSON.stringify({
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        status: "completed",
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "The background command completed successfully.",
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Current turn answer.","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({
        text: "Current turn answer.",
      });
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("defers non-security settings without killing a long-silent background task", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-background-permissions-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ approvalMode: "normal", claudePermissionMode: "manual" }));
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn, configPath,
    });

    let nowSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Start background work",
        files: [],
        instructions: "original instructions",
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
      await first;

      await writeFile(configPath, JSON.stringify({ approvalMode: "normal", claudePermissionMode: "auto" }));
      await expect(adapter.sendUserMessage("session-123", { text: "Switch native permission mode", files: [] })).rejects.toThrow("approval mode cannot be changed yet");
      expect(children[0].stdin.lines).toHaveLength(1);
      await writeFile(configPath, JSON.stringify({ approvalMode: "normal", claudePermissionMode: "manual" }));
      nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
      const second = adapter.sendUserMessage("session-123", {
        text: "New instructions",
        files: [],
        instructions: "changed instructions",
      });
      await waitFor(() => children[0].stdin.lines.length === 2);
      expect(children).toHaveLength(1);
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Continued safely.","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({ text: "Continued safely." });

      await expect(adapter.sendUserMessage("session-123", {
        text: "Switch workspace",
        files: [],
        instructions: "original instructions",
        workspaceOverride: "/tmp/other-workspace",
      })).rejects.toThrow(/workspace cannot be changed/);
      expect(children).toHaveLength(1);
    } finally {
      nowSpy?.mockRestore();
      await adapter.destroy();
      await removeTempRoot(root);
    }
  });

  it("clears background tasks when a foreground result arrives between task notification events", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      idleWorkerTtlMs: 10,
      idleSweepIntervalMs: 5,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Start background work",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
      await first;

      const second = adapter.sendUserMessage("session-123", {
        text: "Foreground turn",
        files: [],
      });

      await waitFor(() => children[0].stdin.lines.length === 2);
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-1","status":"completed","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Foreground answer.","session_id":"session-123"}\n');
      await second;
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Background done.","task_id":"task-1","session_id":"session-123","origin":{"kind":"task-notification"}}\n');

      await vi.advanceTimersByTimeAsync(20);

      const third = adapter.sendUserMessage("session-123", {
        text: "After cleanup",
        files: [],
      });

      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Fresh worker.","session_id":"session-123"}\n');
      await third;
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("prunes stale Claude background tasks so never-complete tasks do not pin workers forever", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string; taskId?: string; status?: string; text?: string }> = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      idleWorkerTtlMs: 10,
      idleSweepIntervalMs: 5,
      backgroundTaskMaxAgeMs: 15,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Start background work",
        files: [],
        onEngineEvent: (event) => {
          events.push(event as never);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
      await first;

      await vi.advanceTimersByTimeAsync(30);
      expect(events).toContainEqual(expect.objectContaining({
        type: "task_notification",
        taskId: "task-1",
        status: "unknown",
        text: expect.stringContaining("settled quietly"),
        suppressUserDelivery: true,
      }));

      const second = adapter.sendUserMessage("session-123", {
        text: "After stale task cleanup",
        files: [],
      });

      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Fresh worker.","session_id":"session-123"}\n');
      await second;
    } finally {
      await adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("keeps intermediate send-file tags when the final Claude result only summarizes delivery", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Generate files",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"Ready. [send-file:/tmp/a.png]"}]},"session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"I sent the image.","session_id":"session-123"}\n');

    await expect(promise).resolves.toEqual({
      text: "Ready. [send-file:/tmp/a.png]\nI sent the image.",
      sessionId: "session-123",
    });
  });

  it("keeps intermediate send-image tags when the final Claude result only summarizes delivery", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Generate a cover image",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"Ready. [send-image:/tmp/cover.png]"}]},"session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"I sent the image.","session_id":"session-123"}\n');

    await expect(promise).resolves.toEqual({
      text: "Ready. [send-image:/tmp/cover.png]\nI sent the image.",
      sessionId: "session-123",
    });
  });

  it("does not time out — engine runs until completion", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Long task",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"done after a long time","session_id":"session-long"}\n');

    await expect(promise).resolves.toEqual({
      text: "done after a long time",
      sessionId: "session-long",
    });
  });
});


describe("Claude scoped public process", () => {
  it("keeps background review tools and thinking with the original request while a new turn exists", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const original: EngineStreamEvent[] = [], next: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const a = adapter.sendUserMessage("telegram-scopes", { text: "A", files: [], onEngineEvent: e => { original.push(e); } });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      const send = (frame: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "scopes-session", ...frame }) + "\n");
      send({ type: "system", subtype: "init" });
      send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", id: "delegate-A", input: { run_in_background: true, description: "A research" } }] } });
      send({ type: "system", subtype: "task_started", task_id: "task-A", tool_use_id: "delegate-A" });
      send({ type: "result", result: "started A" }); await a;
      const b = adapter.sendUserMessage("scopes-session", { text: "B", files: [], onEngineEvent: e => { next.push(e); } });
      await waitFor(() => children[0].stdin.lines.length === 2);
      send({ type: "assistant", parent_tool_use_id: "delegate-A", session_id: "child-session", message: { content: [{ type: "thinking", thinking: "公开思考\n核对文件" }, { type: "tool_use", id: "read-A", name: "Read", input: { file_path: "/fixture.txt" } }] } });
      send({ type: "user", parent_tool_use_id: "delegate-A", message: { content: [{ type: "tool_result", tool_use_id: "read-A", content: "42" }] } });
      send({ type: "system", subtype: "task_notification", task_id: "task-A", status: "completed" });
      send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>task-A</task-id><status>completed</status></task-notification>' } });
      send({ type: "assistant", message: { content: [{ type: "thinking", thinking: "review public thinking" }, { type: "tool_use", name: "Read", id: "review-read", input: {} }] } });
      send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "review-read", content: "review result" }] } });
      send({ type: "result", task_id: "task-A", origin: { kind: "task-notification" }, result: "A final" });
      send({ type: "result", result: "B final" });
      await expect(b).resolves.toMatchObject({ text: "B final" });
      const scoped = original.filter((e): e is Extract<EngineStreamEvent, { type: "scoped" }> => e.type === "scoped");
      expect(scoped).toContainEqual(expect.objectContaining({ detached: true, event: expect.objectContaining({ type: "thinking", text: "公开思考\n核对文件" }) }));
      const review = scoped.find(e => e.scope.kind === "background" && e.event.type === "thinking")!;
      expect(review.event).toMatchObject({ text: "review public thinking" });
      expect(original).toContainEqual(expect.objectContaining({ type: "task_notification", scopeId: review.scope.id, taskId: "task-A", text: "A final", origin: "bound" }));
      expect(next.some(e => e.type === "scoped" || e.type === "task_notification")).toBe(false);
      expect(JSON.stringify(next)).not.toContain("review");
      expect(scoped.filter(e => e.event.type === "scope_status" && e.event.status !== "running")).toHaveLength(2);
    } finally { await adapter.destroy(); }
  });

  it("does not invent detailed ownership for a recovered review", async () => {
    const { children, spawnFn } = createSpawnHarness(); const events: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const main = adapter.sendUserMessage("telegram-recovered-scope", { text: "new", files: [], onEngineEvent: e => { events.push(e); } });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      const send = (frame: object) => children[0].stdout.emitData(JSON.stringify(frame) + "\n");
      send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>old</task-id><status>completed</status></task-notification>' } });
      send({ type: "assistant", message: { content: [{ type: "thinking", thinking: "unowned thinking" }, { type: "tool_use", name: "Read", id: "old-read", input: {} }] } });
      send({ type: "result", origin: { kind: "task-notification" }, task_id: "old", result: "Recovered report" });
      send({ type: "result", result: "New answer" }); await main;
      expect(events.some(e => e.type === "scoped")).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "task_notification", origin: "unattributed", text: "Recovered report" }));
    } finally { await adapter.destroy(); }
  });
});


describe("Claude scope review lifecycle", () => {
  it("creates fresh scopes for repeated monitor reviews and preserves an actual review failure", async () => {
    const { children, spawnFn } = createSpawnHarness(); const events: EngineStreamEvent[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    try {
      const main = adapter.sendUserMessage("telegram-monitor-scope", { text: "monitor", files: [], onEngineEvent: e => { events.push(e); } });
      await waitFor(() => children[0]?.stdin.lines.length === 1);
      const send = (frame: object) => children[0].stdout.emitData(JSON.stringify(frame) + "\n");
      send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "start-monitor", input: { run_in_background: true } }] } });
      send({ type: "system", subtype: "task_started", task_id: "monitor", tool_use_id: "start-monitor" });
      send({ type: "result", result: "started" }); await main;
      for (const label of ["first", "second"]) {
        send({ type: "user", origin: { kind: "task-notification" }, message: { content: `<task-notification><task-id>monitor</task-id><event>${label}</event></task-notification>` } });
        send({ type: "assistant", message: { content: [{ type: "thinking", thinking: label }] } });
        send({ type: "result", origin: { kind: "task-notification" }, task_id: "monitor", result: label });
      }
      const thoughts = events.filter((e): e is Extract<EngineStreamEvent, {type:"scoped"}> => e.type === "scoped" && e.scope.kind === "background" && e.event.type === "thinking");
      expect(thoughts).toHaveLength(2); expect(thoughts[0].scope.id).not.toBe(thoughts[1].scope.id);
      send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>monitor</task-id><status>completed</status></task-notification>' } });
      send({ type: "result", origin: { kind: "task-notification" }, task_id: "monitor", is_error: true, result: "review failed" });
      expect(events).toContainEqual(expect.objectContaining({ type: "task_notification", text: "review failed", status: "failed" }));
    } finally { await adapter.destroy(); }
  });
});


it.each(["Agent", "Bash"])("binds a late %s task_started to its captured request", async name => {
  const { children, spawnFn } = createSpawnHarness(); const aEvents: EngineStreamEvent[] = [], bEvents: EngineStreamEvent[] = [];
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
  try {
    const a = adapter.sendUserMessage("telegram-late-scope", { text: "A", files: [], onEngineEvent: e => { aEvents.push(e); } });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    const send = (frame: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "late-scope-session", ...frame }) + "\n");
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", name, id: "tool-A", input: { run_in_background: true } }] } });
    send({ type: "result", result: "A started" }); await a;
    const b = adapter.sendUserMessage("late-scope-session", { text: "B", files: [], onEngineEvent: e => { bEvents.push(e); } });
    await waitFor(() => children[0].stdin.lines.length === 2);
    send({ type: "system", subtype: "task_started", task_id: "late-A", tool_use_id: "tool-A" });
    send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>late-A</task-id><status>completed</status></task-notification>' } });
    send({ type: "assistant", message: { content: [{ type: "thinking", thinking: "A review" }] } });
    send({ type: "result", origin: { kind: "task-notification" }, task_id: "late-A", result: "A report" });
    send({ type: "result", result: "B answer" }); await b;
    expect(aEvents).toContainEqual(expect.objectContaining({ type: "task_notification", taskId: "late-A", text: "A report", origin: "bound" }));
    expect(bEvents.some(e => e.type === "task_notification" || e.type === "scoped" || e.type === "background_task_started")).toBe(false);
  } finally { await adapter.destroy(); }
});

it("quietly closes a monitor scope with no report instead of leaving delivery active", async () => {
  const { children, spawnFn } = createSpawnHarness(); const events: EngineStreamEvent[] = [];
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
  try {
    const main = adapter.sendUserMessage("telegram-empty-monitor", { text: "monitor", files: [], onEngineEvent: e => { events.push(e); } });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    const send = (frame: object) => children[0].stdout.emitData(JSON.stringify(frame) + "\n");
    send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "start-monitor", input: { run_in_background: true } }] } });
      send({ type: "system", subtype: "task_started", task_id: "monitor", tool_use_id: "start-monitor" }); send({ type: "result", result: "started" }); await main;
    send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>monitor</task-id><event>no change</event></task-notification>' } });
    send({ type: "result", origin: { kind: "task-notification" }, task_id: "monitor", result: "No response requested." });
    expect(events).toContainEqual(expect.objectContaining({ type: "task_notification", text: "", scopeId: expect.any(String), status: "completed", suppressUserDelivery: true }));
  } finally { await adapter.destroy(); }
});

it("keeps a nested detached Agent's late lifecycle with its parent request", async () => {
  const { children, spawnFn } = createSpawnHarness(); const aEvents: EngineStreamEvent[] = [], bEvents: EngineStreamEvent[] = [];
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
  try {
    const a = adapter.sendUserMessage("telegram-nested-scope", { text: "A", files: [], onEngineEvent: e => { aEvents.push(e); } });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    const send = (frame: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "nested-session", ...frame }) + "\n");
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", id: "parent-A", input: {} }] } });
    send({ type: "assistant", parent_tool_use_id: "parent-A", message: { content: [{ type: "tool_use", name: "Agent", id: "nested-A", input: { run_in_background: true } }] } });
    send({ type: "result", result: "A foreground done" }); await a;
    const b = adapter.sendUserMessage("nested-session", { text: "B", files: [], onEngineEvent: e => { bEvents.push(e); } });
    await waitFor(() => children[0].stdin.lines.length === 2);
    // Lifecycle may arrive after the parent Agent and foreground both ended.
    send({ type: "system", subtype: "task_started", task_id: "nested-task", tool_use_id: "nested-A", parent_tool_use_id: "parent-A" });
    send({ type: "assistant", parent_tool_use_id: "nested-A", message: { content: [{ type: "thinking", thinking: "nested public progress" }] } });
    send({ type: "system", subtype: "task_notification", task_id: "nested-task", status: "completed", parent_tool_use_id: "parent-A" });
    send({ type: "result", result: "B answer" }); await b;
    const child = aEvents.find((e): e is Extract<EngineStreamEvent,{type:"scoped"}> => e.type === "scoped" && e.scope.parentCallId === "nested-A")!;
    expect(child.rootScope).toBeUndefined(); expect(child.detached).toBe(true);
    expect(aEvents).toContainEqual(expect.objectContaining({ type: "scoped", scope: child.scope, event: expect.objectContaining({ text: "nested public progress" }) }));
    expect(aEvents).toContainEqual(expect.objectContaining({ type: "scoped", scope: child.scope, event: { type: "scope_status", status: "done" } }));
    expect(bEvents.some(e => e.type === "scoped" || e.type === "task_notification" || e.type === "background_task_started")).toBe(false);
    expect(aEvents).toContainEqual(expect.objectContaining({ type: "task_notification", taskId: "nested-task", suppressUserDelivery: true }));
  } finally { await adapter.destroy(); }
});

it("keeps a no-ID late task unattributed and never borrows the newer prompt's approval", async () => {
  const { children, spawnFn } = createSpawnHarness(); const first: EngineStreamEvent[] = [], second: EngineStreamEvent[] = [];
  const approval = vi.fn().mockResolvedValue({ behavior: "allow" });
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
  try {
    const a = adapter.sendUserMessage("telegram-no-id", { text: "A", files: [], onEngineEvent: e => { first.push(e); } });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    const send = (frame: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "no-id-session", ...frame }) + "\n");
    send({ type: "system", subtype: "init" }); send({ type: "result", result: "A done" }); await a;
    const b = adapter.sendUserMessage("no-id-session", { text: "B", files: [], onEngineEvent: e => { second.push(e); }, onApprovalRequest: approval });
    await waitFor(() => children[0].stdin.lines.length === 2);
    send({ type: "system", subtype: "task_started", task_id: "late-A" });
    send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>late-A</task-id><status>completed</status></task-notification>' } });
    send({ type: "control_request", request_id: "unowned-question", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: {} } });
    await waitFor(() => children[0].stdin.lines.length === 3);
    expect(approval).not.toHaveBeenCalled();
    expect(JSON.parse(children[0].stdin.lines[2]).response.response.behavior).toBe("deny");
    send({ type: "result", origin: { kind: "task-notification" }, task_id: "late-A", result: "Old report" });
    send({ type: "result", result: "B final" }); await expect(b).resolves.toMatchObject({ text: "B final" });
    expect(second).toContainEqual(expect.objectContaining({ type: "task_notification", origin: "unattributed", text: "Old report" }));
    expect(second.filter(e => e.type === "background_task_started" || e.type === "background_task_finished").every(e => e.origin === "unattributed")).toBe(true);
    expect(second.some(e => e.type === "scoped" || e.type === "permission_request")).toBe(false);
  } finally { await adapter.destroy(); }
});

it("keeps an unmarked child permission with its scope and refuses new foreground capabilities", async () => {
  const { children, spawnFn } = createSpawnHarness(); const aEvents: EngineStreamEvent[] = [], bEvents: EngineStreamEvent[] = [];
  const approval = vi.fn().mockResolvedValue({ behavior: "allow" });
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
  try {
    const a = adapter.sendUserMessage("telegram-child-permission", { text: "A", files: [], onEngineEvent: e => { aEvents.push(e); } });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    const send = (frame: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "child-permission-session", ...frame }) + "\n");
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", id: "child-A", input: { run_in_background: true } }] } });
    send({ type: "assistant", parent_tool_use_id: "child-A", message: { content: [{ type: "tool_use", name: "Bash", id: "child-tool", input: {} }] } });
    send({ type: "result", result: "A started" }); await a;
    const b = adapter.sendUserMessage("child-permission-session", { text: "B", files: [], onEngineEvent: e => { bEvents.push(e); }, onApprovalRequest: approval });
    await waitFor(() => children[0].stdin.lines.length === 2);
    send({ type: "control_request", request_id: "child-request", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "child-tool", input: {} } });
    expect(approval).not.toHaveBeenCalled();
    expect(JSON.parse(children[0].stdin.lines[2]).response).toMatchObject({ subtype: "error", request_id: "child-request" });
    expect(aEvents).toContainEqual(expect.objectContaining({ type: "scoped", event: expect.objectContaining({ type: "permission_request", toolUseId: "child-tool" }) }));
    expect(bEvents.some(e => e.type === "permission_request" || e.type === "scoped")).toBe(false);
    send({ type: "user", parent_tool_use_id: "child-A", message: { content: [{ type: "tool_result", tool_use_id: "child-tool", is_error: true, content: "denied" }] } });
    send({ type: "result", result: "B done" }); await b;
  } finally { await adapter.destroy(); }
});

it("bounds shutdown even when scoped publications never settle", async () => {
  vi.useFakeTimers();
  const { children, spawnFn } = createSpawnHarness();
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  try {
    const turn = adapter.sendUserMessage("telegram-shutdown-scope", { text: "A", files: [], onEngineEvent: e => e.type === "scoped" || e.type === "task_notification" ? blocked : undefined });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    const send = (frame: object) => children[0].stdout.emitData(JSON.stringify(frame) + "\n");
    send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", id: "detached", input: { run_in_background: true } }] } });
    send({ type: "system", subtype: "task_started", task_id: "task", tool_use_id: "detached" });
    send({ type: "result", result: "started" }); await turn;
    const shutdown = adapter.destroy(); let closed = false; void shutdown.then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(1999); expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await shutdown; expect(closed).toBe(true);
  } finally { release(); await adapter.destroy(); vi.useRealTimers(); }
});

it("does not reopen a collected background task from a queued review", async () => {
  const { children, spawnFn } = createSpawnHarness(); const events: EngineStreamEvent[] = [];
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
  try {
    const turn = adapter.sendUserMessage("telegram-collected-scope", { text: "A", files: [], onEngineEvent: e => { events.push(e); } });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    const send = (frame: object) => children[0].stdout.emitData(JSON.stringify(frame) + "\n");
    send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "bg", input: { run_in_background: true } }] } });
    send({ type: "system", subtype: "task_started", task_id: "collected", tool_use_id: "bg" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", name: "TaskOutput", id: "collect", input: { task_id: "collected", block: true } }] } });
    send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "collect", content: '<task_id>collected</task_id><task_type>local_bash</task_type><status>completed</status><output>42</output>' }] } });
    const count = events.filter(e => e.type === "scoped").length;
    send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>collected</task-id><status>completed</status></task-notification>' } });
    send({ type: "assistant", message: { content: [{ type: "thinking", thinking: "duplicate review" }] } });
    send({ type: "result", origin: { kind: "task-notification" }, task_id: "collected", result: "duplicate report" });
    send({ type: "result", result: "42 in main answer" }); await turn;
    expect(events.filter(e => e.type === "scoped")).toHaveLength(count);
    expect(events.filter(e => e.type === "task_notification" && !e.suppressUserDelivery)).toEqual([]);
  } finally { await adapter.destroy(); }
});

it("marks a background subagent collected as failed by TaskOutput as an error, not unconfirmed", async () => {
  const { children, spawnFn } = createSpawnHarness(); const events: EngineStreamEvent[] = [];
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
  try {
    const turn = adapter.sendUserMessage("telegram-collected-failed", { text: "A", files: [], onEngineEvent: e => { events.push(e); } });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    const send = (frame: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "collected-failed", ...frame }) + "\n");
    send({ type: "system", subtype: "init" });
    for (const [id, task] of [["agent-failed", "failed-task"], ["agent-done", "done-task"]]) {
      send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", id, input: { description: id, run_in_background: true } }] } });
      send({ type: "system", subtype: "task_started", task_id: task, tool_use_id: id, task_type: "local_agent" });
      send({ type: "assistant", parent_tool_use_id: id, message: { content: [{ type: "tool_use", name: "Read", id: `${id}-read`, input: { file_path: "notes.md" } }] } });
    }
    for (const [task, status] of [["failed-task", "failed"], ["done-task", "completed"]]) {
      send({ type: "assistant", message: { content: [{ type: "tool_use", name: "TaskOutput", id: `collect-${task}`, input: { task_id: task, block: true } }] } });
      send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `collect-${task}`, content: `<task_id>${task}</task_id><task_type>local_agent</task_type><status>${status}</status>` }] } });
    }
    send({ type: "result", result: "collected" }); await turn;
    const finals = events.flatMap(e => e.type === "scoped" && e.scope.kind === "subagent" && e.event.type === "scope_status" && e.event.status !== "running" ? [[e.scope.parentCallId, e.event.status]] : []);
    expect(finals).toEqual(expect.arrayContaining([["agent-failed", "error"], ["agent-done", "done"]]));
    expect(finals.some(([, status]) => status === "unknown")).toBe(false);
  } finally { await adapter.destroy(); }
});

it("rejects a same-turn failed background review even when execution was completed", async () => {
  vi.useFakeTimers();
  const { children, spawnFn } = createSpawnHarness(); const events: EngineStreamEvent[] = [];
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
  try {
    const turn = adapter.sendUserMessage("telegram-failed-review", { text: "A", files: [], onEngineEvent: e => { events.push(e); } });
    const rejected = expect(turn).rejects.toThrow("review failed");
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    const send = (frame: object) => children[0].stdout.emitData(JSON.stringify(frame) + "\n");
    send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "review-start", input: { run_in_background: true } }] } });
    send({ type: "system", subtype: "task_started", task_id: "review", tool_use_id: "review-start" });
    send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>review</task-id><status>completed</status></task-notification>' } });
    send({ type: "result", origin: { kind: "task-notification" }, task_id: "review", is_error: true, result: "review failed" });
    await vi.advanceTimersByTimeAsync(1600); await rejected;
    expect(events).toContainEqual(expect.objectContaining({ type: "task_notification", status: "failed" }));
    expect(events.some(e => e.type === "result")).toBe(false);
  } finally { await adapter.destroy(); vi.useRealTimers(); }
});

it("does not confuse a failed tool execution with a successful review turn", async () => {
  vi.useFakeTimers(); const { children, spawnFn } = createSpawnHarness(); const events: EngineStreamEvent[] = [];
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
  try {
    const turn = adapter.sendUserMessage("telegram-recovered-review", { text: "A", files: [], onEngineEvent: e => { events.push(e); } });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    const send = (frame: object) => children[0].stdout.emitData(JSON.stringify(frame) + "\n");
    send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "retry-start", input: { run_in_background: true } }] } });
    send({ type: "system", subtype: "task_started", task_id: "retry", tool_use_id: "retry-start" });
    send({ type: "user", origin: { kind: "task-notification" }, message: { content: '<task-notification><task-id>retry</task-id><status>failed</status></task-notification>' } });
    send({ type: "result", origin: { kind: "task-notification" }, task_id: "retry", is_error: false, result: "Recovered and verified successfully" });
    await vi.advanceTimersByTimeAsync(1600); await expect(turn).resolves.toMatchObject({ text: "Recovered and verified successfully" });
    expect(events).toContainEqual(expect.objectContaining({ type: "task_notification", status: "failed" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "result", text: "Recovered and verified successfully" }));
  } finally { await adapter.destroy(); vi.useRealTimers(); }
});


it.each([true, false])("routes a current child tool approval to its owning turn (parent marker: %s)", async (marked) => {
  const { children, spawnFn } = createSpawnHarness();
  const events: EngineStreamEvent[] = [];
  const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow" });
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
  try {
    const turn = adapter.sendUserMessage("tarobot-child-approval", { text: "Delegate", files: [], onApprovalRequest, onEngineEvent: e => { events.push(e); } });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    const send = (frame: object) => children[0].stdout.emitData(JSON.stringify({ session_id: "child-approval", ...frame }) + "\n");
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "delegate", name: "Agent", input: { description: "Review" } }] } });
    send({ type: "assistant", parent_tool_use_id: "delegate", message: { content: [{ type: "tool_use", id: "child-bash", name: "Bash", input: { command: "pwd" } }] } });
    send({ type: "control_request", ...(marked ? { parent_tool_use_id: "delegate" } : {}), request_id: "child-permit", request: { subtype: "can_use_tool", tool_use_id: "child-bash", tool_name: "Bash", input: { command: "pwd" } } });
    await waitFor(() => children[0].stdin.lines.length === 2);
    expect(onApprovalRequest).toHaveBeenCalledOnce();
    expect(onApprovalRequest.mock.calls[0][0]).toMatchObject({ toolName: "Bash", toolInput: { command: "pwd" } });
    expect(JSON.parse(children[0].stdin.lines[1]).response).toMatchObject({ subtype: "success", request_id: "child-permit", response: { behavior: "allow" } });
    expect(events.filter(e => e.type === "permission_request")).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "scoped", event: expect.objectContaining({ type: "permission_request", toolUseId: "child-bash" }) }));
    send({ type: "user", parent_tool_use_id: "delegate", message: { content: [{ type: "tool_result", tool_use_id: "child-bash", content: "/workspace" }] } });
    send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "delegate", content: "done" }] } });
    send({ type: "result", subtype: "success", is_error: false, result: "done" });
    await expect(turn).resolves.toMatchObject({ text: "done" });
  } finally { adapter.destroy(); }
});

it("gives a ticket session its own --model/--effort without touching other sessions or config.json", async () => {
  const { children, calls, spawnFn } = createSpawnHarness();
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-claude-override-"));
  const configPath = path.join(root, "config.json");
  const config = JSON.stringify({ engine: "claude", approvalMode: "normal", effort: "xhigh", model: "claude-opus-5-5[1m]" }) + "\n";
  await writeFile(configPath, config, "utf8");
  const adapter = new ClaudeStreamAdapter("claude", { spawnFn, configPath });
  const flag = (args: string[] | undefined, name: string) => args?.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const finish = async (index: number, sessionId: string, turn: Promise<unknown>) => {
    children[index].stdout.emitData(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\n");
    children[index].stdout.emitData(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sessionId }) + "\n");
    await expect(turn).resolves.toMatchObject({ text: "ok" });
  };
  try {
    const ticket = adapter.sendUserMessage("tarobot-ticket", { text: "Work", files: [], engineOverride: { model: "sonnet", effort: "low" } });
    await waitFor(() => children[0]?.stdin.lines.length === 1);
    expect([flag(calls[0]?.args, "--model"), flag(calls[0]?.args, "--effort")]).toEqual(["sonnet", "low"]);
    await finish(0, "ticket-session", ticket);

    const ordinary = adapter.sendUserMessage("tarobot-ordinary", { text: "Hi", files: [] });
    await waitFor(() => children[1]?.stdin.lines.length === 1);
    expect([flag(calls[1]?.args, "--model"), flag(calls[1]?.args, "--effort")]).toEqual(["claude-opus-5-5[1m]", "xhigh"]);
    await finish(1, "ordinary-session", ordinary);

    // The same override reuses the ticket worker; the ordinary worker keeps its options.
    const again = adapter.sendUserMessage("ticket-session", { text: "More", files: [], engineOverride: { model: "sonnet", effort: "low" } });
    await waitFor(() => children[0].stdin.lines.length === 2);
    expect(calls).toHaveLength(2);
    await finish(0, "ticket-session", again);

    // A model that lacks the Bot's effort follows its own default.
    const haiku = adapter.sendUserMessage("tarobot-haiku", { text: "Quick", files: [], engineOverride: { model: "haiku" } });
    await waitFor(() => children[2]?.stdin.lines.length === 1);
    expect(flag(calls[2]?.args, "--model")).toBe("haiku");
    expect(calls[2]?.args).not.toContain("--effort");
    await finish(2, "haiku-session", haiku);

    const rejected = adapter.sendUserMessage("tarobot-invalid", { text: "Work", files: [], engineOverride: { model: "sonnet", effort: "ultra" } });
    await expect(rejected).rejects.toThrow('Invalid model selection: sonnet has no "ultra" effort');
    await expect(rejected.catch(error => classifyFailure(error))).resolves.toBe("engine-settings");
    expect(calls).toHaveLength(3);
    expect(await readFile(configPath, "utf8")).toBe(config);
  } finally {
    adapter.destroy();
    await removeTempRoot(root);
  }
});
